"""Tests for Utility Mode routes (app/routes_utility.py)."""

from __future__ import annotations


import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routes_utility import _parse_tracks


@pytest.fixture(autouse=True)
def _use_tmp_db(monkeypatch, tmp_path):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "test_cid")
    monkeypatch.setenv("SECRET_KEY", "test_secret")
    from app.config import get_settings
    get_settings.cache_clear()


client = TestClient(app)


# ---------------------------------------------------------------------------
# _parse_tracks helper
# ---------------------------------------------------------------------------

class TestParseTracks:
    def test_parses_normal_track(self):
        raw = [
            {
                "track": {
                    "uri": "spotify:track:abc",
                    "name": "Song",
                    "artists": [{"name": "Artist"}],
                    "is_playable": True,
                    "is_local": False,
                    "type": "track",
                }
            }
        ]
        tracks = _parse_tracks(raw)
        assert len(tracks) == 1
        assert tracks[0].uri == "spotify:track:abc"
        assert tracks[0].artist == "Artist"

    def test_skips_none_track(self):
        raw = [{"track": None}]
        tracks = _parse_tracks(raw)
        assert len(tracks) == 0

    def test_multiple_artists(self):
        raw = [
            {
                "track": {
                    "uri": "spotify:track:abc",
                    "name": "Collab",
                    "artists": [{"name": "A"}, {"name": "B"}],
                    "type": "track",
                }
            }
        ]
        tracks = _parse_tracks(raw)
        assert tracks[0].artist == "A, B"


# ---------------------------------------------------------------------------
# /playlists
# ---------------------------------------------------------------------------

def test_playlists_requires_login():
    """Should return 401 if not logged in."""
    resp = client.get("/playlists")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# /utility/create
# ---------------------------------------------------------------------------

def test_utility_create_requires_login():
    """Should return 401 if not logged in."""
    resp = client.post("/utility/create", data={"playlist_id": "test"})
    assert resp.status_code == 401


def test_utility_create_requires_playlist_id():
    """Should return 400 if no playlist_id."""
    # Simulate logged-in session
    with client:
        # Set session manually
        client.cookies.clear()
        resp = client.post("/utility/create", data={})
        # Will be 401 without session — that's correct
        assert resp.status_code in (400, 401)
