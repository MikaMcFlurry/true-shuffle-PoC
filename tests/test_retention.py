"""F10 (ADR-003) — Disconnect-Datenlöschung, dreistufig, testbar (ERR-07).

Stufe 1 sofort · Stufe 2 binnen 5 Tagen (``deletion_requests``-Ledger) ·
Stufe 3: anonymisierter Hörfortschritt, per Reconnect-Import wieder
verknüpfbar.  Fremde Nutzer teilen ``tracks``-Zeilen — deren Katalog darf
eine Löschung nie anfassen.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest_asyncio

from app import db, library_service, retention, runs
from core.models import PlaylistRef, RunMode
from providers.base import TokenBundle
from tests.conftest import FakeProvider

# pytest-asyncio auto mode (pyproject.toml) marks async tests automatically.


@dataclass
class Service:
    session: object
    provider: FakeProvider
    playlist: PlaylistRef
    user_id: int


@pytest_asyncio.fixture
async def service(database) -> Service:
    from app.accounts import Session

    provider = FakeProvider()
    user_id = await db.get_or_create_user("local-retention")
    await db.upsert_provider_account(
        user_id=user_id, provider="fake", provider_user_id="u",
        display_name="U", market="DE", product_tier="premium",
        token={"access_token": "t"},
    )
    session = Session(
        user_id=user_id, provider=provider, token=TokenBundle(access_token="t")
    )
    playlist = (await provider.list_playlists(None))[0]
    return Service(session=session, provider=provider, playlist=playlist,
                   user_id=user_id)


async def _one(sql, params=()):
    cur = await db.get_db().execute(sql, params)
    row = await cur.fetchone()
    return row[0] if row is not None else None


async def _run_with_history(service: Service):
    """Importierte Playlist + Run mit zwei gespielten Karten und einem Event
    mit Titelnamen — genug Material für jede Löschstufe."""
    await library_service.import_playlist(service.session, service.playlist)
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER, name="F10",
    )
    await runs.start(service.session, state, device_id="dev1")
    from core.models import AdvanceReason
    await runs.advance(service.session, state, reason=AdvanceReason.TRACK_ENDED)
    await runs.advance(service.session, state, reason=AdvanceReason.TRACK_ENDED)
    return state


async def test_stage_one_is_immediate_and_the_deadline_is_stamped(
    database, service,
):
    state = await _run_with_history(service)
    await db.get_db().execute(
        "INSERT INTO provider_observations (run_id, kind, payload_json) "
        "VALUES (?, 'playback_state', '{\"secret\":\"raw\"}')",
        (state.run_id,),
    )
    await db.get_db().commit()

    before = datetime.now(UTC)
    outcome = await retention.schedule_provider_deletion(service.user_id, "fake")

    # Tokens/Account: sofort weg.
    assert await db.get_provider_account(service.user_id, "fake") is None
    # Beobachtungen: sofort weg.
    assert await _one(
        "SELECT count(*) FROM provider_observations WHERE run_id = ?",
        (state.run_id,),
    ) == 0
    # Frist: 5 Tage, im Ledger nachweisbar, Antrag offen.
    request = dict(await (await db.get_db().execute(
        "SELECT * FROM deletion_requests WHERE id = ?",
        (outcome["request_id"],),
    )).fetchone())
    assert request["status"] == "pending"
    assert request["salt"]
    due = datetime.strptime(request["due_at"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC)
    assert timedelta(days=4, hours=23) < due - before <= timedelta(days=5, minutes=1)
    # Inhalte existieren noch — die Karenz ist für den Export da.
    assert await _one("SELECT count(*) FROM playlists WHERE user_id = ?",
                      (service.user_id,)) == 1


async def test_stage_two_deletes_content_and_stage_three_keeps_anonymous_progress(
    database, service,
):
    state = await _run_with_history(service)
    played_before = await _one(
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND state = 'played'",
        (state.run_id,),
    )
    await retention.schedule_provider_deletion(service.user_id, "fake")

    # Nicht fällig → der reguläre Job fasst nichts an.
    assert await retention.run_due_deletions() == []
    # Vorziehen (Frist ist Obergrenze, kein Mindestalter).
    outcomes = await retention.run_due_deletions(include_not_due=True)
    assert [o["status"] for o in outcomes] == ["done"]

    # Stufe 2: Provider-Inhalte weg.
    assert await _one("SELECT count(*) FROM playlists WHERE user_id = ?",
                      (service.user_id,)) == 0
    assert await _one("SELECT count(*) FROM playlist_snapshots") == 0
    # Keine Katalog-Identität mehr an den Karten dieses Runs.
    assert await _one(
        "SELECT count(*) FROM run_tracks rt JOIN tracks t ON t.id = rt.track_id "
        "WHERE rt.run_id = ? AND t.provider_track_id != ''",
        (state.run_id,),
    ) == 0
    assert await _one(
        "SELECT count(*) FROM run_tracks rt JOIN tracks t ON t.id = rt.track_id "
        "WHERE rt.run_id = ? AND (t.name != '' OR t.artist != '')",
        (state.run_id,),
    ) == 0

    # Stufe 3: der abstrakte Fortschritt bleibt vollständig.
    assert await _one(
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND state = 'played'",
        (state.run_id,),
    ) == played_before
    run = await db.get_run(state.run_id)
    assert run["cursor"] == 2
    assert all(str(t).startswith(retention.HASH_PREFIX) for t in run["order"])
    assert run["playlist_name"] == ""
    # Events: Namen weg, Ids nur noch als Opaque-Hash.
    leaked = await _one(
        "SELECT count(*) FROM run_events WHERE run_id = ? AND "
        "(detail LIKE '%\"name\"%' OR detail LIKE '%Track %')",
        (state.run_id,),
    )
    assert leaked == 0


async def test_full_scope_deletes_the_runs_too(database, service):
    state = await _run_with_history(service)
    await retention.schedule_provider_deletion(
        service.user_id, "fake", full=True
    )
    await retention.run_due_deletions(include_not_due=True)
    assert await db.get_run(state.run_id) is None
    assert await _one("SELECT count(*) FROM runs WHERE user_id = ?",
                      (service.user_id,)) == 0


async def test_shared_catalogue_rows_of_other_users_survive(database, service):
    """Der Katalog eines FREMDEN Nutzers bleibt beim Löschen unberührt."""
    from app.accounts import Session

    state = await _run_with_history(service)
    other_id = await db.get_or_create_user("other-person")
    other = Service(
        session=Session(user_id=other_id, provider=service.provider,
                        token=TokenBundle(access_token="t2")),
        provider=service.provider, playlist=service.playlist,
        user_id=other_id,
    )
    await library_service.import_playlist(other.session, other.playlist)

    await retention.schedule_provider_deletion(service.user_id, "fake")
    await retention.run_due_deletions(include_not_due=True)

    # Fremder Snapshot vollständig intakt, mit echten Ids und Namen.
    assert await _one(
        "SELECT count(*) FROM snapshot_items si "
        "JOIN playlist_snapshots ps ON ps.id = si.snapshot_id "
        "JOIN playlists p ON p.id = ps.playlist_id "
        "JOIN tracks t ON t.id = si.track_id "
        "WHERE p.user_id = ? AND t.provider_track_id != '' AND t.name != ''",
        (other_id,),
    ) == len(service.provider.tracks)
    # Und der gelöschte Nutzer referenziert KEINE identifizierende Zeile mehr.
    assert await _one(
        "SELECT count(*) FROM run_tracks rt JOIN tracks t ON t.id = rt.track_id "
        "WHERE rt.run_id = ? AND t.provider_track_id != ''",
        (state.run_id,),
    ) == 0


async def test_reconnect_import_relinks_the_anonymous_progress(
    database, service,
):
    """Stufe-3-Versprechen: nach Reconnect + Import ist der Hörstand wieder
    an echte Titel gebunden — Cursor und gespielte Karten unverändert."""
    state = await _run_with_history(service)
    await retention.schedule_provider_deletion(service.user_id, "fake")
    await retention.run_due_deletions(include_not_due=True)

    run = await db.get_run(state.run_id)
    assert all(str(t).startswith(retention.HASH_PREFIX) for t in run["order"])

    # Reconnect + frischer Import derselben Playlist.
    await db.upsert_provider_account(
        user_id=service.user_id, provider="fake", provider_user_id="u",
        display_name="U", market="DE", product_tier="premium",
        token={"access_token": "t-new"},
    )
    summary = await library_service.import_playlist(
        service.session, service.playlist
    )
    assert summary["relinked"] > 0

    run = await db.get_run(state.run_id)
    real_ids = {t.id for t in service.provider.tracks}
    assert set(run["order"]) <= real_ids
    assert run["cursor"] == 2
    assert await _one(
        "SELECT count(*) FROM run_tracks rt JOIN tracks t ON t.id = rt.track_id "
        "WHERE rt.run_id = ? AND t.provider_track_id != ''",
        (state.run_id,),
    ) == len(run["order"])
    # Keine verwaisten Anonym-Zeilen zurückgelassen.
    assert await _one(
        "SELECT count(*) FROM tracks WHERE provider_track_id = '' "
        "AND local_key != ''",
    ) == 0


async def test_a_failed_request_is_stamped_failed_not_silent(
    database, service, monkeypatch,
):
    await _run_with_history(service)
    outcome = await retention.schedule_provider_deletion(service.user_id, "fake")

    async def boom(*args, **kwargs):
        raise RuntimeError("kaputt")

    monkeypatch.setattr(retention, "_anonymise_tracks", boom)
    results = await retention.run_due_deletions(include_not_due=True)
    assert results[0]["status"] == "failed"
    assert await _one(
        "SELECT status FROM deletion_requests WHERE id = ?",
        (outcome["request_id"],),
    ) == "failed"
