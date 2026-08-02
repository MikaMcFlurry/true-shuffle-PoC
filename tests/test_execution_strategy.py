"""Ausführungsstrategien: messen statt annehmen (ADR-005).

ADR-002 wählte das uris-Fenster unter einer Annahme, die nie live geprüft
wurde: dass jeder Client eine Liste von uris vollständig übernimmt.  Der
Live-Bericht hat sie widerlegt — es gibt Clients, die nur ``uris[0]`` spielen,
den Rest verwerfen und danach eigene Empfehlungen anhängen.

Diese Datei prüft, was daraus folgt: dass true-shuffle den Fall *bemerkt*, in
einen Weg wechselt, der nachweislich trägt (eine Playlist als Kontext), und
seine Hilfsdateien im Konto des Hörers wieder aufräumt.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import pytest_asyncio

from app import db, execution, runs
from core import engine
from core.models import AdvanceReason, PlaybackState, PlaylistRef, RunMode
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
async def service(database, monkeypatch) -> Service:
    from app.accounts import Session
    from providers import registry

    provider = FakeProvider()
    # Registered, because the cleanup paths open their own session by provider
    # id — a helper playlist has to be removable from code that was not handed
    # a session (hard delete, boot sweep, account disconnect).
    monkeypatch.setitem(registry._PROVIDERS, "fake", provider)
    user_id = await db.get_or_create_user("local-strategy")
    session = Session(
        user_id=user_id, provider=provider, token=TokenBundle(access_token="t")
    )
    playlist = (await provider.list_playlists(None))[0]
    return Service(session=session, provider=provider, playlist=playlist,
                   user_id=user_id)


async def _run(service: Service, name: str = "Lauf"):
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER, name=name,
    )
    return state


# ---------------------------------------------------------------------------
# Der billige Weg bleibt der Standard, solange er trägt
# ---------------------------------------------------------------------------

async def test_a_client_that_honours_the_window_keeps_the_cheap_strategy(service):
    """Kein Eingriff ins Konto, wenn keiner nötig ist.

    Das ist die halbe Begründung dafür, ``uris_window`` überhaupt zu behalten:
    null Spuren im Spotify-Konto des Hörers.
    """
    state = await _run(service)
    await runs.start(service.session, state, device_id="dev1")

    fresh = await runs.get_state(state.run_id, service.user_id)
    assert fresh.execution_strategy == execution.URIS_WINDOW
    assert service.provider.created == {}          # keine Hilfs-Playlist
    events = [e["type"] for e in await db.list_events(state.run_id)]
    assert "strategy_downgraded" not in events


async def test_a_client_that_drops_the_window_is_detected_at_start(service):
    """Die Probe: Queue zurücklesen und mit dem Gesetzten vergleichen.

    Bewusst schwache Evidenz — ``GET /me/player/queue`` liefert ~20 Einträge
    und füllt bei kürzerer Queue auf.  Sie darf darum nur HERABstufen, nie
    hochstufen; ein falsches „sieht gut aus" wäre exakt der Produktionsfehler.
    """
    service.provider.drops_extra_uris = True
    state = await _run(service)
    await runs.start(service.session, state, device_id="dev1")

    fresh = await runs.get_state(state.run_id, service.user_id)
    assert fresh.execution_strategy == execution.CONTEXT_PLAYLIST
    types = [e["type"] for e in await db.list_events(state.run_id)]
    assert "strategy_probe" in types
    assert "strategy_downgraded" in types
    # Und die Wiedergabe läuft sofort über den tragfähigen Weg weiter.
    assert service.provider.context_plays
    assert service.provider.playing_context is not None


async def test_the_downgrade_is_one_way(service):
    """Ein guter Tag darf einen Lauf nicht zurückstufen.

    Sonst käme genau der Fehler wieder, für den herabgestuft wurde.
    """
    state = await _run(service)
    await runs.downgrade_strategy(state, cause="test")
    assert state.execution_strategy == execution.CONTEXT_PLAYLIST
    assert await runs.downgrade_strategy(state, cause="test again") is False


# ---------------------------------------------------------------------------
# Der tragfähige Weg: eine Playlist als Kontext
# ---------------------------------------------------------------------------

async def test_the_context_playlist_carries_the_plan_and_is_played_as_context(
    service,
):
    state = await _run(service, name="Kontext")
    await db.update_run(state.run_id,
                        execution_strategy=execution.CONTEXT_PLAYLIST)
    state = await runs.get_state(state.run_id, service.user_id)

    await runs.start(service.session, state, device_id="dev1")
    await execution.drain_fill_tasks()

    assert len(service.provider.context_plays) == 1
    context_uri, offset = service.provider.context_plays[0]
    assert offset == 0
    # Die Playlist trägt die geplante Reihenfolge, nicht die Playlist des Nutzers.
    assert service.provider.created[context_uri] == state.order

    rows = await db.list_run_contexts(state.run_id)
    assert len(rows) == 1 and rows[0]["slot"] == "a"

    fresh = await runs.get_state(state.run_id, service.user_id)
    assert fresh.asserted_context_uri == context_uri
    assert fresh.window_size == len(state.order)


async def test_the_helper_playlist_is_removed_when_the_deck_is_through(service):
    """Was wir im Konto anlegen, räumen wir wieder weg.

    Und zwar in dieser Reihenfolge: erst pausieren, dann aufräumen — sonst
    übernimmt Spotifys Autoplay das Gerät in der Sekunde, in der unser Kontext
    zu Ende ist.
    """
    state = await _run(service, name="Durchgehört")
    await db.update_run(state.run_id,
                        execution_strategy=execution.CONTEXT_PLAYLIST)
    state = await runs.get_state(state.run_id, service.user_id)
    await runs.start(service.session, state, device_id="dev1")
    await execution.drain_fill_tasks()
    playlist_id = service.provider.context_plays[0][0]
    assert playlist_id in service.provider.created

    guard = 0
    while state.status.value == "active":
        await runs.advance(service.session, state,
                           reason=AdvanceReason.TRACK_ENDED, device_id="dev1")
        guard += 1
        assert guard < 50

    assert service.provider.paused >= 1
    assert playlist_id in service.provider.deleted_playlists
    assert await db.list_run_contexts(state.run_id) == []


async def test_re_asserting_reuses_the_playlist_that_covers_the_cursor(service):
    """Sonst hinterlässt ein Lauf eine Playlist je Re-Assert im Konto.

    Jeder Schritt zurück, jeder Gerätewechsel, jede Kontext-Rettung würde eine
    neue anlegen — nach einem Abend wären es ein Dutzend.
    """
    state = await _run(service, name="Wiederverwenden")
    await db.update_run(state.run_id,
                        execution_strategy=execution.CONTEXT_PLAYLIST)
    state = await runs.get_state(state.run_id, service.user_id)
    await runs.start(service.session, state, device_id="dev1")
    await execution.drain_fill_tasks()
    first = service.provider.context_plays[0][0]

    # Drei Kommandos an drei verschiedenen Positionen des SELBEN Kontexts.
    for _ in range(3):
        await runs.advance(service.session, state,
                           reason=AdvanceReason.USER_SKIP, device_id="dev1")
        await runs.start(service.session, state, device_id="dev1")

    assert len(await db.list_run_contexts(state.run_id)) == 1
    assert {uri for uri, _ in service.provider.context_plays} == {first}
    # …und zwar an der richtigen Stelle gespielt, nicht von vorn.
    assert service.provider.context_plays[-1][1] == state.cursor


async def test_a_plan_change_is_not_played_from_the_stale_playlist(service):
    """Ein Ausschluss schreibt die Reihenfolge um — die Playlist im Konto
    kennt sie noch nicht.  Der Anker würde weiter passen; ohne Fingerabdruck
    liefe der alte Plan bis zum Laufende einfach weiter."""
    state = await _run(service, name="Ausschluss")
    await db.update_run(state.run_id,
                        execution_strategy=execution.CONTEXT_PLAYLIST)
    state = await runs.get_state(state.run_id, service.user_id)
    await runs.start(service.session, state, device_id="dev1")
    await execution.drain_fill_tasks()
    stale = service.provider.context_plays[0][0]

    # Der Plan ändert sich unter der laufenden Playlist.
    state.order = list(state.order)
    state.order[3], state.order[4] = state.order[4], state.order[3]
    await db.update_run(state.run_id, order=state.order)
    state = await runs.get_state(state.run_id, service.user_id)

    context = await execution.ensure_context_playlist(
        service.session, state, anchor=state.cursor, background_fill=False,
    )
    assert context["reused"] is False
    assert context["playlist_id"] != stale
    assert stale in service.provider.deleted_playlists
    assert len(await db.list_run_contexts(state.run_id)) == 1


async def test_a_context_that_is_running_out_is_replaced_not_reused(
    service, monkeypatch,
):
    """Der Nachschub muss wirklich Nachschub sein.

    Wird der fast aufgebrauchte Kontext einfach wiederverwendet, erreicht der
    Dienst doch das Ende unserer Karten — und genau in dieser Sekunde übernimmt
    Autoplay das Gerät.
    """
    monkeypatch.setattr(execution, "HEAD_ITEMS", 4)
    monkeypatch.setattr(execution, "CHUNK_ITEMS", 4)
    monkeypatch.setattr(execution, "REFILL_MARGIN", 2)

    state = await _run(service, name="Nachschub")
    await db.update_run(state.run_id,
                        execution_strategy=execution.CONTEXT_PLAYLIST)
    state = await runs.get_state(state.run_id, service.user_id)
    await runs.start(service.session, state, device_id="dev1")
    await execution.drain_fill_tasks()
    first = service.provider.context_plays[0][0]

    # Zwei Karten vor dem Ende des Chunks: ab hier ist Nachschub fällig.
    state.cursor = 3
    assert execution.needs_refill(state) is True

    context = await execution.ensure_context_playlist(
        service.session, state, anchor=state.cursor, background_fill=False,
    )
    assert context["reused"] is False
    assert context["playlist_id"] != first
    assert context["anchor"] == 3


async def test_a_stopped_run_keeps_its_helper_playlist(service):
    """Ein gestoppter Lauf ist fortsetzbar — die Playlist bei jedem Fortsetzen
    neu zu schreiben wäre langsam und im Konto sichtbares Rauschen."""
    state = await _run(service, name="Gestoppt")
    await db.update_run(state.run_id,
                        execution_strategy=execution.CONTEXT_PLAYLIST)
    state = await runs.get_state(state.run_id, service.user_id)
    await runs.start(service.session, state, device_id="dev1")
    await execution.drain_fill_tasks()

    await runs.stop_run(service.session, state)

    assert service.provider.deleted_playlists == []
    assert len(await db.list_run_contexts(state.run_id)) == 1


async def test_hard_deleting_a_run_takes_its_playlists_with_it(service):
    state = await _run(service, name="Gelöscht")
    await db.update_run(state.run_id,
                        execution_strategy=execution.CONTEXT_PLAYLIST)
    state = await runs.get_state(state.run_id, service.user_id)
    await runs.start(service.session, state, device_id="dev1")
    await execution.drain_fill_tasks()
    playlist_id = service.provider.context_plays[0][0]

    await db.upsert_provider_account(
        user_id=service.user_id, provider="fake", provider_user_id="u",
        display_name="U", market="DE", product_tier="premium",
        token={"access_token": "t"},
    )
    assert await runs.hard_delete_run(service.user_id, state.run_id) is True
    assert playlist_id in service.provider.deleted_playlists


async def test_no_prefetch_hands_over_exactly_one_title_per_command(service):
    """Der Notmodus: keine Spuren im Konto, dafür ein Kommando je Titel.

    Er ist der ehrliche Preis-Gegenentwurf zur Hilfs-Playlist — und er muss
    funktionieren, nicht nur im Schema stehen. Entscheidend ist, dass nach
    jedem Trackende wirklich ein neues Kommando rausgeht: der Dienst hat ja
    nur einen Titel bekommen.
    """
    state = await _run(service, name="Notmodus")
    await db.update_run(state.run_id,
                        execution_strategy=execution.NO_PREFETCH)
    state = await runs.get_state(state.run_id, service.user_id)

    await runs.start(service.session, state, device_id="dev1")
    assert service.provider.play_windows[-1] == [state.order[0]]

    for expected in range(1, 4):
        before = len(service.provider.play_windows)
        await runs.advance(service.session, state,
                           reason=AdvanceReason.TRACK_ENDED, device_id="dev1")
        assert len(service.provider.play_windows) == before + 1
        assert service.provider.play_windows[-1] == [state.order[expected]]

    assert service.provider.created == {}          # keine Hilfs-Playlist
    assert service.provider.queued == []           # ADR-002: nie die Queue


async def test_single_uri_folds_onto_no_prefetch(service):
    """Der historische Name im CHECK bekommt keinen eigenen Codepfad."""
    assert execution.normalise("single_uri") == execution.NO_PREFETCH
    assert execution.normalise("unbekannt") == execution.URIS_WINDOW
    assert execution.normalise(None) == execution.URIS_WINDOW


# ---------------------------------------------------------------------------
# Spotifys eigene Regler
# ---------------------------------------------------------------------------

async def test_shuffle_and_repeat_are_forced_off_before_playing(service):
    """true-shuffle IST das Shuffle — das des Dienstes muss aus sein.

    Mit dem Shuffle des Dienstes an wird unsere berechnete Reihenfolge
    nochmals zerlegt, und jeder Titel kommt als etwas an, das der Plan nicht
    vorsah.  Auf Desktop und Handy ist das die naheliegendste Einzelursache
    dafür, dass nach jedem Titel etwas Ungeplantes kam.
    """
    service.provider.shuffle_state = True
    service.provider.repeat_state = "context"
    state = await _run(service, name="Shuffle aus")

    await runs.start(service.session, state, device_id="dev1")

    assert ("shuffle", False) in service.provider.mode_commands
    assert ("repeat", "off") in service.provider.mode_commands
    assert service.provider.shuffle_state is False
    assert service.provider.repeat_state == "off"


async def test_smart_shuffle_is_reported_because_it_cannot_be_switched_off(
    service,
):
    """Die ehrliche Grenze: Smart Shuffle mischt fremde Empfehlungen in die
    Wiedergabe und ist über die Web-API nicht abschaltbar.  Wir können es nur
    sehen und sagen — und genau das muss der Lauf festhalten."""
    from app.watcher import Watcher

    state = await _run(service, name="Smart Shuffle")
    await runs.start(service.session, state, device_id="dev1")
    state = await runs.get_state(state.run_id, service.user_id)

    playback = PlaybackState(
        is_playing=True, track_id=state.current_track_id, progress_ms=1_000,
        duration_ms=180_000, smart_shuffle=True,
    )
    await Watcher()._check_playback_modes(state, service.session, playback)

    fresh = await runs.get_state(state.run_id, service.user_id)
    assert fresh.smart_shuffle_seen is True
    types = [e["type"] for e in await db.list_events(state.run_id)]
    assert "smart_shuffle_detected" in types


async def test_silence_after_a_track_does_not_downgrade_anything(service):
    """Ein zu Ende gehörter Titel plus Stille ist KEIN Beweis über den Client.

    Der Hörer hat vielleicht einfach Spotify geschlossen. Herabzustufen würde
    ihm beim nächsten Start eine Playlist ins Konto schreiben, obwohl sein
    Client die Reihenfolge tadellos gehalten hat — und die Herabstufung ist
    einbahnig.
    """
    from app.watcher import Watcher

    state = await _run(service, name="Stille")
    await runs.start(service.session, state, device_id="dev1")
    await db.record_observation(
        state.run_id, track_id=state.order[0], progress_ms=179_900,
        duration_ms=180_000, satisfied=True,
    )
    state = await runs.get_state(state.run_id, service.user_id)

    verdict = engine.reconcile(state, PlaybackState(is_idle=True),
                               window_size=250)
    assert verdict.reason is AdvanceReason.TRACK_ENDED   # Karte verbraucht
    assert verdict.context_lost is True                  # neu setzen nötig
    assert verdict.foreign_playing is False              # …aber kein Beweis

    watcher = Watcher()
    await watcher._advance_context_lost(
        service.session, state.run_id, service.user_id, state, verdict,
    )

    fresh = await runs.get_state(state.run_id, service.user_id)
    assert fresh.execution_strategy == execution.URIS_WINDOW
    assert service.provider.created == {}
    types = [e["type"] for e in await db.list_events(state.run_id)]
    assert "strategy_downgraded" not in types


async def test_the_configured_strategy_is_not_a_no_op(service):
    """`execution_strategy` war seit Schema v3 validiert, akzeptiert — und
    wirkungslos: niemand las den Wert in den Lauf."""
    config_id = await db.create_config(
        service.user_id, "Ohne Spuren",
        Rules(execution_strategy=execution.NO_PREFETCH),
    )
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER,
        name="Konfiguriert", config_id=config_id,
    )
    fresh = await runs.get_state(state.run_id, service.user_id)
    assert fresh.execution_strategy == execution.NO_PREFETCH

    await runs.start(service.session, fresh, device_id="dev1")
    assert service.provider.play_windows[-1] == [fresh.order[0]]


async def test_a_downgraded_run_is_not_talked_back_by_a_rule_change(service):
    """Die Herabstufung ist eine Messung, keine Voreinstellung."""
    state = await _run(service, name="Bleibt unten")
    await runs.downgrade_strategy(state, cause="test")

    await runs.change_run_rules(
        state, {"execution_strategy": execution.URIS_WINDOW},
    )

    fresh = await runs.get_state(state.run_id, service.user_id)
    assert fresh.execution_strategy == execution.CONTEXT_PLAYLIST


async def test_the_service_shuffle_is_left_alone_while_the_listener_drifts(
    service,
):
    """F8: beobachten statt kämpfen. Ihre Musik, ihr Shuffle."""
    from app.watcher import Watcher, WatchHandle

    state = await _run(service, name="Fremdnutzung")
    await runs.start(service.session, state, device_id="dev1")
    state = await runs.get_state(state.run_id, service.user_id)
    service.provider.mode_commands.clear()

    handle = WatchHandle(run_id=state.run_id, user_id=service.user_id,
                         task=asyncio.get_event_loop().create_future())
    drifting = PlaybackState(
        is_playing=True, track_id="ihr-eigener-titel", progress_ms=5_000,
        duration_ms=200_000, shuffle_state=True,
    )
    # Wie der Watcher es tut: bei Drift gar nicht erst fragen.
    verdict = engine.reconcile(state, drifting, window_size=250)
    assert verdict.drifted is True
    if not verdict.drifted:                       # pragma: no cover
        await Watcher()._check_playback_modes(
            state, service.session, drifting, handle,
        )
    assert service.provider.mode_commands == []


async def test_a_shuffle_that_never_sticks_is_not_corrected_for_ever(service):
    """Eine Korrektur, die nicht konvergiert, ist keine Korrektur.

    Ohne Obergrenze kostet ein Gerät, das den Befehl annimmt und trotzdem
    weiter Shuffle meldet, zwei Schreibzugriffe und eine Ledger-Zeile — bei
    jedem Poll, für immer.
    """
    from app.watcher import MAX_MODE_CORRECTIONS, Watcher, WatchHandle

    state = await _run(service, name="Stures Gerät")
    await runs.start(service.session, state, device_id="dev1")
    state = await runs.get_state(state.run_id, service.user_id)
    service.provider.mode_commands.clear()

    watcher = Watcher()
    handle = WatchHandle(run_id=state.run_id, user_id=service.user_id,
                         task=asyncio.get_event_loop().create_future())
    stubborn = PlaybackState(
        is_playing=True, track_id=state.current_track_id, progress_ms=1_000,
        duration_ms=180_000, shuffle_state=True,
    )
    for _ in range(10):
        await watcher._check_playback_modes(
            state, service.session, stubborn, handle,
        )
        service.provider.shuffle_state = True     # es hält einfach nicht

    assert len(service.provider.mode_commands) == 2 * MAX_MODE_CORRECTIONS
    events = [e for e in await db.list_events(state.run_id)
              if e["type"] == "playback_mode_drift"]
    assert len(events) == MAX_MODE_CORRECTIONS


async def test_the_run_payload_says_which_strategy_is_really_in_use(service):
    state = await _run(service, name="Anzeige")
    await runs.start(service.session, state, device_id="dev1")
    state = await runs.get_state(state.run_id, service.user_id)

    payload = await runs.describe(service.session, state)
    assert payload["context"]["strategy"] == execution.URIS_WINDOW
    assert payload["context"]["anchor"] == 0
    assert payload["smart_shuffle_seen"] is False
