"""Utility mode — shuffle-copy workflow.

POST /utility/create?playlist_id=...
  1. Check for existing active run → resume (no re-shuffle)
  2. Fetch all tracks → filter → dedup
  3. Fisher-Yates shuffle
  4. Create new playlist "🔀 {name}"
  5. Add tracks in 100-batch writes
  6. Persist run to DB
  7. Render success page
"""

from __future__ import annotations

import json
import random
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app.auth import get_valid_token
from app.db import get_db
from app.spotify import (
    add_tracks_batch,
    create_playlist,
    get_current_user_id,
    get_playlist,
    get_playlist_tracks,
)

router = APIRouter(tags=["utility"])

_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
templates = Jinja2Templates(directory=str(_TEMPLATES_DIR))


def _require_user(request: Request) -> str:
    uid = request.session.get("spotify_user_id")
    if not uid:
        raise HTTPException(status_code=307, headers={"Location": "/login"})
    return uid


# ---------------------------------------------------------------------------
# POST /utility/create
# ---------------------------------------------------------------------------

@router.post("/utility/create", response_class=HTMLResponse)
async def utility_create(request: Request, playlist_id: str):
    """Execute the full shuffle-copy workflow."""
    spotify_user_id = _require_user(request)
    token = await get_valid_token(spotify_user_id)
    db = get_db()

    # Resolve internal user id.
    cur = await db.execute(
        "SELECT id FROM users WHERE spotify_user_id = ?", (spotify_user_id,)
    )
    user_row = await cur.fetchone()
    if not user_row:
        raise HTTPException(status_code=401, detail="User not found")
    internal_user_id: int = user_row[0]

    # ----- Check for existing active run -----
    cur = await db.execute(
        """SELECT id, shuffled_order, cursor, target_playlist_id
           FROM runs
           WHERE user_id = ? AND playlist_id = ? AND mode = 'utility' AND status = 'active'
           ORDER BY created_at DESC LIMIT 1""",
        (internal_user_id, playlist_id),
    )
    existing_run = await cur.fetchone()

    if existing_run and existing_run[3]:
        # Already have an active run with a target playlist — resume / show it.
        return templates.TemplateResponse(
            "utility_result.html",
            {
                "request": request,
                "target_playlist_id": existing_run[3],
                "target_url": f"https://open.spotify.com/playlist/{existing_run[3]}",
                "track_count": len(json.loads(existing_run[1])),
                "excluded_count": 0,
                "excluded_items": [],
                "resumed": True,
            },
        )

    # ----- Fetch & filter tracks -----
    valid_uris, excluded = await get_playlist_tracks(token, playlist_id)

    if not valid_uris:
        raise HTTPException(
            status_code=400,
            detail=f"No valid tracks found in playlist (excluded: {len(excluded)})",
        )

    # ----- Fisher-Yates shuffle -----
    shuffled = list(valid_uris)
    random.shuffle(shuffled)  # Fisher-Yates (Knuth) in-place

    # ----- Create new playlist -----
    source = await get_playlist(token, playlist_id)
    new_name = f"🔀 {source['name']}"
    new_pl = await create_playlist(
        token,
        spotify_user_id,
        new_name,
        description=f"Shuffled copy of '{source['name']}' by true-shuffle",
    )

    # ----- Add tracks in batches -----
    await add_tracks_batch(token, new_pl["id"], shuffled)

    # ----- Persist run -----
    await db.execute(
        """INSERT INTO runs
           (user_id, playlist_id, mode, shuffled_order, cursor,
            target_playlist_id, status, excluded_count, excluded_items)
           VALUES (?, ?, 'utility', ?, ?, ?, 'completed', ?, ?)""",
        (
            internal_user_id,
            playlist_id,
            json.dumps(shuffled),
            len(shuffled),
            new_pl["id"],
            len(excluded),
            json.dumps(excluded),
        ),
    )
    await db.commit()

    # ----- Render success page -----
    return templates.TemplateResponse(
        "utility_result.html",
        {
            "request": request,
            "target_playlist_id": new_pl["id"],
            "target_url": new_pl.get("url") or f"https://open.spotify.com/playlist/{new_pl['id']}",
            "track_count": len(shuffled),
            "excluded_count": len(excluded),
            "excluded_items": excluded,
            "resumed": False,
        },
    )
