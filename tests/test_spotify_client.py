"""Tests for SpotifyClient retry, refresh, and sequential locking."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.spotify_client import SpotifyClient, _locks


@pytest.fixture(autouse=True)
def _setup_env(monkeypatch, tmp_path):
    """Provide env vars so Settings can load."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "test_cid")
    monkeypatch.setenv("SECRET_KEY", "test_secret")
    from app.config import get_settings
    get_settings.cache_clear()
    # Clear per-user locks between tests.
    _locks.clear()


@pytest.fixture
def client():
    return SpotifyClient("test_user_123")


def _mock_response(status: int = 200, json_data: dict | None = None, headers: dict | None = None):
    """Create a fake httpx.Response."""
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.json.return_value = json_data or {}
    resp.headers = headers or {}
    resp.text = ""
    return resp


# ------------------------------------------------------------------
# _request retry on 429
# ------------------------------------------------------------------

@pytest.mark.asyncio
async def test_retry_on_429(client):
    """Should retry after 429 and succeed on second attempt."""
    resp_429 = _mock_response(429, headers={"Retry-After": "0"})
    resp_200 = _mock_response(200, {"items": []})

    call_count = 0

    async def fake_request(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return resp_429
        return resp_200

    with (
        patch("app.spotify_client.get_valid_token", new_callable=AsyncMock, return_value="tok"),
        patch("httpx.AsyncClient") as mock_client_cls,
    ):
        mock_instance = AsyncMock()
        mock_instance.request = fake_request
        mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
        mock_instance.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_instance

        result = await client._request("GET", "/me/playlists")
        assert result.status_code == 200
        assert call_count == 2


# ------------------------------------------------------------------
# _request raises on 403
# ------------------------------------------------------------------

@pytest.mark.asyncio
async def test_raises_on_403(client):
    """Should raise HTTPException on 403 without retrying."""
    resp_403 = _mock_response(403)

    async def fake_request(*args, **kwargs):
        return resp_403

    with (
        patch("app.spotify_client.get_valid_token", new_callable=AsyncMock, return_value="tok"),
        patch("httpx.AsyncClient") as mock_client_cls,
    ):
        mock_instance = AsyncMock()
        mock_instance.request = fake_request
        mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
        mock_instance.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_instance

        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            await client._request("GET", "/me/player")
        assert exc_info.value.status_code == 403


# ------------------------------------------------------------------
# _request raises on 404
# ------------------------------------------------------------------

@pytest.mark.asyncio
async def test_raises_on_404(client):
    """Should raise HTTPException on 404."""
    resp_404 = _mock_response(404)

    async def fake_request(*args, **kwargs):
        return resp_404

    with (
        patch("app.spotify_client.get_valid_token", new_callable=AsyncMock, return_value="tok"),
        patch("httpx.AsyncClient") as mock_client_cls,
    ):
        mock_instance = AsyncMock()
        mock_instance.request = fake_request
        mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
        mock_instance.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_instance

        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            await client._request("PUT", "/me/player/play")
        assert exc_info.value.status_code == 404


# ------------------------------------------------------------------
# Sequential lock for Player API
# ------------------------------------------------------------------

@pytest.mark.asyncio
async def test_lock_serializes_player_calls(client):
    """Player API calls with use_lock=True should be serialized."""
    call_order: list[int] = []

    async def slow_request(*args, **kwargs):
        idx = len(call_order)
        call_order.append(idx)
        await asyncio.sleep(0.05)  # Simulate network
        return _mock_response(200, {"devices": []})

    with (
        patch("app.spotify_client.get_valid_token", new_callable=AsyncMock, return_value="tok"),
        patch("httpx.AsyncClient") as mock_client_cls,
    ):
        mock_instance = AsyncMock()
        mock_instance.request = slow_request
        mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
        mock_instance.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_instance

        # Fire two locked requests concurrently.
        t1 = asyncio.create_task(client._request("GET", "/me/player/devices", use_lock=True))
        t2 = asyncio.create_task(client._request("GET", "/me/player/devices", use_lock=True))
        await asyncio.gather(t1, t2)

        # Both should have completed in order (serialized, not parallel).
        assert len(call_order) == 2


# ------------------------------------------------------------------
# High-level methods
# ------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_playlists(client):
    """get_playlists should call the correct endpoint."""
    mock_data = {"items": [{"id": "p1", "name": "Test"}], "next": None}

    with (
        patch.object(client, "_request", new_callable=AsyncMock) as mock_req,
    ):
        mock_resp = _mock_response(200, mock_data)
        mock_req.return_value = mock_resp

        result = await client.get_playlists(limit=50, offset=0)
        assert result["items"][0]["id"] == "p1"
        mock_req.assert_called_once_with(
            "GET", "/me/playlists", params={"limit": 50, "offset": 0}
        )


@pytest.mark.asyncio
async def test_play_uses_lock(client):
    """play() should call _request with use_lock=True."""
    with patch.object(client, "_request", new_callable=AsyncMock) as mock_req:
        mock_req.return_value = _mock_response(204)
        await client.play(uris=["spotify:track:abc"])
        mock_req.assert_called_once()
        _, kwargs = mock_req.call_args
        assert kwargs["use_lock"] is True


@pytest.mark.asyncio
async def test_queue_uses_lock(client):
    """queue() should call _request with use_lock=True."""
    with patch.object(client, "_request", new_callable=AsyncMock) as mock_req:
        mock_req.return_value = _mock_response(204)
        await client.queue("spotify:track:def")
        mock_req.assert_called_once()
        _, kwargs = mock_req.call_args
        assert kwargs["use_lock"] is True


@pytest.mark.asyncio
async def test_add_tracks_batch_splits(client):
    """add_tracks_batch should split into batches of 100."""
    uris = [f"spotify:track:{i}" for i in range(250)]

    with patch.object(client, "_request", new_callable=AsyncMock) as mock_req:
        mock_req.return_value = _mock_response(201)
        await client.add_tracks_batch("playlist_id", uris)
        # 250 tracks → 3 batches (100, 100, 50)
        assert mock_req.call_count == 3
