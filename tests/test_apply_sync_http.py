"""RUN-09 / UC-25 — POST /api/runs/{id}/apply-sync über den Draht.

Die Evidence-Matrix hielt für RUN-09 und UC-25 fest: „der HTTP-Endpunkt
``POST /api/runs/{run_id}/apply-sync`` selbst ist ungetestet — alle Zitate
laufen über ``library_service.apply_sync_to_run`` direkt".  Genau das holt
diese Datei nach: der vollständige Draht-Roundtrip, den ein Nutzer auslöst,
wenn sich seine Playlist beim Anbieter geändert hat.

Der Weg, einmal ganz:

1. ``POST /api/playlists/fake/pl1/import`` + Job-Polling (Erstimport),
2. ``POST /api/runs`` — ein Lauf auf diesem Stand,
3. die Playlist ändert sich beim Anbieter (Titel weg, Titel dazu),
4. ``POST /api/playlists/fake/pl1/sync`` + Job-Polling → ``diff_id``,
5. ``POST /api/runs/{id}/apply-sync`` mit ``policy`` → 200.

Mitgeprüft werden die Fehlerpfade so, wie der Server sie WIRKLICH beantwortet
(nicht wie man sie sich wünscht): unbekannte Policy und fehlende/nicht
numerische ``diff_id`` sind 400 (``HTTPException`` in der Route), ein Abgleich,
den es für diesen Lauf nicht gibt, ist 409 (``RunError`` → Handler in
``app/main.py``).

Neu im Antwortkörper ist ``window`` (ADR-004): ob das auf dem Player gesetzte
``uris``-Fenster nach dem Replan sofort nachgezogen wurde.  Ohne laufende
Wiedergabe wird nichts gesendet — die Antwort ist dann ehrlich ``not_driving``
bzw. ``unchanged``; der ``reasserted``-Fall wird eigens hergestellt.

Fixtures/Helfer sind bewusst lokal (Limit-Abbruch-Resilienz): diese Datei
läuft für sich allein, mit nichts als der Datenbank-Isolation aus
``tests/conftest.py``.
"""

from __future__ import annotations

import base64
import json
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app
from core.models import PlaybackState, Track

#: Die vollständige Ergebnismenge von ``runs.reassert_window`` (ADR-004).
WINDOW_OUTCOMES = {"reasserted", "unchanged", "not_driving", "failed"}

#: Was ohne laufende Wiedergabe herauskommen darf — gesendet wird nichts.
QUIET_OUTCOMES = {"not_driving", "unchanged"}


# ---------------------------------------------------------------------------
# Lokale Helfer (Muster aus tests/test_policies.py / tests/test_window_reassert.py)
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
    """Nachrechnen gegen dieselbe Datei, die der Server offen hat (nur SELECT).

    ``run_tracks.admitted``/``added_in_cycle`` stehen in keiner API-Antwort;
    für die Parkplatz-Prüfung von ``after_cycle`` ist das der ehrlichste Blick.
    """
    from app.config import get_settings

    conn = sqlite3.connect(str(get_settings().db_abs_path))
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def _import(client) -> None:
    job = client.post("/api/playlists/fake/pl1/import").json()["job_id"]
    _wait_for_job(client, job)


def _deal(client) -> int:
    response = client.post("/api/runs", json={
        "provider": "fake", "playlist_id": "pl1", "mode": "controller",
    })
    assert response.status_code == 202, response.text
    return _wait_for_job(client, response.json()["job_id"])["run_id"]


def _sync(client) -> dict:
    """Zweiter Import + Diff über den Draht — liefert den Diff-Block."""
    job = client.post("/api/playlists/fake/pl1/sync").json()["job_id"]
    result = _wait_for_job(client, job)
    assert result["diff"] is not None, "Sync ohne Vergleichsstand"
    return result["diff"]


def _card(run_id: int, track_id: str) -> list[dict]:
    return _sql(
        "SELECT rt.state, rt.admitted, rt.added_in_cycle, rt.play_count, "
        "rt.removed_from_snapshot FROM run_tracks rt "
        "JOIN tracks t ON t.id = rt.track_id "
        "WHERE rt.run_id = ? AND t.provider_track_id = ?",
        (run_id, track_id),
    )


# ---------------------------------------------------------------------------
# RUN-09 — der Happy Path: include_now
# ---------------------------------------------------------------------------

def test_apply_sync_include_now_adds_and_removes_over_the_wire(fake_provider):
    """Import → Lauf → Playlist ändert sich → Sync → apply-sync = 200.

    ``added``/``removed`` stehen im Ergebnis, der neue Titel taucht in der
    Reihenfolge des Laufs auf, der entfernte verschwindet aus dem Rest —
    seine Karte bleibt aber bestehen (UC-04: Verlauf wird nie gelöscht).
    """
    with TestClient(app) as client:
        _connect(client)
        _import(client)
        run_id = _deal(client)

        before = client.get(f"/api/runs/{run_id}").json()
        assert before["total"] == 12
        # Das Opfer kommt aus dem NOCH ZU HÖRENDEN Teil — die laufende Karte
        # wird von einem Replan grundsätzlich nicht angetastet.
        victim = before["upcoming"][0]["id"]
        fake_provider.tracks = [t for t in fake_provider.tracks if t.id != victim]
        fake_provider.tracks.append(Track(
            provider="fake", id="t99", name="Neu dabei", artist="A",
            duration_ms=1000))

        diff = _sync(client)
        assert [e["track_id"] for e in diff["added"]] == ["t99"]
        assert [e["track_id"] for e in diff["removed"]] == [victim]

        applied = client.post(f"/api/runs/{run_id}/apply-sync", json={
            "diff_id": diff["diff_id"], "policy": "include_now",
        })
        assert applied.status_code == 200, applied.text
        body = applied.json()
        assert body["added"] == 1
        assert body["removed"] == 1
        assert body["policy"] == "include_now"
        assert body["replanned"] > 0
        assert body["snapshot_id"] == diff["to_snapshot_id"]

        after = client.get(f"/api/runs/{run_id}").json()
        order = after["order_sample"]            # ≤ 96 Karten: die volle Order
        assert "t99" in order                    # JETZT eingemischt
        assert victim not in order               # aus dem Rest verschwunden
        assert after["total"] == before["total"]

        # Die Karte des entfernten Titels lebt weiter, nur markiert (UC-04).
        assert _card(run_id, victim)[0]["removed_from_snapshot"] == 1
        new_card = _card(run_id, "t99")[0]
        assert new_card["admitted"] == 1 and new_card["added_in_cycle"] == 1


def test_apply_sync_after_cycle_parks_the_card_and_leaves_the_order_alone(
    fake_provider,
):
    """UC-25 ``after_cycle``: der neue Titel wartet auf den nächsten Zyklus.

    Über den Draht heißt das: 200, ``added: 1``, ``replanned: 0`` — die
    Reihenfolge dieses Zyklus bleibt Zeichen für Zeichen dieselbe, und weil
    sich am hörbaren Fenster nichts ändert, geht auch kein Kommando raus.
    Dass die Karte wirklich geparkt ist (``admitted=0``, nächster Zyklus),
    steht in keiner Antwort — das prüft der Test in der Datenbank.
    """
    with TestClient(app) as client:
        _connect(client)
        _import(client)
        run_id = _deal(client)
        before = client.get(f"/api/runs/{run_id}").json()

        fake_provider.tracks.append(Track(
            provider="fake", id="t77", name="Später", artist="A",
            duration_ms=1000))
        diff = _sync(client)

        applied = client.post(f"/api/runs/{run_id}/apply-sync", json={
            "diff_id": diff["diff_id"], "policy": "after_cycle",
        })
        assert applied.status_code == 200, applied.text
        body = applied.json()
        assert body["added"] == 1
        assert body["removed"] == 0
        assert body["policy"] == "after_cycle"
        assert body["replanned"] == 0
        assert body["window"] in QUIET_OUTCOMES

        after = client.get(f"/api/runs/{run_id}").json()
        assert after["order_sample"] == before["order_sample"]
        assert after["total"] == before["total"]
        assert "t77" not in after["order_sample"]

        parked = _card(run_id, "t77")[0]
        assert parked["state"] == "open"
        assert parked["admitted"] == 0           # nicht in DIESEM Zyklus
        assert parked["added_in_cycle"] == 2     # der F2-Reset lässt sie rein


# ---------------------------------------------------------------------------
# RUN-09 — Validierung: was der Server wirklich antwortet
# ---------------------------------------------------------------------------

def test_apply_sync_rejects_a_nonsense_policy_and_a_bad_diff_id(fake_provider):
    """400 für Unsinn im Körper, 409 für einen Abgleich, den es nicht gibt.

    Die Route prüft ``diff_id`` und ``policy`` selbst (``HTTPException`` →
    400).  Ein unbekannter Abgleich fällt dagegen erst im Service auf und
    kommt als ``RunError`` heraus — der Handler in ``app/main.py`` macht
    daraus 409, nicht 404.  Der Test hält den TATSÄCHLICHEN Code fest.
    """
    with TestClient(app) as client:
        _connect(client)
        _import(client)
        run_id = _deal(client)

        fake_provider.tracks.append(Track(
            provider="fake", id="t55", name="Egal", artist="A", duration_ms=1000))
        diff = _sync(client)

        bad_policy = client.post(f"/api/runs/{run_id}/apply-sync", json={
            "diff_id": diff["diff_id"], "policy": "quatsch"})
        assert bad_policy.status_code == 400
        assert "include_now" in bad_policy.json()["detail"]

        assert client.post(
            f"/api/runs/{run_id}/apply-sync", json={}).status_code == 400
        assert client.post(f"/api/runs/{run_id}/apply-sync", json={
            "diff_id": None}).status_code == 400
        assert client.post(f"/api/runs/{run_id}/apply-sync", json={
            "diff_id": "abc"}).status_code == 400

        unknown = client.post(f"/api/runs/{run_id}/apply-sync", json={
            "diff_id": diff["diff_id"] + 9999})
        assert unknown.status_code == 409, unknown.text
        assert unknown.json()["detail"] == "Diesen Abgleich gibt es nicht."

        # Nichts davon hat den Lauf angefasst: der Abgleich ist unangewendet.
        assert _sql(
            "SELECT applied_at FROM snapshot_diffs WHERE id = ?",
            (diff["diff_id"],),
        )[0]["applied_at"] is None
        assert _card(run_id, "t55") == []

        # Ein fremder Lauf ist eine 404 (Eigentum ist Teil der Abfrage).
        assert client.post(
            f"/api/runs/{run_id + 999}/apply-sync",
            json={"diff_id": diff["diff_id"]},
        ).status_code == 404


def test_apply_sync_is_idempotent_over_the_wire(fake_provider):
    """Zweimal derselbe Abgleich: die zweite Antwort meldet das Erst-Ergebnis.

    Der Wiederholungsschutz ist ein ``run_events``-Eintrag unter
    ``sync:{diff_id}``; über den Draht sieht man ihn an ``already_applied``
    und daran, dass ``replanned`` auf 0 fällt.  Doppelte Karten entstehen
    keine — das ist die eigentliche Zusicherung.
    """
    with TestClient(app) as client:
        _connect(client)
        _import(client)
        run_id = _deal(client)

        fake_provider.tracks.append(Track(
            provider="fake", id="t42", name="Einmal", artist="A",
            duration_ms=1000))
        diff = _sync(client)
        payload = {"diff_id": diff["diff_id"], "policy": "include_now"}

        first = client.post(f"/api/runs/{run_id}/apply-sync", json=payload)
        second = client.post(f"/api/runs/{run_id}/apply-sync", json=payload)
        assert first.status_code == second.status_code == 200, second.text
        assert first.json()["added"] == 1
        assert second.json()["already_applied"] is True
        assert second.json()["added"] == first.json()["added"]
        assert second.json()["removed"] == first.json()["removed"]
        assert second.json()["replanned"] == 0
        assert second.json()["window"] in WINDOW_OUTCOMES

        assert len(_card(run_id, "t42")) == 1     # genau EINE Karte
        tracks = client.get(f"/api/runs/{run_id}/tracks").json()["tracks"]
        assert [t["id"] for t in tracks].count("t42") == 1
        assert len(_sql(
            "SELECT id FROM run_events WHERE run_id = ? AND event_key = ?",
            (run_id, f"sync:{diff['diff_id']}"),
        )) == 1


# ---------------------------------------------------------------------------
# ADR-004 — das neue Antwortfeld ``window``
# ---------------------------------------------------------------------------

def test_apply_sync_reports_an_honest_window_outcome_when_nothing_plays(
    fake_provider,
):
    """Ohne laufende Wiedergabe darf kein Kommando rausgehen.

    ``window`` ist immer eines der vier ADR-004-Ergebnisse; ohne Player, der
    nachweislich unseren aktuellen Titel spielt, bleibt nur ``not_driving``
    (Plan geändert, aber niemand hört) oder ``unchanged`` (Plan gleich
    geblieben).  Der Test behauptet die Menge, nicht einen Einzelwert — welcher
    der beiden Fälle eintritt, hängt an der Policy, nicht am Zufall.
    """
    with TestClient(app) as client:
        _connect(client)
        _import(client)
        run_id = _deal(client)
        windows_before = len(fake_provider.play_windows)

        fake_provider.tracks.append(Track(
            provider="fake", id="t33", name="Still", artist="A",
            duration_ms=1000))
        diff = _sync(client)

        applied = client.post(f"/api/runs/{run_id}/apply-sync", json={
            "diff_id": diff["diff_id"], "policy": "include_now"})
        assert applied.status_code == 200, applied.text
        assert applied.json()["window"] in WINDOW_OUTCOMES
        assert applied.json()["window"] in QUIET_OUTCOMES
        assert len(fake_provider.play_windows) == windows_before
        assert fake_provider.queued == []        # ADR-002: nie die Nutzer-Queue


def test_apply_sync_reasserts_the_window_while_the_run_is_actually_playing(
    fake_provider,
):
    """Läuft die Wiedergabe wirklich, wird das frische Fenster sofort gesetzt.

    Der Player spielt nachweislich unseren aktuellen Titel (mitten im Stück).
    ``include_now`` ändert die kommenden Titel — dann ist ``window`` gleich
    ``reasserted``, es geht GENAU EIN zusätzliches play-Kommando raus, es
    beginnt mit demselben Titel und behält die Hörposition (ADR-004: nahtlos,
    kein Titel-Neustart).
    """
    with TestClient(app) as client:
        _connect(client)
        _import(client)
        run_id = _deal(client)
        started = client.post(f"/api/runs/{run_id}/start",
                              json={"device_id": "dev1"})
        assert started.status_code == 200, started.text

        payload = client.get(f"/api/runs/{run_id}").json()
        current = payload["current"]["id"]
        victim = payload["upcoming"][0]["id"]
        fake_provider.state = PlaybackState(
            is_playing=True, track_id=current, progress_ms=42_000,
            duration_ms=180_000, device_id="dev1",
        )

        fake_provider.tracks = [t for t in fake_provider.tracks if t.id != victim]
        fake_provider.tracks.append(Track(
            provider="fake", id="t99", name="Neu dabei", artist="A",
            duration_ms=1000))
        diff = _sync(client)
        windows_before = len(fake_provider.play_windows)

        applied = client.post(f"/api/runs/{run_id}/apply-sync", json={
            "diff_id": diff["diff_id"], "policy": "include_now"})
        assert applied.status_code == 200, applied.text
        assert applied.json()["window"] == "reasserted"

        assert len(fake_provider.play_windows) == windows_before + 1
        fresh = fake_provider.play_windows[-1]
        assert fresh[0] == current               # derselbe Titel, nahtlos
        assert victim not in fresh               # der entfernte ist raus
        assert fake_provider.play_positions[-1] == 42_000
        assert fake_provider.queued == []

        events = [e["type"] for e in
                  client.get(f"/api/runs/{run_id}/events").json()["events"]]
        assert "window_reasserted" in events
