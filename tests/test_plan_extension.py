"""Der rollierende Horizont rollt wirklich — der „nur 50 Titel"-Fehler.

Gemeldet als: „wenn ein neuer Hörvorgang konfiguriert wird nimmt es nur 50
Songs aus der Playlist obwohl über 9000 vorhanden und importiert wurden. Beim
allerersten Versuch hat es 9000 Songs im Hörvorgang angezeigt."

Beides stimmte, und beides folgte aus derselben Stelle.  Für ``no_repeat``
plant :func:`core.selection.plan_cycle` eine volle Permutation des Fachs —
darum 9 000 beim ersten Mal.  Für die Wiederholungs-Modi plant es bewusst nur
``PLAN_HORIZON`` (50) Karten im Voraus: ein 9 000-Einträge-Plan wäre bei
erlaubten Wiederholungen in dem Moment eine Fiktion, in dem einmal geskippt
wird, weil sich alle Abstände verschieben.

Der Defekt war nicht die 50, sondern dass nichts den Horizont je verlängert
hat — und dass die Oberfläche die Planlänge als Fachgröße ausgab.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest_asyncio

from app import db, runs
from core.models import AdvanceReason, PlaylistRef, RunMode, RunStatus
from core.selection import PLAN_HORIZON, Rules
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
    # Ein Fach, das größer ist als der Horizont — sonst kann der Fehler gar
    # nicht auftreten.
    provider.tracks = [
        t.model_copy(update={"id": f"t{i:03d}", "name": f"Track {i}"})
        for i, t in enumerate(provider.tracks * 12)
    ][:120]
    user_id = await db.get_or_create_user("local-horizon")
    session = Session(
        user_id=user_id, provider=provider, token=TokenBundle(access_token="t")
    )
    playlist = (await provider.list_playlists(None))[0]
    return Service(session=session, provider=provider, playlist=playlist,
                   user_id=user_id)


async def _repeat_run(service: Service, mode: str = "limited_repeat"):
    config_id = await db.create_config(
        service.user_id, f"Wiederholen ({mode})",
        Rules(repeat_mode=mode, min_gap=0, repeat_quota_pct=100),
    )
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER,
        name=f"Lauf {mode}", config_id=config_id,
    )
    return state


async def test_a_repeat_run_starts_with_the_horizon_not_the_whole_deck(service):
    """Das ist Absicht und bleibt so — nur eben nicht das Ende der Geschichte."""
    state = await _repeat_run(service)
    assert len(state.order) == PLAN_HORIZON
    stats = await db.deck_stats(state.run_id)
    assert stats["deck_size"] == 120


async def test_the_payload_reports_the_deck_size_not_the_plan_length(service):
    """Die Zahl auf dem Bildschirm ist die Fachgröße.

    ``total`` als „Titel im Hörvorgang" zu zeigen war der eigentliche
    Fehlerbericht: ein Fach mit 9 000 Titeln sah aus wie eines mit 50.
    """
    state = await _repeat_run(service)
    payload = await runs.describe(service.session, state)

    assert payload["deck_size"] == 120
    assert payload["total"] == PLAN_HORIZON
    assert payload["plan_is_rolling"] is True
    assert payload["plan_horizon"] == PLAN_HORIZON
    assert payload["repeat_mode"] == "limited_repeat"


async def test_a_no_repeat_run_reports_the_same_number_twice(service):
    """Ohne Wiederholungen sind Plan und Fach identisch — nichts zu erklären."""
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER, name="Ohne",
    )
    payload = await runs.describe(service.session, state)
    assert payload["total"] == payload["deck_size"] == 120
    assert payload["plan_is_rolling"] is False
    assert payload["plan_horizon"] is None


async def test_the_horizon_is_topped_up_before_it_runs_out(service):
    """Der Kern des Fixes: der Plan wächst, während gehört wird."""
    state = await _repeat_run(service)
    await runs.start(service.session, state, device_id="dev1")
    planned_before = len(state.order)

    # Bis kurz vor das Planende hören — dort greift die Nachfüllgrenze.
    while len(state.order) - state.cursor > runs.HORIZON_REFILL_MARGIN:
        await runs.advance(service.session, state,
                           reason=AdvanceReason.TRACK_ENDED, device_id="dev1")

    assert len(state.order) > planned_before
    types = [e["type"] for e in await db.list_events(state.run_id)]
    assert "plan_extended" in types


async def test_a_repeat_run_covers_the_whole_deck_and_then_finishes(service):
    """Ein Lauf ist EIN Durchgang über das Fach — nicht 50 Titel, nicht endlos.

    Für immer weiterzurollen wäre die andere Übertreibung: ``free_repeat``
    hätte dann kein Ende mehr, und der Begriff „durchgehörter Hörvorgang"
    wäre stillschweigend abgeschafft.
    """
    state = await _repeat_run(service, mode="free_repeat")
    await runs.start(service.session, state, device_id="dev1")

    guard = 0
    while state.status is RunStatus.ACTIVE:
        await runs.advance(service.session, state,
                           reason=AdvanceReason.TRACK_ENDED, device_id="dev1")
        guard += 1
        assert guard < 500, "Der Lauf endet nicht — der Horizont rollt endlos"

    assert state.status is RunStatus.COMPLETED
    assert state.cursor == 120                     # so viele Züge wie Karten


async def test_the_extension_keeps_the_consumed_prefix_untouched(service):
    """Nachziehen ist eine Fortschreibung, kein Replan.

    Die Planversion bleibt, gespielte Karten bleiben gespielt, und die
    Reihenfolge vor dem Cursor wird nicht angefasst — sonst wäre der Verlauf
    des Laufs nachträglich verändert.
    """
    state = await _repeat_run(service)
    await runs.start(service.session, state, device_id="dev1")
    run_before = await db.get_run(state.run_id)

    while len(state.order) - state.cursor > runs.HORIZON_REFILL_MARGIN:
        prefix = list(state.order[: state.cursor])
        await runs.advance(service.session, state,
                           reason=AdvanceReason.TRACK_ENDED, device_id="dev1")
        assert state.order[: len(prefix)] == prefix

    run_after = await db.get_run(state.run_id)
    assert run_after["plan_version"] == run_before["plan_version"]


async def test_the_extension_respects_the_minimum_gap(service):
    """Nachgezogene Karten werden gegen den NOCH ausstehenden Plan gezogen.

    Sonst könnte ein Titel innerhalb seines eigenen Mindestabstands
    zurückkommen — der Plan davor ist ja noch gar nicht gespielt.
    """
    config_id = await db.create_config(
        service.user_id, "Mit Abstand",
        Rules(repeat_mode="limited_repeat", min_gap=10, repeat_quota_pct=100),
    )
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER,
        name="Abstand", config_id=config_id,
    )
    await runs.start(service.session, state, device_id="dev1")

    guard = 0
    while state.status is RunStatus.ACTIVE and guard < 200:
        await runs.advance(service.session, state,
                           reason=AdvanceReason.TRACK_ENDED, device_id="dev1")
        guard += 1

    seen: dict = {}
    for index, track_id in enumerate(state.order):
        if track_id in seen:
            assert index - seen[track_id] > 10, (
                f"{track_id} kehrt nach {index - seen[track_id]} Zügen zurück, "
                "min_gap ist 10"
            )
        seen[track_id] = index
