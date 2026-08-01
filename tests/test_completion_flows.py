"""A6 (TS-FABLE-01 §A) — UC-24: Abschluss erkennen UND danach weiterkommen.

Kanonisch (03A §24) kann der Nutzer nach einem Abschluss: beenden, einen
neuen Durchlauf starten, zurücksetzen, Wiederholungen erlauben, mit anderer
Konfiguration weitermachen.  Die Evidence-Matrix belegte: „Wiederholungen
erlauben und direkt weiterhören" wurde aktiv verweigert — ``POST …/rules``
antwortete auf einem abgeschlossenen Lauf mit ``200``/``replanned: 0``
(wirkungslos, als Erfolg getarnt) und ``POST …/start`` mit 409.

Vertrag nach dem Fix:

* Eine Regeländerung, die auf einem ABGESCHLOSSENEN Lauf wieder spielbare
  Titel eröffnet (Wiederholungen erlaubt), öffnet den Lauf ehrlich wieder:
  Status ``stopped`` (F1-Semantik: fortsetzbar, spielt nicht), Antwort
  ``reopened: true``, Ledger-Event ``reopened``.  Fortsetzen + Start spielen
  dann die neuen Titel.
* Eine Regeländerung, die nichts eröffnet (weiter ``no_repeat``), bleibt
  ehrlich: ``reopened: false`` + ``status: completed`` in der Antwort — kein
  stiller Schein-Erfolg.
* „Neuer Durchlauf" (Reset, F2) nach Abschluss startet Zyklus 2 ohne
  Playing-Slot-409 — auch wenn der abgeschlossene Lauf der letzte Spieler
  war.

``test_allowing_repeats_after_completion_reopens_the_run`` war VOR dem Fix
rot (replanned 0, kein reopened-Feld, Start 409) — Beleg im Commit.
"""

from __future__ import annotations

import base64
import json
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app

# pytest-asyncio auto mode (pyproject.toml) marks async tests automatically.


def _connect(client, provider_id: str = "fake") -> None:
    from itsdangerous import TimestampSigner

    from app.config import get_settings

    client.get(f"/auth/{provider_id}/login", follow_redirects=False)
    cookie = client.cookies.get("session")
    signer = TimestampSigner(get_settings().secret_key)
    data = signer.unsign(cookie, max_age=3600)
    state = json.loads(base64.urlsafe_b64decode(data))["oauth_state"]
    client.get(
        f"/auth/{provider_id}/callback",
        params={"code": "test-code", "state": state},
        follow_redirects=False,
    )


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


def _completed_run(client, fake_provider) -> int:
    """Deal, start and play a 12-track deck to its honest completion."""
    response = client.post("/api/runs", json={
        "provider": "fake", "playlist_id": "pl1", "mode": "controller",
    })
    run_id = _wait_for_job(client, response.json()["job_id"])["run_id"]
    assert client.post(f"/api/runs/{run_id}/start",
                       json={"device_id": "dev1"}).status_code == 200
    for _ in range(len(fake_provider.tracks)):
        advanced = client.post(f"/api/runs/{run_id}/advance",
                               json={"reason": "track_ended"})
        assert advanced.status_code == 200, advanced.text
    payload = client.get(f"/api/runs/{run_id}").json()
    assert payload["status"] == "completed"
    return run_id


def test_allowing_repeats_after_completion_reopens_the_run(fake_provider):
    """UC-24 „Wiederholungen erlauben und weiterhören" — the canonical flow."""
    with TestClient(app) as client:
        _connect(client)
        run_id = _completed_run(client, fake_provider)

        changed = client.post(f"/api/runs/{run_id}/rules", json={
            "rules": {"repeat_mode": "free_repeat", "min_gap": 2,
                      "repeat_quota_pct": 100},
        })
        assert changed.status_code == 200, changed.text
        body = changed.json()
        assert body["reopened"] is True
        assert body["status"] == "stopped"
        assert body["replanned"] > 0

        events = [e["type"] for e in
                  client.get(f"/api/runs/{run_id}/events").json()["events"]]
        assert "reopened" in events

        # F1: stopped → resume → start actually plays the new titles.
        windows_before = len(fake_provider.play_windows)
        assert client.post(f"/api/runs/{run_id}/resume").status_code == 200
        started = client.post(f"/api/runs/{run_id}/start",
                              json={"device_id": "dev1"})
        assert started.status_code == 200, started.text
        fresh = client.get(f"/api/runs/{run_id}").json()
        assert fresh["status"] == "active"
        assert fresh["current"] is not None
        assert fresh["remaining"] > 0
        # The listening history of the finished pass is untouched.
        assert fresh["cursor"] == len(fake_provider.tracks)
        # B8 (Runde 2): der Provider bekam das frische Fenster der NEUEN
        # Titel wirklich zu hören — nicht nur eine 200er-Antwort.
        assert len(fake_provider.play_windows) == windows_before + 1
        assert fake_provider.play_windows[-1][0] == fresh["current"]["id"]


def test_a_rule_change_that_opens_nothing_stays_honestly_completed(
    fake_provider,
):
    """No silent fake success: still no_repeat → nothing reopens, and the
    answer says so instead of a bare ``replanned: 0``."""
    with TestClient(app) as client:
        _connect(client)
        run_id = _completed_run(client, fake_provider)

        changed = client.post(f"/api/runs/{run_id}/rules", json={
            "rules": {"skip_policy": "defer_to_end"},
        })
        assert changed.status_code == 200, changed.text
        body = changed.json()
        assert body["reopened"] is False
        assert body["status"] == "completed"
        assert body["replanned"] == 0

        payload = client.get(f"/api/runs/{run_id}").json()
        assert payload["status"] == "completed"
        assert client.post(f"/api/runs/{run_id}/start",
                           json={"device_id": "dev1"}).status_code == 409


def test_a_new_cycle_after_completion_starts_without_a_slot_conflict(
    fake_provider,
):
    """UC-24 „einen neuen Durchlauf starten": Reset (F2) + Start, no 409."""
    with TestClient(app) as client:
        _connect(client)
        run_id = _completed_run(client, fake_provider)

        reset = client.post(f"/api/runs/{run_id}/reset",
                            json={"confirm": True})
        assert reset.status_code == 200, reset.text
        assert reset.json()["cycle"] == 2
        assert reset.json()["status"] in ("active", "paused")

        started = client.post(f"/api/runs/{run_id}/start",
                              json={"device_id": "dev1"})
        assert started.status_code == 200, started.text
        payload = client.get(f"/api/runs/{run_id}").json()
        assert payload["status"] == "active"
        assert payload["cursor"] == 0
        assert payload["current"] is not None
