"""UC-22 — die Zahlen im Fortschritt: Wiederholungen, Ausgeschlossene, Aussortierte.

Die Evidence-Matrix führte ``repeat_count`` / ``excluded_count`` /
``skipped_count`` / ``progress_pct`` als „implementiert, aber ohne eigene
Test-Assertion" (nur ``VERIFIED_CODE``, 0 Testtreffer).  Diese Datei schließt
genau diese Lücke — sie ist der Abnehmer, nicht der Erzeuger.

Verbindlich entschieden ist die Zählsemantik im Docstring von
``app/db.py::deck_stats`` (2026-08-01):

* ``repeats`` zählt **Wiederhol-VORGÄNGE**, nicht wiederholte Karten — eine
  fünfmal gespielte Karte trägt 4 bei (``SUM(play_count - 1)`` über alle
  Karten mit ``play_count > 1``).  Mehrere Karten kumulieren.
* ``excluded`` zählt ``excluded_user`` **und** ``excluded_rule``, also den
  Nutzerausschluss (UC-20) und den Import-Ausschluss (UC-03/F3) zusammen.
* ``deck_size == 0`` (Deck nie materialisiert, Legacy-/Import-Run) liefert
  ``repeats``/``excluded`` als ``None`` — „unbekannt", nicht „0".  Über den
  Draht wird daraus ``null``, und die UI zeigt „—".

``progress_pct`` ist in ``core/models.py::RunState`` definiert als
``round(100 * min(cursor, total) / total, 1)`` und ``remaining`` als
``max(0, total - cursor)``; ``app/runs.py::describe`` reicht beide unverändert
durch.  Der Cursor zählt die **verbrauchten** Karten, nicht die gehörten
Sekunden: solange der erste Titel läuft, steht der Fortschritt ehrlich auf
0 % — erst der Advance verbucht ihn.

Wiederholungen werden hier ausschließlich über den ECHTEN Pfad erzeugt
(``create_run_v3`` → ``start`` → ``advance`` → F2-``reset_run``); SQL kommt nur
zum Nachrechnen zum Einsatz, nie zum Herstellen eines Zustands.

Fixtures sind bewusst lokal (Limit-Abbruch-Resilienz): diese Datei läuft für
sich allein, mit nichts als der Datenbank-Isolation aus ``tests/conftest.py``.
"""

from __future__ import annotations

import base64
import json
import sqlite3
import time
from dataclasses import dataclass

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from app import db, library_service, runs
from app.main import app
from core.models import AdvanceReason, PlaylistRef, RunMode, RunStatus, Track
from core.selection import Rules
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
    user_id = await db.get_or_create_user("local-progress")
    session = Session(
        user_id=user_id, provider=provider, token=TokenBundle(access_token="t")
    )
    playlist = (await provider.list_playlists(None))[0]  # "pl1", 12 Titel
    return Service(session=session, provider=provider, playlist=playlist,
                   user_id=user_id)


async def _one(conn, sql, params=()):
    cur = await conn.execute(sql, params)
    row = await cur.fetchone()
    return row[0] if row is not None else None


async def _play_counts(conn, run_id: int) -> list[int]:
    cur = await conn.execute(
        "SELECT play_count FROM run_tracks WHERE run_id = ? ORDER BY id",
        (run_id,),
    )
    return [int(r[0]) for r in await cur.fetchall()]


async def _run(service: Service, *, name: str, config_id=None):
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER,
        name=name, config_id=config_id,
    )
    return state


async def _play_out(service: Service, state) -> None:
    """Einen ganzen Zyklus über den echten Advance-Pfad hören."""
    await runs.start(service.session, state, device_id="dev1")
    guard = 0
    while state.status is RunStatus.ACTIVE:
        await runs.advance(service.session, state, reason=AdvanceReason.TRACK_ENDED)
        guard += 1
        assert guard < 200, "Zyklus endet nicht — Testaufbau kaputt"


async def _next_cycle(service: Service, state):
    """F2 (UC-15): nächster Zyklus über den echten Reset-Pfad."""
    await runs.reset_run(service.session, state)
    return await runs.get_state(state.run_id, service.user_id)


# ---------------------------------------------------------------------------
# UC-22 — db.deck_stats: Wiederhol-VORGÄNGE
# ---------------------------------------------------------------------------

async def test_deck_stats_repeats_counts_repeat_events_not_repeated_cards(
    database, service
):
    """Eine Karte fünfmal gehört ⇒ ``repeats == 4`` (nicht 1).

    Der Unterschied ist der ganze Punkt der 2026-08-01 getroffenen
    Entscheidung: „wie oft insgesamt wiederholt wurde", nicht „wie viele Titel
    wiederholt wurden".  Eine Ein-Karten-Playlist macht die beiden Lesarten
    maximal unterscheidbar — die Kartenzählung sagte hier 1, die
    Vorgangszählung 4.  Erzeugt wird das über fünf echte Zyklen
    (start → advance(track_ended) → F2-Reset), nie per UPDATE.
    """
    service.provider.tracks = service.provider.tracks[:1]
    config_id = await db.create_config(
        service.user_id, "Wiederholen erlaubt",
        Rules(repeat_mode="free_repeat", min_gap=0, repeat_quota_pct=100),
    )
    state = await _run(service, name="fünfmal", config_id=config_id)
    assert state.order == ["t0"]

    for cycle in range(5):
        await _play_out(service, state)
        if cycle < 4:
            state = await _next_cycle(service, state)

    assert await _play_counts(database, state.run_id) == [5]
    stats = await db.deck_stats(state.run_id)
    assert stats == {"deck_size": 1, "repeats": 4, "excluded": 0}
    # Die verworfene Lesart, explizit: „wiederholte Karten" wäre 1.
    assert await _one(
        database,
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND play_count > 1",
        (state.run_id,),
    ) == 1


async def test_deck_stats_repeats_accumulate_over_several_cards(
    database, service
):
    """Mehrere Karten kumulieren: 3 Karten × je 3 Wiedergaben ⇒ ``repeats == 6``.

    Drei Zyklen ohne Wiederholung (Standard-Preset) spielen jede Karte genau
    einmal je Zyklus; ``play_count`` ist zyklenübergreifend kumulativ
    (ADR-003 F2), also 3 pro Karte.  6 = 3 × (3 - 1) — die Kartenzählung
    stünde bei 3.
    """
    service.provider.tracks = service.provider.tracks[:3]
    state = await _run(service, name="drei Karten")

    for cycle in range(3):
        await _play_out(service, state)
        if cycle < 2:
            state = await _next_cycle(service, state)

    assert await _play_counts(database, state.run_id) == [3, 3, 3]
    stats = await db.deck_stats(state.run_id)
    assert stats["deck_size"] == 3
    assert stats["repeats"] == 6
    assert await _one(
        database,
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND play_count > 1",
        (state.run_id,),
    ) == 3                                       # ≠ 6: die verworfene Lesart


async def test_deck_stats_repeats_match_the_sql_definition_over_the_real_path(
    database, service
):
    """Zwei volle free_repeat-Zyklen über den echten Advance-Pfad.

    Die Zusammensetzung der Züge hängt am Zufalls-Seed des Laufs, die
    Identität nicht: ``repeats`` ist per Definition
    ``SUM(play_count - 1) über play_count > 1``.  Der Aufbau garantiert
    außerdem einen echten Untergrund — 24 Wiedergaben auf höchstens 12 Karten
    heißt nach Schubfachprinzip mindestens 12 Wiederhol-Vorgänge.
    """
    config_id = await db.create_config(
        service.user_id, "Frei wiederholen",
        Rules(repeat_mode="free_repeat", min_gap=0, repeat_quota_pct=100),
    )
    state = await _run(service, name="zwei Zyklen", config_id=config_id)
    assert len(state.order) == 12

    await _play_out(service, state)
    state = await _next_cycle(service, state)
    await _play_out(service, state)

    counts = await _play_counts(database, state.run_id)
    assert sum(counts) == 24                     # 2 × 12 verbuchte Wiedergaben
    expected = sum(c - 1 for c in counts if c > 1)
    stats = await db.deck_stats(state.run_id)
    assert stats["deck_size"] == 12
    assert stats["repeats"] == expected
    assert stats["repeats"] >= 12                # Schubfach, seed-unabhängig
    assert stats["excluded"] == 0


async def test_deck_stats_excluded_counts_import_and_user_exclusions(
    database, service
):
    """``excluded`` = ``excluded_user`` + ``excluded_rule`` (UC-20 und UC-03).

    Ein nicht spielbarer Eintrag wird beim Anlegen als ``excluded_rule``
    verbucht (und steht zusätzlich in ``skipped_tracks``); ein
    Nutzerausschluss macht daraus zwei.  Beide Zustände fließen in dieselbe
    Kachel — die UI unterscheidet sie nicht, ``deck_stats`` also auch nicht.
    """
    service.provider.tracks.append(Track(
        provider="fake", id="tdead", name="Nicht verfügbar", artist="A",
        duration_ms=1000, is_playable=False,
    ))
    await library_service.import_playlist(service.session, service.playlist)
    state = await _run(service, name="ausgeschlossen")

    assert len(state.order) == 12                # tdead ist nicht im Plan
    stats = await db.deck_stats(state.run_id)
    assert stats["deck_size"] == 13              # die Karte existiert, gesperrt
    assert stats["excluded"] == 1
    assert (await db.find_run_track(
        state.run_id, provider_track_id="tdead"))["state"] == "excluded_rule"

    card = await db.find_run_track(
        state.run_id, provider_track_id=state.order[3])
    await runs.set_track_exclusion(state, int(card["id"]), True)

    assert (await db.deck_stats(state.run_id))["excluded"] == 2
    assert await _one(
        database,
        "SELECT count(*) FROM run_tracks WHERE run_id = ? "
        "AND state IN ('excluded_user', 'excluded_rule')",
        (state.run_id,),
    ) == 2


async def test_deck_stats_without_a_materialised_deck_reports_unknown_not_zero(
    database, service
):
    """``deck_size == 0`` ⇒ ``repeats``/``excluded`` sind ``None``, nicht 0.

    Legacy-/Import-Runs (WP3-D2) haben keine ``run_tracks``-Zeilen.  „Null
    Wiederholungen" wäre dort eine Behauptung, die niemand belegen kann — der
    Docstring von ``deck_stats`` verlangt darum ausdrücklich ``None``, damit
    die Kachel „—" zeigt statt einer erfundenen 0.
    """
    run_id = await db.create_run(
        user_id=service.user_id, provider="fake", playlist_id="pl1",
        playlist_name="Everything", mode="controller",
        order=["t0", "t1", "t2"], status="active",
    )
    assert await _one(
        database, "SELECT count(*) FROM run_tracks WHERE run_id = ?", (run_id,)
    ) == 0

    stats = await db.deck_stats(run_id)
    assert stats == {"deck_size": 0, "repeats": None, "excluded": None}
    # Ausdrücklich None und nicht 0 — die beiden bedeuten Verschiedenes.
    assert stats["repeats"] is None and stats["excluded"] is None


# ---------------------------------------------------------------------------
# UC-22 — die dokumentierte No-Repeat-Ausnahme (RUN-03, Matrix-Notiz 12)
# ---------------------------------------------------------------------------

async def test_requeue_later_endgame_completes_at_100_percent_with_an_unplayed_card(
    database, service
):
    """Ein ``requeue_later``-Skip nahe Zyklusende ⇒ ``completed`` / 100 %,
    obwohl eine berücksichtigte Karte nie gespielt wurde.

    Bewusstes, dokumentiertes Verhalten (Matrix RUN-03/UC-06/19/24): liegt der
    Skip innerhalb von ``REQUEUE_AFTER_DRAWS`` vor dem Planende, wird die
    Karte NICHT ans Plan-Ende gehängt — sie bleibt ``deferred`` mit
    ``play_count 0`` und kommt erst im Folgezyklus zurück.  Dieser Test hält
    fest, dass der Sonderfall die Fortschrittslogik nicht zerreißt: Status,
    Cursor, ``remaining`` und ``progress_pct`` bleiben in sich stimmig, und
    ``deck_stats`` erfindet keine Wiederholung.  Er ist die Warnlampe, falls
    jemand die Abschluss-Definition ändert, ohne UC-22 mitzudenken.
    """
    config_id = await db.create_config(
        service.user_id, "Später nochmal", Rules(skip_policy="requeue_later"))
    state = await _run(service, name="endspiel", config_id=config_id)
    total = state.total
    assert total == 12

    await runs.start(service.session, state, device_id="dev1")
    for _ in range(8):
        await runs.advance(service.session, state, reason=AdvanceReason.TRACK_ENDED)
    assert state.cursor == 8

    # Der Skip liegt 4 Züge vor dem Planende — näher als REQUEUE_AFTER_DRAWS
    # (10), also unterbleibt der Plan-Anhang.
    skipped_track = state.order[8]
    await runs.advance(service.session, state, reason=AdvanceReason.USER_SKIP)
    assert state.total == total                  # keine Plan-Verlängerung

    guard = 0
    while state.status is RunStatus.ACTIVE:
        await runs.advance(service.session, state, reason=AdvanceReason.TRACK_ENDED)
        guard += 1
        assert guard < 50

    assert state.status is RunStatus.COMPLETED
    card = await db.find_run_track(
        state.run_id, provider_track_id=skipped_track)
    assert card["state"] == "deferred" and card["play_count"] == 0
    assert await _one(
        database,
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND state = 'played'",
        (state.run_id,),
    ) == 11                                      # 11 von 12, und trotzdem fertig

    payload = await runs.describe(service.session, state)
    assert payload["status"] == "completed"
    assert payload["cursor"] == total and payload["total"] == total
    assert payload["remaining"] == 0
    assert payload["progress_pct"] == 100.0
    # Ein nie gespielter Titel ist keine Wiederholung — die Kachel bleibt ehrlich.
    assert (await db.deck_stats(state.run_id))["repeats"] == 0


# ---------------------------------------------------------------------------
# UC-22 über den Draht — GET /api/runs/{id}
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


def _sql(sql: str, params=()) -> list[dict]:
    """Nachrechnen gegen dieselbe Datei, die der Server gerade offen hat.

    Der Server läuft im TestClient-Thread; eine zweite, lesende
    SQLite-Verbindung ist der ehrlichste Weg, seine Antwort mit dem
    tatsächlichen Datenbankinhalt zu vergleichen (WAL, nur SELECT).
    """
    from app.config import get_settings

    conn = sqlite3.connect(str(get_settings().db_abs_path))
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def _deck_stats_by_sql(run_id: int) -> dict:
    return _sql(
        "SELECT count(*) AS deck_size, "
        "SUM(CASE WHEN play_count > 1 THEN play_count - 1 ELSE 0 END) AS repeats, "
        "SUM(CASE WHEN state IN ('excluded_user','excluded_rule') THEN 1 ELSE 0 END) "
        "AS excluded FROM run_tracks WHERE run_id = ?",
        (run_id,),
    )[0]


def test_run_state_endpoint_mirrors_deck_stats_and_the_skipped_list(fake_provider):
    """GET /api/runs/{id}: ``excluded_count``/``repeat_count`` spiegeln
    ``deck_stats``, ``skipped_count`` zählt genau die Einträge, die
    ``/api/runs/{id}/skipped`` ausliefert, ``progress_pct`` folgt dem Cursor.

    Der Lauf entsteht aus einem Import mit einem nicht spielbaren Eintrag —
    so trägt die Antwort in einem Zug einen Import-Ausschluss, einen
    Aussortierten und (nach dem Klick) einen Nutzerausschluss.
    """
    fake_provider.tracks.append(Track(
        provider="fake", id="tdead", name="Nicht verfügbar", artist="A",
        duration_ms=1000, is_playable=False,
    ))
    with TestClient(app) as client:
        _connect(client)
        job = client.post("/api/playlists/fake/pl1/import").json()["job_id"]
        _wait_for_job(client, job)
        response = client.post("/api/runs", json={
            "provider": "fake", "playlist_id": "pl1", "mode": "controller",
        })
        run_id = _wait_for_job(client, response.json()["job_id"])["run_id"]

        payload = client.get(f"/api/runs/{run_id}").json()
        skipped = client.get(f"/api/runs/{run_id}/skipped").json()["skipped"]
        assert payload["skipped_count"] == len(skipped) == 1
        assert skipped[0]["track_id"] == "tdead"
        assert payload["excluded_count"] == 1        # der Import-Ausschluss
        assert payload["repeat_count"] == 0          # materialisiert: echte 0
        assert payload["total"] == 12
        assert payload["cursor"] == 0
        assert payload["progress_pct"] == 0.0        # noch nichts verbraucht
        assert payload["remaining"] == 12

        # Nutzerausschluss (UC-20) — dieselbe Kachel, ein Zähler mehr.
        target = payload["upcoming"][0]
        excluded = client.post(
            f"/api/runs/{run_id}/tracks/{target['run_track_id']}/exclude")
        assert excluded.status_code == 200, excluded.text

        client.post(f"/api/runs/{run_id}/start", json={"device_id": "dev1"})
        for _ in range(3):
            advanced = client.post(f"/api/runs/{run_id}/advance",
                                   json={"reason": "track_ended"})
            assert advanced.status_code == 200, advanced.text

        payload = client.get(f"/api/runs/{run_id}").json()
        truth = _deck_stats_by_sql(run_id)
        assert payload["excluded_count"] == truth["excluded"] == 2
        assert payload["repeat_count"] == truth["repeats"]
        assert payload["skipped_count"] == len(
            client.get(f"/api/runs/{run_id}/skipped").json()["skipped"])

        # progress_pct/remaining sind reine Funktionen von cursor und total
        # (core/models.py::RunState) — der Cursor zählt VERBRAUCHTE Karten.
        cursor, total = payload["cursor"], payload["total"]
        assert cursor == 3
        assert payload["remaining"] == total - cursor
        assert payload["progress_pct"] == round(100.0 * cursor / total, 1)


def test_repeat_count_over_the_wire_grows_with_the_real_repeats(fake_provider):
    """``repeat_count`` ist keine Konstante: ein zweiter Zyklus über den Draht
    (POST …/reset) lässt ihn genau um die verbuchten Wiederhol-Vorgänge
    steigen — nachgerechnet gegen die Datenbank, nicht gegen eine Erwartung.
    """
    with TestClient(app) as client:
        _connect(client)
        config = client.post("/api/configs", json={
            "name": "Frei wiederholen",
            "rules": {"repeat_mode": "free_repeat", "min_gap": 0,
                      "repeat_quota_pct": 100},
        })
        assert config.status_code == 201, config.text
        response = client.post("/api/runs", json={
            "provider": "fake", "playlist_id": "pl1", "mode": "controller",
            "config_id": config.json()["id"],
        })
        run_id = _wait_for_job(client, response.json()["job_id"])["run_id"]

        def _play_out() -> dict:
            client.post(f"/api/runs/{run_id}/start", json={"device_id": "dev1"})
            payload = client.get(f"/api/runs/{run_id}").json()
            guard = 0
            while payload["status"] == "active":
                client.post(f"/api/runs/{run_id}/advance",
                            json={"reason": "track_ended"})
                payload = client.get(f"/api/runs/{run_id}").json()
                guard += 1
                assert guard < 50
            return payload

        first = _play_out()
        assert first["status"] == "completed"
        assert first["progress_pct"] == 100.0
        assert first["repeat_count"] == _deck_stats_by_sql(run_id)["repeats"]

        reset = client.post(f"/api/runs/{run_id}/reset", json={"confirm": True})
        assert reset.status_code == 200, reset.text
        assert reset.json()["cycle"] == 2
        second = _play_out()

        truth = _deck_stats_by_sql(run_id)
        assert second["repeat_count"] == truth["repeats"]
        # 24 Wiedergaben auf 12 Karten — Schubfach, seed-unabhängig.
        assert second["repeat_count"] >= 12
        assert second["repeat_count"] > first["repeat_count"]
        assert second["excluded_count"] == 0
        assert second["skipped_count"] == 0


async def test_repeats_count_across_cycle_boundaries_by_design(
    database, service,
):
    """B5-Pin (Runde 2, dokumentierte Ergänzung 2026-08-01): ``repeats``
    zählt über Zyklusgrenzen — ein zweiter voller no_repeat-Durchlauf nach
    F2-Reset meldet deck_size Wiederhol-Vorgänge, obwohl innerhalb jedes
    Zyklus nie wiederholt wurde.  Entschieden und begründet im
    ``db.deck_stats``-Docstring; wer Zyklus-lokale Zahlen will, liest den
    Fortschritt."""
    state = await _run(service, name="cycles")
    await runs.start(service.session, state, device_id="dev1")
    for _ in range(len(state.order)):
        await runs.advance(service.session, state,
                           reason=AdvanceReason.TRACK_ENDED)
    assert (await db.deck_stats(state.run_id))["repeats"] == 0

    await runs.reset_run(service.session, state)
    await runs.start(service.session, state, device_id="dev1")
    for _ in range(len(state.order)):
        await runs.advance(service.session, state,
                           reason=AdvanceReason.TRACK_ENDED)

    stats = await db.deck_stats(state.run_id)
    assert stats["repeats"] == stats["deck_size"] == 12
