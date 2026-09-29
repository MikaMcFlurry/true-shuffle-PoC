"""Regression checks for parked listening sessions and provider cooldowns."""

import httpx
import pytest

from app import db, runs
from app.accounts import open_session
from app.watcher import _next_delay
from providers import http
from providers.base import ProviderQuotaError, user_message
from tests.test_watcher import setup_run


async def test_long_retry_after_blocks_other_endpoints_without_extra_requests(monkeypatch):
    calls = []
    now = [1000.0]
    monkeypatch.setattr(http.time, "monotonic", lambda: now[0])

    class Client:
        def __init__(self, **kwargs):
            pass

        async def request(self, method, url, **kwargs):
            calls.append(url)
            if len(calls) == 1:
                return httpx.Response(429, headers={"Retry-After": "120"})
            return httpx.Response(200, json={"ok": True})

        async def aclose(self):
            pass

    monkeypatch.setattr(http.httpx, "AsyncClient", Client)
    with pytest.raises(ProviderQuotaError) as caught:
        await http.request("GET", "https://api.spotify.com/v1/me/player", provider="spotify")
    assert caught.value.retry_after_s == 120
    assert "Kontingent" not in user_message(caught.value)
    with pytest.raises(ProviderQuotaError):
        await http.request("GET", "https://api.spotify.com/v1/me/playlists", provider="spotify")
    assert len(calls) == 1
    now[0] += 121
    assert await http.request("GET", "https://api.spotify.com/v1/me", provider="spotify")
    assert len(calls) == 2


async def test_quota_exceeded_protects_foreground_and_background_calls(monkeypatch):
    calls = []

    class Client:
        def __init__(self, **kwargs):
            pass

        async def request(self, *args, **kwargs):
            calls.append(args)
            return httpx.Response(429, json={"error": {"reason": "QUOTA_EXCEEDED"}})

        async def aclose(self):
            pass

    monkeypatch.setattr(http.httpx, "AsyncClient", Client)
    for endpoint in ("me/player", "tracks/a", "me/playlists"):
        with pytest.raises(ProviderQuotaError) as caught:
            await http.request("GET", f"https://api.spotify.com/v1/{endpoint}",
                               provider="spotify")
        assert caught.value.reason == "QUOTA_EXCEEDED"
        assert caught.value.retry_after_s > 890
    assert len(calls) == 1


async def test_resume_old_unfinished_card_keeps_song_position_and_history(database, fake_provider):
    run_id, user_id, order = await setup_run(fake_provider)
    await db.record_observation(run_id, track_id=order[0], progress_ms=42_000,
                                duration_ms=180_000, satisfied=False)
    await db.get_db().execute(
        "UPDATE runs SET observed_at = '2020-01-01 00:00:00' WHERE id = ?", (run_id,),
    )
    await db.get_db().commit()
    state = await runs.get_state(run_id, user_id)
    session = await open_session(user_id, "fake")
    await runs.start(session, state)
    assert fake_provider.play_positions[0] == 42_000
    fresh = await runs.get_state(run_id, user_id)
    assert fresh.cursor == 0
    assert fresh.order == order


def test_idle_and_drift_polling_use_the_quiet_interval():
    assert _next_delay(None, 4, max_poll=30) == 30
    assert _next_delay(None, 4, max_poll=30, paused=True) == 30
