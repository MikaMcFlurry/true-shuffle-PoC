"""Security-Härtung — Regressionstests zu den Runde-2-Review-Auflagen.

Deckt die als Gate-Auflage eingestuften Findings SEC-01/03/04/05/06/07/09/
12/13/14/16/17 ab.  Erzeuger (Implementierung) und Abnehmer (dieser Test)
sind bewusst getrennt — die Findings stammen aus dem unabhängigen Review.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass

import pytest_asyncio
from fastapi.testclient import TestClient

from app import db, library_service, retention, runs
from app.main import app
from core.models import AdvanceReason, PlaylistRef, RunMode
from providers.base import TokenBundle
from tests.conftest import FakeProvider

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


# ---------------------------------------------------------------------------
# SEC-01 — fail closed on a default SECRET_KEY away from localhost
# ---------------------------------------------------------------------------

def test_default_secret_key_refuses_to_start_when_not_local(monkeypatch):
    from app.config import Settings

    remote = Settings(secret_key="change-me", base_url="https://ts.example",
                      access_code="")
    assert remote.refuse_to_start_reason() is not None

    gated = Settings(secret_key="change-me", base_url="http://127.0.0.1:8000",
                     access_code="letmein")
    assert gated.refuse_to_start_reason() is not None

    local = Settings(secret_key="change-me", base_url="http://127.0.0.1:8000",
                     access_code="")
    assert local.refuse_to_start_reason() is None

    strong = Settings(secret_key="x" * 40, base_url="https://ts.example",
                      access_code="letmein")
    assert strong.refuse_to_start_reason() is None


# ---------------------------------------------------------------------------
# SEC-16 — baseline security headers on every response
# ---------------------------------------------------------------------------

def test_security_headers_are_present(fake_provider):
    with TestClient(app) as client:
        r = client.get("/api/health")
        assert r.headers["X-Content-Type-Options"] == "nosniff"
        assert r.headers["X-Frame-Options"] == "DENY"
        assert r.headers["Referrer-Policy"] == "same-origin"


# ---------------------------------------------------------------------------
# SEC-12 / SEC-13 — disconnect and browser callback validate the provider
# ---------------------------------------------------------------------------

def test_disconnect_rejects_unknown_provider_and_writes_no_ledger_row(
    fake_provider,
):
    with TestClient(app) as client:
        _connect(client)
        # Unknown service → 404, and no deletion_requests spam.
        assert client.post("/auth/gibt-es-nicht/disconnect").status_code == 404
        # Connected → the real one works.
        assert client.post("/auth/fake/disconnect").status_code == 200
        # A second disconnect of the now-gone account → 404, not another row.
        assert client.post("/auth/fake/disconnect").status_code == 404


def test_browser_callback_on_unknown_provider_is_404_not_500(fake_provider):
    with TestClient(app) as client:
        _connect(client)
        r = client.post("/auth/gibtsnicht/browser", json={})
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# SEC-09 — a wrong-state callback must not destroy a pending connect flow
# ---------------------------------------------------------------------------

def test_a_wrong_state_callback_leaves_the_pending_flow_intact(fake_provider):
    with TestClient(app) as client:
        client.get("/auth/fake/login", follow_redirects=False)
        # Attacker GET with a bogus state → 400 …
        assert client.get(
            "/auth/fake/callback",
            params={"code": "x", "state": "bogus"},
            follow_redirects=False,
        ).status_code == 400
        # … and the victim's real state still completes.
        from itsdangerous import TimestampSigner

        from app.config import get_settings

        cookie = client.cookies.get("session")
        data = TimestampSigner(get_settings().secret_key).unsign(cookie, max_age=3600)
        state = json.loads(base64.urlsafe_b64decode(data))["oauth_state"]
        done = client.get(
            "/auth/fake/callback",
            params={"code": "test-code", "state": state},
            follow_redirects=False,
        )
        assert done.status_code == 303


# ---------------------------------------------------------------------------
# Service-level fixtures for the retention / watcher findings
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
    user_id = await db.get_or_create_user("local-sec")
    await db.upsert_provider_account(
        user_id=user_id, provider="fake", provider_user_id="u",
        display_name="U", market="DE", product_tier="premium",
        token={"access_token": "t"},
    )
    session = Session(
        user_id=user_id, provider=provider, token=TokenBundle(access_token="t")
    )
    playlist = (await provider.list_playlists(None))[0]
    return Service(session=session, provider=provider, playlist=playlist,
                   user_id=user_id)


async def _one(sql, params=()):
    cur = await db.get_db().execute(sql, params)
    row = await cur.fetchone()
    return row[0] if row is not None else None


async def _run_with_history(service: Service):
    await library_service.import_playlist(service.session, service.playlist)
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER, name="sec",
    )
    await runs.start(service.session, state, device_id="dev1")
    await runs.advance(service.session, state, reason=AdvanceReason.TRACK_ENDED)
    await runs.advance(service.session, state, reason=AdvanceReason.TRACK_ENDED)
    return state


# ---------------------------------------------------------------------------
# SEC-03 / SEC-04 — deletion leaves no identifying provider data behind
# ---------------------------------------------------------------------------

async def test_deletion_scrubs_ids_names_keys_jobs_and_skips(
    database, service,
):
    state = await _run_with_history(service)
    # A skip with a track id, and a running job row with a playlist id.
    await db.record_skipped(state.run_id, [
        {"id": "t7", "name": "Track 7", "artist": "A",
         "reason": "not_playable"},
    ])
    await db.get_db().execute(
        "INSERT INTO jobs (id, user_id, kind, result_json) VALUES "
        "(?, ?, 'import', ?)",
        ("job-x", service.user_id,
         json.dumps({"provider_playlist_id": "pl1", "playlist_name": "Everything"})),
    )
    await db.get_db().commit()

    await retention.schedule_provider_deletion(service.user_id, "fake")
    outcomes = await retention.run_due_deletions(include_not_due=True)
    assert [o["status"] for o in outcomes] == ["done"]

    # runs: no playlist id / name left.
    assert await _one(
        "SELECT count(*) FROM runs WHERE user_id = ? AND "
        "(playlist_id != '' OR name != '' OR playlist_name != '')",
        (service.user_id,),
    ) == 0
    # event_key: no raw track ids — all redacted.
    assert await _one(
        "SELECT count(*) FROM run_events WHERE run_id = ? AND event_key != '' "
        "AND event_key NOT LIKE 'redacted:%'",
        (state.run_id,),
    ) == 0
    # event detail: only allowlisted keys survive (no track_id/from_track/device_id).
    for (detail,) in await (await db.get_db().execute(
        "SELECT detail FROM run_events WHERE run_id = ?", (state.run_id,)
    )).fetchall():
        keys = set(json.loads(detail or "{}"))
        assert keys <= retention._DETAIL_ALLOWLIST, keys
    # skipped_tracks: track id gone.
    assert await _one(
        "SELECT count(*) FROM skipped_tracks WHERE run_id = ? AND track_id != ''",
        (state.run_id,),
    ) == 0
    # jobs: gone.
    assert await _one(
        "SELECT count(*) FROM jobs WHERE user_id = ?", (service.user_id,)
    ) == 0


# ---------------------------------------------------------------------------
# SEC-06 — disconnect stops the watcher and the runs
# ---------------------------------------------------------------------------

async def test_disconnect_stops_runs_so_no_orphan_loop_remains(
    database, service, monkeypatch,
):
    from providers import registry
    monkeypatch.setitem(registry._PROVIDERS, "fake", service.provider)

    state = await _run_with_history(service)
    await db.update_run(state.run_id, status="active")
    from app.watcher import watcher
    assert await watcher.ensure(state.run_id, service.user_id) is True
    assert watcher.is_watching(state.run_id)

    await retention.schedule_provider_deletion(service.user_id, "fake")

    assert not watcher.is_watching(state.run_id)
    run = await db.get_run(state.run_id)
    assert run["status"] == "stopped"


# ---------------------------------------------------------------------------
# SEC-07 — an unreadable token blob is a reconnect, not a 500
# ---------------------------------------------------------------------------

def test_an_unreadable_token_blob_is_a_clean_refusal(fake_provider):
    import sqlite3

    from app.config import get_settings

    with TestClient(app) as client:
        _connect(client)
        # Corrupt the stored blob directly on the DB file (avoids grabbing the
        # app's async loop from this sync test — the TestClient owns it).
        conn = sqlite3.connect(get_settings().db_abs_path)
        conn.execute("UPDATE provider_accounts SET token_blob = 'tsv1:AAAA'")
        conn.commit()
        conn.close()

        r = client.get("/api/playlists", params={"provider": "fake"})
        assert r.status_code in (401, 409, 502)
        assert r.status_code != 500
