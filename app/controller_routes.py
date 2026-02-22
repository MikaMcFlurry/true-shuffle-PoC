"""Controller Mode REST API routes.

Endpoints for starting/stopping the controller, getting status,
manual next, and shuffle refresh.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from app.controller import (
    ControllerState,
    create_or_resume_run,
    get_devices,
    get_session,
    manual_next,
    refresh_shuffle,
    start_playback,
    stop_controller,
)

router = APIRouter(prefix="/controller", tags=["controller"])


def _get_user_id(request: Request) -> str:
    """Extract spotify_user_id from session or raise 401."""
    uid = request.session.get("spotify_user_id")
    if not uid:
        raise HTTPException(status_code=401, detail="Not logged in — please /login")
    return uid


class StartRequest(BaseModel):
    playlist_id: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/start")
async def start(request: Request, body: StartRequest):
    """Start or resume a controller run for the given playlist."""
    uid = _get_user_id(request)
    try:
        session = await create_or_resume_run(uid, body.playlist_id)
        await start_playback(session)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return JSONResponse(session.to_status_dict())


@router.get("/status")
async def status(request: Request, playlist_id: str):
    """Return current controller state for the given playlist."""
    uid = _get_user_id(request)
    session = get_session(uid, playlist_id)
    if not session:
        return JSONResponse({"state": "idle", "cursor": 0, "total_tracks": 0})
    return JSONResponse(session.to_status_dict())


@router.post("/next")
async def next_track(request: Request, body: StartRequest):
    """Manual next: advance cursor, play next track."""
    uid = _get_user_id(request)
    session = get_session(uid, body.playlist_id)
    if not session:
        raise HTTPException(status_code=404, detail="No active session")
    await manual_next(session)
    return JSONResponse(session.to_status_dict())


@router.post("/stop")
async def stop(request: Request, body: StartRequest):
    """Stop the controller (pause polling)."""
    uid = _get_user_id(request)
    session = get_session(uid, body.playlist_id)
    if not session:
        raise HTTPException(status_code=404, detail="No active session")
    await stop_controller(session)
    return JSONResponse(session.to_status_dict())


@router.post("/refresh")
async def refresh(request: Request, body: StartRequest):
    """Cancel current run, create new shuffled order, start from cursor=0."""
    uid = _get_user_id(request)
    try:
        session = await refresh_shuffle(uid, body.playlist_id)
        await start_playback(session)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return JSONResponse(session.to_status_dict())


@router.get("/devices")
async def devices(request: Request):
    """List available Spotify devices."""
    uid = _get_user_id(request)
    device_list = await get_devices(uid)
    return JSONResponse({"devices": device_list})


@router.get("/ui", response_class=HTMLResponse)
async def controller_ui(request: Request, playlist_id: str = ""):
    """Serve the controller UI page."""
    uid = request.session.get("spotify_user_id")
    if not uid:
        from fastapi.responses import RedirectResponse
        return RedirectResponse("/login")

    from pathlib import Path
    template_path = Path(__file__).parent / "templates" / "controller.html"
    html = template_path.read_text(encoding="utf-8")
    # Inject playlist_id into the page.
    html = html.replace("{{PLAYLIST_ID}}", playlist_id)
    html = html.replace("{{USER_ID}}", uid)
    return HTMLResponse(html)
