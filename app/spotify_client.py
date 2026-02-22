"""Shared async Spotify Web API client with retry and error handling.

All player-related calls are serialized through a per-user asyncio.Lock
to prevent 429 rate-limit errors and race conditions.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
from fastapi import HTTPException

from app.auth import get_valid_token

logger = logging.getLogger(__name__)

_BASE = "https://api.spotify.com/v1"

# Per-user locks for sequential player API calls.
_player_locks: dict[str, asyncio.Lock] = {}


class SpotifyPremiumRequired(Exception):
    """Raised when Spotify returns 403 — account lacks Premium."""

    pass


def _get_lock(user_id: str) -> asyncio.Lock:
    """Return (or create) the asyncio.Lock for a given user."""
    if user_id not in _player_locks:
        _player_locks[user_id] = asyncio.Lock()
    return _player_locks[user_id]


async def _request(
    method: str,
    path: str,
    spotify_user_id: str,
    *,
    json_body: dict | None = None,
    params: dict | None = None,
    max_retries: int = 3,
) -> httpx.Response:
    """Make an authenticated Spotify API request with retry logic.

    - 429: retry after ``Retry-After`` header (up to *max_retries*).
    - 401: raise ``HTTPException(401)`` → triggers re-login.
    - 403: raise ``SpotifyPremiumRequired``.
    """
    lock = _get_lock(spotify_user_id)

    async with lock:
        for attempt in range(max_retries + 1):
            token = await get_valid_token(spotify_user_id)
            headers = {"Authorization": f"Bearer {token}"}

            async with httpx.AsyncClient() as client:
                resp = await client.request(
                    method,
                    f"{_BASE}{path}",
                    headers=headers,
                    json=json_body,
                    params=params,
                    timeout=10.0,
                )

            if resp.status_code == 429:
                retry_after = int(resp.headers.get("Retry-After", "2"))
                if attempt < max_retries:
                    logger.warning(
                        "Spotify 429 — retrying in %ds (attempt %d/%d)",
                        retry_after,
                        attempt + 1,
                        max_retries,
                    )
                    await asyncio.sleep(retry_after)
                    continue
                logger.error("Spotify 429 — max retries exhausted")
                raise HTTPException(status_code=429, detail="Spotify rate limit — try again later")

            if resp.status_code == 401:
                raise HTTPException(status_code=401, detail="Spotify token expired — please /login")

            if resp.status_code == 403:
                raise SpotifyPremiumRequired(
                    "Spotify Premium erforderlich für Controller Mode."
                )

            return resp

    # Should never reach here, but satisfy type checker.
    raise HTTPException(status_code=500, detail="Unexpected retry loop exit")  # pragma: no cover


# ---- Convenience wrappers ----


async def sp_get(
    path: str, spotify_user_id: str, *, params: dict | None = None
) -> httpx.Response:
    """Authenticated GET request to Spotify API."""
    return await _request("GET", path, spotify_user_id, params=params)


async def sp_put(
    path: str, spotify_user_id: str, *, json_body: dict | None = None
) -> httpx.Response:
    """Authenticated PUT request to Spotify API."""
    return await _request("PUT", path, spotify_user_id, json_body=json_body)


async def sp_post(
    path: str, spotify_user_id: str, *, json_body: dict | None = None
) -> httpx.Response:
    """Authenticated POST request to Spotify API."""
    return await _request("POST", path, spotify_user_id, json_body=json_body)
