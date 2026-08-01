"""SP-007 — the four strategy candidates, measured and pinned as tests.

Runs the minimal candidate implementations from
:mod:`tests.forensics.strategy_bench` against the honest simulator and pins
the properties the ADR comparison rests on.  Everything here is
VERIFIED_AUTOMATED under the declared assumptions AN-1..AN-7
(``tests/sim_spotify.py``); nothing is integrated into the app code — that
decision belongs to the lead (ADR).

Measurement-honesty pins (post-review) live here too:

* ``true_silence_ms`` is ms-exact and poll-dependent (poll 1000 vs 250);
  ``post_end_commands`` is only the command-count proxy.
* Reads count against the quota — polling dominates the request bill.
* Scenario (g) pins ``uncontrolled_repeats`` (same title HEARD twice — the
  core invariant) when the user queues a DECK title manually.
* Scenario (h) pins ``device_loss_survived`` under AN-7 (404 mid-run).
* The S1 "0 post-end commands" result is pinned as the window == len(order)
  special case, with the 200-track window sensitivity making boundary cost
  visible.

The full measurement table is produced by

    python tests/forensics/strategy_bench.py --out-dir <dir>
"""

from __future__ import annotations

from functools import cache

import pytest

from tests.forensics.strategy_bench import (
    Metrics,
    run_measurement,
    run_window_measurement,
)

pytestmark = pytest.mark.queue_forensics

CANDIDATES = [
    "S1-fenster5",
    "S1-fenster-all",
    "S2-kein-prefetch",
    "S3-ein-slot",
    "S4-kontext",
]
POLICIES = ["replay_context", "stop"]


@cache
def measure(strategy: str, scenario: str, policy: str,
            poll_ms: int = 1_000) -> Metrics:
    return run_measurement(strategy, scenario, policy, poll_ms=poll_ms)


# ---------------------------------------------------------------------------
# (a) 20 tracks, all natural — every candidate finishes without duplicates
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("policy", POLICIES)
@pytest.mark.parametrize("strategy", CANDIDATES)
def test_candidates_complete_a_natural_run_without_duplicates(strategy, policy):
    m = measure(strategy, "a-natuerlich-20", policy)
    assert m.completed, f"{strategy}/{policy} did not finish the run"
    assert m.final_cursor == 19
    assert m.max_queue_dup <= 1, f"{strategy} duplicated the queue"
    assert m.leftover_queue == 0, f"{strategy} left stale queue entries behind"


@pytest.mark.parametrize("strategy", CANDIDATES)
def test_candidates_natural_run_repeats_nothing_under_stop(strategy):
    """Audio-stream level: under AN-2 'stop' no candidate repeats a title."""
    m = measure(strategy, "a-natuerlich-20", "stop")
    assert m.uncontrolled_repeats == 0


def test_status_quo_duplicates_and_stalls_on_a_natural_run():
    """The baseline S0 shows the SP-008 mechanism in the same harness."""
    m = measure("S0-additiv", "a-natuerlich-20", "replay_context")
    assert m.max_queue_dup >= 5          # blind re-appends pile up
    assert not m.completed               # dup replays → drift → the deck stalls
    assert m.leftover_queue > 0          # stale material keeps playing
    # No flattery: the replayed duplicate IS audible and counted for S0 too.
    assert m.context_restarts >= 1
    assert m.uncontrolled_repeats >= 1


# ---------------------------------------------------------------------------
# (b) 10 native skips in a row — SP-003
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("strategy", CANDIDATES)
def test_ten_native_skips_consume_exactly_their_cards(strategy):
    m = measure(strategy, "b-10-native-skips", "replay_context")
    assert m.completed
    assert m.final_cursor == 11
    assert m.max_queue_dup <= 1


def test_skips_cost_no_commands_for_context_strategies():
    """S4 (and the full uris window) ride out skips without any command."""
    for strategy in ("S1-fenster-all", "S4-kontext"):
        m = measure(strategy, "b-10-native-skips", "stop")
        assert m.plays == 1, f"{strategy} needed extra plays for native skips"
        assert m.enqueues == 0


def test_status_quo_skip_restarts_are_counted():
    """S0's play-override after each skip audibly restarts the running card
    — since the fairness fix this is counted like the candidates count it."""
    m = measure("S0-additiv", "b-10-native-skips", "replay_context")
    assert m.context_restarts >= 5
    assert m.uncontrolled_repeats >= 5


# ---------------------------------------------------------------------------
# (c) manual NON-deck queue titles — UC-17/18
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("policy", POLICIES)
@pytest.mark.parametrize("strategy", CANDIDATES)
def test_manual_queue_titles_play_and_are_never_displaced(strategy, policy):
    m = measure(strategy, "c-manuelle-queue", policy)
    assert m.completed
    assert m.manual_played == 2, f"{strategy}/{policy}: manual titles lost"
    assert m.manual_displaced == 0


def test_status_quo_delays_manual_titles_behind_duplicates():
    """S0 does not displace the manual titles — it buries them (17th/18th)."""
    m = measure("S0-additiv", "c-manuelle-queue", "replay_context")
    assert m.manual_played == 2
    assert not m.completed
    delayed = [n for n in m.notes if "m1 spielte als" in n]
    assert delayed and "17." in delayed[0]


# ---------------------------------------------------------------------------
# (d) duplicated watcher tick — SP-004
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("strategy", CANDIDATES)
def test_double_delivery_is_idempotent(strategy):
    m = measure(strategy, "d-doppelter-tick", "replay_context")
    assert m.completed
    assert m.max_queue_dup <= 1


def test_double_delivery_appends_exactly_one_slot_per_transition():
    m = measure("S3-ein-slot", "d-doppelter-tick", "replay_context")
    assert m.enqueues == 5               # 6 tracks → 5 slots, despite 2× polls


# ---------------------------------------------------------------------------
# (e) process restart mid-run — SP-006
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("strategy", CANDIDATES)
def test_restart_resumes_from_persisted_cursor_without_duplicates(strategy):
    m = measure(strategy, "e-prozessneustart", "replay_context")
    assert m.completed
    assert m.final_cursor == 7
    assert m.max_queue_dup <= 1


def test_status_quo_restart_makes_the_queue_worse():
    m = measure("S0-additiv", "e-prozessneustart", "replay_context")
    assert m.max_queue_dup >= 6          # resume re-appends on top of the pile
    assert m.context_restarts >= 1       # the resume play audibly restarts cur


# ---------------------------------------------------------------------------
# (f) 429 on every 5th REQUEST — reads included (SP-005 flavour)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("strategy", CANDIDATES)
def test_rate_limiting_does_not_break_any_candidate(strategy):
    m = measure(strategy, "f-429-jeder-5te", "replay_context")
    assert m.completed
    assert m.final_cursor == 11


@pytest.mark.parametrize("strategy", CANDIDATES)
def test_read_inclusive_quota_hits_every_candidate(strategy):
    """With reads sharing the quota window (BASE-05), EVERY candidate gets
    429s — the write-frugal ones too, because 1-Hz polling dominates the
    request bill.  A quota argument built on write counts alone would be
    dishonest; the requests_total column carries the real load."""
    m = measure(strategy, "f-429-jeder-5te", "replay_context")
    assert m.r429 >= 50, f"{strategy}: polling did not hit the shared window?"
    assert m.gets > (m.plays + m.enqueues) * 5, "polling should dominate"


# ---------------------------------------------------------------------------
# (g) the user queues a DECK title manually — the core invariant
# ---------------------------------------------------------------------------

# Same title HEARD more than once, per strategy and AN-2 policy.  This is the
# product invariant ("true shuffle = every title exactly once") that the queue
# columns cannot see: all strategies keep max_queue_dup <= 1 here and still
# differ audibly.  Note S3's read-before-write does NOT protect it — the user
# slot lands before S3's prefetch, S3 jumps ahead and later replays stale
# queue entries: worst candidate on the core invariant under 'stop'.
G_EXPECTED_REPEATS = {
    ("S1-fenster5", "stop"): 0,
    ("S1-fenster-all", "stop"): 0,
    ("S2-kein-prefetch", "stop"): 0,     # but skips t04 entirely — see below
    ("S3-ein-slot", "stop"): 2,
    ("S4-kontext", "stop"): 1,
    ("S1-fenster5", "replay_context"): 1,
    ("S1-fenster-all", "replay_context"): 1,
    ("S2-kein-prefetch", "replay_context"): 6,
    ("S3-ein-slot", "replay_context"): 2,
    ("S4-kontext", "replay_context"): 2,
}


@pytest.mark.parametrize("policy", POLICIES)
@pytest.mark.parametrize("strategy", CANDIDATES)
def test_deck_title_queued_uncontrolled_repeats_pinned(strategy, policy):
    m = measure(strategy, "g-deck-titel-gequeued", policy)
    assert m.completed
    assert m.max_queue_dup <= 1          # the queue columns look CLEAN ...
    expected = G_EXPECTED_REPEATS[(strategy, policy)]
    assert m.uncontrolled_repeats == expected, (
        f"{strategy}/{policy}: heard-repeat count changed "
        f"({m.uncontrolled_repeats} != {expected})"
    )


def test_deck_title_queued_s3_is_not_protected_by_its_read():
    """S3's whole selling point (read-before-write) does not cover the risk
    the handoff names for it ('gleiche URI kann manuell vorkommen'): under
    both policies S3 makes the listener hear titles twice."""
    for policy in POLICIES:
        m = measure("S3-ein-slot", "g-deck-titel-gequeued", policy)
        assert m.uncontrolled_repeats == 2
    # ... while the window strategies ride it out silently under 'stop'.
    for strategy in ("S1-fenster5", "S1-fenster-all"):
        assert measure(strategy, "g-deck-titel-gequeued",
                       "stop").uncontrolled_repeats == 0


def test_deck_title_queued_s2_skips_a_deck_title():
    """S2's jumped_ahead handling (implementation-maturity fairness) trades
    the repeat for a coverage hole: t04 is never heard.  Both defects violate
    the invariant — the notes carry the honest picture."""
    m = measure("S2-kein-prefetch", "g-deck-titel-gequeued", "stop")
    assert m.uncontrolled_repeats == 0
    assert any("nie gehört" in n and "t04" in n for n in m.notes)


# ---------------------------------------------------------------------------
# (h) device loss mid-run — AN-7 (404 NO_ACTIVE_DEVICE)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("policy", POLICIES)
@pytest.mark.parametrize("strategy", CANDIDATES)
def test_device_loss_is_survived_by_every_candidate(strategy, policy):
    """A 3-poll device loss must never crash a strategy: Api reports the 404
    state (AN-7) and the run completes."""
    m = measure(strategy, "h-geraeteverlust", policy)
    assert m.device_loss_survived is True
    assert m.completed
    assert m.final_cursor == 11


def test_device_loss_costs_are_visible_not_hidden():
    """Surviving is not the same as clean: S3/S4 reconcile without skipping,
    while the window strategies (and S2 under replay) mis-read the loss as
    'card consumed' and skip deck title t05 — pinned so the ADR sees it."""
    s3 = measure("S3-ein-slot", "h-geraeteverlust", "stop")
    assert s3.no_device_404 == 2         # lost play + lost enqueue, reported
    assert not any("nie gehört" in n for n in s3.notes)

    s4 = measure("S4-kontext", "h-geraeteverlust", "stop")
    assert s4.no_device_404 == 1
    assert not any("nie gehört" in n for n in s4.notes)

    for strategy in ("S1-fenster5", "S1-fenster-all"):
        m = measure(strategy, "h-geraeteverlust", "stop")
        assert m.no_device_404 >= 1
        assert any("nie gehört" in n and "t05" in n for n in m.notes), (
            f"{strategy} should show its skipped deck title honestly"
        )


# ---------------------------------------------------------------------------
# Pinned cost profiles the ADR argues with (deterministic harness)
# ---------------------------------------------------------------------------

def test_s2_post_end_commands_and_an2_restart_risk_documented():
    """S2's structural weakness: a command after EVERY track end — and under
    AN-2 'replay_context' the one-URI context audibly restarts first."""
    replay = measure("S2-kein-prefetch", "a-natuerlich-20", "replay_context")
    assert replay.post_end_commands == 19  # every transition needs a command
    assert replay.context_restarts == 20   # 19 transitions + run-end wrap

    stop = measure("S2-kein-prefetch", "a-natuerlich-20", "stop")
    assert stop.post_end_commands == 19    # the risk stays even without replay
    assert stop.context_restarts == 0


def test_true_silence_is_measured_and_poll_dependent():
    """The honest silence metric: post_end_commands is only a proxy.  With the
    un-aliased track length (29 001 ms) S2's 19 post-end commands are ~1 s of
    real silence EACH at poll 1000 — and ~¼ of that at poll 250.  Silence is
    primarily a property of the poll interval, not of the strategy."""
    stop_1000 = measure("S2-kein-prefetch", "a-natuerlich-20", "stop")
    assert stop_1000.true_silence_ms == 19_980
    stop_250 = measure("S2-kein-prefetch", "a-natuerlich-20", "stop",
                       poll_ms=250)
    assert stop_250.true_silence_ms == 4_980

    # Under 'replay_context' there is no silence at all — the damage moves
    # into audible restarts instead (context_restarts / uncontrolled_repeats).
    replay = measure("S2-kein-prefetch", "a-natuerlich-20", "replay_context")
    assert replay.true_silence_ms == 0
    assert replay.uncontrolled_repeats == 20

    # The single-slot strategy pays one final poll of silence, not 19.
    s3 = measure("S3-ein-slot", "a-natuerlich-20", "stop")
    assert s3.true_silence_ms == 980


def test_polling_dominates_the_request_bill():
    """Quota honesty: >90 % of all requests are reads, for every candidate —
    the requests_total column exists so nobody argues quota from writes."""
    for strategy in CANDIDATES:
        m = measure(strategy, "a-natuerlich-20", "stop")
        assert m.requests_total > 0
        assert m.gets / m.requests_total > 0.9, f"{strategy}: reads must dominate"


def test_s1_window_boundary_cost_is_visible():
    """S1's boundary cost is ceil(N/window) - 1 post-end commands.

    IMPORTANT: `S1-fenster-all` showing 0 post-end commands is the SPECIAL
    CASE window == len(order) — one window, hence no boundary — not a generic
    property of S1.  The documented maximum of the `uris` array is open; any
    live cap below N turns S1-all into the windowed behaviour below.
    """
    m = measure("S1-fenster5", "a-natuerlich-20", "replay_context")
    assert m.plays == 4                  # start + 3 window boundaries
    assert m.post_end_commands == 3      # each boundary is a post-end command

    full = measure("S1-fenster-all", "a-natuerlich-20", "replay_context")
    assert full.plays == 1
    assert full.post_end_commands == 0   # window == len(order): no boundary


def test_s1_window_sensitivity_200_tracks():
    """200-track sensitivity run: the boundary cost scales with N/window."""
    w5 = run_window_measurement(5)
    assert (w5.plays, w5.post_end_commands) == (40, 39)
    w50 = run_window_measurement(50)
    assert (w50.plays, w50.post_end_commands) == (4, 3)
    full = run_window_measurement(None)  # window == len(order) special case
    assert (full.plays, full.post_end_commands) == (1, 0)
    for m in (w5, w50, full):
        assert m.completed and m.final_cursor == 199
        assert m.max_queue_dup <= 1


def test_s4_command_economy():
    m = measure("S4-kontext", "a-natuerlich-20", "stop")
    assert m.plays == 1 and m.enqueues == 0
    assert m.playlist_cmds == 2          # create + one item-write batch
