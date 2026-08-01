"""Run-Lifecycle v3 (WP3-D2): create/stop/resume/reset/delete + Replay.

Acceptance evidence for the D2 slice of Phase 3:

* RUN-01 (deepened): two INDEPENDENT runs of the same playlist+mode with
  separate progress — the UC-16 core that ``idx_runs_one_live`` used to block;
* F1 (ADR-003): stop → resume round trip keeps the cursor;
* F2 (ADR-003): reset starts cycle 2 with a NEW plan while history and play
  counts stay;
* UC-26 / RUN-12: soft → hard delete removes exactly the run, never the
  imported library;
* Blueprint §5.2: an import creates an independent run next to a live one,
  and previous() is a replay, never an un-play;
* Blueprint §5.3: the similarity guard is scoped per (playlist, config);
* the deprecated ``build_run`` wrapper refuses the ambiguous two-live-runs
  case instead of guessing.

Fixtures are local on purpose (Limit-Abbruch-Resilienz): this file must run
on its own with nothing but ``tests/conftest.py``'s database isolation.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass

import pytest
import pytest_asyncio

from app import db, runs
from core import engine
from core.models import AdvanceReason, PlaylistRef, RunMode, RunStatus, Track
from providers.base import TokenBundle
from tests.conftest import FakeProvider

# pytest-asyncio auto mode (pyproject.toml) marks async tests automatically.


# ---------------------------------------------------------------------------
# Local fixtures
# ---------------------------------------------------------------------------

@dataclass
class Service:
    """One connected user on the in-memory provider, service-layer shaped."""

    session: object
    provider: FakeProvider
    playlist: PlaylistRef
    user_id: int


@pytest_asyncio.fixture
async def service(database) -> Service:
    from app.accounts import Session

    provider = FakeProvider()
    user_id = await db.get_or_create_user("local-lifecycle")
    session = Session(
        user_id=user_id, provider=provider, token=TokenBundle(access_token="t")
    )
    playlist = (await provider.list_playlists(None))[0]  # "pl1", 12 tracks
    return Service(session=session, provider=provider, playlist=playlist,
                   user_id=user_id)


async def _one(conn, sql, params=()):
    cur = await conn.execute(sql, params)
    row = await cur.fetchone()
    return row[0] if row is not None else None


# ---------------------------------------------------------------------------
# RUN-01 (deepened): two independent runs, same playlist, same mode
# ---------------------------------------------------------------------------

async def test_two_independent_runs_of_the_same_playlist_and_mode(database, service):
    first, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER
    )
    second, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER, name="Zweitdeck"
    )
    assert first.run_id != second.run_id

    # SP-003 / idx_runs_one_playing: the first run holds the active-controller
    # slot, so the second is created 'paused' — live, independent, resumable.
    assert first.status is RunStatus.ACTIVE
    assert second.status is RunStatus.PAUSED

    # Separate progress: advancing run 1 must not move run 2.
    await runs.advance(service.session, first, reason=AdvanceReason.USER_SKIP)
    one = await db.get_run(first.run_id)
    two = await db.get_run(second.run_id)
    assert one["cursor"] == 1
    assert two["cursor"] == 0

    # Each run has its own full deck and plan (12 valid demo tracks).
    # Teständerung WP3-D3 (ADR-003 F4/F5): advance() verbucht seither die
    # konsumierte Karte im Ledger — der USER_SKIP oben zählt unter der
    # Legacy-Policy 'consume' als gespielt, Run 1 hat also 11 offene Karten
    # und 1 gespielte.  Run 2 bleibt unberührt (Run-Isolation).
    expected_open = {first.run_id: 11, second.run_id: 12}
    for run_id in (first.run_id, second.run_id):
        assert await _one(
            database,
            "SELECT count(*) FROM run_tracks WHERE run_id = ? AND state = 'open'",
            (run_id,),
        ) == expected_open[run_id]
        assert await _one(
            database, "SELECT count(*) FROM run_plan WHERE run_id = ?", (run_id,)
        ) == 12
    assert await _one(
        database,
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND state = 'played' "
        "AND play_count = 1",
        (first.run_id,),
    ) == 1

    # UC-16: several runs per playlist need distinguishable names.
    assert one["name"] == "Everything"
    assert two["name"] == "Zweitdeck"


async def test_default_names_get_a_suffix_instead_of_an_integrity_error(
    database, service
):
    """idx_runs_name is unique per (user, playlist) — the second default-named
    run must come out as 'Everything · 2', not as a 500."""
    a, _ = await runs.create_run_v3(service.session, service.playlist,
                                    RunMode.CONTROLLER)
    b, _ = await runs.create_run_v3(service.session, service.playlist,
                                    RunMode.CONTROLLER)
    names = {
        (await db.get_run(a.run_id))["name"],
        (await db.get_run(b.run_id))["name"],
    }
    assert names == {"Everything", "Everything · 2"}


# ---------------------------------------------------------------------------
# F1: stop → resume round trip
# ---------------------------------------------------------------------------

async def test_stop_resume_roundtrip_keeps_the_cursor(database, service):
    state, _ = await runs.create_run_v3(service.session, service.playlist,
                                        RunMode.CONTROLLER)
    await runs.start(service.session, state, device_id="dev1")
    await runs.advance(service.session, state, reason=AdvanceReason.USER_SKIP)
    await runs.advance(service.session, state, reason=AdvanceReason.USER_SKIP)
    assert state.cursor == 2

    stopped = await runs.stop_run(service.session, state)
    row = await db.get_run(state.run_id)
    assert stopped.status is RunStatus.STOPPED
    assert row["status"] == "stopped"
    assert row["stopped_at"]                 # F1: the deliberate end is stamped
    assert row["device_id"] is None          # device released
    # Not live: it leaves the "Jetzt" surface …
    assert await db.find_live_run(
        service.user_id, "fake", service.playlist.id, "controller"
    ) is None

    # … and a second stop is a no-op, not an error.
    again = await runs.stop_run(service.session, stopped)
    assert again.status is RunStatus.STOPPED

    resumed = await runs.resume_run(service.session, state.run_id)
    assert resumed is not None
    assert resumed.status is RunStatus.ACTIVE
    assert resumed.cursor == 2               # exactly the same card
    events = [e["type"] for e in await db.list_events(state.run_id)]
    assert "stopped" in events and "resumed" in events


async def test_resume_refuses_while_another_controller_run_is_playing(
    database, service
):
    """idx_runs_one_playing surfaces as a German RunError, not a 500."""
    first, _ = await runs.create_run_v3(service.session, service.playlist,
                                        RunMode.CONTROLLER)
    second, _ = await runs.create_run_v3(service.session, service.playlist,
                                         RunMode.CONTROLLER, name="Zwei")
    assert first.status is RunStatus.ACTIVE and second.status is RunStatus.PAUSED

    with pytest.raises(engine.RunError) as excinfo:
        await runs.resume_run(service.session, second.run_id)
    assert "steuert gerade" in str(excinfo.value)

    # Once the first is stopped, the resume goes through.
    await runs.stop_run(service.session, first)
    resumed = await runs.resume_run(service.session, second.run_id)
    assert resumed is not None and resumed.status is RunStatus.ACTIVE


# ---------------------------------------------------------------------------
# F2: reset = next cycle, history stays
# ---------------------------------------------------------------------------

async def test_reset_starts_cycle_two_with_a_new_plan_and_keeps_history(
    database, service
):
    state, _ = await runs.create_run_v3(service.session, service.playlist,
                                        RunMode.CONTROLLER)
    old_order = list(state.order)
    assert len(old_order) == 12

    # Simulate a played cycle the way D3's ledger will: one card carries a
    # play_count.  Reset must keep that number (F2: cumulative), not zero it.
    await database.execute(
        "UPDATE run_tracks SET state = 'played', play_count = 1, "
        "last_played_seq = 0 WHERE run_id = ? AND id = "
        "(SELECT MIN(id) FROM run_tracks WHERE run_id = ?)",
        (state.run_id, state.run_id),
    )
    await database.commit()
    await db.update_run(state.run_id, status="completed", cursor=12)
    events_before = len(await db.list_events(state.run_id))

    summary = await runs.reset_run(service.session, state)
    assert summary["cycle"] == 2
    assert summary["plan_version"] == 2
    assert summary["cursor"] == 0
    assert summary["total"] == 12
    assert summary["status"] == "active"

    row = await db.get_run(state.run_id)
    assert row["cycle"] == 2
    assert row["plan_version"] == 2
    assert row["cursor"] == 0
    assert len(row["order"]) == 12
    assert sorted(row["order"]) == sorted(old_order)   # same cards, new order

    # The old plan is discarded, never deleted (RUN-04/05 evidence); the new
    # one continues the seq clock instead of overwriting positions.
    assert await _one(
        database,
        "SELECT count(*) FROM run_plan WHERE run_id = ? AND state = 'discarded'",
        (state.run_id,),
    ) == 12
    assert await _one(
        database,
        "SELECT count(*) FROM run_plan WHERE run_id = ? AND plan_version = 2",
        (state.run_id,),
    ) == 12
    assert await _one(
        database,
        "SELECT MIN(seq) FROM run_plan WHERE run_id = ? AND plan_version = 2",
        (state.run_id,),
    ) == 12

    # F2: every admitted card is open again, play_count stays cumulative.
    assert await _one(
        database,
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND state = 'open'",
        (state.run_id,),
    ) == 12
    assert await _one(
        database,
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND play_count = 1",
        (state.run_id,),
    ) == 1

    # History stays: nothing was removed, and cycle_reset was appended.
    events = await db.list_events(state.run_id)
    assert len(events) == events_before + 1
    assert events[0]["type"] == "cycle_reset"
    assert events[0]["detail"]["cycle"] == 2


async def test_reset_refuses_a_cancelled_run(database, service):
    state, _ = await runs.create_run_v3(service.session, service.playlist,
                                        RunMode.CONTROLLER)
    await runs.cancel(service.session, state)
    state.status = RunStatus.CANCELLED
    with pytest.raises(engine.RunError):
        await runs.reset_run(service.session, state)


# ---------------------------------------------------------------------------
# UC-26 / RUN-12: delete = soft archive, then confirmed hard delete
# ---------------------------------------------------------------------------

async def test_delete_soft_then_hard_leaves_the_library_untouched(
    database, service
):
    # Import first, so the run actually references a snapshot (UC-03) and the
    # deletion has a library to prove innocent against.
    from app import library_service

    imported = await library_service.import_playlist(
        service.session, service.playlist
    )
    state, _ = await runs.create_run_v3(service.session, service.playlist,
                                        RunMode.CONTROLLER)
    run_row = await db.get_run(state.run_id)
    assert run_row["snapshot_id"] == imported["snapshot_id"]
    assert await _one(
        database,
        "SELECT count(*) FROM run_tracks WHERE run_id = ? "
        "AND source_snapshot_id = ?",
        (state.run_id, imported["snapshot_id"]),
    ) == 12

    # Soft: archived, hidden from the listing, nothing destroyed.
    assert await runs.delete_run(service.user_id, state.run_id) is True
    row = await db.get_run(state.run_id)
    assert row["archived_at"]
    assert all(r["id"] != state.run_id for r in await db.list_runs(service.user_id))
    assert await _one(
        database, "SELECT count(*) FROM run_tracks WHERE run_id = ?",
        (state.run_id,),
    ) == 12

    # Hard (the confirmed second step): the run and ONLY the run goes.
    assert await runs.hard_delete_run(service.user_id, state.run_id) is True
    assert await db.get_run(state.run_id) is None
    for table in ("run_tracks", "run_plan", "run_events", "skipped_tracks"):
        assert await _one(
            database, f"SELECT count(*) FROM {table} WHERE run_id = ?",
            (state.run_id,),
        ) == 0
    # RUN-12: the imported library is referenced, never owned — it stays.
    assert await _one(database, "SELECT count(*) FROM playlists") == 1
    assert await _one(
        database, "SELECT count(*) FROM playlist_snapshots WHERE id = ?",
        (imported["snapshot_id"],),
    ) == 1
    assert await _one(
        database, "SELECT count(*) FROM snapshot_items WHERE snapshot_id = ?",
        (imported["snapshot_id"],),
    ) == 12
    assert int(await _one(database, "SELECT count(*) FROM tracks")) >= 12

    # A foreign (or gone) run answers False — the API's 404.
    assert await runs.delete_run(service.user_id, state.run_id) is False
    assert await runs.hard_delete_run(service.user_id + 999, 12345) is False


# ---------------------------------------------------------------------------
# §5.3: the similarity guard is scoped per (playlist, config)
# ---------------------------------------------------------------------------

async def test_latest_completed_order_is_scoped_to_the_config(database, service):
    user_id = service.user_id
    cur = await database.execute(
        "INSERT INTO run_configs (user_id, name) VALUES (?, 'Config A')",
        (user_id,),
    )
    config_a = int(cur.lastrowid)
    cur = await database.execute(
        "INSERT INTO run_configs (user_id, name) VALUES (?, 'Config B')",
        (user_id,),
    )
    config_b = int(cur.lastrowid)
    await database.commit()

    await db.create_run(
        user_id=user_id, provider="fake", playlist_id="pl1",
        playlist_name="Everything", mode="controller", order=["a1", "a2"],
        status="completed", config_id=config_a,
    )
    await db.create_run(
        user_id=user_id, provider="fake", playlist_id="pl1",
        playlist_name="Everything", mode="controller", order=["b1", "b2"],
        status="completed", config_id=config_b,
    )

    # Scoped: each config sees only ITS OWN finished cycle — two differently
    # configured runs must not bias each other's shuffle (run isolation).
    assert await db.latest_completed_order(
        user_id, "fake", "pl1", config_id=config_a
    ) == ["a1", "a2"]
    assert await db.latest_completed_order(
        user_id, "fake", "pl1", config_id=config_b
    ) == ["b1", "b2"]
    # None-config = legacy behaviour: unfiltered across configs.  (Both runs
    # share one updated_at second, so "newest" is not decidable here — what
    # matters is that the legacy path sees finished runs of ANY config.)
    assert await db.latest_completed_order(user_id, "fake", "pl1") in (
        ["a1", "a2"], ["b1", "b2"],
    )
    # An unknown config has no history — no guard, not somebody else's order.
    assert await db.latest_completed_order(
        user_id, "fake", "pl1", config_id=config_b + 999
    ) is None


# ---------------------------------------------------------------------------
# §5.2: previous() is a replay, never an un-play
# ---------------------------------------------------------------------------

async def test_previous_is_a_replay_not_an_unplay(database, service):
    state, _ = await runs.create_run_v3(service.session, service.playlist,
                                        RunMode.CONTROLLER)
    await runs.start(service.session, state, device_id="dev1")
    await runs.advance(service.session, state, reason=AdvanceReason.USER_SKIP)
    assert state.cursor == 1

    # D3 will book the consumed card; simulate its ledger entry.  (tracks'
    # primary key is ``id`` — naming it ``track_id`` in the subquery would
    # silently resolve against the OUTER run_tracks row and update all 12.)
    await database.execute(
        "UPDATE run_tracks SET state = 'played', play_count = 1, "
        "last_played_seq = 0 WHERE run_id = ? AND track_id = "
        "(SELECT id FROM tracks WHERE provider_track_id = ? AND provider = 'fake')",
        (state.run_id, state.order[0]),
    )
    await database.commit()

    decision = await runs.previous(service.session, state)
    assert decision.cursor == 0

    # play_count is untouched — going back must not launder no-repeat (§5.2).
    assert await _one(
        database,
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND play_count = 1",
        (state.run_id,),
    ) == 1
    # The replayed card's plan row is 'current' again; nothing was deleted.
    plan = await db.list_run_plan(state.run_id, plan_version=1)
    assert plan[0]["state"] == "current"
    assert plan[1]["state"] == "planned"
    events = await db.list_events(state.run_id)
    assert any(e["type"] == "replayed" for e in events)
    replayed = next(e for e in events if e["type"] == "replayed")
    assert replayed["detail"]["track_id"] == state.order[0]


# ---------------------------------------------------------------------------
# Wrapper compatibility: build_run refuses the ambiguous case
# ---------------------------------------------------------------------------

async def test_build_run_wrapper_resumes_a_single_live_run(database, service):
    created, _ = await runs.create_run_v3(service.session, service.playlist,
                                          RunMode.CONTROLLER)
    resumed, skipped = await runs.build_run(service.session, service.playlist,
                                            RunMode.CONTROLLER)
    assert resumed.run_id == created.run_id
    assert skipped == []


async def test_build_run_wrapper_refuses_two_live_runs(database, service):
    """Blueprint §5.2: with several live runs, "resume the live one" is
    ambiguous — the wrapper must refuse and point to the explicit choice,
    never silently pick the newest."""
    await runs.create_run_v3(service.session, service.playlist, RunMode.CONTROLLER)
    await runs.create_run_v3(service.session, service.playlist,
                             RunMode.CONTROLLER, name="Zwei")
    with pytest.raises(engine.RunError) as excinfo:
        await runs.build_run(service.session, service.playlist, RunMode.CONTROLLER)
    assert "mehrere Hörvorgänge" in str(excinfo.value)


# ---------------------------------------------------------------------------
# §5.2: an import creates an independent run next to a live one (API level)
# ---------------------------------------------------------------------------

def _wait_for_job(client, job_id: str) -> dict:
    deadline = time.time() + 10
    while time.time() < deadline:
        snap = client.get(f"/api/jobs/{job_id}").json()
        if snap["status"] == "done":
            return snap["result"]
        if snap["status"] == "error":
            pytest.fail(f"job failed: {snap['message']}")
        time.sleep(0.05)
    pytest.fail("job did not finish in time")


def test_import_creates_an_independent_run_beside_a_live_one(fake_provider):
    """The v2 code cancelled the live runs of the playlist on import ("the
    partial unique index would reject the insert").  UC-16 removed that index;
    an upload must now create an independent run and leave the running deck
    alone (run-isolation invariant, Blueprint §5.2)."""
    import base64

    from fastapi.testclient import TestClient
    from itsdangerous import TimestampSigner

    from app.config import get_settings
    from app.main import app

    with TestClient(app) as client:
        # Connect the fake provider (same walk as tests/test_api.py).
        client.get("/auth/fake/login", follow_redirects=False)
        cookie = client.cookies.get("session")
        data = TimestampSigner(get_settings().secret_key).unsign(cookie, max_age=3600)
        oauth_state = json.loads(base64.urlsafe_b64decode(data))["oauth_state"]
        client.get("/auth/fake/callback",
                   params={"code": "c", "state": oauth_state},
                   follow_redirects=False)

        response = client.post("/api/runs", json={
            "provider": "fake", "playlist_id": "pl1", "mode": "controller",
        })
        assert response.status_code == 202, response.text
        original = _wait_for_job(client, response.json()["job_id"])
        client.post(f"/api/runs/{original['run_id']}/advance",
                    json={"reason": "user_skip"})

        exported = client.get(f"/export/{original['run_id']}")
        assert exported.status_code == 200

        imported = client.post("/export/import", content=exported.content).json()
        assert imported["run_id"] != original["run_id"]
        assert imported["cursor"] == 1

        # The live original is UNTOUCHED — no close_live_runs on import.
        untouched = client.get(f"/api/runs/{original['run_id']}").json()
        assert untouched["status"] == "active"
        assert untouched["cursor"] == 1
        # The imported twin resumes paused (never a second active driver).
        twin = client.get(f"/api/runs/{imported['run_id']}").json()
        assert twin["status"] == "paused"


# ---------------------------------------------------------------------------
# API surface: stop / resume / reset / delete round trip
# ---------------------------------------------------------------------------

def test_api_lifecycle_stop_resume_reset_delete(fake_provider):
    import base64

    from fastapi.testclient import TestClient
    from itsdangerous import TimestampSigner

    from app.config import get_settings
    from app.main import app

    with TestClient(app) as client:
        client.get("/auth/fake/login", follow_redirects=False)
        cookie = client.cookies.get("session")
        data = TimestampSigner(get_settings().secret_key).unsign(cookie, max_age=3600)
        oauth_state = json.loads(base64.urlsafe_b64decode(data))["oauth_state"]
        client.get("/auth/fake/callback",
                   params={"code": "c", "state": oauth_state},
                   follow_redirects=False)

        response = client.post("/api/runs", json={
            "provider": "fake", "playlist_id": "pl1", "mode": "controller",
            "name": "Mein Abenddeck",
        })
        run_id = _wait_for_job(client, response.json()["job_id"])["run_id"]

        listed = client.get("/api/runs").json()["runs"]
        me = next(r for r in listed if r["id"] == run_id)
        assert me["name"] == "Mein Abenddeck"
        assert me["cycle"] == 1

        client.post(f"/api/runs/{run_id}/advance", json={"reason": "user_skip"})

        # F1: stop, then resume — same cursor.
        payload = client.post(f"/api/runs/{run_id}/stop").json()
        assert payload == {"status": "stopped", "cursor": 1}
        payload = client.post(f"/api/runs/{run_id}/resume").json()
        assert payload == {"status": "active", "cursor": 1}

        # F2: reset needs the explicit confirmation.
        refused = client.post(f"/api/runs/{run_id}/reset", json={})
        assert refused.status_code == 400
        assert "confirm" in refused.json()["detail"]
        summary = client.post(f"/api/runs/{run_id}/reset",
                              json={"confirm": True}).json()
        assert summary["cycle"] == 2 and summary["cursor"] == 0

        # UC-26: DELETE archives (run leaves the listing), ?confirm=true
        # hard-deletes; afterwards the run is gone for good.
        assert client.delete(f"/api/runs/{run_id}").json()["status"] == "archived"
        assert all(r["id"] != run_id
                   for r in client.get("/api/runs").json()["runs"])
        assert client.delete(
            f"/api/runs/{run_id}", params={"confirm": "true"}
        ).json()["status"] == "deleted"
        assert client.get(f"/api/runs/{run_id}").status_code == 404


# ---------------------------------------------------------------------------
# Snapshot-backed creation (UC-03 → UC-16 hand-over)
# ---------------------------------------------------------------------------

async def test_a_new_run_uses_the_newest_ready_snapshot(database, service):
    """When the playlist was imported, run creation reads snapshot_items —
    the imported library, not the live provider — and records the source
    (runs.snapshot_id, run_tracks.source_snapshot_id)."""
    from app import library_service

    imported = await library_service.import_playlist(
        service.session, service.playlist
    )
    # Poison the live path: if creation went to the provider now, it would
    # see 13 tracks and the assertion below would catch the wrong source.
    service.provider.tracks.append(
        Track(provider="fake", id="t99", name="Nachzügler", artist="Artist",
              duration_ms=1000)
    )

    state, skipped = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER
    )
    run_row = await db.get_run(state.run_id)
    assert run_row["snapshot_id"] == imported["snapshot_id"]
    assert len(state.order) == 12                # snapshot content, not live
    assert "t99" not in state.order
    assert skipped == []                          # demo playlist is all clean


async def test_runs_of_the_same_deck_share_track_rows_but_not_state(
    database, service
):
    """Track identity is global (``tracks``), per-run state is not."""
    a, _ = await runs.create_run_v3(service.session, service.playlist,
                                    RunMode.CONTROLLER)
    b, _ = await runs.create_run_v3(service.session, service.playlist,
                                    RunMode.CONTROLLER, name="B")
    assert await _one(database, "SELECT count(*) FROM tracks") == 12
    assert await _one(database, "SELECT count(*) FROM run_tracks") == 24


# ---------------------------------------------------------------------------
# Guard rails kept from v2
# ---------------------------------------------------------------------------

async def test_create_run_v3_refuses_an_unreadable_playlist(database, service):
    from providers.base import ProviderContentUnavailable

    foreign = (await service.provider.list_playlists(None))[1]  # pl-foreign
    with pytest.raises(ProviderContentUnavailable):
        await runs.create_run_v3(service.session, foreign, RunMode.CONTROLLER)


async def test_create_run_v3_refuses_a_foreign_config(database, service):
    """Ownership is part of the query — a stranger's config behaves like a
    missing one (same rule as require_run)."""
    from providers.base import ProviderError

    stranger = await db.get_or_create_user("local-stranger")
    cur = await database.execute(
        "INSERT INTO run_configs (user_id, name) VALUES (?, 'Fremd')", (stranger,)
    )
    foreign_config = int(cur.lastrowid)
    await database.execute(
        "INSERT INTO run_config_versions (config_id, version, rules_json, rules_hash) "
        "VALUES (?, 1, '{}', '')",
        (foreign_config,),
    )
    await database.commit()

    with pytest.raises(ProviderError):
        await runs.create_run_v3(
            service.session, service.playlist, RunMode.CONTROLLER,
            config_id=foreign_config,
        )
