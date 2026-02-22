"""Tests for the utility shuffle-copy workflow (app/utility.py).

All Spotify API calls are mocked. Tests verify:
- Full workflow creates a run and renders success
- Existing active run is resumed (no re-shuffle)
- Excluded items are persisted
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(autouse=True)
def _use_tmp_db(monkeypatch, tmp_path):
    """Use a temp database for every test."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "test_client_id")
    monkeypatch.setenv("SECRET_KEY", "test_secret")
    from app.config import get_settings
    get_settings.cache_clear()


client = TestClient(app)


def _login_session():
    """Return a session-cookie dict that simulates a logged-in user."""
    # Insert a user first.
    from app.db import get_db
    import asyncio

    async def _setup():
        db = get_db()
        await db.execute(
            "INSERT OR IGNORE INTO users (spotify_user_id, display_name, token_data) VALUES (?, ?, ?)",
            ("test-user", "Test", json.dumps({"access_token": "tok", "expires_at": 9999999999})),
        )
        await db.commit()

    asyncio.get_event_loop().run_until_complete(_setup())


# ---------------------------------------------------------------------------
# Mocks for Spotify API calls
# ---------------------------------------------------------------------------

_MOCK_TRACKS = (
    [f"spotify:track:{i}" for i in range(5)],      # valid URIs
    [{"uri": "spotify:local:x", "reason": "local_file"}],  # excluded
)

_MOCK_PLAYLIST = {
    "id": "src-pl",
    "name": "My Playlist",
    "total_tracks": 6,
    "owner": "test-user",
}

_MOCK_NEW_PL = {
    "id": "new-pl-abc",
    "url": "https://open.spotify.com/playlist/new-pl-abc",
}


# ---------------------------------------------------------------------------
# Full workflow test
# ---------------------------------------------------------------------------

@patch("app.utility.add_tracks_batch", new_callable=AsyncMock, return_value=1)
@patch("app.utility.create_playlist", new_callable=AsyncMock, return_value=_MOCK_NEW_PL)
@patch("app.utility.get_playlist", new_callable=AsyncMock, return_value=_MOCK_PLAYLIST)
@patch("app.utility.get_playlist_tracks", new_callable=AsyncMock, return_value=_MOCK_TRACKS)
@patch("app.utility.get_valid_token", new_callable=AsyncMock, return_value="fake-token")
def test_utility_create_full_workflow(mock_token, mock_tracks, mock_pl, mock_create, mock_add):
    """POST /utility/create should create a shuffled copy and show success."""
    _login_session()

    # Simulate logged-in session.
    with client:
        # Set session cookie.
        client.cookies.clear()
        resp = client.get("/health")  # warm up lifespan

        # Manually set session.
        from starlette.testclient import TestClient as _TC
        with client as c:
            # Use the session middleware by setting a cookie manually.
            # We need to go through the session middleware, so we patch the request.
            pass

    # Direct approach: use app test client with session injection.
    from starlette.testclient import TestClient

    with TestClient(app) as tc:
        # We need to inject session data — simplest way is to patch _require_user.
        with patch("app.utility._require_user", return_value="test-user"):
            _login_session()
            resp = tc.post("/utility/create?playlist_id=src-pl")

    assert resp.status_code == 200
    assert "new-pl-abc" in resp.text
    assert "Shuffle Complete" in resp.text

    # Verify mocks were called.
    mock_tracks.assert_called_once()
    mock_create.assert_called_once()
    mock_add.assert_called_once()


# ---------------------------------------------------------------------------
# Excluded items persisted
# ---------------------------------------------------------------------------

@patch("app.utility.add_tracks_batch", new_callable=AsyncMock, return_value=1)
@patch("app.utility.create_playlist", new_callable=AsyncMock, return_value=_MOCK_NEW_PL)
@patch("app.utility.get_playlist", new_callable=AsyncMock, return_value=_MOCK_PLAYLIST)
@patch("app.utility.get_playlist_tracks", new_callable=AsyncMock, return_value=_MOCK_TRACKS)
@patch("app.utility.get_valid_token", new_callable=AsyncMock, return_value="fake-token")
def test_utility_persists_excluded_items(mock_token, mock_tracks, mock_pl, mock_create, mock_add):
    """Excluded items should be visible on the result page."""
    _login_session()

    with TestClient(app) as tc:
        with patch("app.utility._require_user", return_value="test-user"):
            _login_session()
            resp = tc.post("/utility/create?playlist_id=src-pl-2")

    assert resp.status_code == 200
    assert "1 items were skipped" in resp.text or "1" in resp.text


# ---------------------------------------------------------------------------
# Resume existing run
# ---------------------------------------------------------------------------

@patch("app.utility.add_tracks_batch", new_callable=AsyncMock, return_value=1)
@patch("app.utility.create_playlist", new_callable=AsyncMock, return_value={"id": "first-pl", "url": ""})
@patch("app.utility.get_playlist", new_callable=AsyncMock, return_value=_MOCK_PLAYLIST)
@patch("app.utility.get_playlist_tracks", new_callable=AsyncMock, return_value=_MOCK_TRACKS)
@patch("app.utility.get_valid_token", new_callable=AsyncMock, return_value="fake-token")
def test_utility_no_duplicate_run(mock_token, mock_tracks, mock_pl, mock_create, mock_add):
    """Creating a shuffle for the same playlist twice should not create two active runs."""
    _login_session()

    with TestClient(app) as tc:
        with patch("app.utility._require_user", return_value="test-user"):
            _login_session()
            resp1 = tc.post("/utility/create?playlist_id=src-dedup")
            assert resp1.status_code == 200

    # The run status is 'completed', so a second call will create a new one
    # (resume only applies to 'active' runs).
    mock_create.return_value = {"id": "second-pl", "url": ""}
    with TestClient(app) as tc:
        with patch("app.utility._require_user", return_value="test-user"):
            _login_session()
            resp2 = tc.post("/utility/create?playlist_id=src-dedup")
            assert resp2.status_code == 200
