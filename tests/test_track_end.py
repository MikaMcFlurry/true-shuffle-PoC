"""Das Trackende — und was danach passiert (ADR-005).

Diese Datei pinnt genau den gemeldeten Live-Fehler:

    „nach dem true-Shuffle den ersten Song gestartet hat bekommt true-Shuffle
    nicht mit wann der Song zu Ende ist und Spotify startet als nächsten Song
    einen unabhängigen. Wenn man danach in true-Shuffle die Fortsetzung
    bestätigt startet true-Shuffle wieder den ersten Song."

Die Ursache war nicht die API — ``GET /me/player`` liefert ``progress_ms``,
``duration_ms`` und ``item.id``, das reicht vollkommen aus. Die Ursache war
die *Einordnung*: ``reconcile`` kannte kein Muster für „unsere Karte ist zu
Ende gelaufen, jetzt läuft etwas Fremdes" und fiel auf ``drifted``. Damit
öffnete die F8-Maschine eine Manuell-Episode, der Watcher hörte auf zu buchen,
die gespielte Karte blieb unverbucht — und „fortsetzen" startete sie erneut.

Jeder Test hier war vor dem Fix rot.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest
import pytest_asyncio

from app import db, runs
from core import engine
from core.models import (
    AdvanceReason,
    PlaybackState,
    PlaylistRef,
    RunMode,
    RunState,
    RunStatus,
)
from providers.base import TokenBundle
from tests.conftest import FakeProvider

# pytest-asyncio auto mode (pyproject.toml) marks async tests automatically.


# ---------------------------------------------------------------------------
# Reine Engine-Ebene
# ---------------------------------------------------------------------------

def _run(**kwargs) -> RunState:
    defaults = dict(
        run_id=1, provider="spotify", order=[f"t{i}" for i in range(6)],
        cursor=0, status=RunStatus.ACTIVE,
    )
    defaults.update(kwargs)
    return RunState(**defaults)


def test_a_foreign_track_after_our_card_ended_consumes_the_card():
    """Autoplay nach dem Trackende ist ein Trackende, keine Fremdnutzung.

    Der Hörer hat nichts getan — der Dienst hat weitergespielt, mit etwas, das
    wir ihm nie gegeben haben. Genau diese Zeile war vorher ``drifted=True``.
    """
    run = _run(
        window_anchor=0, window_size=6,
        observed_track_id="t0", observed_progress_ms=179_000,
        observed_duration_ms=180_000, card_satisfied=True,
    )
    verdict = engine.reconcile(
        run,
        PlaybackState(is_playing=True, track_id="spotify-radio-xyz",
                      progress_ms=1_000, duration_ms=200_000),
        previous_state=PlaybackState(
            is_playing=True, track_id="t0", progress_ms=179_000,
            duration_ms=180_000,
        ),
        window_size=6,
    )
    assert verdict.reason is AdvanceReason.TRACK_ENDED
    assert verdict.context_lost is True
    assert verdict.drifted is False


def test_leaving_our_context_counts_even_when_the_title_is_in_the_deck():
    """Die Kontext-URI ist das stärkere Signal als die Track-Id.

    Ein Autoplay-Vorschlag KANN zufällig ein Titel aus derselben Playlist
    sein. Ohne den Kontextvergleich wäre das „provider jumped to another
    track from this playlist" — also Drift, also Stillstand.
    """
    run = _run(
        window_anchor=0, window_size=6,
        asserted_context_uri="spotify:playlist:ts-1",
        observed_track_id="t0", observed_progress_ms=179_500,
        observed_duration_ms=180_000, card_satisfied=True,
    )
    verdict = engine.reconcile(
        run,
        PlaybackState(is_playing=True, track_id="t4", progress_ms=800,
                      duration_ms=180_000, context_uri="spotify:playlist:other"),
        window_size=6,
    )
    assert verdict.reason is AdvanceReason.TRACK_ENDED
    assert verdict.context_lost is True


def test_a_device_that_vanishes_mid_track_still_consumes_nothing():
    """ADR-002 Auflage 1 bleibt: Geräteverlust ist kein Trackende.

    Das ist die Gegenprobe zum Test darüber — die Unterscheidung ist die
    Beobachtung, nicht die Fensterarithmetik.
    """
    run = _run(
        window_anchor=0, window_size=6,
        observed_track_id="t0", observed_progress_ms=42_000,
        observed_duration_ms=180_000, card_satisfied=False,
    )
    verdict = engine.reconcile(
        run, PlaybackState(is_idle=True),
        previous_state=PlaybackState(
            is_playing=True, track_id="t0", progress_ms=42_000,
            duration_ms=180_000,
        ),
        window_size=6,
    )
    assert verdict.idle is True
    assert verdict.should_advance is False


def test_the_first_poll_after_a_start_still_recognises_a_natural_end():
    """Ohne ``previous_state`` trug die Beobachtung früher nichts bei.

    Der erste Tick nach einem Start hat keinen Vorgänger-Poll, und ein
    natürliches Trackende wurde darum als ``native_skip`` verbucht — der aber
    NICHT zu den verbrauchenden Gründen zählt. Unter einer keep_open- oder
    requeue_later-Politik blieb die Karte offen.
    """
    run = _run(
        window_anchor=0, window_size=6,
        observed_track_id="t0", observed_progress_ms=178_000,
        observed_duration_ms=180_000, card_satisfied=True,
    )
    verdict = engine.reconcile(
        run,
        PlaybackState(is_playing=True, track_id="t1", progress_ms=500,
                      duration_ms=180_000),
        previous_state=None,
        window_size=6,
    )
    assert verdict.reason is AdvanceReason.TRACK_ENDED


def test_a_context_that_replays_our_own_card_is_not_nothing_happened():
    """Startet der Kontext dieselbe Karte neu, stand der Lauf vorher ewig."""
    run = _run(
        window_anchor=0, window_size=6,
        observed_track_id="t0", observed_progress_ms=179_000,
        observed_duration_ms=180_000, card_satisfied=True,
    )
    verdict = engine.reconcile(
        run,
        PlaybackState(is_playing=True, track_id="t0", progress_ms=400,
                      duration_ms=180_000),
        previous_state=PlaybackState(
            is_playing=True, track_id="t0", progress_ms=179_000,
            duration_ms=180_000,
        ),
        window_size=6,
    )
    assert verdict.reason is AdvanceReason.TRACK_ENDED
    assert verdict.context_lost is True


@pytest.mark.parametrize(
    "threshold, seconds, progress, duration, expected",
    [
        ("on_track_end", 30, 30_000, 180_000, False),
        ("on_track_end", 30, 177_000, 180_000, True),
        ("on_min_seconds", 30, 29_000, 180_000, False),
        ("on_min_seconds", 30, 30_000, 180_000, True),
        ("on_min_seconds", 30, 176_000, 180_000, True),   # Ende zählt weiter
        ("on_start", 30, 1, 180_000, True),
        ("on_start", 30, 0, 180_000, False),              # nichts gehört
    ],
)
def test_played_threshold_is_finally_implemented(
    threshold, seconds, progress, duration, expected
):
    """ADR-003 F4 stand seit Monaten im Schema und in keiner Zeile Code.

    Wichtig für Spotifys Policy II.2: die Regel kennt nur ``progress_ms``,
    niemals eine Uhr — eine Karte, die sich per Timer selbst weiterschaltet,
    wäre genau die künstliche Abspielzahl, die dort verboten ist.
    """
    assert engine.is_played(
        threshold, seconds, progress_ms=progress, duration_ms=duration
    ) is expected


# ---------------------------------------------------------------------------
# Über den echten Pfad: buchen, fortsetzen, nicht wiederholen
# ---------------------------------------------------------------------------

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
    user_id = await db.get_or_create_user("local-trackend")
    session = Session(
        user_id=user_id, provider=provider, token=TokenBundle(access_token="t")
    )
    playlist = (await provider.list_playlists(None))[0]
    return Service(session=session, provider=provider, playlist=playlist,
                   user_id=user_id)


async def test_resume_does_not_replay_a_card_that_already_played(service):
    """DER gemeldete Fehler, end-to-end.

    Aufbau: Titel 1 läuft, wird zu Ende gehört, aber niemand bucht ihn (genau
    das passierte, während die F8-Episode offen war). Dann drückt der Hörer
    „Hörvorgang fortsetzen".

    Vorher: derselbe Titel 1 noch einmal, für immer.
    Jetzt: die erfüllte Karte wird zuerst verbucht, dann läuft Titel 2.
    """
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER, name="Nachtfahrt",
    )
    await runs.start(service.session, state, device_id="dev1")
    first, second = state.order[0], state.order[1]

    # Der Titel läuft aus — beobachtet, aber nicht gebucht.
    await db.record_observation(
        state.run_id, track_id=first, progress_ms=179_500,
        duration_ms=180_000, satisfied=True,
    )
    resumed = await runs.get_state(state.run_id, service.user_id)
    assert resumed.card_satisfied is True

    played_before = list(service.provider.played)
    await runs.start(service.session, resumed, device_id="dev1")

    assert resumed.cursor == 1
    assert service.provider.played[len(played_before):] == [second]
    events = [e["type"] for e in await db.list_events(state.run_id)]
    assert "resume_settled" in events


async def test_resume_picks_a_half_played_card_up_where_it_stopped(service):
    """Mitten im Titel gestoppt heißt: mitten im Titel weiter, nicht von vorn."""
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER, name="Pause",
    )
    await runs.start(service.session, state, device_id="dev1")
    await db.record_observation(
        state.run_id, track_id=state.order[0], progress_ms=61_000,
        duration_ms=180_000, satisfied=False,
    )
    resumed = await runs.get_state(state.run_id, service.user_id)

    await runs.start(service.session, resumed, device_id="dev1")

    assert resumed.cursor == 0                      # dieselbe Karte
    assert service.provider.play_positions[-1] == 61_000


async def test_the_observation_is_dropped_when_the_cursor_moves(service):
    """Sonst sähe die NÄCHSTE Karte aus, als wäre sie schon gehört.

    Das wäre das Spiegelbild des Fehlers: statt einer Karte zu oft eine Karte
    zu wenig — ungehört verbraucht.
    """
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER, name="Weiter",
    )
    await runs.start(service.session, state, device_id="dev1")
    await db.record_observation(
        state.run_id, track_id=state.order[0], progress_ms=179_000,
        duration_ms=180_000, satisfied=True,
    )
    state = await runs.get_state(state.run_id, service.user_id)

    await runs.advance(
        service.session, state, reason=AdvanceReason.TRACK_ENDED,
    )

    fresh = await runs.get_state(state.run_id, service.user_id)
    assert fresh.cursor == 1
    assert fresh.card_satisfied is False
    assert fresh.observed_track_id is None


async def test_the_reported_sequence_end_to_end_through_the_watcher(service):
    """Der gemeldete Ablauf, vom Watcher getrieben — der eigentliche Beweis.

    1. true-shuffle startet Titel 1.
    2. Titel 1 läuft zu Ende.
    3. Spotify spielt einen Titel, den wir nie gegeben haben (Autoplay, oder
       der Rest eines uris-Fensters, das der Client verworfen hat).

    Vorher: Drift → F8-Episode → kein Advance → Karte unverbucht → „fortsetzen"
    startet Titel 1 erneut, endlos.

    Jetzt: Karte verbucht, Strategie herabgestuft, Titel 2 läuft — ohne dass
    der Hörer irgendetwas bestätigen muss.
    """
    from app.watcher import Watcher

    await db.upsert_provider_account(
        user_id=service.user_id, provider="fake", provider_user_id="u",
        display_name="U", market="DE", product_tier="premium",
        token={"access_token": "t"},
    )
    from providers import registry
    registry._PROVIDERS["fake"] = service.provider
    try:
        state, _ = await runs.create_run_v3(
            service.session, service.playlist, RunMode.CONTROLLER,
            name="Der gemeldete Fall",
        )
        await runs.start(service.session, state, device_id="dev1")
        first, second = state.order[0], state.order[1]

        watcher = Watcher()
        try:
            # (2) Titel 1 läuft aus — der Watcher sieht ihn kurz vor dem Ende.
            service.provider.state = PlaybackState(
                is_playing=True, track_id=first, progress_ms=179_500,
                duration_ms=180_000, device_id="dev1",
            )
            assert await watcher.ensure(state.run_id, service.user_id) is True
            await _wait_until(lambda: _satisfied(state.run_id))

            # (3) …und Spotify spielt etwas Eigenes.
            service.provider.state = PlaybackState(
                is_playing=True, track_id="spotify:radio:fremd",
                progress_ms=1_000, duration_ms=210_000, device_id="dev1",
            )
            cursor = await _wait_for_cursor(state.run_id, 1)
        finally:
            await watcher.stop_all()

        assert cursor == 1, "die zu Ende gehörte Karte wurde nicht verbucht"
        assert service.provider.played[-1] == second, (
            "nach dem Fremdtitel muss der GEPLANTE zweite Titel laufen"
        )

        run = await db.get_run(state.run_id)
        assert run["manual_state"] == "none", (
            "ein Kontextende ist keine Fremdnutzung — es darf keine "
            "Bestätigung verlangt werden"
        )
        assert run["execution_strategy"] == "context_playlist", (
            "der Dienst hat die Reihenfolge nicht behalten — der Lauf muss "
            "auf den tragfähigen Weg wechseln"
        )
        types = [e["type"] for e in await db.list_events(state.run_id)]
        assert "context_lost" in types
        assert "strategy_downgraded" in types
    finally:
        registry._PROVIDERS.pop("fake", None)


async def _satisfied(run_id: int) -> bool:
    run = await db.get_run(run_id)
    return bool(run and run["card_satisfied"])


async def _wait_until(predicate, timeout: float = 3.0) -> None:
    import asyncio

    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if await predicate():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("Bedingung wurde nicht erreicht")


async def _wait_for_cursor(run_id: int, expected: int, timeout: float = 3.0) -> int:
    import asyncio

    deadline = asyncio.get_event_loop().time() + timeout
    cursor = -1
    while asyncio.get_event_loop().time() < deadline:
        run = await db.get_run(run_id)
        cursor = int(run["cursor"]) if run else -1
        if cursor >= expected:
            return cursor
        await asyncio.sleep(0.02)
    return cursor


async def test_a_lost_context_books_the_card_and_asserts_the_next_one(service):
    """Der volle Weg: Fremdtitel → Karte verbucht → nächste Karte gesetzt."""
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER, name="Autoplay",
    )
    await runs.start(service.session, state, device_id="dev1")
    await db.record_observation(
        state.run_id, track_id=state.order[0], progress_ms=179_800,
        duration_ms=180_000, satisfied=True,
    )
    state = await runs.get_state(state.run_id, service.user_id)

    verdict = engine.reconcile(
        state,
        PlaybackState(is_playing=True, track_id="fremd-1", progress_ms=2_000,
                      duration_ms=200_000),
        window_size=250,
    )
    assert verdict.context_lost is True

    await runs.advance(
        service.session, state, reason=verdict.reason,
        device_id="dev1", context_lost=True,
    )

    assert state.cursor == 1
    # Kein „der Kontext läuft ja weiter"-Kurzschluss: der Kontext lief NICHT
    # weiter, also muss ein Kommando raus.
    assert service.provider.played[-1] == state.order[1]
    played = await db.list_run_tracks(state.run_id, states=["played"])
    assert len(played) == 1
