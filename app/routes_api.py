"""JSON API — the surface the web player and any future mobile app use."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app import accounts, db, jobs, library_service, runs
from app.accounts import AccountNotConnected
from app.deps import ensure_session_user, http_error, require_run, require_user_id
from app.watcher import watcher
from core.models import AdvanceReason, PlaylistRef, RunMode, RunStatus
from core.selection import NEW_TRACKS_POLICIES, Candidate, Rules
from core.selection import preflight as rules_preflight
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
    """Playlists for one connected service, each with its import status.

    ``import_status`` says what the content layer actually knows: never
    imported, or imported at X with N titles.  ``sync_available`` appears
    only when staleness is cheaply provable via source_etag; otherwise the
    field is honestly absent (see :func:`library_service.import_status_field`).
    """
    user_id = await require_user_id(request)
    session = await _session(user_id, provider)
    try:
        playlists = await session.provider.list_playlists(session.token)
    except ProviderError as exc:
        raise http_error(exc) from exc

    overview = await library_service.import_overview(user_id, provider)
    items = []
    for playlist in playlists:
        entry = playlist.model_dump()
        entry["import_status"] = library_service.import_status_field(
            playlist, overview.get(playlist.id)
        )
        items.append(entry)

    return JSONResponse({"provider": provider, "playlists": items})


# ---------------------------------------------------------------------------
# Playlist import / snapshot / sync (UC-03, UC-04, RUN-09 basis)
# ---------------------------------------------------------------------------

async def _importable_playlist(session, playlist_id: str) -> PlaylistRef:
    """Resolve a playlist and refuse the unreadable ones up front.

    Same rule as run creation: the listener pressed a button, and an answer
    in the same breath beats a progress bar that dies at 0 %.
    """
    playlist = await runs.resolve_playlist(session, playlist_id)
    if not playlist.readable:
        raise HTTPException(
            status_code=422,
            detail=(playlist.unreadable_reason
                    or f"{session.provider.capabilities.display_name} gibt den "
                       "Inhalt dieser Playlist nicht heraus."),
        )
    return playlist


@router.post("/playlists/{provider}/{playlist_id}/import")
async def playlist_import(request: Request, provider: str, playlist_id: str):
    """Import a playlist as a new versioned snapshot — returns a job to watch."""
    user_id = await require_user_id(request)
    session = await _session(user_id, provider)
    playlist = await _importable_playlist(session, playlist_id)

    job_id = jobs.new_job_id()

    async def work() -> Dict[str, Any]:
        return await library_service.import_playlist(
            session, playlist, job_id=job_id
        )

    await jobs.start(job_id, user_id, f"import:{provider}", work)
    return JSONResponse({"job_id": job_id}, status_code=202)


@router.get("/playlists/{provider}/{playlist_id}/snapshot")
async def playlist_snapshot(request: Request, provider: str, playlist_id: str):
    """Newest snapshot of the caller's playlist: status, counters, version."""
    user_id = await require_user_id(request)
    info = await library_service.snapshot_status(user_id, provider, playlist_id)
    if info is None:
        raise HTTPException(
            status_code=404,
            detail="Diese Playlist wurde noch nicht importiert.",
        )
    return JSONResponse(info)


@router.post("/playlists/{provider}/{playlist_id}/sync")
async def playlist_sync(request: Request, provider: str, playlist_id: str):
    """Sync = fresh import + diff against the previous snapshot (RUN-09).

    The job result shows the diff BEFORE anything is applied; applying it to
    a run is WP3-D3 (:func:`library_service.apply_sync_to_run`).
    """
    user_id = await require_user_id(request)
    session = await _session(user_id, provider)
    playlist = await _importable_playlist(session, playlist_id)

    job_id = jobs.new_job_id()

    async def work() -> Dict[str, Any]:
        imported = await library_service.import_playlist(
            session, playlist, job_id=job_id
        )
        await jobs.report(
            job_id, imported["item_count"], imported["item_count"], "diffing"
        )
        diff = await library_service.compute_sync_diff(imported["playlist_id"])
        return {"import": imported, "diff": diff}

    await jobs.start(job_id, user_id, f"sync:{provider}", work)
    return JSONResponse({"job_id": job_id}, status_code=202)


@router.get("/playlists/{provider}/{playlist_id}/sync/latest")
async def playlist_sync_latest(request: Request, provider: str, playlist_id: str):
    """The latest computed diff (newest ready snapshot vs. the one before)."""
    user_id = await require_user_id(request)
    row = await library_service.get_playlist_row(user_id, provider, playlist_id)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail="Diese Playlist wurde noch nicht importiert.",
        )
    diff = await library_service.compute_sync_diff(int(row["id"]))
    if diff is None:
        raise HTTPException(
            status_code=404,
            detail=("Noch kein Vergleichsstand — dafür braucht es mindestens "
                    "zwei erfolgreiche Importe."),
        )
    return JSONResponse(diff)


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
# Configs — the rule layer's write side (WP3-D3: UC-07..10, 27..29)
# ---------------------------------------------------------------------------

def _config_payload(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "kind": row["kind"],
        "origin_config_id": row.get("origin_config_id"),
        "current_version": row["current_version"],
        "config_version_id": row["config_version_id"],
        "rules": json.loads(row["rules_json"]),
        "rules_hash": row["rules_hash"],
        "created_at": row.get("created_at", ""),
        "updated_at": row.get("updated_at", ""),
        "used_by_runs": row.get("used_by_runs", 0),
    }


def _merge_rules(base: Rules, patch: Any) -> Rules:
    """Merge a partial rules dict over *base* and validate — 400 on nonsense.

    Unknown keys, wrong types and out-of-domain values are all client
    errors with the engine's own German sentences; nothing invalid ever
    reaches ``run_config_versions``.
    """
    if patch is None:
        patch = {}
    if not isinstance(patch, dict):
        raise HTTPException(
            status_code=400, detail="rules muss ein JSON-Objekt sein."
        )
    try:
        merged = Rules.from_dict({**base.to_dict(), **patch})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    conflicts = merged.validate()
    if conflicts:
        raise HTTPException(
            status_code=400,
            detail="; ".join(c.message for c in conflicts),
        )
    return merged


async def _owned_config(user_id: int, config_id: int) -> Dict[str, Any]:
    """Ownership is part of the lookup — a foreign config is a 404, not a 403
    (the same rule as require_run: never confirm that the id exists)."""
    cfg = await db.get_config(config_id)
    if cfg is None or int(cfg["user_id"]) != user_id:
        raise HTTPException(
            status_code=404, detail="Diese Konfiguration gibt es nicht."
        )
    return cfg


@router.get("/configs")
async def list_configs(request: Request):
    """Every preset of the caller, with frozen current rules + usage count."""
    user_id = await require_user_id(request)
    rows = await db.list_configs(user_id)
    return JSONResponse({"configs": [_config_payload(r) for r in rows]})


@router.post("/configs")
async def create_config(request: Request):
    """Create a preset (UC-07/10): ``{"name": …, "rules": {…}}``.

    ``rules`` is a partial dict over the behaviour-neutral defaults; the new
    preset gets its frozen version 1.  A taken name answers 409.
    """
    user_id = await require_user_id(request)
    body = await _json(request)
    name = str(body.get("name") or "").strip()[:120]
    if not name:
        raise HTTPException(status_code=400, detail="name wird gebraucht.")
    rules = _merge_rules(Rules(), body.get("rules"))
    try:
        config_id = await db.create_config(user_id, name, rules)
    except aiosqlite.IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail=f"Eine Konfiguration namens „{name}“ gibt es schon.",
        ) from exc
    cfg = await db.get_config(config_id)
    return JSONResponse(_config_payload({**cfg, "used_by_runs": 0}),
                        status_code=201)


@router.get("/configs/{config_id}")
async def get_config(request: Request, config_id: int):
    user_id = await require_user_id(request)
    cfg = await _owned_config(user_id, config_id)
    return JSONResponse(_config_payload(cfg))


@router.patch("/configs/{config_id}")
async def patch_config(request: Request, config_id: int):
    """Edit a preset (UC-27 preset side): a rules patch freezes a NEW version
    and bumps ``current_version`` — old versions stay for reproducibility.
    Runs already bound to an older version keep it (their bindings decide)."""
    user_id = await require_user_id(request)
    cfg = await _owned_config(user_id, config_id)
    body = await _json(request)

    if "rules" in body:
        merged = _merge_rules(Rules.from_json(cfg["rules_json"]), body["rules"])
        await db.add_config_version(config_id, merged)
    name = str(body.get("name") or "").strip()[:120]
    if name and name != cfg["name"]:
        try:
            await db.rename_config(config_id, name)
        except aiosqlite.IntegrityError as exc:
            raise HTTPException(
                status_code=409,
                detail=f"Eine Konfiguration namens „{name}“ gibt es schon.",
            ) from exc
    fresh = await db.get_config(config_id)
    return JSONResponse(_config_payload(fresh))


@router.post("/configs/{config_id}/duplicate")
async def duplicate_config(request: Request, config_id: int):
    """UC-28: copy a preset as the starting point for a variant.

    The copy records its ancestry (``origin_config_id``) and starts at
    version 1 with the source's CURRENT rules.  Track-bound facts
    (favourites, exclusions) live on runs and never travel (F7/UC-29).
    """
    user_id = await require_user_id(request)
    source = await _owned_config(user_id, config_id)
    body = await _json(request)
    base_name = (
        str(body.get("name") or "").strip()[:110] or f"{source['name']} (Kopie)"
    )
    rules = Rules.from_json(source["rules_json"])

    name = base_name
    for attempt in range(2, 30):
        try:
            new_id = await db.create_config(
                user_id, name, rules, origin_config_id=config_id
            )
            break
        except aiosqlite.IntegrityError:
            name = f"{base_name} · {attempt}"
    else:  # pragma: no cover — 28 collisions in a row
        raise HTTPException(
            status_code=409, detail="Kein freier Name für die Kopie gefunden."
        )
    cfg = await db.get_config(new_id)
    return JSONResponse(_config_payload({**cfg, "used_by_runs": 0}),
                        status_code=201)


@router.post("/runs/preflight")
async def run_preflight(request: Request):
    """RUN-05: rule conflicts BEFORE a run starts, with concrete corrections.

    Body: ``{"provider", "playlist_id", "config_id"?, "rules"?,
    "track_count"?}`` — rules patch over the config (or the defaults).  The
    candidate count comes from the newest ready snapshot when one exists
    (collapse-aware); otherwise from the client's ``track_count`` hint;
    otherwise only the value-domain checks can run — said honestly via
    ``candidate_source``.
    """
    user_id = await require_user_id(request)
    body = await _json(request)
    provider = str(body.get("provider") or "")
    playlist_id = str(body.get("playlist_id") or "")

    base = Rules()
    raw_config = body.get("config_id")
    if raw_config is not None:
        try:
            cfg = await _owned_config(user_id, int(raw_config))
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=400, detail="config_id muss eine Zahl sein."
            ) from exc
        base = Rules.from_json(cfg["rules_json"])
    rules = _merge_rules(base, body.get("rules"))

    count: Optional[int] = None
    source = None
    if provider and playlist_id:
        snapshot = await db.latest_ready_snapshot(user_id, provider, playlist_id)
        if snapshot is not None:
            items = await db.snapshot_items_with_tracks(int(snapshot["id"]))
            playable = [i for i in items if i["availability"] == "playable"]
            if rules.duplicate_policy == "collapse":
                count = len({i["track_pk"] for i in playable})
            else:
                count = len(playable)
            source = "snapshot"
    if count is None:
        hint = body.get("track_count")
        if isinstance(hint, int) and not isinstance(hint, bool) and hint >= 0:
            count = hint
            source = "hint"

    candidates = [
        Candidate(run_track_id=i, track_key=f"preflight:{i}")
        for i in range(count or 0)
    ]
    conflicts = (
        rules_preflight(candidates, rules) if count is not None
        else rules.validate()
    )
    return JSONResponse({
        "conflicts": [
            {"code": c.code, "field": c.field, "message": c.message,
             "suggestion": c.suggestion}
            for c in conflicts
        ],
        "candidate_count": count,
        "candidate_source": source,
        "rules": rules.to_dict(),
    })


# ---------------------------------------------------------------------------
# Creating runs
# ---------------------------------------------------------------------------

@router.post("/runs")
async def create_run(request: Request):
    """Deal a deck (or resume the live one) — returns a job to watch.

    Reading a huge playlist happens in the background so the request returns
    immediately and the UI can show real progress.

    WP3-D2 body additions (both optional): ``name`` — the run's own name
    (UC-16: several runs per playlist need names; defaults to the playlist
    name, collisions get an automatic ``· N`` suffix) — and ``config_id`` —
    the run configuration (defaults to the user's legacy preset „Ohne
    Wiederholungen").  Resolution stays the deprecated-wrapper rule: exactly
    one live run resumes, none creates, several is a 409 that asks for an
    explicit choice, ``reshuffle`` keeps its v2 meaning.
    """
    user_id = await require_user_id(request)
    body = await request.json()

    provider_id = body.get("provider", "")
    playlist_id = body.get("playlist_id", "")
    mode = RunMode(body.get("mode", RunMode.CONTROLLER.value))
    reshuffle = bool(body.get("reshuffle"))
    name = str(body.get("name") or "").strip() or None
    raw_config = body.get("config_id")
    try:
        config_id = int(raw_config) if raw_config is not None else None
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=400, detail="config_id muss eine Zahl sein."
        ) from exc

    if not provider_id or not playlist_id:
        raise HTTPException(status_code=400, detail="provider und playlist_id werden gebraucht.")

    session = await _session(user_id, provider_id)
    caps = session.provider.capabilities

    if mode is RunMode.CONTROLLER and not caps.supports_controller_mode:
        raise HTTPException(
            status_code=400,
            detail=(f"{caps.display_name} lässt keine Wiedergabesteuerung zu — "
                    "nimm den Handoff-Modus."),
        )
    if mode is RunMode.UTILITY and not caps.create_playlist:
        raise HTTPException(
            status_code=400,
            detail=f"{caps.display_name} kann keine Playlists anlegen — nimm den Live-Modus.",
        )

    playlist = await runs.resolve_playlist(session, playlist_id)

    # Refuse here rather than in the job: the listener pressed a button, and an
    # answer in the same breath beats a progress bar that dies at 0 %.
    if not playlist.readable:
        raise HTTPException(
            status_code=422,
            detail=(playlist.unreadable_reason
                    or f"{caps.display_name} gibt den Inhalt dieser Playlist "
                       "nicht heraus."),
        )

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
            session, playlist, mode, on_progress=on_progress,
            reshuffle=reshuffle, name=name, config_id=config_id,
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
        raise HTTPException(status_code=404, detail="Diesen Auftrag gibt es nicht.")
    return JSONResponse(snap)


@router.get("/jobs/{job_id}/stream")
async def job_stream(request: Request, job_id: str):
    """Server-sent progress for a running job."""
    user_id = await require_user_id(request)
    snap = await jobs.snapshot(job_id, user_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="Diesen Auftrag gibt es nicht.")

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
    """Every run of the caller — with its v3 identity (name, cycle).

    Archived runs (UC-26 soft delete) are hidden: they await their confirmed
    deletion and must not look resumable.
    """
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
    # WP3-D4: real "Wiederholungen" / "Ausgeschlossene" counters for the
    # Fortschritt tiles — None (→ "—") for legacy runs without a materialised
    # deck, never a fake 0 (see db.deck_stats docstring).
    deck_totals = await db.deck_stats(run_id)
    payload["repeat_count"] = deck_totals["repeats"]
    payload["excluded_count"] = deck_totals["excluded"]
    # WP3-D2: the run's own identity (UC-16) and cycle count (UC-15/F2).
    payload["name"] = run.get("name", "")
    payload["cycle"] = run.get("cycle", 1)
    # WP3-D3 (F8): the manual-use state — 'awaiting_decision' is UX-Zustand C
    # and the player renders the decision banner from exactly this field.
    payload["manual_state"] = run.get("manual_state") or "none"
    # Deck identity for the "Als Nächstes" actions (UC-08/20/21): the
    # favourite / exclude buttons need the run_track_id behind each row.
    ids = [e["id"] for e in [payload.get("current"), *payload.get("upcoming", [])] if e]
    deck = await db.run_tracks_by_provider_ids(run_id, ids)
    for entry in [payload.get("current"), *payload.get("upcoming", [])]:
        if not entry:
            continue
        card = deck.get(entry["id"])
        if card:
            entry["run_track_id"] = card["id"]
            entry["favorite"] = bool(card["favorite"])
            entry["state"] = card["state"]
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

    raise HTTPException(status_code=400, detail=f"Unbekannter Ereignistyp {event_type!r}.")


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
            raise HTTPException(status_code=404, detail="Diesen Lauf gibt es nicht.")
        if state.status is RunStatus.COMPLETED:
            return JSONResponse({"status": "completed", "cursor": state.cursor,
                                 "total": state.total})
        if state.status is RunStatus.CANCELLED:
            raise HTTPException(status_code=409, detail="Dieser Lauf wurde beendet.")

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
            raise HTTPException(status_code=404, detail="Diesen Lauf gibt es nicht.")
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


@router.post("/runs/{run_id}/stop")
async def run_stop(request: Request, run_id: int):
    """F1 (ADR-003): deliberate session end — watcher off, device released,
    fully resumable.  Illegal states answer 409 via the RunError handler."""
    run = await require_run(request, run_id)
    session = await _session(run["user_id"], run["provider"])
    state = await runs.stop_run(session, runs._to_state(run))
    return JSONResponse({"status": state.status.value, "cursor": state.cursor})


@router.post("/runs/{run_id}/resume")
async def run_resume(request: Request, run_id: int):
    """Explicit resume by run id (WP3-D2): stopped/paused → active.

    Does NOT start playback — that stays ``POST …/start``, which re-asserts a
    device.  Completed/cancelled answer 409 (RunError handler)."""
    run = await require_run(request, run_id)
    session = await _session(run["user_id"], run["provider"])
    state = await runs.resume_run(session, run_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Diesen Lauf gibt es nicht.")
    return JSONResponse({"status": state.status.value, "cursor": state.cursor})


@router.post("/runs/{run_id}/rules")
async def run_rules(request: Request, run_id: int):
    """UC-27: change the rules of THIS run — versioned, effective-from-seq.

    Body: ``{"rules": {…partial…}}``.  Freezes a run-local config version,
    binds it from the next selection on, and replans only the tail — played
    history and the running card stay untouched.
    """
    run = await require_run(request, run_id)
    body = await _json(request)
    patch = body.get("rules")
    if not isinstance(patch, dict) or not patch:
        raise HTTPException(
            status_code=400,
            detail="rules (ein nicht-leeres JSON-Objekt) wird gebraucht.",
        )
    # Same lock as advance/reset: the watcher must not consume plan rows
    # while the tail underneath them is being replaced.
    async with runs.advance_lock(run_id):
        state = await runs.get_state(run_id, run["user_id"])
        if state is None:
            raise HTTPException(status_code=404, detail="Diesen Lauf gibt es nicht.")
        try:
            result = await runs.change_run_rules(state, patch)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return JSONResponse(result)


@router.post("/runs/{run_id}/tracks/{run_track_id}/favorite")
@router.delete("/runs/{run_id}/tracks/{run_track_id}/favorite")
async def run_track_favorite(request: Request, run_id: int, run_track_id: int):
    """UC-08: POST marks the card as a favourite, DELETE unmarks it."""
    run = await require_run(request, run_id)
    favorite = request.method == "POST"
    result = await runs.mark_favorite(
        run["user_id"], run_id, run_track_id, favorite
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Diesen Titel gibt es hier nicht.")
    return JSONResponse(result)


@router.post("/runs/{run_id}/tracks/{run_track_id}/exclude")
@router.delete("/runs/{run_id}/tracks/{run_track_id}/exclude")
async def run_track_exclude(request: Request, run_id: int, run_track_id: int):
    """UC-20/21: POST excludes the card for this run, DELETE takes it back.

    Immediate effect (RUN-08): the remaining order is replanned right away.
    Import exclusions are not user-revocable here (409 via RunError).
    """
    run = await require_run(request, run_id)
    excluded = request.method == "POST"
    async with runs.advance_lock(run_id):
        state = await runs.get_state(run_id, run["user_id"])
        if state is None:
            raise HTTPException(status_code=404, detail="Diesen Lauf gibt es nicht.")
        result = await runs.set_track_exclusion(state, run_track_id, excluded)
    if result is None:
        raise HTTPException(status_code=404, detail="Diesen Titel gibt es hier nicht.")
    return JSONResponse(result)


@router.post("/runs/{run_id}/apply-sync")
async def run_apply_sync(request: Request, run_id: int):
    """UC-04 / RUN-10: apply a computed sync diff to THIS run.

    Body: ``{"diff_id": …, "policy"?: "include_now"|"after_cycle"|"ignore"}``
    — without ``policy`` the run's effective ``new_tracks_policy`` decides.
    Idempotent: a second apply of the same diff answers with the first
    result.  A diff of another playlist answers 409 (RunError handler).
    """
    run = await require_run(request, run_id)
    body = await _json(request)
    try:
        diff_id = int(body.get("diff_id"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=400, detail="diff_id (eine Zahl) wird gebraucht."
        ) from exc
    policy = body.get("policy")
    if policy is not None and policy not in NEW_TRACKS_POLICIES:
        raise HTTPException(
            status_code=400,
            detail=("policy muss include_now, after_cycle oder ignore sein — "
                    "oder weggelassen werden."),
        )
    # Same lock as advance/reset: the tail replan must not race the watcher.
    async with runs.advance_lock(run_id):
        result = await library_service.apply_sync_to_run(
            run_id, diff_id=diff_id, user_id=run["user_id"],
            new_tracks_policy=policy,
        )
    return JSONResponse(result)


@router.post("/runs/{run_id}/manual-decision")
async def run_manual_decision(request: Request, run_id: int):
    """UX-Zustand C (F8, ADR-003): answer the 'ask' policy's question.

    ``{"action": "resume"}`` → True Shuffle takes playback back;
    ``{"action": "pause"}`` → the run pauses at exactly this card.
    A run that is not awaiting a decision answers 409 (RunError handler)."""
    run = await require_run(request, run_id)
    body = await _json(request)
    action = str(body.get("action") or "")
    if action not in ("resume", "pause"):
        raise HTTPException(
            status_code=400,
            detail="action muss 'resume' oder 'pause' sein.",
        )
    session = await _session(run["user_id"], run["provider"])
    try:
        result = await runs.manual_decision(session, run_id, run["user_id"], action)
    except ProviderError as exc:
        raise http_error(exc) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Diesen Lauf gibt es nicht.")
    if action == "resume":
        await watcher.ensure(run_id, run["user_id"])
    result["watcher"] = watcher.status(run_id)
    return JSONResponse(result)


@router.post("/runs/{run_id}/reset")
async def run_reset(request: Request, run_id: int):
    """F2 (ADR-003) / UC-15: next cycle — history stays, deck re-opens.

    Requires ``{"confirm": true}``: a reset discards the current order and
    position (not the history), so it must never happen on a stray click.
    """
    run = await require_run(request, run_id)
    body = await _json(request)
    if body.get("confirm") is not True:
        raise HTTPException(
            status_code=400,
            detail=("Ein neuer Durchlauf verwirft die aktuelle Reihenfolge und "
                    "Position (der Verlauf bleibt). Zum Bestätigen "
                    "confirm: true mitsenden."),
        )
    session = await _session(run["user_id"], run["provider"])
    # Same lock as advance: a watcher tick must not move the cursor while the
    # plan underneath it is being replaced.
    async with runs.advance_lock(run_id):
        state = await runs.get_state(run_id, run["user_id"])
        if state is None:
            raise HTTPException(status_code=404, detail="Diesen Lauf gibt es nicht.")
        summary = await runs.reset_run(session, state)
    return JSONResponse(summary)


@router.delete("/runs/{run_id}")
async def run_delete(request: Request, run_id: int, confirm: bool = False):
    """UC-26, two steps: DELETE archives (soft, reversible in the data),
    DELETE ?confirm=true is the confirmed hard deletion of exactly this run.
    The imported library (playlist, snapshots, tracks) stays untouched
    (RUN-12); only the run and its own history go."""
    user_id = await require_user_id(request)
    if confirm:
        deleted = await runs.hard_delete_run(user_id, run_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Diesen Lauf gibt es nicht.")
        return JSONResponse({"status": "deleted", "run_id": run_id})
    archived = await runs.delete_run(user_id, run_id)
    if not archived:
        raise HTTPException(status_code=404, detail="Diesen Lauf gibt es nicht.")
    return JSONResponse({"status": "archived", "run_id": run_id})


@router.post("/runs/{run_id}/device")
async def run_device(request: Request, run_id: int):
    """Move a live run to another playback target."""
    run = await require_run(request, run_id)
    body = await _json(request)
    device_id = body.get("device_id")
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id wird gebraucht.")

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
            status_code=404, detail=f"Unbekannter Dienst {provider_id}."
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
            # ADR-002: the uris window replaced the queue prefetch; empty when
            # the already-set context simply keeps playing.
            "play_window": decision.play_window,
            "watcher": watcher.status(run_id),
        }
    )
    return payload


@router.post("/demo/manual-play")
async def demo_manual_play(request: Request):
    """Demo-only: simulate the listener starting a track in the service's
    OWN app — the honest trigger for the F8 manual-use detection.

    The demo device is one global simulated speaker; playing something on it
    is exactly what a real listener does when they take Spotify over by
    hand, so the takeover browser tests provoke REAL drift through
    ``engine.reconcile`` instead of mocking a flag.  404 unless the demo
    connector is enabled — this surface does not exist in a real build.
    """
    from app.config import get_settings
    from providers.registry import try_get_provider

    if not get_settings().enable_demo_provider:
        raise HTTPException(status_code=404, detail="Das gibt es nicht.")
    await require_user_id(request)
    provider = try_get_provider("demo")
    if provider is None:  # pragma: no cover — registry always carries demo
        raise HTTPException(status_code=404, detail="Das gibt es nicht.")
    body = await _json(request)
    track_id = str(body.get("track_id") or "demo-01000")
    await provider.play(None, track_ids=[track_id], device_id="demo-speaker")
    return JSONResponse({"status": "ok", "track_id": track_id})


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
