"""Strategy measurement harness — S1..S4 against the honest Spotify simulator.

Executable script (NOT pytest):

    python tests/forensics/strategy_bench.py --out-dir <dir>

Measures the four Phase-2 strategy candidates (plus the status quo as
baseline) against six scenarios and writes a Markdown table + JSON.  The
candidates are implemented here as MINIMAL execution functions against
:mod:`tests.sim_spotify` — deliberately NOT integrated into the app code; the
lead decides integration per ADR (SP-007).

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
(AN-1..AN-4, see tests/sim_spotify.py).  AN-2 is measured under BOTH policies
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
from typing import Callable, Dict, List, Optional

try:
    from tests.sim_spotify import SimRateLimited, SimulatedSpotifyPlayer
except ImportError:  # direct script execution from anywhere
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from tests.sim_spotify import SimRateLimited, SimulatedSpotifyPlayer

POLL_MS = 1_000
TRACK_MS = 30_000
QUEUE_BUFFER = 5           # mirrors settings.queue_buffer_size
NEAR_END_SLACK_MS = POLL_MS + 700
SKIP_PROGRESS_MS = 3_000   # mirrors core.engine.SKIP_PROGRESS_MS


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
    plays: int = 0
    enqueues: int = 0
    pauses: int = 0
    gets: int = 0              # playback-state reads + queue reads
    playlist_cmds: int = 0     # S4 only: create + item writes
    r429: int = 0              # commands answered 429 (each retried)
    gaps: int = 0              # deck transitions needing a command AFTER track end
    context_restarts: int = 0  # already-played material audibly restarted
    max_queue_dup: int = 0     # worst simultaneous occurrences of one track
    leftover_queue: int = 0    # queue entries left when the run finished/stalled
    manual_played: int = 0
    manual_displaced: int = 0
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


def _near_end(obs: Optional[Obs]) -> bool:
    return (
        obs is not None
        and obs.duration_ms > 0
        and obs.duration_ms - obs.progress_ms <= NEAR_END_SLACK_MS
    )


def classify(
    prev: Optional[Obs], cur: Optional[Obs], order: List[str], cursor: int
) -> str:
    """Interpret one polled snapshot against the deck — reconcile-lite."""
    expected = order[cursor]
    nxt = order[cursor + 1] if cursor + 1 < len(order) else None

    if cur is None:
        if prev is not None and prev.track_id == expected and _near_end(prev):
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
            and cur.progress_ms <= NEAR_END_SLACK_MS
        ):
            # After a manual interlude only S2's one-URI context can land back
            # on the consumed card — that is a replay, not progress.
            return "reentered_expected"
        return "on_expected"

    if nxt is not None and cur.track_id == nxt:
        if _near_end(prev) or cur.progress_ms > SKIP_PROGRESS_MS:
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
    def __init__(self, player: SimulatedSpotifyPlayer, metrics: Metrics) -> None:
        self.player = player
        self.m = metrics

    def observe(self) -> Optional[Obs]:
        self.m.gets += 1
        data = self.player.get_playback_state()
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
        self.m.gets += 1
        data = self.player.get_queue()
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
        raise RuntimeError("command still rate-limited after 6 attempts")

    def play(self, track_ids: List[str], *, position_ms: int = 0) -> None:
        self.m.plays += 1
        self._cmd(lambda: self.player.play(
            uris=[_uri(t) for t in track_ids], position_ms=position_ms,
        ))

    def play_context(self, context_uri: str, *, offset: int) -> None:
        self.m.plays += 1
        self._cmd(lambda: self.player.play(context_uri=context_uri, offset=offset))

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
        verdict = classify(self.prev, cur, self.order, self.cursor)
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
            self.api.play([self.order[self.cursor]])   # audible restart of cur
            self._blind_prefetch()
        elif verdict == "jumped_ahead" and cur is not None:
            self._jump_to(cur)
            self._blind_prefetch()
        elif verdict in ("replay_old", "restart_current", "reentered_expected"):
            if self.at_last:
                self._complete()
            else:
                # The real watcher classifies this as drift and stops driving:
                # duplicated queue material replays and the deck stalls.
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
        self.api.m.gaps += 1          # a command after the audio already ended
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
        self.api.m.gaps += 1          # every transition needs a post-end command
        self.api.play([self.order[self.cursor]])

    def handle(self, verdict: str, cur: Optional[Obs]) -> None:
        if verdict in ("restart_current", "replay_old", "reentered_expected"):
            self._next_card(restart=True)
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
                self.api.m.gaps += 1
                self.api.play([self.order[self.cursor]])
                self._ensure_slot()
        elif verdict in ("idle_end", "idle"):
            if self.at_last:
                self._complete()
            elif self.prev is not None:
                self.api.m.gaps += 1
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
                self.api.m.gaps += 1
                self.api.play_context(self.CONTEXT_URI, offset=self.cursor)
        elif verdict in ("idle_end", "idle"):
            if self.at_last:
                self._complete()
            elif self.prev is not None:
                self.api.m.gaps += 1
                self.api.play_context(self.CONTEXT_URI, offset=self.cursor)
        # on_expected / interlude: nothing


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

def _finalize(metrics: Metrics, strategy: Strategy) -> None:
    metrics.completed = strategy.done and not strategy.stalled
    metrics.final_cursor = strategy.cursor


def _drive(player: SimulatedSpotifyPlayer, strategy: Strategy,
           max_ticks: int, *, polls_per_tick: int = 1,
           until_cursor: Optional[int] = None) -> None:
    for _ in range(max_ticks):
        if strategy.done:
            return
        if until_cursor is not None and strategy.cursor >= until_cursor:
            return
        player.tick(POLL_MS)
        for _ in range(polls_per_tick):
            strategy.poll()


StrategyFactory = Callable[..., Strategy]


def scenario_natural(make: StrategyFactory, player: SimulatedSpotifyPlayer,
                     api: Api, order: List[str], metrics: Metrics) -> None:
    """(a) 20 tracks, every one plays to its natural end."""
    strategy = make(api, order)
    strategy.start()
    _drive(player, strategy, max_ticks=len(order) * 30 * 3 + 200)
    _finalize(metrics, strategy)


def scenario_skips(make: StrategyFactory, player: SimulatedSpotifyPlayer,
                   api: Api, order: List[str], metrics: Metrics) -> None:
    """(b) 10 native skips in a row, then the rest plays out."""
    strategy = make(api, order)
    strategy.start()
    player.tick(POLL_MS)
    strategy.poll()
    for _ in range(10):
        if strategy.done:
            break
        player.tick(4_000)
        strategy.poll()
        player.user_next()            # the listener presses next in Spotify
        player.tick(POLL_MS)
        strategy.poll()
    _drive(player, strategy, max_ticks=len(order) * 30 * 3 + 200)
    _finalize(metrics, strategy)


def scenario_manual_queue(make: StrategyFactory, player: SimulatedSpotifyPlayer,
                          api: Api, order: List[str], metrics: Metrics) -> None:
    """(c) UC-17/18: two manual queue titles while title 3 is playing."""
    strategy = make(api, order)
    strategy.start()
    _drive(player, strategy, max_ticks=len(order) * 30 * 3, until_cursor=2)
    player.user_add_to_queue("m1")
    player.user_add_to_queue("m2")
    _drive(player, strategy, max_ticks=(len(order) + 4) * 30 * 3 + 200)
    _finalize(metrics, strategy)
    # Our process stopping (completion or stall) does not stop Spotify: let the
    # device keep playing so "displaced vs. merely delayed" is judged honestly.
    player.tick((len(order) + 6) * TRACK_MS)
    metrics.manual_played = sum(1 for t in player.played_ids if t in ("m1", "m2"))
    metrics.manual_displaced = 2 - metrics.manual_played
    for idx, tid in enumerate(player.played_ids):
        if tid in ("m1", "m2"):
            metrics.notes.append(f"{tid} spielte als {idx + 1}. Titel")


def scenario_double_tick(make: StrategyFactory, player: SimulatedSpotifyPlayer,
                         api: Api, order: List[str], metrics: Metrics) -> None:
    """(d) every observation is delivered twice (duplicated watcher tick)."""
    strategy = make(api, order)
    strategy.start()
    _drive(player, strategy, max_ticks=len(order) * 30 * 3 + 200,
           polls_per_tick=2)
    _finalize(metrics, strategy)


def scenario_restart(make: StrategyFactory, player: SimulatedSpotifyPlayer,
                     api: Api, order: List[str], metrics: Metrics) -> None:
    """(e) process restart mid-run; rebuild from the persisted cursor."""
    strategy = make(api, order)
    strategy.start()
    _drive(player, strategy, max_ticks=len(order) * 30 * 3, until_cursor=3)
    persisted_cursor = strategy.cursor          # what the DB would hold
    del strategy                                # the process dies ...
    player.tick(2 * POLL_MS)                    # ... Spotify keeps playing
    revived = make(api, order, cursor=persisted_cursor, resumed=True)
    revived.resume()
    _drive(player, revived, max_ticks=len(order) * 30 * 3 + 200)
    _finalize(metrics, revived)


def scenario_rate_limited(make: StrategyFactory, player: SimulatedSpotifyPlayer,
                          api: Api, order: List[str], metrics: Metrics) -> None:
    """(f) every 5th command is answered 429 with Retry-After."""
    player.rate_limit_every = 5
    strategy = make(api, order)
    strategy.start()
    _drive(player, strategy, max_ticks=len(order) * 30 * 3 + 300)
    _finalize(metrics, strategy)


SCENARIOS: Dict[str, tuple[Callable, int, str]] = {
    "a-natuerlich-20": (scenario_natural, 20, "20 Tracks, alle natürlich zu Ende"),
    "b-10-native-skips": (scenario_skips, 12, "10 native Skips in Folge"),
    "c-manuelle-queue": (scenario_manual_queue, 8,
                         "2 manuelle Queue-Titel bei Titel 3 (UC-17/18)"),
    "d-doppelter-tick": (scenario_double_tick, 6, "jedes Ereignis 2× beobachtet"),
    "e-prozessneustart": (scenario_restart, 8, "Neustart mitten im Run"),
    "f-429-jeder-5te": (scenario_rate_limited, 12, "429 auf jedem 5. Command"),
}


# ---------------------------------------------------------------------------
# Strategy registry
# ---------------------------------------------------------------------------

def _make_s0(api, order, cursor=0, resumed=False):
    s = S0Additive(api, order, cursor)
    if resumed:
        # Today's resume path is runs.start with force_override: play + re-append.
        s.resume = s.start
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

def run_measurement(strategy_name: str, scenario_name: str, policy: str) -> Metrics:
    scenario_fn, total, _ = SCENARIOS[scenario_name]
    order = [f"t{i:02d}" for i in range(total)]
    player = SimulatedSpotifyPlayer(
        default_duration_ms=TRACK_MS, exhausted_context_policy=policy,
    )
    metrics = Metrics(strategy=strategy_name, scenario=scenario_name, policy=policy)
    api = Api(player, metrics)
    SCENARIOS[scenario_name][0](STRATEGIES[strategy_name], player, api, order, metrics)
    metrics.max_queue_dup = player.max_queue_dup_seen
    metrics.leftover_queue = len(player.queue_ids)
    return metrics


def run_all() -> List[Metrics]:
    results: List[Metrics] = []
    for scenario_name in SCENARIOS:
        for strategy_name in STRATEGIES:
            for policy in POLICIES:
                results.append(
                    run_measurement(strategy_name, scenario_name, policy)
                )
    return results


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

_HEADER = (
    "| Strategie | AN-2-Policy | play | enqueue | get | playlist | 429 | "
    "max. Queue-Dup | Rest-Queue | Lücken (Cmd nach Trackende) | "
    "Kontext-Restarts | manuell gespielt/verdrängt | Cursor | fertig | Notizen |"
)
_SEP = "|" + "---|" * 15


def _row(m: Metrics) -> str:
    manual = (
        f"{m.manual_played}/{m.manual_displaced}"
        if m.scenario == "c-manuelle-queue" else "–"
    )
    notes = "; ".join(dict.fromkeys(m.notes)) or ""
    return (
        f"| {m.strategy} | {m.policy} | {m.plays} | {m.enqueues} | {m.gets} "
        f"| {m.playlist_cmds} | {m.r429} | {m.max_queue_dup} | {m.leftover_queue} "
        f"| {m.gaps} | {m.context_restarts} | {manual} | {m.final_cursor} "
        f"| {'ja' if m.completed else 'NEIN'} | {notes} |"
    )


def to_markdown(results: List[Metrics]) -> str:
    lines = [
        "# Phase 2 — Strategie-Messung gegen den Spotify-Simulator",
        "",
        "Evidenzklasse: **VERIFIED_AUTOMATED** (Simulator mit deklarierten "
        "Annahmen AN-1..AN-4, siehe `tests/sim_spotify.py`; Live-Gate BLOCKED).",
        "Harness: `tests/forensics/strategy_bench.py` · deterministisch · "
        f"Poll {POLL_MS} ms · Titellänge {TRACK_MS // 1000} s · "
        f"Prefetch-Fenster {QUEUE_BUFFER}.",
        "",
        "Jede Strategie läuft unter **beiden** AN-2-Policies "
        "(`replay_context` / `stop`) — Pflicht für S2, informativ für alle. "
        "`S0-additiv` ist der Status quo als Kontrast, kein Kandidat.",
        "",
        "Metriken: *Lücken* = Commands, die erst NACH einem Trackende nötig "
        "wurden (potenziell hörbare Lücke); *Kontext-Restarts* = bereits "
        "gespieltes Material startete hörbar erneut; *max. Queue-Dup* = "
        "höchste gleichzeitige Anzahl desselben Titels in der Queue; "
        "*manuell gespielt/verdrängt* bezieht sich auf die 2 Nutzer-Titel in "
        "Szenario (c).",
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
    lines += [
        "## Lesehinweise",
        "",
        "- S1-fenster-all setzt das gesamte Restfenster als `uris`-Array; das "
        "dokumentierte Maximum der Body-Größe ist offen (live zu prüfen, "
        "10k-Playlists!).",
        "- S4-`playlist`-Spalte zählt Playlist-Erstellung + Item-Writes; diese "
        "laufen außerhalb des Player-Rate-Limit-Pfads des Simulators.",
        "- Szenario (c): die Simulator-Semantik »Queue vor Kontext« ist "
        "dokumentiert; ob ein `play`-Override die manuelle Queue erhält, ist "
        "AN-1 (live zu bestätigen).",
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
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    md_path = out_dir / "phase2_strategy_measurements.md"
    json_path = out_dir / "phase2_strategy_measurements.json"
    md_path.write_text(to_markdown(results), encoding="utf-8")
    json_path.write_text(
        json.dumps([m.as_dict() for m in results], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"wrote {md_path}")
    print(f"wrote {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
