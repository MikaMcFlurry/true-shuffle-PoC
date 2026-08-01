"""Phase-4-Perf-Befund: der reine no_repeat-Tail-Replan ohne Draw-Loop.

Das 10k-Profil maß 54 s für einen Regeländerungs-/Ausschluss-Replan UNTER
dem advance_lock (O(n²)-Draw-Loop).  Der Fast Path ersetzt ihn im reinen
Fall (nur offene Karten, keine deferred-Fristen, keine Favoriten/Gewichte)
durch die geseedete plan_cycle-Permutation — gleiche P1/P5-Garantien,
O(n log n).  Fristen (P6) und Gewichtung (P4) erzwingen weiter den Loop.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest_asyncio

from app import db, runs
from core import selection as core_selection
from core.models import AdvanceReason, PlaylistRef, RunMode
from core.selection import Rules
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
    user_id = await db.get_or_create_user("local-fastpath")
    session = Session(
        user_id=user_id, provider=provider, token=TokenBundle(access_token="t")
    )
    playlist = (await provider.list_playlists(None))[0]
    return Service(session=session, provider=provider, playlist=playlist,
                   user_id=user_id)


async def _run(service: Service, **rule_overrides):
    config_id = await db.create_config(
        service.user_id, "fastpath", Rules(**rule_overrides)
    )
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER,
        name="fastpath", config_id=config_id,
    )
    return state


async def test_pure_no_repeat_replan_never_enters_the_draw_loop(
    database, service, monkeypatch,
):
    """Der Beweis, dass der Fast Path greift: select_next darf im reinen
    no_repeat-Fall nicht mehr aufgerufen werden."""
    state = await _run(service)
    await runs.advance(service.session, state, reason=AdvanceReason.TRACK_ENDED)

    def forbidden(*args, **kwargs):
        raise AssertionError("Draw-Loop im reinen no_repeat-Replan benutzt")

    monkeypatch.setattr(runs, "select_next", forbidden)
    card = await db.find_run_track(state.run_id,
                                   provider_track_id=state.order[3])
    result = await runs.set_track_exclusion(state, int(card["id"]), True)
    assert result["replanned"] > 0

    # P1/P5 halten: Rest-Reihenfolge ist Permutation der offenen Karten,
    # ohne die ausgeschlossene und ohne Wiederholung.
    tail = state.order[state.cursor + 1:]
    assert state.order[3] != card["provider_track_id"]
    assert card["provider_track_id"] not in tail
    # 12 Karten − 1 gespielt − 1 laufend − 1 ausgeschlossen = 9 offene.
    assert len(tail) == len(set(tail)) == 9


async def test_deferred_deadlines_still_use_the_draw_loop(
    database, service, monkeypatch,
):
    """P6-Schutz: Sobald eine requeue_later-Karte mit Frist liegt, MUSS der
    Loop rechnen (der Fast Path wäre fristenblind)."""
    state = await _run(service, skip_policy="requeue_later")
    await runs.advance(service.session, state, reason=AdvanceReason.USER_SKIP)

    called = {"n": 0}
    original = core_selection.select_next

    def counting(*args, **kwargs):
        called["n"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(runs, "select_next", counting)
    await runs.change_run_rules(state, {"min_gap": 3})
    assert called["n"] > 0


async def test_favorites_still_use_the_draw_loop(
    database, service, monkeypatch,
):
    """P4-Schutz: Favoriten gewichten den no_repeat-Replan weiterhin."""
    state = await _run(service)
    card = await db.find_run_track(state.run_id,
                                   provider_track_id=state.order[5])
    await runs.mark_favorite(service.user_id, state.run_id, int(card["id"]),
                             True)

    called = {"n": 0}
    original = core_selection.select_next

    def counting(*args, **kwargs):
        called["n"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(runs, "select_next", counting)
    await runs.change_run_rules(state, {"min_gap": 1})
    assert called["n"] > 0


async def test_fastpath_replan_is_deterministic_for_the_same_clock(
    database, service,
):
    """WP3C-Vertrag: gleicher (Seed, Seq, Regeln, Deck) ⇒ gleicher Tail."""
    state = await _run(service)
    card = await db.find_run_track(state.run_id,
                                   provider_track_id=state.order[2])

    await runs.set_track_exclusion(state, int(card["id"]), True)
    first = list(state.order)
    await runs.set_track_exclusion(state, int(card["id"]), False)
    await runs.set_track_exclusion(state, int(card["id"]), True)
    # Gleiches Deck, aber weitergerückte selection_seq-Uhr existiert hier
    # nicht (Ausschlüsse ticken die Uhr nicht) — der Tail ist reproduzierbar.
    assert list(state.order) == first
