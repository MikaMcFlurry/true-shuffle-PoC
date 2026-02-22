"""Playlist listing routes — HTML views for browsing playlists."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app.auth import get_valid_token
from app.spotify import get_my_playlists, get_playlist

router = APIRouter(tags=["playlists"])

_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
templates = Jinja2Templates(directory=str(_TEMPLATES_DIR))


def _require_user(request: Request) -> str:
    """Return the spotify_user_id from session or redirect to /login."""
    uid = request.session.get("spotify_user_id")
    if not uid:
        raise HTTPException(status_code=307, headers={"Location": "/login"})
    return uid


# ---------------------------------------------------------------------------
# GET /playlists — list all playlists
# ---------------------------------------------------------------------------

@router.get("/playlists", response_class=HTMLResponse)
async def list_playlists(request: Request):
    """Show all playlists for the logged-in user."""
    user_id = _require_user(request)
    token = await get_valid_token(user_id)
    playlists = await get_my_playlists(token)

    return templates.TemplateResponse(
        "playlists.html",
        {"request": request, "playlists": playlists, "user_id": user_id},
    )


# ---------------------------------------------------------------------------
# GET /playlists/{playlist_id} — detail / actions page
# ---------------------------------------------------------------------------

@router.get("/playlists/{playlist_id}", response_class=HTMLResponse)
async def playlist_detail(request: Request, playlist_id: str):
    """Show details and available actions for a single playlist."""
    user_id = _require_user(request)
    token = await get_valid_token(user_id)
    playlist = await get_playlist(token, playlist_id)

    return templates.TemplateResponse(
        "playlist_detail.html",
        {"request": request, "playlist": playlist, "user_id": user_id},
    )
