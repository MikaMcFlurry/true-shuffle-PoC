"""Run service — where the pure engine meets providers and the database.

Everything that mutates a run goes through here, so the cursor can only ever
move in one well-audited place.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from dataclasses import replace
from datetime import UTC, datetime
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
from core.selection import (
    PLAN_HORIZON,
    QUOTA_WINDOW,
    Candidate,
    Rules,
    apply_skip,
    draw_seed,
    plan_cycle,
    select_next,
)
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


#: Advance reasons that consume the card like a natural end (ADR-003 F4): the
#: card was PLAYED, not skipped — the skip policy never applies to these.
#: A user skip (user_skip / manual / native_skip) counts per skip_policy.
_CONSUME_REASONS = frozenset({
    AdvanceReason.TRACK_ENDED,
    AdvanceReason.PLAYBACK_FAILED,
    AdvanceReason.RESYNC,
})


async def _effective_rules(
    run: Dict[str, Any], seq: int
) -> Tuple[Optional[int], str, Rules]:
    """The rule version governing draw *seq* of this run (UC-27).

    Resolution order: newest ``run_rule_bindings`` row with
    ``effective_from_seq <= seq`` (a run-local rule change) → the config's
    current version → behaviour-neutral defaults for pre-v3 shells without a
    config.  Selections already booked keep the version they recorded —
    a rule change never rewrites history (Blueprint §2.2).
    """
    binding = await db.latest_rule_binding(int(run["id"]), seq)
    if binding is not None:
        return (
            int(binding["config_version_id"]),
            str(binding["rules_hash"]),
            Rules.from_json(binding["rules_json"]),
        )
    if run.get("config_id"):
        cfg = await db.get_config(int(run["config_id"]))
        if cfg is not None:
            return (
                int(cfg["config_version_id"]),
                str(cfg["rules_hash"]),
                Rules.from_json(cfg["rules_json"]),
            )
    rules = Rules()
    return None, rules.rules_hash(), rules


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
            # Real selection clock (WP3-C, Befund 6): a fresh run books its
            # first draw at selection_seq=1, so the plan simulates from 1.
            start_seq=1,
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


async def _slot_conflict(user_id: int, provider: str) -> engine.RunError:
    """The idx_runs_one_playing 409 sentence, naming the blocking run.

    WP3-D3: "ein anderer Hörvorgang" without saying WHICH one sends the
    listener hunting through the dashboard — the blocker has a name (UC-16),
    so the refusal uses it.
    """
    blocker = await db.active_controller_run(user_id, provider)
    who = ""
    if blocker is not None:
        name = blocker.get("name") or blocker.get("playlist_name") or ""
        if name:
            who = f" („{name}“)"
    return engine.RunError(
        f"Ein anderer Hörvorgang{who} steuert gerade die Wiedergabe — "
        "stoppe oder pausiere ihn zuerst."
    )


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
            # drives this provider.  A 409 sentence naming the blocker, not a
            # bare 500.
            raise await _slot_conflict(state.user_id, state.provider) from exc
        state.status = RunStatus.ACTIVE

    if device_id:
        await db.update_run(state.run_id, device_id=device_id)
        state.device_id = device_id

    # F8: a start IS the listener's decision to take the playback back — the
    # manual episode (detected / awaiting_decision / suspended) ends here,
    # and the ledger says so (manual_resumed).
    run = await db.get_run(state.run_id)
    if run is not None and str(run.get("manual_state") or MANUAL_NONE) != MANUAL_NONE:
        await db.update_run(
            state.run_id, manual_state=MANUAL_NONE, clear_manual_since=True
        )
        await _record_keyed_event(
            state.run_id, "manual_resumed",
            key=f"manual:{state.run_id}:{run.get('selection_seq') or 0}:resumed",
            cursor=state.cursor,
            detail={"action": "start", "from": run.get("manual_state")},
        )

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


def _signed64(value: int) -> int:
    """Reinterpret an unsigned 64-bit value as SQLite's signed INTEGER.

    :func:`core.selection.draw_seed` yields the full unsigned range; SQLite
    INTEGER is signed 64-bit and overflows above 2^63-1.  Two's complement
    keeps the round trip lossless: ``value & MASK64`` restores the draw seed.
    """
    value &= 0xFFFFFFFFFFFFFFFF
    return value - (1 << 64) if value >= (1 << 63) else value


def _stale_decision(state: RunState, reason: AdvanceReason) -> Decision:
    """F5: the ledger already holds this transition — answer with the existing
    state instead of applying it a second time (SP-004/005)."""
    return Decision(
        cursor=state.cursor,
        play_track_id=state.current_track_id,
        advanced=False,
        needs_override=False,
        reason=reason,
        note="stale: transition already applied (F5 ledger)",
    )


async def _book_advance(
    run: Dict[str, Any],
    state: RunState,
    decision: Decision,
    reason: AdvanceReason,
) -> bool:
    """Book one advance in the v3 ledger (WP3-D3) — returns False on a dup.

    What gets booked, atomically (:func:`db.book_advance`):

    * the consumed plan row(s) → 'consumed', the next row → 'current';
    * the consumed card per skip policy (F4/P6 via
      :func:`core.selection.apply_skip`): a natural end is the
      consume-equivalent (played, ``play_count+1``, ``last_played_seq`` =
      the new seq); ``requeue_later``/``defer_to_end`` append the card to
      the plan end (plan extension instead of an immediate replan) and
      extend ``order_json`` — the dual source stays consistent;
    * a ``run_selections`` row under the new ``selection_seq`` (plan
      consumption: candidate evidence lives with the plan materialisation,
      so ``candidate_count=0`` / ``filtered_by={}``);
    * the ``run_events`` row under the deterministic event key
      ``run:planversion:seq:from:to`` (ADR-003 F5).  The seq component is
      the SELECTION seq, not the plan seq: a replayed card (§5.2,
      :func:`previous`) legitimately re-consumes its plan row, and a
      plan-seq key would refuse that second consumption forever — while two
      writers racing on the SAME draw still read the same selection_seq and
      collide exactly as F5 demands.

    A duplicate (UNIQUE index hit) books an ``applied=0`` / reason='stale'
    event and applies NOTHING — the caller answers with the existing state.
    """
    run_id = state.run_id
    old_cursor = state.cursor
    completed = decision.completed
    plan_version = int(run.get("plan_version") or 1)
    new_seq = int(run.get("selection_seq") or 0) + 1

    from_track = (
        state.order[old_cursor] if 0 <= old_cursor < len(state.order) else ""
    )
    to_track = (
        "end"
        if completed or decision.cursor >= len(state.order)
        else state.order[decision.cursor]
    )
    event_key = f"{run_id}:{plan_version}:{new_seq}:{from_track}:{to_track}"

    # Plan rows: everything the cursor moves past is consumed (normally one).
    consumed_rows = []
    end = min(decision.cursor, len(state.order)) if not completed else len(state.order)
    for index in range(old_cursor, max(end, old_cursor)):
        row = await db.plan_row_at(run_id, index)
        if row is None:
            break
        consumed_rows.append(row)
    next_row = None if completed else await db.plan_row_at(run_id, decision.cursor)

    card = None
    if consumed_rows:
        card = await db.find_run_track(
            run_id, run_track_id=int(consumed_rows[0]["run_track_id"])
        )
    elif from_track:
        # Legacy run without plan rows — the provider id is all we have.
        card = await db.find_run_track(run_id, provider_track_id=from_track)

    config_version_id, rules_hash, rules = await _effective_rules(run, new_seq)
    policy = "consume" if reason in _CONSUME_REASONS else rules.skip_policy

    track_update: Optional[Dict[str, Any]] = None
    plan_append: Optional[Dict[str, Any]] = None
    order: Optional[List[str]] = None
    if card is not None and card["state"] in ("open", "played", "deferred"):
        outcome = apply_skip(card["state"], policy)
        track_update = {"state": outcome.new_state, "count_play": outcome.consumed}
        wants_requeue = outcome.requeue_after_draws or outcome.requeue_at_cycle_end
        if wants_requeue and consumed_rows and not completed:
            # Plan extension instead of an immediate replan: the deferred
            # card re-enters at the end of the current plan AND of
            # order_json (the two stay index-identical).  Skipping the LAST
            # card cannot extend (the decision already completed the deck) —
            # the card stays 'deferred' and the next cycle re-opens it (F2).
            plan_append = {
                "seq": await db.max_plan_seq(run_id) + 1,
                "run_track_id": int(card["id"]),
                "plan_version": plan_version,
            }
            order = [*state.order, from_track]

    selection = {
        "run_track_id": int(card["id"]) if card else None,
        "config_version_id": config_version_id,
        "rules_hash": rules_hash,
        "seed": _signed64(draw_seed(
            int(run["seed"]) if run.get("seed") is not None else 0, new_seq
        )),
        "candidate_count": 0,
        "filtered_by_json": "{}",
    }

    booked = await db.book_advance(
        run_id,
        event_key=event_key,
        event_type="completed" if completed else "advanced",
        seq=new_seq,
        cursor=decision.cursor,
        reason=reason.value,
        detail={
            "track_id": decision.play_track_id,
            "from_track": from_track,
            "policy": policy,
        },
        status=RunStatus.COMPLETED.value if completed else None,
        order=order,
        consumed_plan_seqs=[int(r["seq"]) for r in consumed_rows],
        next_plan_seq=int(next_row["seq"]) if next_row else None,
        run_track_id=int(card["id"]) if card else None,
        track_update=track_update,
        plan_append=plan_append,
        selection=selection,
    )
    if not booked:
        await db.record_event(
            run_id, "advanced", cursor=old_cursor, reason="stale",
            detail={"duplicate_of": event_key, "reported_reason": reason.value},
            applied=False, seq=new_seq,
        )
        return False
    if order is not None:
        state.order = order
    return True


async def advance(
    session: Session,
    state: RunState,
    *,
    reason: AdvanceReason,
    device_id: Optional[str] = None,
    steps: int = 1,
) -> Decision:
    """Consume the current card and move to the next one.

    WP3-D3: the move is BOOKED, not just counted — plan row, card state per
    skip policy, ``run_selections``, ``selection_seq`` and the F5 event key
    land in one transaction (:func:`_book_advance`).  A duplicate report of
    the same transition falls off the UNIQUE index, is recorded as
    ``applied=0``/stale, and moves nothing.  ``order_json``/``cursor``
    remain the dual playback source until M009.
    """
    settings = get_settings()
    run = await db.get_run(state.run_id)
    decision = engine.advance(
        state, reason=reason, window_size=settings.context_window_size, steps=steps
    )

    if decision.completed:
        if run is not None:
            if not await _book_advance(run, state, decision, reason):
                return _stale_decision(state, reason)
        else:  # pragma: no cover — run vanished mid-flight
            await db.update_run(state.run_id, cursor=decision.cursor,
                                status=RunStatus.COMPLETED.value)
        state.cursor = decision.cursor
        state.status = RunStatus.COMPLETED
        _forget_window(state.run_id)
        return decision

    # ADR-002 Auflage 1: the command goes out BEFORE anything is persisted.
    # A device that is gone (404 / no active device) fails the command, the
    # cursor stays put, and no card is consumed — the watcher then sees idle
    # (Zustand D) instead of a silently burnt title.
    command = await _apply(session, state, decision,
                           device_id=device_id or state.device_id)
    if run is not None:
        if not await _book_advance(run, state, decision, reason):
            return _stale_decision(state, reason)
    else:  # pragma: no cover — run vanished mid-flight
        await db.update_run(state.run_id, cursor=decision.cursor)
    state.cursor = decision.cursor
    if command == "play":
        _remember_window(state.run_id, decision.cursor)
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

    Cursor N maps onto the N-th NON-discarded plan row (WP3-D3: a tail replan
    mixes plan versions, so the version alone no longer identifies the live
    rows — :func:`db.plan_row_at` carries the one mapping rule).  Runs
    without plan rows — pre-D2 test fixtures, imported runs — skip silently:
    order_json remains their only order until M009.
    """
    row_new = await db.plan_row_at(run_id, new_cursor)
    if row_new is None:
        return
    await db.set_plan_state(run_id, row_new["seq"], "current")
    if old_cursor != new_cursor:
        row_old = await db.plan_row_at(run_id, old_cursor)
        if row_old is not None:
            # The card we stepped away from is planned again — it will come
            # back after the replay, exactly like the order_json cursor will.
            await db.set_plan_state(run_id, row_old["seq"], "planned")


# ---------------------------------------------------------------------------
# Mid-run rules, favourites and exclusions (WP3-D3 — UC-08/20/21/27)
# ---------------------------------------------------------------------------

async def _replan_tail(
    run: Dict[str, Any], state: RunState, rules: Rules
) -> int:
    """Rebuild the FUTURE of the plan under *rules* (UC-27 'tail_only').

    The consumed prefix and the currently playing card stay exactly where
    they are — a rule change never rewrites history and never yanks the
    running track.  Future rows are discarded (never deleted, RUN-04/05),
    the new tail is drawn with a :func:`core.selection.select_next` loop
    against the real deck state, appended after ``max(seq)`` under
    ``plan_version + 1``, and ``order_json`` is rewritten to match — the
    dual source stays index-identical with the non-discarded plan rows.

    Draw *k* of the tail is simulated at seq ``selection_seq + k`` — the
    same clock the later advances will book, so a test can reproduce the
    tail deterministically from (master seed, selection_seq, rules, deck).

    Returns the number of newly planned rows.  Runs without plan rows
    (legacy imports) refuse honestly: their only order is order_json.
    """
    run_id = int(run["id"])
    plan_rows = await db.list_active_plan(run_id)
    if not plan_rows:
        raise engine.RunError(
            "Dieser Hörvorgang hat keinen materialisierten Plan — "
            "Regeländerungen im Lauf brauchen ein v3-Deck."
        )
    if run["status"] in (RunStatus.COMPLETED.value, RunStatus.CANCELLED.value):
        return 0

    await db.discard_planned_rows(run_id)

    deck = await db.list_run_tracks(
        run_id, states=["open", "played", "deferred"], admitted_only=True
    )
    current_rt = (
        int(plan_rows[state.cursor]["run_track_id"])
        if state.cursor < len(plan_rows) else None
    )
    provider_by_rt: Dict[int, str] = {}
    sim: Dict[int, Candidate] = {}
    for row in deck:
        if row["removed_from_snapshot"]:
            continue  # UC-04: removed from the playlist — history stays, plan not
        provider_by_rt[int(row["id"])] = str(row["provider_track_id"])
        if int(row["id"]) == current_rt:
            continue  # the playing card is already the plan's 'current' row
        last = row["last_played_seq"]
        if row["state"] == "played" and last is None:
            last = 0  # pre-D3 backfill rows — distance-free, never blocking
        sim[int(row["id"])] = Candidate(
            run_track_id=int(row["id"]),
            track_key=f"{run['provider']}:{row['provider_track_id']}",
            state=str(row["state"]),
            play_count=int(row["play_count"]),
            last_played_seq=last,
            favorite=bool(row["favorite"]),
            weight=float(row["weight"]),
        )

    master_seed = int(run["seed"]) if run.get("seed") is not None else 0
    base_seq = int(run.get("selection_seq") or 0)
    limit = len(sim) if rules.repeat_mode == "no_repeat" else min(
        PLAN_HORIZON, len(sim)
    )
    tail: List[int] = []
    repeat_window: List[int] = []
    step = 0
    while len(tail) < limit:
        # The quota window is led in integers; window_repeats / QUOTA_WINDOW
        # is the convention select_next converts back to the exact count —
        # the P7 gate itself never compares floats (WP3-C, Befund 1).
        window_repeats = sum(repeat_window[-QUOTA_WINDOW:])
        share = window_repeats / QUOTA_WINDOW
        selection = select_next(
            list(sim.values()), rules, master_seed, base_seq + 1 + step,
            recent_repeat_share=share,
        )
        step += 1
        if selection.exhausted or selection.run_track_id is None:
            break
        chosen = sim[selection.run_track_id]
        # A repeat is a draw of a card with a listening history — the same
        # convention core.selection.plan_cycle books into its window.
        repeat_window.append(1 if chosen.last_played_seq is not None else 0)
        sim[chosen.run_track_id] = replace(
            chosen, state="played", play_count=chosen.play_count + 1,
            last_played_seq=base_seq + step,
        )
        tail.append(chosen.run_track_id)

    new_pv = int(run["plan_version"]) + 1
    if tail:
        start_seq = await db.max_plan_seq(run_id) + 1
        await db.write_run_plan(
            run_id, tail, plan_version=new_pv, start_seq=start_seq, live=False
        )
    order = state.order[: state.cursor + 1] + [provider_by_rt[rt] for rt in tail]
    await db.update_run(run_id, order=order, plan_version=new_pv)
    state.order = order
    run["plan_version"] = new_pv
    run["order"] = order
    return len(tail)


async def change_run_rules(
    state: RunState, patch: Dict[str, Any]
) -> Dict[str, Any]:
    """UC-27: change the rules of a RUNNING run — versioned, effective-from.

    The patch is merged over the run's currently effective rules, frozen as
    a new run-local config version (the run's preset is never mutated — F7),
    bound via ``run_rule_bindings`` from the NEXT selection seq on, and the
    plan tail is rebuilt under the new rules.  Selections already booked
    keep the version they recorded — history untouched.

    Raises ``ValueError`` for unknown keys / invalid values (the caller's
    400) and :class:`~core.engine.RunError` for runs that cannot replan
    (the caller's 409).
    """
    run = await db.get_run(state.run_id, user_id=state.user_id)
    if run is None:
        raise engine.RunError("Diesen Lauf gibt es nicht mehr.")
    if run["status"] == RunStatus.CANCELLED.value:
        raise engine.RunError("Dieser Lauf wurde beendet.")

    seq_next = int(run.get("selection_seq") or 0) + 1
    _, _, current = await _effective_rules(run, seq_next)
    merged = Rules.from_dict({**current.to_dict(), **patch})
    conflicts = merged.validate()
    if conflicts:
        raise ValueError("; ".join(c.message for c in conflicts))

    version = await db.run_local_config_version(
        state.user_id, state.run_id, merged,
        origin_config_id=run.get("config_id"),
    )
    await db.upsert_rule_binding(
        state.run_id, int(version["config_version_id"]), seq_next, "tail_only"
    )
    replanned = await _replan_tail(run, state, merged)
    await db.record_event(
        state.run_id, "rules_changed", cursor=state.cursor,
        detail={
            "config_version_id": version["config_version_id"],
            "version": version["version"],
            "effective_from_seq": seq_next,
            "replanned": replanned,
            "rules_hash": merged.rules_hash(),
            "changed": sorted(patch),
        },
    )
    return {
        "run_id": state.run_id,
        "config_id": version["config_id"],
        "config_version_id": version["config_version_id"],
        "version": version["version"],
        "effective_from_seq": seq_next,
        "replanned": replanned,
        "rules": merged.to_dict(),
        "rules_hash": merged.rules_hash(),
    }


async def mark_favorite(
    user_id: int, run_id: int, run_track_id: int, favorite: bool
) -> Optional[Dict[str, Any]]:
    """UC-08: (un)mark one deck card as a favourite — run-scoped (F7).

    Weighting takes effect wherever :func:`core.selection.select_next`
    draws — the rolling repeat-mode plans and every tail replan; a pre-dealt
    no_repeat permutation is membership-only, so its ORDER changes on the
    next replan/reset, exactly like the contract says.  ``None`` = foreign
    or missing run/card (the caller's 404).
    """
    run = await db.get_run(run_id, user_id=user_id)
    if run is None:
        return None
    card = await db.find_run_track(run_id, run_track_id=run_track_id)
    if card is None:
        return None
    if bool(card["favorite"]) != favorite:
        await db.set_run_track(run_track_id, favorite=1 if favorite else 0)
        await db.record_event(
            run_id, "track_favorited" if favorite else "track_unfavorited",
            cursor=int(run["cursor"]), run_track_id=run_track_id,
            detail={"track": card["provider_track_id"], "name": card["name"]},
        )
    return {
        "run_id": run_id, "run_track_id": run_track_id, "favorite": favorite,
    }


async def set_track_exclusion(
    state: RunState, run_track_id: int, excluded: bool
) -> Optional[Dict[str, Any]]:
    """UC-20/21: exclude a deck card (state 'excluded_user') or take it back.

    Immediate effect (RUN-08): the tail is replanned under the effective
    rules, so an excluded title leaves "Als Nächstes" now — and a
    reactivated one re-enters the remaining order now.  User exclusions are
    hard (P5): they are simply no candidates any more.  Import exclusions
    ('excluded_rule') are not user-revocable here — only a sync that makes
    the entry playable again re-opens them (UC-04).
    """
    run = await db.get_run(state.run_id, user_id=state.user_id)
    if run is None:
        return None
    card = await db.find_run_track(state.run_id, run_track_id=run_track_id)
    if card is None:
        return None

    changed = False
    if excluded:
        if card["state"] == "excluded_rule":
            raise engine.RunError(
                "Dieser Eintrag wurde schon beim Import ausgeschlossen."
            )
        if card["state"] != "excluded_user":
            await db.set_run_track(
                run_track_id, state="excluded_user", excluded_reason="user",
                excluded_at=_iso_utc(time.time()),
            )
            await db.record_event(
                state.run_id, "track_excluded", cursor=state.cursor,
                run_track_id=run_track_id,
                detail={"track": card["provider_track_id"], "name": card["name"]},
            )
            changed = True
    else:
        if card["state"] != "excluded_user":
            raise engine.RunError(
                "Nur eigene Ausschlüsse lassen sich wieder aufnehmen."
            )
        await db.set_run_track(
            run_track_id, state="open", excluded_reason="", excluded_at=None,
        )
        await db.record_event(
            state.run_id, "track_reactivated", cursor=state.cursor,
            run_track_id=run_track_id,
            detail={"track": card["provider_track_id"], "name": card["name"]},
        )
        changed = True

    replanned = 0
    if changed:
        seq_next = int(run.get("selection_seq") or 0) + 1
        _, _, rules = await _effective_rules(run, seq_next)
        replanned = await _replan_tail(run, state, rules)
    return {
        "run_id": state.run_id,
        "run_track_id": run_track_id,
        "excluded": excluded,
        "replanned": replanned,
    }


# ---------------------------------------------------------------------------
# Manual use — the F8 state machine (WP3-D3, ADR-003 F8)
# ---------------------------------------------------------------------------

#: ``runs.manual_state`` vocabulary (M004/M005 CHECK constraint).
MANUAL_NONE = "none"
MANUAL_DETECTED = "manual_detected"
MANUAL_AWAITING = "awaiting_decision"
MANUAL_SUSPENDED = "suspended"


def _iso_utc(ts: float) -> str:
    """Epoch seconds → the ``datetime('now')`` text shape SQLite uses."""
    return datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%d %H:%M:%S")


def _parse_utc(text: str) -> float:
    """Inverse of :func:`_iso_utc` (UTC, second precision)."""
    return (
        datetime.strptime(text, "%Y-%m-%d %H:%M:%S")
        .replace(tzinfo=UTC)
        .timestamp()
    )


async def _record_keyed_event(
    run_id: int,
    type_: str,
    *,
    key: str,
    cursor: int = 0,
    reason: Optional[str] = None,
    detail: Optional[Dict[str, Any]] = None,
) -> None:
    """Record a transition under its deterministic key, duplicate-safe.

    Manual transitions carry ``manual:{run}:{seq}:{zustand}`` keys.  Two
    episodes without an advance in between legitimately produce the same key
    (the seq clock did not move) — then the second event is kept under a
    suffixed key with the collision documented, never dropped: the ledger is
    append-only and honest about repeats.
    """
    try:
        await db.record_event(
            run_id, type_, cursor=cursor, reason=reason, detail=detail,
            event_key=key,
        )
    except aiosqlite.IntegrityError:
        await db.get_db().rollback()
        await db.record_event(
            run_id, type_, cursor=cursor, reason=reason,
            detail={**(detail or {}), "duplicate_of": key},
            event_key=f"{key}:{uuid.uuid4().hex[:8]}",
        )


async def manual_tick(
    session: Session,
    state: RunState,
    *,
    drifted: bool,
    idle: bool = False,
    advancing: bool = False,
    now: Optional[float] = None,
) -> str:
    """Feed one playback observation into the F8 state machine.

    Beobachten statt kämpfen (ADR-003 F8): while the listener drives the
    service manually, True Shuffle sends no commands.  The watcher calls
    this after every reconcile verdict; tests call it directly with an
    injected clock (``now``).  Returns the manual_state AFTER the
    observation so the caller can gate its own advance path on it.

    Transitions:

    * ``none`` → ``manual_detected`` when playback drifts off the plan
      (event ``manual_detected``, ``manual_since`` stamped);
    * ``manual_detected`` + return to the plan or idle → per
      ``manual_use_policy``: ``auto_resume`` re-asserts the window,
      ``auto_pause`` pauses the run, ``ask`` parks it in
      ``awaiting_decision`` (UX-Zustand C — resolved only by
      :func:`manual_decision`);
    * ``manual_detected`` + continuous foreign playback longer than
      ``manual_wait_seconds`` → ``suspended`` (run paused, event
      ``manual_suspended``) — the hard upper bound, because the provider
      API cannot signal "the manual queue is over";
    * ``awaiting_decision`` / ``suspended`` hold until the listener acts.

    ``advancing=True`` marks a return that the caller is about to book as a
    regular advance (the listener manually played the next plan card) — the
    state clears without re-asserting a window the advance would replace.
    """
    run = await db.get_run(state.run_id)
    if run is None:
        return MANUAL_NONE
    manual_state = str(run.get("manual_state") or MANUAL_NONE)
    ts = time.time() if now is None else now
    seq = int(run.get("selection_seq") or 0)
    _, _, rules = await _effective_rules(run, seq + 1)

    if manual_state == MANUAL_NONE:
        if not drifted:
            return MANUAL_NONE
        await db.update_run(
            state.run_id, manual_state=MANUAL_DETECTED, manual_since=_iso_utc(ts)
        )
        _forget_window(state.run_id)  # observation only from here on
        await _record_keyed_event(
            state.run_id, "manual_detected",
            key=f"manual:{state.run_id}:{seq}:manual_detected",
            cursor=state.cursor,
            detail={"policy": rules.manual_use_policy, "since": _iso_utc(ts)},
        )
        return MANUAL_DETECTED

    if manual_state == MANUAL_DETECTED:
        if drifted:
            since = (
                _parse_utc(str(run["manual_since"]))
                if run.get("manual_since") else ts
            )
            if ts - since > rules.manual_wait_seconds:
                await db.update_run(
                    state.run_id, status=RunStatus.PAUSED.value,
                    manual_state=MANUAL_SUSPENDED,
                )
                state.status = RunStatus.PAUSED
                _forget_window(state.run_id)
                await _record_keyed_event(
                    state.run_id, "manual_suspended",
                    key=f"manual:{state.run_id}:{seq}:suspended",
                    cursor=state.cursor,
                    detail={
                        "waited_seconds": int(ts - since),
                        "manual_wait_seconds": rules.manual_wait_seconds,
                    },
                )
                return MANUAL_SUSPENDED
            return MANUAL_DETECTED

        # Playback returned to the plan (or went idle) — the policy decides.
        if rules.manual_use_policy == "auto_resume":
            await db.update_run(
                state.run_id, manual_state=MANUAL_NONE, clear_manual_since=True
            )
            note = "resolved by advance" if advancing else ("idle" if idle else "returned to plan")
            if not advancing:
                settings = get_settings()
                decision = engine.start(
                    state, window_size=settings.context_window_size
                )
                command = await _apply(
                    session, state, decision,
                    device_id=state.device_id, force_override=True,
                )
                if command == "play":
                    _remember_window(state.run_id, state.cursor)
            await _record_keyed_event(
                state.run_id, "manual_resumed",
                key=f"manual:{state.run_id}:{seq}:resumed",
                cursor=state.cursor,
                detail={"policy": "auto_resume", "note": note},
            )
            return MANUAL_NONE
        if rules.manual_use_policy == "auto_pause":
            await db.update_run(
                state.run_id, status=RunStatus.PAUSED.value,
                manual_state=MANUAL_NONE, clear_manual_since=True,
            )
            state.status = RunStatus.PAUSED
            _forget_window(state.run_id)
            await _record_keyed_event(
                state.run_id, "manual_paused",
                key=f"manual:{state.run_id}:{seq}:paused",
                cursor=state.cursor,
                detail={"policy": "auto_pause"},
            )
            return MANUAL_NONE
        # 'ask' — UX-Zustand C: hold and let the listener decide.
        await db.update_run(state.run_id, manual_state=MANUAL_AWAITING)
        await _record_keyed_event(
            state.run_id, "manual_awaiting_decision",
            key=f"manual:{state.run_id}:{seq}:awaiting_decision",
            cursor=state.cursor,
            detail={"policy": "ask"},
        )
        return MANUAL_AWAITING

    # awaiting_decision holds for the API; suspended holds for resume/start.
    return manual_state


async def manual_decision(
    session: Session, run_id: int, user_id: int, action: str
) -> Optional[Dict[str, Any]]:
    """Resolve UX-Zustand C: the listener answered the 'ask' question.

    ``action='resume'`` → True Shuffle takes the playback back (window
    re-asserted via :func:`start`); ``action='pause'`` → the run pauses at
    exactly this card.  Returns ``None`` for a foreign/missing run (the
    caller's 404); a run that is not awaiting a decision raises
    :class:`~core.engine.RunError` (the caller's 409).
    """
    run = await db.get_run(run_id, user_id=user_id)
    if run is None:
        return None
    if str(run.get("manual_state") or MANUAL_NONE) != MANUAL_AWAITING:
        raise engine.RunError(
            "Hier wartet keine Entscheidung — dieser Hörvorgang ist nicht im "
            "Nachfrage-Zustand."
        )
    state = _to_state(run)
    seq = int(run.get("selection_seq") or 0)
    await db.update_run(run_id, manual_state=MANUAL_NONE, clear_manual_since=True)
    if action == "resume":
        decision = await start(session, state)
        await _record_keyed_event(
            run_id, "manual_resumed",
            key=f"manual:{run_id}:{seq}:resumed",
            cursor=state.cursor, detail={"policy": "ask", "action": "resume"},
        )
        return {
            "run_id": run_id, "action": "resume",
            "manual_state": MANUAL_NONE, "status": state.status.value,
            "play_track_id": decision.play_track_id,
        }
    # 'pause'
    await pause(session, state)
    await _record_keyed_event(
        run_id, "manual_paused",
        key=f"manual:{run_id}:{seq}:paused",
        cursor=state.cursor, detail={"policy": "ask", "action": "pause"},
    )
    return {
        "run_id": run_id, "action": "pause",
        "manual_state": MANUAL_NONE, "status": RunStatus.PAUSED.value,
    }


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
    # F8: pausing ends any manual episode — the listener chose "pausiert
    # lassen", nothing is awaited any more.
    await db.update_run(state.run_id, status=RunStatus.PAUSED.value,
                        manual_state=MANUAL_NONE, clear_manual_since=True)
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
            # for this (user, provider).  A German sentence naming the
            # blocker, not a 500.
            raise await _slot_conflict(state.user_id, state.provider) from exc
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

    # WP3-D3: the reset plans under the run's EFFECTIVE rules (a run-local
    # UC-27 change carries into the next cycle), and cards parked for this
    # cycle (UC-25 'after_cycle', ERR-06 'retry_next_cycle') join the deck
    # before the new plan is drawn.
    new_cycle = int(run["cycle"]) + 1
    _, _, rules = await _effective_rules(run, int(run.get("selection_seq") or 0) + 1)

    reopened = await db.reopen_run_tracks(state.run_id)
    admitted_now = await db.admit_pending_tracks(state.run_id, new_cycle)
    deck = await db.list_run_tracks(state.run_id, states=["open"], admitted_only=True)
    # UC-04: cards no longer in the playlist keep their history but are never
    # planned again.
    deck = [r for r in deck if not r["removed_from_snapshot"]]
    if not deck:
        raise ProviderError(
            "Für einen neuen Durchlauf ist kein Titel offen — dieser "
            "Hörvorgang hat keine spielbaren Karten (mehr)."
        )
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
        # Real selection clock (WP3-C, Befund 6): draw k of the new cycle is
        # booked at selection_seq + k, so the repeat-mode plan simulates
        # under exactly that clock (no_repeat plans have no clock).
        start_seq=int(run.get("selection_seq") or 0) + 1,
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
            "admitted": admitted_now, "status": status.value,
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
