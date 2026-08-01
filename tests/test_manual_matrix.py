"""Manuelle Spotify-Nutzung (08_ACCEPTANCE_TEST_MATRIX §Manuelle Nutzung).

MAN-01…MAN-05 × drei Policies (``auto_resume`` / ``auto_pause`` / ``ask``) als
parametrisierte Matrix über die ECHTEN Pfade: ``core.engine.reconcile``
entscheidet, ob eine Beobachtung Drift ist, und ``app.runs.manual_tick``
(bzw. ``app.runs.manual_decision``) führt die F8-Zustandsmaschine.  Im Test
wird nichts nachgebildet — nur die Beobachtung wird injiziert, genau wie der
Watcher sie aus ``get_playback_state`` bekäme, und die Uhr wird gestellt
(Muster aus ``tests/test_policies.py`` §MAN-01/F8).

Die fünf Aktionen unterscheiden sich im Simulator ausschließlich in ihrer
Drift-Signatur:

* **MAN-01** anderen Song starten → ein Deck-Titel außer der Reihe
  (``reconcile``: „provider jumped to another track from this playlist");
* **MAN-02** anderes Album/Playlist → ein Titel außerhalb des Decks;
* **MAN-03** ein Queue-Titel → eine einzelne fremde Beobachtung;
* **MAN-04** mehrere Queue-Titel → mehrere fremde Beobachtungen hintereinander;
* **MAN-05** Gerätewechsel → derselbe erwartete Titel, neue ``device_id``.

Was die Matrix je Policy erwartet und was der Code liefert, steht in den
Docstrings der einzelnen Tests — inklusive der Stellen, an denen beides
auseinandergeht (MAN-05 und „pausiert nach Erkennung").

Live-Rest (BLOCKED): „nach der manuellen Queue" ist über die Spotify-API nicht
beobachtbar — es gibt kein Signal „die Warteschlange ist abgearbeitet".  Der
Code behilft sich mit der Rückkehr zum Plan und der harten Obergrenze
``manual_wait_seconds``; ob das der real beobachtbaren Semantik entspricht,
entscheidet erst der Live-Test (ebenso, ob ein Gerätewechsel das gesetzte
uris-Fenster überhaupt mitnimmt).

Fixtures sind bewusst lokal (Limit-Abbruch-Resilienz).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List

import pytest
import pytest_asyncio

from app import db, runs
from app.config import get_settings
from core import engine
from core.models import PlaybackState, PlaylistRef, RunMode, RunState
from core.selection import Rules
from providers.base import TokenBundle
from tests.conftest import FakeProvider

# pytest-asyncio auto mode (pyproject.toml) marks async tests automatically.

POLICIES = ("auto_resume", "auto_pause", "ask")
#: Die vier Aktionen, die im Simulator als Drift ankommen.  MAN-05 hat einen
#: eigenen Test, weil es GENAU der Fall ist, der keine Drift erzeugt.
DRIFT_ACTIONS = ("MAN-01", "MAN-02", "MAN-03", "MAN-04")


# ---------------------------------------------------------------------------
# Lokale Fixtures und Helfer
# ---------------------------------------------------------------------------

@dataclass
class Service:
    session: Any
    provider: FakeProvider
    playlist: PlaylistRef
    user_id: int


@pytest_asyncio.fixture
async def service(database) -> Service:
    from app.accounts import Session

    provider = FakeProvider()
    user_id = await db.get_or_create_user("local-manual")
    session = Session(
        user_id=user_id, provider=provider, token=TokenBundle(access_token="t")
    )
    playlist = (await provider.list_playlists(None))[0]   # "pl1", 12 Titel
    return Service(session=session, provider=provider, playlist=playlist,
                   user_id=user_id)


async def _one(sql: str, params: tuple = ()) -> Any:
    cur = await db.get_db().execute(sql, params)
    row = await cur.fetchone()
    return row[0] if row is not None else None


async def _run_with_policy(service: Service, policy: str) -> RunState:
    config_id = await db.create_config(
        service.user_id, f"MAN-{policy}", Rules(manual_use_policy=policy)
    )
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER,
        name=f"manuell-{policy}", config_id=config_id,
    )
    await runs.start(service.session, state, device_id="dev1")
    return state


def _playing(track_id: str, *, device_id: str = "dev1",
             progress_ms: int = 5_000) -> PlaybackState:
    return PlaybackState(
        is_playing=True, track_id=track_id, progress_ms=progress_ms,
        duration_ms=180_000, device_id=device_id,
    )


def _verdict(state: RunState, playback: PlaybackState,
             previous: PlaybackState | None = None) -> engine.Reconciliation:
    """Genau der Aufruf, den ``app/watcher.py`` je Poll macht."""
    return engine.reconcile(
        state, playback, previous_state=previous,
        window_size=get_settings().context_window_size,
    )


def _manual_playback(action: str, state: RunState) -> List[PlaybackState]:
    """Die Beobachtungen, die die jeweilige Aktion beim Dienst erzeugt."""
    if action == "MAN-01":
        # Ein Titel DES Decks, aber außer der Reihe (nicht die nächste Karte).
        return [_playing(state.order[7])]
    if action == "MAN-02":
        return [_playing("fremd:album:track-1")]
    if action == "MAN-03":
        return [_playing("fremd:queue:1")]
    if action == "MAN-04":
        return [_playing(f"fremd:queue:{n}") for n in (1, 2, 3)]
    raise AssertionError(f"unbekannte Aktion {action}")


async def _events(run_id: int) -> List[str]:
    return [e["type"] for e in await db.list_events(run_id)]


# ---------------------------------------------------------------------------
# MAN-01…MAN-04 × drei Policies
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("policy", POLICIES)
@pytest.mark.parametrize("action", DRIFT_ACTIONS)
async def test_manual_use_matrix(database, service, action, policy):
    """MAN-01…04 × Policy: erkennen, beobachten, und dann policy-gerecht.

    Der Ablauf ist für alle vier Aktionen derselbe, weil der Dienst uns über
    alle vier dasselbe erzählt: „es läuft etwas anderes als der Plan".  Was
    sie unterscheidet, ist die Zahl der fremden Beobachtungen (MAN-04:
    mehrere) und ob der fremde Titel zum Deck gehört (MAN-01) oder nicht.

    Belegt wird pro Zelle der Matrix:

    * **Erkennung**: die erste Drift setzt ``manual_detected`` samt Ereignis
      und ``manual_since`` — und schickt KEIN Kommando (Beobachten statt
      Kämpfen, F8).  Das gilt für alle drei Policies gleich.
    * **auto_resume** („nach manueller Sequenz regelkonform weiter"): mit der
      Rückkehr zum Plan endet die Episode und True Shuffle asserted das
      Fenster neu — genau ein zusätzliches play-Kommando, ab der unveränderten
      aktuellen Karte.
    * **auto_pause** („Run pausiert"): die Episode endet mit ``paused``, ohne
      ein einziges Kommando.
    * **ask** („Entscheidung erscheint"): die Episode parkt in
      ``awaiting_decision`` (UX-Zustand C), der Lauf bleibt aktiv, und erst
      ``manual_decision('resume')`` nimmt die Wiedergabe zurück.

    Und in allen Fällen: kein Ledger-Schaden — der Cursor bleibt stehen, es
    wird keine Karte verbucht (MAN-02 „definierte Wiederkehr ohne
    Ledger-Schaden").
    """
    state = await _run_with_policy(service, policy)
    plays_after_start = len(service.provider.play_windows)
    cursor_before = state.cursor
    clock = 10_000.0

    # -- die manuelle Phase: erkennen und NUR beobachten -------------------
    previous = _playing(state.current_track_id)
    for playback in _manual_playback(action, state):
        verdict = _verdict(state, playback, previous)
        assert verdict.drifted is True, verdict.note
        assert verdict.should_advance is False
        assert verdict.idle is False
        result = await runs.manual_tick(
            service.session, state, drifted=verdict.drifted,
            idle=verdict.idle, advancing=verdict.should_advance, now=clock,
        )
        assert result == runs.MANUAL_DETECTED
        assert len(service.provider.play_windows) == plays_after_start
        previous = playback
        clock += 30.0

    run = await db.get_run(state.run_id)
    assert run["manual_state"] == runs.MANUAL_DETECTED
    assert run["manual_since"]
    # Auch unter auto_pause pausiert die ERKENNUNG noch nicht: die Matrixzeile
    # „Run pausiert nach Erkennung" wird am ENDE der Episode eingelöst (oder
    # über manual_wait_seconds), nicht im Moment des Erkennens.
    assert run["status"] == "active"
    assert "manual_detected" in await _events(state.run_id)

    # -- Rückkehr zum Plan: jetzt entscheidet die Policy -------------------
    back = _playing(state.current_track_id, progress_ms=1_000)
    verdict = _verdict(state, back, previous)
    assert verdict.drifted is False and verdict.idle is False
    assert verdict.should_advance is False
    result = await runs.manual_tick(
        service.session, state, drifted=verdict.drifted, idle=verdict.idle,
        advancing=verdict.should_advance, now=clock,
    )

    run = await db.get_run(state.run_id)
    events = await _events(state.run_id)
    if policy == "auto_resume":
        assert result == runs.MANUAL_NONE
        assert run["status"] == "active" and run["manual_state"] == "none"
        assert run["manual_since"] is None
        assert len(service.provider.play_windows) == plays_after_start + 1
        assert service.provider.play_windows[-1][0] == state.current_track_id
        # Ehrlich gepinnt: die Rücknahme startet die Karte bei 0 ms — anders
        # als der positions-erhaltende Re-Assert aus ADR-004.
        assert service.provider.play_positions[-1] == 0
        assert "manual_resumed" in events
    elif policy == "auto_pause":
        assert result == runs.MANUAL_NONE
        assert run["status"] == "paused" and run["manual_state"] == "none"
        assert len(service.provider.play_windows) == plays_after_start
        assert "manual_paused" in events
    else:  # ask
        assert result == runs.MANUAL_AWAITING
        assert run["manual_state"] == runs.MANUAL_AWAITING
        assert run["status"] == "active"           # gehalten, nicht pausiert
        assert len(service.provider.play_windows) == plays_after_start
        assert "manual_awaiting_decision" in events

        decided = await runs.manual_decision(
            service.session, state.run_id, service.user_id, "resume"
        )
        assert decided["manual_state"] == "none"
        assert decided["status"] == "active"
        assert len(service.provider.play_windows) == plays_after_start + 1
        assert "manual_resumed" in await _events(state.run_id)

    # -- kein Ledger-Schaden, egal welche Policy ---------------------------
    assert run["cursor"] == cursor_before
    assert run["selection_seq"] == 0
    assert await _one(
        "SELECT count(*) FROM run_selections WHERE run_id = ?", (state.run_id,)
    ) == 0
    assert "advanced" not in await _events(state.run_id)
    assert service.provider.queued == []           # ADR-002: nie die Queue


@pytest.mark.parametrize("policy", POLICIES)
async def test_a_long_manual_queue_suspends_under_every_policy(
    database, service, policy,
):
    """MAN-03/04, Obergrenze: hält die manuelle Nutzung an, wird suspendiert.

    Die Spotify-API sagt nicht, wann eine manuelle Warteschlange abgearbeitet
    ist.  Der Code hat dafür genau eine ehrliche Antwort: nach
    ``manual_wait_seconds`` durchgehender Fremdwiedergabe wird der Lauf sicher
    pausiert (``manual_suspended``) — und zwar unter ALLEN drei Policies, denn
    die Policy entscheidet nur über die Rückkehr, nicht über die Obergrenze.

    ``tests/test_policies.py::test_f8_timeout_suspends_the_run`` prüft diesen
    Weg für die Standardregeln; hier zählt, dass ``auto_pause`` und ``ask``
    ihn nicht aushebeln.
    """
    config_id = await db.create_config(
        service.user_id, f"Kurz-{policy}",
        Rules(manual_use_policy=policy, manual_wait_seconds=100),
    )
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER,
        name=f"queue-{policy}", config_id=config_id,
    )
    await runs.start(service.session, state, device_id="dev1")
    plays_after_start = len(service.provider.play_windows)

    clock = 20_000.0
    assert await runs.manual_tick(
        service.session, state, drifted=True, now=clock
    ) == runs.MANUAL_DETECTED
    assert await runs.manual_tick(
        service.session, state, drifted=True, now=clock + 90
    ) == runs.MANUAL_DETECTED
    assert await runs.manual_tick(
        service.session, state, drifted=True, now=clock + 101
    ) == runs.MANUAL_SUSPENDED

    run = await db.get_run(state.run_id)
    assert run["status"] == "paused"
    assert run["manual_state"] == runs.MANUAL_SUSPENDED
    assert run["cursor"] == 0
    assert len(service.provider.play_windows) == plays_after_start
    assert "manual_suspended" in await _events(state.run_id)


# ---------------------------------------------------------------------------
# MAN-05 — Gerätewechsel
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("policy", POLICIES)
async def test_man05_a_device_change_is_no_drift_and_the_run_just_continues(
    database, service, policy,
):
    """MAN-05: der Gerätewechsel ist für den Code ein Nicht-Ereignis.

    ``core.engine.reconcile`` vergleicht ausschließlich Titel-Ids; die
    ``device_id`` der Beobachtung geht in keine Entscheidung ein (siehe
    ``core/engine.py`` Zeilen 317-383).  Spielt nach dem Wechsel derselbe
    erwartete Titel, lautet das Urteil „on expected track": keine Drift, kein
    Idle, kein Advance.  Damit öffnet sich auch keine manuelle Episode — unter
    keiner der drei Policies.

    Genau das ist die „kontrollierte Fortsetzung" der Matrixzeile: der Lauf
    läuft weiter, ohne dass ein Kommando fließt oder eine Karte verbucht wird.
    Ehrlich dazugesagt, und hier mitgepinnt:

    * die Spalten „Run sicher pausiert" (auto_pause) und „Entscheidung
      erscheint" (ask) lösen bei einem reinen Gerätewechsel NICHT aus — es
      gibt nichts zu entscheiden, weil der Code den Wechsel nicht bemerkt;
    * ``runs.device_id`` bleibt auf dem alten Gerät stehen.  Ein späteres
      Kommando (Fenster-Re-Assert, Advance an der Fenstergrenze) zielt damit
      weiterhin auf ``dev1``.  Ob Spotify das auf das neue Gerät umlenkt oder
      die Wiedergabe zurückholt, ist ohne echtes Konto nicht entscheidbar →
      Live (BLOCKED).
    """
    state = await _run_with_policy(service, policy)
    plays_after_start = len(service.provider.play_windows)
    events_before = await _events(state.run_id)

    previous = _playing(state.current_track_id, device_id="dev1")
    moved = _playing(state.current_track_id, device_id="dev2",
                     progress_ms=61_000)
    verdict = _verdict(state, moved, previous)
    assert verdict.drifted is False
    assert verdict.idle is False
    assert verdict.should_advance is False
    assert verdict.note == "on expected track"

    result = await runs.manual_tick(
        service.session, state, drifted=verdict.drifted, idle=verdict.idle,
        advancing=verdict.should_advance, now=30_000.0,
    )
    assert result == runs.MANUAL_NONE

    run = await db.get_run(state.run_id)
    assert run["status"] == "active"
    assert run["manual_state"] == "none"
    assert run["manual_since"] is None
    assert run["cursor"] == 0
    assert run["device_id"] == "dev1"              # folgt dem Hörer nicht
    assert len(service.provider.play_windows) == plays_after_start
    assert await _events(state.run_id) == events_before


async def test_man05_a_device_change_with_another_title_is_ordinary_drift(
    database, service,
):
    """MAN-05, Abgrenzung: erst der fremde TITEL macht den Wechsel sichtbar.

    Wechselt der Hörer das Gerät UND startet dort etwas anderes, greift wieder
    die normale F8-Erkennung (hier mit ``ask``: UX-Zustand C).  Der Test hält
    fest, dass die Unsichtbarkeit aus dem Test darüber wirklich am Gerät hängt
    und nicht an der Beobachtung als solcher.
    """
    state = await _run_with_policy(service, "ask")

    elsewhere = _playing("fremd:auf:dev2", device_id="dev2")
    verdict = _verdict(state, elsewhere,
                       _playing(state.current_track_id, device_id="dev1"))
    assert verdict.drifted is True

    assert await runs.manual_tick(
        service.session, state, drifted=True, now=40_000.0
    ) == runs.MANUAL_DETECTED
    back = _playing(state.current_track_id, device_id="dev2")
    assert _verdict(state, back, elsewhere).drifted is False
    assert await runs.manual_tick(
        service.session, state, drifted=False, now=40_020.0
    ) == runs.MANUAL_AWAITING

    run = await db.get_run(state.run_id)
    assert run["manual_state"] == runs.MANUAL_AWAITING
    assert run["cursor"] == 0
