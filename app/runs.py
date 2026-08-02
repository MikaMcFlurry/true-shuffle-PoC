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

from app import db, execution, migrations
from app.accounts import Session
from app.config import get_settings
from core import engine
from core.engine import Decision
from core.models import (
    AdvanceReason,
    PlaybackState,
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

async def _remember_window(
    run_id: int,
    anchor: int,
    *,
    size: int,
    context_uri: Optional[str] = None,
) -> None:
    """Record which context is now set on the provider (ADR-002/ADR-005).

    This used to be a process-local dict, and that was a real defect, not an
    implementation detail: after every restart the anchor was ``None``, which
    switches BOTH end-of-context patterns in :func:`core.engine.reconcile` off
    — a context that ran out then read as drift, the deck stalled, and the
    card that had just played was never booked.

    ``size`` is what was *actually* asserted, not the configured window size:
    a context playlist carries thousands of cards where the setting says 250.
    """
    await db.update_run(
        run_id,
        window_anchor=anchor,
        window_size=max(1, size),
        asserted_context_uri=context_uri or "",
    )


async def _forget_window(run_id: int) -> None:
    """Nothing is known to be set any more — the next command re-asserts."""
    await db.update_run(run_id, clear_window=True)


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
        # ADR-002/ADR-005: which context is set on the provider, how big it
        # really is, and how far the card under the cursor got.  All persisted
        # since M012 — see _remember_window for why that matters.
        window_anchor=row.get("window_anchor"),
        window_size=row.get("window_size"),
        asserted_context_uri=row.get("asserted_context_uri") or None,
        execution_strategy=str(row.get("execution_strategy") or "uris_window"),
        observed_track_id=row.get("observed_track_id"),
        observed_progress_ms=int(row.get("observed_progress_ms") or 0),
        observed_duration_ms=int(row.get("observed_duration_ms") or 0),
        observed_at=row.get("observed_at") or "",
        card_satisfied=bool(row.get("card_satisfied")),
        smart_shuffle_seen=bool(row.get("smart_shuffle_seen")),
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
    position_ms: int = 0,
) -> Optional[str]:
    """Push a decision to a REMOTE_DEVICE provider.

    ADR-002: at most ONE command leaves here — either a play carrying the
    whole context, or the lightweight ``next`` for a TS skip inside it.
    ``POST /queue`` is never used any more; the user's queue belongs to the
    user.  Returns which command was sent (``"play"`` / ``"skip"``), or
    ``None``.

    ADR-005 adds two things.  The *how* now depends on the run's effective
    execution strategy (:mod:`app.execution`) rather than being hard-wired to a
    uris array, and the asserted context is **persisted here** instead of by
    every caller: an assert that the run does not remember is how a context
    ended up looking unset, which switched off the end-of-context detection.

    ``position_ms`` rides on the play command (ADR-004): a re-assert of the
    ALREADY PLAYING title continues at the listener's position instead of
    restarting the song.

    Web-player providers get the decision as JSON instead; the browser does
    the playing, so there is nothing to push.
    """
    if not execution.is_remote(session):
        return None
    if not decision.play_track_id:
        return None

    correlation_id = uuid.uuid4().hex[:8]
    window = decision.play_window or [decision.play_track_id]
    strategy = execution.effective_strategy(state, session)

    if decision.needs_override or force_override:
        assertion = await execution.assert_playback(
            session, state,
            strategy=strategy, window=window, cursor=decision.cursor,
            device_id=device_id, position_ms=position_ms,
            correlation_id=correlation_id,
        )
        await _record_assertion(state, assertion)
        return assertion.command

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
            # No skip command on this provider — assert the context instead.
            assertion = await execution.assert_playback(
                session, state,
                strategy=strategy, window=window, cursor=decision.cursor,
                device_id=device_id, position_ms=0,
                correlation_id=correlation_id,
            )
            await _record_assertion(state, assertion)
            return assertion.command

    return None


async def rules_for_state(state: RunState) -> Rules:
    """The rule version governing the run's NEXT draw.

    Thin wrapper around :func:`_effective_rules` for callers that hold a
    :class:`RunState` rather than a row — the watcher needs
    ``played_threshold`` on every poll.
    """
    run = await db.get_run(state.run_id)
    if run is None:
        return Rules()
    _, _, rules = await _effective_rules(
        run, int(run.get("selection_seq") or 0) + 1
    )
    return rules


async def force_playback_modes(
    session: Session, state: RunState
) -> Dict[str, Any]:
    """Put the service's own shuffle/repeat back where they belong: off."""
    return await execution.force_playback_modes(
        session, device_id=state.device_id
    )


async def downgrade_strategy(state: RunState, *, cause: str) -> bool:
    """Fall back to the strategy that actually works on this client.

    Called the first time a run demonstrably loses the context it asserted.
    That observation — our card ended, something we never sent is playing — is
    the honest measurement the original design lacked: ADR-002 chose the uris
    window under the assumption that every client honours a multi-uri list, and
    this is what it looks like when one does not.

    One-way on purpose.  Promoting a run back to the cheap strategy on a good
    day would reintroduce exactly the failure it was downgraded for.
    """
    current = execution.normalise(state.execution_strategy)
    if current == execution.CONTEXT_PLAYLIST:
        return False
    await db.update_run(
        state.run_id, execution_strategy=execution.CONTEXT_PLAYLIST
    )
    state.execution_strategy = execution.CONTEXT_PLAYLIST
    await db.record_event(
        state.run_id, "strategy_downgraded", cursor=state.cursor,
        detail={
            "from": current,
            "to": execution.CONTEXT_PLAYLIST,
            "cause": cause[:200],
            "note": "der Dienst hat die gesetzte Reihenfolge nicht behalten — "
                    "ab jetzt über eine Kontext-Playlist",
        },
    )
    logger.info("run %s downgraded to context_playlist: %s", state.run_id, cause)
    return True


async def _record_assertion(
    state: RunState, assertion: execution.Assertion
) -> None:
    """Persist what the provider is now believed to be playing from."""
    if not assertion.asserted or assertion.anchor is None:
        return
    await _remember_window(
        state.run_id, assertion.anchor,
        size=assertion.size, context_uri=assertion.context_uri,
    )
    state.window_anchor = assertion.anchor
    state.window_size = max(1, assertion.size)
    state.asserted_context_uri = assertion.context_uri
    # A fresh assert is a belief, not an observation: only a poll that sees the
    # context may license us to skip sending commands (ADR-005).
    state.context_confirmed = False
    if assertion.detail:
        await db.record_event(
            state.run_id, "context_asserted", cursor=assertion.anchor,
            detail={
                "strategy": assertion.strategy,
                "size": assertion.size,
                **assertion.detail,
            },
        )


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
    """Begin or resume a run and, for remote providers, take over the device.

    ADR-005: resuming must never replay a card that already played.  The old
    code went straight to ``order[cursor]`` at position 0, whose only guard was
    ``cursor >= total`` — so whenever a card had been heard without the deck
    booking it (the service jumped to an autoplay title, the watcher was gone,
    the process restarted), pressing „Hörvorgang fortsetzen" started the very
    same title again.  The persisted observation closes that: a card that is
    already satisfied is settled first, and only then does playback start —
    on the NEXT card.
    """
    settings = get_settings()

    # Book a card that already played out BEFORE deciding what to start.  The
    # start itself then force-asserts the next one, because „fortsetzen" is a
    # deliberate take-over of the device: pressing it and hearing nothing would
    # be its own bug.
    await _settle_satisfied_card(state)

    decision = engine.start(state, window_size=settings.context_window_size)

    if decision.completed:
        await _finish(state, session)
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

    # ADR-004 parity for a plain resume: when the listener stopped MID-track,
    # pick the song up where they left it instead of starting it over.  Only
    # a fresh observation of this very card counts — an hour-old position is a
    # memory, not a place in the music.
    position_ms = _resume_position_ms(state)

    await _apply(session, state, decision,
                 device_id=device_id or state.device_id,
                 force_override=True, position_ms=position_ms)
    await db.record_event(
        state.run_id, "started", cursor=state.cursor,
        detail={
            "device_id": device_id or state.device_id,
            "note": decision.note,
            "position_ms": position_ms,
            "strategy": execution.effective_strategy(state, session)
            if execution.is_remote(session) else None,
        },
    )
    await _probe_execution(session, state, decision,
                           device_id=device_id or state.device_id)
    return decision


async def _probe_execution(
    session: Session,
    state: RunState,
    decision: Decision,
    *,
    device_id: Optional[str],
) -> None:
    """Check once whether the cheap strategy is actually being honoured.

    ADR-005 deliberately makes this weak evidence and uses it in one direction
    only.  ``GET /me/player/queue`` returns about twenty entries, is reported
    to pad or loop when the real queue is shorter, and answers per device — so
    a "looks fine" proves nothing and must never promote a run back to the
    uris window.  A clear miss, on the other hand, is worth acting on
    immediately instead of letting the listener discover it one track later.

    The stronger signal is free and arrives on its own: ``context_lost`` from
    :func:`core.engine.reconcile`.  This is the head start, not the guarantee.
    """
    if not execution.is_remote(session):
        return
    if execution.effective_strategy(state, session) != execution.URIS_WINDOW:
        return
    window = decision.play_window or []
    try:
        probe = await execution.probe_uris_window(session, window)
    except ProviderError:
        return
    if probe is None:
        return
    await db.record_event(
        state.run_id, "strategy_probe", cursor=state.cursor, detail=probe,
    )
    if probe.get("honoured"):
        return
    if not await downgrade_strategy(
        state, cause="queue probe: the window was not honoured"
    ):
        return
    # Re-assert straight away — the listener is one track away from hearing
    # something we did not plan.
    fresh = engine.start(state, window_size=get_settings().context_window_size)
    if fresh.completed or not fresh.play_track_id:
        return
    with contextlib.suppress(ProviderError, Unsupported):
        await _apply(session, state, fresh, device_id=device_id,
                     force_override=True)


def _resume_position_ms(state: RunState) -> int:
    """Where to pick the current card up, or 0 to start it from the top."""
    if state.observed_track_id != state.current_track_id:
        return 0
    if not state.observed_progress_ms or state.card_satisfied:
        return 0
    max_age = get_settings().resume_position_max_age_seconds
    if max_age <= 0:
        return 0
    age = _observation_age_seconds(state)
    if age is None or age > max_age:
        return 0
    return int(state.observed_progress_ms)


def _observation_age_seconds(state: RunState) -> Optional[float]:
    """How old the persisted observation is, in seconds (``None`` if unknown)."""
    if not state.observed_at:
        return None
    try:
        stamp = datetime.strptime(state.observed_at, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return max(0.0, datetime.now(tz=UTC).timestamp() - stamp.replace(tzinfo=UTC).timestamp())


async def _settle_satisfied_card(state: RunState) -> bool:
    """Book the card under the cursor if it already played out.

    This is the fix for „Hörvorgang fortsetzen startet wieder den ersten Song".
    The old resume path went straight to ``order[cursor]`` with the sole guard
    ``cursor >= total``, so a card that had been heard without the deck booking
    it — because the service jumped to an autoplay title, because the watcher
    was gone, because the process restarted — was simply played again.

    No provider command leaves here: the caller force-asserts right afterwards,
    which is what „fortsetzen" means.  Booking goes through :func:`_book_advance`
    directly for the same reason, and its F5 event key turns a race with the
    watcher into a no-op instead of a double advance.
    """
    if not state.card_satisfied:
        return False
    if state.observed_track_id != state.current_track_id:
        return False
    # engine.advance refuses anything but a live run, and rightly so — a
    # stopped or cancelled deck must not book cards behind the listener's back.
    if state.status not in (RunStatus.ACTIVE, RunStatus.PAUSED):
        return False
    run = await db.get_run(state.run_id)
    if run is None:
        return False
    decision = engine.advance(
        state, reason=AdvanceReason.TRACK_ENDED,
        window_size=get_settings().context_window_size,
    )
    if not await _book_advance(run, state, decision, AdvanceReason.TRACK_ENDED):
        return False
    state.cursor = decision.cursor
    if decision.completed:
        state.status = RunStatus.COMPLETED
    await db.record_event(
        state.run_id, "resume_settled", cursor=state.cursor,
        detail={
            "track": run.get("observed_track_id"),
            "progress_ms": int(run.get("observed_progress_ms") or 0),
            "note": "Karte war schon zu Ende gehört — vor dem Fortsetzen verbucht",
        },
    )
    await maybe_extend_plan(state)
    return True


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
        # Skip-touch stamp (WP3-C contract §Funktionen 3, deferral-time
        # convention): every skip stamps ``last_played_seq`` with the skip's
        # selection seq — the title was just offered to the ear, and that
        # recency is exactly what the engine's min_gap check (keep_open) and
        # requeue deadline (requeue_later/defer_to_end) measure.  ``state``
        # keeps encoding consumption; ``play_count`` stays untouched for
        # unconsumed cards (the consume branch counts the play itself).
        track_update = {
            "state": outcome.new_state,
            "count_play": outcome.consumed,
            "stamp_seq": True,
        }
        wants_requeue = outcome.requeue_after_draws or outcome.requeue_at_cycle_end
        if wants_requeue and consumed_rows and not completed:
            # Plan extension instead of an immediate replan: the deferred
            # card re-enters at the end of the current plan AND of
            # order_json (the two stay index-identical).  Skipping the LAST
            # card cannot extend (the decision already completed the deck) —
            # the card stays 'deferred' and the next cycle re-opens it (F2).
            # requeue_later additionally honours its deadline HERE: the
            # appended row would be consumed ``len(order) - cursor + 1``
            # draws after this skip (one row per draw); if the plan end is
            # closer than REQUEUE_AFTER_DRAWS, appending would book the
            # comeback inside the deadline window — so the card is NOT
            # appended and stays 'deferred' with its stamp: a later replan
            # pools it once the deadline has passed, otherwise the F2 reset
            # lifts the deadline (same outcome as the last-card case).
            comeback_distance = len(state.order) - decision.cursor + 1
            if (
                outcome.requeue_after_draws is None
                or comeback_distance >= outcome.requeue_after_draws
            ):
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
    # The observation belonged to the card we just consumed.  Leaving it in
    # place would make the NEXT card look already-played and settle it
    # unheard — the mirror image of the bug this whole mechanism fixes.
    await db.clear_observation(run_id)
    state.observed_track_id = None
    state.observed_progress_ms = 0
    state.observed_duration_ms = 0
    state.observed_at = ""
    state.card_satisfied = False
    return True


async def advance(
    session: Optional[Session],
    state: RunState,
    *,
    reason: AdvanceReason,
    device_id: Optional[str] = None,
    steps: int = 1,
    context_lost: bool = False,
) -> Decision:
    """Consume the current card and move to the next one.

    WP3-D3: the move is BOOKED, not just counted — plan row, card state per
    skip policy, ``run_selections``, ``selection_seq`` and the F5 event key
    land in one transaction (:func:`_book_advance`).  A duplicate report of
    the same transition falls off the UNIQUE index, is recorded as
    ``applied=0``/stale, and moves nothing.  ``order_json``/``cursor``
    remain the dual playback source until M009.

    ``context_lost`` (ADR-005) says the service is demonstrably no longer
    playing what we set.  The "context continues on its own, send nothing"
    shortcut must not fire then — that shortcut is only correct while the
    context we asserted is still running.
    """
    settings = get_settings()
    run = await db.get_run(state.run_id)
    if context_lost:
        # Both the belief and its confirmation are void: whatever is playing,
        # it is not ours.  Forgetting first makes engine.advance take the
        # re-assert branch instead of trusting a context that is gone.
        await _forget_window(state.run_id)
        state.window_anchor = None
        state.window_size = None
        state.asserted_context_uri = None
        state.context_confirmed = False
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
        await _forget_window(state.run_id)
        # A finished deck must not become a radio station: the moment our
        # context runs out Spotify Autoplay starts recommending, in the
        # listener's account and their history.  Pause, then clean up.
        if session is not None and execution.is_remote(session):
            with contextlib.suppress(ProviderError, Unsupported):
                await session.provider.pause(
                    session.token, device_id=device_id or state.device_id
                )
        await _release_contexts(session, state.run_id)
        return decision

    # ADR-002 Auflage 1: the command goes out BEFORE anything is persisted.
    # A device that is gone (404 / no active device) fails the command, the
    # cursor stays put, and no card is consumed — the watcher then sees idle
    # (Zustand D) instead of a silently burnt title.
    try:
        await _apply(session, state, decision,
                     device_id=device_id or state.device_id)
    except ProviderError as exc:
        # ERR-06: a TRACK-level refusal (plain 4xx command error — device,
        # auth, quota and tier failures all carry their own subclass and
        # re-raise) means the NEW card is unplayable, not that the device is
        # gone.  The transition itself is real — the previous card did end —
        # so it is booked, the unplayable card is then consumed reactively
        # as PLAYBACK_FAILED (F4) and the following card is asserted.  One
        # failure hop per call: a second track-level failure returns with
        # the window unasserted instead of machine-gunning through the deck.
        track_level = (
            type(exc) is ProviderError
            and exc.http_status is not None
            and 400 <= exc.http_status < 500
        )
        if not track_level:
            raise
        if run is not None:
            if not await _book_advance(run, state, decision, reason):
                return _stale_decision(state, reason)
        else:  # pragma: no cover — run vanished mid-flight
            await db.update_run(state.run_id, cursor=decision.cursor)
        state.cursor = decision.cursor
        await _forget_window(state.run_id)
        await db.record_event(
            state.run_id, "playback_failed", cursor=state.cursor,
            reason=AdvanceReason.PLAYBACK_FAILED.value,
            detail={"track": decision.play_track_id,
                    "error": str(exc)[:200]},
        )
        if reason is AdvanceReason.PLAYBACK_FAILED:
            return decision
        return await advance(
            session, state, reason=AdvanceReason.PLAYBACK_FAILED,
            device_id=device_id,
        )
    if run is not None:
        if not await _book_advance(run, state, decision, reason):
            return _stale_decision(state, reason)
    else:  # pragma: no cover — run vanished mid-flight
        await db.update_run(state.run_id, cursor=decision.cursor)
    state.cursor = decision.cursor
    # The rolling horizon rolls here, and nowhere else: close to the end of the
    # plan, draw the next fifty.  Runs under a repeat mode used to simply stop
    # after fifty cards while their deck still held thousands.
    await maybe_extend_plan(state)
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
    await _apply(session, state, decision,
                 device_id=device_id or state.device_id,
                 force_override=True)
    await db.update_run(state.run_id, cursor=decision.cursor)
    state.cursor = decision.cursor
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

def _draw_tail(
    sim: Dict[int, Candidate],
    rules: Rules,
    master_seed: int,
    base_seq: int,
    limit: int,
    *,
    repeat_window: Optional[List[int]] = None,
) -> List[int]:
    """Draw *limit* further cards, simulating each draw as if it were booked.

    The one draw loop in the app layer — a tail replan and a horizon extension
    must produce cards under exactly the same rules, or the two would disagree
    about no-repeat, minimum gap and repeat quota.  ``sim`` is mutated in place
    so the caller can keep simulating on top of the result.

    Draw *k* is simulated at ``base_seq + 1 + k``, i.e. the same clock the
    later advances will book — which is what makes a plan reproducible from
    (master seed, selection_seq, rules, deck).
    """
    tail: List[int] = []
    window: List[int] = list(repeat_window or [])
    step = 0
    while len(tail) < limit:
        # The quota window is led in integers; window_repeats / QUOTA_WINDOW
        # is the convention select_next converts back to the exact count —
        # the P7 gate itself never compares floats (WP3-C, Befund 1).
        window_repeats = sum(window[-QUOTA_WINDOW:])
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
        window.append(1 if chosen.last_played_seq is not None else 0)
        sim[chosen.run_track_id] = replace(
            chosen, state="played", play_count=chosen.play_count + 1,
            last_played_seq=base_seq + step,
        )
        tail.append(chosen.run_track_id)
    return tail


#: How close the cursor may come to the end of the plan before the rolling
#: horizon is extended.  Twenty cards is over an hour of audio — enough for a
#: failed extension to be retried several times before it could ever be felt.
HORIZON_REFILL_MARGIN = 20


async def _extend_plan(
    run: Dict[str, Any], state: RunState, rules: Rules, *, count: int = PLAN_HORIZON
) -> int:
    """Make the rolling horizon actually roll (the „nur 50 Titel"-Fehler).

    Under ``limited_repeat``/``free_repeat`` the plan is deliberately a rolling
    window of :data:`core.selection.PLAN_HORIZON` cards — a 9 000-entry plan
    for a mode that allows repeats would be a fiction the first skip
    invalidates.  What was missing is the *rolling*: nothing ever extended it,
    so the run genuinely ended after fifty cards while the deck still held
    thousands, and the interface reported the plan length as the deck size.

    This appends ``count`` further cards under the SAME plan version — a
    continuation, not a replan: the consumed prefix, the current card and every
    already-planned row stay exactly as they are.  The simulation first replays
    the still-pending plan rows, so the new cards respect minimum gap and
    repeat quota against what is about to be played, not just against history.

    Returns how many cards were added (0 when nothing was needed or possible).
    """
    if rules.repeat_mode == "no_repeat":
        return 0  # a permutation has nothing left to extend
    run_id = int(run["id"])
    plan_rows = await db.list_active_plan(run_id)
    if not plan_rows:
        return 0  # legacy run without a materialised plan — order_json only

    deck = await db.list_run_tracks(
        run_id, states=["open", "played", "deferred"], admitted_only=True
    )
    provider_by_rt: Dict[int, str] = {}
    sim: Dict[int, Candidate] = {}
    for row in deck:
        if row["removed_from_snapshot"]:
            continue
        rt_id = int(row["id"])
        provider_by_rt[rt_id] = str(row["provider_track_id"])
        last = row["last_played_seq"]
        if row["state"] == "played" and last is None:
            last = 0
        sim[rt_id] = Candidate(
            run_track_id=rt_id,
            track_key=f"{run['provider']}:{row['provider_track_id']}",
            state=str(row["state"]),
            play_count=int(row["play_count"]),
            last_played_seq=last,
            favorite=bool(row["favorite"]),
            weight=float(row["weight"]),
        )
    if not sim:
        return 0

    base_seq = int(run.get("selection_seq") or 0)
    # Replay the pending plan: those cards WILL be played before anything we
    # draw now, so drawing against today's deck state would let a card come
    # back inside its own minimum gap.
    repeat_window: List[int] = []
    pending = plan_rows[state.cursor:]
    for offset, prow in enumerate(pending):
        rt_id = int(prow["run_track_id"])
        card = sim.get(rt_id)
        if card is None:
            continue
        repeat_window.append(1 if card.last_played_seq is not None else 0)
        sim[rt_id] = replace(
            card, state="played", play_count=card.play_count + 1,
            last_played_seq=base_seq + 1 + offset,
        )

    tail = _draw_tail(
        sim, rules, int(run["seed"]) if run.get("seed") is not None else 0,
        base_seq + len(pending), count, repeat_window=repeat_window,
    )
    if not tail:
        return 0

    start_seq = await db.max_plan_seq(run_id) + 1
    await db.write_run_plan(
        run_id, tail, plan_version=int(run["plan_version"]),
        start_seq=start_seq, live=False,
    )
    order = list(state.order) + [provider_by_rt[rt] for rt in tail]
    await db.update_run(run_id, order=order)
    state.order = order
    run["order"] = order
    await db.record_event(
        run_id, "plan_extended", cursor=state.cursor,
        detail={"added": len(tail), "total": len(order),
                "repeat_mode": rules.repeat_mode},
    )
    return len(tail)


async def maybe_extend_plan(state: RunState) -> int:
    """Top the rolling horizon up when the cursor gets close to its end.

    Called after a booked advance, under the caller's ``advance_lock``.  A
    failure here must never stop the music: the horizon is a convenience, the
    card that just played is the fact.

    **How far it rolls, and why there is a limit.**  One run is one pass over
    the deck — under a repeat mode that means as many draws as the deck has
    cards, with repeats allowed among them, and then the run is through and the
    F2 cycle reset deals a new one.  Rolling for ever would make
    ``free_repeat`` runs endless and quietly delete the idea of a finished
    Hörvorgang; stopping at fifty (what happened before) made a 9 000-title
    deck end after fifty.  The deck size is the honest bound.
    """
    remaining = len(state.order) - state.cursor
    if remaining > HORIZON_REFILL_MARGIN:
        return 0
    run = await db.get_run(state.run_id)
    if run is None:
        return 0
    _, _, rules = await _effective_rules(
        run, int(run.get("selection_seq") or 0) + 1
    )
    if rules.repeat_mode == "no_repeat":
        return 0  # already a full permutation of the deck
    stats = await db.deck_stats(state.run_id)
    deck_size = int(stats.get("deck_size") or 0)
    missing = deck_size - len(state.order)
    if missing <= 0:
        return 0
    try:
        return await _extend_plan(
            run, state, rules, count=min(PLAN_HORIZON, missing)
        )
    except Exception as exc:  # pragma: no cover — never block playback
        logger.warning("run %s: plan extension failed: %s", state.run_id, exc)
        await db.record_event(
            state.run_id, "plan_extension_failed", cursor=state.cursor,
            detail={"error": str(exc)[:200]},
        )
        return 0


async def _replan_tail(
    run: Dict[str, Any], state: RunState, rules: Rules,
    *, allow_completed: bool = False,
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
    if run["status"] == RunStatus.CANCELLED.value:
        return 0
    # UC-24: a rule change may deliberately re-open a COMPLETED run
    # (``allow_completed``, change_run_rules only).  Every other caller keeps
    # the old refusal — an exclusion on a finished run must not grow a tail.
    if run["status"] == RunStatus.COMPLETED.value and not allow_completed:
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

    # Performance-Fast-Path (Phase 4, 10k-Profil): der no_repeat-Draw-Loop
    # ist O(n²) — 54 s für 10 000 Karten, UNTER dem advance_lock.  Im reinen
    # Fall (nur offene Karten OHNE Hör-Historie, keine deferred-Fristen,
    # keine Favoriten/Gewichte) ist der Loop distributionsgleich mit einer
    # geseedeten Permutation — plan_cycle liefert sie in O(n log n) mit
    # identischen P1/P5-Garantien.  Fristen (P6), Gewichtung (P4) UND der
    # Mindestabstand (P2: eine keep_open-Karte mit last_played_seq darf nie
    # innerhalb ihres min_gap-Fensters zurückkommen — plan_cycle ist
    # gap-blind; adversarialer Befund B1, 2026-08-01) erzwingen weiter den
    # Draw-Loop.
    open_cards = [c for c in sim.values() if c.state == "open"]
    deferred_cards = [c for c in sim.values() if c.state == "deferred"]
    pure_no_repeat = (
        rules.repeat_mode == "no_repeat"
        and not deferred_cards
        and all(not c.favorite and c.weight == 1.0 for c in open_cards)
        and (
            rules.min_gap == 0
            or all(c.last_played_seq is None for c in open_cards)
        )
    )
    if pure_no_repeat:
        tail = plan_cycle(
            open_cards, rules, draw_seed(master_seed, base_seq + 1),
        )
        new_pv = int(run["plan_version"]) + 1
        if tail:
            start_seq = await db.max_plan_seq(run_id) + 1
            await db.write_run_plan(
                run_id, tail, plan_version=new_pv, start_seq=start_seq,
                live=False,
            )
        order = state.order[: state.cursor + 1] + [
            provider_by_rt[rt] for rt in tail
        ]
        await db.update_run(run_id, order=order, plan_version=new_pv)
        state.order = order
        run["plan_version"] = new_pv
        run["order"] = order
        await _forget_window(run_id)
        return len(tail)

    limit = len(sim) if rules.repeat_mode == "no_repeat" else min(
        PLAN_HORIZON, len(sim)
    )
    tail = _draw_tail(sim, rules, master_seed, base_seq, limit)

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
    # ADR-004: the plan underneath the asserted uris window just changed, so
    # nothing is known to be correctly set any more.  Forgetting the anchor is
    # the safety net — the next command re-asserts a fresh window even when
    # the immediate re-assert below (routes) cannot run or fails.
    await _forget_window(run_id)
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
    completed_before = run["status"] == RunStatus.COMPLETED.value
    replanned = await _replan_tail(run, state, merged, allow_completed=True)
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
    # UC-24 „Wiederholungen erlauben und weiterhören": when the new rules
    # actually open further titles on a finished run, it re-opens as
    # 'stopped' (F1: resumable, not playing) — resume + start take it from
    # there.  ``completed_at`` stays stamped: the finished no-repeat pass
    # remains a fact of the history.
    reopened = False
    if completed_before and replanned > 0:
        await db.update_run(state.run_id, status=RunStatus.STOPPED.value)
        state.status = RunStatus.STOPPED
        reopened = True
        await db.record_event(
            state.run_id, "reopened", cursor=state.cursor,
            detail={
                "replanned": replanned,
                "config_version_id": version["config_version_id"],
            },
        )
    return {
        "run_id": state.run_id,
        "config_id": version["config_id"],
        "config_version_id": version["config_version_id"],
        "version": version["version"],
        "effective_from_seq": seq_next,
        "replanned": replanned,
        "reopened": reopened,
        "status": state.status.value,
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


#: UC-07: user-settable per-track draw weight — bounded so a typo cannot turn
#: one song into a de-facto exclusive loop (engine itself only demands > 0).
TRACK_WEIGHT_MIN = 0.1
TRACK_WEIGHT_MAX = 10.0


async def set_track_weight(
    user_id: int, run_id: int, run_track_id: int, weight: float
) -> Optional[Dict[str, Any]]:
    """UC-07: how often THIS song may come around — run-scoped (F7).

    Same visibility contract as :func:`mark_favorite`: the weight takes
    effect wherever :func:`core.selection.select_next` draws — rolling
    repeat-mode plans and every tail replan; a pre-dealt no_repeat
    permutation is membership-only, so its ORDER changes on the next
    replan/reset.  ``None`` = foreign or missing run/card (the caller's
    404); a weight outside ``[TRACK_WEIGHT_MIN, TRACK_WEIGHT_MAX]`` raises
    ``ValueError`` (the caller's 400).
    """
    weight = float(weight)
    if (
        weight != weight  # NaN
        or not (TRACK_WEIGHT_MIN <= weight <= TRACK_WEIGHT_MAX)
    ):
        raise ValueError(
            f"weight muss zwischen {TRACK_WEIGHT_MIN} und {TRACK_WEIGHT_MAX} "
            "liegen."
        )
    run = await db.get_run(run_id, user_id=user_id)
    if run is None:
        return None
    card = await db.find_run_track(run_id, run_track_id=run_track_id)
    if card is None:
        return None
    if float(card["weight"]) != weight:
        await db.set_run_track(run_track_id, weight=weight)
        await db.record_event(
            run_id, "track_weighted",
            cursor=int(run["cursor"]), run_track_id=run_track_id,
            detail={"track": card["provider_track_id"], "name": card["name"],
                    "weight": weight},
        )
    return {
        "run_id": run_id, "run_track_id": run_track_id, "weight": weight,
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


def audible_window(state: RunState) -> List[str]:
    """The uris window a listener would hear from here — for change detection.

    ADR-004: captured BEFORE a tail replan and handed to
    :func:`reassert_window` as ``previous_window``, so a redraw that leaves
    the audible future identical wastes no provider command.
    """
    ws = max(1, get_settings().context_window_size)
    return list(state.order[state.cursor : state.cursor + ws])


async def reassert_window(
    session: Optional[Session],
    state: RunState,
    *,
    cause: str,
    previous_window: Optional[List[str]] = None,
    playback: Optional[PlaybackState] = None,
) -> str:
    """ADR-004: push the CURRENT plan to an actively driven provider, now.

    After a tail replan (exclusion, reactivation, rule change, sync apply)
    the asserted uris window no longer matches the plan.  ``_replan_tail``
    already forgot the anchor, so the next boundary converges in any case;
    this closes the AUDIBLE gap for the driven case: when the provider is
    demonstrably playing the run's current card, the fresh window is asserted
    immediately and seamlessly — same title, position preserved.

    Beobachten statt kämpfen (F8): during a manual episode, drift, idle or on
    a paused/completed run nothing is sent.  Outcomes:

    * ``"reasserted"`` — one play command carried the fresh window;
    * ``"unchanged"`` — the audible future did not change, no command;
    * ``"not_driving"`` — no session/remote provider, run not ACTIVE, manual
      episode open, or the provider does not currently play our title;
    * ``"failed"`` — the command failed (device gone, 429 …); the anchor
      stays forgotten and ``window_reassert_failed`` is in the ledger — the
      next advance re-asserts.
    """
    if session is None:
        return "not_driving"
    if session.provider.capabilities.playback is not PlaybackControl.REMOTE_DEVICE:
        return "not_driving"
    if state.status is not RunStatus.ACTIVE:
        return "not_driving"

    fresh_window = audible_window(state)
    if previous_window is not None and fresh_window == previous_window:
        return "unchanged"

    run = await db.get_run(state.run_id)
    if run is None:
        return "not_driving"
    if str(run.get("manual_state") or MANUAL_NONE) != MANUAL_NONE:
        return "not_driving"

    if playback is None:
        try:
            playback = await session.provider.get_playback_state(session.token)
        except ProviderError:
            # We cannot even see the player — no blind commands (F8).
            return "not_driving"
    if (
        playback is None
        or not playback.is_playing
        or playback.track_id != state.current_track_id
    ):
        return "not_driving"

    decision = engine.start(
        state, window_size=get_settings().context_window_size
    )
    if decision.completed or not decision.play_track_id:
        return "not_driving"
    try:
        command = await _apply(
            session, state, decision,
            device_id=state.device_id, force_override=True,
            position_ms=int(playback.progress_ms or 0),
        )
    except ProviderError as exc:
        await db.record_event(
            state.run_id, "window_reassert_failed", cursor=state.cursor,
            # SEC-17: provider error text is service-controlled — persist a
            # bounded slice, never the unbounded raw message.
            detail={"cause": cause, "error": str(exc)[:200]},
        )
        return "failed"
    if command != "play":
        return "not_driving"
    await db.record_event(
        state.run_id, "window_reasserted", cursor=state.cursor,
        detail={
            "cause": cause,
            "position_ms": int(playback.progress_ms or 0),
            "window": len(decision.play_window or []),
        },
    )
    return "reasserted"


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
    playback: Optional[PlaybackState] = None,
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
        await _forget_window(state.run_id)  # observation only from here on
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
                await _forget_window(state.run_id)
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
                # ADR-004 parity: when the return-to-plan is the expected
                # title ALREADY playing, the re-assert continues at the
                # listener's position instead of restarting the song.
                position_ms = 0
                if (
                    playback is not None
                    and playback.is_playing
                    and playback.track_id == state.current_track_id
                ):
                    position_ms = int(playback.progress_ms or 0)
                await _apply(
                    session, state, decision,
                    device_id=state.device_id, force_override=True,
                    position_ms=position_ms,
                )
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
            await _forget_window(state.run_id)
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
        await _finish(state, session)
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
    await _forget_window(state.run_id)
    # The helper playlists deliberately survive a stop: the run is resumable,
    # and re-creating a 2 000-entry playlist on every resume would be both slow
    # and visible churn in the listener's account.
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
    await _forget_window(state.run_id)
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
    await _forget_window(run_id)

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
    await _forget_window(run_id)

    # Our helper playlists live in the listener's Spotify account, and the
    # cascade below only reaches OUR rows — deleting the run without removing
    # them would leave litter nobody can trace back to us.
    from app.accounts import try_open_session
    session = await try_open_session(user_id, str(run["provider"]))
    stuck = await _release_contexts(session, run_id)
    if stuck:
        logger.warning(
            "run %s: helper playlists could not be removed: %s", run_id, stuck
        )

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
    await _forget_window(state.run_id)
    await _release_contexts(session, state.run_id)
    await db.record_event(state.run_id, "cancelled", cursor=state.cursor)


async def _finish(state: RunState, session: Optional[Session] = None) -> None:
    """The deck is through.  Hand the device back deliberately.

    Order matters and it is not cosmetic: the moment our context runs out,
    Spotify's Autoplay starts recommending music inside the listener's account
    and their listening history.  Pausing FIRST is the only thing that keeps a
    finished run from turning into an unrequested radio station; only then is
    it safe to take the helper playlist away.
    """
    if session is not None and execution.is_remote(session):
        with contextlib.suppress(ProviderError, Unsupported):
            await session.provider.pause(session.token, device_id=state.device_id)
    await db.update_run(state.run_id, status=RunStatus.COMPLETED.value)
    state.status = RunStatus.COMPLETED
    await _forget_window(state.run_id)
    await _release_contexts(session, state.run_id)


async def _release_contexts(
    session: Optional[Session], run_id: int
) -> List[str]:
    """Take our helper playlists back out of the listener's account."""
    try:
        return await execution.cleanup_contexts(session, run_id)
    except Exception:  # pragma: no cover — cleanup must never break a run
        logger.exception("run %s: helper playlist cleanup failed", run_id)
        return []


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

    # The DECK size, not the plan length.  Under a repeat mode the plan is a
    # rolling horizon of PLAN_HORIZON cards that gets topped up as the cursor
    # moves; showing its length as „Titel im Hörvorgang" is what made a
    # 9 000-track deck look like a 50-track one.
    stats = await db.deck_stats(state.run_id)
    # deck_size is 0 for legacy/imported runs without a materialised deck —
    # there the plan IS all we know, and saying so beats inventing a number.
    deck_size = int(stats.get("deck_size") or 0) or state.total
    run_row = await db.get_run(state.run_id)
    repeat_mode = "no_repeat"
    if run_row is not None:
        _, _, rules = await _effective_rules(
            run_row, int(run_row.get("selection_seq") or 0) + 1
        )
        repeat_mode = rules.repeat_mode
    rolling = repeat_mode != "no_repeat"

    return {
        "run_id": state.run_id,
        "provider": state.provider,
        "playlist_id": state.playlist_id,
        "playlist_name": state.playlist_name,
        "mode": state.mode.value,
        "status": state.status.value,
        "cursor": state.cursor,
        "total": state.total,
        #: How many titles are really in the deck.  Equal to ``total`` for
        #: no_repeat; for the repeat modes ``total`` is only the planned
        #: horizon and this is the honest answer.
        "deck_size": deck_size,
        "repeat_mode": repeat_mode,
        "plan_is_rolling": rolling,
        "plan_horizon": PLAN_HORIZON if rolling else None,
        #: What is set on the service right now — used by the UI and by tests
        #: that used to reach into a process-local dict.
        "context": {
            "anchor": state.window_anchor,
            "size": state.window_size,
            "uri": state.asserted_context_uri,
            "strategy": execution.normalise(state.execution_strategy),
        },
        #: Spotify's Smart Shuffle mixes recommendations into playback and
        #: cannot be switched off through the Web API — if it is on, the
        #: order promise does not hold and the interface has to say so.
        "smart_shuffle_seen": state.smart_shuffle_seen,
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
