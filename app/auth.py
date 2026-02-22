"""Spotify OAuth 2.0 with PKCE — no client secret needed.

Flow:
  1. GET /login        → redirect to Spotify /authorize with code_challenge
  2. GET /callback     → exchange code for tokens via /api/token
  3. Tokens stored in ``tokens`` table (dedicated columns)
  4. Session cookie holds ``spotify_user_id``
  5. GET /me           → fetch current user profile via Spotify API
"""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from base64 import urlsafe_b64encode
from typing import Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse

from app.config import get_settings
from app.db import get_db
from app.spotify_client import (
    SpotifyAPIError,
    _get_access_token,
    _persist_tokens,
    spotify_request,
)

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
    access_token = token_data["access_token"]
    refresh_token = token_data.get("refresh_token", "")
    expires_at = int(time.time()) + token_data.get("expires_in", 3600)

    # Fetch user profile to get spotify_user_id.
    async with httpx.AsyncClient() as client:
        me_resp = await client.get(
            _SPOTIFY_ME_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )

    if me_resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch Spotify profile")

    me = me_resp.json()
    spotify_user_id = me["id"]
    display_name = me.get("display_name", "")

    # Upsert user row (profile data).
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

    # Persist tokens in dedicated tokens table.
    await _persist_tokens(spotify_user_id, access_token, refresh_token, expires_at)

    # Set session cookie.
    request.session["spotify_user_id"] = spotify_user_id

    return RedirectResponse("/me", status_code=303)


@router.get("/me")
async def me(request: Request):
    """Return current user's Spotify profile."""
    spotify_user_id = request.session.get("spotify_user_id")
    if not spotify_user_id:
        raise HTTPException(status_code=401, detail="Not logged in — visit /login")

    try:
        resp = await spotify_request("GET", "/v1/me", spotify_user_id)
    except SpotifyAPIError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    profile = resp.json()
    return JSONResponse({
        "user_id": profile["id"],
        "display_name": profile.get("display_name", ""),
    })


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
    try:
        return await _get_access_token(spotify_user_id)
    except SpotifyAPIError as exc:
        raise HTTPException(status_code=401, detail=exc.detail)
