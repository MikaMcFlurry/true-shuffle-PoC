"""JSON API — the surface the web player and any future mobile app use."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app import accounts, db, jobs, runs
from app.accounts import AccountNotConnected
from app.deps import ensure_session_user, http_error, require_run, require_user_id
from app.watcher import watcher
from core.models import AdvanceReason, PlaylistRef, RunMode, RunStatus
from providers import planned
from providers.base import PlaybackControl, ProviderError, ProviderQuotaError
from providers.registry import all_providers
from providers.youtube import YouTubeMusicProvider

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["api"])


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------

@router.get("/providers")
async def list_providers(request: Request):
    """Every connector, its capabilities, and whether this user linked it."""
    user_id = await ensure_session_user(request)
    connected = {
        a["provider"]: a for a in await db.list_provider_accounts(user_id)
    }

    items: List[Dict[str, Any]] = []
    for provider in all_providers():
        caps = provider.capabilities.as_dict()
        account = connected.get(caps["id"])
        caps.update(
            {
                "configured": provider.is_configured(),
                "missing_config": provider.missing_config(),
                "connected": account is not None,
                "account_name": (account or {}).get("display_name", ""),
                "market": (account or {}).get("market", ""),
                "product_tier": (account or {}).get("product_tier", ""),
                "status": "planned",
            }
        )
        if not caps["configured"]:
            caps["status"] = "needs_setup"
        elif account is not None:
            caps["status"] = "connected"
        else:
            caps["status"] = "ready"
        items.append(caps)

    return JSONResponse({"providers": items, "planned": planned.as_dicts()})


@router.get("/playlists")
async def list_playlists(request: Request, provider: str):
    """Playlists for one connected service."""
    user_id = await require_user_id(request)
    session = await _session(user_id, provider)
    try:
        playlists = await session.provider.list_playlists(session.token)
    except ProviderError as exc:
        raise http_error(exc) from exc

    return JSONResponse(
        {
            "provider": provider,
            "playlists": [p.model_dump() for p in playlists],
        }
    )


@router.get("/devices")
async def list_devices(request: Request, provider: str):
    """Playback targets for a remote-control provider."""
    user_id = await require_user_id(request)
    session = await _session(user_id, provider)
    if session.provider.capabilities.playback is not PlaybackControl.REMOTE_DEVICE:
        return JSONResponse({"provider": provider, "devices": [], "remote": False})
    try:
        devices = await session.provider.list_devices(session.token)
    except ProviderError as exc:
        raise http_error(exc) from exc
    return JSONResponse(
        {
            "provider": provider,
            "remote": True,
            "devices": [d.model_dump() for d in devices],
        }
    )


@router.get("/player-config")
async def player_config(request: Request, provider: str):
    """Non-secret configuration the in-page player needs to boot."""
    user_id = await require_user_id(request)
    session = await _session(user_id, provider)
    return JSONResponse(
        {
            "provider": provider,
            "playback": session.provider.capabilities.playback.value,
            "config": session.provider.browser_config(session.token),
        }
    )


# ---------------------------------------------------------------------------
# Creating runs
# ---------------------------------------------------------------------------

@router.post("/runs")
async def create_run(request: Request):
    """Deal a deck (or resume the live one) — returns a job to watch.

    Reading a huge playlist happens in the background so the request returns
    immediately and the UI can show real progress.
    """
    user_id = await require_user_id(request)
    body = await request.json()

    provider_id = body.get("provider", "")
    playlist_id = body.get("playlist_id", "")
    mode = RunMode(body.get("mode", RunMode.CONTROLLER.value))
    reshuffle = bool(body.get("reshuffle"))

    if not provider_id or not playlist_id:
        raise HTTPException(status_code=400, detail="provider and playlist_id required")

    session = await _session(user_id, provider_id)
    caps = session.provider.capabilities

    if mode is RunMode.CONTROLLER and not caps.supports_controller_mode:
        raise HTTPException(
            status_code=400,
            detail=f"{caps.display_name} offers no playback control — use Copy Mode.",
        )
    if mode is RunMode.UTILITY and not caps.create_playlist:
        raise HTTPException(
            status_code=400,
            detail=f"{caps.display_name} cannot create playlists — use Live Mode.",
        )

    playlist = await runs.resolve_playlist(session, playlist_id)
    job_id = jobs.new_job_id()

    async def work() -> Dict[str, Any]:
        async def on_progress(done: int, total: int, phase: str) -> None:
            await jobs.report(job_id, done, total, phase)

        # Pre-flight the YouTube quota so a doomed copy fails in one second
        # with an explanation instead of dying at track 190 of 1 500.
        if mode is RunMode.UTILITY and isinstance(
            session.provider, YouTubeMusicProvider
        ) and playlist.track_count > 0:
            session.provider.check_copy_quota(playlist.track_count)

        state, skipped = await runs.build_run(
            session, playlist, mode, on_progress=on_progress, reshuffle=reshuffle
        )

        result: Dict[str, Any] = {
            "run_id": state.run_id,
            "provider": provider_id,
            "playlist_id": playlist.id,
            "playlist_name": playlist.name,
            "mode": mode.value,
            "total": state.total,
            "cursor": state.cursor,
            "skipped": len(skipped),
        }

        if mode is RunMode.UTILITY:
            result.update(await _write_copy(session, state, playlist))

        return result

    await jobs.start(job_id, user_id, f"{mode.value}:{provider_id}", work)
    return JSONResponse({"job_id": job_id}, status_code=202)


async def _write_copy(session, state, playlist: PlaylistRef) -> Dict[str, Any]:
    """Handoff Mode: materialise the shuffled order as a real playlist.

    Where the service exposes a listening history, the run stays **active** and
    a background watcher reconciles the cursor from it — so the deck keeps its
    place with nothing of ours open. Where it does not (YouTube), there is
    nothing to track and the run is closed on the spot rather than pretending.
    """
    if isinstance(session.provider, YouTubeMusicProvider):
        session.provider.check_copy_quota(state.total)

    name = f"true-shuffle · {playlist.name}"[:120]
    created = await session.provider.create_playlist(
        session.token,
        name=name,
        description=(
            "Dealt by true-shuffle — every playable unique track exactly once, "
            "in an unbiased Fisher–Yates order."
        ),
    )

    size = max(1, session.provider.capabilities.write_batch_size)
    written = 0
    for i in range(0, state.total, size):
        await session.provider.add_tracks(
            session.token, created.id, state.order[i : i + size]
        )
        written += len(state.order[i : i + size])

    tracked = session.provider.capabilities.supports_history_sync
    if not tracked:
        await db.update_run(state.run_id, status=RunStatus.COMPLETED.value)
    await db.record_event(
        state.run_id, "copy_written", cursor=state.cursor,
        detail={"copy_playlist_id": created.id, "written": written,
                "tracked": tracked},
    )
    if tracked:
        await watcher.ensure(state.run_id, state.user_id)

    return {
        "copy_playlist_id": created.id,
        "copy_playlist_name": created.name,
        "copy_playlist_url": created.url or session.provider.playlist_url(created.id),
        "written": written,
        "tracked": tracked,
    }


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

@router.get("/jobs/{job_id}")
async def job_status(request: Request, job_id: str):
    user_id = await require_user_id(request)
    snap = await jobs.snapshot(job_id, user_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return JSONResponse(snap)


@router.get("/jobs/{job_id}/stream")
async def job_stream(request: Request, job_id: str):
    """Server-sent progress for a running job."""
    user_id = await require_user_id(request)
    snap = await jobs.snapshot(job_id, user_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="Job not found")

    queue = jobs.subscribe(job_id)

    async def events():
        try:
            yield f"data: {json.dumps(snap)}\n\n"
            if snap["status"] in ("done", "error", "cancelled"):
                return
            while True:
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(frame)}\n\n"
                if frame.get("status") in ("done", "error", "cancelled"):
                    return
        finally:
            jobs.unsubscribe(job_id, queue)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Run state & control
# ---------------------------------------------------------------------------

@router.get("/runs")
async def run_history(request: Request):
    user_id = await require_user_id(request)
    return JSONResponse({"runs": await db.list_runs(user_id)})


@router.get("/runs/{run_id}")
async def run_state(request: Request, run_id: int):
    run = await require_run(request, run_id)
    state = runs._to_state(run)
    session = await accounts.try_open_session(run["user_id"], run["provider"])
    payload = await runs.describe(session, state)
    payload["watcher"] = watcher.status(run_id)
    payload["skipped_count"] = len(await db.list_skipped(run_id))
    return JSONResponse(payload)


@router.get("/runs/{run_id}/skipped")
async def run_skipped(request: Request, run_id: int):
    await require_run(request, run_id)
    return JSONResponse({"skipped": await db.list_skipped(run_id)})


@router.get("/runs/{run_id}/events")
async def run_events(request: Request, run_id: int):
    await require_run(request, run_id)
    return JSONResponse({"events": await db.list_events(run_id)})


@router.post("/runs/{run_id}/start")
async def run_start(request: Request, run_id: int):
    run = await require_run(request, run_id)
    body = await _json(request)
    device_id = body.get("device_id") or run.get("device_id")

    session = await _session(run["user_id"], run["provider"])
    state = runs._to_state(run)
    try:
        decision = await runs.start(session, state, device_id=device_id)
    except ProviderError as exc:
        raise http_error(exc) from exc

    await watcher.ensure(run_id, run["user_id"])
    return JSONResponse(await _decision_payload(session, run_id, run["user_id"], decision))


@router.post("/runs/{run_id}/advance")
async def run_advance(request: Request, run_id: int):
    """Move the deck forward.  Used by the UI's *next* button."""
    body = await _json(request)
    reason = _reason(body.get("reason"), AdvanceReason.MANUAL)
    return await _advance(request, run_id, reason)


@router.post("/runs/{run_id}/event")
async def run_event(request: Request, run_id: int):
    """Playback events reported by the in-page player (Apple, YouTube).

    This is the web-player twin of the server-side watcher: the browser owns
    the audio pipeline, so it is the only thing that can tell us a track
    finished or was skipped.
    """
    body = await _json(request)
    event_type = body.get("type", "")

    mapping = {
        "track_ended": AdvanceReason.TRACK_ENDED,
        "skip": AdvanceReason.USER_SKIP,
        "native_skip": AdvanceReason.NATIVE_SKIP,
        "playback_failed": AdvanceReason.PLAYBACK_FAILED,
    }
    if event_type in mapping:
        return await _advance(request, run_id, mapping[event_type],
                              detail=body.get("detail"))

    if event_type in ("progress", "paused", "playing"):
        run = await require_run(request, run_id)
        await db.record_event(
            run_id, event_type, cursor=run["cursor"],
            detail={"position_ms": body.get("position_ms", 0)},
        )
        return JSONResponse({"status": "ok"})

    raise HTTPException(status_code=400, detail=f"Unknown event type {event_type!r}")


async def _advance(
    request: Request,
    run_id: int,
    reason: AdvanceReason,
    *,
    detail: Optional[Dict[str, Any]] = None,
) -> JSONResponse:
    run = await require_run(request, run_id)
    user_id = run["user_id"]

    # One cursor move per real event, even if the watcher and the browser
    # report the same track ending at the same moment.
    async with runs.advance_lock(run_id):
        state = await runs.get_state(run_id, user_id)
        if state is None:
            raise HTTPException(status_code=404, detail="Run not found")
        if state.status is RunStatus.COMPLETED:
            return JSONResponse({"status": "completed", "cursor": state.cursor,
                                 "total": state.total})
        if state.status is RunStatus.CANCELLED:
            raise HTTPException(status_code=409, detail="Run was cancelled")

        session = await _session(user_id, state.provider)
        try:
            decision = await runs.advance(
                session, state, reason=reason, device_id=state.device_id
            )
        except ProviderError as exc:
            raise http_error(exc) from exc

    if detail:
        await db.record_event(run_id, "client_detail", cursor=decision.cursor,
                              detail=detail)
    return JSONResponse(await _decision_payload(session, run_id, user_id, decision))


@router.post("/runs/{run_id}/previous")
async def run_previous(request: Request, run_id: int):
    run = await require_run(request, run_id)
    session = await _session(run["user_id"], run["provider"])
    async with runs.advance_lock(run_id):
        state = await runs.get_state(run_id, run["user_id"])
        if state is None:
            raise HTTPException(status_code=404, detail="Run not found")
        try:
            decision = await runs.previous(session, state)
        except ProviderError as exc:
            raise http_error(exc) from exc
    return JSONResponse(await _decision_payload(session, run_id, run["user_id"], decision))


@router.post("/runs/{run_id}/pause")
async def run_pause(request: Request, run_id: int):
    run = await require_run(request, run_id)
    session = await _session(run["user_id"], run["provider"])
    await watcher.stop(run_id)
    await runs.pause(session, runs._to_state(run))
    return JSONResponse({"status": "paused", "cursor": run["cursor"]})


@router.post("/runs/{run_id}/cancel")
async def run_cancel(request: Request, run_id: int):
    run = await require_run(request, run_id)
    session = await _session(run["user_id"], run["provider"])
    await watcher.stop(run_id)
    await runs.cancel(session, runs._to_state(run))
    return JSONResponse({"status": "cancelled"})


@router.post("/runs/{run_id}/device")
async def run_device(request: Request, run_id: int):
    """Move a live run to another playback target."""
    run = await require_run(request, run_id)
    body = await _json(request)
    device_id = body.get("device_id")
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id required")

    session = await _session(run["user_id"], run["provider"])
    state = runs._to_state(run)
    try:
        decision = await runs.start(session, state, device_id=device_id)
    except ProviderError as exc:
        raise http_error(exc) from exc
    return JSONResponse(await _decision_payload(session, run_id, run["user_id"], decision))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _session(user_id: int, provider_id: str):
    try:
        return await accounts.open_session(user_id, provider_id)
    except AccountNotConnected as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(
            status_code=404, detail=f"Unknown provider {provider_id}"
        ) from exc
    except ProviderQuotaError as exc:
        raise http_error(exc) from exc
    except ProviderError as exc:
        raise http_error(exc) from exc


async def _json(request: Request) -> Dict[str, Any]:
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _reason(value: Any, default: AdvanceReason) -> AdvanceReason:
    try:
        return AdvanceReason(value)
    except (ValueError, TypeError):
        return default


async def _decision_payload(session, run_id: int, user_id: int, decision) -> Dict[str, Any]:
    state = await runs.get_state(run_id, user_id)
    payload = await runs.describe(session, state) if state else {}
    payload.update(
        {
            "completed": decision.completed,
            "advanced": decision.advanced,
            "play_track_id": decision.play_track_id,
            "queue_track_ids": decision.queue_track_ids,
            "watcher": watcher.status(run_id),
        }
    )
    return payload


@router.get("/health")
async def health():
    from app.config import get_settings

    settings = get_settings()
    return JSONResponse(
        {
            "status": "ok",
            "providers": {
                p.capabilities.id: {
                    "configured": p.is_configured(),
                    "playback": p.capabilities.playback.value,
                }
                for p in all_providers()
            },
            "warnings": settings.insecure_defaults(),
        }
    )
