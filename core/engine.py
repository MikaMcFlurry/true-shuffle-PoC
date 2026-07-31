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
from typing import List, Optional, Sequence

from core.models import AdvanceReason, PlaybackState, RunState, RunStatus


class RunError(Exception):
    """Raised when an operation is invalid for the run's current status."""


@dataclass
class Decision:
    """What the app layer should do after an engine call."""

    #: The new cursor position.
    cursor: int
    #: Track id that should now be playing (``None`` when the deck is done).
    #: Web-player providers keep using exactly this field — the page plays it.
    play_track_id: Optional[str] = None
    #: ADR-002 (uris window): the titles from the cursor on, at most
    #: ``window_size`` of them.  A remote provider receives the whole window in
    #: ONE play call and then plays through it on its own; ``POST /queue`` is
    #: never used any more.  Empty when no command is needed (the previously
    #: set window is still running) — see :attr:`needs_override`.
    play_window: List[str] = field(default_factory=list)
    #: Whether the cursor actually moved.
    advanced: bool = False
    #: Whether the run just finished.
    completed: bool = False
    #: Whether the provider needs a hard override (PUT /play with the window)
    #: rather than simply being left alone.
    needs_override: bool = True
    #: ADR-002: a TS-initiated skip while the provider is inside our window
    #: prefers the lightweight ``next`` command over re-asserting a whole new
    #: window.  :attr:`play_window` still carries the fresh window so a
    #: provider without a ``skip_next`` can fall back to a full play.
    use_skip_next: bool = False
    reason: Optional[AdvanceReason] = None
    note: str = ""


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

_LIVE_STATUSES = (RunStatus.ACTIVE, RunStatus.PAUSED)


#: What each non-live status means to the listener. These reach the browser,
#: so they are written in the interface's language rather than the log's.
#: 'stopped' (F1, ADR-003) is deliberately NOT terminal: it is not live — the
#: watcher is gone, the device released — but its text invites resumption
#: instead of declaring the run dead.
_TERMINAL_TEXT = {
    RunStatus.COMPLETED: "Dieses Fach ist durchgehört — leg ein neues an.",
    RunStatus.CANCELLED: "Dieser Lauf wurde beendet.",
    RunStatus.STOPPED: (
        "Dieser Lauf ist gestoppt — setze ihn fort, um genau an dieser "
        "Karte weiterzuhören."
    ),
}


def ensure_live(run: RunState) -> None:
    """Raise unless the run can still progress."""
    if run.status not in _LIVE_STATUSES:
        raise RunError(
            _TERMINAL_TEXT.get(run.status, "Dieser Lauf kann nicht weiterlaufen.")
        )


def resume_status(run: RunState) -> RunStatus:
    """The status a resume request results in (F1: ``stopped → active``).

    Pure decision, no mutation: ``stopped`` and the live statuses resume to
    ``active``; the truly terminal statuses (completed / cancelled) raise with
    their listener-facing text — resuming them is what ``ensure_live`` has
    always refused.
    """
    if run.status is RunStatus.STOPPED or run.status in _LIVE_STATUSES:
        return RunStatus.ACTIVE
    raise RunError(
        _TERMINAL_TEXT.get(run.status, "Dieser Lauf kann nicht weiterlaufen.")
    )


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------

#: ADR-002: default size of the uris window.  Conservative and configurable
#: (``CONTEXT_WINDOW_SIZE``); the documented body limit of ``PUT /play`` is
#: unknown — live measurement LT-13 before raising it.
DEFAULT_WINDOW_SIZE = 250


def _window(run: RunState, start_cursor: int, window_size: int) -> List[str]:
    """The uris window: ``min(verbleibend, window_size)`` titles from *start_cursor*."""
    return run.order[start_cursor : start_cursor + max(1, window_size)]


def _in_window(run: RunState, cursor: int, window_size: int) -> bool:
    """True when *cursor* is covered by the window the caller last set.

    ``window_anchor`` is ``None`` after a restart (or for web-player runs) —
    then nothing is known to be set and every move re-asserts a fresh window.
    """
    return (
        run.window_anchor is not None
        and run.window_anchor <= cursor < run.window_anchor + max(1, window_size)
    )


def start(run: RunState, *, window_size: int = DEFAULT_WINDOW_SIZE) -> Decision:
    """Begin (or resume) a run at its stored cursor.

    Resuming is the differentiator: we do not restart the deck, we re-assert
    the card the listener stopped on — ADR-002: as ONE play call carrying the
    uris window from the cursor on.
    """
    ensure_live(run)
    if run.cursor >= run.total:
        return Decision(cursor=run.cursor, completed=True, needs_override=False,
                        note="deck already complete")
    return Decision(
        cursor=run.cursor,
        play_track_id=run.order[run.cursor],
        play_window=_window(run, run.cursor, window_size),
        needs_override=True,
        note="resume" if run.cursor > 0 else "start",
    )


def advance(
    run: RunState,
    *,
    reason: AdvanceReason,
    window_size: int = DEFAULT_WINDOW_SIZE,
    steps: int = 1,
) -> Decision:
    """Move the cursor forward and report what should play next.

    A user skip and a finished track both consume exactly one card — this is
    the rule that makes "no repeats until the deck is done" true even when the
    listener skips a lot.

    ADR-002 command discipline: inside the currently set window the context
    plays on its own, so a natural track end and a native skip produce NO
    player command at all.  A TS-initiated skip prefers the lightweight
    ``next`` command while the provider is inside our window.  Everything
    else — window boundary, no known window (restart), failure recovery —
    re-asserts a fresh uris window.
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

    in_window = _in_window(run, new_cursor, window_size)

    if in_window and reason in (AdvanceReason.TRACK_ENDED, AdvanceReason.NATIVE_SKIP):
        # The set context already carries this title — sending anything would
        # be the old bug (SP-008) in new clothes.
        return Decision(
            cursor=new_cursor,
            play_track_id=run.order[new_cursor],
            play_window=[],
            advanced=True,
            reason=reason,
            needs_override=False,
            note="context continues within the window",
        )

    if in_window and reason in (AdvanceReason.MANUAL, AdvanceReason.USER_SKIP):
        # TS-UI skip while the provider plays our window: one `next` beats
        # re-sending 250 uris.  play_window stays filled as the fallback for
        # providers without a skip command.
        return Decision(
            cursor=new_cursor,
            play_track_id=run.order[new_cursor],
            play_window=_window(run, new_cursor, window_size),
            advanced=True,
            reason=reason,
            needs_override=False,
            use_skip_next=True,
            note="ts skip inside the window",
        )

    return Decision(
        cursor=new_cursor,
        play_track_id=run.order[new_cursor],
        play_window=_window(run, new_cursor, window_size),
        advanced=True,
        reason=reason,
        needs_override=True,
        note="window boundary" if run.window_anchor is not None else "no window set",
    )


def previous(run: RunState, *, window_size: int = DEFAULT_WINDOW_SIZE) -> Decision:
    """Step one card back.

    Going back does *not* re-deal the deck; it re-plays a card that was already
    consumed, which is why the cursor is clamped at zero.  ADR-002: a step back
    always re-asserts a fresh window from the new cursor — the set context only
    ever runs forward.
    """
    ensure_live(run)
    new_cursor = max(0, run.cursor - 1)
    return Decision(
        cursor=new_cursor,
        play_track_id=run.order[new_cursor] if new_cursor < run.total else None,
        play_window=_window(run, new_cursor, window_size),
        advanced=new_cursor != run.cursor,
        reason=AdvanceReason.MANUAL,
        needs_override=True,
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


def _window_end(run: RunState, window_size: Optional[int]) -> Optional[int]:
    """Exclusive end of the currently set window, or ``None`` when unknown."""
    if run.window_anchor is None or not window_size:
        return None
    return min(run.window_anchor + window_size, run.total)


def reconcile(
    run: RunState,
    state: Optional[PlaybackState],
    *,
    previous_state: Optional[PlaybackState] = None,
    window_size: Optional[int] = None,
) -> Reconciliation:
    """Decide what a playback snapshot means for the run.

    Handles the three cases the old PoC could not:

    1. the expected track finished on its own → advance (``TRACK_ENDED``);
    2. the listener pressed *next* in the provider's own app → advance
       (``NATIVE_SKIP``) so we stay one deck, not two;
    3. the provider is playing something we never dealt → report drift instead
       of fighting the user for control.

    ADR-002 Auflage 2 adds the two window-end patterns of AN-2 (both policies
    of an exhausted context), which need ``window_size`` and the run's
    ``window_anchor`` to be recognisable:

    4. *replay*: the first title of the window plays again while the cursor
       sits on the window's last card → the context replayed after the window
       ran out; advance (``TRACK_ENDED``) so the caller overrides immediately
       with the next window instead of reading it as drift;
    5. *stop*: playback went idle right after the window's last card played
       out → advance (``TRACK_ENDED``) so the caller plays the next window.

    Auflage 1 stays intact: idle WITHOUT that played-out evidence — a device
    that disappeared mid-track (404 / no active device) — remains plain
    ``idle`` and consumes no card.
    """
    expected = run.current_track_id
    window_end = _window_end(run, window_size)
    on_last_window_card = window_end is not None and run.cursor == window_end - 1

    if state is None or state.is_idle:
        # AN-2 'stop' after the window's last card demonstrably played out.
        # The previous poll must have seen the expected title near its end —
        # anything else (device loss, manual stop mid-track) stays idle and
        # consumes nothing (Auflage 1).
        if (
            on_last_window_card
            and expected is not None
            and previous_state is not None
            and previous_state.track_id == expected
            and previous_state.duration_ms > 0
            and previous_state.remaining_ms <= NEAR_END_MS
        ):
            return Reconciliation(
                reason=AdvanceReason.TRACK_ENDED,
                note="context stopped after window end",
            )
        return Reconciliation(idle=True, note="no active playback session")

    if expected is None:
        return Reconciliation(note="deck complete")

    # Still on the expected track.
    if state.track_id == expected:
        return Reconciliation(note="on expected track")

    # Provider moved on to the next title of our window → it played through.
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

    # AN-2 'replay': the window ran out and the context started over — the
    # window's FIRST title plays again while the deck stands on its LAST card.
    # Without this pattern the replay would read as drift and the deck would
    # stall while old titles repeat (the audible "Titel 6 = Titel 1").
    if (
        on_last_window_card
        and run.window_anchor != run.cursor          # 1-card window is "expected"
        and state.track_id == run.order[run.window_anchor]  # type: ignore[index]
    ):
        return Reconciliation(
            reason=AdvanceReason.TRACK_ENDED,
            note="context replayed after window end",
        )

    # Something else entirely is playing.
    if state.track_id in run.order:
        return Reconciliation(
            drifted=True,
            note="provider jumped to another track from this playlist",
        )
    return Reconciliation(drifted=True, note="provider is playing outside the deck")


# ---------------------------------------------------------------------------
# Reconciliation from listening history — the no-open-tab path
# ---------------------------------------------------------------------------

#: How far ahead of the cursor a history match is still believed.  Services cap
#: their history at ~50 entries, so a match further out than this is far more
#: likely to be the same song played from somewhere else entirely.
HISTORY_LOOKAHEAD = 60


@dataclass
class HistoryVerdict:
    """How far a deck got, judged from the service's recently-played list."""

    cursor: int
    advanced: bool = False
    matched: int = 0
    completed: bool = False
    note: str = ""


def reconcile_history(
    run: RunState,
    played_track_ids: Sequence[str],
    *,
    lookahead: int = HISTORY_LOOKAHEAD,
) -> HistoryVerdict:
    """Advance the deck using what the service says was recently played.

    This is what lets a deck progress with **nothing of ours open**: the
    listener plays the shuffled playlist in Spotify or Apple Music directly,
    and we read back how far they got.

    The rule is deliberately conservative:

    * only the window ``[cursor, cursor + lookahead)`` is considered, so a song
      the listener happened to play from an album months later cannot yank the
      cursor to the end of the deck;
    * the cursor lands just past the **furthest** matched card, because playing
      the copy in order means everything before it was played too;
    * it never moves backwards — a deck only ever gets shorter.
    """
    if run.cursor >= run.total:
        return HistoryVerdict(cursor=run.cursor, completed=True, note="deck complete")

    played = {tid for tid in played_track_ids if tid}
    if not played:
        return HistoryVerdict(cursor=run.cursor, note="no history to read")

    window = run.order[run.cursor : run.cursor + lookahead]
    furthest = -1
    matched = 0
    for index, track_id in enumerate(window):
        if track_id in played:
            furthest = index
            matched += 1

    if furthest < 0:
        return HistoryVerdict(cursor=run.cursor, note="nothing from this deck was played")

    new_cursor = min(run.cursor + furthest + 1, run.total)
    return HistoryVerdict(
        cursor=new_cursor,
        advanced=new_cursor > run.cursor,
        matched=matched,
        completed=new_cursor >= run.total,
        note=f"{matched} card(s) played since the last check",
    )
