"""A1 (TS-FABLE-01 §A) — Fenster-Re-Assert bei Planänderungen während der Wiedergabe.

UC-20 / UC-27 / RUN-08, Matrix-Befund „hohes Live-Divergenzrisiko":
``set_track_exclusion`` und ``change_run_rules`` replanten nur das Ledger —
das auf dem Provider gesetzte uris-Fenster blieb unangetastet.  Bei Playlists
≤ Fenstergröße (250) wird im ganzen Lauf keine Fenstergrenze erreicht, also
wäre ein ausgeschlossener Titel live bis Laufende unverändert weitergespielt
worden.

Vertrag nach dem Fix (ADR-004):

* Jeder erfolgreiche Tail-Replan vergisst den Fensteranker (Sicherheitsnetz:
  spätestens der nächste Advance re-asserted ein frisches Fenster).
* Ändert der Replan das HÖRBARE Fenster (order[cursor:cursor+window]) und
  spielt der Provider nachweislich unseren aktuellen Titel, wird das frische
  Fenster sofort re-asserted — nahtlos: gleicher Titel, Position erhalten.
* Drift/Manual-Episode/Pause/Idle: beobachten statt kämpfen (F8) — kein
  Kommando, Ausgang ``not_driving``.
* Schlägt das Kommando fehl, bleibt der Anker vergessen und der Ausgang ist
  ehrlich ``failed`` (Event ``window_reassert_failed``); die Aktion selbst
  (Ausschluss/Regeländerung) bleibt wirksam.
* Der Watcher heilt selbst: spielt der erwartete Titel, ohne dass ein Fenster
  bekannt ist (Prozessneustart, fehlgeschlagener Re-Assert), wird das Fenster
  positions-erhaltend nachgezogen — der dokumentierte hörbare Titel-Restart
  nach Neustart (SP-006-Restnotiz) entfällt.

Diese Datei war VOR dem Fix rot (kein zweites play-Kommando, kein
``window``-Feld in den Antworten) — Beleg im Commit.
"""

from __future__ import annotations

import asyncio
import base64
import json
import time

import pytest
from fastapi.testclient import TestClient

from app import db, runs
from app.main import app
from core.models import PlaybackState
from tests.conftest import window_anchor

# pytest-asyncio auto mode (pyproject.toml) marks async tests automatically.


# ---------------------------------------------------------------------------
# Local helpers (standalone on purpose — Limit-Abbruch-Resilienz)
# ---------------------------------------------------------------------------

def _connect(client, provider_id: str = "fake") -> None:
    from itsdangerous import TimestampSigner

    from app.config import get_settings

    client.get(f"/auth/{provider_id}/login", follow_redirects=False)
    cookie = client.cookies.get("session")
    signer = TimestampSigner(get_settings().secret_key)
    data = signer.unsign(cookie, max_age=3600)
    state = json.loads(base64.urlsafe_b64decode(data))["oauth_state"]
    client.get(
        f"/auth/{provider_id}/callback",
        params={"code": "test-code", "state": state},
        follow_redirects=False,
    )


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


def _deal_and_start(client, fake_provider) -> tuple[int, dict]:
    response = client.post("/api/runs", json={
        "provider": "fake", "playlist_id": "pl1", "mode": "controller",
    })
    run_id = _wait_for_job(client, response.json()["job_id"])["run_id"]
    started = client.post(f"/api/runs/{run_id}/start", json={"device_id": "dev1"})
    assert started.status_code == 200, started.text
    payload = client.get(f"/api/runs/{run_id}").json()
    return run_id, payload


def _playing_mid_track(fake_provider, track_id: str, progress_ms: int) -> None:
    """The provider demonstrably plays OUR current title, mid-track."""
    fake_provider.state = PlaybackState(
        is_playing=True, track_id=track_id, progress_ms=progress_ms,
        duration_ms=180_000, device_id="dev1",
    )


# ---------------------------------------------------------------------------
# UC-20 / RUN-08 — exclusion while playing re-asserts the window
# ---------------------------------------------------------------------------

def test_excluding_an_upcoming_track_reasserts_the_window_without_it(
    fake_provider,
):
    """The audible future must match the plan NOW, not at the window border."""
    with TestClient(app) as client:
        _connect(client)
        run_id, payload = _deal_and_start(client, fake_provider)
        current = payload["current"]["id"]
        target = payload["upcoming"][0]
        assert len(fake_provider.play_windows) == 1
        _playing_mid_track(fake_provider, current, 63_000)

        response = client.post(
            f"/api/runs/{run_id}/tracks/{target['run_track_id']}/exclude"
        )
        assert response.status_code == 200, response.text
        assert response.json()["window"] == "reasserted"

        # A SECOND play command carried the fresh window: same current title,
        # position preserved, the excluded id gone from the audible future.
        assert len(fake_provider.play_windows) == 2
        fresh_window = fake_provider.play_windows[-1]
        assert fresh_window[0] == current
        assert target["id"] not in fresh_window
        assert fake_provider.play_positions[-1] == 63_000
        assert fake_provider.queued == []      # never the user's queue


def test_a_rule_change_reasserts_only_when_the_audible_window_changed(
    fake_provider,
):
    with TestClient(app) as client:
        _connect(client)
        run_id, payload = _deal_and_start(client, fake_provider)
        current = payload["current"]["id"]
        _playing_mid_track(fake_provider, current, 30_000)
        windows_before = len(fake_provider.play_windows)

        changed = client.post(f"/api/runs/{run_id}/rules", json={
            "rules": {"repeat_mode": "free_repeat", "min_gap": 2,
                      "repeat_quota_pct": 50},
        })
        assert changed.status_code == 200, changed.text
        outcome = changed.json()["window"]
        assert outcome in ("reasserted", "unchanged")

        fresh = client.get(f"/api/runs/{run_id}").json()
        expected_future = [fresh["current"]["id"]] + [
            e["id"] for e in fresh["upcoming"]
        ]
        if outcome == "reasserted":
            # The command carried exactly the new plan, seamlessly.
            assert len(fake_provider.play_windows) == windows_before + 1
            window = fake_provider.play_windows[-1]
            assert window[0] == current
            assert window[: len(expected_future)] == expected_future
            assert fake_provider.play_positions[-1] == 30_000
        else:
            # Deterministic redraw left the audible future identical — then
            # no command may be wasted on the provider.
            assert len(fake_provider.play_windows) == windows_before


def test_a_repeated_identical_rule_change_is_unchanged_and_sends_nothing(
    fake_provider,
):
    """B4 (Runde 2): der ``unchanged``-Pfad, deterministisch erzwungen.

    Regeländerungen ticken die seq-Uhr nicht — zwei Replans unter derselben
    Uhr, demselben Master-Seed und denselben Regeln ziehen denselben Tail.
    Der ZWEITE identische Patch muss darum ``unchanged`` melden und darf
    nachweislich kein Kommando senden."""
    with TestClient(app) as client:
        _connect(client)
        run_id, payload = _deal_and_start(client, fake_provider)
        _playing_mid_track(fake_provider, payload["current"]["id"], 20_000)

        patch = {"rules": {"skip_policy": "defer_to_end", "min_gap": 2}}
        first = client.post(f"/api/runs/{run_id}/rules", json=patch)
        assert first.status_code == 200, first.text
        windows_after_first = len(fake_provider.play_windows)

        second = client.post(f"/api/runs/{run_id}/rules", json=patch)
        assert second.status_code == 200, second.text
        assert second.json()["window"] == "unchanged"
        assert len(fake_provider.play_windows) == windows_after_first


def test_reassert_observes_instead_of_fighting_when_the_listener_took_over(
    fake_provider,
):
    """F8: while something foreign plays, an exclusion sends NO command."""
    with TestClient(app) as client:
        _connect(client)
        run_id, payload = _deal_and_start(client, fake_provider)
        target = payload["upcoming"][0]
        fake_provider.state = PlaybackState(
            is_playing=True, track_id="not-ours", progress_ms=5_000,
            duration_ms=200_000, device_id="dev1",
        )
        windows_before = len(fake_provider.play_windows)

        response = client.post(
            f"/api/runs/{run_id}/tracks/{target['run_track_id']}/exclude"
        )
        assert response.status_code == 200, response.text
        assert response.json()["window"] == "not_driving"
        assert len(fake_provider.play_windows) == windows_before
        # Safety net: the stale window is forgotten, the next command
        # re-asserts (the exclusion itself IS applied).
        assert client.get(f"/api/runs/{run_id}").json()["context"]["anchor"] is None
        fresh = client.get(f"/api/runs/{run_id}").json()
        assert all(e["run_track_id"] != target["run_track_id"]
                   for e in fresh["upcoming"])


def test_a_failed_reassert_is_honest_and_the_next_advance_converges(
    fake_provider,
):
    """Command failure: outcome ``failed``, anchor forgotten, action kept —
    and the very next advance carries the fresh window (safety net)."""
    with TestClient(app) as client:
        _connect(client)
        run_id, payload = _deal_and_start(client, fake_provider)
        current = payload["current"]["id"]
        target = payload["upcoming"][0]
        _playing_mid_track(fake_provider, current, 10_000)

        fake_provider.fail_play = True
        response = client.post(
            f"/api/runs/{run_id}/tracks/{target['run_track_id']}/exclude"
        )
        fake_provider.fail_play = False
        assert response.status_code == 200, response.text
        assert response.json()["window"] == "failed"
        assert response.json()["excluded"] is True
        assert client.get(f"/api/runs/{run_id}").json()["context"]["anchor"] is None

        events = [e["type"] for e in
                  client.get(f"/api/runs/{run_id}/events").json()["events"]]
        assert "window_reassert_failed" in events

        # Boundary convergence: the next advance finds no asserted window and
        # must re-assert a fresh one — without the excluded title.
        advanced = client.post(f"/api/runs/{run_id}/advance",
                               json={"reason": "track_ended"})
        assert advanced.status_code == 200, advanced.text
        assert target["id"] not in fake_provider.play_windows[-1]


# ---------------------------------------------------------------------------
# Watcher self-healing — the SP-006 restart residue, closed
# ---------------------------------------------------------------------------

async def test_watcher_reasserts_a_missing_window_while_the_expected_track_plays(
    database, fake_provider,
):
    """No known window + the expected title demonstrably playing → the watcher
    re-asserts seamlessly (position preserved) instead of waiting for the next
    boundary.  This is the process-restart path: before the fix the first
    boundary advance hard-restarted a title (SP-006 residue)."""
    from app.watcher import Watcher

    user_id = await db.get_or_create_user("local-reassert")
    await db.upsert_provider_account(
        user_id=user_id, provider="fake", provider_user_id="u",
        display_name="U", market="DE", product_tier="premium",
        token={"access_token": "t"},
    )
    order = [t.id for t in fake_provider.tracks[:6]]
    run_id = await db.create_run(
        user_id=user_id, provider="fake", playlist_id="pl1",
        playlist_name="Everything", mode="controller", order=order,
        status="active",
    )
    # Restart shape: the provider plays our current title mid-track, but this
    # process never asserted a window for the run.
    _playing_mid_track(fake_provider, order[0], 42_000)
    assert await window_anchor(run_id) is None
    windows_before = len(fake_provider.play_windows)

    watcher = Watcher()
    try:
        assert await watcher.ensure(run_id, user_id) is True
        deadline = asyncio.get_event_loop().time() + 3.0
        while (
            len(fake_provider.play_windows) == windows_before
            and asyncio.get_event_loop().time() < deadline
        ):
            await asyncio.sleep(0.02)
    finally:
        await watcher.stop_all()

    assert len(fake_provider.play_windows) == windows_before + 1
    assert fake_provider.play_windows[-1][0] == order[0]
    assert fake_provider.play_positions[-1] == 42_000
    assert await window_anchor(run_id) == 0
    events = [e["type"] for e in await db.list_events(run_id)]
    assert "window_reasserted" in events


async def test_auto_resume_preserves_the_position_when_the_plan_title_plays(
    database, fake_provider,
):
    """F8/ADR-004-Parität: kehrt die Wiedergabe auf den erwarteten Titel
    zurück, setzt auto_resume das Fenster positions-erhaltend — kein
    Neustart bei 0 ms mehr (Phase-4-Fix nach ERR/MAN-Befund 8)."""
    from app import db as app_db
    from app.accounts import Session
    from providers.base import TokenBundle

    user_id = await app_db.get_or_create_user("local-autoresume")
    session = Session(user_id=user_id, provider=fake_provider,
                      token=TokenBundle(access_token="t"))
    playlist = (await fake_provider.list_playlists(None))[0]
    from core.models import RunMode
    state, _ = await runs.create_run_v3(
        session, playlist, RunMode.CONTROLLER, name="auto-resume-pos",
    )
    await runs.start(session, state, device_id="dev1")
    current = state.current_track_id

    # Manuelle Episode: Drift erkannt, dann Rückkehr auf den Plan-Titel
    # mitten im Song — beobachtet vom Watcher als playback-Snapshot.
    assert await runs.manual_tick(
        session, state, drifted=True, now=1_000.0
    ) == runs.MANUAL_DETECTED
    _playing_mid_track(fake_provider, current, 33_000)
    assert await runs.manual_tick(
        session, state, drifted=False, now=1_010.0,
        playback=fake_provider.state,
    ) == runs.MANUAL_NONE

    assert fake_provider.play_windows[-1][0] == current
    assert fake_provider.play_positions[-1] == 33_000
