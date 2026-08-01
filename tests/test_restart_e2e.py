"""RUN-02 / UC-30 — ein Lauf überlebt den Prozessneustart.

Die Evidence-Matrix stufte RUN-02 (und damit den Restart-Baustein von UC-30)
auf **TEILWEISE** herunter, mit exakt dieser Begründung: das Verhalten wurde
von einem Prüfer manuell reproduziert, aber „es fehlt ein benannter,
dauerhafter Test dafür in der Suite".  Die bis dahin zitierten Belege trugen
die Aussage nicht — ``test_strategy_candidates.py`` läuft gegen
``tests/forensics/strategy_bench.py`` (Modul-Docstring: „nothing is integrated
into the app code"; der dortige „Restart" ist eine In-Memory-Ganzzahl), und
``test_engine.py::test_resume_returns_to_the_stored_cursor_not_the_top`` baut
die ``RunState`` nur im Speicher auf, ohne Datenbank.

Diese Datei ist dieser Test — gegen echten App-Code und eine echte
SQLite-Datei, auf beiden Ebenen:

* **Service-Ebene**: ``create_run_v3`` → ``start`` → 2× ``advance`` →
  ``db.close_db()`` + ``db.init_db()`` auf DERSELBEN Datei → ``resume_run``
  → weiterhören bis ``completed``.
* **HTTP-Ebene**: derselbe Ablauf über zwei NACHEINANDER geöffnete
  ``TestClient``-Kontexte.  Der Kontextwechsel fährt die Lifespan herunter
  (``close_db``) und wieder hoch (``init_db``) — das ist der Prozessneustart,
  den ein Deploy oder ein Fly-Maschinen-Stopp verursacht.

Was dabei bewiesen wird:

* Cursor, Status und Reihenfolge stehen nach dem Neustart exakt wie vorher;
* nichts wird doppelt verbucht (F5): ``run_selections`` zählt genau einen
  Eintrag je Übergang, der Verlauf hat keine ``stale``-Zeile;
* ``runs._window_anchors`` ist prozesslokal und nach dem Neustart leer
  (Matrix-Restnotiz G3/SP-006) — der erste ``start`` danach schickt darum ein
  frisches ``uris``-Fenster; ``fake_provider.play_windows`` wächst.

Der Browser hält seine Session-Cookie über den Serverneustart hinweg; die
lokale Identität hängt an genau dieser Cookie (``app/deps.py``: ein zufälliger
Handle in der Session, NICHT die Provider-Identität).  Der HTTP-Test reicht
sie darum an den zweiten Client weiter — ein frisch „verbundener" Client wäre
ein anderer Nutzer und sähe den Lauf zu Recht nicht.

Fixtures sind bewusst lokal (Limit-Abbruch-Resilienz).
"""

from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from app import db, runs
from app.main import app
from core.models import AdvanceReason, PlaylistRef, RunMode, RunState, RunStatus
from providers.base import TokenBundle
from tests.conftest import FakeProvider

# pytest-asyncio auto mode (pyproject.toml) marks async tests automatically.


# ---------------------------------------------------------------------------
# Lokale Fixtures und Helfer (standalone — Muster aus tests/test_policies.py)
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
    user_id = await db.get_or_create_user("local-restart")
    session = Session(
        user_id=user_id, provider=provider, token=TokenBundle(access_token="t")
    )
    playlist = (await provider.list_playlists(None))[0]  # "pl1", 12 Titel
    return Service(session=session, provider=provider, playlist=playlist,
                   user_id=user_id)


async def _one(sql, params=()):
    """Ein Skalar aus der AKTUELL offenen Verbindung.

    Bewusst über ``db.get_db()`` statt über das ``database``-Fixture-Objekt:
    nach dem simulierten Neustart ist die alte Verbindung geschlossen, und
    genau das soll der Test ja beweisen.
    """
    cur = await db.get_db().execute(sql, params)
    row = await cur.fetchone()
    return row[0] if row is not None else None


def _new_session(service: Service):
    """Die Sitzung, die ein frisch gestarteter Prozess aufbaut.

    Dasselbe Konto, derselbe Connector — aber ein neues ``Session``-Objekt,
    denn das alte gehörte einem Prozess, den es nicht mehr gibt.
    """
    from app.accounts import Session

    return Session(user_id=service.user_id, provider=service.provider,
                   token=TokenBundle(access_token="t"))


async def _restart_process(service: Service) -> object:
    """Prozessneustart über DERSELBEN Datenbankdatei.

    ``DB_PATH`` setzt die autouse-Fixture aus ``tests/conftest.py`` auf eine
    Datei unter ``tmp_path``; sie wird hier absichtlich NICHT neu gepatcht —
    genau darauf beruht die Aussage „dieselbe Datei".  Zusätzlich fällt der
    prozesslokale Fensterspeicher weg, wie er es bei einem echten Neustart tut.
    """
    await db.close_db()
    await db.init_db()
    runs._window_anchors.clear()
    return _new_session(service)


# ---------------------------------------------------------------------------
# Service-Ebene — create_run_v3 → advance → close/init → resume_run
# ---------------------------------------------------------------------------

async def test_restart_keeps_cursor_status_and_order_and_finishes_the_run(
    database, service
):
    """RUN-02: nach ``close_db``/``init_db`` auf derselben Datei setzt
    ``resume_run`` den Lauf an genau derselben Karte fort — und der Lauf läuft
    danach bis ``completed`` durch, ohne dass eine Karte doppelt verbucht wird.
    """
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER, name="Autofahrt")
    run_id = state.run_id
    await runs.start(service.session, state, device_id="dev1")
    for _ in range(2):
        await runs.advance(service.session, state, reason=AdvanceReason.TRACK_ENDED)

    order_before = list(state.order)
    assert state.cursor == 2 and state.status is RunStatus.ACTIVE
    # Dieser Prozess weiß, dass er ein uris-Fenster gesetzt hat (ADR-002).
    assert run_id in runs._window_anchors
    windows_before = len(service.provider.play_windows)

    session = await _restart_process(service)

    assert run_id not in runs._window_anchors        # prozesslokal, also weg
    resumed = await runs.resume_run(session, run_id)
    assert isinstance(resumed, RunState)
    assert resumed.cursor == 2                       # exakt dieselbe Karte
    assert resumed.status is RunStatus.ACTIVE
    assert resumed.order == order_before             # Reihenfolge unangetastet
    assert resumed.current_track_id == order_before[2]
    # resume_run startet bewusst keine Wiedergabe — kein Kommando bisher.
    assert len(service.provider.play_windows) == windows_before

    # Der erste start der neuen Sitzung schickt ein frisches uris-Fenster.
    await runs.start(session, resumed, device_id="dev1")
    assert len(service.provider.play_windows) == windows_before + 1
    assert service.provider.play_windows[-1][0] == order_before[2]
    assert runs._window_anchors.get(run_id) == 2
    assert service.provider.queued == []             # ADR-002: nie die Queue

    guard = 0
    while resumed.status is RunStatus.ACTIVE:
        await runs.advance(session, resumed, reason=AdvanceReason.TRACK_ENDED)
        guard += 1
        assert guard < 50
    assert resumed.status is RunStatus.COMPLETED
    assert resumed.cursor == len(order_before)

    # F5: genau ein Auswahleintrag je Übergang, jede Karte genau einmal
    # gespielt — der Neustart hat nichts doppelt verbucht.
    assert await _one(
        "SELECT count(*) FROM run_selections WHERE run_id = ?", (run_id,)
    ) == len(order_before)
    assert await _one(
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND state = 'played'",
        (run_id,),
    ) == len(order_before)
    assert await _one(
        "SELECT count(*) FROM run_events WHERE run_id = ? AND applied = 0",
        (run_id,),
    ) == 0
    assert await _one(
        "SELECT max(play_count) FROM run_tracks WHERE run_id = ?", (run_id,)
    ) == 1                                           # keine Karte zweimal


async def test_restart_after_a_stopped_session_resumes_instead_of_restarting(
    database, service
):
    """F1/UC-30: ein bewusst beendeter Lauf (``stop``) überlebt den Neustart
    als ``stopped`` und wird von ``resume_run`` wieder ``active`` — an der
    gemerkten Karte, nicht am Anfang.

    Das ist die Tagesgrenze aus UC-30: abends Stopp, morgen neuer Prozess,
    Weiterhören.  ``resume_status`` (core/engine.py) entscheidet, die Datei
    hält den Cursor.
    """
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER, name="Übernacht")
    run_id = state.run_id
    await runs.start(service.session, state, device_id="dev1")
    for _ in range(3):
        await runs.advance(service.session, state, reason=AdvanceReason.TRACK_ENDED)
    await runs.stop_run(service.session, state)
    assert (await db.get_run(run_id))["status"] == RunStatus.STOPPED.value

    session = await _restart_process(service)

    stored = await db.get_run(run_id)
    assert stored["cursor"] == 3
    assert stored["status"] == RunStatus.STOPPED.value

    resumed = await runs.resume_run(session, run_id)
    assert resumed.status is RunStatus.ACTIVE and resumed.cursor == 3
    events = [e["type"] for e in await db.list_events(run_id)]
    assert "resumed" in events

    await runs.start(session, resumed, device_id="dev1")
    assert service.provider.play_windows[-1][0] == resumed.order[3]


# ---------------------------------------------------------------------------
# HTTP-Ebene — zwei nacheinander geöffnete TestClient-Kontexte
# ---------------------------------------------------------------------------

def _connect(client):
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


def test_restart_over_http_resumes_the_same_run_and_plays_it_to_the_end(
    fake_provider,
):
    """UC-30 über den Draht: anlegen/starten/zwei Advances, Server aus,
    Server an, weiterhören bis ``completed`` — mit lückenlosem Verlauf.

    Der zweite ``TestClient``-Kontext fährt die Lifespan neu hoch, öffnet also
    dieselbe Datenbankdatei in einer neuen Verbindung.  Die Browser-Cookie
    wird weitergereicht, weil sie den Neustart in Wirklichkeit auch überlebt.
    """
    with TestClient(app) as client:
        _connect(client)
        response = client.post("/api/runs", json={
            "provider": "fake", "playlist_id": "pl1", "mode": "controller",
        })
        run_id = _wait_for_job(client, response.json()["job_id"])["run_id"]
        started = client.post(f"/api/runs/{run_id}/start",
                              json={"device_id": "dev1"})
        assert started.status_code == 200, started.text
        for _ in range(2):
            advanced = client.post(f"/api/runs/{run_id}/advance",
                                   json={"reason": "track_ended"})
            assert advanced.status_code == 200, advanced.text

        before = client.get(f"/api/runs/{run_id}").json()
        assert before["cursor"] == 2 and before["status"] == "active"
        order_sample_before = before["order_sample"]
        current_before = before["current"]["id"]
        session_cookie = client.cookies.get("session")

    # --- SIMULIERTER Prozessneustart (Präzisierung nach Runde-2-Befund B6,
    # dokumentierte Teständerung 2026-08-01): der Lifespan-Zyklus erneuert
    # die DB-Verbindung, aber die prozesslokalen Register überleben ihn —
    # ein echter Neustart leert sie automatisch, hier tun wir es explizit
    # (Anker UND Locks) und pinnen die Ausgangslage, damit die
    # Fenster-Assertion unten wirklich am Neustartzustand hängt.
    assert session_cookie
    runs._window_anchors.clear()
    runs._advance_locks.clear()
    assert run_id not in runs._window_anchors
    windows_before = len(fake_provider.play_windows)

    with TestClient(app) as client:
        client.cookies.set("session", session_cookie)

        listed = client.get("/api/runs").json()["runs"]
        assert [r["id"] for r in listed] == [run_id]   # derselbe Nutzer, derselbe Lauf

        resumed = client.post(f"/api/runs/{run_id}/resume")
        assert resumed.status_code == 200, resumed.text
        assert resumed.json() == {"status": "active", "cursor": 2}

        after = client.get(f"/api/runs/{run_id}").json()
        assert after["cursor"] == before["cursor"]
        assert after["total"] == before["total"]
        assert after["status"] == "active"
        assert after["order_sample"] == order_sample_before
        assert after["current"]["id"] == current_before
        assert after["progress_pct"] == before["progress_pct"]

        started = client.post(f"/api/runs/{run_id}/start",
                              json={"device_id": "dev1"})
        assert started.status_code == 200, started.text
        # Frisches uris-Fenster ab der gemerkten Karte (ADR-002/ADR-004).
        assert len(fake_provider.play_windows) == windows_before + 1
        assert fake_provider.play_windows[-1][0] == current_before
        assert fake_provider.queued == []

        payload = client.get(f"/api/runs/{run_id}").json()
        guard = 0
        while payload["status"] == "active":
            advanced = client.post(f"/api/runs/{run_id}/advance",
                                   json={"reason": "track_ended"})
            assert advanced.status_code == 200, advanced.text
            payload = client.get(f"/api/runs/{run_id}").json()
            guard += 1
            assert guard < 50
        assert payload["status"] == "completed"
        assert payload["cursor"] == payload["total"]
        assert payload["progress_pct"] == 100.0

        # Der Verlauf ist lückenlos: ein Übergang je Karte, keine stale-Zeile,
        # die Cursor-Positionen 1…total genau einmal.
        events = client.get(f"/api/runs/{run_id}/events").json()["events"]
        assert all(e["reason"] != "stale" for e in events)
        moves = sorted(
            e["cursor"] for e in events if e["type"] in ("advanced", "completed")
        )
        assert moves == list(range(1, payload["total"] + 1))
        types = [e["type"] for e in events]
        assert types.count("started") == 2          # vor und nach dem Neustart
        assert types.count("completed") == 1
        assert "run_created" in types
