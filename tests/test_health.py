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
