"""Routes for exporting/importing run state."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from app.db import get_db
from app.routes_utility import _get_user_id
from core.exporter import export_run, import_run

router = APIRouter(prefix="/export", tags=["export"])


# ---------------------------------------------------------------------------
# GET /export/{run_id} — download run as JSON
# ---------------------------------------------------------------------------

@router.get("/{run_id}")
async def export_run_endpoint(request: Request, run_id: int):
    """Export a run's state as a downloadable JSON file."""
    _get_user_id(request)  # auth guard

    db = get_db()
    cursor = await db.execute(
        "SELECT playlist_id, mode, shuffled_order, cursor, status FROM runs WHERE id = ?",
        (run_id,),
    )
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")

    json_str = export_run(
        playlist_id=row[0],
        mode=row[1],
        shuffled_order=json.loads(row[2]),
        cursor=row[3],
        status=row[4],
    )

    return Response(
        content=json_str,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="run_{run_id}.json"'},
    )


# ---------------------------------------------------------------------------
# POST /export/import — upload a run JSON to resume
# ---------------------------------------------------------------------------

@router.post("/import")
async def import_run_endpoint(request: Request):
    """Import a run state from JSON and create a new DB run."""
    user_id = _get_user_id(request)

    body = await request.body()
    try:
        payload = import_run(body.decode("utf-8"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    db = get_db()
    cursor = await db.execute(
        "SELECT id FROM users WHERE spotify_user_id = ?", (user_id,)
    )
    user_row = await cursor.fetchone()
    if not user_row:
        raise HTTPException(status_code=401, detail="User not found")

    await db.execute(
        """
        INSERT INTO runs (user_id, playlist_id, mode, shuffled_order, cursor, status)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            user_row[0],
            payload.playlist_id,
            payload.mode,
            json.dumps(payload.shuffled_order),
            payload.cursor,
            "active",  # imported runs are always active
        ),
    )
    await db.commit()

    return JSONResponse({"status": "imported", "playlist_id": payload.playlist_id})
