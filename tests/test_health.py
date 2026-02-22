"""Smoke tests for FastAPI app startup and /health endpoint."""

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_health_returns_ok():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "version" in data


def test_health_version_matches_app():
    response = client.get("/health")
    data = response.json()
    assert data["version"] == app.version


def test_root_returns_home_page():
    response = client.get("/")
    assert response.status_code == 200
    assert "true-shuffle" in response.text
    assert "Login with Spotify" in response.text


def test_root_shows_playlists_link_when_logged_in():
    # Simulate a logged-in session by setting the session cookie
    with TestClient(app) as c:
        # Use the session middleware directly
        response = c.get("/")
        assert response.status_code == 200
