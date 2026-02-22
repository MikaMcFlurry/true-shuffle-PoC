"""Tests for the Spotify HTTP client wrapper (app/spotify_client.py)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.spotify_client import (
    SpotifyAPIError,
    _persist_tokens,
    spotify_request,
)


@pytest.fixture(autouse=True)
def _use_tmp_db(monkeypatch, tmp_path):
    """Temp database + fake settings for every test."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "test_client_id")
    monkeypatch.setenv("SECRET_KEY", "test_secret")
    from app.config import get_settings

    get_settings.cache_clear()


@pytest.fixture()
async def _init_db():
    """Initialise the database and seed a test user with tokens."""
    from app.db import close_db, init_db

    db = await init_db()
    # Seed tokens for test user
    await _persist_tokens("test_user", "access_abc", "refresh_xyz", 9999999999)
    yield db
    await close_db()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_response(status_code: int, json_data: dict | None = None, headers: dict | None = None) -> httpx.Response:
    """Build a fake httpx.Response."""
    resp = httpx.Response(
        status_code=status_code,
        json=json_data or {},
        headers=headers or {},
    )
    return resp


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_successful_request(_init_db):
    """A 200 response should be returned directly."""
    fake_resp = _mock_response(200, {"id": "test_user", "display_name": "Test"})

    with patch("app.spotify_client.httpx.AsyncClient") as MockClient:
        instance = AsyncMock()
        instance.request = AsyncMock(return_value=fake_resp)
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = instance

        resp = await spotify_request("GET", "/v1/me", "test_user")
        assert resp.status_code == 200
        assert resp.json()["id"] == "test_user"


@pytest.mark.asyncio
async def test_429_retry(_init_db, monkeypatch):
    """429 should wait Retry-After seconds then retry."""
    # Speed up the test
    monkeypatch.setattr("app.spotify_client._JITTER_MAX", 0.0)

    resp_429 = _mock_response(429, headers={"Retry-After": "0"})
    resp_200 = _mock_response(200, {"ok": True})

    call_count = 0

    async def _side_effect(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return resp_429
        return resp_200

    with patch("app.spotify_client.httpx.AsyncClient") as MockClient:
        instance = AsyncMock()
        instance.request = AsyncMock(side_effect=_side_effect)
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = instance

        resp = await spotify_request("GET", "/v1/me", "test_user")
        assert resp.status_code == 200
        assert call_count == 2


@pytest.mark.asyncio
async def test_401_triggers_refresh(_init_db, monkeypatch):
    """401 should trigger a token refresh and retry once."""
    monkeypatch.setattr("app.spotify_client._JITTER_MAX", 0.0)

    resp_401 = _mock_response(401, {"error": "token expired"})
    resp_200 = _mock_response(200, {"id": "test_user"})

    call_count = 0

    async def _side_effect(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return resp_401
        return resp_200

    # Mock out _refresh_access_token to avoid hitting Spotify
    with (
        patch("app.spotify_client.httpx.AsyncClient") as MockClient,
        patch("app.spotify_client._refresh_access_token") as mock_refresh,
    ):
        mock_refresh.return_value = {
            "access_token": "new_token",
            "refresh_token": "refresh_xyz",
            "expires_at": 9999999999,
        }

        instance = AsyncMock()
        instance.request = AsyncMock(side_effect=_side_effect)
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = instance

        resp = await spotify_request("GET", "/v1/me", "test_user")
        assert resp.status_code == 200
        mock_refresh.assert_called_once()


@pytest.mark.asyncio
async def test_max_retries_raises(_init_db, monkeypatch):
    """After MAX_RETRIES 5xx errors, should raise SpotifyAPIError."""
    monkeypatch.setattr("app.spotify_client._JITTER_MAX", 0.0)
    monkeypatch.setattr("app.spotify_client._BACKOFF_BASE", 0.0)

    resp_500 = _mock_response(500, {"error": "internal"})

    with patch("app.spotify_client.httpx.AsyncClient") as MockClient:
        instance = AsyncMock()
        instance.request = AsyncMock(return_value=resp_500)
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = instance

        with pytest.raises(SpotifyAPIError, match="Max retries"):
            await spotify_request("GET", "/v1/me", "test_user")


@pytest.mark.asyncio
async def test_4xx_fails_immediately(_init_db):
    """A 403 should raise immediately without retrying."""
    resp_403 = _mock_response(403, {"error": "forbidden"})

    with patch("app.spotify_client.httpx.AsyncClient") as MockClient:
        instance = AsyncMock()
        instance.request = AsyncMock(return_value=resp_403)
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = instance

        with pytest.raises(SpotifyAPIError) as exc_info:
            await spotify_request("GET", "/v1/me", "test_user")
        assert exc_info.value.status_code == 403
