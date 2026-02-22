"""Resilient Spotify Web API HTTP client wrapper.

Features:
  - 429 Retry-After with jitter
  - Exponential backoff on 5xx
  - Auto-refresh on 401
  - Configurable timeouts & limited retries
  - Minimal logging
"""

from __future__ import annotations

import asyncio
import logging
import random
import time

import httpx

from app.config import get_settings
from app.db import get_db

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_MAX_RETRIES = 3
_CONNECT_TIMEOUT = 10.0  # seconds
_READ_TIMEOUT = 30.0
_BACKOFF_BASE = 0.5  # seconds
_BACKOFF_CAP = 30.0  # seconds
_JITTER_MAX = 0.5  # seconds

_SPOTIFY_API = "https://api.spotify.com"
_SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class SpotifyAPIError(Exception):
    """Raised when a Spotify API request fails after all retries."""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"Spotify API error {status_code}: {detail}")


# ---------------------------------------------------------------------------
# Token helpers (DB-backed)
# ---------------------------------------------------------------------------

async def _load_tokens(user_id: str) -> dict:
    """Read token row from the ``tokens`` table."""
    db = get_db()
    cursor = await db.execute(
        "SELECT access_token, refresh_token, expires_at FROM tokens WHERE user_id = ?",
        (user_id,),
    )
    row = await cursor.fetchone()
    if not row:
        raise SpotifyAPIError(401, "No tokens found — please /login")
    return {
        "access_token": row[0],
        "refresh_token": row[1],
        "expires_at": row[2],
    }


async def _persist_tokens(
    user_id: str,
    access_token: str,
    refresh_token: str,
    expires_at: int,
) -> None:
    """Upsert tokens into the ``tokens`` table."""
    db = get_db()
    await db.execute(
        """
        INSERT INTO tokens (user_id, access_token, refresh_token, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id)
        DO UPDATE SET access_token  = excluded.access_token,
                      refresh_token = excluded.refresh_token,
                      expires_at    = excluded.expires_at,
                      updated_at    = datetime('now')
        """,
        (user_id, access_token, refresh_token, expires_at),
    )
    await db.commit()


async def _refresh_access_token(user_id: str, refresh_token: str) -> dict:
    """Exchange a refresh token for a new access token (PKCE, no secret)."""
    settings = get_settings()
    async with httpx.AsyncClient(timeout=_CONNECT_TIMEOUT) as client:
        resp = await client.post(
            _SPOTIFY_TOKEN_URL,
            data={
                "client_id": settings.spotify_client_id,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
        )

    if resp.status_code != 200:
        logger.warning("Token refresh failed (%s): %s", resp.status_code, resp.text)
        raise SpotifyAPIError(401, "Token refresh failed — please /login")

    data = resp.json()
    new_refresh = data.get("refresh_token", refresh_token)
    expires_at = int(time.time()) + data.get("expires_in", 3600)

    await _persist_tokens(user_id, data["access_token"], new_refresh, expires_at)
    logger.info("Refreshed access token for user %s", user_id)
    return {
        "access_token": data["access_token"],
        "refresh_token": new_refresh,
        "expires_at": expires_at,
    }


async def _get_access_token(user_id: str) -> str:
    """Return a valid access token, proactively refreshing if within 60s of expiry."""
    tokens = await _load_tokens(user_id)
    if tokens["expires_at"] < time.time() + 60:
        tokens = await _refresh_access_token(user_id, tokens["refresh_token"])
    return tokens["access_token"]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def spotify_request(
    method: str,
    path: str,
    user_id: str,
    *,
    base_url: str = _SPOTIFY_API,
    **kwargs,
) -> httpx.Response:
    """Make an authenticated Spotify API request with retry logic.

    Parameters
    ----------
    method : str
        HTTP method (GET, POST, PUT, DELETE, …).
    path : str
        API path, e.g. ``/v1/me`` or ``/v1/playlists/{id}/tracks``.
    user_id : str
        Spotify user ID — used to look up tokens.
    base_url : str
        Override for tests. Defaults to ``https://api.spotify.com``.
    **kwargs
        Forwarded to ``httpx.AsyncClient.request`` (json, params, …).

    Returns
    -------
    httpx.Response
        The successful response (2xx).

    Raises
    ------
    SpotifyAPIError
        After exhausting retries or unrecoverable errors.
    """
    url = f"{base_url}{path}"
    refreshed_on_401 = False

    timeout = httpx.Timeout(_READ_TIMEOUT, connect=_CONNECT_TIMEOUT)

    for attempt in range(_MAX_RETRIES):
        access_token = await _get_access_token(user_id)
        headers = kwargs.pop("headers", {})
        headers["Authorization"] = f"Bearer {access_token}"

        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                resp = await client.request(method, url, headers=headers, **kwargs)
            except httpx.TimeoutException:
                logger.warning("Timeout on attempt %d for %s %s", attempt + 1, method, path)
                await _backoff_sleep(attempt)
                continue

        # ── Success ─────────────────────────────────────────────
        if resp.status_code < 400:
            return resp

        # ── 401 → refresh once ──────────────────────────────────
        if resp.status_code == 401 and not refreshed_on_401:
            logger.info("401 on %s %s — refreshing token", method, path)
            tokens = await _load_tokens(user_id)
            await _refresh_access_token(user_id, tokens["refresh_token"])
            refreshed_on_401 = True
            continue  # retry immediately, don't count as backoff attempt

        # ── 429 → Retry-After ───────────────────────────────────
        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", "1"))
            jitter = random.uniform(0, _JITTER_MAX)
            wait = retry_after + jitter
            logger.warning("429 on %s %s — waiting %.1fs", method, path, wait)
            await asyncio.sleep(wait)
            continue

        # ── 5xx → exponential backoff ───────────────────────────
        if resp.status_code >= 500:
            logger.warning("Server error %d on %s %s (attempt %d)", resp.status_code, method, path, attempt + 1)
            await _backoff_sleep(attempt)
            continue

        # ── 4xx (other) → fail immediately ──────────────────────
        raise SpotifyAPIError(resp.status_code, resp.text)

    raise SpotifyAPIError(
        resp.status_code if "resp" in dir() else 0,
        f"Max retries ({_MAX_RETRIES}) exhausted for {method} {path}",
    )


async def _backoff_sleep(attempt: int) -> None:
    """Exponential backoff with jitter, capped at ``_BACKOFF_CAP``."""
    delay = min(_BACKOFF_BASE * (2 ** attempt) + random.uniform(0, _JITTER_MAX), _BACKOFF_CAP)
    logger.debug("Backoff sleep %.2fs (attempt %d)", delay, attempt + 1)
    await asyncio.sleep(delay)
