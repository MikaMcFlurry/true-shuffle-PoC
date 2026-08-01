"""UC-07 Pro-Titel-Gewicht — Service- und Draht-Vertrag (Befund B2, Runde 2).

Der adversariale Review wies nach, dass die §A-Runde UC-07 nur mit einem
Browser-Klicktest und einem fehlattribuierten Zitat belegte.  Diese Datei
liefert die fehlende Evidenz: PUT-Roundtrip, Grenzwerte, Ownership und die
Wirkung des Gewichts im echten Replan-Pfad.
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
from core.models import PlaylistRef, RunMode
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
    user_id = await db.get_or_create_user("local-weight")
    session = Session(
        user_id=user_id, provider=provider, token=TokenBundle(access_token="t")
    )
    playlist = (await provider.list_playlists(None))[0]
    return Service(session=session, provider=provider, playlist=playlist,
                   user_id=user_id)


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


def _deal(client) -> int:
    response = client.post("/api/runs", json={
        "provider": "fake", "playlist_id": "pl1", "mode": "controller",
    })
    job_id = response.json()["job_id"]
    deadline = time.time() + 10
    while time.time() < deadline:
        snap = client.get(f"/api/jobs/{job_id}").json()
        if snap["status"] == "done":
            return snap["result"]["run_id"]
        if snap["status"] == "error":
            pytest.fail(f"job failed: {snap['message']}")
        time.sleep(0.05)
    pytest.fail("job did not finish in time")


async def test_set_track_weight_service_contract(database, service):
    """Setzen, Idempotenz, Ownership-404, Grenzen (ValueError)."""
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER, name="w",
    )
    card = await db.find_run_track(state.run_id,
                                   provider_track_id=state.order[2])

    result = await runs.set_track_weight(
        service.user_id, state.run_id, int(card["id"]), 2.0
    )
    assert result == {"run_id": state.run_id, "run_track_id": int(card["id"]),
                      "weight": 2.0}
    fresh = await db.find_run_track(state.run_id, run_track_id=int(card["id"]))
    assert float(fresh["weight"]) == 2.0
    events = [e["type"] for e in await db.list_events(state.run_id)]
    assert events.count("track_weighted") == 1

    # Idempotent: derselbe Wert erzeugt kein zweites Ereignis.
    await runs.set_track_weight(
        service.user_id, state.run_id, int(card["id"]), 2.0
    )
    events = [e["type"] for e in await db.list_events(state.run_id)]
    assert events.count("track_weighted") == 1

    # Fremder Nutzer: 404-None, nichts geändert.
    stranger = await db.get_or_create_user("someone-else")
    assert await runs.set_track_weight(
        stranger, state.run_id, int(card["id"]), 0.4
    ) is None
    fresh = await db.find_run_track(state.run_id, run_track_id=int(card["id"]))
    assert float(fresh["weight"]) == 2.0

    # Grenzen: 0.1..10.0, endlich.
    for bad in (0.05, 10.5, 0.0, -1.0, float("nan"), float("inf")):
        with pytest.raises(ValueError):
            await runs.set_track_weight(
                service.user_id, state.run_id, int(card["id"]), bad
            )


async def test_weight_changes_the_next_replan_deterministically(
    database, service,
):
    """Wirkung im echten Replan (Muster von P4-favorite): gleicher Seed,
    gleiche seq-Uhr — erst das gesetzte Gewicht ändert den neu gezogenen
    Tail.  Unter ``no_repeat`` ändert das Gewicht die REIHENFOLGE des
    Replans, nie die Häufigkeit (membership-only, s. set_track_weight-
    Docstring) — genau diese Ordnung wird hier belegt."""
    config_id = await db.create_config(
        service.user_id, "gap0", Rules(min_gap=0)
    )
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER,
        name="w-replan", config_id=config_id,
    )
    # Baseline-Replan (seq bewegt sich bei Regeländerungen nicht — beide
    # Redraws laufen unter derselben Uhr und demselben Master-Seed).
    await runs.change_run_rules(state, {"skip_policy": "defer_to_end"})
    baseline_tail = list(state.order[state.cursor + 1:])

    card = await db.find_run_track(state.run_id,
                                   provider_track_id=baseline_tail[-1])
    await runs.set_track_weight(
        service.user_id, state.run_id, int(card["id"]), 10.0
    )
    await runs.change_run_rules(state, {"skip_policy": "defer_to_end"})
    weighted_tail = list(state.order[state.cursor + 1:])

    assert sorted(weighted_tail) == sorted(baseline_tail)  # membership only
    assert weighted_tail != baseline_tail                  # order changed


def test_track_weight_over_the_wire(fake_provider):
    """PUT-Roundtrip, 400-Grenzen, 404, und das weight-Feld im Player-Payload."""
    with TestClient(app) as client:
        _connect(client)
        run_id = _deal(client)
        payload = client.get(f"/api/runs/{run_id}").json()
        target = payload["upcoming"][0]
        assert target["weight"] == 1.0

        ok = client.put(
            f"/api/runs/{run_id}/tracks/{target['run_track_id']}/weight",
            json={"weight": 0.4},
        )
        assert ok.status_code == 200, ok.text
        assert ok.json()["weight"] == 0.4
        fresh = client.get(f"/api/runs/{run_id}").json()
        by_id = {e["run_track_id"]: e for e in fresh["upcoming"]}
        assert by_id[target["run_track_id"]]["weight"] == 0.4

        for bad in (0.01, 42, "quatsch", None):
            answer = client.put(
                f"/api/runs/{run_id}/tracks/{target['run_track_id']}/weight",
                json={"weight": bad},
            )
            assert answer.status_code == 400, (bad, answer.text)

        assert client.put(
            f"/api/runs/{run_id}/tracks/999999/weight", json={"weight": 2.0}
        ).status_code == 404
