"""Property tests for the pure selection engine — invariants P1-P8 (WP3-C).

Contract: ``docs/ts-fable-01/worknotes/WP3C_SELECTION_CONTRACT.md`` §Invarianten.
Written by an independent run; the author of ``core/selection.py`` did not
write these.  Example-based tests live in ``tests/test_selection.py`` and are
deliberately NOT duplicated here — this file generates candidate sets, rules
and seeds and tries to break the engine.

Variant: **hypothesis** (``requirements.txt``, Dev/Test section).  Every
generator-driven property carries an explicit ``max_examples`` so the suite
stays inside its runtime budget; the deep runs (n up to 500, thousands of
draws) are marked ``@pytest.mark.slow`` and deselected by default via the
``addopts`` in ``pyproject.toml``::

    python -m pytest tests/test_selection_properties.py -m slow -q

**Found violations are checked in, not fixed** (``core/`` is off limits for
this run): every one is a ``@pytest.mark.xfail(strict=True)`` test in the
last section, with a minimal deterministic repro.  ``strict=True`` means the
suite turns red the moment the engine is fixed — the xfails are regression
markers, not excuses.

Checked-in violations (all ``test_violation_*``, all with a minimal repro):

1. P7 — the quota gate ``share * 100.0 < quota`` is float-lenient at quota
   29 / 57 / 58, so a 100-draw window ends up with ``quota + 1`` repeats.
2. P2 — ``min_gap`` is only checked against ``state='played'``: a deferred or
   kept-open card carrying ``last_played_seq`` is replayed at distance 1 with
   an empty ``filtered_by`` (two separate repros).
3. P6 — the deferred endgame hands a ``requeue_later`` card back after 2
   draws although ``apply_skip`` promises ``>= 10``.
4. P2 — ``plan_cycle`` drops the per-draw ``filtered_by``, so a plan can
   contain a relaxed (gap-violating) repeat with no channel to report it.
5. §Funktionen 1 — ``plan_cycle`` simulates from ``seq=1`` while candidates
   carry absolute ``last_played_seq``; a mid-run replan silently drops every
   played candidate.
6. P8 — ``repeat_quota_pct=100`` with a fully repeated window reports
   exhaustion although 100 % <= 100 % is rule-conformant.
7. P4/P5 — ``weight=nan`` / ``inf`` pass ``Candidate`` validation and make the
   highest ``run_track_id`` win every draw.
8. P1 — ``duplicate_policy='collapse'`` is never enforced (nothing in the
   engine reads ``track_key``), so one cycle can play the same track twice.

Scope notes for the generic properties (each restriction is deliberate and
points at the xfail that covers the excluded region):

* ``clean`` candidate sets carry ``last_played_seq`` only on ``state='played'``
  cards.  ``open`` / ``deferred`` cards with a play history bypass the gap
  check — see ``test_violation_p2_*``.
* Quotas 29 / 57 / 58 are excluded from the generic P7/P8 strategies: at
  exactly those values the float gate is lenient — see
  ``test_violation_p7_quota_float_leniency`` and
  ``test_float_lenient_quota_set_is_exactly_the_known_three``, which pins the
  set so the exclusion cannot rot silently.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from dataclasses import dataclass, replace
from typing import Dict, List, Optional, Sequence, Tuple

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from core.selection import (
    DUPLICATE_POLICIES,
    PLAN_HORIZON,
    QUOTA_WINDOW,
    REPEAT_MODES,
    REQUEUE_AFTER_DRAWS,
    SKIP_POLICIES,
    Candidate,
    Rules,
    Selection,
    apply_skip,
    plan_cycle,
    preflight,
    select_next,
)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

settings.register_profile(
    "wp3c_properties",
    deadline=None,  # a 500-card drain is far slower than hypothesis' 200ms default
    suppress_health_check=[HealthCheck.too_slow],
)
settings.load_profile("wp3c_properties")

#: Quota percentages where ``share * 100.0 < quota`` is lenient in IEEE-754
#: doubles for ``share = quota / 100``.  Excluded from the generic strategies,
#: covered by their own xfail.  Pinned by
#: ``test_float_lenient_quota_set_is_exactly_the_known_three``.
FLOAT_LENIENT_QUOTAS = frozenset({29, 57, 58})

#: Weight ladder for the generated candidate sets — deliberately mixes 1.0
#: with the extreme values named as an attack point (1e9 next to 1.0).
WEIGHT_CHOICES = (1.0, 1.0, 1.0, 0.5, 2.5, 1e-6, 1e6, 1e9)

FAVORITE_WEIGHTS = (1.0, 1.5, 3.0, 10.0)


# ---------------------------------------------------------------------------
# Generators
# ---------------------------------------------------------------------------

def make(i: int, **kwargs) -> Candidate:
    return Candidate(run_track_id=i, track_key=f"spotify:t{i}", **kwargs)


def played(i: int, last_played_seq: int, **kwargs) -> Candidate:
    return make(i, state="played", play_count=1, last_played_seq=last_played_seq, **kwargs)


@st.composite
def candidate_sets(
    draw,
    *,
    min_size: int = 1,
    max_size: int = 40,
    states: Sequence[str] = ("open", "played", "deferred"),
    start_seq: int = 1,
) -> List[Candidate]:
    """A *clean* candidate set: only ``played`` cards carry last_played_seq.

    That is what a correct caller materialises from ``run_tracks`` at the
    start of a draw.  Ids are non-contiguous on purpose (run_track_id is a
    database id, not an index), weights span 1e-6 … 1e9, favourite flags and
    play counts are free.
    """
    ids = draw(st.lists(st.integers(1, 5000), min_size=min_size, max_size=max_size, unique=True))
    out: List[Candidate] = []
    for i in ids:
        state = draw(st.sampled_from(list(states)))
        weight = draw(st.sampled_from(WEIGHT_CHOICES))
        favorite = draw(st.booleans())
        if state == "played":
            # distance 0 (played at this very seq) is included on purpose: it
            # is the max_distance < 1 relaxation edge.
            low = max(0, start_seq - 25)
            out.append(make(
                i, state="played", play_count=draw(st.integers(1, 3)),
                last_played_seq=draw(st.integers(low, start_seq)),
                favorite=favorite, weight=weight,
            ))
        else:
            out.append(make(i, state=state, favorite=favorite, weight=weight))
    return out


@st.composite
def rules_sets(
    draw,
    *,
    modes: Sequence[str] = REPEAT_MODES,
    max_gap: int = 20,
    quota_exclude: frozenset = frozenset(),
) -> Rules:
    quotas = st.integers(0, 100)
    if quota_exclude:
        quotas = quotas.filter(lambda q: q not in quota_exclude)
    return Rules(
        repeat_mode=draw(st.sampled_from(list(modes))),
        min_gap=draw(st.integers(0, max_gap)),
        repeat_quota_pct=draw(quotas),
        favorite_weight=draw(st.sampled_from(FAVORITE_WEIGHTS)),
        # Neither policy is read by select_next/plan_cycle — generated anyway
        # so the properties would notice if that ever changed.
        skip_policy=draw(st.sampled_from(list(SKIP_POLICIES))),
        duplicate_policy=draw(st.sampled_from(list(DUPLICATE_POLICIES))),
    )


seeds = st.integers(min_value=0, max_value=2**63 - 1)


# ---------------------------------------------------------------------------
# The honest caller — the bookkeeping WP3-D has to do around the pure engine
# ---------------------------------------------------------------------------

@dataclass
class Draw:
    seq: int
    selection: Selection
    before: Optional[Candidate]     # the chosen card as it was BEFORE the draw
    was_repeat: bool                # it had been played before (history, not state)


class Run:
    """Drives :func:`select_next` the way the service layer would.

    Bookkeeping per draw: the chosen card becomes ``played`` with
    ``last_played_seq = seq`` and ``play_count + 1``; the repeat window keeps
    the last :data:`QUOTA_WINDOW` draws (1 = the card had a play history) and
    is reported as a share over the full window — exactly the convention
    :func:`core.selection.plan_cycle` uses itself.
    """

    def __init__(
        self,
        candidates: Sequence[Candidate],
        rules: Rules,
        seed: int,
        *,
        start_seq: int = 1,
    ) -> None:
        self.pool: Dict[int, Candidate] = {c.run_track_id: c for c in candidates}
        self.rules = rules
        self.seed = seed
        self.seq = start_seq
        self.window: List[int] = []
        self.draws: List[Draw] = []
        self.exhausted_at: Optional[int] = None

    @property
    def share(self) -> float:
        window = self.window[-QUOTA_WINDOW:]
        return sum(window) / float(QUOTA_WINDOW)

    @property
    def window_repeats(self) -> int:
        return sum(self.window[-QUOTA_WINDOW:])

    @property
    def picks(self) -> List[Draw]:
        return [d for d in self.draws if not d.selection.exhausted]

    @property
    def picked_ids(self) -> List[int]:
        return [d.selection.run_track_id for d in self.picks]

    def snapshot(self) -> List[Candidate]:
        return list(self.pool.values())

    def step(self, *, advance_on_exhaustion: bool = False) -> Draw:
        seq = self.seq
        selection = select_next(
            self.snapshot(), self.rules, self.seed, seq, recent_repeat_share=self.share
        )
        before = None if selection.run_track_id is None else self.pool[selection.run_track_id]
        was_repeat = before is not None and before.last_played_seq is not None
        drawn = Draw(seq=seq, selection=selection, before=before, was_repeat=was_repeat)
        self.draws.append(drawn)
        if selection.exhausted:
            if self.exhausted_at is None:
                self.exhausted_at = seq
            if advance_on_exhaustion:
                # The caller waited out one draw slot; the quota window keeps
                # sliding (an empty slot is a non-repeat, exactly as plan_cycle
                # treats its unfilled window).
                self.window.append(0)
                self.seq += 1
            return drawn
        assert before is not None
        self.window.append(1 if was_repeat else 0)
        self.pool[before.run_track_id] = replace(
            before, state="played", play_count=before.play_count + 1, last_played_seq=seq,
        )
        self.seq += 1
        return drawn

    def undo_last_draw(self) -> Draw:
        """The user skipped instead of listening: the draw happened (the cursor
        moved on), but no card was consumed — the caller now applies
        :func:`apply_skip` to the restored card."""
        drawn = self.draws.pop()
        if not drawn.selection.exhausted:
            assert drawn.before is not None
            self.window.pop()
            self.pool[drawn.before.run_track_id] = drawn.before
        return drawn

    def drain(self, max_draws: int, *, stop_on_exhaustion: bool = True) -> Run:
        """Draw ``max_draws`` times.

        ``stop_on_exhaustion=False`` models a long-horizon run that keeps
        asking: an exhausted draw costs a slot but nothing else, so the quota
        window slides on and repeats become admissible again — that is how a
        quota ceiling is stressed over hundreds of draws.
        """
        for _ in range(max_draws):
            drawn = self.step(advance_on_exhaustion=not stop_on_exhaustion)
            if drawn.selection.exhausted and stop_on_exhaustion:
                break
        return self


def effective_gap(selection: Selection, rules: Rules) -> int:
    """The gap the draw actually claims to enforce (relaxed value if documented)."""
    return int(selection.filtered_by.get("gap_relaxed_to", rules.min_gap))


# ---------------------------------------------------------------------------
# P1 — no-repeat exactness over a complete cycle (incl. the deferred endgame)
# ---------------------------------------------------------------------------

@given(
    candidates=candidate_sets(max_size=40),
    seed=seeds,
    gap=st.integers(0, 30),
)
@settings(max_examples=300)
def test_p1_no_repeat_cycle_selects_every_card_exactly_once(candidates, seed, gap):
    """P1: one complete cycle plays every open AND every deferred card once.

    The deferred endgame is part of the cycle (contract §select_next step 2),
    so a full drain must consume exactly ``open ∪ deferred`` — no card twice,
    none lost, and only then ``exhausted``.
    """
    rules = Rules(repeat_mode="no_repeat", min_gap=gap)
    run = Run(candidates, rules, seed).drain(len(candidates) + 5)

    expected = sorted(
        c.run_track_id for c in candidates if c.state in ("open", "deferred")
    )
    assert sorted(run.picked_ids) == expected
    assert len(run.picked_ids) == len(set(run.picked_ids)), "a card was played twice"
    assert run.exhausted_at is not None, "the cycle never reported exhaustion"
    assert run.exhausted_at == (len(expected) + 1)


@given(candidates=candidate_sets(max_size=40), seed=seeds)
@settings(max_examples=90)
def test_p1_deferred_cards_come_after_every_open_card(candidates, seed):
    """P1 × P6: deferred cards are the endgame, never interleaved."""
    run = Run(candidates, Rules(), seed).drain(len(candidates) + 5)
    open_ids = {c.run_track_id for c in candidates if c.state == "open"}
    deferred_ids = {c.run_track_id for c in candidates if c.state == "deferred"}
    positions = {track: i for i, track in enumerate(run.picked_ids)}
    if open_ids and deferred_ids:
        assert max(positions[t] for t in open_ids) < min(positions[t] for t in deferred_ids)


@given(candidates=candidate_sets(max_size=60), seed=seeds, previous=st.booleans())
@settings(max_examples=90)
def test_p1_plan_cycle_is_a_complete_permutation(candidates, seed, previous):
    """P1 for :func:`plan_cycle`: the plan is a permutation of open ∪ deferred."""
    expected = sorted(c.run_track_id for c in candidates if c.state in ("open", "deferred"))
    previous_order = (
        plan_cycle(candidates, Rules(), seed=seed + 1) if previous else None
    )
    plan = plan_cycle(candidates, Rules(), seed=seed, previous_order=previous_order)
    assert sorted(plan) == expected
    assert len(plan) == len(set(plan))
    open_ids = {c.run_track_id for c in candidates if c.state == "open"}
    assert set(plan[:len(open_ids)]) == open_ids     # deferred block last


@pytest.mark.slow
@given(
    n=st.integers(200, 500),
    seed=seeds,
    deferred_share=st.floats(0.0, 0.4),
)
@settings(max_examples=30)
def test_p1_deep_cycles_up_to_500_cards(n, seed, deferred_share):
    """P1 at contract scale (n up to 500, deep run — deselected by default)."""
    cut = int(n * deferred_share)
    candidates = [make(i, state="deferred" if i <= cut else "open") for i in range(1, n + 1)]
    run = Run(candidates, Rules(), seed).drain(n + 2)
    assert sorted(run.picked_ids) == list(range(1, n + 1))
    assert run.exhausted_at == n + 1
    open_ids = {c.run_track_id for c in candidates if c.state == "open"}
    assert set(run.picked_ids[:len(open_ids)]) == open_ids       # deferred endgame last


@pytest.mark.parametrize("seed", [1, 987654321, 2**62 + 7])
def test_p1_five_hundred_cards_stay_exact(seed):
    """The n=500 case in the default run — cheap, three fixed seeds."""
    candidates = [make(i) for i in range(1, 501)]
    run = Run(candidates, Rules(), seed).drain(505)
    assert sorted(run.picked_ids) == list(range(1, 501))
    assert plan_cycle(candidates, Rules(), seed=seed) != sorted(run.picked_ids)  # shuffled
    assert sorted(plan_cycle(candidates, Rules(), seed=seed)) == list(range(1, 501))


# ---------------------------------------------------------------------------
# P2 — min-gap hard, relaxation only documented
# ---------------------------------------------------------------------------

@given(
    candidates=candidate_sets(max_size=25, start_seq=20),
    rules=rules_sets(modes=("limited_repeat", "free_repeat"), max_gap=30),
    seed=seeds,
)
@settings(max_examples=400)
def test_p2_every_repeat_keeps_the_effective_gap(candidates, rules, seed):
    """P2: ``seq_new - seq_old > effective gap`` for every repeat, always.

    ``effective gap`` is ``min_gap`` unless the draw documents a relaxation in
    ``filtered_by`` — a relaxation the caller cannot see would be a silent
    rule break (contract P2: "Relaxation nur dokumentiert").
    """
    run = Run(candidates, rules, seed, start_seq=20).drain(min(4 * len(candidates) + 20, 120))
    for drawn in run.picks:
        before = drawn.before
        assert before is not None
        if before.last_played_seq is None:
            continue                                     # first play, not a repeat
        distance = drawn.seq - before.last_played_seq
        gap = effective_gap(drawn.selection, rules)
        assert distance > gap, (
            f"repeat of {before.run_track_id} at seq {drawn.seq} after "
            f"{distance} draws, effective gap {gap}, filtered_by="
            f"{drawn.selection.filtered_by}"
        )


@given(
    candidates=candidate_sets(max_size=25, states=("played",), start_seq=30),
    rules=rules_sets(modes=("limited_repeat", "free_repeat"), max_gap=40),
    seed=seeds,
)
@settings(max_examples=300)
def test_p2_relaxation_is_documented_consistently(candidates, rules, seed):
    """filtered_by consistency for the F6 ladder (attack point: relaxation edges).

    Whenever ``gap_relaxed_*`` appears:

    * ``gap_relaxed_from`` is the configured ``min_gap``,
    * ``gap_relaxed_to`` is strictly smaller (a relaxation must relax),
    * no candidate satisfied the configured gap (the ladder is a last resort),
    * ``gap_relaxed_to`` is the *maximum satisfiable* k (contract: "senke gap
      auf max erfüllbares k"), i.e. one below the largest available distance,
    * the card actually drawn keeps that relaxed gap.
    """
    run = Run(candidates, rules, seed, start_seq=30).drain(40)
    for drawn in run.picks:
        filtered = drawn.selection.filtered_by
        if "gap_relaxed_to" not in filtered:
            assert "gap_relaxed_from" not in filtered
            continue
        pool_before = drawn.before
        assert pool_before is not None
        assert filtered["gap_relaxed_from"] == rules.min_gap
        assert filtered["gap_relaxed_to"] < rules.min_gap
        assert filtered["gap_relaxed_to"] >= 0
        # Re-derive the state the engine saw: every card as of this draw.
        history = {d.selection.run_track_id: d.seq for d in run.picks if d.seq < drawn.seq}
        distances = []
        for c in candidates:
            last = history.get(c.run_track_id, c.last_played_seq)
            if last is not None:
                distances.append(drawn.seq - last)
        assert distances
        assert max(distances) <= rules.min_gap, "ladder fired although a card fit the gap"
        assert filtered["gap_relaxed_to"] == max(distances) - 1, "not the maximum k"
        chosen_distance = drawn.seq - int(pool_before.last_played_seq)
        assert chosen_distance > filtered["gap_relaxed_to"]
        assert chosen_distance == max(distances)


@given(
    candidates=candidate_sets(max_size=20, states=("played",), start_seq=15),
    seed=seeds,
    gap=st.integers(0, 25),
)
@settings(max_examples=90)
def test_p2_relaxation_never_undercuts_a_documented_gap_in_free_repeat(candidates, seed, gap):
    """Even with the ladder firing every draw, the documented gap is kept."""
    rules = Rules(repeat_mode="free_repeat", min_gap=gap)
    run = Run(candidates, rules, seed, start_seq=15).drain(60)
    for drawn in run.picks:
        before = drawn.before
        assert before is not None and before.last_played_seq is not None
        assert drawn.seq - before.last_played_seq > effective_gap(drawn.selection, rules)


# ---------------------------------------------------------------------------
# P3 — determinism (in-process and across a process boundary)
# ---------------------------------------------------------------------------

@given(
    candidates=candidate_sets(max_size=40, start_seq=10),
    rules=rules_sets(),
    seed=seeds,
    seq=st.integers(1, 5000),
    share=st.floats(0.0, 1.0),
)
@settings(max_examples=200)
def test_p3_select_next_is_deterministic_and_order_independent(
    candidates, rules, seed, seq, share
):
    """P3: same input ⇒ same Selection, regardless of the caller's ordering."""
    first = select_next(candidates, rules, seed, seq, recent_repeat_share=share)
    again = select_next(candidates, rules, seed, seq, recent_repeat_share=share)
    reversed_input = select_next(
        list(reversed(candidates)), rules, seed, seq, recent_repeat_share=share
    )
    rotated = list(candidates[len(candidates) // 2:]) + list(candidates[:len(candidates) // 2])
    rotated_result = select_next(rotated, rules, seed, seq, recent_repeat_share=share)
    assert first == again == reversed_input == rotated_result


@given(candidates=candidate_sets(max_size=40), rules=rules_sets(), seed=seeds)
@settings(max_examples=60)
def test_p3_plan_cycle_is_deterministic_and_order_independent(candidates, rules, seed):
    plan = plan_cycle(candidates, rules, seed)
    assert plan == plan_cycle(candidates, rules, seed)
    assert plan == plan_cycle(list(reversed(candidates)), rules, seed)


def _spec_to_candidates(spec: Dict[str, object]) -> List[Candidate]:
    return [
        Candidate(
            run_track_id=row[0], track_key=f"spotify:t{row[0]}", state=row[1],
            play_count=row[2], last_played_seq=row[3], favorite=row[4], weight=row[5],
        )
        for row in spec["candidates"]  # type: ignore[index]
    ]


def _p3_payload(spec: Dict[str, object]) -> Dict[str, object]:
    """Full observable behaviour for one spec — JSON-safe, for the subprocess.

    Imported by the child process below: parent and child must agree bit for
    bit, whatever ``PYTHONHASHSEED`` is (P3: no ``hash()``, no process state).
    """
    candidates = _spec_to_candidates(spec)
    rules = Rules(**spec["rules"])  # type: ignore[arg-type]
    seed = int(spec["seed"])  # type: ignore[arg-type]
    selections = []
    for seq in range(1, 13):
        selection = select_next(
            candidates, rules, seed, seq, recent_repeat_share=(seq % 7) / 10.0
        )
        selections.append([
            selection.run_track_id, selection.seq, selection.seed_used,
            selection.candidate_count, sorted(selection.filtered_by.items()),
            selection.exhausted,
        ])
    return {
        "plan": plan_cycle(candidates, rules, seed),
        "selections": selections,
    }


#: Three samples covering all three repeat modes, mixed states, extreme
#: weights and favourites — deterministic, no generator involved.
P3_SPECS: Tuple[Dict[str, object], ...] = (
    {
        "candidates": [
            [3, "open", 0, None, False, 1.0], [11, "open", 0, None, True, 1e9],
            [42, "played", 2, 4, False, 2.5], [7, "deferred", 0, None, False, 1e-6],
            [99, "open", 1, None, True, 1.0],
        ],
        "rules": {"repeat_mode": "no_repeat", "min_gap": 3, "favorite_weight": 3.0},
        "seed": 1234567890123,
    },
    {
        "candidates": [
            [1, "played", 5, 2, True, 1.0], [2, "played", 1, 9, False, 4.0],
            [5, "open", 0, None, False, 1.0], [8, "played", 3, 1, True, 0.25],
        ],
        "rules": {
            "repeat_mode": "limited_repeat", "min_gap": 2, "repeat_quota_pct": 40,
            "favorite_weight": 2.0, "skip_policy": "requeue_later",
        },
        "seed": 2**61 + 17,
    },
    {
        "candidates": [
            [10, "played", 9, 3, False, 1e6], [20, "played", 9, 6, True, 1.0],
            [30, "deferred", 0, None, False, 1.0],
        ],
        "rules": {
            "repeat_mode": "free_repeat", "min_gap": 1, "repeat_quota_pct": 0,
            "favorite_weight": 10.0, "duplicate_policy": "keep_entries",
        },
        "seed": 0,
    },
)


def test_p3_determinism_survives_the_process_boundary():
    """P3, the hard version: three samples reproduced by two child processes
    with different (and randomising) ``PYTHONHASHSEED`` values."""
    expected = json.loads(json.dumps([_p3_payload(spec) for spec in P3_SPECS]))
    command = (
        "import json, sys; "
        "from tests.test_selection_properties import _p3_payload; "
        "print(json.dumps([_p3_payload(s) for s in json.load(sys.stdin)]))"
    )
    results = []
    for hash_seed in ("0", "987654"):
        proc = subprocess.run(
            [sys.executable, "-c", command],
            cwd=REPO_ROOT, env={**os.environ, "PYTHONHASHSEED": hash_seed},
            input=json.dumps(list(P3_SPECS)),
            capture_output=True, text=True, timeout=120, check=False,
        )
        assert proc.returncode == 0, proc.stderr
        results.append(json.loads(proc.stdout))
    assert results[0] == results[1] == expected


# ---------------------------------------------------------------------------
# P4 — favourite weighting, statistically, while P2 stays hard
# ---------------------------------------------------------------------------

#: Fixed seed set: the statistics are deterministic, never flaky.
P4_SEEDS = (11, 4242, 777001, 2026)


@pytest.mark.parametrize("seed", P4_SEEDS)
def test_p4_favorites_win_significantly_more_often_while_p2_holds(seed):
    """P4: with ``favorite_weight=3.0`` favourites are drawn far above chance —
    measured over 2400 draws with ``min_gap=2`` enforced on every single draw.

    The test statistic is the 1-df chi-square of the favourite/non-favourite
    split against the uniform null; 10.83 is the p<0.001 critical value.  The
    upper bound guards the other direction: the weighting must not exceed the
    unconstrained ideal share (that would mean the gap rule is being ignored).
    """
    n, n_fav, draws = 12, 3, 2400
    candidates = [make(i, favorite=(i <= n_fav)) for i in range(1, n + 1)]
    rules = Rules(repeat_mode="free_repeat", min_gap=2, favorite_weight=3.0)
    run = Run(candidates, rules, seed).drain(draws)
    assert len(run.picks) == draws, "the run must not exhaust — P4 needs the full sample"

    for drawn in run.picks:                              # P2 hardness, same run
        before = drawn.before
        assert before is not None
        if before.last_played_seq is not None:
            assert drawn.seq - before.last_played_seq > effective_gap(drawn.selection, rules)

    favorites = {c.run_track_id for c in candidates if c.favorite}
    observed = sum(1 for t in run.picked_ids if t in favorites)
    expected = draws * n_fav / n                          # uniform null
    chi2 = (observed - expected) ** 2 / expected + (
        (draws - observed) - (draws - expected)) ** 2 / (draws - expected)
    assert observed > expected
    assert chi2 > 10.83, f"favourite share {observed / draws:.3f} not significant (chi2={chi2:.1f})"

    ideal = (n_fav * 3.0) / (n_fav * 3.0 + (n - n_fav))   # unconstrained weighted share
    assert observed / draws <= ideal + 0.05, "share above the ideal — gap rule bypassed?"
    assert observed / draws >= 0.33, "weighting barely visible"


@pytest.mark.parametrize("seed", P4_SEEDS)
def test_p4_weight_and_favorite_weight_compose(seed):
    """``weight × favorite_weight`` is the drawing probability, exactly.

    With ``min_gap=0`` and ``free_repeat`` every draw sees the full pool, so
    the draws are i.i.d. and each card's count must sit inside a 4σ binomial
    band around ``draws × w_i / Σw`` — a heavy non-favourite (4.0) against a
    light favourite (1.0 × 3.0) against a plain card (1.0).
    """
    candidates = [
        make(1, weight=4.0), make(2, weight=1.0, favorite=True), make(3, weight=1.0),
    ]
    rules = Rules(repeat_mode="free_repeat", min_gap=0, favorite_weight=3.0)
    draws = 1500
    run = Run(candidates, rules, seed).drain(draws)
    counts = {i: run.picked_ids.count(i) for i in (1, 2, 3)}
    assert all(counts[i] > 0 for i in (1, 2, 3)), f"a card was never reachable: {counts}"
    assert counts[1] > counts[2] > counts[3]

    effective = {1: 4.0, 2: 3.0, 3: 1.0}                  # 1.0 × favorite_weight for #2
    total = sum(effective.values())
    for track, weight in effective.items():
        p = weight / total
        expected = draws * p
        sigma = math.sqrt(draws * p * (1 - p))
        assert abs(counts[track] - expected) <= 4 * sigma, (
            f"card {track}: {counts[track]} draws, expected {expected:.1f} ± {4 * sigma:.1f}"
        )


# ---------------------------------------------------------------------------
# P5 — exclusions are absolute
# ---------------------------------------------------------------------------

@given(
    candidates=candidate_sets(max_size=30),
    rules=rules_sets(quota_exclude=FLOAT_LENIENT_QUOTAS),
    seed=seeds,
    flags=st.lists(st.sampled_from(["excluded", "unadmitted"]), min_size=1, max_size=6),
)
@settings(max_examples=100)
def test_p5_excluded_and_unadmitted_never_appear(candidates, rules, seed, flags):
    """P5: the engine refuses a mis-filtered set, and correctly filtered runs
    never surface an excluded id."""
    base_id = max(c.run_track_id for c in candidates) + 1
    forbidden = []
    for offset, flag in enumerate(flags):
        forbidden.append(make(
            base_id + offset,
            excluded=(flag == "excluded"),
            admitted=(flag != "unadmitted"),
        ))
    with pytest.raises(ValueError, match="keine Kandidaten"):
        select_next([*candidates, *forbidden], rules, seed, 1)
    with pytest.raises(ValueError, match="keine Kandidaten"):
        plan_cycle([*candidates, *forbidden], rules, seed)

    run = Run(candidates, rules, seed).drain(min(3 * len(candidates) + 10, 60))
    forbidden_ids = {c.run_track_id for c in forbidden}
    assert not forbidden_ids & set(run.picked_ids)
    # preflight is the one function that accepts them — and must not count them.
    conflicts = preflight([*candidates, *forbidden], Rules(min_gap=10_000))
    unsatisfiable = [c for c in conflicts if c.code == "min_gap_unsatisfiable"]
    assert unsatisfiable and unsatisfiable[0].suggestion == len(candidates) - 1


@given(candidates=candidate_sets(max_size=20), rules=rules_sets(), seed=seeds)
@settings(max_examples=40)
def test_p5_selection_always_names_a_real_candidate(candidates, rules, seed):
    ids = {c.run_track_id for c in candidates}
    run = Run(candidates, rules, seed).drain(30)
    for drawn in run.picks:
        assert drawn.selection.run_track_id in ids
        assert drawn.selection.candidate_count == len(candidates)


# ---------------------------------------------------------------------------
# P6 — skip policies
# ---------------------------------------------------------------------------

@given(
    n=st.integers(2, 25),
    seed=seeds,
    skip_at=st.integers(1, 5),
    policy=st.sampled_from(list(SKIP_POLICIES)),
)
@settings(max_examples=60)
def test_p6_apply_skip_state_sequences(n, seed, skip_at, policy):
    """P6: the state after a skip is exactly the one the contract names, and
    the pool reacts accordingly on the next draw."""
    pool = {i: make(i) for i in range(1, n + 1)}
    run = Run(list(pool.values()), Rules(), seed)
    for _ in range(min(skip_at, n) - 1):
        run.step()
    drawn = run.step()
    assert not drawn.selection.exhausted
    skipped_id = drawn.selection.run_track_id
    outcome = apply_skip("open", policy)

    expected_state = {
        "consume": "played", "keep_open": "open",
        "requeue_later": "deferred", "defer_to_end": "deferred",
    }[policy]
    assert outcome.new_state == expected_state
    assert outcome.consumed is (policy == "consume")
    assert (outcome.requeue_after_draws == REQUEUE_AFTER_DRAWS) is (policy == "requeue_later")
    assert outcome.requeue_at_cycle_end is (policy == "defer_to_end")

    # keep_open leaves the card selectable; the other policies take it out of
    # the open pool for now.
    card = run.pool[skipped_id]
    run.pool[skipped_id] = replace(card, state=outcome.new_state)
    remaining_open = [c for c in run.snapshot() if c.state == "open"]
    assert (skipped_id in {c.run_track_id for c in remaining_open}) is (policy == "keep_open")


@given(n=st.integers(3, 20), seed=seeds)
@settings(max_examples=40)
def test_p6_requeue_later_card_returns_exactly_once(n, seed):
    """P6: a requeue_later card comes back — exactly once, nothing lost.

    The caller re-opens it after :data:`REQUEUE_AFTER_DRAWS` draws, as
    :func:`apply_skip` instructs, and only while it is still deferred.  The
    resubmission window is only honoured when the open pool lasts that long;
    otherwise the deferred endgame hands the card back early — pinned by
    ``test_violation_p6_requeue_later_returns_before_ten_draws``.
    """
    pool = {i: make(i) for i in range(1, n + 1)}
    run = Run(list(pool.values()), Rules(), seed)
    first = run.step()
    skipped_id = first.selection.run_track_id
    outcome = apply_skip("open", "requeue_later")
    card = run.undo_last_draw().before
    assert card is not None
    run.pool[skipped_id] = replace(card, state=outcome.new_state)

    reopen_seq = first.seq + outcome.requeue_after_draws + 1
    for _ in range(4 * n + 20):
        if run.seq >= reopen_seq and run.pool[skipped_id].state == "deferred":
            run.pool[skipped_id] = replace(run.pool[skipped_id], state="open")
        if run.step().selection.exhausted:
            break

    picked = run.picked_ids
    assert picked.count(skipped_id) == 1, "the requeued card was lost or played twice"
    assert sorted(picked) == sorted(pool)
    return_seq = next(d.seq for d in run.picks if d.selection.run_track_id == skipped_id)
    if n >= reopen_seq:
        # Enough open cards to bridge the resubmission window: the card comes
        # back through the front door, never before its due draw.
        assert return_seq >= reopen_seq
    else:
        # Too few open cards: the deferred endgame returns it at the first
        # draw after the open pool is empty, possibly long before its due
        # draw — that is the violation.
        assert return_seq == n + 1


@given(
    n_open=st.integers(1, 15),
    n_deferred=st.integers(1, 8),
    seed=seeds,
)
@settings(max_examples=40)
def test_p6_defer_to_end_cards_play_only_after_the_open_pool(n_open, n_deferred, seed):
    """P6: defer_to_end ⇒ deferred cards strictly after the open ones."""
    candidates = (
        [make(i) for i in range(1, n_open + 1)]
        + [make(1000 + i, state="deferred") for i in range(n_deferred)]
    )
    run = Run(candidates, Rules(skip_policy="defer_to_end"), seed).drain(len(candidates) + 3)
    picked = run.picked_ids
    assert sorted(picked) == sorted(c.run_track_id for c in candidates)
    assert all(t < 1000 for t in picked[:n_open])
    assert all(t >= 1000 for t in picked[n_open:])


@given(candidates=candidate_sets(max_size=20), seed=seeds, seq=st.integers(1, 100))
@settings(max_examples=40)
def test_p6_skip_and_duplicate_policy_do_not_influence_the_draw(candidates, seed, seq):
    """The engine's draw is invariant under ``skip_policy`` and
    ``duplicate_policy`` — proof that neither is consulted in the selection
    path.  For ``skip_policy`` that is correct (apply_skip owns it); for
    ``duplicate_policy`` it is the gap documented in
    ``test_violation_p1_duplicate_policy_collapse_is_never_enforced``.
    """
    base = Rules(repeat_mode="free_repeat", min_gap=1)
    results = [
        select_next(
            candidates, replace(base, skip_policy=skip, duplicate_policy=dup), seed, seq
        )
        for skip in SKIP_POLICIES for dup in DUPLICATE_POLICIES
    ]
    assert all(result == results[0] for result in results)   # Selection is unhashable


# ---------------------------------------------------------------------------
# P7 — the repeat quota ceiling
# ---------------------------------------------------------------------------

def _window_breach(window: List[int], quota: int) -> Optional[Tuple[int, int]]:
    """The first 100-draw window whose repeat count exceeds ``quota``."""
    for start in range(max(1, len(window) - QUOTA_WINDOW + 1)):
        chunk = window[start:start + QUOTA_WINDOW]
        if sum(chunk) > quota:
            return start, sum(chunk)
    return None


@given(
    n=st.integers(1, 12),
    quota=st.integers(0, 100).filter(lambda q: q not in FLOAT_LENIENT_QUOTAS),
    gap=st.integers(0, 6),
    seed=seeds,
)
@settings(max_examples=120)
def test_p7_quota_ceiling_holds_over_long_sequences(n, quota, gap, seed):
    """P7: at most ``repeat_quota_pct`` repeats in ANY 100 consecutive draws.

    The window is led exactly as an honest caller would (and as
    :func:`plan_cycle` does): the last :data:`QUOTA_WINDOW` draws, a repeat
    being a card that had been played before.  260 draws with a small pool
    force the ceiling to be tested continuously, not just once.
    """
    candidates = [make(i) for i in range(1, n + 1)]
    rules = Rules(repeat_mode="limited_repeat", min_gap=gap, repeat_quota_pct=quota)
    run = Run(candidates, rules, seed).drain(260, stop_on_exhaustion=False)
    assert len(run.window) == 260
    breach = _window_breach(run.window, quota)
    assert breach is None, (
        f"quota {quota}% breached: window at draw {breach[0]} holds {breach[1]} repeats"
    )
    if quota >= 50 and n >= 2:
        # Non-vacuity: the engine really does ride the ceiling, the property is
        # not passing because nothing ever repeated.
        assert sum(run.window) > 0


@given(
    n=st.integers(1, 10),
    quota=st.integers(0, 100).filter(lambda q: q not in FLOAT_LENIENT_QUOTAS),
    seed=seeds,
)
@settings(max_examples=30)
def test_p7_plan_cycle_keeps_the_quota_inside_the_plan(n, quota, seed):
    candidates = [make(i) for i in range(1, n + 1)]
    rules = Rules(repeat_mode="limited_repeat", min_gap=0, repeat_quota_pct=quota)
    plan = plan_cycle(candidates, rules, seed)
    repeats = sum(1 for i, track in enumerate(plan) if track in plan[:i])
    assert repeats <= quota
    assert len(plan) <= min(PLAN_HORIZON, n)


@given(candidates=candidate_sets(max_size=15, start_seq=10), seed=seeds)
@settings(max_examples=30)
def test_p7_free_repeat_ignores_the_quota_but_never_the_gap(candidates, seed):
    """free_repeat is the documented quota exception — the gap still holds."""
    rules = Rules(repeat_mode="free_repeat", min_gap=2, repeat_quota_pct=0)
    run = Run(candidates, rules, seed, start_seq=10).drain(50)
    for drawn in run.picks:
        before = drawn.before
        assert before is not None
        if before.last_played_seq is not None:
            assert drawn.seq - before.last_played_seq > effective_gap(drawn.selection, rules)


@pytest.mark.slow
@pytest.mark.parametrize("quota", [1, 7, 20, 33, 55, 80, 99])
def test_p7_quota_ceiling_over_five_thousand_draws(quota):
    """Deep P7: 5000 draws against a 4-card pool, gap and quota both binding —
    the 100-draw ceiling must hold at every one of the ~4900 window positions.
    """
    candidates = [make(i) for i in range(1, 5)]
    rules = Rules(repeat_mode="limited_repeat", min_gap=2, repeat_quota_pct=quota)
    run = Run(candidates, rules, seed=31337).drain(5000, stop_on_exhaustion=False)
    assert len(run.window) == 5000
    assert _window_breach(run.window, quota) is None
    for drawn in run.picks:
        before = drawn.before
        assert before is not None
        if before.last_played_seq is not None:
            assert drawn.seq - before.last_played_seq > effective_gap(drawn.selection, rules)


def test_float_lenient_quota_set_is_exactly_the_known_three():
    """Pins the root cause of the P7 violation: ``share * 100.0 < quota`` is
    the engine's gate, and for ``share = k/100`` the product lands *below* k
    for exactly these three k.  If this set ever changes, the exclusions in
    the generic P7/P8 strategies are wrong.
    """
    lenient = {k for k in range(101) if (k / 100.0) * 100.0 < k}
    assert lenient == set(FLOAT_LENIENT_QUOTAS)


# ---------------------------------------------------------------------------
# P8 — exhausted exactness
# ---------------------------------------------------------------------------

def _conformant_candidate_exists(
    pool: Sequence[Candidate], rules: Rules, seq: int, window_repeats: int
) -> bool:
    """Independent oracle for P8, derived from the contract, not the code.

    A rule-conformant candidate exists when an open or deferred card is
    available; otherwise only a repeat can help, which needs a repeat mode,
    quota headroom (integer arithmetic — the float gate is a separate finding)
    and at least one card with a distance of 1 or more (the F6 ladder can
    lower the gap to ``max_distance - 1`` but never below 0).
    """
    if any(c.state in ("open", "deferred") for c in pool):
        return True
    if rules.repeat_mode == "no_repeat":
        return False
    if rules.repeat_mode == "limited_repeat" and window_repeats + 1 > rules.repeat_quota_pct:
        return False
    return any(seq - int(c.last_played_seq) >= 1 for c in pool if c.state == "played")


@given(
    candidates=candidate_sets(max_size=20, start_seq=12),
    rules=rules_sets(max_gap=25, quota_exclude=FLOAT_LENIENT_QUOTAS),
    seed=seeds,
)
@settings(max_examples=300)
def test_p8_exhausted_exactly_when_no_conformant_candidate_exists(candidates, rules, seed):
    """P8: ``exhausted`` ⇔ the oracle finds no admissible candidate."""
    run = Run(candidates, rules, seed, start_seq=12)
    for _ in range(min(3 * len(candidates) + 15, 60)):
        expected = _conformant_candidate_exists(
            run.snapshot(), rules, run.seq, run.window_repeats
        )
        drawn = run.step()
        assert drawn.selection.exhausted is (not expected), (
            f"exhausted={drawn.selection.exhausted} but a conformant candidate "
            f"{'exists' if expected else 'does not exist'} at seq {drawn.seq}; "
            f"filtered_by={drawn.selection.filtered_by}"
        )
        if drawn.selection.exhausted:
            break


@given(rules=rules_sets(), seed=seeds, seq=st.integers(1, 1000))
@settings(max_examples=30)
def test_p8_empty_candidate_set_is_always_exhausted(rules, seed, seq):
    selection = select_next([], rules, seed, seq)
    assert selection.exhausted is True
    assert selection.run_track_id is None
    assert selection.candidate_count == 0
    assert selection.filtered_by == {}
    assert plan_cycle([], rules, seed) == []


@given(
    candidates=candidate_sets(max_size=12, states=("played",), start_seq=5),
    gap=st.integers(0, 20),
    seed=seeds,
)
@settings(max_examples=40)
def test_p8_no_repeat_exhausts_as_soon_as_only_played_cards_remain(candidates, gap, seed):
    rules = Rules(repeat_mode="no_repeat", min_gap=gap)
    selection = select_next(candidates, rules, seed, 6)
    assert selection.exhausted is True
    assert selection.filtered_by == {"played": len(candidates)}


# ---------------------------------------------------------------------------
# Attack point 1 — quota window semantics over long horizons
# ---------------------------------------------------------------------------

def test_attack_quota_window_ceiling_survives_a_thousand_draws():
    """A thousand draws against a 6-card pool: the 100-draw ceiling holds at
    every position (quota values outside the float-lenient set)."""
    for quota in (1, 5, 20, 33, 50, 75, 99, 100):
        candidates = [make(i) for i in range(1, 7)]
        rules = Rules(repeat_mode="limited_repeat", min_gap=0, repeat_quota_pct=quota)
        run = Run(candidates, rules, seed=20260801).drain(1000, stop_on_exhaustion=False)
        assert len(run.window) == 1000
        assert _window_breach(run.window, quota) is None, f"quota {quota} breached"


def test_attack_quota_window_denominator_is_lenient_for_short_runs():
    """Documented semantics gap (NOT a P7 breach, but worth knowing).

    The window denominator is always 100, also when far fewer draws exist —
    ``plan_cycle`` divides by :data:`QUOTA_WINDOW` itself.  A 50-draw plan with
    ``repeat_quota_pct=4`` may therefore contain 4 repeats = 8 % of the plan.
    The contract wording ("Anteil an den letzten 100 Zügen") permits this
    reading; a caller reading the quota as "share of the run so far" gets
    twice what it configured.
    """
    candidates = [make(i) for i in range(1, 51)]
    rules = Rules(repeat_mode="limited_repeat", min_gap=0, repeat_quota_pct=4)
    plan = plan_cycle(candidates, rules, seed=13)
    repeats = sum(1 for i, track in enumerate(plan) if track in plan[:i])
    assert len(plan) == PLAN_HORIZON
    assert repeats <= 4                                   # ceiling per the 100-window
    assert repeats / len(plan) > 4 / 100                  # …but 8 % of this plan
    assert math.isclose(repeats / len(plan), 0.08)


@given(
    quota=st.integers(0, 100).filter(lambda q: q not in FLOAT_LENIENT_QUOTAS),
    share_pct=st.integers(0, 100),
    seed=seeds,
)
@settings(max_examples=100)
def test_attack_quota_gate_matches_the_integer_reading(quota, share_pct, seed):
    """The gate must behave like integer arithmetic on the window count."""
    candidate = played(1, last_played_seq=1)
    rules = Rules(repeat_mode="limited_repeat", min_gap=0, repeat_quota_pct=quota)
    selection = select_next(
        [candidate], rules, seed, 50, recent_repeat_share=share_pct / 100.0
    )
    admitted_by_integer_reading = share_pct + 1 <= quota
    assert (not selection.exhausted) is admitted_by_integer_reading


# ---------------------------------------------------------------------------
# Attack point 2 — relaxation edges (max_distance < 1, relaxation × quota)
# ---------------------------------------------------------------------------

@given(
    n=st.integers(1, 10),
    gap=st.integers(0, 30),
    seed=seeds,
    mode=st.sampled_from(["limited_repeat", "free_repeat"]),
)
@settings(max_examples=60)
def test_attack_relaxation_edge_max_distance_below_one(n, gap, seed, mode):
    """All played cards at distance ≤ 0 ⇒ no relaxation, clean exhaustion.

    ``max_distance - 1`` would be a negative gap; the engine must not invent
    one, must not draw, and must not write a ``gap_relaxed_*`` key.
    """
    seq = 30
    candidates = [played(i, last_played_seq=seq + i % 3) for i in range(1, n + 1)]
    rules = Rules(repeat_mode=mode, min_gap=gap, repeat_quota_pct=100)
    selection = select_next([*candidates], rules, seed, seq, recent_repeat_share=0.0)
    assert selection.exhausted is True
    assert selection.run_track_id is None
    assert "gap_relaxed_to" not in selection.filtered_by
    assert "gap_relaxed_from" not in selection.filtered_by
    assert selection.filtered_by == {"gap": n}


@given(gap=st.integers(1, 40), seed=seeds)
@settings(max_examples=40)
def test_attack_relaxation_edge_max_distance_exactly_one(gap, seed):
    """The tightest legal relaxation: gap drops to 0, distance 1 is kept."""
    seq = 50
    candidates = [played(1, last_played_seq=seq - 1), played(2, last_played_seq=seq)]
    rules = Rules(repeat_mode="free_repeat", min_gap=gap)
    selection = select_next(candidates, rules, seed, seq)
    assert selection.run_track_id == 1
    assert selection.filtered_by["gap_relaxed_from"] == gap
    assert selection.filtered_by["gap_relaxed_to"] == 0
    assert selection.filtered_by["gap"] == 1              # the distance-0 card
    assert seq - 1 > selection.filtered_by["gap_relaxed_to"] * 0    # distance 1 > gap 0


@given(
    n=st.integers(1, 8),
    gap=st.integers(5, 40),
    quota=st.integers(1, 100).filter(lambda q: q not in FLOAT_LENIENT_QUOTAS),
    seed=seeds,
)
@settings(max_examples=60)
def test_attack_relaxation_never_fires_when_the_quota_blocks(n, gap, quota, seed):
    """Relaxation × quota: the ladder relaxes ``min_gap`` ONLY.  With the quota
    exhausted the draw must report exhaustion instead of relaxing a repeat in.
    """
    seq = 60
    candidates = [played(i, last_played_seq=seq - i) for i in range(1, n + 1)]
    rules = Rules(repeat_mode="limited_repeat", min_gap=gap, repeat_quota_pct=quota)
    selection = select_next(
        candidates, rules, seed, seq, recent_repeat_share=quota / 100.0
    )
    assert selection.exhausted is True
    assert "gap_relaxed_to" not in selection.filtered_by
    assert selection.run_track_id is None


@given(
    n=st.integers(2, 12),
    gap=st.integers(0, 30),
    seed=seeds,
)
@settings(max_examples=60)
def test_attack_relaxed_gap_is_always_the_maximum_satisfiable_k(n, gap, seed):
    """``gap_relaxed_to`` must be the largest k any card can satisfy — one
    below the maximum distance in the pool (contract: "max erfüllbares k")."""
    seq = 80
    distances = [1 + (i * 3) % (n + 2) for i in range(n)]
    candidates = [
        played(i + 1, last_played_seq=seq - distances[i]) for i in range(n)
    ]
    rules = Rules(repeat_mode="free_repeat", min_gap=gap)
    selection = select_next(candidates, rules, seed, seq)
    max_distance = max(distances)
    if gap < max_distance:                                # no relaxation needed
        assert "gap_relaxed_to" not in selection.filtered_by
        return
    assert selection.filtered_by["gap_relaxed_to"] == max_distance - 1
    assert selection.filtered_by["gap_relaxed_from"] == gap
    chosen = next(c for c in candidates if c.run_track_id == selection.run_track_id)
    assert seq - int(chosen.last_played_seq) == max_distance


# ---------------------------------------------------------------------------
# Attack point 3 — float accumulation with extreme weights
# ---------------------------------------------------------------------------

@given(
    heavy=st.sampled_from([1e6, 1e9, 1e12]),
    n_light=st.integers(1, 30),
    seed=seeds,
)
@settings(max_examples=40)
def test_attack_extreme_weights_keep_every_candidate_representable(heavy, n_light, seed):
    """1e9 next to 1.0: the running sum must stay strictly increasing, i.e. no
    candidate is silently swallowed (weight 0 would violate P5, and an
    unreachable weight is weight 0 in disguise)."""
    candidates = [make(1, weight=heavy)] + [
        make(i, weight=1.0) for i in range(2, n_light + 2)
    ]
    weights = [c.weight for c in candidates]
    accumulated = 0.0
    for weight in weights:
        previous = accumulated
        accumulated += weight
        assert accumulated > previous, "a positive weight vanished in the accumulation"
    assert math.isfinite(sum(weights))
    selection = select_next(candidates, Rules(), seed, 1)
    assert selection.run_track_id in {c.run_track_id for c in candidates}


def test_attack_heavy_weight_dominates_but_light_cards_stay_reachable():
    """With 1e9 vs 1.0 the heavy card wins every draw (correct: p ≈ 1 − 1e-9),
    while a moderate ratio (100 vs 1) still lets the light cards through."""
    heavy_pool = [make(1, weight=1e9), make(2, weight=1.0), make(3, weight=1.0)]
    rules = Rules(repeat_mode="free_repeat", min_gap=0)
    run = Run(heavy_pool, rules, seed=5).drain(300)
    assert set(run.picked_ids) == {1}

    moderate = [make(1, weight=100.0), make(2, weight=1.0), make(3, weight=1.0)]
    run2 = Run(moderate, rules, seed=5).drain(600)
    assert set(run2.picked_ids) == {1, 2, 3}


@given(
    weight=st.sampled_from([1e-6, 1.0, 1e6, 1e9]),
    favorite_weight=st.sampled_from(FAVORITE_WEIGHTS),
    seed=seeds,
    seq=st.integers(1, 500),
)
@settings(max_examples=60)
def test_attack_extreme_weights_stay_deterministic(weight, favorite_weight, seed, seq):
    """Whatever the float edge does, it must do it reproducibly (P3)."""
    candidates = [make(1, weight=weight, favorite=True), make(2, weight=1.0)]
    rules = Rules(favorite_weight=favorite_weight)
    first = select_next(candidates, rules, seed, seq)
    assert first == select_next(list(reversed(candidates)), rules, seed, seq)


# ---------------------------------------------------------------------------
# Attack point 4 — P1 × keep_open with a set last_played_seq (no_repeat)
# ---------------------------------------------------------------------------

@given(n=st.integers(2, 20), seed=seeds)
@settings(max_examples=40)
def test_attack_keep_open_card_is_not_consumed(n, seed):
    """keep_open (contract §3): the card stays in the pool and the cycle does
    not lose it.  The engine ignores ``last_played_seq`` on open cards, which
    is what ``test_violation_p2_keep_open_ignores_min_gap`` pins down.
    """
    candidates = [make(i) for i in range(1, n + 1)]
    run = Run(candidates, Rules(skip_policy="keep_open"), seed)
    first = run.step()
    skipped_id = first.selection.run_track_id
    outcome = apply_skip("open", "keep_open")
    assert outcome.consumed is False
    card = run.undo_last_draw().before
    assert card is not None
    # The caller records the partial play (played_threshold='on_start') but
    # keeps the card open, exactly as the policy says.
    run.pool[skipped_id] = replace(
        card, state="open", play_count=1, last_played_seq=first.seq
    )

    remaining = {c.run_track_id for c in run.snapshot() if c.state == "open"}
    assert skipped_id in remaining
    run.drain(n + 5)
    assert skipped_id in run.picked_ids, "the kept-open card fell out of the cycle"


def test_attack_keep_open_card_can_be_redrawn_immediately_in_no_repeat():
    """The engine treats an ``open`` card as fresh, whatever its history: the
    just-skipped title can be the very next draw.  Documented here as
    behaviour; the rule consequence (min_gap not applied) is the xfail below.
    """
    candidates = [
        make(1, state="open", play_count=1, last_played_seq=4),      # kept open
        make(2, state="played", play_count=1, last_played_seq=3),
    ]
    selection = select_next(candidates, Rules(min_gap=10), seed=1, seq=5)
    assert selection.run_track_id == 1                # distance 1 to its own last play
    assert selection.filtered_by == {"played": 1}     # nothing about the gap


# ---------------------------------------------------------------------------
# CHECKED-IN VIOLATIONS — xfail(strict=True), minimal deterministic repros.
# core/ is off limits for this run: these document, they do not fix.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("quota", sorted(FLOAT_LENIENT_QUOTAS))
@pytest.mark.xfail(strict=True, reason=(
    "P7-Verletzung: die Quota-Schranke ist `recent_repeat_share * 100.0 < "
    "repeat_quota_pct`. Fuer share = k/100 liegt das Produkt in IEEE-754 bei "
    "k = 29, 57, 58 unter k (0.29*100 == 28.999999999999996), also laesst die "
    "Engine bei exakt ausgeschoepfter Quote eine weitere Wiederholung zu: das "
    "100-Zuege-Fenster enthaelt danach quota+1 Wiederholungen."
))
def test_violation_p7_quota_float_leniency(quota):
    candidate = played(1, last_played_seq=1)
    rules = Rules(repeat_mode="limited_repeat", min_gap=0, repeat_quota_pct=quota)
    selection = select_next(
        [candidate], rules, seed=1, seq=500, recent_repeat_share=quota / 100.0
    )
    assert selection.exhausted is True, (
        f"quota {quota}% already exhausted ({quota}/100 repeats) — one more "
        f"repeat pushes the window to {quota + 1}%"
    )


@pytest.mark.xfail(strict=True, reason=(
    "P7-Verletzung (Folgenebene): 400 Zuege mit ehrlich gefuehrtem Fenster und "
    "repeat_quota_pct=29 enthalten ein 100-Zuege-Fenster mit 30 Wiederholungen "
    "— gleiche Ursache wie test_violation_p7_quota_float_leniency."
))
def test_violation_p7_ceiling_breaks_over_a_long_sequence():
    candidates = [make(i) for i in range(1, 11)]
    rules = Rules(repeat_mode="limited_repeat", min_gap=0, repeat_quota_pct=29)
    run = Run(candidates, rules, seed=5).drain(400, stop_on_exhaustion=False)
    breach = _window_breach(run.window, 29)
    assert breach is None, f"window at draw {breach[0]} holds {breach[1]} repeats"


@pytest.mark.xfail(strict=True, reason=(
    "P2-Verletzung: min_gap wird nur gegen state='played' geprueft. Eine "
    "deferred Karte mit gesetztem last_played_seq (realistisch: "
    "played_threshold='on_start' + Skip mit requeue_later/defer_to_end) wird im "
    "Deferred-Endspiel ohne Gap-Pruefung gezogen — Abstand 1 bei min_gap=50, "
    "und filtered_by dokumentiert nichts (keine gap_relaxed_*-Schluessel)."
))
def test_violation_p2_deferred_endgame_ignores_min_gap():
    card = make(1, state="deferred", play_count=1, last_played_seq=9)
    rules = Rules(repeat_mode="free_repeat", min_gap=50)
    selection = select_next([card], rules, seed=1, seq=10)
    distance = 10 - 9
    assert selection.run_track_id is None or distance > effective_gap(selection, rules), (
        f"deferred card replayed at distance {distance} with min_gap "
        f"{rules.min_gap}, filtered_by={selection.filtered_by}"
    )


@pytest.mark.xfail(strict=True, reason=(
    "P2-Verletzung: min_gap wird nicht gegen 'open' Karten geprueft. Mit "
    "skip_policy='keep_open' bleibt die gerade angespielte Karte offen und "
    "traegt last_played_seq; sie kann im naechsten Zug erneut gezogen werden "
    "(Abstand 1 bei min_gap=10), ohne dokumentierte Relaxation."
))
def test_violation_p2_keep_open_ignores_min_gap():
    kept_open = make(1, state="open", play_count=1, last_played_seq=4)
    rules = Rules(repeat_mode="limited_repeat", min_gap=10, repeat_quota_pct=50)
    selection = select_next([kept_open], rules, seed=1, seq=5, recent_repeat_share=0.0)
    distance = 5 - 4
    assert selection.run_track_id is None or distance > effective_gap(selection, rules), (
        f"kept-open card replayed at distance {distance} with min_gap "
        f"{rules.min_gap}, filtered_by={selection.filtered_by}"
    )


@pytest.mark.xfail(strict=True, reason=(
    "P6-Verletzung: apply_skip verspricht fuer requeue_later eine Wiedervorlage "
    "nach >= REQUEUE_AFTER_DRAWS (10) Zuegen, das Deferred-Endspiel in "
    "select_next gibt die Karte aber schon nach 2 Zuegen zurueck, sobald der "
    "offene Pool leer ist — die Wiedervorlagefrist ist nicht durchsetzbar."
))
def test_violation_p6_requeue_later_returns_before_ten_draws():
    pool = {1: make(1), 2: make(2)}
    first = select_next(list(pool.values()), Rules(), seed=3, seq=1)
    skipped_id = first.run_track_id
    outcome = apply_skip("open", "requeue_later")
    assert outcome.requeue_after_draws == REQUEUE_AFTER_DRAWS
    pool[skipped_id] = replace(
        pool[skipped_id], state="deferred", play_count=1, last_played_seq=1
    )
    other = next(i for i in pool if i != skipped_id)
    second = select_next(list(pool.values()), Rules(), seed=3, seq=2)
    assert second.run_track_id == other
    pool[other] = replace(pool[other], state="played", play_count=1, last_played_seq=2)

    third = select_next(list(pool.values()), Rules(), seed=3, seq=3)
    returned_after = 3 - 1
    assert third.run_track_id != skipped_id or returned_after >= REQUEUE_AFTER_DRAWS, (
        f"requeue_later card returned after {returned_after} draws, "
        f"contract says >= {REQUEUE_AFTER_DRAWS}"
    )


@pytest.mark.xfail(strict=True, reason=(
    "P2-Verletzung (Dokumentation): plan_cycle verwirft die filtered_by-Daten "
    "der Einzelzuege. Ein Plan im Wiederholungsmodus kann die F6-Relaxation "
    "enthalten (hier Wiederholung mit Abstand 2 bei min_gap=10), ohne dass der "
    "Aufrufer irgendeinen Kanal haette, das zu erfahren — P2 verlangt "
    "'Relaxation nur dokumentiert'."
))
def test_violation_p2_plan_cycle_hides_the_relaxation():
    candidates = [make(1)] + [played(i, last_played_seq=i - 1) for i in range(2, 6)]
    rules = Rules(repeat_mode="free_repeat", min_gap=10)
    plan = plan_cycle(candidates, rules, seed=4)
    last_position: Dict[int, int] = {}
    violations = []
    for position, track in enumerate(plan, start=1):
        if track in last_position and position - last_position[track] <= rules.min_gap:
            violations.append((track, last_position[track], position))
        last_position[track] = position
    assert not violations, (
        f"plan {plan} repeats inside min_gap={rules.min_gap} at {violations} "
        "with no filtered_by channel on plan_cycle"
    )


@pytest.mark.xfail(strict=True, reason=(
    "Vertrag §Funktionen 1 / P2-Konsistenz: plan_cycle simuliert den "
    "Wiederholungshorizont ab seq=1, die Kandidaten tragen aber absolute "
    "last_played_seq aus dem laufenden Run. Jede Karte mit last_played_seq >= "
    "Plan-seq hat damit Abstand <= 0 und faellt komplett aus dem Plan; "
    "stattdessen werden die offenen Karten innerhalb des Horizonts wiederholt. "
    "Ein Replan mitten im Run liefert so einen Plan, der von dem abweicht, was "
    "select_next beim echten seq zulaesst (dort ist die Karte zulaessig)."
))
def test_violation_plan_cycle_local_clock_drops_played_candidates():
    candidates = [make(1), played(2, last_played_seq=100)]
    rules = Rules(repeat_mode="free_repeat", min_gap=0)
    plan = plan_cycle(candidates, rules, seed=7)
    # At any real seq > 100 card 2 is a legal repeat — select_next says so:
    live = select_next(candidates, rules, seed=7, seq=101)
    assert not live.exhausted
    assert 2 in plan, (
        f"plan {plan} never plans card 2 (last_played_seq=100) and repeats "
        "card 1 instead, although select_next admits card 2 at the real seq"
    )


@pytest.mark.xfail(strict=True, reason=(
    "P8-Verletzung (Randfall): bei repeat_quota_pct=100 ist jede Wiederholung "
    "regelkonform (Anteil 100 % <= 100 %), die strikte Schranke "
    "'share*100 < quota' meldet aber exhausted — falsche Erschoepfung, obwohl "
    "ein regelkonformer Kandidat existiert."
))
def test_violation_p8_quota_hundred_reports_false_exhaustion():
    candidate = played(1, last_played_seq=1)
    rules = Rules(repeat_mode="limited_repeat", min_gap=0, repeat_quota_pct=100)
    selection = select_next([candidate], rules, seed=1, seq=50, recent_repeat_share=1.0)
    assert selection.exhausted is False, (
        "quota 100 % must never exhaust — a repeat keeps the share at 100 %"
    )


@pytest.mark.parametrize("bad_weight", [float("nan"), float("inf")])
@pytest.mark.xfail(strict=True, reason=(
    "P4/P5-Verletzung (Robustheit): Candidate prueft nur `weight <= 0`, also "
    "passieren NaN und inf die Validierung (NaN <= 0 ist False). In "
    "_weighted_pick werden dann alle Vergleiche False und die Ziehung faellt "
    "still auf ordered[-1] zurueck: die hoechste run_track_id gewinnt immer, "
    "jede andere Karte ist still ausgeschlossen. Gleiches gilt fuer "
    "weight*favorite_weight == inf (validiert, weil favorite_weight nur >= 1.0 "
    "geprueft wird)."
))
def test_violation_p4_non_finite_weight_silently_excludes_everything_else(bad_weight):
    candidates = [make(1, weight=bad_weight), make(2, weight=1.0), make(3, weight=1.0)]
    rules = Rules(repeat_mode="free_repeat", min_gap=0)
    winners = {
        select_next(candidates, rules, seed, 1).run_track_id for seed in range(40)
    }
    assert winners != {3}, (
        f"weight={bad_weight!r} makes the highest run_track_id win every draw "
        f"(winners={winners}) — every other card is silently excluded"
    )


@pytest.mark.xfail(strict=True, reason=(
    "P1-Verletzung (Titel-Ebene): Rules.duplicate_policy wird von der Engine "
    "nie ausgewertet (weder select_next noch plan_cycle lesen track_key). Mit "
    "duplicate_policy='collapse' spielt ein Zyklus denselben Titel zweimal, "
    "sobald zwei run_tracks-Zeilen denselben track_key tragen — anders als bei "
    "excluded/admitted gibt es hier keinen defensiven Check, der den kaputten "
    "Vorfilter des Aufrufers sichtbar macht."
))
def test_violation_p1_duplicate_policy_collapse_is_never_enforced():
    candidates = [
        Candidate(run_track_id=1, track_key="spotify:same"),
        Candidate(run_track_id=2, track_key="spotify:same"),
        Candidate(run_track_id=3, track_key="spotify:other"),
    ]
    rules = Rules(duplicate_policy="collapse")
    run = Run(candidates, rules, seed=5).drain(6)
    by_id = {c.run_track_id: c.track_key for c in candidates}
    keys = [by_id[t] for t in run.picked_ids]
    assert len(keys) == len(set(keys)), (
        f"duplicate_policy='collapse' but the cycle played {keys} — the same "
        "track twice, and select_next accepted the set without complaint"
    )
