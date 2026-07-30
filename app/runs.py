"""Run service — where the pure engine meets providers and the database.

Everything that mutates a run goes through here, so the cursor can only ever
move in one well-audited place.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from app import db
from app.accounts import Session
from app.config import get_settings
from core import engine
from core.engine import Decision
from core.models import (
    AdvanceReason,
    PlaylistRef,
    RunMode,
    RunState,
    RunStatus,
    SkippedEntry,
    Track,
)
from core.shuffle import prepare_shuffled_run
from providers.base import PlaybackControl, ProviderError

logger = logging.getLogger(__name__)

ProgressFn = Callable[[int, int, str], Awaitable[None]]


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

async def load_tracks(
    session: Session,
    playlist: PlaylistRef,
    *,
    on_progress: Optional[ProgressFn] = None,
) -> List[Track]:
    """Stream every track of a playlist, reporting progress as pages arrive.

    Reading 1 500 tracks is 15 sequential API round trips; doing that inside a
    request handler is what made the old Utility Mode appear to hang.
    """
    tracks: List[Track] = []
    total_hint = playlist.track_count if playlist.track_count > 0 else 0
    async for page in session.provider.iter_playlist_tracks(
        session.token, playlist.id
    ):
        tracks.extend(page)
        if on_progress:
            await on_progress(
                len(tracks), max(total_hint, len(tracks)), "reading playlist"
            )
    return tracks


def _skipped_rows(skipped: List[SkippedEntry]) -> List[Dict[str, str]]:
    return [
        {
            "id": s.track.id,
            "name": s.track.name,
            "artist": s.track.artist,
            "reason": s.reason.value,
        }
        for s in skipped
    ]


# ---------------------------------------------------------------------------
# Creating a run
# ---------------------------------------------------------------------------

async def build_run(
    session: Session,
    playlist: PlaylistRef,
    mode: RunMode,
    *,
    tracks: Optional[List[Track]] = None,
    on_progress: Optional[ProgressFn] = None,
    reshuffle: bool = False,
) -> Tuple[RunState, List[SkippedEntry]]:
    """Deal a fresh deck for *playlist*, or resume the live one.

    Resuming is the default: asking for a run you already have mid-deck gives
    you back the same order at the same cursor.  ``reshuffle=True`` is the
    explicit "deal again" action.
    """
    user_id = session.user_id
    provider_id = session.provider_id

    existing = await db.find_live_run(user_id, provider_id, playlist.id, mode.value)
    if existing and not reshuffle:
        return _to_state(existing), []

    if reshuffle and existing:
        await db.close_live_runs(user_id, provider_id, playlist.id, mode.value)

    if tracks is None:
        tracks = await load_tracks(session, playlist, on_progress=on_progress)
    if not tracks:
        raise ProviderError("This playlist has no tracks")

    if on_progress:
        await on_progress(len(tracks), len(tracks), "shuffling")

    previous = await db.latest_completed_order(user_id, provider_id, playlist.id)
    order, skipped, seed = prepare_shuffled_run(tracks, previous_order=previous)
    if not order:
        raise ProviderError(
            "No playable tracks left after filtering — every entry was a local "
            "file, unavailable, or not a music track."
        )

    run_id = await db.create_run(
        user_id=user_id,
        provider=provider_id,
        playlist_id=playlist.id,
        playlist_name=playlist.name,
        mode=mode.value,
        order=order,
        seed=seed,
        status=RunStatus.ACTIVE.value,
    )
    await db.record_skipped(run_id, _skipped_rows(skipped))
    await db.record_event(
        run_id, "run_created", cursor=0,
        detail={"total": len(order), "skipped": len(skipped), "seed": seed},
    )

    state = RunState(
        run_id=run_id,
        user_id=user_id,
        provider=provider_id,
        playlist_id=playlist.id,
        playlist_name=playlist.name,
        mode=mode,
        order=order,
        cursor=0,
        status=RunStatus.ACTIVE,
        seed=seed,
    )
    return state, skipped


def _to_state(row: Dict[str, Any]) -> RunState:
    return RunState(
        run_id=row["id"],
        user_id=row["user_id"],
        provider=row["provider"],
        playlist_id=row["playlist_id"],
        playlist_name=row.get("playlist_name", ""),
        mode=RunMode(row["mode"]),
        order=row.get("order", []),
        cursor=row.get("cursor", 0),
        status=RunStatus(row["status"]),
        device_id=row.get("device_id"),
        seed=row.get("seed"),
        created_at=row.get("created_at", ""),
        updated_at=row.get("updated_at", ""),
    )


async def get_state(run_id: int, user_id: int) -> Optional[RunState]:
    row = await db.get_run(run_id, user_id=user_id)
    return _to_state(row) if row else None


# ---------------------------------------------------------------------------
# Driving playback
# ---------------------------------------------------------------------------

async def _apply(
    session: Session,
    state: RunState,
    decision: Decision,
    *,
    device_id: Optional[str],
    force_override: bool = False,
) -> None:
    """Push a decision to a REMOTE_DEVICE provider.

    Web-player providers get the decision as JSON instead; the browser does the
    playing, so there is nothing to push.
    """
    caps = session.provider.capabilities
    if caps.playback is not PlaybackControl.REMOTE_DEVICE:
        return
    if not decision.play_track_id:
        return

    if decision.needs_override or force_override:
        await session.provider.play(
            session.token, track_id=decision.play_track_id, device_id=device_id
        )

    if caps.supports_queue_prefetch and decision.queue_track_ids:
        for track_id in decision.queue_track_ids:
            try:
                await session.provider.enqueue(
                    session.token, track_id=track_id, device_id=device_id
                )
            except ProviderError as exc:
                # A queue slot that fails is recoverable — the watcher will
                # hard-override when the track actually comes up.  Record it
                # instead of swallowing it, which is what the old code did.
                logger.warning("queue prefetch failed for %s: %s", track_id, exc)
                await db.record_event(
                    state.run_id, "queue_failed", cursor=state.cursor,
                    detail={"track_id": track_id, "error": str(exc)},
                )


async def start(
    session: Session,
    state: RunState,
    *,
    device_id: Optional[str] = None,
) -> Decision:
    """Begin or resume a run and, for remote providers, take over the device."""
    settings = get_settings()
    decision = engine.start(state, queue_buffer=settings.queue_buffer_size)

    if decision.completed:
        await _finish(state)
        return decision

    if state.status is RunStatus.PAUSED:
        await db.update_run(state.run_id, status=RunStatus.ACTIVE.value)
        state.status = RunStatus.ACTIVE

    if device_id:
        await db.update_run(state.run_id, device_id=device_id)
        state.device_id = device_id

    await _apply(session, state, decision, device_id=device_id or state.device_id,
                 force_override=True)
    await db.record_event(
        state.run_id, "started", cursor=state.cursor,
        detail={"device_id": device_id or state.device_id, "note": decision.note},
    )
    return decision


async def advance(
    session: Session,
    state: RunState,
    *,
    reason: AdvanceReason,
    device_id: Optional[str] = None,
    steps: int = 1,
) -> Decision:
    """Consume the current card and move to the next one."""
    settings = get_settings()
    decision = engine.advance(
        state, reason=reason, queue_buffer=settings.queue_buffer_size, steps=steps
    )

    await db.update_run(state.run_id, cursor=decision.cursor)
    state.cursor = decision.cursor

    if decision.completed:
        await _finish(state)
        await db.record_event(
            state.run_id, "completed", cursor=decision.cursor, reason=reason.value
        )
        return decision

    await _apply(session, state, decision, device_id=device_id or state.device_id)
    await db.record_event(
        state.run_id, "advanced", cursor=decision.cursor, reason=reason.value,
        detail={"track_id": decision.play_track_id},
    )
    return decision


async def previous(
    session: Session, state: RunState, *, device_id: Optional[str] = None
) -> Decision:
    settings = get_settings()
    decision = engine.previous(state, queue_buffer=settings.queue_buffer_size)
    await db.update_run(state.run_id, cursor=decision.cursor)
    state.cursor = decision.cursor
    await _apply(session, state, decision, device_id=device_id or state.device_id,
                 force_override=True)
    await db.record_event(state.run_id, "previous", cursor=decision.cursor)
    return decision


async def sync_from_history(
    session: Session, state: RunState
) -> Optional[engine.HistoryVerdict]:
    """Advance a deck from the service's recently-played list.

    This is the path that needs nothing of ours open: the listener plays the
    shuffled playlist in Spotify or Apple Music directly, and we reconcile.
    Returns ``None`` when the provider has no history to offer.
    """
    if not session.provider.capabilities.supports_history_sync:
        return None

    played = await session.provider.get_recently_played(session.token)
    verdict = engine.reconcile_history(state, [p.track_id for p in played])
    if not verdict.advanced:
        return verdict

    await db.update_run(state.run_id, cursor=verdict.cursor)
    state.cursor = verdict.cursor
    await db.record_event(
        state.run_id, "history_sync", cursor=verdict.cursor,
        reason=AdvanceReason.TRACK_ENDED.value,
        detail={"matched": verdict.matched, "note": verdict.note},
    )
    if verdict.completed:
        await _finish(state)
        await db.record_event(state.run_id, "completed", cursor=verdict.cursor,
                              reason="history_sync")
    return verdict


async def pause(session: Session, state: RunState) -> None:
    """Stop driving playback but keep the deck exactly where it is."""
    caps = session.provider.capabilities
    if caps.playback is PlaybackControl.REMOTE_DEVICE:
        try:
            await session.provider.pause(session.token, device_id=state.device_id)
        except ProviderError as exc:
            logger.info("pause ignored by provider: %s", exc)
    await db.update_run(state.run_id, status=RunStatus.PAUSED.value)
    await db.record_event(state.run_id, "paused", cursor=state.cursor)


async def cancel(session: Session, state: RunState) -> None:
    """Abandon the deck.  A future start deals a new one."""
    caps = session.provider.capabilities
    if caps.playback is PlaybackControl.REMOTE_DEVICE:
        # The device may already be gone; cancelling the deck must still work.
        with contextlib.suppress(ProviderError):
            await session.provider.pause(session.token, device_id=state.device_id)
    await db.update_run(state.run_id, status=RunStatus.CANCELLED.value)
    await db.record_event(state.run_id, "cancelled", cursor=state.cursor)


async def _finish(state: RunState) -> None:
    await db.update_run(state.run_id, status=RunStatus.COMPLETED.value)
    state.status = RunStatus.COMPLETED


# ---------------------------------------------------------------------------
# Presentation helpers
# ---------------------------------------------------------------------------

def _sample_order(order: List[str], bars: int) -> List[str]:
    """Evenly spaced track ids, at most *bars* of them.

    The rack draws one spine per bar; a 1 500-track deck must not ship 1 500
    ids every four seconds just to colour them.
    """
    if not order:
        return []
    if len(order) <= bars:
        return list(order)
    step = len(order) / bars
    return [order[int(i * step)] for i in range(bars)]


async def describe(
    session: Optional[Session],
    state: RunState,
    *,
    window: int = 8,
    rack_bars: int = 96,
) -> Dict[str, Any]:
    """Build the JSON payload the player UI renders.

    Metadata for the visible window only — resolving 1 500 titles to show 8 of
    them would be absurd.
    """
    # +1 because the window below renders cursor+1 … cursor+window inclusive;
    # without it the last row of "up next" shows a bare track id.
    ids = state.order[max(0, state.cursor - 1) : state.cursor + window + 1]
    meta: Dict[str, Track] = {}
    if session and ids:
        try:
            meta = await session.provider.resolve_tracks(session.token, ids)
        except ProviderError as exc:
            logger.info("track metadata unavailable: %s", exc)

    def _entry(index: int) -> Optional[Dict[str, Any]]:
        if not 0 <= index < state.total:
            return None
        track_id = state.order[index]
        t = meta.get(track_id)
        return {
            "index": index,
            "id": track_id,
            "name": t.name if t else "",
            "artist": t.artist if t else "",
            "duration_ms": t.duration_ms if t else 0,
            "artwork_url": t.artwork_url if t else "",
        }

    return {
        "run_id": state.run_id,
        "provider": state.provider,
        "playlist_id": state.playlist_id,
        "playlist_name": state.playlist_name,
        "mode": state.mode.value,
        "status": state.status.value,
        "cursor": state.cursor,
        "total": state.total,
        "remaining": state.remaining,
        "progress_pct": state.progress_pct,
        "device_id": state.device_id,
        # Evenly spaced ids so the UI can tint one spine per bar without
        # shipping 1 500 ids on every poll.
        "order_sample": _sample_order(state.order, rack_bars),
        "current": _entry(state.cursor),
        "upcoming": [
            e for e in (_entry(i) for i in range(state.cursor + 1,
                                                 state.cursor + 1 + window))
            if e
        ],
    }


async def resolve_playlist(session: Session, playlist_id: str) -> PlaylistRef:
    try:
        return await session.provider.get_playlist(session.token, playlist_id)
    except ProviderError:
        # Providers that cannot fetch a single playlist still deserve a run.
        return PlaylistRef(
            provider=session.provider_id, id=playlist_id, name=playlist_id
        )


_advance_locks: Dict[int, asyncio.Lock] = {}


def advance_lock(run_id: int) -> asyncio.Lock:
    """Serialise cursor moves for a run.

    Without this, a browser "track ended" event and the server-side watcher can
    both advance the same run within milliseconds and burn two cards for one
    song — the single nastiest bug class in this design.
    """
    lock = _advance_locks.get(run_id)
    if lock is None:
        lock = asyncio.Lock()
        _advance_locks[run_id] = lock
    return lock
