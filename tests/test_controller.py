"""Tests for Controller Mode (app/controller.py + app/controller_routes.py).

All Spotify API calls are mocked via ``spotify_client`` patching.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.controller import (
    ControllerSession,
    ControllerState,
    _fill_buffer,
    _hard_override,
    _poll_playback,
    _shuffle_order,
    create_or_resume_run,
    manual_next,
    start_playback,
    stop_controller,
)
from app.db import close_db, init_db
from app.main import app


@pytest.fixture(autouse=True)
def _env_setup(monkeypatch, tmp_path):
    """Use temp DB and clear settings cache for every test."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "test_client_id")
    monkeypatch.setenv("SECRET_KEY", "test_secret")
    from app.config import get_settings
    get_settings.cache_clear()


@pytest.fixture
async def db_session(tmp_path, monkeypatch):
    """Init DB, insert a test user, yield, then close."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    from app.config import get_settings
    get_settings.cache_clear()

    db = await init_db()
    await db.execute(
        "INSERT INTO users (spotify_user_id, display_name, token_data) VALUES (?, ?, ?)",
        ("test_user", "Test User", json.dumps({"access_token": "tok", "expires_at": 9999999999})),
    )
    await db.commit()
    yield db
    # Clean up controller sessions
    from app.controller import _sessions
    _sessions.clear()
    await close_db()


# ---------------------------------------------------------------------------
# Shuffle tests
# ---------------------------------------------------------------------------


def test_shuffle_order_deduplicates():
    uris = ["a", "b", "a", "c", "b"]
    result = _shuffle_order(uris)
    assert len(result) == 3
    assert len(set(result)) == 3


def test_shuffle_order_preserves_all_unique():
    uris = [f"track:{i}" for i in range(20)]
    result = _shuffle_order(uris)
    assert set(result) == set(uris)
    assert len(result) == 20


def test_shuffle_order_returns_different_order():
    """With 20+ tracks, the probability of identical order is negligible."""
    uris = [f"track:{i}" for i in range(50)]
    results = {tuple(_shuffle_order(uris)) for _ in range(5)}
    assert len(results) > 1  # At least 2 different orders


# ---------------------------------------------------------------------------
# Session tests
# ---------------------------------------------------------------------------


def test_session_to_status_dict():
    session = ControllerSession(
        run_id=1,
        user_id=1,
        spotify_user_id="u1",
        playlist_id="p1",
        order=["a", "b", "c"],
        cursor=1,
    )
    session.state = ControllerState.PLAYING
    status = session.to_status_dict()
    assert status["state"] == "playing"
    assert status["cursor"] == 1
    assert status["total_tracks"] == 3
    assert status["current_track_uri"] == "b"


# ---------------------------------------------------------------------------
# create_or_resume_run
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_run(db_session):
    """Creating a run produces a session with shuffled order."""
    with patch("app.controller._fetch_playlist_tracks", new_callable=AsyncMock) as mock_fetch:
        mock_fetch.return_value = [f"spotify:track:{i}" for i in range(10)]
        session = await create_or_resume_run("test_user", "playlist_123")

    assert session.cursor == 0
    assert len(session.order) == 10
    assert session.state == ControllerState.IDLE


@pytest.mark.asyncio
async def test_resume_existing_run(db_session):
    """Resuming returns the same run with the same cursor."""
    db = db_session
    # Get user_id
    cur = await db.execute("SELECT id FROM users WHERE spotify_user_id = 'test_user'")
    user = await cur.fetchone()
    user_id = user[0]

    order = json.dumps(["a", "b", "c", "d", "e"])
    await db.execute(
        """INSERT INTO runs (user_id, playlist_id, mode, shuffled_order, cursor, queued_until_index)
           VALUES (?, ?, 'controller', ?, 3, 5)""",
        (user_id, "playlist_abc", order),
    )
    await db.commit()

    session = await create_or_resume_run("test_user", "playlist_abc")
    assert session.cursor == 3
    assert session.order == ["a", "b", "c", "d", "e"]


# ---------------------------------------------------------------------------
# Buffer fill
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fill_buffer_sequential(db_session):
    """Fill buffer should make N sequential POST /queue calls."""
    order = [f"spotify:track:{i}" for i in range(10)]
    session = ControllerSession(
        run_id=1, user_id=1, spotify_user_id="test_user",
        playlist_id="p1", order=order, cursor=0, queued_until_index=0,
    )

    mock_resp = MagicMock()
    mock_resp.status_code = 204

    with patch("app.controller.sp_post", new_callable=AsyncMock, return_value=mock_resp) as mock_post:
        await _fill_buffer(session)

    # Should queue tracks 1..5 (5 calls)
    assert mock_post.call_count == 5
    # Verify sequential URIs
    for i, call in enumerate(mock_post.call_args_list):
        assert call[0][0] == "/me/player/queue"
        assert call[1]["json_body"]["uri"] == f"spotify:track:{i + 1}"


# ---------------------------------------------------------------------------
# Hard override
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hard_override_on_wrong_track(db_session):
    """Hard override fires PUT /play and refills buffer."""
    order = [f"spotify:track:{i}" for i in range(10)]
    session = ControllerSession(
        run_id=1, user_id=1, spotify_user_id="test_user",
        playlist_id="p1", order=order, cursor=2, queued_until_index=5,
    )
    session.state = ControllerState.PLAYING

    mock_put_resp = MagicMock()
    mock_put_resp.status_code = 204
    mock_post_resp = MagicMock()
    mock_post_resp.status_code = 204

    with patch("app.controller.sp_put", new_callable=AsyncMock, return_value=mock_put_resp) as mock_put, \
         patch("app.controller.sp_post", new_callable=AsyncMock, return_value=mock_post_resp):
        await _hard_override(session)

    # Should have called PUT /play with the correct track
    mock_put.assert_called_once()
    call_body = mock_put.call_args[1]["json_body"]
    assert call_body["uris"] == ["spotify:track:2"]
    assert session.state == ControllerState.PLAYING


# ---------------------------------------------------------------------------
# Poll / skip detection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_skip_detection_advances_cursor(db_session):
    """When poll detects the next track playing, cursor advances."""
    order = ["spotify:track:0", "spotify:track:1", "spotify:track:2"]
    session = ControllerSession(
        run_id=1, user_id=1, spotify_user_id="test_user",
        playlist_id="p1", order=order, cursor=0, queued_until_index=2,
    )
    session.state = ControllerState.PLAYING

    # Simulate Spotify reporting track:1 (the next expected track)
    mock_get_resp = MagicMock()
    mock_get_resp.status_code = 200
    mock_get_resp.json.return_value = {
        "is_playing": True,
        "item": {
            "uri": "spotify:track:1",
            "name": "Track 1",
            "artists": [{"name": "Artist"}],
            "album": {"images": [{"url": "http://img"}]},
        },
    }
    mock_post_resp = MagicMock()
    mock_post_resp.status_code = 204

    with patch("app.controller.sp_get", new_callable=AsyncMock, return_value=mock_get_resp), \
         patch("app.controller.sp_post", new_callable=AsyncMock, return_value=mock_post_resp):
        await _poll_playback(session)

    assert session.cursor == 1
    assert session.state == ControllerState.PLAYING


@pytest.mark.asyncio
async def test_foreign_track_triggers_override(db_session):
    """When poll detects a foreign track, hard override fires."""
    order = ["spotify:track:0", "spotify:track:1", "spotify:track:2"]
    session = ControllerSession(
        run_id=1, user_id=1, spotify_user_id="test_user",
        playlist_id="p1", order=order, cursor=0, queued_until_index=2,
    )
    session.state = ControllerState.PLAYING

    # Simulate Spotify reporting a completely foreign track
    mock_get_resp = MagicMock()
    mock_get_resp.status_code = 200
    mock_get_resp.json.return_value = {
        "is_playing": True,
        "item": {
            "uri": "spotify:track:FOREIGN",
            "name": "Foreign Track",
            "artists": [{"name": "Other"}],
            "album": {"images": []},
        },
    }
    mock_put_resp = MagicMock()
    mock_put_resp.status_code = 204
    mock_post_resp = MagicMock()
    mock_post_resp.status_code = 204

    with patch("app.controller.sp_get", new_callable=AsyncMock, return_value=mock_get_resp), \
         patch("app.controller.sp_put", new_callable=AsyncMock, return_value=mock_put_resp) as mock_put, \
         patch("app.controller.sp_post", new_callable=AsyncMock, return_value=mock_post_resp):
        await _poll_playback(session)

    # Should have called PUT /play to override
    mock_put.assert_called_once()
    assert session.state == ControllerState.PLAYING


# ---------------------------------------------------------------------------
# 403 Premium error
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_403_raises_premium_error(db_session):
    """A 403 from Spotify should set ERROR state."""
    from app.spotify_client import SpotifyPremiumRequired

    order = ["spotify:track:0", "spotify:track:1"]
    session = ControllerSession(
        run_id=1, user_id=1, spotify_user_id="test_user",
        playlist_id="p1", order=order, cursor=0,
    )

    with patch("app.controller.sp_put", new_callable=AsyncMock, side_effect=SpotifyPremiumRequired("Premium required")), \
         patch("app.controller._find_active_device", new_callable=AsyncMock, return_value="device_123"):
        await start_playback(session)

    assert session.state == ControllerState.ERROR
    assert "Premium" in session.error_message


# ---------------------------------------------------------------------------
# No device
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_device_returns_no_device_state(db_session):
    """If no Spotify device found, state should be NO_DEVICE."""
    order = ["spotify:track:0"]
    session = ControllerSession(
        run_id=1, user_id=1, spotify_user_id="test_user",
        playlist_id="p1", order=order,
    )

    with patch("app.controller._find_active_device", new_callable=AsyncMock, return_value=None):
        await start_playback(session)

    assert session.state == ControllerState.NO_DEVICE
    assert "Spotify" in session.error_message


# ---------------------------------------------------------------------------
# Route tests (via TestClient)
# ---------------------------------------------------------------------------

client = TestClient(app)


def test_controller_status_unauthenticated():
    """Status endpoint should return 401 without session."""
    resp = client.get("/controller/status?playlist_id=test")
    assert resp.status_code == 401


def test_controller_ui_redirects_without_login():
    """UI page should redirect to /login without session."""
    resp = client.get("/controller/ui?playlist_id=test", follow_redirects=False)
    assert resp.status_code == 307  # redirect to /login
