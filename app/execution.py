"""How a decision becomes a command on a real player (ADR-002 / ADR-005).

Everything the deck decides is provider-neutral; everything in this module is
the opposite — it is the one place that knows how a particular service has to
be talked to so that it actually plays what we planned.

Why this module exists at all
-----------------------------
ADR-002 chose the **uris window**: one ``PUT /me/player/play`` carrying the
next N track uris, after which the service plays through them on its own.  That
is the cheapest correct strategy *when the service honours it*.  It was never
verified against a real Spotify client, and the live report says it is not
universally honoured: on at least some clients only ``uris[0]`` is played, the
rest is dropped, and Spotify's own recommendations fill the queue.  From the
deck's point of view the very next thing it sees is a foreign track — which the
old code read as "the listener took over", so it stopped driving and never
booked the card that had just played.

So the strategy is no longer a belief.  Three of them live here:

``uris_window``
    The cheap one.  Zero artifacts in the listener's account.  Kept, because on
    clients that honour it, it is strictly better than everything else.
``context_playlist``
    The reliable one.  A private helper playlist in the listener's account,
    played as ``context_uri``.  Every client plays a playlist correctly, and
    ``GET /me/player`` reports the context back — so "is the service still
    playing our order?" becomes an observation instead of a guess.  The price
    is honest and visible: a playlist appears in the account, and we have to
    clean it up.
``no_prefetch``
    The degraded one.  One title per command, next command only after the end
    was observed.  No artifacts, but an audible gap at every transition and a
    race against Autoplay on every track.  ``single_uri`` is a documented alias.

Which one a run uses is *measured*, not assumed: see :func:`probe_uris_window`
and the ``context_lost`` downgrade in :mod:`app.runs`.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app import db
from app.accounts import Session
from core.models import RunState
from providers.base import (
    PlaybackControl,
    ProviderError,
    Unsupported,
)

logger = logging.getLogger(__name__)

#: Structured trail of every command we send to a provider player.
_command_log = logging.getLogger("ts.provider.command")

URIS_WINDOW = "uris_window"
CONTEXT_PLAYLIST = "context_playlist"
NO_PREFETCH = "no_prefetch"
#: Historic name in the schema's CHECK constraint.  It describes exactly what
#: ``no_prefetch`` does, so it folds onto it rather than earning a fourth code
#: path nobody would keep correct.
SINGLE_URI = "single_uri"

STRATEGIES = (SINGLE_URI, URIS_WINDOW, CONTEXT_PLAYLIST, NO_PREFETCH)

#: How many cards go into the helper playlist before playback starts.  One
#: request (Spotify's write batch is 100), so the listener hears music about as
#: fast as with the uris window; the rest streams in behind it.
HEAD_ITEMS = 100

#: How far the helper playlist is filled in total.  2 000 cards is ~130 hours
#: of audio for 20 write requests — far enough that most runs never reach a
#: chunk boundary, cheap enough that creating a run stays fast.  A Spotify
#: playlist holds 10 000, so this is our budget, not their limit.
CHUNK_ITEMS = 2_000

#: When the cursor comes this close to the end of what the helper playlist
#: actually contains, the next chunk is asserted.  Must be large enough that a
#: failed refill has several tracks to be retried in.
REFILL_MARGIN = 50

#: Name and description of the helper playlist, in the interface's language.
_PLAYLIST_NAME = "true-shuffle · {name}"
_PLAYLIST_NOTE = (
    "Arbeitsdatei von true-shuffle für den Hörvorgang „{name}“. "
    "Sie enthält die geplante Reihenfolge und wird beim Beenden des "
    "Hörvorgangs wieder entfernt. Änderungen daran gehen verloren."
)


@dataclass
class Assertion:
    """What actually got set on the provider.

    ``command`` is ``"play"``, ``"skip"`` or ``None`` (nothing was sent).  The
    rest describes the context now believed to be running, so the caller can
    persist it in one place instead of guessing from the decision.
    """

    command: Optional[str] = None
    anchor: Optional[int] = None
    size: int = 0
    context_uri: Optional[str] = None
    strategy: str = URIS_WINDOW
    #: Free-form notes for the ledger (mode forcing, probe outcome, …).
    detail: Dict[str, Any] = field(default_factory=dict)

    @property
    def asserted(self) -> bool:
        return self.command == "play"


def normalise(strategy: Optional[str]) -> str:
    """Map a stored/configured value onto a strategy that has code behind it."""
    value = (strategy or URIS_WINDOW).strip()
    if value == SINGLE_URI:
        return NO_PREFETCH
    if value not in STRATEGIES:
        return URIS_WINDOW
    return value


def effective_strategy(state: RunState, session: Session) -> str:
    """The strategy this run really runs under.

    The run's own (possibly downgraded) value wins over anything configured —
    a downgrade is a *measurement*, and re-deciding it from configuration on
    every command would resurrect the very bug it was made to fix.  A provider
    that cannot do playlist contexts falls back to the uris window rather than
    failing.
    """
    strategy = normalise(state.execution_strategy)
    caps = session.provider.capabilities
    if strategy == CONTEXT_PLAYLIST and not caps.supports_context_playlist:
        return URIS_WINDOW
    if strategy == URIS_WINDOW and not caps.supports_context_window:
        return NO_PREFETCH
    return strategy


# ---------------------------------------------------------------------------
# Player modes — the service's own shuffle is not compatible with ours
# ---------------------------------------------------------------------------

async def force_playback_modes(
    session: Session, *, device_id: Optional[str]
) -> Dict[str, Any]:
    """Switch the service's own shuffle and repeat off.

    True Shuffle *is* the shuffle: it hands the service an order it computed
    itself.  With the service's shuffle on, that order is scrambled again, and
    every title then arrives as something the deck did not plan — which used to
    read as drift and stop the run after one track.  Repeat is the same story
    for cards that were already booked.

    Failure is not fatal: a service without these controls, a device that just
    went away, an exhausted quota — none of them should stop the music from
    starting.  What we did (or could not do) goes into the returned detail so
    the ledger and the UI can be honest about it.
    """
    result: Dict[str, Any] = {}
    try:
        await session.provider.set_shuffle(
            session.token, state=False, device_id=device_id
        )
        result["shuffle"] = "off"
    except Unsupported:
        result["shuffle"] = "unsupported"
    except ProviderError as exc:
        result["shuffle"] = f"failed: {str(exc)[:120]}"
    try:
        await session.provider.set_repeat(
            session.token, state="off", device_id=device_id
        )
        result["repeat"] = "off"
    except Unsupported:
        result["repeat"] = "unsupported"
    except ProviderError as exc:
        result["repeat"] = f"failed: {str(exc)[:120]}"
    return result


# ---------------------------------------------------------------------------
# Helper playlist (context_playlist)
# ---------------------------------------------------------------------------

async def _fill_tail(
    session: Session,
    run_id: int,
    context_id: int,
    playlist_id: str,
    tail: List[str],
    head: List[str],
) -> None:
    """Append the rest of the chunk after playback has already started.

    Writing 2 000 ids before the first note would mean twenty round trips of
    silence.  The head chunk is enough to play from immediately; this fills the
    runway behind it.  Appending is the *safe* playlist mutation — we never
    replace or reorder a playlist the service is currently playing.
    """
    done = list(head)
    written = len(done)
    try:
        size = session.provider.capabilities.write_batch_size
        for i in range(0, len(tail), size):
            batch = tail[i:i + size]
            await session.provider.add_tracks(session.token, playlist_id, batch)
            done.extend(batch)
            written += len(batch)
    except (ProviderError, Unsupported) as exc:
        # The head chunk is playing; a short runway is a smaller problem than a
        # dead run.  Correct the row DOWN to what really made it into the
        # playlist — the refill margin reasons about that number, and an
        # optimistic one would let the service reach the end of our cards.
        logger.warning("run %s: context playlist fill stopped at %s — %s",
                       run_id, written, exc)
        await db.update_run_context(
            context_id, item_count=written, fingerprint=_fingerprint(done),
        )
        await db.record_event(
            run_id, "context_fill_failed", cursor=0,
            detail={"written": written, "planned": len(head) + len(tail),
                    "error": str(exc)[:200]},
        )


def _fingerprint(ids: List[str]) -> str:
    """Short, stable hash of the ids a helper playlist was built from."""
    digest = hashlib.sha256("|".join(ids).encode("utf-8")).hexdigest()
    return digest[:16]


def _context_uri(provider: str, playlist_id: str) -> str:
    return (
        f"spotify:playlist:{playlist_id}" if provider == "spotify"
        else playlist_id
    )


async def ensure_context_playlist(
    session: Session,
    state: RunState,
    *,
    anchor: int,
    background_fill: bool = True,
) -> Dict[str, Any]:
    """Make sure a helper playlist covers the cursor and matches the plan.

    Returns ``{"playlist_id", "uri", "anchor", "item_count", "reused"}``.

    Two rules, and both exist because getting them wrong is expensive in the
    listener's account rather than in ours:

    * **Reuse whatever already covers this position.**  Every re-assert
      (a step back, a device change, a recovered context) would otherwise mint
      another playlist — one run could leave a dozen behind.  A covering
      context is played at an offset instead.
    * **Never reuse a playlist the plan has moved on from.**  An exclusion or a
      rule change rewrites the order underneath a playlist that is already in
      the account; the anchor would still fit, and we would happily keep
      playing the old order.  The fingerprint of the ids we wrote is what
      catches that.

    Playlists that no longer cover the cursor are unfollowed as we go, so at
    most two exist at any time.
    """
    contexts = await db.list_run_contexts(state.run_id)
    stale: List[Dict[str, Any]] = []
    for row in contexts:
        row_anchor = int(row["anchor"])
        count = int(row["item_count"])
        end = row_anchor + count
        covers = count > 0 and row_anchor <= anchor < end
        written = state.order[row_anchor:end]
        matches = str(row["fingerprint"] or "") == _fingerprint(written)
        # Reusing a context that is about to run out defeats the refill it was
        # called for: the point of asserting early is that the service must
        # never reach the end of our cards, because that is the moment Autoplay
        # takes the device.  A context that reaches the end of the plan has no
        # such problem — there is nothing left to run into.
        has_runway = end >= len(state.order) or (end - anchor) > REFILL_MARGIN
        if covers and matches and has_runway:
            return {
                "playlist_id": row["playlist_id"],
                "uri": _context_uri(state.provider, str(row["playlist_id"])),
                "anchor": row_anchor,
                "item_count": count,
                "context_id": int(row["id"]),
                "reused": True,
            }
        stale.append(row)

    chunk = state.order[anchor:anchor + CHUNK_ITEMS]
    if not chunk:
        raise ProviderError("execution: nothing left to put into a context")

    live_slots = {str(c["slot"]) for c in contexts}
    slot = next((s for s in ("a", "b") if s not in live_slots), "a")

    name = state.playlist_name or state.playlist_id
    playlist = await session.provider.create_playlist(
        session.token,
        name=_PLAYLIST_NAME.format(name=name)[:100],
        description=_PLAYLIST_NOTE.format(name=name)[:300],
    )
    head = chunk[:HEAD_ITEMS]
    await session.provider.add_tracks(session.token, playlist.id, head)
    # Recorded for the WHOLE chunk, not just the head that is already written:
    # the tail is being appended right now, and reading the row back before it
    # lands would make every context look HEAD_ITEMS long — which would trigger
    # a refill at card 50 of a 2 000-card context, every time.  A fill that
    # fails corrects this back down (see _fill_tail).
    context_id = await db.create_run_context(
        state.run_id, state.provider, playlist.id,
        slot=slot, anchor=anchor, item_count=len(chunk),
        fingerprint=_fingerprint(chunk),
    )

    # The superseded ones go back out of the account.  Doing it AFTER the new
    # playlist exists means a failure here leaves a stray playlist, not a run
    # with nothing to play.
    for row in stale:
        with contextlib.suppress(ProviderError, Unsupported):
            await session.provider.delete_playlist(
                session.token, str(row["playlist_id"])
            )
            await db.mark_context_deleted(int(row["id"]))

    tail = chunk[HEAD_ITEMS:]
    if tail:
        coro = _fill_tail(
            session, state.run_id, context_id, playlist.id, tail, head
        )
        if background_fill:
            _track_fill(state.run_id, asyncio.create_task(coro))
        else:
            await coro

    return {
        "playlist_id": playlist.id,
        "uri": _context_uri(state.provider, playlist.id),
        "anchor": anchor,
        "item_count": len(chunk),
        "context_id": context_id,
        "reused": False,
    }


#: ``run_id → in-flight fill tasks``.  Strong references, because a task
#: nobody holds can be garbage collected mid-write; keyed by run, because a
#: cleanup has to be able to stop the task that is filling the very playlist it
#: is about to unfollow.
_FILL_TASKS: Dict[int, set] = {}


def _track_fill(run_id: int, task: asyncio.Task) -> None:
    _FILL_TASKS.setdefault(run_id, set()).add(task)

    def _done(finished: asyncio.Task) -> None:
        tasks = _FILL_TASKS.get(run_id)
        if tasks is None:
            return
        tasks.discard(finished)
        if not tasks:
            _FILL_TASKS.pop(run_id, None)

    task.add_done_callback(_done)


async def cancel_fills(run_id: int) -> None:
    """Stop filling a run's helper playlists.

    Called before removing them: a fill that keeps appending to an unfollowed
    playlist writes into the listener's account for no reason, and updates a
    row that is already gone.
    """
    for task in list(_FILL_TASKS.get(run_id, ())):
        task.cancel()
        with contextlib.suppress(BaseException):
            await task
    _FILL_TASKS.pop(run_id, None)


async def drain_fill_tasks() -> None:
    """Shutdown/test hook: wait for the background playlist fills to settle."""
    tasks = [t for group in _FILL_TASKS.values() for t in group]
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def cleanup_contexts(
    session: Optional[Session], run_id: int
) -> List[str]:
    """Remove every helper playlist this run created.

    Returns the ids that could NOT be removed — a run whose token is already
    gone leaves litter in the listener's account, and the only honest thing we
    can do then is name it so they can delete it by hand.
    """
    await cancel_fills(run_id)
    rows = await db.list_run_contexts(run_id)
    stuck: List[str] = []
    for row in rows:
        if session is None:
            stuck.append(str(row["playlist_id"]))
            continue
        try:
            await session.provider.delete_playlist(
                session.token, str(row["playlist_id"])
            )
        except (ProviderError, Unsupported) as exc:
            logger.warning("run %s: helper playlist %s not removed — %s",
                           run_id, row["playlist_id"], exc)
            stuck.append(str(row["playlist_id"]))
            continue
        await db.mark_context_deleted(int(row["id"]))
    if rows:
        await db.record_event(
            run_id, "context_cleanup", cursor=0,
            detail={"removed": len(rows) - len(stuck), "stuck": stuck},
        )
    return stuck


# ---------------------------------------------------------------------------
# The probe — is the cheap strategy actually being honoured?
# ---------------------------------------------------------------------------

async def probe_uris_window(
    session: Session, window: List[str]
) -> Optional[Dict[str, Any]]:
    """Read the queue back and see whether our window survived the play call.

    Deliberately weak evidence, and used accordingly.  ``GET /me/player/queue``
    returns about twenty entries and is reported to pad or loop when the real
    queue is shorter, and its answer is per device — so this may only ever
    *downgrade* a run to the reliable strategy, never promote one back to the
    cheap strategy.  A false "looks fine" would recreate exactly the bug this
    was written for.

    Returns ``None`` when nothing could be measured.
    """
    if not session.provider.capabilities.supports_queue_read or len(window) < 2:
        return None
    try:
        queue = await session.provider.get_queue(session.token)
    except (ProviderError, Unsupported):
        return None
    if not queue:
        return None
    ids = list(queue.get("queue_ids") or [])
    expected = window[1:1 + min(5, len(window) - 1)]
    if not ids:
        return {"honoured": False, "expected": expected, "seen": [],
                "note": "queue empty right after the window was set"}
    seen = ids[:len(expected)]
    return {
        "honoured": seen == expected,
        "expected": expected,
        "seen": seen,
        "note": "prefix comparison against the asserted window",
    }


# ---------------------------------------------------------------------------
# Sending the command
# ---------------------------------------------------------------------------

async def assert_playback(
    session: Session,
    state: RunState,
    *,
    strategy: str,
    window: List[str],
    cursor: int,
    device_id: Optional[str],
    position_ms: int,
    correlation_id: str,
) -> Assertion:
    """Send exactly ONE play command in the given strategy and report it back.

    Every play is preceded by putting the service's own shuffle and repeat back
    to off: true-shuffle computes the order, and a service that re-shuffles it
    defeats the whole point.  Two writes, and only where the connector says it
    can do them.
    """
    detail: Dict[str, Any] = {}
    if session.provider.capabilities.supports_playback_modes:
        detail["modes"] = await force_playback_modes(session, device_id=device_id)

    if strategy == CONTEXT_PLAYLIST:
        context = await ensure_context_playlist(session, state, anchor=cursor)
        offset = cursor - int(context["anchor"])
        _command_log.info(
            "corr=%s run=%s kind=play-context target=%s cursor=%s "
            "context=%s offset=%s position_ms=%s",
            correlation_id, state.run_id, window[0] if window else None,
            cursor, context["playlist_id"], offset, position_ms,
        )
        await session.provider.play_context(
            session.token, context_uri=str(context["uri"]),
            offset_position=max(0, offset), device_id=device_id,
            position_ms=position_ms,
        )
        detail["context_playlist"] = context["playlist_id"]
        return Assertion(
            command="play",
            anchor=int(context["anchor"]),
            size=int(context["item_count"]),
            context_uri=str(context["uri"]),
            strategy=strategy,
            detail=detail,
        )

    payload = window[:1] if strategy == NO_PREFETCH else window
    _command_log.info(
        "corr=%s run=%s kind=play target=%s cursor=%s window=%s offset=0 "
        "position_ms=%s strategy=%s",
        correlation_id, state.run_id, payload[0] if payload else None,
        cursor, len(payload), position_ms, strategy,
    )
    await session.provider.play(
        session.token, track_ids=payload, offset_position=0,
        device_id=device_id, position_ms=position_ms,
    )
    return Assertion(
        command="play",
        anchor=cursor,
        size=len(payload),
        context_uri=None,
        strategy=strategy,
        detail=detail,
    )


def needs_refill(state: RunState) -> bool:
    """True when the running context is about to run out of our cards.

    The whole point of the context strategy is that the service never reaches
    the end of what we gave it — because the moment it does, Autoplay takes
    over with music that is not in the deck.
    """
    if state.window_anchor is None or not state.window_size:
        return False
    end = state.window_anchor + state.window_size
    if end >= len(state.order):
        return False
    return state.cursor >= end - REFILL_MARGIN


def is_remote(session: Session) -> bool:
    return session.provider.capabilities.playback is PlaybackControl.REMOTE_DEVICE


__all__ = [
    "CHUNK_ITEMS",
    "CONTEXT_PLAYLIST",
    "HEAD_ITEMS",
    "NO_PREFETCH",
    "REFILL_MARGIN",
    "SINGLE_URI",
    "STRATEGIES",
    "URIS_WINDOW",
    "Assertion",
    "assert_playback",
    "cleanup_contexts",
    "drain_fill_tasks",
    "effective_strategy",
    "ensure_context_playlist",
    "force_playback_modes",
    "is_remote",
    "needs_refill",
    "normalise",
    "probe_uris_window",
]
