"""SP-007 — the four strategy candidates, measured and pinned as tests.

Runs the minimal candidate implementations from
:mod:`tests.forensics.strategy_bench` against the honest simulator and pins
the properties the ADR comparison rests on.  Everything here is
VERIFIED_AUTOMATED under the declared assumptions AN-1..AN-4
(``tests/sim_spotify.py``); nothing is integrated into the app code — that
decision belongs to the lead (ADR).

The full measurement table is produced by

    python tests/forensics/strategy_bench.py --out-dir <dir>
"""

from __future__ import annotations

from functools import cache

import pytest

from tests.forensics.strategy_bench import Metrics, run_measurement

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
def measure(strategy: str, scenario: str, policy: str) -> Metrics:
    return run_measurement(strategy, scenario, policy)


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


def test_status_quo_duplicates_and_stalls_on_a_natural_run():
    """The baseline S0 shows the SP-008 mechanism in the same harness."""
    m = measure("S0-additiv", "a-natuerlich-20", "replay_context")
    assert m.max_queue_dup >= 5          # blind re-appends pile up
    assert not m.completed               # dup replays → drift → the deck stalls
    assert m.leftover_queue > 0          # stale material keeps playing


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


# ---------------------------------------------------------------------------
# (c) manual queue titles — UC-17/18
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


# ---------------------------------------------------------------------------
# (f) 429 on every 5th command — SP-005 flavour
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("strategy", CANDIDATES)
def test_rate_limiting_does_not_break_any_candidate(strategy):
    m = measure(strategy, "f-429-jeder-5te", "replay_context")
    assert m.completed
    assert m.final_cursor == 11


def test_command_hungry_candidates_actually_hit_the_limiter():
    assert measure("S2-kein-prefetch", "f-429-jeder-5te", "replay_context").r429 > 0
    assert measure("S3-ein-slot", "f-429-jeder-5te", "replay_context").r429 > 0


# ---------------------------------------------------------------------------
# Pinned cost profiles the ADR argues with (deterministic harness)
# ---------------------------------------------------------------------------

def test_s2_gap_and_an2_restart_risk_documented():
    """S2's structural weakness: a command after EVERY track end — and under
    AN-2 'replay_context' the one-URI context audibly restarts first."""
    replay = measure("S2-kein-prefetch", "a-natuerlich-20", "replay_context")
    assert replay.gaps == 19             # every transition is a potential gap
    assert replay.context_restarts == 20  # 19 transitions + run-end wrap

    stop = measure("S2-kein-prefetch", "a-natuerlich-20", "stop")
    assert stop.gaps == 19               # the gap risk stays even without replay
    assert stop.context_restarts == 0


def test_s1_window_boundary_cost_is_visible():
    m = measure("S1-fenster5", "a-natuerlich-20", "replay_context")
    assert m.plays == 4                  # start + 3 window boundaries
    assert m.gaps == 3                   # each boundary is a post-end command
    full = measure("S1-fenster-all", "a-natuerlich-20", "replay_context")
    assert full.plays == 1 and full.gaps == 0


def test_s4_command_economy():
    m = measure("S4-kontext", "a-natuerlich-20", "stop")
    assert m.plays == 1 and m.enqueues == 0
    assert m.playlist_cmds == 2          # create + one item-write batch
