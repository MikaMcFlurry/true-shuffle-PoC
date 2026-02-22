"""Spotify Web API client with retry, token refresh, and sequential locking.

All Player API calls go through an ``asyncio.Lock`` to ensure strictly
sequential execution — no parallel requests, as required by the SPEC.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

import httpx
from fastapi import HTTPException

from app.auth import get_valid_token

logger = logging.getLogger(__name__)

_BASE = "https://api.spotify.com/v1"

# Per-user locks keyed by spotify_user_id.
_locks: dict[str, asyncio.Lock] = {}


def _get_lock(user_id: str) -> asyncio.Lock:
    """Return (or create) the per-user sequential lock."""
    if user_id not in _locks:
        _locks[user_id] = asyncio.Lock()
    return _locks[user_id]


class SpotifyClient:
    """High-level async Spotify API client.

    Parameters
    ----------
    spotify_user_id:
        The Spotify user ID whose token is used for requests.
    """

    MAX_RETRIES = 3

    def __init__(self, spotify_user_id: str) -> None:
        self.user_id = spotify_user_id

    # ------------------------------------------------------------------
    # Core request helper
    # ------------------------------------------------------------------

    async def _request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        use_lock: bool = False,
    ) -> httpx.Response:
        """Send an authenticated request with retry/refresh logic.

        Parameters
        ----------
        use_lock:
            If True, acquire the per-user sequential lock before sending.
            Should be True for all Player API calls.
        """
        lock = _get_lock(self.user_id) if use_lock else None

        async def _do() -> httpx.Response:
            for attempt in range(1, self.MAX_RETRIES + 1):
                token = await get_valid_token(self.user_id)
                headers = {"Authorization": f"Bearer {token}"}

                async with httpx.AsyncClient() as client:
                    resp = await client.request(
                        method,
                        f"{_BASE}{path}",
                        headers=headers,
                        json=body,
                        params=params,
                    )

                # 429 — Rate limited
                if resp.status_code == 429:
                    retry_after = int(resp.headers.get("Retry-After", "2"))
                    logger.warning(
                        "429 Rate-limited (attempt %d/%d), retry after %ds",
                        attempt,
                        self.MAX_RETRIES,
                        retry_after,
                    )
                    await asyncio.sleep(retry_after)
                    continue

                # 401 — Token expired (already refreshed by get_valid_token,
                # but Spotify can be flaky).  Retry once.
                if resp.status_code == 401 and attempt == 1:
                    logger.warning("401 Unauthorized — retrying with fresh token")
                    continue

                # 502/503 — Spotify server hiccup
                if resp.status_code in (502, 503) and attempt < self.MAX_RETRIES:
                    logger.warning(
                        "%d from Spotify (attempt %d), retrying in 2s",
                        resp.status_code,
                        attempt,
                    )
                    await asyncio.sleep(2)
                    continue

                # 403 — Premium required / bad scope — don't retry
                if resp.status_code == 403:
                    raise HTTPException(
                        status_code=403,
                        detail=f"Spotify 403: {resp.text}. Premium or missing scope?",
                    )

                # 404 — Resource / device not found — don't retry
                if resp.status_code == 404:
                    raise HTTPException(
                        status_code=404,
                        detail=f"Spotify 404: {resp.text}",
                    )

                return resp

            # Exhausted retries
            raise HTTPException(
                status_code=502,
                detail=f"Spotify request failed after {self.MAX_RETRIES} retries",
            )

        if lock:
            async with lock:
                return await _do()
        return await _do()

    # ------------------------------------------------------------------
    # Playlist endpoints
    # ------------------------------------------------------------------

    async def get_playlists(self, limit: int = 50, offset: int = 0) -> dict:
        """GET /me/playlists — paginated list of user's playlists."""
        resp = await self._request(
            "GET", "/me/playlists", params={"limit": limit, "offset": offset}
        )
        return resp.json()

    async def get_all_playlists(self) -> list[dict]:
        """Fetch all playlists across pages."""
        items: list[dict] = []
        offset = 0
        while True:
            data = await self.get_playlists(limit=50, offset=offset)
            items.extend(data.get("items", []))
            if data.get("next") is None:
                break
            offset += 50
        return items

    async def get_playlist_tracks(
        self, playlist_id: str, limit: int = 100, offset: int = 0
    ) -> dict:
        """GET /playlists/{id}/tracks — paginated tracks."""
        resp = await self._request(
            "GET",
            f"/playlists/{playlist_id}/tracks",
            params={"limit": limit, "offset": offset},
        )
        return resp.json()

    async def get_all_playlist_tracks(self, playlist_id: str) -> list[dict]:
        """Fetch all tracks across pages."""
        items: list[dict] = []
        offset = 0
        while True:
            data = await self.get_playlist_tracks(playlist_id, limit=100, offset=offset)
            items.extend(data.get("items", []))
            if data.get("next") is None:
                break
            offset += 100
        return items

    async def create_playlist(
        self, name: str, *, public: bool = False, description: str = ""
    ) -> dict:
        """POST /users/{user_id}/playlists — create a new playlist."""
        resp = await self._request(
            "POST",
            f"/users/{self.user_id}/playlists",
            body={"name": name, "public": public, "description": description},
        )
        return resp.json()

    async def add_tracks_batch(self, playlist_id: str, uris: list[str]) -> None:
        """POST /playlists/{id}/tracks — add tracks in batches of 100."""
        for i in range(0, len(uris), 100):
            batch = uris[i : i + 100]
            await self._request(
                "POST",
                f"/playlists/{playlist_id}/tracks",
                body={"uris": batch},
            )

    # ------------------------------------------------------------------
    # Player endpoints (all use sequential lock)
    # ------------------------------------------------------------------

    async def get_devices(self) -> list[dict]:
        """GET /me/player/devices — list available devices."""
        resp = await self._request("GET", "/me/player/devices", use_lock=True)
        return resp.json().get("devices", [])

    async def get_current_playback(self) -> dict | None:
        """GET /me/player — current playback state."""
        resp = await self._request("GET", "/me/player", use_lock=True)
        if resp.status_code == 204:
            return None
        return resp.json()

    async def play(
        self,
        uris: Optional[list[str]] = None,
        *,
        device_id: Optional[str] = None,
    ) -> None:
        """PUT /me/player/play — hard-override: start specific track(s).

        This is the **core of the hard-override strategy**: call this
        before any queued track can start playing.
        """
        body: dict[str, Any] = {}
        if uris:
            body["uris"] = uris
        params: dict[str, Any] = {}
        if device_id:
            params["device_id"] = device_id

        await self._request(
            "PUT", "/me/player/play", body=body or None, params=params or None, use_lock=True
        )

    async def queue(self, uri: str, *, device_id: Optional[str] = None) -> None:
        """POST /me/player/queue — add a track to the queue."""
        params: dict[str, Any] = {"uri": uri}
        if device_id:
            params["device_id"] = device_id

        await self._request("POST", "/me/player/queue", params=params, use_lock=True)

    async def pause(self, *, device_id: Optional[str] = None) -> None:
        """PUT /me/player/pause — pause playback (prevent autoplay at run end)."""
        params: dict[str, Any] = {}
        if device_id:
            params["device_id"] = device_id

        await self._request("PUT", "/me/player/pause", params=params or None, use_lock=True)
