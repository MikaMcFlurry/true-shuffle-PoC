"""Phase 4 §B5 — Concurrency/Locking über die echten Pfade.

Die F5-Forged-Key-Prüfung (`test_policies.py`) belegt den Ledger-Schutz
gegen einen NACHGEBAUTEN Doppelschreiber; hier laufen die Schreiber
wirklich nebenläufig: zwei Beobachter desselben Übergangs (Watcher +
Browser-Event), Route-Lock-Disziplin unter Last, und ein Ausschluss-Replan
gegen einen laufenden Advance.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import pytest_asyncio

from app import db, runs
from core.models import AdvanceReason, PlaylistRef, RunMode
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
    user_id = await db.get_or_create_user("local-concurrency")
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


async def _run(service: Service, name: str):
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER, name=name,
    )
    await runs.start(service.session, state, device_id="dev1")
    return state


async def test_two_observers_of_the_same_transition_book_it_exactly_once(
    database, service,
):
    """Watcher und Browser melden DENSELBEN Trackwechsel gleichzeitig —
    ohne Lock (wie zwei Prozesse).  F5 muss genau eine Verbuchung
    durchlassen; die zweite ist stale und bewegt nichts."""
    state = await _run(service, "race-observers")
    first = await runs.get_state(state.run_id, service.user_id)
    second = await runs.get_state(state.run_id, service.user_id)

    d1, d2 = await asyncio.gather(
        runs.advance(service.session, first, reason=AdvanceReason.TRACK_ENDED),
        runs.advance(service.session, second, reason=AdvanceReason.TRACK_ENDED),
    )
    applied = [d for d in (d1, d2) if d.advanced]
    stale = [d for d in (d1, d2) if not d.advanced]
    assert len(applied) == 1 and len(stale) == 1
    assert "stale" in stale[0].note

    run = await db.get_run(state.run_id)
    assert run["cursor"] == 1
    assert run["selection_seq"] == 1
    assert await _one(
        "SELECT count(*) FROM run_selections WHERE run_id = ?",
        (state.run_id,),
    ) == 1
    assert await _one(
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND state = 'played'",
        (state.run_id,),
    ) == 1


async def test_route_lock_discipline_serialises_a_burst_of_advances(
    database, service,
):
    """Fünf gleichzeitige Advance-Requests in Routen-Disziplin (advance_lock
    + get_state im Lock) verbrauchen exakt fünf Karten — keine Lücke, kein
    Sprung, lückenlose seq-Uhr."""
    state = await _run(service, "burst")

    async def locked_advance():
        async with runs.advance_lock(state.run_id):
            fresh = await runs.get_state(state.run_id, service.user_id)
            return await runs.advance(
                service.session, fresh, reason=AdvanceReason.TRACK_ENDED
            )

    results = await asyncio.gather(*[locked_advance() for _ in range(5)])
    assert all(d.advanced for d in results)

    run = await db.get_run(state.run_id)
    assert run["cursor"] == 5
    assert run["selection_seq"] == 5
    seqs = [r["seq"] for r in await (await db.get_db().execute(
        "SELECT seq FROM run_selections WHERE run_id = ? ORDER BY seq",
        (state.run_id,),
    )).fetchall()]
    assert seqs == [1, 2, 3, 4, 5]


async def test_an_exclusion_racing_an_advance_leaves_a_consistent_plan(
    database, service,
):
    """Ausschluss-Replan gegen laufenden Advance, beide in Routen-Disziplin:
    egal wer gewinnt, hinterher ist der Plan konsistent — der Ausschluss
    gilt, genau eine Karte wurde verbraucht, die ausgeschlossene Karte
    steht nicht mehr in der restlichen Reihenfolge."""
    state = await _run(service, "race-exclude")
    victim = await db.find_run_track(
        state.run_id, provider_track_id=state.order[3]
    )

    async def locked_advance():
        async with runs.advance_lock(state.run_id):
            fresh = await runs.get_state(state.run_id, service.user_id)
            return await runs.advance(
                service.session, fresh, reason=AdvanceReason.TRACK_ENDED
            )

    async def locked_exclude():
        async with runs.advance_lock(state.run_id):
            fresh = await runs.get_state(state.run_id, service.user_id)
            return await runs.set_track_exclusion(
                fresh, int(victim["id"]), True
            )

    advanced, excluded = await asyncio.gather(
        locked_advance(), locked_exclude()
    )
    assert advanced.advanced is True
    assert excluded["excluded"] is True

    run = await db.get_run(state.run_id)
    assert run["cursor"] == 1
    card = await db.find_run_track(state.run_id, run_track_id=int(victim["id"]))
    assert card["state"] == "excluded_user"
    remaining = run["order"][run["cursor"]:]
    assert victim["provider_track_id"] not in remaining
    # Der Plan hinter der Order trägt die ausgeschlossene Karte in keiner
    # zukünftigen Zeile (discarded ja, live nein).
    live_rows = await _one(
        "SELECT count(*) FROM run_plan WHERE run_id = ? AND run_track_id = ? "
        "AND state IN ('planned', 'current')",
        (state.run_id, int(victim["id"])),
    )
    assert live_rows == 0
