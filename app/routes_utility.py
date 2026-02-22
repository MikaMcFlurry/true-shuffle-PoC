"""Utility Mode routes: playlist listing and shuffled copy creation."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from app.db import get_db
from app.spotify_client import SpotifyClient
from core.models import Track
from core.shuffle import prepare_shuffled_run

router = APIRouter(tags=["utility"])
templates = Jinja2Templates(directory="app/templates")


def _get_user_id(request: Request) -> str:
    """Extract spotify_user_id from session or raise 401."""
    uid = request.session.get("spotify_user_id")
    if not uid:
        raise HTTPException(status_code=401, detail="Not logged in — please /login")
    return uid


def _parse_tracks(raw_items: list[dict]) -> list[Track]:
    """Convert Spotify API track items to Track models."""
    tracks: list[Track] = []
    for item in raw_items:
        t = item.get("track")
        if t is None:
            continue
        tracks.append(
            Track(
                uri=t.get("uri", ""),
                name=t.get("name", ""),
                artist=", ".join(a.get("name", "") for a in t.get("artists", [])),
                is_playable=t.get("is_playable", True),
                is_local=t.get("is_local", False),
                track_type=t.get("type", "track"),
            )
        )
    return tracks


# ---------------------------------------------------------------------------
# /playlists
# ---------------------------------------------------------------------------

@router.get("/playlists", response_class=HTMLResponse)
async def playlists_page(request: Request):
    """Show all playlists for the logged-in user."""
    user_id = _get_user_id(request)
    client = SpotifyClient(user_id)

    all_playlists = await client.get_all_playlists()

    return templates.TemplateResponse(
        request,
        "playlists.html",
        {
            "playlists": all_playlists,
            "user_id": user_id,
        },
    )


# ---------------------------------------------------------------------------
# /utility/create
# ---------------------------------------------------------------------------

@router.post("/utility/create", response_class=HTMLResponse)
async def utility_create(request: Request):
    """Create a shuffled copy of a playlist (Utility Mode)."""
    user_id = _get_user_id(request)
    form = await request.form()
    playlist_id = form.get("playlist_id", "")
    playlist_name = form.get("playlist_name", "Playlist")

    if not playlist_id:
        raise HTTPException(status_code=400, detail="playlist_id is required")

    client = SpotifyClient(user_id)

    # 1. Fetch all tracks
    raw_items = await client.get_all_playlist_tracks(str(playlist_id))
    tracks = _parse_tracks(raw_items)

    if not tracks:
        raise HTTPException(status_code=400, detail="Playlist has no tracks")

    # 2. Shuffle (filter + dedup + Fisher-Yates)
    shuffled_uris, skipped = prepare_shuffled_run(tracks)

    if not shuffled_uris:
        raise HTTPException(status_code=400, detail="No playable tracks after filtering")

    # 3. Create new playlist on Spotify
    new_name = f"🔀 {playlist_name} (true-shuffle)"
    new_playlist = await client.create_playlist(
        new_name,
        description="Created by true-shuffle PoC — unbiased Fisher-Yates shuffle",
    )
    new_playlist_id = new_playlist["id"]
    new_playlist_url = new_playlist.get("external_urls", {}).get("spotify", "")

    # 4. Add tracks in batches of 100
    await client.add_tracks_batch(new_playlist_id, shuffled_uris)

    # 5. Persist run to DB
    db = get_db()
    cursor = await db.execute(
        "SELECT id FROM users WHERE spotify_user_id = ?", (user_id,)
    )
    user_row = await cursor.fetchone()
    if user_row:
        await db.execute(
            """
            INSERT INTO runs (user_id, playlist_id, mode, shuffled_order, cursor, status)
            VALUES (?, ?, 'utility', ?, ?, 'completed')
            """,
            (user_row[0], playlist_id, json.dumps(shuffled_uris), len(shuffled_uris)),
        )
        await db.commit()

    return templates.TemplateResponse(
        request,
        "utility_result.html",
        {
            "playlist_name": new_name,
            "playlist_url": new_playlist_url,
            "total_tracks": len(shuffled_uris),
            "skipped_count": len(skipped),
            "skipped_tracks": skipped,
        },
    )
