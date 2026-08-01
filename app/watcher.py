"""Playback watcher — automatic advance and native-skip detection.

This is the piece the previous PoC was missing.  It had ``/controller/next``
and nothing else, which meant the listener had to press a button in a browser
tab for every single track — not a product, a demo.

For providers that expose a remote player (today: Spotify), a background task
polls the playback state and moves the deck forward on its own:

* the track finished → the cursor advances and the next card is asserted;
* the listener pressed *next* inside the Spotify app → the cursor advances
  once, so their skip consumes exactly one card instead of desynchronising us;
* the listener started playing something else entirely → we notice the drift,
  stop fighting for control, and keep the deck exactly where it was so it can
  be resumed later.

Web-player providers (Apple Music, YouTube Music) do not need this: their
browser SDK reports the same events directly to ``POST /api/runs/{id}/event``.

The poll interval is adaptive — it sleeps until just after the current track is
due to end rather than hammering the API on a fixed timer.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass, field
from typing import Dict, Optional

from app import db, runs
from app.accounts import AccountNotConnected, open_session
from app.config import get_settings
from core import engine
from core.models import PlaybackState, RunMode, RunStatus
from providers.base import PlaybackControl, ProviderError

logger = logging.getLogger(__name__)

#: Never poll faster than this, whatever the maths says.
MIN_SLEEP = 1.0
#: Wake up this long after a track is predicted to end.
END_MARGIN = 0.75


@dataclass
class WatchHandle:
    run_id: int
    user_id: int
    task: asyncio.Task
    started_at: float = field(default_factory=time.time)
    drifted: bool = False
    last_state: Optional[PlaybackState] = None


class Watcher:
    """Owns one background task per actively-watched run."""

    def __init__(self) -> None:
        self._handles: Dict[int, WatchHandle] = {}

    # -- lifecycle --------------------------------------------------------

    def is_watching(self, run_id: int) -> bool:
        handle = self._handles.get(run_id)
        return handle is not None and not handle.task.done()

    async def ensure(self, run_id: int, user_id: int) -> bool:
        """Start watching *run_id*, if this run is one the server can follow.

        Two kinds of run qualify, and they use different loops:

        * **Live Mode on a remote-control service** — poll playback and drive it.
        * **Handoff Mode on a service with a history API** — poll the
          recently-played list and move the cursor to match. Nothing of ours
          needs to be open for this one.

        Live Mode on a browser-player service qualifies for neither: that page
        owns the audio and reports its own events.

        Returns True when a watcher is running for this run afterwards.
        """
        if self.is_watching(run_id):
            return True

        run = await db.get_run(run_id, user_id=user_id)
        if run is None or run["status"] != RunStatus.ACTIVE.value:
            return False

        try:
            session = await open_session(user_id, run["provider"])
        except (AccountNotConnected, ProviderError):
            return False

        caps = session.provider.capabilities
        mode = run["mode"]

        if mode == RunMode.CONTROLLER.value:
            if caps.playback is not PlaybackControl.REMOTE_DEVICE:
                return False  # the browser reports these itself
            loop = self._playback_loop
        elif caps.supports_history_sync:
            loop = self._history_loop
        else:
            return False

        task = asyncio.create_task(loop(run_id, user_id), name=f"ts-watch-{run_id}")
        self._handles[run_id] = WatchHandle(run_id=run_id, user_id=user_id, task=task)
        logger.info("watching run %s via %s", run_id, loop.__name__)
        return True

    async def stop(self, run_id: int) -> None:
        handle = self._handles.pop(run_id, None)
        if handle and not handle.task.done():
            handle.task.cancel()
            # Whatever the watcher was doing, stopping it has to succeed.
            with contextlib.suppress(BaseException):
                await handle.task

    async def stop_all(self) -> None:
        for run_id in list(self._handles):
            await self.stop(run_id)

    def status(self, run_id: int) -> Dict[str, object]:
        handle = self._handles.get(run_id)
        if handle is None or handle.task.done():
            return {"watching": False, "drifted": False}
        return {"watching": True, "drifted": handle.drifted}

    # -- history loop (Handoff Mode — nothing of ours is open) ------------

    async def _history_loop(self, run_id: int, user_id: int) -> None:
        """Reconcile a deck against the service's recently-played list.

        The listener is playing the shuffled playlist in their own app. We are
        not driving anything — we are only reading back how far they got, so
        the deck resumes correctly and finishes exactly once.
        """
        settings = get_settings()
        quiet_rounds = 0
        #: Give up after roughly this long with no deck activity at all.
        max_quiet = max(
            1, int(settings.watcher_idle_timeout_seconds / settings.history_poll_seconds)
        )

        try:
            while True:
                state = await runs.get_state(run_id, user_id)
                if state is None or state.status is not RunStatus.ACTIVE:
                    return

                try:
                    session = await open_session(user_id, state.provider)
                    async with runs.advance_lock(run_id):
                        fresh = await runs.get_state(run_id, user_id)
                        if fresh is None or fresh.status is not RunStatus.ACTIVE:
                            return
                        verdict = await runs.sync_from_history(session, fresh)
                except (AccountNotConnected, ProviderError) as exc:
                    logger.warning("history watcher %s: %s", run_id, exc)
                    await asyncio.sleep(_backoff(exc, settings.history_poll_seconds))
                    continue

                if verdict is not None and verdict.advanced:
                    quiet_rounds = 0
                    if verdict.completed:
                        logger.info("run %s completed from history", run_id)
                        return
                else:
                    quiet_rounds += 1
                    if quiet_rounds >= max_quiet:
                        await db.record_event(
                            run_id, "watcher_stopped", cursor=state.cursor,
                            detail={"reason": "no deck activity in history"},
                        )
                        return

                await asyncio.sleep(settings.history_poll_seconds)
        except asyncio.CancelledError:  # pragma: no cover - shutdown path
            raise
        except Exception:
            logger.exception("history watcher for run %s crashed", run_id)
        finally:
            self._handles.pop(run_id, None)

    # -- playback loop (Live Mode on a remote-control service) ------------

    async def _playback_loop(self, run_id: int, user_id: int) -> None:
        settings = get_settings()
        idle_since: Optional[float] = None
        previous_state: Optional[PlaybackState] = None

        try:
            while True:
                state = await runs.get_state(run_id, user_id)
                if state is None or state.status is not RunStatus.ACTIVE:
                    logger.info("run %s no longer active — stopping watcher", run_id)
                    return

                try:
                    session = await open_session(user_id, state.provider)
                    playback = await session.provider.get_playback_state(session.token)
                except (AccountNotConnected, ProviderError) as exc:
                    logger.warning("watcher %s: %s", run_id, exc)
                    await asyncio.sleep(_backoff(exc, settings.watcher_poll_seconds))
                    continue

                # window_size lets reconcile recognise the AN-2 window-end
                # patterns (ADR-002 Auflage 2); state.window_anchor carries
                # which window this process last asserted.
                verdict = engine.reconcile(
                    state, playback, previous_state=previous_state,
                    window_size=settings.context_window_size,
                )
                handle = self._handles.get(run_id)

                if verdict.idle:
                    idle_since = idle_since or time.time()
                    if time.time() - idle_since > settings.watcher_idle_timeout_seconds:
                        await db.record_event(
                            run_id, "watcher_stopped", cursor=state.cursor,
                            detail={"reason": "idle timeout"},
                        )
                        logger.info("run %s idle too long — stopping watcher", run_id)
                        return
                else:
                    idle_since = None

                if verdict.drifted:
                    if handle and not handle.drifted:
                        handle.drifted = True
                        await db.record_event(
                            run_id, "drift", cursor=state.cursor,
                            detail={"note": verdict.note,
                                    "playing": playback.track_id if playback else None},
                        )
                        logger.info("run %s drifted: %s", run_id, verdict.note)
                elif handle and handle.drifted and not verdict.idle:
                    handle.drifted = False
                    await db.record_event(
                        run_id, "drift_resolved", cursor=state.cursor
                    )

                # F8 (WP3-D3): every observation feeds the manual-use state
                # machine.  While an episode is open (detected / awaiting /
                # suspended) True Shuffle only observes — no advance, no
                # commands; the machine itself decides resume/pause/suspend
                # per manual_use_policy.  A pure idle poll outside an episode
                # is NOT a manual observation (Zustand D handling above).
                manual_state = runs.MANUAL_NONE
                try:
                    manual_state = await runs.manual_tick(
                        session, state,
                        drifted=verdict.drifted,
                        idle=verdict.idle,
                        advancing=verdict.should_advance,
                        playback=playback,
                    )
                except ProviderError as exc:
                    # The auto_resume window assert can fail like any other
                    # command (device gone) — observe on, next poll retries.
                    logger.warning("watcher %s: manual resume failed: %s",
                                   run_id, exc)
                    await asyncio.sleep(
                        _backoff(exc, settings.watcher_poll_seconds)
                    )
                    continue
                if manual_state != runs.MANUAL_NONE:
                    if manual_state == runs.MANUAL_SUSPENDED:
                        # The run was paused in a controlled way — the top of
                        # the next loop iteration ends this watcher.
                        logger.info("run %s suspended after manual use", run_id)
                    previous_state = playback
                    if handle is not None:
                        handle.last_state = playback
                    await asyncio.sleep(
                        _next_delay(playback, settings.watcher_poll_seconds,
                                    paused=True)
                    )
                    continue

                # MAN-05 (Phase 4): the listener moved OUR playback to another
                # device — same title, new device_id.  That is deliberate use,
                # not a takeover: follow the playback so later commands reach
                # the device the listener is actually hearing, instead of
                # yanking audio back to the old one.  Ledger says so once.
                if (
                    playback is not None
                    and playback.is_playing
                    and not verdict.drifted
                    and playback.track_id == state.current_track_id
                    and playback.device_id
                    and state.device_id
                    and playback.device_id != state.device_id
                ):
                    await db.update_run(run_id, device_id=playback.device_id)
                    state.device_id = playback.device_id
                    await db.record_event(
                        run_id, "device_changed", cursor=state.cursor,
                        detail={"note": "playback moved to another device — "
                                        "following it"},
                    )
                    logger.info("run %s followed playback to a new device",
                                run_id)

                # ADR-004 self-healing: the expected title demonstrably plays
                # but no window is known to be set (process restart, or a
                # failed immediate re-assert after a replan).  Assert the
                # fresh window now, position preserved — instead of waiting
                # for the next boundary and hard-restarting a title there
                # (the old SP-006 residue).
                if (
                    not verdict.should_advance
                    and not verdict.drifted
                    and not verdict.idle
                    and state.window_anchor is None
                    and playback is not None
                    and playback.is_playing
                    and playback.track_id == state.current_track_id
                ):
                    async with runs.advance_lock(run_id):
                        fresh = await runs.get_state(run_id, user_id)
                        if (
                            fresh is not None
                            and fresh.status is RunStatus.ACTIVE
                            and fresh.cursor == state.cursor
                            and fresh.window_anchor is None
                        ):
                            outcome = await runs.reassert_window(
                                session, fresh, cause="watcher",
                                playback=playback,
                            )
                            if outcome == "failed":
                                # Like any failed command: back off, re-poll.
                                await asyncio.sleep(
                                    max(settings.watcher_poll_seconds * 2,
                                        MIN_SLEEP)
                                )
                                continue

                if verdict.should_advance:
                    try:
                        async with runs.advance_lock(run_id):
                            # Re-read under the lock: a browser event may have
                            # advanced this run while we were polling.
                            fresh = await runs.get_state(run_id, user_id)
                            if (
                                fresh is not None
                                and fresh.status is RunStatus.ACTIVE
                                and fresh.cursor == state.cursor
                            ):
                                assert verdict.reason is not None
                                await runs.advance(
                                    session, fresh, reason=verdict.reason,
                                    device_id=fresh.device_id,
                                )
                                state = fresh
                    except ProviderError as exc:
                        # ADR-002 Auflagen 1 + 5: a command that failed (device
                        # gone → 404, quota → 429) consumed nothing — runs.advance
                        # persists the cursor only after the command landed.
                        # Back off (respecting Retry-After when the provider
                        # sent one) and re-poll instead of doubling commands.
                        logger.warning("watcher %s: advance failed: %s", run_id, exc)
                        await asyncio.sleep(
                            _backoff(exc, settings.watcher_poll_seconds)
                        )
                        continue

                previous_state = playback
                if handle is not None:
                    handle.last_state = playback

                await asyncio.sleep(
                    _next_delay(playback, settings.watcher_poll_seconds,
                                paused=verdict.drifted)
                )
        except asyncio.CancelledError:  # pragma: no cover - shutdown path
            raise
        except Exception:
            logger.exception("watcher for run %s crashed", run_id)
        finally:
            self._handles.pop(run_id, None)


def _backoff(exc: BaseException, base: float) -> float:
    """How long to sleep after a provider failure.

    ADR-002 Auflage 5: a 429 carries ``Retry-After`` — respect it instead of
    hammering.  ``providers.http`` already waits Retry-After out for transient
    429s inside one request; what surfaces here is the give-up case (or a
    simulator-injected 429 whose ``retry_after_s`` rides on the exception).
    """
    retry_after = getattr(exc, "retry_after_s", None)
    try:
        retry_after = float(retry_after) if retry_after is not None else 0.0
    except (TypeError, ValueError):
        retry_after = 0.0
    return max(retry_after, base * 2, MIN_SLEEP)


def _next_delay(
    playback: Optional[PlaybackState], base: float, *, paused: bool = False
) -> float:
    """Sleep until just after the current track should end.

    Polling a fixed 4 s wastes calls during a five-minute song and still reacts
    late at the end of a 90-second one.
    """
    if paused:
        return max(base * 2, MIN_SLEEP)
    if playback is None or not playback.is_playing:
        return max(base, MIN_SLEEP)
    remaining = playback.remaining_ms / 1000.0
    if remaining <= 0:
        return MIN_SLEEP
    return max(MIN_SLEEP, min(base, remaining + END_MARGIN))


#: Process-wide singleton; the app wires shutdown to :meth:`Watcher.stop_all`.
watcher = Watcher()
