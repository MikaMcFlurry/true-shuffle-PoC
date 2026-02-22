"""Controller Mode routes: real-time playback control with hard-override.

Core strategy:
1. Shuffle playlist once → persist order + cursor in ``runs``.
2. Pre-fill the Spotify queue with *QUEUE_BUFFER_SIZE* upcoming tracks.
3. On each "advance" call, do a **hard-override** (``PUT /play``) to jump
   to the correct next track, then re-fill the queue buffer.
4. Persist cursor after every advance so the run can be resumed.
"""

from __future__ import annotations

import json
from typing import List

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from app.config import get_settings
from app.db import get_db
from app.routes_utility import _get_user_id, _parse_tracks
from app.spotify_client import SpotifyClient
from core.models import Track
from core.shuffle import prepare_shuffled_run

router = APIRouter(prefix="/controller", tags=["controller"])
templates = Jinja2Templates(directory="app/templates")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_or_create_run(
    user_db_id: int,
    playlist_id: str,
    shuffled_uris: List[str],
) -> dict:
    """Get active run or create a new one.  Returns row as dict."""
    db = get_db()
    cursor = await db.execute(
        """
        SELECT id, shuffled_order, cursor, status
        FROM runs
        WHERE user_id = ? AND playlist_id = ? AND mode = 'controller' AND status = 'active'
        ORDER BY created_at DESC LIMIT 1
        """,
        (user_db_id, playlist_id),
    )
    row = await cursor.fetchone()
    if row:
        return {
            "run_id": row[0],
            "shuffled_order": json.loads(row[1]),
            "cursor": row[2],
            "status": row[3],
        }

    # Create new run
    cursor = await db.execute(
        """
        INSERT INTO runs (user_id, playlist_id, mode, shuffled_order, cursor, status)
        VALUES (?, ?, 'controller', ?, 0, 'active')
        """,
        (user_db_id, playlist_id, json.dumps(shuffled_uris)),
    )
    await db.commit()
    return {
        "run_id": cursor.lastrowid,
        "shuffled_order": shuffled_uris,
        "cursor": 0,
        "status": "active",
    }


async def _persist_cursor(run_id: int, cursor: int) -> None:
    """Update cursor position in the DB."""
    db = get_db()
    await db.execute(
        "UPDATE runs SET cursor = ?, updated_at = datetime('now') WHERE id = ?",
        (cursor, run_id),
    )
    await db.commit()


async def _complete_run(run_id: int) -> None:
    """Mark run as completed."""
    db = get_db()
    await db.execute(
        "UPDATE runs SET status = 'completed', updated_at = datetime('now') WHERE id = ?",
        (run_id,),
    )
    await db.commit()


async def _persist_skipped(run_id: int, skipped: List[Track]) -> None:
    """Insert skipped tracks into skipped_tracks table."""
    if not skipped:
        return
    db = get_db()
    for t in skipped:
        reason = "local" if t.is_local else ("episode" if t.track_type != "track" else "unavailable")
        await db.execute(
            "INSERT INTO skipped_tracks (run_id, track_uri, reason) VALUES (?, ?, ?)",
            (run_id, t.uri, reason),
        )
    await db.commit()


async def _fill_queue(
    client: SpotifyClient,
    shuffled_order: List[str],
    cursor: int,
    buffer_size: int,
    device_id: str | None = None,
) -> int:
    """Pre-fill the Spotify queue with upcoming tracks.

    Returns the number of tracks actually queued.
    """
    queued = 0
    for i in range(cursor + 1, min(cursor + 1 + buffer_size, len(shuffled_order))):
        try:
            await client.queue(shuffled_order[i], device_id=device_id)
            queued += 1
        except HTTPException:
            pass  # Track might be unavailable — skip silently
    return queued


# ---------------------------------------------------------------------------
# /controller/start  — start or resume a controller run
# ---------------------------------------------------------------------------

@router.post("/start", response_class=HTMLResponse)
async def controller_start(request: Request):
    """Start (or resume) a Controller Mode run for a playlist."""
    user_id = _get_user_id(request)
    form = await request.form()
    playlist_id = form.get("playlist_id", "")
    playlist_name = form.get("playlist_name", "Playlist")

    if not playlist_id:
        raise HTTPException(status_code=400, detail="playlist_id is required")

    client = SpotifyClient(user_id)
    settings = get_settings()

    # Resolve user DB id
    db = get_db()
    cursor = await db.execute(
        "SELECT id FROM users WHERE spotify_user_id = ?", (user_id,)
    )
    user_row = await cursor.fetchone()
    if not user_row:
        raise HTTPException(status_code=401, detail="User not found in DB")
    user_db_id = user_row[0]

    # Fetch tracks & shuffle (or resume existing run)
    raw_items = await client.get_all_playlist_tracks(str(playlist_id))
    tracks = _parse_tracks(raw_items)

    if not tracks:
        raise HTTPException(status_code=400, detail="Playlist has no tracks")

    shuffled_uris, skipped = prepare_shuffled_run(tracks)

    if not shuffled_uris:
        raise HTTPException(status_code=400, detail="No playable tracks after filtering")

    run = await _get_or_create_run(user_db_id, str(playlist_id), shuffled_uris)
    run_id = run["run_id"]
    shuffled_order = run["shuffled_order"]
    pos = run["cursor"]

    # Persist skipped tracks
    await _persist_skipped(run_id, skipped)

    # Get available devices
    devices = await client.get_devices()
    active_device = None
    for d in devices:
        if d.get("is_active"):
            active_device = d
            break
    if not active_device and devices:
        active_device = devices[0]

    device_id = active_device["id"] if active_device else None

    # Hard-override: play the current track
    if pos < len(shuffled_order):
        await client.play(uris=[shuffled_order[pos]], device_id=device_id)
        # Fill queue buffer
        await _fill_queue(
            client, shuffled_order, pos, settings.queue_buffer_size, device_id
        )

    return templates.TemplateResponse(
        request,
        "controller.html",
        {
            "run_id": run_id,
            "playlist_name": playlist_name,
            "playlist_id": playlist_id,
            "shuffled_order": shuffled_order,
            "cursor": pos,
            "total_tracks": len(shuffled_order),
            "skipped_count": len(skipped),
            "devices": devices,
            "active_device": active_device,
            "current_track_uri": shuffled_order[pos] if pos < len(shuffled_order) else None,
        },
    )


# ---------------------------------------------------------------------------
# /controller/next  — advance to next track (JSON API for JS)
# ---------------------------------------------------------------------------

@router.post("/next")
async def controller_next(request: Request):
    """Advance cursor, hard-override to next track, refill queue."""
    user_id = _get_user_id(request)
    body = await request.json()
    run_id = body.get("run_id")
    device_id = body.get("device_id")

    if not run_id:
        raise HTTPException(status_code=400, detail="run_id is required")

    db = get_db()
    cursor = await db.execute(
        "SELECT shuffled_order, cursor FROM runs WHERE id = ? AND status = 'active'",
        (run_id,),
    )
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Run not found or not active")

    shuffled_order = json.loads(row[0])
    pos = row[1] + 1  # advance

    if pos >= len(shuffled_order):
        await _complete_run(run_id)
        return JSONResponse({"status": "completed", "cursor": pos})

    await _persist_cursor(run_id, pos)

    client = SpotifyClient(user_id)
    settings = get_settings()

    # Hard-override: play the next track
    await client.play(uris=[shuffled_order[pos]], device_id=device_id)

    # Refill queue
    await _fill_queue(
        client, shuffled_order, pos, settings.queue_buffer_size, device_id
    )

    return JSONResponse({
        "status": "playing",
        "cursor": pos,
        "total": len(shuffled_order),
        "current_uri": shuffled_order[pos],
    })


# ---------------------------------------------------------------------------
# /controller/stop  — stop/cancel a run
# ---------------------------------------------------------------------------

@router.post("/stop")
async def controller_stop(request: Request):
    """Pause playback and mark run as cancelled (can be resumed with /start)."""
    user_id = _get_user_id(request)
    body = await request.json()
    run_id = body.get("run_id")
    device_id = body.get("device_id")

    if not run_id:
        raise HTTPException(status_code=400, detail="run_id is required")

    client = SpotifyClient(user_id)
    try:
        await client.pause(device_id=device_id)
    except HTTPException:
        pass  # Device might already be paused or gone

    db = get_db()
    await db.execute(
        "UPDATE runs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?",
        (run_id,),
    )
    await db.commit()

    return JSONResponse({"status": "stopped"})
