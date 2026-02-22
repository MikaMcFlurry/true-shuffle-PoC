"""Spotify OAuth 2.0 with PKCE — no client secret needed.

Flow:
  1. GET /login        → redirect to Spotify /authorize with code_challenge
  2. GET /callback     → exchange code for tokens via /api/token
  3. Tokens stored in ``users.token_data`` (JSON blob)
  4. Session cookie holds ``spotify_user_id``
"""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from base64 import urlsafe_b64encode
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from app.config import get_settings
from app.db import get_db

router = APIRouter(tags=["auth"])

# Scopes required by this PoC
_SCOPES = " ".join(
    [
        "playlist-read-private",
        "playlist-read-collaborative",
        "playlist-modify-public",
        "playlist-modify-private",
        "user-read-playback-state",
        "user-modify-playback-state",
        "user-read-currently-playing",
    ]
)

_SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize"
_SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"
_SPOTIFY_ME_URL = "https://api.spotify.com/v1/me"


# ---------------------------------------------------------------------------
# PKCE helpers
# ---------------------------------------------------------------------------

def _generate_code_verifier(length: int = 128) -> str:
    """Random URL-safe string (43-128 chars) per RFC 7636."""
    return secrets.token_urlsafe(length)[:length]


def _generate_code_challenge(verifier: str) -> str:
    """S256 code challenge = BASE64URL(SHA256(verifier))."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/login")
async def login(request: Request):
    """Start the Spotify PKCE login flow."""
    settings = get_settings()

    if not settings.spotify_client_id:
        raise HTTPException(status_code=500, detail="SPOTIFY_CLIENT_ID not set")

    verifier = _generate_code_verifier()
    challenge = _generate_code_challenge(verifier)

    # Store verifier in session so /callback can use it.
    request.session["code_verifier"] = verifier

    params = {
        "client_id": settings.spotify_client_id,
        "response_type": "code",
        "redirect_uri": f"{settings.base_url}/callback",
        "scope": _SCOPES,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
    }
    return RedirectResponse(f"{_SPOTIFY_AUTH_URL}?{urlencode(params)}")


@router.get("/callback")
async def callback(request: Request, code: str | None = None, error: str | None = None):
    """Handle Spotify's redirect after user authorizes."""
    if error:
        raise HTTPException(status_code=400, detail=f"Spotify auth error: {error}")
    if not code:
        raise HTTPException(status_code=400, detail="Missing authorization code")

    settings = get_settings()
    verifier = request.session.pop("code_verifier", None)
    if not verifier:
        raise HTTPException(status_code=400, detail="Missing code_verifier — restart login")

    # Exchange authorization code for tokens.
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            _SPOTIFY_TOKEN_URL,
            data={
                "client_id": settings.spotify_client_id,
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": f"{settings.base_url}/callback",
                "code_verifier": verifier,
            },
        )

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Spotify token exchange failed ({resp.status_code}): {resp.text}",
        )

    token_data = resp.json()
    # Annotate with an absolute expiry timestamp for easy refresh checks.
    token_data["expires_at"] = int(time.time()) + token_data.get("expires_in", 3600)

    # Fetch user profile.
    async with httpx.AsyncClient() as client:
        me_resp = await client.get(
            _SPOTIFY_ME_URL,
            headers={"Authorization": f"Bearer {token_data['access_token']}"},
        )

    if me_resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch Spotify profile")

    me = me_resp.json()
    spotify_user_id = me["id"]
    display_name = me.get("display_name", "")

    # Upsert user + tokens into DB.
    db = get_db()
    await db.execute(
        """
        INSERT INTO users (spotify_user_id, display_name, token_data)
        VALUES (?, ?, ?)
        ON CONFLICT(spotify_user_id)
        DO UPDATE SET display_name = excluded.display_name,
                      token_data   = excluded.token_data,
                      updated_at   = datetime('now')
        """,
        (spotify_user_id, display_name, json.dumps(token_data)),
    )
    await db.commit()

    # Set session cookie.
    request.session["spotify_user_id"] = spotify_user_id

    return RedirectResponse("/playlists", status_code=303)


@router.get("/logout")
async def logout(request: Request):
    """Clear session and redirect to home."""
    request.session.clear()
    return RedirectResponse("/")


# ---------------------------------------------------------------------------
# Token helpers (used by other modules)
# ---------------------------------------------------------------------------

async def get_valid_token(spotify_user_id: str) -> str:
    """Return a valid access token, refreshing if expired.

    Raises ``HTTPException(401)`` if no token data found or refresh fails.
    """
    db = get_db()
    cursor = await db.execute(
        "SELECT token_data FROM users WHERE spotify_user_id = ?",
        (spotify_user_id,),
    )
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="User not found — please /login")

    token_data: dict = json.loads(row[0])

    # Check expiry (with 60s buffer).
    if token_data.get("expires_at", 0) < time.time() + 60:
        token_data = await _refresh_token(spotify_user_id, token_data)

    return token_data["access_token"]


async def _refresh_token(spotify_user_id: str, token_data: dict) -> dict:
    """Use the refresh_token to get a new access_token."""
    settings = get_settings()
    refresh_token = token_data.get("refresh_token")
    if not refresh_token:
        raise HTTPException(status_code=401, detail="No refresh token — please /login")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            _SPOTIFY_TOKEN_URL,
            data={
                "client_id": settings.spotify_client_id,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Token refresh failed — please /login")

    new_data = resp.json()
    # Spotify may or may not return a new refresh_token.
    new_data.setdefault("refresh_token", refresh_token)
    new_data["expires_at"] = int(time.time()) + new_data.get("expires_in", 3600)

    # Persist updated tokens.
    db = get_db()
    await db.execute(
        "UPDATE users SET token_data = ?, updated_at = datetime('now') WHERE spotify_user_id = ?",
        (json.dumps(new_data), spotify_user_id),
    )
    await db.commit()

    return new_data
