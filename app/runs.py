"""Run service — where the pure engine meets providers and the database.

Everything that mutates a run goes through here, so the cursor can only ever
move in one well-audited place.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

import aiosqlite

from app import db, migrations
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
    SkipReason,
    Track,
)
from core.selection import Candidate, Rules, draw_seed, plan_cycle
from core.shuffle import dedup_tracks, filter_valid_tracks, new_seed
from providers.base import (
    PlaybackControl,
    ProviderContentUnavailable,
    ProviderError,
    Unsupported,
)

logger = logging.getLogger(__name__)

#: Structured trail of every command we send to a provider player.  One
#: correlation id per :func:`_apply` call, so a live log can be lined up 1:1
#: against playback observations.  Never logs tokens, account ids or device
#: names — run ids, cursors and track ids only (track ids are public
#: catalogue data).
_command_log = logging.getLogger("ts.provider.command")

#: ADR-002 window tracking: ``run_id → cursor`` at which the last uris window
#: was asserted on the provider.  Deliberately in-memory (like the advance
#: locks): after a restart nothing is known to be set, so the first
#: start/advance simply asserts a fresh window.
_window_anchors: Dict[int, int] = {}


def _remember_window(run_id: int, anchor: int) -> None:
    _window_anchors[run_id] = anchor


def _forget_window(run_id: int) -> None:
    _window_anchors.pop(run_id, None)

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
# Creating a run (WP3-D2: create_run_v3 is the real path, build_run a wrapper)
# ---------------------------------------------------------------------------

#: ``snapshot_items.availability`` → the :class:`SkipReason` the v2 surfaces
#: (player "Ausschuss" panel, ``skipped_tracks``) already speak.  The inverse
#: of ``library_service._AVAILABILITY``.
_AVAILABILITY_SKIP: Dict[str, SkipReason] = {
    "local": SkipReason.LOCAL_FILE,
    "unavailable": SkipReason.NOT_PLAYABLE,
    "wrong_kind": SkipReason.WRONG_KIND,
    "missing_id": SkipReason.MISSING_ID,
    "not_music": SkipReason.NOT_MUSIC,
}


async def _load_rules(user_id: int, config_id: Optional[int]) -> Tuple[int, Rules]:
    """Resolve the effective (config_id, Rules) for a new run.

    ``config_id=None`` binds to the user's behaviour-neutral legacy preset
    („Ohne Wiederholungen", M003) — exactly what ``db.create_run`` has done
    since WP3-A, so pre-v3 callers keep today's behaviour.  Ownership is
    checked: a foreign config behaves like a missing one.
    """
    conn = db.get_db()
    if config_id is None:
        config_id = await migrations.ensure_legacy_config(conn, user_id)
        await conn.commit()
    cfg = await db.get_config(config_id)
    if cfg is None or int(cfg["user_id"]) != user_id:
        raise ProviderError("Diese Konfiguration gibt es nicht.")
    return config_id, Rules.from_json(cfg["rules_json"])


def _translate_previous_order(
    previous: Optional[List[str]], by_provider_id: Dict[str, int]
) -> Optional[List[int]]:
    """Map a previous cycle's provider-id order onto THIS run's run_track ids.

    The similarity guard compares position-wise; ids that do not exist in this
    deck become ``-1`` (a value no candidate carries), so they simply never
    match.  ``None`` stays ``None`` — no previous order, no guard.
    """
    if not previous:
        return None
    return [by_provider_id.get(track_id, -1) for track_id in previous]


async def create_run_v3(
    session: Session,
    playlist: PlaylistRef,
    mode: RunMode,
    *,
    name: Optional[str] = None,
    config_id: Optional[int] = None,
    tracks: Optional[List[Track]] = None,
    on_progress: Optional[ProgressFn] = None,
) -> Tuple[RunState, List[SkippedEntry]]:
    """Create a NEW run — always (UC-16).  Never resumes, never cancels.

    The v3 creation path:

    * **Candidates** come from the newest READY snapshot of the playlist when
      one exists (UC-03: the imported library is the source of truth), with
      the config's ``duplicate_policy`` applied (F3: collapse by default,
      ``keep_entries`` keeps each entry under its ``entry_uid``).  Without a
      snapshot the playlist is live-loaded exactly as before (and collapsed —
      live loading has no stable entry identity, only an import does).
    * **Deck**: one ``run_tracks`` row per candidate (state 'open',
      ``source_snapshot_id`` set when a snapshot fed it).
    * **Plan**: materialised via :func:`core.selection.plan_cycle` with the
      rules from the config's frozen ``rules_json`` — the no_repeat path is a
      full guarded permutation, so the similarity guard (scoped to the config,
      Blueprint §5.3) keeps working.  ``order_json`` is dual-written and stays
      the authoritative order for playback until M009.
    * **run_selections** rows are deliberately NOT written here: the plan
      materialisation carries the evidence for a pre-dealt cycle; per-draw
      ledger entries arrive with the select_next integration (WP3-D3).
    * **Status**: 'active', unless another controller run is already actively
      playing for this (user, provider) — then the run starts 'paused', because
      ``idx_runs_one_playing`` (SP-003) allows only one driver per device.
    """
    user_id = session.user_id
    provider_id = session.provider_id

    # A playlist the service will not open is a dead end, and finding that out
    # after a progress bar and a spinner is worse than being told up front.
    if not playlist.readable:
        raise ProviderContentUnavailable(
            playlist.unreadable_reason
            or "Dieser Dienst gibt den Inhalt dieser Playlist nicht heraus."
        )

    config_id, rules = await _load_rules(user_id, config_id)

    #: deck entries: {"track_pk", "provider_track_id", "entry_uid", "source_snapshot_id"}
    deck: List[Dict[str, Any]] = []
    skipped: List[SkippedEntry] = []
    snapshot_id: Optional[int] = None

    snapshot = await db.latest_ready_snapshot(user_id, provider_id, playlist.id)
    if snapshot is not None:
        snapshot_id = int(snapshot["id"])
        items = await db.snapshot_items_with_tracks(snapshot_id)
        seen_pks: set[int] = set()
        for item in items:
            track = Track(
                provider=provider_id, id=item["provider_track_id"],
                name=item["name"], artist=item["artist"], album=item["album"],
                duration_ms=item["duration_ms"],
            )
            if item["availability"] != "playable":
                # F3/UC-03: unplayable entries stay persisted in the snapshot;
                # for THIS run they are excluded ('exclude' and
                # 'retry_next_cycle' alike — re-entry on sync is WP3-D3).
                reason = _AVAILABILITY_SKIP.get(
                    item["availability"], SkipReason.NOT_PLAYABLE
                )
                skipped.append(SkippedEntry(track=track, reason=reason))
                continue
            if rules.duplicate_policy == "collapse":
                if item["track_pk"] in seen_pks:
                    skipped.append(
                        SkippedEntry(track=track, reason=SkipReason.DUPLICATE)
                    )
                    continue
                seen_pks.add(item["track_pk"])
                entry_uid = ""
            else:  # keep_entries: every occurrence is its own card (F3)
                entry_uid = item["entry_uid"]
            deck.append({
                "track_pk": item["track_pk"],
                "provider_track_id": item["provider_track_id"],
                "entry_uid": entry_uid,
                "source_snapshot_id": snapshot_id,
            })
    else:
        if tracks is None:
            tracks = await load_tracks(session, playlist, on_progress=on_progress)
        if not tracks:
            raise ProviderError("Diese Playlist enthält keine Titel.")
        valid, dropped = filter_valid_tracks(tracks)
        # Live loading has no entry identity, so duplicates always collapse
        # here; ``keep_entries`` needs an import (snapshot_items.entry_uid).
        deduped, dupes = dedup_tracks(valid)
        skipped = dropped + dupes
        conn = db.get_db()
        for t in deduped:
            track_pk = await migrations.ensure_track(
                conn, provider_id, t.id, name=t.name, artist=t.artist,
                album=t.album, duration_ms=t.duration_ms, is_local=t.is_local,
            )
            deck.append({
                "track_pk": track_pk,
                "provider_track_id": t.id,
                "entry_uid": "",
                "source_snapshot_id": None,
            })
        await conn.commit()

    if not deck:
        raise ProviderError(
            "Nach dem Aussortieren blieb kein spielbarer Titel übrig — jeder "
            "Eintrag war eine lokale Datei, nicht verfügbar oder kein Musiktitel."
        )

    if on_progress:
        await on_progress(len(deck), len(deck), "shuffling")

    base_name = (name or playlist.name or playlist.id).strip()[:120] or playlist.id
    run_name = await db.unique_run_name(user_id, playlist.id, base_name)

    # SP-003 / idx_runs_one_playing: only one controller run may actively play
    # per (user, provider).  A new run next to a playing one starts paused —
    # honest and resumable — instead of dying on the unique index.
    status = RunStatus.ACTIVE
    if (
        mode is RunMode.CONTROLLER
        and await db.count_active_controller_runs(user_id, provider_id) > 0
    ):
        status = RunStatus.PAUSED

    seed = new_seed()
    run_id = await db.create_run(
        user_id=user_id,
        provider=provider_id,
        playlist_id=playlist.id,
        playlist_name=playlist.name,
        mode=mode.value,
        order=[],
        seed=seed,
        status=status.value,
        name=run_name,
        config_id=config_id,
        snapshot_id=snapshot_id,
    )
    try:
        run_track_ids = await db.create_run_deck(run_id, deck)
        by_run_track: Dict[int, str] = {}
        by_provider_id: Dict[str, int] = {}
        candidates: List[Candidate] = []
        for rt_id, entry in zip(run_track_ids, deck, strict=True):
            by_run_track[rt_id] = entry["provider_track_id"]
            by_provider_id.setdefault(entry["provider_track_id"], rt_id)
            candidates.append(Candidate(
                run_track_id=rt_id,
                track_key=f"{provider_id}:{entry['provider_track_id']}",
            ))

        previous = await db.latest_completed_order(
            user_id, provider_id, playlist.id, config_id=config_id
        )
        plan = plan_cycle(
            candidates, rules, seed,
            previous_order=_translate_previous_order(previous, by_provider_id),
        )
        order = [by_run_track[rt_id] for rt_id in plan]
        await db.write_run_plan(run_id, plan, plan_version=1, start_seq=0)
        # Dual write: order_json remains the authoritative playback order
        # until M009; run_plan is its v3 twin.
        await db.update_run(run_id, order=order, cursor=0)
        await db.record_skipped(run_id, _skipped_rows(skipped))
        await db.record_event(
            run_id, "run_created", cursor=0,
            detail={
                "total": len(order), "skipped": len(skipped), "seed": seed,
                "name": run_name, "config_id": config_id, "cycle": 1,
                "snapshot_id": snapshot_id, "status": status.value,
            },
        )
    except BaseException:
        # Never leave a half-created run behind: the shell row without deck,
        # plan and order would look like a resumable run and is not.
        await db.hard_delete_run(run_id)
        raise

    state = RunState(
        run_id=run_id,
        user_id=user_id,
        provider=provider_id,
        playlist_id=playlist.id,
        playlist_name=playlist.name,
        mode=mode,
        order=order,
        cursor=0,
        status=status,
        seed=seed,
    )
    return state, skipped


async def build_run(
    session: Session,
    playlist: PlaylistRef,
    mode: RunMode,
    *,
    tracks: Optional[List[Track]] = None,
    on_progress: Optional[ProgressFn] = None,
    reshuffle: bool = False,
    name: Optional[str] = None,
    config_id: Optional[int] = None,
) -> Tuple[RunState, List[SkippedEntry]]:
    """DEPRECATED (WP3-D2) — thin compatibility wrapper over :func:`create_run_v3`.

    v2's "resume by default via find_live_run" is ambiguous once several live
    runs per playlist are legal (UC-16, Blueprint §5.2).  The wrapper keeps
    the existing call sites working under an explicit rule:

    * exactly ONE live run → resume it (the v2 main case, unchanged);
    * NO live run → create a new one (:func:`create_run_v3`);
    * SEVERAL live runs → refuse with a pointer to the explicit choice
      (``POST /api/runs/{id}/resume`` / the dashboard) — silently picking the
      newest would resume a run the listener may not mean;
    * ``reshuffle=True`` keeps its v2 semantics (cancel the live runs of this
      combination, then deal fresh) so existing callers and tests stay valid.
      New code should create an independent run instead (UC-16) and leave
      running ones alone.
    """
    user_id = session.user_id
    provider_id = session.provider_id

    if reshuffle:
        await db.close_live_runs(user_id, provider_id, playlist.id, mode.value)
    else:
        live = await db.list_live_runs(user_id, provider_id, playlist.id, mode.value)
        if len(live) == 1:
            return _to_state(live[0]), []
        if len(live) > 1:
            raise engine.RunError(
                "Für diese Playlist laufen mehrere Hörvorgänge. Wähl im "
                "Dashboard aus, welcher fortgesetzt werden soll, oder leg "
                "einen neuen mit eigenem Namen an."
            )

    return await create_run_v3(
        session, playlist, mode,
        name=name, config_id=config_id, tracks=tracks, on_progress=on_progress,
    )


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
        # ADR-002: which window this process last asserted, if any.
        window_anchor=_window_anchors.get(row["id"]),
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
) -> Optional[str]:
    """Push a decision to a REMOTE_DEVICE provider.

    ADR-002: at most ONE command leaves here — either a play carrying the
    whole uris window, or the lightweight ``next`` for a TS skip inside the
    window.  ``POST /queue`` is never used any more; the user's queue belongs
    to the user.  Returns which command was sent (``"play"`` / ``"skip"``) so
    the caller can track the asserted window, or ``None``.

    Web-player providers get the decision as JSON instead; the browser does
    the playing, so there is nothing to push.
    """
    caps = session.provider.capabilities
    if caps.playback is not PlaybackControl.REMOTE_DEVICE:
        return None
    if not decision.play_track_id:
        return None

    correlation_id = uuid.uuid4().hex[:8]
    window = decision.play_window or [decision.play_track_id]

    if decision.needs_override or force_override:
        _command_log.info(
            "corr=%s run=%s kind=play target=%s cursor=%s window=%s offset=0",
            correlation_id, state.run_id, decision.play_track_id,
            decision.cursor, len(window),
        )
        await session.provider.play(
            session.token, track_ids=window, offset_position=0,
            device_id=device_id,
        )
        return "play"

    if decision.use_skip_next:
        try:
            _command_log.info(
                "corr=%s run=%s kind=next target=%s cursor=%s",
                correlation_id, state.run_id, decision.play_track_id,
                decision.cursor,
            )
            await session.provider.skip_next(session.token, device_id=device_id)
            return "skip"
        except Unsupported:
            # No skip command on this provider — assert the window instead.
            _command_log.info(
                "corr=%s run=%s kind=play target=%s cursor=%s window=%s offset=0 "
                "note=skip_next-unsupported",
                correlation_id, state.run_id, decision.play_track_id,
                decision.cursor, len(window),
            )
            await session.provider.play(
                session.token, track_ids=window, offset_position=0,
                device_id=device_id,
            )
            return "play"

    return None


async def start(
    session: Session,
    state: RunState,
    *,
    device_id: Optional[str] = None,
) -> Decision:
    """Begin or resume a run and, for remote providers, take over the device."""
    settings = get_settings()
    decision = engine.start(state, window_size=settings.context_window_size)

    if decision.completed:
        await _finish(state)
        return decision

    if state.status is RunStatus.PAUSED:
        try:
            await db.update_run(state.run_id, status=RunStatus.ACTIVE.value)
        except aiosqlite.IntegrityError as exc:
            # idx_runs_one_playing (SP-003): another controller run actively
            # drives this provider.  A 409 sentence, not a bare 500.  The F8
            # takeover state machine (WP3-D3) will replace this refusal with
            # the manual_state hand-over.
            raise engine.RunError(
                "Ein anderer Hörvorgang steuert gerade die Wiedergabe — "
                "stoppe oder pausiere ihn zuerst."
            ) from exc
        state.status = RunStatus.ACTIVE

    if device_id:
        await db.update_run(state.run_id, device_id=device_id)
        state.device_id = device_id

    command = await _apply(session, state, decision,
                           device_id=device_id or state.device_id,
                           force_override=True)
    if command == "play":
        _remember_window(state.run_id, state.cursor)
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
        state, reason=reason, window_size=settings.context_window_size, steps=steps
    )

    if decision.completed:
        await db.update_run(state.run_id, cursor=decision.cursor)
        state.cursor = decision.cursor
        await _finish(state)
        await db.record_event(
            state.run_id, "completed", cursor=decision.cursor, reason=reason.value
        )
        return decision

    # ADR-002 Auflage 1: the command goes out BEFORE the cursor is persisted.
    # A device that is gone (404 / no active device) fails the command, the
    # cursor stays put, and no card is consumed — the watcher then sees idle
    # (Zustand D) instead of a silently burnt title.
    command = await _apply(session, state, decision,
                           device_id=device_id or state.device_id)
    await db.update_run(state.run_id, cursor=decision.cursor)
    state.cursor = decision.cursor
    if command == "play":
        _remember_window(state.run_id, decision.cursor)

    await db.record_event(
        state.run_id, "advanced", cursor=decision.cursor, reason=reason.value,
        detail={"track_id": decision.play_track_id},
    )
    return decision


async def previous(
    session: Session, state: RunState, *, device_id: Optional[str] = None
) -> Decision:
    """Step one card back — as a REPLAY, never an un-play (Blueprint §5.2).

    ``engine.previous`` still moves the cursor backwards; that is the
    order_json world and it stays until M009.  What WP3-D2 changes is the
    bookkeeping: the v3 ledger records a ``replayed`` event, the plan row of
    the replayed card becomes 'current' again, and ``run_tracks`` is NOT
    touched — ``play_count`` stays, nothing is silently un-played.  Otherwise
    repeated back-jumping could launder the no-repeat invariant.
    """
    settings = get_settings()
    old_cursor = state.cursor
    decision = engine.previous(state, window_size=settings.context_window_size)
    # Same order as advance(): command first, cursor second (ADR-002 Auflage 1).
    command = await _apply(session, state, decision,
                           device_id=device_id or state.device_id,
                           force_override=True)
    await db.update_run(state.run_id, cursor=decision.cursor)
    state.cursor = decision.cursor
    if command == "play":
        _remember_window(state.run_id, decision.cursor)
    if decision.advanced:
        await _mark_plan_replay(state.run_id, decision.cursor, old_cursor)
        await db.record_event(
            state.run_id, "replayed", cursor=decision.cursor,
            reason=AdvanceReason.MANUAL.value,
            detail={"track_id": decision.play_track_id, "from_cursor": old_cursor},
        )
    return decision


async def _mark_plan_replay(run_id: int, new_cursor: int, old_cursor: int) -> None:
    """Flip the plan row of the replayed card back to 'current'.

    Cursor N maps onto the N-th row of the *current* plan version (the seq
    values themselves are the run-wide plan clock and restart nowhere).  Runs
    without plan rows — pre-D2 test fixtures, imported runs — skip silently:
    order_json remains their only order until M009.
    """
    run = await db.get_run(run_id)
    if run is None:
        return
    rows = await db.list_run_plan(run_id, plan_version=run["plan_version"])
    if not rows or new_cursor >= len(rows):
        return
    await db.set_plan_state(run_id, rows[new_cursor]["seq"], "current")
    if old_cursor != new_cursor and old_cursor < len(rows):
        # The card we stepped away from is planned again — it will come back
        # after the replay, exactly like the order_json cursor will reach it.
        await db.set_plan_state(run_id, rows[old_cursor]["seq"], "planned")


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


async def resume(session: Session, state: RunState) -> RunState:
    """Lift a stopped run back to active at exactly the same card (F1).

    Minimal on purpose (WP3-A): the status transition plus its ledger entry.
    Re-asserting playback on a device is what the caller's subsequent
    :func:`start` does — a stopped run has no device any more.
    """
    new_status = engine.resume_status(state)
    if state.status is not new_status:
        await db.update_run(state.run_id, status=new_status.value)
        state.status = new_status
        await db.record_event(state.run_id, "resumed", cursor=state.cursor)
    return state


# ---------------------------------------------------------------------------
# Lifecycle v3 (WP3-D2): stop / resume / reset / delete
# ---------------------------------------------------------------------------

async def stop_run(session: Session, state: RunState) -> RunState:
    """F1 (ADR-003): deliberate session end — stopped, not dead.

    active/paused → stopped: the watcher deregisters, the device is released
    (``device_id`` cleared), ``stopped_at`` is stamped, and the run leaves the
    "Jetzt" surface for "Fortsetzen".  Fully resumable at exactly this card.
    Stopping an already-stopped run is a no-op; completed/cancelled refuse
    with their usual text.
    """
    if state.status is RunStatus.STOPPED:
        return state  # idempotent — a second stop must not error or re-stamp
    engine.ensure_live(state)  # completed/cancelled → RunError (their own text)

    # Lazy import: app.watcher imports this module, so a top-level import
    # would be circular.  The service still owns the whole transition.
    from app.watcher import watcher
    await watcher.stop(state.run_id)

    caps = session.provider.capabilities
    if caps.playback is PlaybackControl.REMOTE_DEVICE:
        # The device may already be gone; stopping the run must still work.
        with contextlib.suppress(ProviderError):
            await session.provider.pause(session.token, device_id=state.device_id)

    await db.update_run(state.run_id, status=RunStatus.STOPPED.value,
                        clear_device=True)
    state.status = RunStatus.STOPPED
    state.device_id = None
    _forget_window(state.run_id)
    await db.record_event(state.run_id, "stopped", cursor=state.cursor)
    return state


async def resume_run(session: Session, run_id: int) -> Optional[RunState]:
    """Explicit resume by run id (WP3-D2 — replaces find_live_run guessing).

    stopped → active (F1) and paused → active; truly terminal statuses raise
    ``RunError`` via :func:`engine.resume_status`.  Deliberately does NOT
    start playback — re-asserting a device is what a subsequent
    :func:`start` does; a stopped run has no device any more.

    Returns ``None`` when the run does not exist for this user (the caller's
    404), the resumed state otherwise.
    """
    state = await get_state(run_id, session.user_id)
    if state is None:
        return None
    new_status = engine.resume_status(state)
    if state.status is not new_status:
        try:
            await db.update_run(run_id, status=new_status.value)
        except aiosqlite.IntegrityError as exc:
            # idx_runs_one_playing: another controller run is actively playing
            # for this (user, provider).  A German sentence, not a 500.
            raise engine.RunError(
                "Ein anderer Hörvorgang steuert gerade die Wiedergabe — "
                "stoppe oder pausiere ihn zuerst."
            ) from exc
        state.status = new_status
        await db.record_event(run_id, "resumed", cursor=state.cursor)
    return state


async def reset_run(session: Session, state: RunState) -> Dict[str, Any]:
    """F2 (ADR-003) / UC-15: start the next cycle — history stays.

    * ``cycle + 1``; every admitted deck card back to 'open'
      (``play_count`` stays cumulative, ``last_played_seq`` clears);
    * a NEW plan via :func:`plan_cycle` under a fresh per-cycle draw seed
      (``draw_seed(seed, cycle)``), appended after the old plan's seq range;
    * old plan rows become 'discarded' (never deleted — RUN-04/05 evidence);
    * ``plan_version + 1``, ``order_json`` re-written, cursor back to 0;
    * ``run_events`` / ``run_selections`` untouched, event ``cycle_reset``.

    The reset run returns to 'active'; when another controller run already
    actively plays (idx_runs_one_playing) it lands on 'paused' instead —
    resumable, honest, no IntegrityError.
    """
    run = await db.get_run(state.run_id, user_id=state.user_id)
    if run is None:
        raise engine.RunError("Diesen Lauf gibt es nicht mehr.")
    if run["status"] == RunStatus.CANCELLED.value:
        raise engine.RunError("Dieser Lauf wurde beendet.")

    _, rules = await _load_rules(state.user_id, run["config_id"])

    reopened = await db.reopen_run_tracks(state.run_id)
    deck = await db.list_run_tracks(state.run_id, states=["open"], admitted_only=True)
    if not deck:
        raise ProviderError(
            "Für einen neuen Durchlauf ist kein Titel offen — dieser "
            "Hörvorgang hat keine spielbaren Karten (mehr)."
        )

    new_cycle = int(run["cycle"]) + 1
    # Fresh per-cycle draw seed, derived from the run's master seed (F2/P3):
    # the new cycle shuffles differently but reproducibly.
    cycle_seed = (
        draw_seed(int(run["seed"]), new_cycle)
        if run["seed"] is not None else new_seed()
    )

    by_run_track = {int(r["id"]): str(r["provider_track_id"]) for r in deck}
    by_provider_id: Dict[str, int] = {}
    for r in deck:
        by_provider_id.setdefault(str(r["provider_track_id"]), int(r["id"]))
    candidates = [
        Candidate(
            run_track_id=int(r["id"]),
            track_key=f"{run['provider']}:{r['provider_track_id']}",
            favorite=bool(r["favorite"]),
            weight=float(r["weight"]),
        )
        for r in deck
    ]
    plan = plan_cycle(
        candidates, rules, cycle_seed,
        # The finished cycle's own order is the similarity reference: the next
        # cycle must not open like the last one did (same guard as creation).
        previous_order=_translate_previous_order(run["order"], by_provider_id),
    )
    order = [by_run_track[rt_id] for rt_id in plan]

    await db.discard_run_plan(state.run_id)
    start_seq = await db.max_plan_seq(state.run_id) + 1
    new_plan_version = int(run["plan_version"]) + 1
    await db.write_run_plan(state.run_id, plan, plan_version=new_plan_version,
                            start_seq=start_seq)

    status = RunStatus.ACTIVE
    try:
        await db.update_run(
            state.run_id, status=status.value, cursor=0, order=order,
            cycle=new_cycle, plan_version=new_plan_version,
        )
    except aiosqlite.IntegrityError:
        # idx_runs_one_playing — the reset still succeeds, just not as the
        # active driver of the device.
        status = RunStatus.PAUSED
        await db.update_run(
            state.run_id, status=status.value, cursor=0, order=order,
            cycle=new_cycle, plan_version=new_plan_version,
        )

    state.order = order
    state.cursor = 0
    state.status = status
    _forget_window(state.run_id)
    await db.record_event(
        state.run_id, "cycle_reset", cursor=0,
        detail={
            "cycle": new_cycle, "plan_version": new_plan_version,
            "seed": cycle_seed, "total": len(order), "reopened": reopened,
            "status": status.value,
        },
    )
    return {
        "run_id": state.run_id,
        "status": status.value,
        "cycle": new_cycle,
        "plan_version": new_plan_version,
        "cursor": 0,
        "total": len(order),
    }


async def delete_run(user_id: int, run_id: int) -> bool:
    """UC-26 step 1: soft delete.  ``archived_at`` is stamped, the run leaves
    every listing, watcher and window are released — but nothing is destroyed
    until the listener confirms (:func:`hard_delete_run`).

    Returns False when the run does not exist for this user (the caller's 404).
    """
    run = await db.get_run(run_id, user_id=user_id)
    if run is None:
        return False

    from app.watcher import watcher  # lazy — see stop_run
    await watcher.stop(run_id)
    _forget_window(run_id)

    if run["archived_at"]:
        return True  # idempotent — archiving twice must not re-stamp
    await db.update_run(run_id, archive=True)
    await db.record_event(run_id, "archived", cursor=run["cursor"])
    return True


async def hard_delete_run(user_id: int, run_id: int) -> bool:
    """UC-26 step 2: confirmed hard deletion of exactly this run.

    Cascades take run_tracks / run_plan / run_selections / run_events /
    skipped_tracks with it; the imported library (playlists, snapshots,
    tracks) is only referenced and stays untouched (RUN-12).
    """
    run = await db.get_run(run_id, user_id=user_id)
    if run is None:
        return False

    from app.watcher import watcher  # lazy — see stop_run
    await watcher.stop(run_id)
    _forget_window(run_id)

    await db.hard_delete_run(run_id)
    logger.info("run %s hard-deleted for user %s", run_id, user_id)
    return True


async def cancel(session: Session, state: RunState) -> None:
    """Abandon the deck.  A future start deals a new one."""
    caps = session.provider.capabilities
    if caps.playback is PlaybackControl.REMOTE_DEVICE:
        # The device may already be gone; cancelling the deck must still work.
        with contextlib.suppress(ProviderError):
            await session.provider.pause(session.token, device_id=state.device_id)
    await db.update_run(state.run_id, status=RunStatus.CANCELLED.value)
    _forget_window(state.run_id)
    await db.record_event(state.run_id, "cancelled", cursor=state.cursor)


async def _finish(state: RunState) -> None:
    await db.update_run(state.run_id, status=RunStatus.COMPLETED.value)
    state.status = RunStatus.COMPLETED
    _forget_window(state.run_id)


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
