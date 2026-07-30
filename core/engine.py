"""Run state machine — the deck-of-cards logic, with zero I/O.

This is the heart of the product promise:

* every playable, unique track exactly once per run;
* the cursor only ever moves forward, and only once per real playback event;
* a run can be paused and resumed at exactly the same card.

The engine is deliberately pure: it takes a :class:`RunState` plus an
observation and returns a :class:`Decision`.  Persistence, HTTP and provider
quirks live in the app layer, which makes all of this trivially testable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from core.models import AdvanceReason, PlaybackState, RunState, RunStatus


class RunError(Exception):
    """Raised when an operation is invalid for the run's current status."""


@dataclass
class Decision:
    """What the app layer should do after an engine call."""

    #: The new cursor position.
    cursor: int
    #: Track id that should now be playing (``None`` when the deck is done).
    play_track_id: Optional[str] = None
    #: Tracks to (re)queue behind the current one.
    queue_track_ids: List[str] = field(default_factory=list)
    #: Whether the cursor actually moved.
    advanced: bool = False
    #: Whether the run just finished.
    completed: bool = False
    #: Whether the provider needs a hard override (PUT /play) rather than
    #: simply being left alone.
    needs_override: bool = True
    reason: Optional[AdvanceReason] = None
    note: str = ""


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

_LIVE_STATUSES = (RunStatus.ACTIVE, RunStatus.PAUSED)


def ensure_live(run: RunState) -> None:
    """Raise unless the run can still progress."""
    if run.status not in _LIVE_STATUSES:
        raise RunError(f"Run {run.run_id} is {run.status.value} and cannot progress")


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------

def start(run: RunState, *, queue_buffer: int = 5) -> Decision:
    """Begin (or resume) a run at its stored cursor.

    Resuming is the differentiator: we do not restart the deck, we re-assert
    the card the listener stopped on.
    """
    ensure_live(run)
    if run.cursor >= run.total:
        return Decision(cursor=run.cursor, completed=True, needs_override=False,
                        note="deck already complete")
    return Decision(
        cursor=run.cursor,
        play_track_id=run.order[run.cursor],
        queue_track_ids=run.upcoming(queue_buffer),
        note="resume" if run.cursor > 0 else "start",
    )


def advance(
    run: RunState,
    *,
    reason: AdvanceReason,
    queue_buffer: int = 5,
    steps: int = 1,
) -> Decision:
    """Move the cursor forward and report what should play next.

    A user skip and a finished track both consume exactly one card — this is
    the rule that makes "no repeats until the deck is done" true even when the
    listener skips a lot.
    """
    ensure_live(run)
    if steps < 1:
        raise RunError("advance() must move at least one card")

    new_cursor = min(run.cursor + steps, run.total)

    if new_cursor >= run.total:
        return Decision(
            cursor=run.total,
            advanced=True,
            completed=True,
            needs_override=False,
            reason=reason,
            note="deck complete",
        )

    return Decision(
        cursor=new_cursor,
        play_track_id=run.order[new_cursor],
        queue_track_ids=run.order[new_cursor + 1 : new_cursor + 1 + queue_buffer],
        advanced=True,
        reason=reason,
        # A track that ended naturally may already be followed by the correct
        # queued track — the app layer decides whether to override based on
        # what the provider reports.
        needs_override=reason is not AdvanceReason.TRACK_ENDED,
    )


def previous(run: RunState, *, queue_buffer: int = 5) -> Decision:
    """Step one card back.

    Going back does *not* re-deal the deck; it re-plays a card that was already
    consumed, which is why the cursor is clamped at zero.
    """
    ensure_live(run)
    new_cursor = max(0, run.cursor - 1)
    return Decision(
        cursor=new_cursor,
        play_track_id=run.order[new_cursor] if new_cursor < run.total else None,
        queue_track_ids=run.order[new_cursor + 1 : new_cursor + 1 + queue_buffer],
        advanced=new_cursor != run.cursor,
        reason=AdvanceReason.MANUAL,
        note="previous",
    )


# ---------------------------------------------------------------------------
# Reconciliation — what a polled playback snapshot means
# ---------------------------------------------------------------------------

#: A track is considered "finished" when less than this much is left and the
#: provider then stops reporting it.
NEAR_END_MS = 5_000

#: Progress below this on a track change means the previous track was skipped
#: rather than played to the end.
SKIP_PROGRESS_MS = 3_000


@dataclass
class Reconciliation:
    """Interpretation of a polled playback snapshot against the run."""

    #: ``None`` when nothing should happen.
    reason: Optional[AdvanceReason] = None
    #: True when the provider is playing something outside our deck and we
    #: should stop driving it (the listener went off to do their own thing).
    drifted: bool = False
    #: True when playback stopped entirely.
    idle: bool = False
    note: str = ""

    @property
    def should_advance(self) -> bool:
        return self.reason is not None


def reconcile(
    run: RunState,
    state: Optional[PlaybackState],
    *,
    previous_state: Optional[PlaybackState] = None,
) -> Reconciliation:
    """Decide what a playback snapshot means for the run.

    Handles the three cases the old PoC could not:

    1. the expected track finished on its own → advance (``TRACK_ENDED``);
    2. the listener pressed *next* in the provider's own app → advance
       (``NATIVE_SKIP``) so we stay one deck, not two;
    3. the provider is playing something we never dealt → report drift instead
       of fighting the user for control.
    """
    expected = run.current_track_id

    if state is None or state.is_idle:
        return Reconciliation(idle=True, note="no active playback session")

    if expected is None:
        return Reconciliation(note="deck complete")

    # Still on the expected track.
    if state.track_id == expected:
        return Reconciliation(note="on expected track")

    # Provider moved on to the track we queued next → it played through.
    upcoming = run.upcoming(1)
    if upcoming and state.track_id == upcoming[0]:
        prev_progress = previous_state.progress_ms if previous_state else 0
        prev_duration = previous_state.duration_ms if previous_state else 0
        played_out = (
            prev_duration > 0 and prev_duration - prev_progress <= NEAR_END_MS
        )
        if played_out or state.progress_ms > SKIP_PROGRESS_MS:
            return Reconciliation(
                reason=AdvanceReason.TRACK_ENDED, note="advanced into queued track"
            )
        return Reconciliation(
            reason=AdvanceReason.NATIVE_SKIP, note="skipped into queued track"
        )

    # Something else entirely is playing.
    if state.track_id in run.order:
        return Reconciliation(
            drifted=True,
            note="provider jumped to another track from this playlist",
        )
    return Reconciliation(drifted=True, note="provider is playing outside the deck")
