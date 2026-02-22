"""Controller Mode — queue-buffer playback with hard override.

Manages playback state, queue buffer, polling, and track-change detection.
All Spotify Player API calls go through ``spotify_client`` (locked, sequential).
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from enum import Enum
from typing import Any

from app.config import get_settings
from app.db import get_db
from app.spotify_client import SpotifyPremiumRequired, sp_get, sp_post, sp_put

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Controller states
# ---------------------------------------------------------------------------

class ControllerState(str, Enum):
    IDLE = "idle"
    STARTING = "starting"
    NO_DEVICE = "no_device"
    PLAYING = "playing"
    OVERRIDING = "overriding"
    ADVANCING = "advancing"
    COMPLETED = "completed"
    ERROR = "error"


# ---------------------------------------------------------------------------
# In-memory session store (one per user+playlist)
# ---------------------------------------------------------------------------

class ControllerSession:
    """In-memory runtime state for an active controller run."""

    __slots__ = (
        "run_id",
        "user_id",
        "spotify_user_id",
        "playlist_id",
        "order",
        "cursor",
        "queued_until_index",
        "state",
        "device_id",
        "error_message",
        "poll_task",
        "current_track_name",
        "current_artist",
        "current_album_art",
    )

    def __init__(
        self,
        *,
        run_id: int,
        user_id: int,
        spotify_user_id: str,
        playlist_id: str,
        order: list[str],
        cursor: int = 0,
        queued_until_index: int = 0,
    ):
        self.run_id = run_id
        self.user_id = user_id
        self.spotify_user_id = spotify_user_id
        self.playlist_id = playlist_id
        self.order = order
        self.cursor = cursor
        self.queued_until_index = queued_until_index
        self.state = ControllerState.IDLE
        self.device_id: str | None = None
        self.error_message: str | None = None
        self.poll_task: asyncio.Task | None = None
        self.current_track_name: str | None = None
        self.current_artist: str | None = None
        self.current_album_art: str | None = None

    def to_status_dict(self) -> dict[str, Any]:
        """Serialize for the status API."""
        return {
            "state": self.state.value,
            "cursor": self.cursor,
            "total_tracks": len(self.order),
            "current_track_uri": self.order[self.cursor] if self.cursor < len(self.order) else None,
            "current_track_name": self.current_track_name,
            "current_artist": self.current_artist,
            "current_album_art": self.current_album_art,
            "error_message": self.error_message,
            "device_id": self.device_id,
        }


# Key: (spotify_user_id, playlist_id) → ControllerSession
_sessions: dict[tuple[str, str], ControllerSession] = {}


def get_session(spotify_user_id: str, playlist_id: str) -> ControllerSession | None:
    return _sessions.get((spotify_user_id, playlist_id))


# ---------------------------------------------------------------------------
# Playlist fetching (paginated)
# ---------------------------------------------------------------------------

async def _fetch_playlist_tracks(spotify_user_id: str, playlist_id: str) -> list[str]:
    """Fetch all track URIs from a Spotify playlist (paginated)."""
    uris: list[str] = []
    offset = 0
    limit = 100
    while True:
        resp = await sp_get(
            f"/playlists/{playlist_id}/tracks",
            spotify_user_id,
            params={"offset": offset, "limit": limit, "fields": "items(track(uri,type,is_local)),next"},
        )
        if resp.status_code != 200:
            logger.error("Failed to fetch playlist tracks: %d", resp.status_code)
            break
        data = resp.json()
        for item in data.get("items", []):
            track = item.get("track")
            if not track:
                continue
            # Skip local files and episodes
            if track.get("is_local", False):
                continue
            if track.get("type") != "track":
                continue
            uri = track.get("uri")
            if uri:
                uris.append(uri)
        if not data.get("next"):
            break
        offset += limit
    return uris


# ---------------------------------------------------------------------------
# Shuffle (Fisher-Yates)
# ---------------------------------------------------------------------------

def _shuffle_order(uris: list[str]) -> list[str]:
    """Return a new list shuffled via Fisher-Yates (unbiased)."""
    shuffled = uris.copy()
    for i in range(len(shuffled) - 1, 0, -1):
        j = random.randint(0, i)
        shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
    # Dedup (keep first occurrence)
    seen: set[str] = set()
    deduped: list[str] = []
    for uri in shuffled:
        if uri not in seen:
            seen.add(uri)
            deduped.append(uri)
    return deduped


# ---------------------------------------------------------------------------
# Run creation / resume
# ---------------------------------------------------------------------------

async def create_or_resume_run(
    spotify_user_id: str, playlist_id: str
) -> ControllerSession:
    """Find an active controller run or create a new one."""
    db = get_db()

    # Look up internal user id.
    cur = await db.execute(
        "SELECT id FROM users WHERE spotify_user_id = ?", (spotify_user_id,)
    )
    user_row = await cur.fetchone()
    if not user_row:
        raise ValueError("User not found in DB")
    user_id: int = user_row[0]

    # Check for existing active run.
    cur = await db.execute(
        """SELECT id, shuffled_order, cursor, queued_until_index
           FROM runs
           WHERE user_id = ? AND playlist_id = ? AND mode = 'controller' AND status = 'active'
           ORDER BY id DESC LIMIT 1""",
        (user_id, playlist_id),
    )
    row = await cur.fetchone()

    if row:
        run_id, order_json, cursor, queued_until = row
        order = json.loads(order_json)
        logger.info("Resuming run %d at cursor %d", run_id, cursor)
    else:
        # Create new run.
        track_uris = await _fetch_playlist_tracks(spotify_user_id, playlist_id)
        if not track_uris:
            raise ValueError("Playlist is empty or inaccessible")

        order = _shuffle_order(track_uris)
        cursor = 0
        queued_until = 0
        order_json = json.dumps(order)

        cur = await db.execute(
            """INSERT INTO runs (user_id, playlist_id, mode, shuffled_order, cursor, queued_until_index)
               VALUES (?, ?, 'controller', ?, 0, 0)""",
            (user_id, playlist_id, order_json),
        )
        await db.commit()
        run_id = cur.lastrowid
        logger.info("Created new run %d with %d tracks", run_id, len(order))

    session = ControllerSession(
        run_id=run_id,
        user_id=user_id,
        spotify_user_id=spotify_user_id,
        playlist_id=playlist_id,
        order=order,
        cursor=cursor,
        queued_until_index=queued_until,
    )
    _sessions[(spotify_user_id, playlist_id)] = session
    return session


# ---------------------------------------------------------------------------
# Device discovery
# ---------------------------------------------------------------------------

async def get_devices(spotify_user_id: str) -> list[dict]:
    """Return list of available Spotify devices."""
    resp = await sp_get("/me/player/devices", spotify_user_id)
    if resp.status_code != 200:
        return []
    return resp.json().get("devices", [])


async def _find_active_device(spotify_user_id: str) -> str | None:
    """Return the device_id of the first active device, or None."""
    devices = await get_devices(spotify_user_id)
    for d in devices:
        if d.get("is_active"):
            return d["id"]
    # If none active, return first available
    if devices:
        return devices[0]["id"]
    return None


# ---------------------------------------------------------------------------
# Playback control
# ---------------------------------------------------------------------------

async def _persist_cursor(session: ControllerSession) -> None:
    """Persist cursor and queued_until_index to DB."""
    db = get_db()
    await db.execute(
        """UPDATE runs SET cursor = ?, queued_until_index = ?, updated_at = datetime('now')
           WHERE id = ?""",
        (session.cursor, session.queued_until_index, session.run_id),
    )
    await db.commit()


async def _fill_buffer(session: ControllerSession) -> None:
    """Queue tracks from cursor+1 up to cursor+N (sequential, locked)."""
    settings = get_settings()
    buffer_size = settings.queue_buffer_size
    end_index = min(session.cursor + buffer_size, len(session.order) - 1)

    start_from = max(session.queued_until_index, session.cursor) + 1

    for i in range(start_from, end_index + 1):
        uri = session.order[i]
        logger.debug("Queuing track %d: %s", i, uri)
        resp = await sp_post(
            "/me/player/queue",
            session.spotify_user_id,
            json_body={"uri": uri},
        )
        if resp.status_code not in (200, 204):
            logger.warning("Queue POST failed for index %d: %d", i, resp.status_code)
            break
        session.queued_until_index = i

    await _persist_cursor(session)


async def start_playback(session: ControllerSession) -> None:
    """Start playback on order[cursor] and fill the queue buffer."""
    session.state = ControllerState.STARTING

    # Find a device.
    device_id = await _find_active_device(session.spotify_user_id)
    if not device_id:
        session.state = ControllerState.NO_DEVICE
        session.error_message = (
            "Kein aktives Spotify-Gerät gefunden. "
            "Öffne Spotify und drücke Play, dann klicke hier erneut."
        )
        return

    session.device_id = device_id
    session.error_message = None

    if session.cursor >= len(session.order):
        session.state = ControllerState.COMPLETED
        return

    # Hard play the current track.
    track_uri = session.order[session.cursor]
    try:
        resp = await sp_put(
            "/me/player/play",
            session.spotify_user_id,
            json_body={"uris": [track_uri], "position_ms": 0},
        )
    except SpotifyPremiumRequired as exc:
        session.state = ControllerState.ERROR
        session.error_message = str(exc)
        return

    if resp.status_code not in (200, 204):
        session.state = ControllerState.ERROR
        session.error_message = f"PUT /play failed: {resp.status_code}"
        return

    session.queued_until_index = session.cursor
    await _fill_buffer(session)
    session.state = ControllerState.PLAYING

    # Start polling.
    _start_polling(session)


def _start_polling(session: ControllerSession) -> None:
    """Start the background polling task."""
    if session.poll_task and not session.poll_task.done():
        session.poll_task.cancel()
    session.poll_task = asyncio.create_task(_poll_loop(session))


async def _poll_loop(session: ControllerSession) -> None:
    """Poll Spotify playback state every ~3 seconds."""
    while session.state == ControllerState.PLAYING:
        try:
            await asyncio.sleep(3)
            await _poll_playback(session)
        except asyncio.CancelledError:
            logger.info("Polling cancelled for run %d", session.run_id)
            return
        except SpotifyPremiumRequired as exc:
            session.state = ControllerState.ERROR
            session.error_message = str(exc)
            return
        except Exception:
            logger.exception("Poll error for run %d", session.run_id)
            # Continue polling — transient errors shouldn't stop us.
            await asyncio.sleep(3)


async def _poll_playback(session: ControllerSession) -> None:
    """Single poll cycle: detect track changes, skips, and deviations."""
    if session.cursor >= len(session.order):
        session.state = ControllerState.COMPLETED
        return

    resp = await sp_get("/me/player", session.spotify_user_id)

    if resp.status_code == 204 or resp.status_code != 200:
        # No active playback — nothing to do, keep polling.
        return

    data = resp.json()
    item = data.get("item")
    if not item:
        return

    current_uri = item.get("uri", "")
    is_playing = data.get("is_playing", False)

    # Update display info.
    session.current_track_name = item.get("name", "")
    artists = item.get("artists", [])
    session.current_artist = ", ".join(a.get("name", "") for a in artists)
    album = item.get("album", {})
    images = album.get("images", [])
    session.current_album_art = images[0]["url"] if images else None

    if not is_playing:
        return

    expected_uri = session.order[session.cursor]

    if current_uri == expected_uri:
        # All good — still playing the expected track.
        return

    # Check if it's the next expected track (natural advance / skip).
    next_cursor = session.cursor + 1
    if next_cursor < len(session.order) and current_uri == session.order[next_cursor]:
        # Natural advance or skip.
        logger.info("Track advanced: cursor %d → %d", session.cursor, next_cursor)
        session.state = ControllerState.ADVANCING
        session.cursor = next_cursor
        await _fill_buffer(session)
        session.state = ControllerState.PLAYING

        if session.cursor >= len(session.order) - 1:
            # Check if we've reached the end and this is the last track.
            pass

        return

    # Check if it's any upcoming queued track (multi-skip).
    for offset in range(2, 6):
        check_cursor = session.cursor + offset
        if check_cursor < len(session.order) and current_uri == session.order[check_cursor]:
            logger.info("Multi-skip detected: cursor %d → %d", session.cursor, check_cursor)
            session.cursor = check_cursor
            await _fill_buffer(session)
            session.state = ControllerState.PLAYING
            return

    # Foreign track detected → hard override.
    logger.warning(
        "Foreign track detected! Expected %s, got %s — overriding",
        expected_uri,
        current_uri,
    )
    await _hard_override(session)


async def _hard_override(session: ControllerSession) -> None:
    """Force playback back to order[cursor] and refill buffer."""
    session.state = ControllerState.OVERRIDING

    if session.cursor >= len(session.order):
        session.state = ControllerState.COMPLETED
        return

    track_uri = session.order[session.cursor]
    body: dict[str, Any] = {"uris": [track_uri], "position_ms": 0}
    if session.device_id:
        body["device_id"] = session.device_id  # type: ignore[assignment]

    try:
        resp = await sp_put(
            "/me/player/play",
            session.spotify_user_id,
            json_body=body,
        )
    except SpotifyPremiumRequired as exc:
        session.state = ControllerState.ERROR
        session.error_message = str(exc)
        return

    if resp.status_code not in (200, 204):
        logger.error("Hard override PUT /play failed: %d", resp.status_code)
        session.state = ControllerState.ERROR
        session.error_message = f"Override failed: {resp.status_code}"
        return

    # Reset buffer — everything after cursor needs re-queuing.
    session.queued_until_index = session.cursor
    await _fill_buffer(session)
    session.state = ControllerState.PLAYING


# ---------------------------------------------------------------------------
# User actions
# ---------------------------------------------------------------------------

async def manual_next(session: ControllerSession) -> None:
    """User clicks Next — advance cursor, hard play next track, refill."""
    if session.cursor + 1 >= len(session.order):
        session.state = ControllerState.COMPLETED
        await _persist_cursor(session)
        return

    session.cursor += 1
    logger.info("Manual next → cursor %d", session.cursor)

    # Hard play the new track.
    track_uri = session.order[session.cursor]
    try:
        body: dict[str, Any] = {"uris": [track_uri], "position_ms": 0}
        resp = await sp_put(
            "/me/player/play",
            session.spotify_user_id,
            json_body=body,
        )
    except SpotifyPremiumRequired as exc:
        session.state = ControllerState.ERROR
        session.error_message = str(exc)
        return

    if resp.status_code not in (200, 204):
        session.state = ControllerState.ERROR
        session.error_message = f"PUT /play failed on next: {resp.status_code}"
        return

    session.queued_until_index = session.cursor
    await _fill_buffer(session)
    session.state = ControllerState.PLAYING

    if not session.poll_task or session.poll_task.done():
        _start_polling(session)


async def stop_controller(session: ControllerSession) -> None:
    """Stop polling — playback continues but controller stops watching."""
    if session.poll_task and not session.poll_task.done():
        session.poll_task.cancel()
        try:
            await session.poll_task
        except asyncio.CancelledError:
            pass
    session.poll_task = None
    session.state = ControllerState.IDLE
    await _persist_cursor(session)
    logger.info("Controller stopped for run %d at cursor %d", session.run_id, session.cursor)


async def refresh_shuffle(spotify_user_id: str, playlist_id: str) -> ControllerSession:
    """Cancel current run and create a new one with fresh shuffle order."""
    # Stop existing session if any.
    existing = get_session(spotify_user_id, playlist_id)
    if existing:
        await stop_controller(existing)
        # Mark old run as cancelled.
        db = get_db()
        await db.execute(
            "UPDATE runs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?",
            (existing.run_id,),
        )
        await db.commit()

    # Remove from sessions dict.
    _sessions.pop((spotify_user_id, playlist_id), None)

    # Create new run.
    return await create_or_resume_run(spotify_user_id, playlist_id)
