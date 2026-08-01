"""Export / import a run.

A deck is portable: you can take the exact order and cursor with you and
resume it later, or on another machine.  The file never contains credentials —
see :mod:`core.exporter`.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from app import db
from app.deps import require_run, require_user_id
from core.exporter import export_run, import_run, resume_status

router = APIRouter(prefix="/export", tags=["export"])


@router.get("/{run_id}")
async def export_run_endpoint(request: Request, run_id: int):
    """Download a run as JSON.  Ownership is enforced by :func:`require_run`.

    WP3-D2: this is the LOSSY v2 legacy export — order + cursor + status
    only; config, per-track states, cycle and ledger stay behind (see
    :mod:`core.exporter`).  A v3 format follows once run_tracks round-trips.
    """
    run = await require_run(request, run_id)

    json_str = export_run(
        provider=run["provider"],
        playlist_id=run["playlist_id"],
        playlist_name=run.get("playlist_name", ""),
        mode=run["mode"],
        order=run["order"],
        cursor=run["cursor"],
        status=run["status"],
    )

    filename = f"true-shuffle-run-{run_id}.json"
    return Response(
        content=json_str,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/import")
async def import_run_endpoint(request: Request):
    """Upload a previously exported run and continue it."""
    user_id = await require_user_id(request)

    body = await request.body()
    try:
        payload = import_run(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # WP3-D2 (Blueprint §5.2): an import creates an INDEPENDENT new run —
    # always.  The v2 code cancelled the live runs of the same playlist here
    # because ``idx_runs_one_live`` would have rejected the insert; that index
    # fell with M005 (UC-16), so a running deck and an imported one now
    # coexist, and tearing down a live run as a side effect of an upload
    # would violate the run-isolation invariant.  Imported runs resume as
    # 'paused' (see ``resume_status``), so ``idx_runs_one_playing`` cannot
    # collide either.
    run_id = await db.create_run(
        user_id=user_id,
        provider=payload.provider,
        playlist_id=payload.playlist_id,
        playlist_name=payload.playlist_name,
        mode=payload.mode.value,
        order=payload.order,
        cursor=payload.cursor,
        status=resume_status(payload).value,
    )
    await db.record_event(
        run_id, "imported", cursor=payload.cursor,
        detail={"total": len(payload.order), "source_status": payload.status.value},
    )

    return JSONResponse(
        {
            "status": "imported",
            "run_id": run_id,
            "provider": payload.provider,
            "playlist_id": payload.playlist_id,
            "cursor": payload.cursor,
            "total": len(payload.order),
        }
    )
