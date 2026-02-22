"""Tests for Spotify OAuth PKCE flow (app/auth.py)."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import _generate_code_challenge, _generate_code_verifier
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


# ---------------------------------------------------------------------------
# PKCE helper tests
# ---------------------------------------------------------------------------

def test_code_verifier_length():
    v = _generate_code_verifier(64)
    assert len(v) == 64


def test_code_verifier_is_url_safe():
    v = _generate_code_verifier()
    # URL-safe base64 chars only
    for ch in v:
        assert ch.isalnum() or ch in "-_"


def test_code_challenge_deterministic():
    v = "test_verifier_value"
    c1 = _generate_code_challenge(v)
    c2 = _generate_code_challenge(v)
    assert c1 == c2
    assert len(c1) > 0


def test_code_challenge_is_base64url():
    c = _generate_code_challenge("hello_world")
    for ch in c:
        assert ch.isalnum() or ch in "-_"
    # No padding
    assert "=" not in c


# ---------------------------------------------------------------------------
# /login endpoint
# ---------------------------------------------------------------------------

def test_login_redirects_to_spotify():
    resp = client.get("/login", follow_redirects=False)
    assert resp.status_code == 307
    location = resp.headers["location"]
    assert "accounts.spotify.com/authorize" in location
    assert "code_challenge" in location
    assert "client_id=test_client_id" in location


def test_login_fails_without_client_id(monkeypatch):
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "")
    from app.config import get_settings
    get_settings.cache_clear()

    resp = client.get("/login")
    assert resp.status_code == 500
    assert "SPOTIFY_CLIENT_ID" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# /callback endpoint
# ---------------------------------------------------------------------------

def test_callback_error_param():
    resp = client.get("/callback?error=access_denied")
    assert resp.status_code == 400
    assert "access_denied" in resp.json()["detail"]


def test_callback_missing_code():
    resp = client.get("/callback")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# /me endpoint
# ---------------------------------------------------------------------------

def test_me_requires_login():
    """GET /me without a session should return 401."""
    resp = client.get("/me")
    assert resp.status_code == 401
    assert "login" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# /logout endpoint
# ---------------------------------------------------------------------------

def test_logout_redirects():
    resp = client.get("/logout", follow_redirects=False)
    assert resp.status_code == 307
    assert resp.headers["location"] == "/"
