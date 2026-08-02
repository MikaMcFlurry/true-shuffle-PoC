"""Fehler- und Recovery-Matrix (08_ACCEPTANCE_TEST_MATRIX §Fehler und Recovery).

Je Matrixzeile mindestens ein Test über den ECHTEN Pfad — Service-Schicht
(``app/runs.py``, ``app/watcher.py``, ``app/accounts.py``) oder HTTP
(``app/routes_api.py``).  Nichts wird nachgebaut: die Fehler werden dort
injiziert, wo im Betrieb der Connector scheitert, nämlich in den
Provider-Kommandos.

Abgedeckt (simulierbarer Anteil):

* **ERR-01** kein aktives Gerät — Kommando scheitert wie Spotifys
  ``404 NO_ACTIVE_DEVICE`` (``tests/sim_spotify.SimNoActiveDevice``, AN-7):
  Statuscode und Text der HTTP-Antwort, Cursor unbewegt, Ledger sauber, und
  der Watcher hämmert nicht (Backoff statt Endlosschleife).
* **ERR-02** Premium fehlt — der Connector antwortet mit
  ``ProviderPaidTierRequired`` (genau das, was ``providers/http.py``
  ``_auth_error`` aus einem 403 ``PREMIUM_REQUIRED`` macht): verständliche
  deutsche Blockade, der Lauf bleibt erhalten.
* **ERR-03** 401/Tokenrefresh — ``app/accounts.open_session`` refresht
  PROAKTIV beim Öffnen der Sitzung (``needs_refresh``), höchstens einmal je
  Sitzung.  Ein 401 MITTEN in einem Kommando löst bewusst keinen
  Reaktiv-Refresh aus; der Ist-Zustand ist hier gepinnt (siehe Docstrings).
* **ERR-04** 429 — ``ProviderQuotaError`` mit ``retry_after_s``: kein
  Doppelkommando, kein Cursor-Move, HTTP 429 mit deutschem Text, und
  ``watcher._backoff`` respektiert ``Retry-After``.
* **ERR-05** 5xx/Timeout — nach einem transienten Fehler führt EIN erneuter
  Advance GENAU EINEN fachlichen Advance aus (F5-Ereignisschlüssel, eine
  ``run_selections``-Zeile).
* **ERR-06** Track unverfügbar zur Laufzeit — Ist-Zustand gepinnt.
* **ERR-08** Abbruch MITTEN in einer Transition — Ergänzung zu
  ``tests/test_restart_e2e.py``: Crash zwischen Kommando und Verbuchung sowie
  Crash NACH der Verbuchung.

Nicht hier: **ERR-07** (Disconnect) ist in ``tests/test_retention.py``
vollständig abgedeckt.

Live-Rest (BLOCKED, ohne echtes Spotify nicht entscheidbar): ob Spotify bei
einem echten 404/403/429 exakt diese Körper schickt, wie lange ein echtes
``Retry-After`` ausfällt, und ob ein wiederholtes ``PUT /me/player/play`` mit
demselben Fenster live wirklich folgenlos bleibt.

Fixtures sind bewusst lokal (Limit-Abbruch-Resilienz): diese Datei läuft mit
nichts als der Datenbank-Isolation aus ``tests/conftest.py``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from app import db, runs
from app.main import app
from app.watcher import MIN_SLEEP, Watcher, _backoff
from core.models import AdvanceReason, PlaybackState, PlaylistRef, RunMode
from providers.base import (
    ProviderAuthError,
    ProviderError,
    ProviderPaidTierRequired,
    TokenBundle,
)
from tests.conftest import FakeProvider, forget_window
from tests.sim_spotify import SimNoActiveDevice, SimRateLimited

# pytest-asyncio auto mode (pyproject.toml) marks async tests automatically.


# ---------------------------------------------------------------------------
# Lokale Fixtures und Helfer
# ---------------------------------------------------------------------------

class ControlledProvider(FakeProvider):
    """``FakeProvider`` mit programmierbaren Kommando-Fehlern.

    ``tests/conftest.py`` bleibt unangetastet: der Fehlerfall wird per
    Unterklasse injiziert.  ``play_attempts`` zählt JEDEN Versuch — auch den
    gescheiterten — denn genau daran hängt die Aussage „kein Doppelkommando".
    """

    def __init__(self, provider_id: str = "fake") -> None:
        super().__init__(provider_id)
        self.play_attempts = 0
        #: Fabrik für den nächsten play-Fehler; ``None`` = play gelingt.
        self.play_error: Optional[Callable[[], BaseException]] = None
        #: Wie oft der Fehler noch geworfen wird (``None`` = unbegrenzt).
        self.play_error_times: Optional[int] = None
        self.refresh_calls = 0

    async def play(self, token, **kwargs: Any) -> None:
        self.play_attempts += 1
        pending = self.play_error_times is None or self.play_error_times > 0
        if self.play_error is not None and pending:
            if self.play_error_times is not None:
                self.play_error_times -= 1
            raise self.play_error()
        await super().play(token, **kwargs)

    async def refresh(self, token: TokenBundle) -> TokenBundle:
        """Ein Connector, der wirklich ein neues Zugriffstoken ausstellt."""
        self.refresh_calls += 1
        return TokenBundle(
            access_token=f"frisch-{self.refresh_calls}",
            refresh_token=token.refresh_token,
            expires_at=int(time.time()) + 3600,
        )


@dataclass
class Service:
    session: Any
    provider: ControlledProvider
    playlist: PlaylistRef
    user_id: int


@pytest.fixture
def controlled_provider(monkeypatch) -> ControlledProvider:
    """Der Connector unter der id ``fake`` — auch für die HTTP-Tests."""
    from providers import registry

    provider = ControlledProvider()
    monkeypatch.setitem(registry._PROVIDERS, "fake", provider)
    return provider


@pytest_asyncio.fixture
async def service(database, controlled_provider) -> Service:
    from app.accounts import Session

    user_id = await db.get_or_create_user("local-errors")
    await db.upsert_provider_account(
        user_id=user_id, provider="fake", provider_user_id="u",
        display_name="U", market="DE", product_tier="premium",
        token={"access_token": "t"},
    )
    session = Session(
        user_id=user_id, provider=controlled_provider,
        token=TokenBundle(access_token="t"),
    )
    playlist = (await controlled_provider.list_playlists(None))[0]
    return Service(session=session, provider=controlled_provider,
                   playlist=playlist, user_id=user_id)


async def _one(sql: str, params: tuple = ()) -> Any:
    """Ein Skalar aus der AKTUELL offenen Verbindung (übersteht Neustarts)."""
    cur = await db.get_db().execute(sql, params)
    row = await cur.fetchone()
    return row[0] if row is not None else None


async def _new_run(service: Service, name: str):
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER, name=name,
    )
    return state


def _premium_required() -> ProviderPaidTierRequired:
    """Was ``providers/http.py::_auth_error`` aus einem 403 baut."""
    exc = ProviderPaidTierRequired(
        "spotify: this account has no Premium subscription — "
        '{"error": {"status": 403, "reason": "PREMIUM_REQUIRED"}}'
    )
    exc.http_status = 403
    return exc


def _transient_5xx() -> ProviderError:
    """Ein 503, wie ihn ``providers.http`` nach erschöpften Retries wirft."""
    exc = ProviderError("spotify: HTTP 503 — service unavailable")
    exc.http_status = 503
    return exc


def _track_unavailable() -> ProviderError:
    """Ein titelbezogener Fehlschlag des play-Kommandos.

    Spotify beantwortet ein ``PUT /me/player/play`` mit einer im Markt nicht
    verfügbaren URI mit einem Kommandofehler; ``providers.http`` macht daraus
    einen generischen ``ProviderError`` mit ``http_status``.
    """
    exc = ProviderError(
        'spotify: HTTP 404 — {"error": {"status": 404, "message": '
        '"Player command failed: Track not available in this market"}}'
    )
    exc.http_status = 404
    return exc


def _connect(client) -> None:
    from itsdangerous import TimestampSigner

    from app.config import get_settings

    client.get("/auth/fake/login", follow_redirects=False)
    cookie = client.cookies.get("session")
    data = TimestampSigner(get_settings().secret_key).unsign(cookie, max_age=3600)
    oauth_state = json.loads(base64.urlsafe_b64decode(data))["oauth_state"]
    client.get("/auth/fake/callback",
               params={"code": "c", "state": oauth_state},
               follow_redirects=False)


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


def _deal(client) -> int:
    response = client.post("/api/runs", json={
        "provider": "fake", "playlist_id": "pl1", "mode": "controller",
    })
    return _wait_for_job(client, response.json()["job_id"])["run_id"]


async def _watch_run(service: Service, total: int = 6) -> int:
    """Ein aktiver Controller-Lauf, wie ihn der Watcher vorfindet."""
    order = [t.id for t in service.provider.tracks[:total]]
    return await db.create_run(
        user_id=service.user_id, provider="fake", playlist_id="pl1",
        playlist_name="Everything", mode="controller", order=order,
        status="active",
    )


# ---------------------------------------------------------------------------
# ERR-01 — kein aktives Gerät
# ---------------------------------------------------------------------------

def test_err01_no_active_device_refuses_and_moves_nothing(controlled_provider):
    """ERR-01: ohne aktives Gerät scheitert das Kommando — und NUR das.

    Über HTTP (``POST /runs/{id}/start`` und ``…/advance``) belegt der Test
    den Ist-Zustand: ein Statuscode aus der Fehlerklasse (kein 500, keine
    stille 200), ein Text im Körper, und danach steht der Lauf unverändert da
    — Cursor 0, Status ``active``, im Verlauf keine ``advanced``-Zeile.  Das
    ist die halbe Matrixzeile: „keine stille Endlosschleife".  Die andere
    Hälfte („klare Geräteaktion") prüft der xfail-Test darunter.
    """
    # Teständerung 2026-08-01 (dokumentierte fachliche Begründung, ERR-01-Fix):
    # „kein aktives Gerät" hat jetzt eine eigene Fehlerklasse
    # (providers.base.ProviderNoActiveDevice, 409 + deutsche Geräteaktion) —
    # der frühere Pin auf den rohen 502 beschrieb den Vor-Fix-Zustand.
    controlled_provider.play_error = SimNoActiveDevice
    with TestClient(app) as client:
        _connect(client)
        run_id = _deal(client)

        started = client.post(f"/api/runs/{run_id}/start",
                              json={"device_id": "dev1"})
        assert started.status_code == 409, started.text
        assert started.json()["detail"]
        assert started.status_code != 500

        advanced = client.post(f"/api/runs/{run_id}/advance",
                               json={"reason": "track_ended"})
        assert advanced.status_code == 409, advanced.text

        payload = client.get(f"/api/runs/{run_id}").json()
        assert payload["cursor"] == 0
        assert payload["status"] == "active"
        events = client.get(f"/api/runs/{run_id}/events").json()["events"]
        assert [e["type"] for e in events] == ["run_created"]
        assert controlled_provider.played == []
        assert controlled_provider.queued == []


def test_err01_the_refusal_names_a_device_action_in_german(controlled_provider):
    """ERR-01: die Verweigerung trägt eine klare deutsche Geräteaktion.

    Rot-vor-Fix-Historie: dieser Test war strict-xfail, solange „kein
    aktives Gerät" keine eigene Fehlerklasse hatte und der Rohtext des
    Dienstes als 502 durchgereicht wurde.  Seit dem ERR-01-Fix
    (``providers/base.py::ProviderNoActiveDevice`` + ``_USER_MESSAGES``,
    Mapping in ``providers/http.py`` auf ``404 NO_ACTIVE_DEVICE``) ist die
    Matrix-Erwartung erfüllt — der xfail-Marker wurde mit dem Fix entfernt
    (dokumentierte Teständerung 2026-08-01).
    """
    controlled_provider.play_error = SimNoActiveDevice
    with TestClient(app) as client:
        _connect(client)
        run_id = _deal(client)
        started = client.post(f"/api/runs/{run_id}/start",
                              json={"device_id": "dev1"})
        detail = started.json()["detail"]
        assert "Gerät" in detail


async def test_err01_watcher_backs_off_instead_of_hammering(
    database, service,
):
    """ERR-01: der Watcher wiederholt ein gescheitertes Kommando nicht sofort.

    ``tests/test_watcher.py::test_watcher_survives_a_provider_error`` belegt
    bereits, dass ein LESEfehler den Watcher nicht tötet.  Hier fehlt der
    andere Aspekt: ein dauerhaft scheiterndes KOMMANDO (Gerät weg).
    ``app/watcher.py::_backoff`` erzwingt mindestens ``MIN_SLEEP`` = 1 s, also
    darf in 0,5 s höchstens EIN Versuch stehen — ohne Backoff wären es bei
    ``WATCHER_POLL_SECONDS=0.01`` (conftest) dutzende.

    Zusätzlich: der Lauf bleibt erhalten (aktiv, Cursor unbewegt) und das
    Ledger bleibt sauber — ein gescheitertes Kommando verbucht nichts.
    """
    run_id = await _watch_run(service)
    order = (await db.get_run(run_id))["order"]
    service.provider.play_error = SimNoActiveDevice
    # Der Dienst spielt bereits den zweiten Titel → reconcile sagt
    # „advance", der Advance schickt ein Fenster (kein Anker gesetzt) …
    service.provider.state = PlaybackState(
        is_playing=True, track_id=order[1], progress_ms=5_000,
        duration_ms=180_000, device_id="dev1",
    )

    watcher = Watcher()
    try:
        assert await watcher.ensure(run_id, service.user_id) is True
        await asyncio.sleep(0.5)
        assert service.provider.play_attempts == 1
        assert watcher.is_watching(run_id) is True
    finally:
        await watcher.stop_all()

    run = await db.get_run(run_id)
    assert run["status"] == "active"
    assert run["cursor"] == 0
    assert run["selection_seq"] == 0
    types = [e["type"] for e in await db.list_events(run_id)]
    assert "advanced" not in types
    assert await _one(
        "SELECT count(*) FROM run_selections WHERE run_id = ?", (run_id,)
    ) == 0
    assert service.provider.queued == []


# ---------------------------------------------------------------------------
# ERR-02 — Premium fehlt
# ---------------------------------------------------------------------------

def test_err02_missing_premium_is_an_understandable_block(controlled_provider):
    """ERR-02: verständliche Blockade, der Lauf bleibt erhalten.

    Seit Spotify ``product`` aus ``GET /me`` entfernt hat, ist die Ablehnung
    des Kommandos der erste ehrliche Moment (``providers/base.py``
    ``ProviderPaidTierRequired``).  Über HTTP heißt das: 402 statt 500, der
    deutsche Satz aus ``_USER_MESSAGES`` (mit dem Ausweg Handoff-Modus) — und
    danach ist der Lauf weder abgebrochen noch fortgeschritten.
    """
    controlled_provider.play_error = _premium_required
    with TestClient(app) as client:
        _connect(client)
        run_id = _deal(client)

        started = client.post(f"/api/runs/{run_id}/start",
                              json={"device_id": "dev1"})
        assert started.status_code == 402, started.text
        detail = started.json()["detail"]
        assert "Abo" in detail and "Handoff" in detail

        payload = client.get(f"/api/runs/{run_id}").json()
        assert payload["status"] == "active"      # nicht cancelled
        assert payload["cursor"] == 0
        # Der Lauf ist weiter bedienbar: pausieren und fortsetzen geht.
        assert client.post(f"/api/runs/{run_id}/pause").status_code == 200
        assert client.get(f"/api/runs/{run_id}").json()["status"] == "paused"
        resumed = client.post(f"/api/runs/{run_id}/resume")
        assert resumed.status_code == 200
        assert resumed.json() == {"status": "active", "cursor": 0}


async def test_err02_premium_refusal_keeps_the_deck_untouched(
    database, service,
):
    """ERR-02 auf Service-Ebene: die Karten bleiben, wie sie waren.

    Der Fehler tritt VOR jeder Verbuchung auf (ADR-002 Auflage 1: erst das
    Kommando, dann das Ledger), also ist nach der Ablehnung keine Karte
    verbraucht und keine Auswahlzeile geschrieben.
    """
    state = await _new_run(service, "premium")
    service.provider.play_error = _premium_required

    with pytest.raises(ProviderPaidTierRequired):
        await runs.start(service.session, state, device_id="dev1")

    run = await db.get_run(state.run_id)
    assert run["status"] == "active" and run["cursor"] == 0
    assert await _one(
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND state != 'open'",
        (state.run_id,),
    ) == 0
    assert await _one(
        "SELECT count(*) FROM run_selections WHERE run_id = ?", (state.run_id,)
    ) == 0
    assert service.provider.play_attempts == 1   # kein blinder zweiter Versuch


# ---------------------------------------------------------------------------
# ERR-03 — 401 / Tokenrefresh
# ---------------------------------------------------------------------------

async def test_err03_an_expired_token_is_refreshed_once_on_session_open(
    database, controlled_provider,
):
    """ERR-03: „höchstens kontrollierter Retry" — hier: genau EIN Refresh.

    Der Refreshweg hängt im Code an der Sitzungsöffnung
    (``app/accounts.py::open_session`` → ``provider.needs_refresh`` →
    ``provider.refresh`` → ``db.update_account_token``), nicht an einem
    401-Handler.  Der Test belegt beides: das abgelaufene Token wird genau
    einmal getauscht und persistiert, und die nächste Sitzung mit dem
    frischen Token refresht NICHT noch einmal.
    """
    from app import accounts

    user_id = await db.get_or_create_user("local-refresh")
    await db.upsert_provider_account(
        user_id=user_id, provider="fake", provider_user_id="u",
        display_name="U", market="DE", product_tier="premium",
        token={"access_token": "abgelaufen", "refresh_token": "r",
               "expires_at": int(time.time()) - 10},
    )

    session = await accounts.open_session(user_id, "fake")
    assert controlled_provider.refresh_calls == 1
    assert session.token.access_token == "frisch-1"
    stored = await db.get_provider_account(user_id, "fake")
    assert stored["token"]["access_token"] == "frisch-1"

    again = await accounts.open_session(user_id, "fake")
    assert controlled_provider.refresh_calls == 1      # kein zweiter Tausch
    assert again.token.access_token == "frisch-1"


def test_err03_a_401_during_a_command_is_not_silently_retried(
    controlled_provider,
):
    """ERR-03, Ist-Zustand: ein 401 MITTEN im Kommando wird NICHT nachgeholt.

    Befund, ehrlich gepinnt: ``app/accounts.py`` refresht ausschließlich
    proaktiv beim Öffnen der Sitzung (Zeile 60-63).  Es gibt keinen
    Reaktiv-Refresh — wird ein Token zwischen Sitzungsöffnung und Kommando
    ungültig (Nutzer widerruft die Freigabe, Spotify invalidiert), reist der
    ``ProviderAuthError`` unverändert bis zum Browser: HTTP 401, ein
    Kommandoversuch, kein zweiter.

    Das erfüllt „höchstens kontrollierter Retry" (es ist null Retry) und ist
    darum KEIN Fehlschlag — aber die Matrixzeile meint erkennbar den
    Selbstheilungsfall, und den gibt es hier nicht.  Kein xfail: der Code
    entscheidet bewusst so, die Lücke gehört in den Bericht.
    """
    def expired() -> ProviderAuthError:
        exc = ProviderAuthError("spotify: credentials rejected — 401")
        exc.http_status = 401
        return exc

    controlled_provider.play_error = expired
    with TestClient(app) as client:
        _connect(client)
        run_id = _deal(client)
        started = client.post(f"/api/runs/{run_id}/start",
                              json={"device_id": "dev1"})
        assert started.status_code == 401, started.text
        assert controlled_provider.play_attempts == 1
        assert client.get(f"/api/runs/{run_id}").json()["cursor"] == 0


# ---------------------------------------------------------------------------
# ERR-04 — 429
# ---------------------------------------------------------------------------

def test_err04_quota_answers_429_and_sends_no_second_command(
    controlled_provider,
):
    """ERR-04: ein 429 beendet den Versuch — es folgt kein Doppelkommando.

    ``providers/http.py`` wartet ein transientes ``Retry-After`` innerhalb
    EINER Anfrage aus; was bis hier durchkommt, ist der Aufgabefall.  Dann
    gilt: HTTP 429 mit dem deutschen Kontingent-Satz, genau ein
    Kommandoversuch, Cursor unbewegt, nichts verbucht.
    """
    controlled_provider.play_error = lambda: SimRateLimited(30)
    with TestClient(app) as client:
        _connect(client)
        run_id = _deal(client)
        started = client.post(f"/api/runs/{run_id}/start",
                              json={"device_id": "dev1"})
        assert started.status_code == 429, started.text
        assert "Kontingent" in started.json()["detail"]

        advanced = client.post(f"/api/runs/{run_id}/advance",
                               json={"reason": "track_ended"})
        assert advanced.status_code == 429, advanced.text
        assert controlled_provider.play_attempts == 2   # ein Versuch je Aufruf

        payload = client.get(f"/api/runs/{run_id}").json()
        assert payload["cursor"] == 0 and payload["status"] == "active"
        events = client.get(f"/api/runs/{run_id}/events").json()["events"]
        assert [e["type"] for e in events] == ["run_created"]


def test_err04_backoff_respects_retry_after():
    """ERR-04: ``watcher._backoff`` nimmt ``Retry-After`` ernst.

    Der Watcher fängt ``ProviderError`` und schläft nach
    ``app/watcher.py::_backoff``: ein 429 mit ``retry_after_s`` gewinnt gegen
    den Basisrhythmus, ein Fehler ohne Angabe fällt auf ``base * 2`` bzw. die
    Untergrenze ``MIN_SLEEP`` zurück.
    """
    assert _backoff(SimRateLimited(30), 4.0) == 30.0
    assert _backoff(SimRateLimited(1), 4.0) == 8.0        # base*2 gewinnt
    assert _backoff(SimNoActiveDevice(), 4.0) == 8.0      # ohne Retry-After
    assert _backoff(SimNoActiveDevice(), 0.01) == MIN_SLEEP


async def test_err04_watcher_does_not_repeat_the_command_under_quota(
    database, service,
):
    """ERR-04 im Watcher: unter Kontingentdruck bleibt es bei EINEM Kommando.

    Derselbe Aufbau wie der ERR-01-Watchertest, aber mit einem 429 samt
    ``Retry-After`` — der Backoff ist damit noch länger, das beobachtbare
    Ergebnis dasselbe: kein zweites Kommando im Messfenster, Lauf erhalten.
    """
    run_id = await _watch_run(service)
    order = (await db.get_run(run_id))["order"]
    service.provider.play_error = lambda: SimRateLimited(30)
    service.provider.state = PlaybackState(
        is_playing=True, track_id=order[1], progress_ms=5_000,
        duration_ms=180_000, device_id="dev1",
    )

    watcher = Watcher()
    try:
        assert await watcher.ensure(run_id, service.user_id) is True
        await asyncio.sleep(0.5)
        assert service.provider.play_attempts == 1
    finally:
        await watcher.stop_all()

    run = await db.get_run(run_id)
    assert run["cursor"] == 0 and run["status"] == "active"
    assert await _one(
        "SELECT count(*) FROM run_selections WHERE run_id = ?", (run_id,)
    ) == 0


# ---------------------------------------------------------------------------
# ERR-05 — 5xx / Timeout: idempotente Recovery
# ---------------------------------------------------------------------------

async def test_err05_one_retry_after_a_transient_error_advances_exactly_once(
    database, service,
):
    """ERR-05: ein transienter Fehler kostet keine Karte, der Retry genau eine.

    Ablauf über den echten Pfad: ``start`` gelingt, der nächste Advance
    scheitert am 503 (``_apply`` wirft, bevor ``_book_advance`` läuft — ADR-002
    Auflage 1), der Advance danach gelingt.  Belegt wird die Idempotenz am
    Ledger: EINE ``run_selections``-Zeile, EIN angewandtes ``advanced``-Event,
    keine ``applied=0``-Zeile, ``play_count`` nirgends über 1.

    Der Fensterspeicher wird vorher geleert, weil ein Advance INNERHALB eines
    gesetzten uris-Fensters gar kein Kommando schickt (ADR-002) — scheitern
    kann nur, was gesendet wird.  „Fenster unbekannt" ist genau die Lage nach
    einem Prozessneustart oder einem fehlgeschlagenen Re-Assert.
    """
    state = await _new_run(service, "5xx")
    await runs.start(service.session, state, device_id="dev1")
    attempts_after_start = service.provider.play_attempts
    await forget_window(state.run_id)
    state = await runs.get_state(state.run_id, service.user_id)
    assert state.window_anchor is None

    service.provider.play_error = _transient_5xx
    service.provider.play_error_times = 1
    with pytest.raises(ProviderError):
        await runs.advance(
            service.session, state, reason=AdvanceReason.TRACK_ENDED
        )

    # Nach dem Fehlschlag: nichts bewegt, nichts verbucht.
    run = await db.get_run(state.run_id)
    assert run["cursor"] == 0 and run["selection_seq"] == 0
    assert state.cursor == 0
    assert await _one(
        "SELECT count(*) FROM run_selections WHERE run_id = ?", (state.run_id,)
    ) == 0

    # Genau ein erneuter Advance — und der zählt genau einmal.
    fresh = await runs.get_state(state.run_id, service.user_id)
    decision = await runs.advance(
        service.session, fresh, reason=AdvanceReason.TRACK_ENDED
    )
    assert decision.advanced is True and decision.cursor == 1

    run = await db.get_run(state.run_id)
    assert run["cursor"] == 1 and run["selection_seq"] == 1
    assert await _one(
        "SELECT count(*) FROM run_selections WHERE run_id = ?", (state.run_id,)
    ) == 1
    assert await _one(
        "SELECT count(*) FROM run_events WHERE run_id = ? AND type = 'advanced' "
        "AND applied = 1",
        (state.run_id,),
    ) == 1
    assert await _one(
        "SELECT count(*) FROM run_events WHERE run_id = ? AND applied = 0",
        (state.run_id,),
    ) == 0
    assert await _one(
        "SELECT max(play_count) FROM run_tracks WHERE run_id = ?",
        (state.run_id,),
    ) == 1
    # Zwei Kommandoversuche für einen fachlichen Advance: der gescheiterte und
    # der geglückte.  Mehr darf es nicht sein (SP-005).
    assert service.provider.play_attempts == attempts_after_start + 2


async def test_err05_the_failed_attempt_leaves_no_ledger_trace(
    database, service,
):
    """ERR-05, Ist-Zustand: der Fehlschlag selbst steht in KEINEM Ereignis.

    ``app/runs.py::advance`` lässt den ``ProviderError`` durch, ohne ihn zu
    protokollieren; nur die Aufrufer loggen (``app/watcher.py`` Zeile 341).
    Für ein Fenster-Re-Assert gibt es dagegen sehr wohl ein Ereignis
    (``window_reassert_failed``, ``app/runs.py`` Zeile 1381).  Der Verlauf des
    Laufs erzählt also nicht, dass ein Kommando scheiterte — hier gepinnt,
    damit die Asymmetrie nicht unbemerkt bleibt.
    """
    state = await _new_run(service, "5xx-ledger")
    await runs.start(service.session, state, device_id="dev1")
    events_before = len(await db.list_events(state.run_id))
    await forget_window(state.run_id)
    state = await runs.get_state(state.run_id, service.user_id)

    service.provider.play_error = _transient_5xx
    service.provider.play_error_times = 1
    with pytest.raises(ProviderError):
        await runs.advance(
            service.session, state, reason=AdvanceReason.TRACK_ENDED
        )

    assert len(await db.list_events(state.run_id)) == events_before


# ---------------------------------------------------------------------------
# ERR-06 — Track unverfügbar (Laufzeitfall)
# ---------------------------------------------------------------------------

async def test_err06_a_permanent_failure_consumes_one_failure_hop_per_call(
    database, service,
):
    """ERR-06 nach dem Fix: genau EIN Fehler-Hop je Advance-Aufruf.

    Teständerung 2026-08-01 (dokumentierte fachliche Begründung): die alte
    Fassung pinnte den Vor-Fix-Stillstand („Deck steht, keine Policy").
    Seit dem reaktiven ``PLAYBACK_FAILED``-Zweig in ``app/runs.py::advance``
    gilt: die echte Transition wird verbucht, die unspielbare Karte wird
    reaktiv konsumiert, die Folgekarte wird angespielt — und scheitert AUCH
    sie, ist nach genau einem Hop Schluss (kein Durchballern durchs Deck;
    die nächste Beobachtung oder ein manueller Start versucht es erneut).
    """
    state = await _new_run(service, "unspielbar")
    await runs.start(service.session, state, device_id="dev1")
    blocked = state.order[1]
    await forget_window(state.run_id)
    state = await runs.get_state(state.run_id, service.user_id)

    service.provider.play_error = _track_unavailable
    attempts_before = service.provider.play_attempts
    decision = await runs.advance(
        service.session, state, reason=AdvanceReason.TRACK_ENDED
    )

    run = await db.get_run(state.run_id)
    assert run["cursor"] == 2                       # Transition + 1 Hop
    assert run["status"] == "active"
    card = await db.find_run_track(state.run_id, provider_track_id=blocked)
    assert card["play_count"] == 1                  # reaktiv konsumiert (F4)
    assert card["state"] != "open"
    # Kein Ausschluss — ein Wiedersehen im nächsten Zyklus bleibt möglich.
    assert await _one(
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND state LIKE "
        "'excluded%'",
        (state.run_id,),
    ) == 0
    # Genau zwei Kommandoversuche (Karte 1, dann Karte 2) — kein weiterer.
    assert service.provider.play_attempts == attempts_before + 2
    reasons = [e["reason"] for e in await db.list_events(state.run_id)]
    assert reasons.count(AdvanceReason.PLAYBACK_FAILED.value) >= 1
    assert decision.advanced is True

    # Sobald der Dienst wieder spielt, läuft das Deck normal weiter.
    service.provider.play_error = None
    fresh = await runs.get_state(state.run_id, service.user_id)
    ok = await runs.advance(
        service.session, fresh, reason=AdvanceReason.TRACK_ENDED
    )
    assert ok.advanced is True
    assert (await db.get_run(state.run_id))["cursor"] == 3


def test_err06_over_http_the_run_survives_an_unplayable_title(
    controlled_provider,
):
    """ERR-06 über den Draht: 502 mit dem Wortlaut des Dienstes, Lauf intakt.

    Ist-Zustand: ``ProviderError.status_code`` ist 502, und ``user_message``
    kennt für diesen Fall keinen deutschen Satz (``providers/base.py``
    Zeilen 101-122) — der Hörer liest die Rohmeldung.  Für die Matrixzeile
    zählt hier: der Lauf bleibt erhalten und die Karte unverbraucht.
    """
    controlled_provider.play_error = _track_unavailable
    with TestClient(app) as client:
        _connect(client)
        run_id = _deal(client)
        started = client.post(f"/api/runs/{run_id}/start",
                              json={"device_id": "dev1"})
        assert started.status_code == 502, started.text
        assert "Track not available" in started.json()["detail"]

        payload = client.get(f"/api/runs/{run_id}").json()
        assert payload["status"] == "active" and payload["cursor"] == 0
        tracks = client.get(f"/api/runs/{run_id}/tracks").json()["tracks"]
        assert all(t["state"] == "open" for t in tracks)


async def test_err06_a_failed_playback_is_caught_reactively_as_promised(
    database, service,
):
    """ERR-06: die reaktive Behandlung gilt jetzt auch serverseitig.

    Rot-vor-Fix-Historie: strict-xfail, solange nur der Web-Player-Zweig
    ``playback_failed`` melden konnte und der ferngesteuerte Weg auf der
    unspielbaren Karte stehen blieb.  Seit dem ERR-06-Fix in
    ``app/runs.py::advance`` (track-level ProviderError ⇒ Transition
    verbuchen, Karte reaktiv als ``PLAYBACK_FAILED`` konsumieren, Folgekarte
    anspielen) ist das Versprechen aus ``providers/spotify.py`` eingelöst —
    xfail-Marker mit dem Fix entfernt (dokumentierte Teständerung
    2026-08-01).
    """
    state = await _new_run(service, "err06-reaktiv")
    await runs.start(service.session, state, device_id="dev1")
    await forget_window(state.run_id)
    state = await runs.get_state(state.run_id, service.user_id)
    service.provider.play_error = _track_unavailable

    await runs.advance(service.session, state, reason=AdvanceReason.TRACK_ENDED)

    run = await db.get_run(state.run_id)
    assert run["cursor"] >= 1
    reasons = [e["reason"] for e in await db.list_events(state.run_id)]
    assert AdvanceReason.PLAYBACK_FAILED.value in reasons


# ---------------------------------------------------------------------------
# ERR-08 — Abbruch MITTEN in einer Transition
# ---------------------------------------------------------------------------

async def _restart_process(service: Service):
    """Prozessneustart auf DERSELBEN Datei (Muster aus test_restart_e2e).

    Seit M012 überlebt der Fensteranker den Neustart bewusst — er steht in der
    ``runs``-Zeile, nicht mehr in einem prozesslokalen Dict. Genau das ist der
    Sinn der Migration: ein verlorener Anker hat die Kontextende-Erkennung nach
    jedem Neustart stillschweigend abgeschaltet.
    """
    from app.accounts import Session

    await db.close_db()
    await db.init_db()
    return Session(user_id=service.user_id, provider=service.provider,
                   token=TokenBundle(access_token="t"))


async def test_err08_a_crash_between_command_and_booking_leaves_no_half_move(
    database, service, monkeypatch,
):
    """ERR-08: Absturz NACH dem Kommando, VOR der Verbuchung.

    Das ist die gefährliche Lücke: der Dienst hat den nächsten Titel schon
    bekommen, das Ledger weiß noch nichts davon.  ``db.book_advance`` bricht
    hier hart ab (wie ein Prozesstod), danach folgt ein echter Neustart
    (``close_db``/``init_db`` auf derselben Datei).

    Erwartung und Ergebnis: keine halbe Transition.  Der Cursor steht noch auf
    der alten Karte, ``selection_seq`` ist 0, keine Planzeile ist konsumiert —
    und der EINE Advance nach dem Neustart verbucht genau einmal.

    Seit M012/ADR-005 kostet das auch kein zweites Kommando mehr: der Anker
    steht in der Datenbank, also weiß der neu gestartete Prozess, dass der
    Dienst die nächste Karte längst bekommen hat, und schickt sie nicht noch
    einmal.  Vorher war genau das der Preis der Reihenfolge „erst Kommando,
    dann Ledger" (ADR-002 Auflage 1) — und live ein hörbarer Titel-Neustart.
    """
    state = await _new_run(service, "crash-vor-buchung")
    run_id = state.run_id
    await runs.start(service.session, state, device_id="dev1")
    attempts_after_start = service.provider.play_attempts
    # Damit überhaupt ein Kommando fließt, das der Absturz überholen kann.
    await forget_window(state.run_id)
    state = await runs.get_state(run_id, service.user_id)

    async def crash(*args: Any, **kwargs: Any) -> bool:
        raise RuntimeError("Prozess stirbt zwischen Kommando und Verbuchung")

    monkeypatch.setattr(db, "book_advance", crash)
    with pytest.raises(RuntimeError):
        await runs.advance(
            service.session, state, reason=AdvanceReason.TRACK_ENDED
        )
    monkeypatch.undo()
    assert service.provider.play_attempts == attempts_after_start + 1

    session = await _restart_process(service)

    run = await db.get_run(run_id)
    assert run["cursor"] == 0                       # keine halbe Transition
    assert run["selection_seq"] == 0
    assert run["status"] == "active"
    assert await _one(
        "SELECT count(*) FROM run_plan WHERE run_id = ? AND state = 'consumed'",
        (run_id,),
    ) == 0
    assert await _one(
        "SELECT count(*) FROM run_selections WHERE run_id = ?", (run_id,)
    ) == 0

    resumed = await runs.get_state(run_id, service.user_id)
    decision = await runs.advance(
        session, resumed, reason=AdvanceReason.TRACK_ENDED
    )
    assert decision.advanced is True and decision.cursor == 1

    run = await db.get_run(run_id)
    assert run["cursor"] == 1 and run["selection_seq"] == 1
    assert await _one(
        "SELECT count(*) FROM run_selections WHERE run_id = ?", (run_id,)
    ) == 1
    assert await _one(
        "SELECT count(*) FROM run_events WHERE run_id = ? AND applied = 0",
        (run_id,),
    ) == 0
    assert await _one(
        "SELECT max(play_count) FROM run_tracks WHERE run_id = ?", (run_id,)
    ) == 1
    # EIN Kommando insgesamt: das vor dem Absturz.  Der persistierte Anker
    # macht das zweite überflüssig (vorher: attempts_after_start + 2).
    assert service.provider.play_attempts == attempts_after_start + 1


async def test_err08_a_crash_after_the_booking_keeps_the_transition_whole(
    database, service, monkeypatch,
):
    """ERR-08, andere Absturzstelle: NACH der Verbuchung, vor der Antwort.

    ``db.book_advance`` ist EINE Transaktion mit EINEM Commit
    (``app/db.py`` Zeilen 1269-1350) — stirbt der Prozess danach, ist die
    Transition vollständig, nicht halb.  Der Test belegt das nach echtem
    Neustart: Cursor exakt eins weiter, genau eine Auswahlzeile, die Planzeile
    konsumiert, die nächste ``current``.

    Und weiter geht es sauber: der Lauf wird von der NEU gelesenen Karte aus
    zu Ende gehört, jede Karte genau einmal, ohne ``stale``-Zeile (F5).
    """
    state = await _new_run(service, "crash-nach-buchung")
    run_id = state.run_id
    await runs.start(service.session, state, device_id="dev1")
    total = len(state.order)

    real_book = db.book_advance

    async def book_then_crash(*args: Any, **kwargs: Any) -> bool:
        await real_book(*args, **kwargs)
        raise RuntimeError("Prozess stirbt nach dem Commit")

    monkeypatch.setattr(db, "book_advance", book_then_crash)
    with pytest.raises(RuntimeError):
        await runs.advance(
            service.session, state, reason=AdvanceReason.TRACK_ENDED
        )
    monkeypatch.undo()

    session = await _restart_process(service)

    run = await db.get_run(run_id)
    assert run["cursor"] == 1 and run["selection_seq"] == 1
    assert await _one(
        "SELECT count(*) FROM run_selections WHERE run_id = ?", (run_id,)
    ) == 1
    plan = await db.list_active_plan(run_id)
    assert plan[0]["state"] == "consumed" and plan[1]["state"] == "current"

    resumed = await runs.get_state(run_id, service.user_id)
    guard = 0
    while resumed.status.value == "active":
        await runs.advance(session, resumed, reason=AdvanceReason.TRACK_ENDED)
        guard += 1
        assert guard < 50

    assert await _one(
        "SELECT count(*) FROM run_selections WHERE run_id = ?", (run_id,)
    ) == total
    assert await _one(
        "SELECT count(*) FROM run_events WHERE run_id = ? AND applied = 0",
        (run_id,),
    ) == 0
    assert await _one(
        "SELECT max(play_count) FROM run_tracks WHERE run_id = ?", (run_id,)
    ) == 1
