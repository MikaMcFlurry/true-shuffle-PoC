"""Strategy measurement harness — S1..S4 against the honest Spotify simulator.

Executable script (NOT pytest):

    python tests/forensics/strategy_bench.py --out-dir <dir>

Measures the four Phase-2 strategy candidates (plus the status quo as
baseline) against eight scenarios and writes a Markdown table + JSON.  The
candidates are implemented here as MINIMAL execution functions against
:mod:`tests.sim_spotify` — deliberately NOT integrated into the app code; the
lead decides integration per ADR (SP-007).

Measurement honesty (post-review):
* ``TRACK_MS`` is deliberately NOT poll-aligned (29 001 ms), so real silence
  cannot alias to zero; ``true_silence_ms`` is measured ms-exactly from the
  player event log, at BOTH poll intervals (1000 ms and 250 ms) — silence is
  primarily a function of the poll interval, not of the strategy.
* ``post_end_commands`` (formerly mislabelled "Lücken") is an honest command
  counter, not a silence measurement.
* Reads count against the quota (``rate_limit_reads=True``): polling is the
  dominant request-cost factor; a total-request column makes that visible.
* ``uncontrolled_repeats`` counts audio-stream repetitions (the same title
  HEARD more than once up to strategy completion) — the core invariant.
* Scenario (g) queues a DECK title manually; scenario (h) drops the active
  device mid-run — ``Api`` reports 404s instead of crashing (AN-7).

Candidates
----------
S0-additiv        status quo baseline: blind additive prefetch (what
                  ``app/runs.py::_apply`` does today) — for contrast only.
S1-fenster        ``play(uris=[cursor..cursor+N], offset=0)``; natural end
                  inside the window needs NO command; a new window only at the
                  window boundary, on drift, or on a TS-side skip.
S2-kein-prefetch  one ``play([track])`` per title change, nothing queued ahead.
S3-ein-slot       read the queue; append the next deck track only when missing
                  (idempotent one-slot prefetch).
S4-kontext        materialise the run order as a playlist once; play via
                  ``context_uri`` + offset; rewrite only on rule changes.

Evidence class: VERIFIED_AUTOMATED against declared simulator assumptions
(AN-1..AN-7, see tests/sim_spotify.py).  AN-2 is measured under BOTH policies
('replay_context' and 'stop') for every strategy — mandatory for S2, where the
context-restart risk at track end lives.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

try:
    from tests.sim_spotify import (
        SimNoActiveDevice,
        SimRateLimited,
        SimulatedSpotifyPlayer,
    )
except ImportError:  # direct script execution from anywhere
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from tests.sim_spotify import (
        SimNoActiveDevice,
        SimRateLimited,
        SimulatedSpotifyPlayer,
    )

POLL_MS = 1_000            # main measurement interval
POLL_MS_ALT = 250          # second run per cell — makes poll dependency visible
# Deliberately NOT a multiple of any poll interval: with 30 000 ms every track
# end fell exactly on a poll boundary and true silence aliased to 0 ms.
TRACK_MS = 29_001
QUEUE_BUFFER = 5           # mirrors settings.queue_buffer_size
SKIP_PROGRESS_MS = 3_000   # mirrors core.engine.SKIP_PROGRESS_MS


def _near_end_slack(poll_ms: int) -> int:
    """Harness detection slack: one poll interval + command grace."""
    return poll_ms + 700


def _uri(track_id: str) -> str:
    return f"spotify:track:{track_id}"


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

@dataclass
class Metrics:
    strategy: str
    scenario: str
    policy: str
    poll_ms: int = POLL_MS
    plays: int = 0
    enqueues: int = 0
    pauses: int = 0
    gets: int = 0              # playback-state reads + queue reads
    playlist_cmds: int = 0     # S4 only: create + item writes
    r429: int = 0              # requests answered 429 (each retried; reads too)
    no_device_404: int = 0     # player commands answered 404 NO_ACTIVE_DEVICE
    requests_total: int = 0    # reads + writes + retried 429 attempts
    post_end_commands: int = 0  # commands that became necessary AFTER a track end
    context_restarts: int = 0  # already-played material audibly restarted
    true_silence_ms: int = 0   # ms-exact audible silence up to strategy end
    true_silence_ms_poll250: Optional[int] = None  # same cell re-run at 250 ms
    uncontrolled_repeats: int = 0  # same title HEARD again (audio stream level)
    max_queue_dup: int = 0     # worst simultaneous occurrences of one track
    leftover_queue: int = 0    # queue entries left when the run finished/stalled
    manual_played: int = 0
    manual_displaced: int = 0
    device_loss_survived: Optional[bool] = None    # scenario (h) only
    completed: bool = False
    final_cursor: int = 0
    notes: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, object]:
        return dict(self.__dict__)


# ---------------------------------------------------------------------------
# Observation + classification (a deliberately small watcher-like reconcile)
# ---------------------------------------------------------------------------

@dataclass
class Obs:
    track_id: str
    progress_ms: int
    duration_ms: int
    is_playing: bool


def _near_end(obs: Optional[Obs], slack_ms: int) -> bool:
    return (
        obs is not None
        and obs.duration_ms > 0
        and obs.duration_ms - obs.progress_ms <= slack_ms
    )


def classify(
    prev: Optional[Obs], cur: Optional[Obs], order: List[str], cursor: int,
    *, slack_ms: int = _near_end_slack(POLL_MS),
) -> str:
    """Interpret one polled snapshot against the deck — reconcile-lite."""
    expected = order[cursor]
    nxt = order[cursor + 1] if cursor + 1 < len(order) else None

    if cur is None:
        if prev is not None and prev.track_id == expected and _near_end(prev, slack_ms):
            return "idle_end"
        return "idle"

    if cur.track_id == expected:
        if (
            prev is not None
            and prev.track_id == expected
            and cur.progress_ms + 500 < prev.progress_ms
        ):
            return "restart_current"
        if (
            prev is not None
            and prev.track_id != expected
            and prev.track_id not in order
            and cur.progress_ms <= slack_ms
        ):
            # After a manual interlude only S2's one-URI context can land back
            # on the consumed card — that is a replay, not progress.
            return "reentered_expected"
        return "on_expected"

    if nxt is not None and cur.track_id == nxt:
        if _near_end(prev, slack_ms) or cur.progress_ms > SKIP_PROGRESS_MS:
            return "advanced_natural"
        return "advanced_skip"

    if cur.track_id in order[: cursor + 1]:
        return "replay_old"
    if cur.track_id in order[cursor + 1 :]:
        return "jumped_ahead"
    return "interlude"


# ---------------------------------------------------------------------------
# Counted API access with honest 429 handling (wait Retry-After, then retry)
# ---------------------------------------------------------------------------

class Api:
    def __init__(self, player: SimulatedSpotifyPlayer, metrics: Metrics,
                 poll_ms: int = POLL_MS) -> None:
        self.player = player
        self.m = metrics
        self.poll_ms = poll_ms
        self.slack_ms = _near_end_slack(poll_ms)

    def _read(self, fn: Callable[[], Optional[Dict[str, Any]]]) -> Optional[Dict[str, Any]]:
        """Reads share the quota window (rate_limit_reads) — retry honestly."""
        for _ in range(6):
            try:
                return fn()
            except SimRateLimited as exc:
                self.m.r429 += 1
                self.player.tick(exc.retry_after_s * 1000)
        raise RuntimeError("read still rate-limited after 6 attempts")

    def observe(self) -> Optional[Obs]:
        self.m.gets += 1
        data = self._read(self.player.get_playback_state)
        if not data or not data.get("item"):
            return None
        item = data["item"]
        return Obs(
            track_id=item["id"],
            progress_ms=int(data.get("progress_ms") or 0),
            duration_ms=int(item.get("duration_ms") or 0),
            is_playing=bool(data.get("is_playing")),
        )

    def queue_ids(self) -> List[str]:
        # NOTE (AN-7): "no active device" and "empty queue" both map to [] —
        # declared simplification; scenario (h) shows what that costs.
        self.m.gets += 1
        data = self._read(self.player.get_queue)
        if not data:
            return []
        return [t["id"] for t in data.get("queue") or []]

    def _cmd(self, fn: Callable[[], None]) -> None:
        for _ in range(6):
            try:
                fn()
                return
            except SimRateLimited as exc:
                self.m.r429 += 1
                # Honest retry: Retry-After passes as real time — the music
                # (or the silence) keeps going while we wait.
                self.player.tick(exc.retry_after_s * 1000)
            except SimNoActiveDevice:
                # AN-7: report the state instead of crashing — the command is
                # lost, the next poll re-observes and reconciles.
                self.m.no_device_404 += 1
                self.m.notes.append("404 NO_ACTIVE_DEVICE: Command verloren")
                return
        raise RuntimeError("command still rate-limited after 6 attempts")

    def play(self, track_ids: List[str], *, position_ms: int = 0) -> None:
        self.m.plays += 1
        self._cmd(lambda: self.player.play(
            uris=[_uri(t) for t in track_ids], position_ms=position_ms,
        ))

    def play_context(self, context_uri: str, *, offset: int) -> None:
        self.m.plays += 1
        # Documented object form {"position": N}; out of range would ERROR
        # (no silent clamping) — an invalid cursor must fail loudly.
        self._cmd(lambda: self.player.play(
            context_uri=context_uri, offset={"position": offset},
        ))

    def enqueue(self, track_id: str) -> None:
        self.m.enqueues += 1
        self._cmd(lambda: self.player.add_to_queue(_uri(track_id)))

    def pause(self) -> None:
        self.m.pauses += 1
        self._cmd(self.player.pause)

    def materialize(self, context_uri: str, order: List[str]) -> None:
        """S4: create the run playlist once + write its items (counted)."""
        self.player.register_context(context_uri, order)
        self.m.playlist_cmds += 1 + math.ceil(len(order) / 100)


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

class Strategy:
    name = "?"

    def __init__(self, api: Api, order: List[str], cursor: int = 0) -> None:
        self.api = api
        self.order = order
        self.cursor = cursor
        self.prev: Optional[Obs] = None
        self.done = False
        self.stalled = False

    # -- lifecycle --------------------------------------------------------

    def start(self) -> None:
        raise NotImplementedError

    def resume(self) -> None:
        """Process restart: rebuild from the persisted cursor, then attach."""
        cur = self.api.observe()
        if cur is not None and cur.track_id == self.order[self.cursor]:
            self.prev = cur
            self.attached()
        else:
            self.start()

    def attached(self) -> None:
        pass

    # -- per poll ---------------------------------------------------------

    def poll(self) -> None:
        if self.done:
            return
        cur = self.api.observe()
        verdict = classify(self.prev, cur, self.order, self.cursor,
                           slack_ms=self.api.slack_ms)
        self.handle(verdict, cur)
        self.prev = cur

    def handle(self, verdict: str, cur: Optional[Obs]) -> None:
        raise NotImplementedError

    # -- helpers ----------------------------------------------------------

    @property
    def at_last(self) -> bool:
        return self.cursor >= len(self.order) - 1

    def _complete(self, *, pause: bool = False) -> None:
        if pause:
            self.api.pause()
        self.done = True

    def _jump_to(self, cur: Obs) -> None:
        self.cursor = self.order.index(cur.track_id)


class S0Additive(Strategy):
    """Status quo: blind additive prefetch on every advance (baseline)."""

    name = "S0-additiv"

    def start(self) -> None:
        self.api.play([self.order[self.cursor]])
        self._blind_prefetch()

    def _blind_prefetch(self) -> None:
        for tid in self.order[self.cursor + 1 : self.cursor + 1 + QUEUE_BUFFER]:
            self.api.enqueue(tid)

    def handle(self, verdict: str, cur: Optional[Obs]) -> None:
        if verdict == "advanced_natural":
            self.cursor += 1
            self._blind_prefetch()
        elif verdict == "advanced_skip":
            self.cursor += 1
            # Audible restart of the already-running card — counted like the
            # candidates count it (no flattery for the baseline).
            self.api.m.context_restarts += 1
            self.api.play([self.order[self.cursor]])
            self._blind_prefetch()
        elif verdict == "jumped_ahead" and cur is not None:
            self._jump_to(cur)
            self._blind_prefetch()
        elif verdict in ("replay_old", "restart_current", "reentered_expected"):
            if self.at_last:
                self._complete()
            else:
                # The real watcher classifies this as drift and stops driving:
                # duplicated queue material replays and the deck stalls.  The
                # replayed material IS audible — counted as a restart.
                self.api.m.context_restarts += 1
                self.api.m.notes.append(
                    f"S0 stalled at cursor {self.cursor}: queue duplicate "
                    f"replayed old material (drift)"
                )
                self.stalled = True
                self.done = True
        elif verdict == "idle_end" and self.at_last:
            self._complete()
        # on_expected / interlude / idle: nothing (matches today's watcher)


class S1Window(Strategy):
    """uris window: no command at natural ends inside the window."""

    def __init__(self, api: Api, order: List[str], cursor: int = 0,
                 window: int = QUEUE_BUFFER) -> None:
        super().__init__(api, order, cursor)
        self.window = window
        self.name = f"S1-fenster{window if window < len(order) else '-all'}"

    def _set_window(self) -> None:
        end = min(len(self.order), self.cursor + self.window)
        self.api.play(self.order[self.cursor : end])

    def start(self) -> None:
        self._set_window()

    def _boundary(self, *, restart: bool) -> None:
        """The window (or run) ended; the running card was consumed."""
        if restart:
            self.api.m.context_restarts += 1
        self.cursor += 1
        if self.cursor >= len(self.order):
            self.cursor = len(self.order) - 1
            self._complete(pause=restart)
            return
        self.api.m.post_end_commands += 1   # command after the audio already ended
        self._set_window()

    def handle(self, verdict: str, cur: Optional[Obs]) -> None:
        if verdict in ("advanced_natural", "advanced_skip"):
            self.cursor += 1          # inside the window — zero commands
        elif verdict == "jumped_ahead" and cur is not None:
            self._jump_to(cur)
        elif verdict in ("replay_old", "restart_current", "reentered_expected"):
            self._boundary(restart=True)
        elif verdict == "idle_end":
            self._boundary(restart=False)
        elif verdict == "idle" and self.prev is not None:
            # stop-policy: window exhausted after a skip or an interlude.
            self._boundary(restart=False)
        # on_expected / interlude: nothing


class S2NoPrefetch(Strategy):
    """One play per title change; nothing queued ahead."""

    name = "S2-kein-prefetch"

    def start(self) -> None:
        self.api.play([self.order[self.cursor]])

    def _next_card(self, *, restart: bool) -> None:
        if restart:
            self.api.m.context_restarts += 1
        self.cursor += 1
        if self.cursor >= len(self.order):
            self.cursor = len(self.order) - 1
            self._complete(pause=restart)
            return
        self.api.m.post_end_commands += 1   # every transition needs one
        self.api.play([self.order[self.cursor]])

    def handle(self, verdict: str, cur: Optional[Obs]) -> None:
        if verdict in ("restart_current", "replay_old", "reentered_expected"):
            self._next_card(restart=True)
        elif verdict == "jumped_ahead" and cur is not None:
            # Implementation-maturity fairness: every candidate handles the
            # jumped_ahead verdict; S2 was the only one missing the branch.
            self._jump_to(cur)
        elif verdict in ("idle_end", "idle"):
            if self.prev is not None:
                self._next_card(restart=False)
        elif verdict in ("advanced_natural", "advanced_skip"):
            self.cursor += 1          # defensive; cannot normally occur
        # on_expected / interlude: nothing


class S3OneSlot(Strategy):
    """Idempotent one-slot prefetch: read the queue, append only what's missing."""

    name = "S3-ein-slot"

    def start(self) -> None:
        self.api.play([self.order[self.cursor]])
        self._ensure_slot()

    def attached(self) -> None:
        self._ensure_slot()

    def _ensure_slot(self) -> None:
        if self.at_last:
            return
        nxt = self.order[self.cursor + 1]
        if nxt not in self.api.queue_ids():
            self.api.enqueue(nxt)

    def handle(self, verdict: str, cur: Optional[Obs]) -> None:
        if verdict in ("advanced_natural", "advanced_skip"):
            self.cursor += 1
            self._ensure_slot()       # read-before-write keeps this idempotent
        elif verdict == "jumped_ahead" and cur is not None:
            self._jump_to(cur)
            self._ensure_slot()
        elif verdict in ("restart_current", "replay_old", "reentered_expected"):
            self.api.m.context_restarts += 1
            if self.at_last:          # run end: the one-URI context wrapped
                self._complete(pause=True)
            else:                     # defensive recovery: assert next card
                self.cursor += 1
                self.api.m.post_end_commands += 1
                self.api.play([self.order[self.cursor]])
                self._ensure_slot()
        elif verdict in ("idle_end", "idle"):
            if self.at_last:
                self._complete()
            elif self.prev is not None:
                self.api.m.post_end_commands += 1
                self.api.play([self.order[self.cursor]])
                self._ensure_slot()
        # on_expected / interlude: nothing


class S4ContextPlaylist(Strategy):
    """Materialised run playlist, played via context_uri + offset."""

    name = "S4-kontext"
    CONTEXT_URI = "spotify:playlist:ts-run-sim"

    def __init__(self, api: Api, order: List[str], cursor: int = 0,
                 materialized: bool = False) -> None:
        super().__init__(api, order, cursor)
        if not materialized:
            self.api.materialize(self.CONTEXT_URI, order)

    def start(self) -> None:
        self.api.play_context(self.CONTEXT_URI, offset=self.cursor)

    def handle(self, verdict: str, cur: Optional[Obs]) -> None:
        if verdict in ("advanced_natural", "advanced_skip"):
            self.cursor += 1          # the context carries the order — no commands
        elif verdict == "jumped_ahead" and cur is not None:
            self._jump_to(cur)
        elif verdict in ("replay_old", "restart_current", "reentered_expected"):
            self.api.m.context_restarts += 1
            if self.at_last:
                self._complete(pause=True)   # replay policy wrapped the playlist
            else:
                self.api.m.post_end_commands += 1
                self.api.play_context(self.CONTEXT_URI, offset=self.cursor)
        elif verdict in ("idle_end", "idle"):
            if self.at_last:
                self._complete()
            elif self.prev is not None:
                self.api.m.post_end_commands += 1
                self.api.play_context(self.CONTEXT_URI, offset=self.cursor)
        # on_expected / interlude: nothing


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

def _true_silence_ms(player: SimulatedSpotifyPlayer, end_ms: int) -> int:
    """Ms-exact audible silence from the event log, up to ``end_ms``.

    Walks track_started / playback_stopped / paused events; time with no
    track playing counts as silence.  Because TRACK_MS is not poll-aligned,
    post-end commands produce real, non-zero silence here — the aliasing that
    hid it at 30 000 ms / 1 000 ms cannot occur.
    """
    silence = 0
    playing = False
    last_t = 0
    for ev in player.event_log:
        t = min(ev["t_ms"], end_ms)
        if t < last_t:
            continue
        kind = ev["event"]
        if kind == "track_started":
            if not playing:
                silence += t - last_t
            playing = True
            last_t = t
        elif kind in ("playback_stopped", "paused"):
            if playing:
                playing = False
                last_t = t
    if not playing and last_t < end_ms:
        silence += end_ms - last_t
    return silence


def _finalize(metrics: Metrics, strategy: Strategy,
              player: SimulatedSpotifyPlayer) -> None:
    metrics.completed = strategy.done and not strategy.stalled
    metrics.final_cursor = strategy.cursor
    metrics.true_silence_ms = _true_silence_ms(player, player.now_ms)
    # Core invariant, audio-stream level: every started playback of an
    # already-heard title is one uncontrolled repeat (up to strategy end).
    metrics.uncontrolled_repeats = (
        len(player.played_ids) - len(set(player.played_ids))
    )
    metrics.requests_total = (
        metrics.plays + metrics.enqueues + metrics.pauses
        + metrics.gets + metrics.playlist_cmds + metrics.r429
    )
    if metrics.completed:
        missed = [t for t in strategy.order if t not in player.played_ids]
        if missed:
            metrics.notes.append(f"nie gehört: {', '.join(missed)}")


def _max_ticks(n_tracks: int, poll_ms: int, *, extra_tracks: int = 0,
               slack: int = 300) -> int:
    return (n_tracks + extra_tracks) * TRACK_MS * 3 // poll_ms + slack


def _drive(player: SimulatedSpotifyPlayer, strategy: Strategy,
           max_ticks: int, *, poll_ms: int = POLL_MS, polls_per_tick: int = 1,
           until_cursor: Optional[int] = None) -> None:
    for _ in range(max_ticks):
        if strategy.done:
            return
        if until_cursor is not None and strategy.cursor >= until_cursor:
            return
        player.tick(poll_ms)
        for _ in range(polls_per_tick):
            strategy.poll()


StrategyFactory = Callable[..., Strategy]


def scenario_natural(make: StrategyFactory, player: SimulatedSpotifyPlayer,
                     api: Api, order: List[str], metrics: Metrics,
                     poll_ms: int) -> None:
    """(a) 20 tracks, every one plays to its natural end."""
    strategy = make(api, order)
    strategy.start()
    _drive(player, strategy, _max_ticks(len(order), poll_ms), poll_ms=poll_ms)
    _finalize(metrics, strategy, player)


def scenario_skips(make: StrategyFactory, player: SimulatedSpotifyPlayer,
                   api: Api, order: List[str], metrics: Metrics,
                   poll_ms: int) -> None:
    """(b) 10 native skips in a row, then the rest plays out."""
    strategy = make(api, order)
    strategy.start()
    player.tick(poll_ms)
    strategy.poll()
    for _ in range(10):
        if strategy.done:
            break
        player.tick(4_000)
        strategy.poll()
        player.user_next()            # the listener presses next in Spotify
        player.tick(poll_ms)
        strategy.poll()
    _drive(player, strategy, _max_ticks(len(order), poll_ms), poll_ms=poll_ms)
    _finalize(metrics, strategy, player)


def scenario_manual_queue(make: StrategyFactory, player: SimulatedSpotifyPlayer,
                          api: Api, order: List[str], metrics: Metrics,
                          poll_ms: int) -> None:
    """(c) UC-17/18: two manual NON-deck titles while title 3 is playing."""
    strategy = make(api, order)
    strategy.start()
    _drive(player, strategy, _max_ticks(len(order), poll_ms),
           poll_ms=poll_ms, until_cursor=2)
    player.user_add_to_queue("m1")
    player.user_add_to_queue("m2")
    _drive(player, strategy, _max_ticks(len(order), poll_ms, extra_tracks=4),
           poll_ms=poll_ms)
    _finalize(metrics, strategy, player)
    # Our process stopping (completion or stall) does not stop Spotify: let the
    # device keep playing so "displaced vs. merely delayed" is judged honestly.
    player.tick((len(order) + 6) * TRACK_MS)
    metrics.manual_played = sum(1 for t in player.played_ids if t in ("m1", "m2"))
    metrics.manual_displaced = 2 - metrics.manual_played
    for idx, tid in enumerate(player.played_ids):
        if tid in ("m1", "m2"):
            metrics.notes.append(f"{tid} spielte als {idx + 1}. Titel")


def scenario_double_tick(make: StrategyFactory, player: SimulatedSpotifyPlayer,
                         api: Api, order: List[str], metrics: Metrics,
                         poll_ms: int) -> None:
    """(d) every observation is delivered twice (duplicated watcher tick)."""
    strategy = make(api, order)
    strategy.start()
    _drive(player, strategy, _max_ticks(len(order), poll_ms),
           poll_ms=poll_ms, polls_per_tick=2)
    _finalize(metrics, strategy, player)


def scenario_restart(make: StrategyFactory, player: SimulatedSpotifyPlayer,
                     api: Api, order: List[str], metrics: Metrics,
                     poll_ms: int) -> None:
    """(e) process restart mid-run; rebuild from the persisted cursor."""
    strategy = make(api, order)
    strategy.start()
    _drive(player, strategy, _max_ticks(len(order), poll_ms),
           poll_ms=poll_ms, until_cursor=3)
    persisted_cursor = strategy.cursor          # what the DB would hold
    del strategy                                # the process dies ...
    player.tick(2 * poll_ms)                    # ... Spotify keeps playing
    revived = make(api, order, cursor=persisted_cursor, resumed=True)
    revived.resume()
    _drive(player, revived, _max_ticks(len(order), poll_ms), poll_ms=poll_ms)
    _finalize(metrics, revived, player)


def scenario_rate_limited(make: StrategyFactory, player: SimulatedSpotifyPlayer,
                          api: Api, order: List[str], metrics: Metrics,
                          poll_ms: int) -> None:
    """(f) every 5th request is answered 429 — reads included.

    With ``rate_limit_reads=True`` (set for every measurement) the polling
    reads share the quota window, so this scenario now exercises the request
    class that dominates live quota — not just the ~3 % of writes.
    """
    player.rate_limit_every = 5
    strategy = make(api, order)
    strategy.start()
    _drive(player, strategy, _max_ticks(len(order), poll_ms, slack=400),
           poll_ms=poll_ms)
    _finalize(metrics, strategy, player)


def scenario_deck_title_queued(make: StrategyFactory,
                               player: SimulatedSpotifyPlayer, api: Api,
                               order: List[str], metrics: Metrics,
                               poll_ms: int) -> None:
    """(g) the user manually queues a DECK title: t05 while t03 is playing.

    Handoff risk C-2 ("gleiche URI kann absichtlich oder manuell vorkommen").
    The user acts between two polls — faster than the controller: t02 ends
    between polls, t03 begins (per AN-2/AN-5 semantics), and t05 goes into
    the queue before the strategy has observed the transition.  The decisive
    column is ``uncontrolled_repeats``: does the same title get HEARD twice?
    (For S2 under 'stop' the moment falls into its structural silence window;
    that is inherent to S2, not a scenario unfairness.)
    """
    strategy = make(api, order)
    strategy.start()
    _drive(player, strategy, _max_ticks(len(order), poll_ms),
           poll_ms=poll_ms, until_cursor=2)
    player.tick(poll_ms)
    strategy.poll()                    # one settled observation of t02
    player.tick(TRACK_MS)              # t02 ends BETWEEN two polls
    player.user_add_to_queue("t05")    # the user is faster than the next poll
    _drive(player, strategy, _max_ticks(len(order), poll_ms, extra_tracks=4),
           poll_ms=poll_ms)
    _finalize(metrics, strategy, player)


def scenario_device_loss(make: StrategyFactory,
                         player: SimulatedSpotifyPlayer, api: Api,
                         order: List[str], metrics: Metrics,
                         poll_ms: int) -> None:
    """(h) no active device from title 5, for 3 polls, then back (AN-7).

    Reads answer 204/None, player commands 404 — ``Api._cmd`` must report the
    state instead of crashing.  ``device_loss_survived`` = the strategy kept
    running and finished the run; side effects (skipped deck titles, extra
    restarts) stay visible in the other columns and notes.
    """
    strategy = make(api, order)
    strategy.start()
    _drive(player, strategy, _max_ticks(len(order), poll_ms),
           poll_ms=poll_ms, until_cursor=4)
    player.has_active_device = False
    for _ in range(3):
        if strategy.done:
            break
        player.tick(poll_ms)
        strategy.poll()
    player.has_active_device = True
    _drive(player, strategy, _max_ticks(len(order), poll_ms), poll_ms=poll_ms)
    _finalize(metrics, strategy, player)
    metrics.device_loss_survived = metrics.completed


SCENARIOS: Dict[str, tuple[Callable, int, str]] = {
    "a-natuerlich-20": (scenario_natural, 20, "20 Tracks, alle natürlich zu Ende"),
    "b-10-native-skips": (scenario_skips, 12, "10 native Skips in Folge"),
    "c-manuelle-queue": (scenario_manual_queue, 8,
                         "2 manuelle Queue-Titel (nicht im Deck) bei Titel 3 (UC-17/18)"),
    "d-doppelter-tick": (scenario_double_tick, 6, "jedes Ereignis 2× beobachtet"),
    "e-prozessneustart": (scenario_restart, 8, "Neustart mitten im Run"),
    "f-429-jeder-5te": (scenario_rate_limited, 12,
                        "429 auf jedem 5. Request (Reads inklusive)"),
    "g-deck-titel-gequeued": (scenario_deck_title_queued, 8,
                              "Nutzer queued Deck-Titel t05, während t03 läuft"),
    "h-geraeteverlust": (scenario_device_loss, 12,
                         "kein aktives Gerät ab Titel 5 für 3 Polls (AN-7)"),
}


# ---------------------------------------------------------------------------
# Strategy registry
# ---------------------------------------------------------------------------

def _make_s0(api, order, cursor=0, resumed=False):
    s = S0Additive(api, order, cursor)
    if resumed:
        # Today's resume path is runs.start with force_override: play + re-append.
        # The play restarts the already-running card from 0:00 — audible, so it
        # is counted exactly like the candidates count their restarts.
        def _resume_with_restart():
            api.m.context_restarts += 1
            s.start()

        s.resume = _resume_with_restart
    return s


def _make_s1_5(api, order, cursor=0, resumed=False):
    return S1Window(api, order, cursor, window=5)


def _make_s1_all(api, order, cursor=0, resumed=False):
    return S1Window(api, order, cursor, window=len(order))


def _make_s2(api, order, cursor=0, resumed=False):
    return S2NoPrefetch(api, order, cursor)


def _make_s3(api, order, cursor=0, resumed=False):
    return S3OneSlot(api, order, cursor)


def _make_s4(api, order, cursor=0, resumed=False):
    return S4ContextPlaylist(api, order, cursor, materialized=resumed)


STRATEGIES: Dict[str, StrategyFactory] = {
    "S0-additiv": _make_s0,
    "S1-fenster5": _make_s1_5,
    "S1-fenster-all": _make_s1_all,
    "S2-kein-prefetch": _make_s2,
    "S3-ein-slot": _make_s3,
    "S4-kontext": _make_s4,
}

POLICIES = ("replay_context", "stop")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run_measurement(strategy_name: str, scenario_name: str, policy: str,
                    *, poll_ms: int = POLL_MS) -> Metrics:
    scenario_fn, total, _ = SCENARIOS[scenario_name]
    order = [f"t{i:02d}" for i in range(total)]
    player = SimulatedSpotifyPlayer(
        default_duration_ms=TRACK_MS, exhausted_context_policy=policy,
        # Reads share the quota window (BASE-05: rolling window for the API,
        # July 2026: quota per developer account) — polling must be countable.
        rate_limit_reads=True,
    )
    metrics = Metrics(strategy=strategy_name, scenario=scenario_name,
                      policy=policy, poll_ms=poll_ms)
    api = Api(player, metrics, poll_ms=poll_ms)
    scenario_fn(STRATEGIES[strategy_name], player, api, order, metrics, poll_ms)
    metrics.max_queue_dup = player.max_queue_dup_seen
    metrics.leftover_queue = len(player.queue_ids)
    return metrics


def run_all() -> List[Metrics]:
    results: List[Metrics] = []
    for scenario_name in SCENARIOS:
        for strategy_name in STRATEGIES:
            for policy in POLICIES:
                m = run_measurement(strategy_name, scenario_name, policy)
                # Same cell again at 250 ms — only the silence is reported
                # from it, so the poll dependency of "silence" is in the row.
                alt = run_measurement(strategy_name, scenario_name, policy,
                                      poll_ms=POLL_MS_ALT)
                m.true_silence_ms_poll250 = alt.true_silence_ms
                results.append(m)
    return results


# ---------------------------------------------------------------------------
# S1 window-size sensitivity (200 tracks): the boundary cost is a function of
# ceil(N/window) - 1; "0 post-end commands" for S1-fenster-all is the special
# case window == len(order), not a generic property.
# ---------------------------------------------------------------------------

WINDOW_SENSITIVITY_TRACKS = 200
WINDOW_SENSITIVITY_SCENARIO = "w-fenster-sensitivitaet-200"


def run_window_measurement(window: Optional[int], *,
                           poll_ms: int = POLL_MS,
                           policy: str = "replay_context") -> Metrics:
    total = WINDOW_SENSITIVITY_TRACKS
    order = [f"t{i:03d}" for i in range(total)]
    w = window if window is not None else total
    name = f"S1-fenster{'-all' if w >= total else w}"
    player = SimulatedSpotifyPlayer(
        default_duration_ms=TRACK_MS, exhausted_context_policy=policy,
        rate_limit_reads=True,
    )
    metrics = Metrics(strategy=name, scenario=WINDOW_SENSITIVITY_SCENARIO,
                      policy=policy, poll_ms=poll_ms)
    api = Api(player, metrics, poll_ms=poll_ms)
    strategy = S1Window(api, order, window=w)
    strategy.start()
    _drive(player, strategy, _max_ticks(total, poll_ms), poll_ms=poll_ms)
    _finalize(metrics, strategy, player)
    metrics.max_queue_dup = player.max_queue_dup_seen
    metrics.leftover_queue = len(player.queue_ids)
    return metrics


def run_window_sensitivity() -> List[Metrics]:
    rows: List[Metrics] = []
    for window in (5, 50, None):       # None → window == len(order) special case
        m = run_window_measurement(window)
        alt = run_window_measurement(window, poll_ms=POLL_MS_ALT)
        m.true_silence_ms_poll250 = alt.true_silence_ms
        rows.append(m)
    return rows


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

_HEADER = (
    "| Strategie | AN-2-Policy | play | enqueue | get | playlist | 429 | 404 | "
    "Requests gesamt | max. Queue-Dup | Rest-Queue | post_end_commands | "
    "Kontext-Restarts | uncontrolled_repeats | true_silence_ms (Poll 1000 / 250) | "
    "manuell gespielt/verdrängt | Geräteverlust überlebt | Cursor | fertig | Notizen |"
)
_SEP = "|" + "---|" * 20


def _row(m: Metrics) -> str:
    manual = (
        f"{m.manual_played}/{m.manual_displaced}"
        if m.scenario == "c-manuelle-queue" else "–"
    )
    silence = f"{m.true_silence_ms} / "
    silence += (
        str(m.true_silence_ms_poll250)
        if m.true_silence_ms_poll250 is not None else "–"
    )
    survived = (
        "–" if m.device_loss_survived is None
        else ("ja" if m.device_loss_survived else "NEIN")
    )
    notes = "; ".join(dict.fromkeys(m.notes)) or ""
    return (
        f"| {m.strategy} | {m.policy} | {m.plays} | {m.enqueues} | {m.gets} "
        f"| {m.playlist_cmds} | {m.r429} | {m.no_device_404} "
        f"| {m.requests_total} | {m.max_queue_dup} | {m.leftover_queue} "
        f"| {m.post_end_commands} | {m.context_restarts} "
        f"| {m.uncontrolled_repeats} | {silence} | {manual} | {survived} "
        f"| {m.final_cursor} | {'ja' if m.completed else 'NEIN'} | {notes} |"
    )


def to_markdown(results: List[Metrics],
                window_rows: Optional[List[Metrics]] = None) -> str:
    lines = [
        "# Phase 2 — Strategie-Messung gegen den Spotify-Simulator",
        "",
        "Evidenzklasse: **VERIFIED_AUTOMATED** (Simulator mit deklarierten "
        "Annahmen AN-1..AN-7, siehe `tests/sim_spotify.py`; Live-Gate BLOCKED).",
        "Harness: `tests/forensics/strategy_bench.py` · deterministisch · "
        f"Poll {POLL_MS} ms (Stille zusätzlich bei {POLL_MS_ALT} ms) · "
        f"Titellänge {TRACK_MS} ms (bewusst NICHT poll-aligned) · "
        f"Prefetch-Fenster {QUEUE_BUFFER} · Reads zählen gegen die Quota "
        "(`rate_limit_reads=True`).",
        "",
        "Jede Strategie läuft unter **beiden** AN-2-Policies "
        "(`replay_context` / `stop`) — Pflicht für S2, informativ für alle. "
        "`S0-additiv` ist der Status quo als Kontrast, kein Kandidat.",
        "",
        "Metriken: *post_end_commands* = Commands, die erst NACH einem "
        "Trackende nötig wurden — ein Command-Zähler (Proxy), KEINE "
        "Stille-Messung; *true_silence_ms* = ms-genaue hörbare Stille aus dem "
        "Event-Log bis zum Strategie-Ende, bei Poll 1000 ms und 250 ms; "
        "*uncontrolled_repeats* = derselbe Titel mehrfach GEHÖRT "
        "(Audio-Stream-Ebene, bis Strategie-Ende) — die Kerninvariante von "
        "True Shuffle; *Kontext-Restarts* = bereits gespieltes Material "
        "startete hörbar erneut; *max. Queue-Dup* = höchste gleichzeitige "
        "Anzahl desselben Titels in der Queue (0 = Queue nie benutzt, 1 = "
        "gesund); *Requests gesamt* = Reads + Writes + 429-Wiederholungen; "
        "*404* = Player-Commands ohne aktives Gerät (AN-7), gemeldet statt "
        "Crash; *manuell gespielt/verdrängt* bezieht sich auf die 2 "
        "Nutzer-Titel in Szenario (c); *Geräteverlust überlebt* nur in "
        "Szenario (h).",
        "",
    ]
    for scenario_name, (_, total, describe) in SCENARIOS.items():
        lines += [
            f"## Szenario {scenario_name} — {describe} ({total} Tracks)",
            "",
            _HEADER,
            _SEP,
        ]
        lines += [_row(m) for m in results if m.scenario == scenario_name]
        lines.append("")
    if window_rows:
        lines += [
            f"## S1-Fenstergrößen-Sensitivität — {WINDOW_SENSITIVITY_TRACKS} "
            "Tracks, natürlich zu Ende (policy replay_context)",
            "",
            "Boundary-Kosten = ceil(N/Fenster) − 1 Fenstergrenzen, jede eine "
            "post-end-Command-Stelle. `S1-fenster-all` hat 0 Grenzen NUR, "
            "weil Fenster == Playlist-Länge (Sonderfall); das dokumentierte "
            "Maximum des `uris`-Arrays ist offen — bei einem Live-Cap unter N "
            "fällt S1-all auf das Fensterverhalten zurück.",
            "",
            _HEADER,
            _SEP,
        ]
        lines += [_row(m) for m in window_rows]
        lines.append("")
    lines += [
        "## Lesehinweise",
        "",
        "- **Polling ist der dominante Kostenfaktor**: die Requests-gesamt-"
        "Spalte besteht zu >90 % aus 1-Hz-Reads, die bei allen Strategien "
        "praktisch identisch sind. Eine Quota-Argumentation über die "
        "429-Spalte allein wäre unehrlich — Reads zählen hier deshalb mit "
        "(BASE-05: rollierendes 30-s-Fenster; seit Juli 2026 Quota pro "
        "Developer-Account).",
        "- **true_silence_ms hängt primär am Poll-Intervall, nicht an der "
        "Strategie**: dieselbe Zelle bei Poll 250 ms zeigt je Übergang ~¼ der "
        "Stille. Die Titellänge 29 001 ms ist bewusst nicht poll-aligned; bei "
        "30 000 ms fiel jedes Trackende exakt auf eine Poll-Grenze und die "
        "Stille aliaste auf 0.",
        "- **uncontrolled_repeats zählt nur bis zum Strategie-Ende** (bei S0 "
        "bis zum Stall) — was das Gerät danach weiterspielt, steht in "
        "Rest-Queue/Notizen.",
        "- S1-fenster-all setzt das gesamte Restfenster als `uris`-Array; das "
        "dokumentierte Maximum der Body-Größe ist offen (live zu prüfen, "
        "10k-Playlists!) — siehe Fenster-Sensitivitätstabelle.",
        "- S4-`playlist`-Spalte zählt Playlist-Erstellung + Item-Writes; diese "
        "laufen außerhalb des Player-Rate-Limit-Pfads des Simulators.",
        "- Szenario (c)/(g): die Semantik »Queue vor Kontext« ist **AN-5** "
        "(angenommen, live LT-10 — nicht dokumentiert); ob ein "
        "`play`-Override die manuelle Queue erhält, ist AN-1 (live LT-7); "
        "dass identische URIs nicht dedupliziert werden, ist AN-6 (LT-11).",
        "- Szenario (g) ist die Kernprüfung der Produktinvariante: "
        "`uncontrolled_repeats` zeigt, welche Strategie einen manuell "
        "gequeueten Deck-Titel doppelt hörbar macht.",
        "- Szenario (h): 404-Verhalten ohne aktives Gerät ist **AN-7** "
        "(LT-12). »überlebt« heißt: kein Crash und Run beendet — "
        "übersprungene Deck-Titel stehen in den Notizen (»nie gehört«).",
        "- S2 unter `replay_context` zeigt das AN-2-Risiko am Trackende: der "
        "Ein-URI-Kontext startet hörbar neu, bevor der Override greift.",
    ]
    return "\n".join(lines) + "\n"


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out-dir", default=".",
        help="directory for phase2_strategy_measurements.{md,json}",
    )
    args = parser.parse_args(argv)

    results = run_all()
    window_rows = run_window_sensitivity()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    md_path = out_dir / "phase2_strategy_measurements.md"
    json_path = out_dir / "phase2_strategy_measurements.json"
    md_path.write_text(to_markdown(results, window_rows), encoding="utf-8")
    json_path.write_text(
        json.dumps(
            [m.as_dict() for m in results + window_rows],
            indent=2, ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"wrote {md_path}")
    print(f"wrote {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
