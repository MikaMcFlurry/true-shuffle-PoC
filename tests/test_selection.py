"""Example and edge-case tests for the pure selection engine (WP3-C).

Contract: docs/ts-fable-01/worknotes/WP3C_SELECTION_CONTRACT.md.  These are
deliberately example-based — the property tests for invariants P1-P8 are
written by an independent run and do NOT live here.

``_determinism_payload`` at module level is imported by the subprocess in the
cross-process determinism test (P3): the child re-imports this module and must
reproduce the parent's selections bit for bit.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Dict, List, Optional, Tuple

import pytest

from app.migrations import LEGACY_PRESET_RULES, legacy_rules_hash, legacy_rules_json
from core.selection import (
    PLAN_HORIZON,
    REQUEUE_AFTER_DRAWS,
    Candidate,
    HashPRNG,
    Rules,
    apply_skip,
    draw_seed,
    plan_cycle,
    preflight,
    select_next,
)
from core.shuffle import _first_n_similarity

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make(i: int, **kwargs) -> Candidate:
    """A candidate with a stable key naming convention."""
    return Candidate(run_track_id=i, track_key=f"spotify:t{i}", **kwargs)


def played(i: int, last_played_seq: int, **kwargs) -> Candidate:
    return make(i, state="played", play_count=1, last_played_seq=last_played_seq, **kwargs)


# ---------------------------------------------------------------------------
# Rules — from_json/to_json contract against the legacy preset
# ---------------------------------------------------------------------------

def test_default_rules_are_the_legacy_preset():
    """Rules() IS today's behaviour, frozen — byte-identical JSON and hash."""
    assert Rules().to_json() == legacy_rules_json()
    assert Rules().rules_hash() == legacy_rules_hash()
    assert Rules().to_dict() == LEGACY_PRESET_RULES


def test_from_json_roundtrips_the_legacy_preset():
    rules = Rules.from_json(legacy_rules_json())
    assert rules == Rules()
    assert rules.to_json() == legacy_rules_json()


def test_from_json_fills_missing_keys_with_defaults():
    rules = Rules.from_json('{"repeat_mode":"free_repeat","min_gap":3}')
    assert rules.repeat_mode == "free_repeat"
    assert rules.min_gap == 3
    assert rules.skip_policy == "consume"          # column default
    assert rules.favorite_weight == 1.0


def test_from_json_rejects_unknown_keys():
    with pytest.raises(ValueError, match="unbekannte Regel-Schlüssel"):
        Rules.from_json('{"repeat_mode":"no_repeat","surprise":1}')


def test_from_json_rejects_wrong_types():
    with pytest.raises(ValueError, match="min_gap"):
        Rules.from_json('{"min_gap":"3"}')
    with pytest.raises(ValueError, match="min_gap"):
        Rules.from_json('{"min_gap":true}')        # bool is not an int here
    with pytest.raises(ValueError, match="favorite_weight"):
        Rules.from_json('{"favorite_weight":"heavy"}')
    with pytest.raises(ValueError, match="repeat_mode"):
        Rules.from_json('{"repeat_mode":7}')
    with pytest.raises(ValueError, match="JSON-Objekt"):
        Rules.from_json('["no_repeat"]')


def test_validate_accepts_the_defaults():
    assert Rules().validate() == []


def test_validate_flags_domain_violations():
    conflicts = Rules(
        repeat_mode="sometimes",
        min_gap=-1,
        repeat_quota_pct=101,
        favorite_weight=0.5,
        skip_policy="explode",
    ).validate()
    fields = {c.field for c in conflicts}
    assert fields == {"repeat_mode", "min_gap", "repeat_quota_pct",
                      "favorite_weight", "skip_policy"}
    assert all(c.code == "invalid_value" for c in conflicts)


# ---------------------------------------------------------------------------
# Candidate — defensive construction
# ---------------------------------------------------------------------------

def test_candidate_rejects_unknown_state():
    with pytest.raises(ValueError, match="Kandidaten-Zustand"):
        make(1, state="excluded_user")


def test_candidate_played_requires_last_played_seq():
    with pytest.raises(ValueError, match="last_played_seq"):
        make(1, state="played", play_count=1)


def test_candidate_rejects_nonpositive_weight():
    with pytest.raises(ValueError, match="weight"):
        make(1, weight=0.0)


# ---------------------------------------------------------------------------
# draw_seed / HashPRNG — the P3 substrate
# ---------------------------------------------------------------------------

def test_draw_seed_is_pinned():
    """Golden values: any change to the seed derivation breaks recorded
    ``run_selections.seed`` reproducibility and must be a conscious act."""
    assert draw_seed(1234567890123, 1) == 9954791446043200346
    assert draw_seed(1234567890123, 2) == 2324825353298420350


def test_draw_seed_separates_seed_seq_and_label():
    assert draw_seed(1, 2) != draw_seed(2, 1)
    assert draw_seed(1, 1) != draw_seed(1, 2)
    assert draw_seed(1, 1) != draw_seed(1, 1, label="plan")
    assert 0 <= draw_seed(0, 0) < 2**64


def test_prng_is_deterministic_and_in_range():
    a = HashPRNG(99)
    b = HashPRNG(99)
    seq_a = [a.randint(0, 10) for _ in range(50)]
    seq_b = [b.randint(0, 10) for _ in range(50)]
    assert seq_a == seq_b
    assert all(0 <= x <= 10 for x in seq_a)
    assert HashPRNG(5).randint(7, 7) == 7
    assert 0.0 <= HashPRNG(5).random() < 1.0
    with pytest.raises(ValueError):
        HashPRNG(5).randint(3, 2)


# ---------------------------------------------------------------------------
# select_next — hard filters, relaxation, quota, exhaustion
# ---------------------------------------------------------------------------

def test_empty_candidates_are_exhausted():
    selection = select_next([], Rules(), seed=1, seq=1)
    assert selection.exhausted is True
    assert selection.run_track_id is None
    assert selection.candidate_count == 0
    assert selection.filtered_by == {}


def test_single_open_candidate_is_chosen():
    selection = select_next([make(7)], Rules(), seed=1, seq=1)
    assert selection.run_track_id == 7
    assert selection.exhausted is False
    assert selection.candidate_count == 1
    assert selection.filtered_by == {}
    assert selection.seed_used == draw_seed(1, 1)


def test_min_gap_zero_allows_an_immediate_repeat():
    """min_gap=0: distance 1 > 0 — the very next draw may repeat the card."""
    candidate = played(1, last_played_seq=4)
    rules = Rules(repeat_mode="free_repeat", min_gap=0)
    selection = select_next([candidate], rules, seed=1, seq=5)
    assert selection.run_track_id == 1
    assert selection.filtered_by == {}


def test_gap_check_is_strict_at_the_boundary():
    """distance == min_gap is a violation (P2: seq_new - seq_old > gap)."""
    at_gap = played(1, last_played_seq=7)       # distance 3 == min_gap -> blocked
    beyond = played(2, last_played_seq=6)       # distance 4 > min_gap  -> eligible
    rules = Rules(repeat_mode="free_repeat", min_gap=3)
    selection = select_next([at_gap, beyond], rules, seed=1, seq=10)
    assert selection.run_track_id == 2
    assert selection.filtered_by == {"gap": 1}


def test_gap_relaxation_at_the_boundary_eight_titles():
    """ADR-003 F6: 8 titles, gap 12 → relaxed to 7, documented in filtered_by.

    Steady rotation of 8 played cards (distances 1..8): none satisfies gap 12,
    so the gap drops to the maximum satisfiable k = 7 and the draw takes the
    card at maximum distance — never silently, always recorded.
    """
    seq = 100
    rotation = [played(i, last_played_seq=seq - i) for i in range(1, 9)]
    rules = Rules(repeat_mode="free_repeat", min_gap=12)
    selection = select_next(rotation, rules, seed=5, seq=seq)
    assert selection.run_track_id == 8          # distance 8, the only one > 7
    assert selection.filtered_by == {
        "gap": 7, "gap_relaxed_from": 12, "gap_relaxed_to": 7,
    }
    assert selection.exhausted is False


def test_relaxation_never_touches_the_quota():
    """The ladder relaxes min_gap ONLY (P2/P8): with the quota exhausted the
    ladder is not even attempted — the draw reports exhaustion instead of
    sneaking a repeat through.  The cards stay counted under ``gap`` (that is
    the filter they hit); no ``gap_relaxed_*`` keys appear."""
    rotation = [played(i, last_played_seq=50 - i) for i in range(1, 4)]
    rules = Rules(repeat_mode="limited_repeat", min_gap=45, repeat_quota_pct=10)
    selection = select_next(
        rotation, rules, seed=5, seq=50, recent_repeat_share=0.10
    )
    assert selection.exhausted is True
    assert selection.run_track_id is None
    assert selection.filtered_by == {"gap": 3}
    assert "gap_relaxed_to" not in selection.filtered_by
    assert "gap_relaxed_from" not in selection.filtered_by


def test_quota_boundary_is_strict():
    """P7: a repeat is admissible only while the share is strictly below the
    quota — at exactly quota_pct/100 one more repeat could break the ceiling."""
    candidate = played(1, last_played_seq=1)
    rules = Rules(repeat_mode="limited_repeat", min_gap=0, repeat_quota_pct=20)

    below = select_next([candidate], rules, seed=1, seq=10, recent_repeat_share=0.19)
    assert below.run_track_id == 1

    at_quota = select_next([candidate], rules, seed=1, seq=10, recent_repeat_share=0.20)
    assert at_quota.exhausted is True
    assert at_quota.filtered_by == {"quota_blocked": 1}


def test_quota_blocked_repeats_are_counted_next_to_an_open_pool():
    """With open cards present the blocked repeat is documented, not drawn."""
    pool = [make(1), played(2, last_played_seq=5)]
    rules = Rules(repeat_mode="limited_repeat", min_gap=0, repeat_quota_pct=10)
    selection = select_next(pool, rules, seed=3, seq=9, recent_repeat_share=0.5)
    assert selection.run_track_id == 1
    assert selection.filtered_by == {"quota_blocked": 1}


def test_free_repeat_ignores_the_quota():
    candidate = played(1, last_played_seq=1)
    rules = Rules(repeat_mode="free_repeat", min_gap=0, repeat_quota_pct=0)
    selection = select_next([candidate], rules, seed=1, seq=5, recent_repeat_share=1.0)
    assert selection.run_track_id == 1


def test_no_repeat_never_pools_played_cards():
    pool = [make(1), played(2, last_played_seq=1)]
    selection = select_next(pool, Rules(), seed=1, seq=5)
    assert selection.run_track_id == 1
    assert selection.filtered_by == {"played": 1}


def test_no_repeat_exhausts_when_nothing_is_open():
    """P8/contract: no_repeat + no open admitted title left ⇒ exhausted."""
    pool = [played(1, last_played_seq=1), played(2, last_played_seq=2)]
    selection = select_next(pool, Rules(), seed=1, seq=3)
    assert selection.exhausted is True
    assert selection.filtered_by == {"played": 2}


def test_deferred_cards_wait_behind_the_open_pool():
    """P6: while an open card exists, deferred cards are counted, not drawn."""
    pool = [make(1), make(2, state="deferred")]
    selection = select_next(pool, Rules(), seed=1, seq=1)
    assert selection.run_track_id == 1
    assert selection.filtered_by == {"deferred": 1}


def test_deferred_endgame_plays_the_deferred_card():
    """P6: once no open card remains, the deferred card is drawn — before
    any exhaustion and before any repeat."""
    pool = [played(1, last_played_seq=1), make(2, state="deferred")]
    selection = select_next(pool, Rules(), seed=1, seq=2)
    assert selection.run_track_id == 2
    assert selection.exhausted is False


def test_excluded_and_unadmitted_candidates_are_refused():
    """P5 defensively: the engine never silently drops a mis-filtered row."""
    with pytest.raises(ValueError, match="keine Kandidaten"):
        select_next([make(1, excluded=True)], Rules(), seed=1, seq=1)
    with pytest.raises(ValueError, match="keine Kandidaten"):
        select_next([make(1, admitted=False)], Rules(), seed=1, seq=1)
    with pytest.raises(ValueError, match="keine Kandidaten"):
        plan_cycle([make(1, excluded=True)], Rules(), seed=1)


def test_duplicate_run_track_ids_are_refused():
    with pytest.raises(ValueError, match="doppelt"):
        select_next([make(1), make(1)], Rules(), seed=1, seq=1)


def test_invalid_rules_are_refused():
    with pytest.raises(ValueError, match="ungültige Regeln"):
        select_next([make(1)], Rules(min_gap=-1), seed=1, seq=1)


def test_recent_repeat_share_must_be_a_share():
    with pytest.raises(ValueError, match="recent_repeat_share"):
        select_next([make(1)], Rules(), seed=1, seq=1, recent_repeat_share=1.5)


def test_selection_is_deterministic_and_order_independent():
    """P3: identical inputs — and even a permuted candidate list — produce
    the identical Selection."""
    pool = [make(i) for i in range(1, 20)]
    rules = Rules()
    first = select_next(pool, rules, seed=77, seq=4)
    second = select_next(pool, rules, seed=77, seq=4)
    reversed_input = select_next(list(reversed(pool)), rules, seed=77, seq=4)
    assert first == second == reversed_input
    assert first.seed_used == draw_seed(77, 4)


def test_different_seq_uses_a_different_draw_seed():
    pool = [make(i) for i in range(1, 10)]
    a = select_next(pool, Rules(), seed=77, seq=1)
    b = select_next(pool, Rules(), seed=77, seq=2)
    assert a.seed_used != b.seed_used


def test_an_extreme_favorite_weight_dominates_the_draw():
    """Deterministic P4 smoke (the statistical version is a property test):
    with favorite_weight=1e9 the favourite wins every one of ten draws."""
    pool = [make(i) for i in range(1, 5)] + [make(5, favorite=True)]
    rules = Rules(favorite_weight=1e9)
    winners = {select_next(pool, rules, seed=11, seq=seq).run_track_id
               for seq in range(1, 11)}
    assert winners == {5}


# ---------------------------------------------------------------------------
# apply_skip — all four policies (P6)
# ---------------------------------------------------------------------------

def test_consume_marks_the_card_played():
    outcome = apply_skip("open", "consume")
    assert outcome.new_state == "played"
    assert outcome.consumed is True
    assert outcome.requeue_after_draws is None
    assert outcome.requeue_at_cycle_end is False


def test_keep_open_keeps_the_card_in_the_pool():
    outcome = apply_skip("open", "keep_open")
    assert outcome.new_state == "open"
    assert outcome.consumed is False
    assert outcome.requeue_after_draws is None
    assert outcome.requeue_at_cycle_end is False


def test_requeue_later_defers_with_a_resubmission_instruction():
    outcome = apply_skip("open", "requeue_later")
    assert outcome.new_state == "deferred"
    assert outcome.consumed is False
    assert outcome.requeue_after_draws == REQUEUE_AFTER_DRAWS == 10
    assert outcome.requeue_at_cycle_end is False


def test_defer_to_end_defers_until_the_cycle_end():
    outcome = apply_skip("open", "defer_to_end")
    assert outcome.new_state == "deferred"
    assert outcome.consumed is False
    assert outcome.requeue_after_draws is None
    assert outcome.requeue_at_cycle_end is True


def test_apply_skip_rejects_unknown_inputs():
    with pytest.raises(ValueError, match="Skip-Policy"):
        apply_skip("open", "vanish")
    with pytest.raises(ValueError, match="Kandidaten-Zustand"):
        apply_skip("excluded_user", "consume")


def _drain(
    pool: Dict[int, Candidate],
    rules: Rules,
    seed: int,
    *,
    start_seq: int = 1,
    reopen_at: Optional[Tuple[int, int]] = None,
    max_draws: int = 100,
) -> List[Tuple[int, int]]:
    """Draw until exhaustion, marking every pick as played (the service-layer
    bookkeeping in miniature).  ``reopen_at=(seq, run_track_id)`` re-opens a
    deferred card before that draw — the requeue_later resubmission."""
    picks: List[Tuple[int, int]] = []
    for seq in range(start_seq, start_seq + max_draws):
        if reopen_at and seq == reopen_at[0]:
            card = pool[reopen_at[1]]
            pool[reopen_at[1]] = Candidate(
                run_track_id=card.run_track_id, track_key=card.track_key, state="open",
                play_count=card.play_count, last_played_seq=card.last_played_seq,
            )
        selection = select_next(list(pool.values()), rules, seed, seq)
        if selection.exhausted:
            break
        chosen = pool[selection.run_track_id]
        pool[selection.run_track_id] = Candidate(
            run_track_id=chosen.run_track_id, track_key=chosen.track_key,
            state="played", play_count=chosen.play_count + 1, last_played_seq=seq,
        )
        picks.append((seq, selection.run_track_id))
    return picks


def test_requeue_later_card_reappears_after_the_resubmission():
    """P6 flow: the skipped card is deferred, stays away while open cards
    play, and is drawn again once the caller re-opens it after 10 draws."""
    pool = {i: make(i) for i in range(1, 13)}
    rules = Rules()  # no_repeat

    first = select_next(list(pool.values()), rules, seed=3, seq=1)
    skipped_id = first.run_track_id
    outcome = apply_skip("open", "requeue_later")
    card = pool[skipped_id]
    pool[skipped_id] = Candidate(
        run_track_id=card.run_track_id, track_key=card.track_key,
        state=outcome.new_state,
    )
    assert outcome.consumed is False

    reopen_seq = 1 + outcome.requeue_after_draws + 1   # skip at 1, back for seq 12
    picks = _drain(pool, rules, seed=3, start_seq=2,
                   reopen_at=(reopen_seq, skipped_id))

    picked_ids = [track for _, track in picks]
    assert picked_ids.count(skipped_id) == 1                       # exactly once
    seq_of_return = next(s for s, t in picks if t == skipped_id)
    assert seq_of_return >= reopen_seq                             # never earlier
    assert sorted(picked_ids) == sorted(pool)                      # nothing lost


def test_defer_to_end_card_comes_last():
    """P6: the deferred card plays only after every open card is through."""
    pool = {1: make(1), 2: make(2), 3: make(3, state="deferred")}
    picks = _drain(pool, Rules(), seed=9)
    assert len(picks) == 3
    assert picks[-1][1] == 3                       # the deferred card is last
    assert sorted(track for _, track in picks) == [1, 2, 3]
    final = select_next(list(pool.values()), Rules(), seed=9, seq=5)
    assert final.exhausted is True                 # and then the cycle is done


# ---------------------------------------------------------------------------
# plan_cycle — permutation reuse and rolling horizon
# ---------------------------------------------------------------------------

def test_no_repeat_plan_is_a_complete_permutation():
    """P1: every admitted open title exactly once, reproducible per seed."""
    pool = [make(i) for i in range(1, 31)]
    plan_a = plan_cycle(pool, Rules(), seed=42)
    plan_b = plan_cycle(list(reversed(pool)), Rules(), seed=42)
    assert sorted(plan_a) == list(range(1, 31))
    assert plan_a == plan_b                         # P3: order-independent


def test_no_repeat_plan_avoids_the_previous_opening():
    """The similarity guard from core/shuffle is reused, not duplicated."""
    pool = [make(i) for i in range(1, 41)]
    previous = plan_cycle(pool, Rules(), seed=1)
    fresh = plan_cycle(pool, Rules(), seed=2, previous_order=previous)
    assert sorted(fresh) == sorted(previous)
    assert _first_n_similarity(fresh, previous, 10) <= 0.5


def test_no_repeat_plan_appends_deferred_after_the_open_block():
    pool = [make(1), make(2), make(3, state="deferred"), make(4, state="deferred")]
    plan = plan_cycle(pool, Rules(), seed=8)
    assert sorted(plan[:2]) == [1, 2]
    assert sorted(plan[2:]) == [3, 4]


def test_no_repeat_plan_skips_already_played_cards():
    """Mid-cycle replan: played cards are not planned again (P1)."""
    pool = [make(1), played(2, last_played_seq=1), make(3)]
    plan = plan_cycle(pool, Rules(), seed=8)
    assert sorted(plan) == [1, 3]


def test_plan_cycle_of_nothing_is_empty():
    assert plan_cycle([], Rules(), seed=1) == []
    assert plan_cycle([], Rules(repeat_mode="free_repeat"), seed=1) == []


def test_plan_cycle_of_a_single_card():
    assert plan_cycle([make(9)], Rules(), seed=1) == [9]
    assert plan_cycle([make(9)], Rules(repeat_mode="free_repeat"), seed=1) == [9]


def test_repeat_plan_has_the_rolling_horizon_length():
    """Contract: horizon = min(50, n)."""
    small = [make(i) for i in range(1, 6)]
    rules = Rules(repeat_mode="free_repeat", min_gap=0)
    assert len(plan_cycle(small, rules, seed=4)) == 5

    large = [make(i) for i in range(1, 61)]
    assert len(plan_cycle(large, rules, seed=4)) == PLAN_HORIZON == 50


def test_repeat_plan_respects_min_gap_inside_the_plan():
    """P2 in miniature: with min_gap=1 no card recurs within distance 1."""
    pool = [make(i) for i in range(1, 5)]
    rules = Rules(repeat_mode="free_repeat", min_gap=1)
    plan = plan_cycle(pool, rules, seed=6)
    assert len(plan) == 4
    last_seen: Dict[int, int] = {}
    for position, track in enumerate(plan, start=1):
        if track in last_seen:
            assert position - last_seen[track] > 1
        last_seen[track] = position


def test_limited_repeat_plan_obeys_the_quota():
    """P7 in miniature: quota 4 percent over a window of 100 caps the plan of
    50 draws at 4 repeats."""
    pool = [make(i) for i in range(1, 51)]
    rules = Rules(repeat_mode="limited_repeat", min_gap=0, repeat_quota_pct=4)
    plan = plan_cycle(pool, rules, seed=13)
    assert len(plan) == 50
    repeats = sum(1 for i, track in enumerate(plan) if track in plan[:i])
    assert repeats <= 4


# ---------------------------------------------------------------------------
# preflight — RUN-05 conflicts with corrections
# ---------------------------------------------------------------------------

def test_preflight_flags_the_empty_candidate_set():
    conflicts = preflight([], Rules())
    assert [c.code for c in conflicts] == ["empty_candidates"]


def test_preflight_flags_unsatisfiable_min_gap_with_a_correction():
    """ADR-003 F6: 'Bei 8 Titeln sind höchstens 7 Titel Abstand möglich.'"""
    pool = [make(i) for i in range(1, 9)]
    conflicts = preflight(pool, Rules(min_gap=12))
    assert len(conflicts) == 1
    conflict = conflicts[0]
    assert conflict.code == "min_gap_unsatisfiable"
    assert conflict.field == "min_gap"
    assert conflict.suggestion == 7
    assert "8 Titeln" in conflict.message and "7" in conflict.message


def test_preflight_accepts_min_gap_exactly_at_the_boundary():
    pool = [make(i) for i in range(1, 9)]
    assert preflight(pool, Rules(min_gap=7)) == []      # 7 < 8: satisfiable
    assert preflight(pool, Rules(min_gap=8)) != []      # 8 >= 8: conflict


def test_preflight_flags_quota_zero_with_limited_repeat():
    pool = [make(1), make(2)]
    rules = Rules(repeat_mode="limited_repeat", repeat_quota_pct=0)
    codes = [c.code for c in preflight(pool, rules)]
    assert codes == ["quota_zero_limited"]


def test_preflight_counts_only_admitted_candidates():
    """Excluded/unadmitted rows do not count towards admitted_count — this is
    the one function that accepts them (it predicts, it does not select)."""
    pool = [make(i) for i in range(1, 5)] + [
        make(5, excluded=True), make(6, admitted=False),
    ]
    conflicts = preflight(pool, Rules(min_gap=5))
    assert len(conflicts) == 1
    assert conflicts[0].suggestion == 3                 # 4 admitted -> max k=3


def test_preflight_includes_rule_domain_validation():
    conflicts = preflight([make(1)], Rules(repeat_mode="sometimes"))
    assert [c.code for c in conflicts] == ["invalid_value"]


def test_preflight_is_clean_for_a_sound_setup():
    pool = [make(i) for i in range(1, 9)]
    rules = Rules(repeat_mode="limited_repeat", min_gap=3, repeat_quota_pct=20)
    assert preflight(pool, rules) == []


# ---------------------------------------------------------------------------
# Determinism across a process boundary (P3)
# ---------------------------------------------------------------------------

def _determinism_payload() -> Dict[str, object]:
    """Fixed inputs → the full observable selection behaviour, JSON-safe.

    Imported by the subprocess below: parent and child must agree bit for bit.
    """
    rules = Rules(repeat_mode="limited_repeat", min_gap=2, repeat_quota_pct=30,
                  favorite_weight=3.0)
    pool = (
        [make(i) for i in range(1, 8)]
        + [make(8, favorite=True), make(9, weight=2.5)]
        + [played(10, last_played_seq=1), make(11, state="deferred")]
    )
    plan = plan_cycle(pool, rules, seed=1234567890123)
    no_repeat_plan = plan_cycle(
        [make(i) for i in range(1, 26)], Rules(), seed=1234567890123,
        previous_order=list(range(1, 26)),
    )
    selections = []
    for seq in range(1, 9):
        s = select_next(pool, rules, seed=1234567890123, seq=seq,
                        recent_repeat_share=0.1)
        selections.append([s.run_track_id, s.seq, s.seed_used, s.candidate_count,
                           dict(sorted(s.filtered_by.items())), s.exhausted])
    return {"plan": plan, "no_repeat_plan": no_repeat_plan, "selections": selections}


def test_selection_is_identical_across_process_boundaries():
    """P3, the hard version: two child processes with different (and
    randomising) PYTHONHASHSEED values reproduce the parent's selections
    exactly — proof that neither ``hash()`` nor interpreter state leaks in."""
    expected = _determinism_payload()
    command = (
        "import json; from tests.test_selection import _determinism_payload; "
        "print(json.dumps(_determinism_payload()))"
    )
    results = []
    for hash_seed in ("0", "424242"):
        env = {**os.environ, "PYTHONHASHSEED": hash_seed}
        proc = subprocess.run(
            [sys.executable, "-c", command],
            cwd=REPO_ROOT, env=env, capture_output=True, text=True, timeout=60,
        )
        assert proc.returncode == 0, proc.stderr
        results.append(json.loads(proc.stdout))
    assert results[0] == results[1] == json.loads(json.dumps(expected))
