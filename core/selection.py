"""Pure selection / rule engine — WP3-C.

Contract: ``docs/ts-fable-01/worknotes/WP3C_SELECTION_CONTRACT.md`` (based on
ADR-003 F3/F4/F6 and Blueprint §5.3: SQL only pre-filters candidates, the
rules live here).  The service layer (WP3-D) materialises :class:`Candidate`
rows from ``run_tracks``, calls :func:`plan_cycle` / :func:`select_next`, and
persists ``run_plan`` / ``run_selections`` from the returned values.

Design constraints
------------------
* **No I/O, no module-level state, no ``random`` module, no built-in
  ``hash()``.**  Every draw derives from :func:`draw_seed` — SHA-256 over
  ``label:seed:seq`` — so identical inputs produce identical selections in
  any process on any machine (invariant P3).
* Excluded / not-admitted tracks are **not candidates**.  The caller filters;
  the engine re-checks defensively and raises ``ValueError`` (invariant P5).
* The relaxation ladder (ADR-003 F6) applies to ``min_gap`` ONLY, is always
  recorded in ``Selection.filtered_by`` and never touches user exclusions
  (invariants P2 + P8).  The repeat quota is deliberately never relaxed.

Invariants (property-test targets, written by an independent run):
P1 no-repeat completeness · P2 hard min-gap · P3 determinism ·
P4 favourite weighting · P5 exclusions absolute · P6 skip policies ·
P7 quota ceiling · P8 exhausted exactness.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import struct
from dataclasses import dataclass, replace
from typing import Any, Dict, List, Optional, Sequence, Tuple

from core.shuffle import fisher_yates_shuffle, shuffle_with_guard

# ---------------------------------------------------------------------------
# Vocabulary — mirrors the run_configs CHECK constraints (Blueprint §2.2) and
# the run_tracks.state column (§2.3, minus the excluded_* states, which are
# expressed on Candidate as flags because they are not selectable).
# ---------------------------------------------------------------------------

REPEAT_MODES: Tuple[str, ...] = ("no_repeat", "limited_repeat", "free_repeat")
SKIP_POLICIES: Tuple[str, ...] = ("consume", "keep_open", "requeue_later", "defer_to_end")
MANUAL_USE_POLICIES: Tuple[str, ...] = ("auto_resume", "auto_pause", "ask")
NEW_TRACKS_POLICIES: Tuple[str, ...] = ("include_now", "after_cycle", "ignore")
DUPLICATE_POLICIES: Tuple[str, ...] = ("collapse", "keep_entries")
UNPLAYABLE_POLICIES: Tuple[str, ...] = ("exclude", "retry_next_cycle")
PLAYED_THRESHOLDS: Tuple[str, ...] = ("on_start", "on_min_seconds", "on_track_end")
EXECUTION_STRATEGIES: Tuple[str, ...] = (
    "single_uri", "uris_window", "context_playlist", "no_prefetch",
)
CANDIDATE_STATES: Tuple[str, ...] = ("open", "played", "deferred")

#: requeue_later (P6): the skipped card comes back after at least this many draws.
REQUEUE_AFTER_DRAWS = 10

#: Rolling plan horizon for the repeat modes (contract: ``min(50, n)``).
PLAN_HORIZON = 50

#: The quota window: share of repeats over the last this-many draws (P7).
QUOTA_WINDOW = 100


# ---------------------------------------------------------------------------
# Deterministic PRNG — hashlib only, never `random` module state, never hash()
# ---------------------------------------------------------------------------

class HashPRNG:
    """Deterministic PRNG: SHA-256 in counter mode over a 64-bit seed (P3).

    Implements ``randint`` — the one method :mod:`core.shuffle` draws on
    (``RandomLike``) — plus ``randbits`` / ``random`` for the weighted pick.
    ``randint`` uses rejection sampling, so the Fisher–Yates reuse stays
    unbiased.  Stateless apart from its stream position; two instances with
    the same seed produce the same byte stream in any process.
    """

    _MASK64 = 0xFFFFFFFFFFFFFFFF

    def __init__(self, seed: int) -> None:
        self._prefix = struct.pack(">Q", seed & self._MASK64)
        self._counter = 0
        self._buffer = bytearray()

    def _take(self, n: int) -> bytes:
        while len(self._buffer) < n:
            block = hashlib.sha256(
                self._prefix + struct.pack(">Q", self._counter)
            ).digest()
            self._counter += 1
            self._buffer.extend(block)
        out = bytes(self._buffer[:n])
        del self._buffer[:n]
        return out

    def randbits(self, k: int) -> int:
        """A uniform ``k``-bit integer."""
        if k <= 0:
            raise ValueError("k must be positive")
        nbytes = (k + 7) // 8
        return int.from_bytes(self._take(nbytes), "big") >> (nbytes * 8 - k)

    def randint(self, a: int, b: int) -> int:
        """Uniform integer in ``[a, b]`` — inclusive, like ``random.Random``."""
        if b < a:
            raise ValueError(f"empty range [{a}, {b}]")
        span = b - a + 1
        k = span.bit_length()
        while True:  # rejection sampling keeps the shuffle unbiased
            r = self.randbits(k)
            if r < span:
                return a + r

    def random(self) -> float:
        """A float in ``[0, 1)`` with 53 bits of precision (weighted draw)."""
        return self.randbits(53) / (1 << 53)


def draw_seed(master_seed: int, seq: int, *, label: str = "select") -> int:
    """Stable per-draw seed: first 8 bytes of SHA-256 over ``label:seed:seq``.

    Contract §select_next / P3: never Python's ``hash()`` (process-random),
    hashlib only.  Decimal-string encoding keeps arbitrary-size Python ints
    unambiguous; ``label`` domain-separates the plan stream from the
    per-draw stream so :func:`plan_cycle` and :func:`select_next` cannot
    collide on the same master seed.
    """
    payload = f"{label}:{master_seed}:{seq}".encode("ascii")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big")


# ---------------------------------------------------------------------------
# Data types (contract §Datentypen — frozen dataclasses)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RuleConflict:
    """One rule problem, with a machine-usable correction where one exists.

    ``code`` values: ``invalid_value`` (a field outside its domain),
    ``min_gap_unsatisfiable`` / ``quota_zero_limited`` / ``empty_candidates``
    (the RUN-05 pre-flight conflicts).  ``suggestion`` carries the concrete
    correction — e.g. the maximum satisfiable ``min_gap`` (ADR-003 F6:
    "Bei 8 Titeln sind höchstens 7 Abstand möglich").
    """

    code: str
    field: str
    message: str
    suggestion: Optional[Any] = None


@dataclass(frozen=True)
class Rules:
    """Playlist-neutral rules — mirrors the rule columns of ``run_configs``
    (Blueprint §2.2); track-bound facts (favourite, weight, exclusion) live on
    :class:`Candidate`, never here (ADR-003 F7).

    :meth:`from_json` / :meth:`to_json` are the loading contract for
    ``run_config_versions.rules_json``: exactly the keys of
    ``app.migrations.LEGACY_PRESET_RULES``, canonical JSON (sorted keys,
    compact separators), so ``Rules().to_json()`` equals
    ``app.migrations.legacy_rules_json()`` byte for byte and
    :meth:`rules_hash` reproduces ``run_config_versions.rules_hash``.
    """

    repeat_mode: str = "no_repeat"
    min_gap: int = 0
    repeat_quota_pct: int = 0
    favorite_weight: float = 1.0
    skip_policy: str = "consume"
    manual_use_policy: str = "auto_resume"
    manual_wait_seconds: int = 900
    new_tracks_policy: str = "ignore"
    duplicate_policy: str = "collapse"
    unplayable_policy: str = "exclude"
    played_threshold: str = "on_track_end"
    played_threshold_seconds: int = 30
    execution_strategy: str = "uris_window"

    _INT_FIELDS = ("min_gap", "repeat_quota_pct", "manual_wait_seconds",
                   "played_threshold_seconds")
    _FLOAT_FIELDS = ("favorite_weight",)

    # -- (de)serialisation ---------------------------------------------------

    @classmethod
    def field_names(cls) -> Tuple[str, ...]:
        return tuple(f.name for f in dataclasses.fields(cls))

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Rules:
        """Build Rules from a mapping with exactly the ``rules_json`` keys.

        Unknown keys raise (schema drift must be loud); missing keys fall
        back to the column defaults.  Types are checked strictly — ``bool``
        is rejected for the int fields, numbers for the str fields.  Value
        *domains* are NOT checked here; that is :meth:`validate`'s job.
        """
        known = set(cls.field_names())
        unknown = sorted(set(data) - known)
        if unknown:
            raise ValueError(f"unbekannte Regel-Schlüssel: {unknown}")
        kwargs: Dict[str, Any] = {}
        for name in cls.field_names():
            if name not in data:
                continue
            value = data[name]
            if name in cls._INT_FIELDS:
                if isinstance(value, bool) or not isinstance(value, int):
                    raise ValueError(f"{name} muss eine ganze Zahl sein, nicht {value!r}")
            elif name in cls._FLOAT_FIELDS:
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise ValueError(f"{name} muss eine Zahl sein, nicht {value!r}")
                value = float(value)
            elif not isinstance(value, str):
                raise ValueError(f"{name} muss ein String sein, nicht {value!r}")
            kwargs[name] = value
        return cls(**kwargs)

    @classmethod
    def from_json(cls, text: str) -> Rules:
        """Load from a ``run_config_versions.rules_json`` document."""
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("rules_json muss ein JSON-Objekt sein")
        return cls.from_dict(data)

    def to_dict(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)

    def to_json(self) -> str:
        """Canonical JSON — same convention as ``app.migrations.legacy_rules_json``."""
        return json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"))

    def rules_hash(self) -> str:
        """sha256 over the canonical JSON — the reproducibility hash."""
        return hashlib.sha256(self.to_json().encode("utf-8")).hexdigest()

    # -- validation ----------------------------------------------------------

    def validate(self) -> List[RuleConflict]:
        """Per-field domain validation.  Empty list = every value in domain.

        Cross-field and candidate-dependent conflicts (quota 0 with
        limited_repeat, unsatisfiable min_gap, empty candidate set) are
        reported by :func:`preflight` — they are start-time conflicts, not
        invalid values.
        """
        conflicts: List[RuleConflict] = []

        def bad(field: str, value: Any, expected: str) -> None:
            conflicts.append(RuleConflict(
                "invalid_value", field,
                f"Ungültiger Wert für {field}: {value!r} (erwartet: {expected}).",
            ))

        domains = (
            ("repeat_mode", REPEAT_MODES),
            ("skip_policy", SKIP_POLICIES),
            ("manual_use_policy", MANUAL_USE_POLICIES),
            ("new_tracks_policy", NEW_TRACKS_POLICIES),
            ("duplicate_policy", DUPLICATE_POLICIES),
            ("unplayable_policy", UNPLAYABLE_POLICIES),
            ("played_threshold", PLAYED_THRESHOLDS),
            ("execution_strategy", EXECUTION_STRATEGIES),
        )
        for field, allowed in domains:
            value = getattr(self, field)
            if value not in allowed:
                bad(field, value, " | ".join(allowed))
        if self.min_gap < 0:
            bad("min_gap", self.min_gap, ">= 0")
        if not 0 <= self.repeat_quota_pct <= 100:
            bad("repeat_quota_pct", self.repeat_quota_pct, "0..100")
        if self.favorite_weight < 1.0:
            bad("favorite_weight", self.favorite_weight, ">= 1.0")
        if self.manual_wait_seconds < 0:
            bad("manual_wait_seconds", self.manual_wait_seconds, ">= 0")
        if self.played_threshold_seconds < 0:
            bad("played_threshold_seconds", self.played_threshold_seconds, ">= 0")
        return conflicts


@dataclass(frozen=True)
class Candidate:
    """One selectable card, materialised from a ``run_tracks`` row (§2.3).

    ``excluded`` / ``admitted`` exist only for the defensive P5 check and for
    :func:`preflight`'s admitted count: rows with ``excluded=True`` or
    ``admitted=False`` must never be passed to :func:`select_next` /
    :func:`plan_cycle` — the caller (SQL) pre-filters, the engine raises.
    """

    run_track_id: int
    track_key: str
    state: str = "open"
    play_count: int = 0
    last_played_seq: Optional[int] = None
    favorite: bool = False
    weight: float = 1.0
    admitted: bool = True
    excluded: bool = False

    def __post_init__(self) -> None:
        if self.state not in CANDIDATE_STATES:
            raise ValueError(
                f"unbekannter Kandidaten-Zustand {self.state!r} "
                f"(erlaubt: {', '.join(CANDIDATE_STATES)})"
            )
        if self.state == "played" and self.last_played_seq is None:
            raise ValueError(
                f"{self.track_key}: state='played' verlangt last_played_seq "
                "(P2 wäre sonst unprüfbar)"
            )
        if self.play_count < 0:
            raise ValueError(f"{self.track_key}: play_count muss >= 0 sein")
        if self.weight <= 0:
            raise ValueError(
                f"{self.track_key}: weight muss > 0 sein — Gewicht 0 wäre ein "
                "stiller Ausschluss und verletzte P5"
            )


@dataclass(frozen=True)
class Selection:
    """The result of one draw — persisted as a ``run_selections`` row.

    ``filtered_by`` documents every exclusion of this draw (only non-zero
    counters are recorded).  Keys:

    * ``gap`` — played candidates blocked by the *effective* (possibly
      relaxed) min-gap check,
    * ``quota_blocked`` — played candidates blocked by the repeat quota (P7),
    * ``deferred`` — deferred candidates held back while other candidates
      exist (P6),
    * ``played`` — played candidates that are structurally out because
      ``repeat_mode='no_repeat'``,
    * ``gap_relaxed_from`` / ``gap_relaxed_to`` — the F6 relaxation ladder,
      recorded whenever it fired (P2: never silent).

    ``exhausted=True`` ⇔ no rule-conformant candidate exists and no
    relaxation is admissible (P8) — cycle end / completion.
    """

    run_track_id: Optional[int]
    seq: int
    seed_used: int
    candidate_count: int
    filtered_by: Dict[str, int]
    exhausted: bool = False


@dataclass(frozen=True)
class SkipOutcome:
    """New card state + requeue instruction, returned by :func:`apply_skip`.

    ``consumed`` says whether the card is used up for this cycle.
    ``requeue_after_draws`` (requeue_later) tells the caller to flip the card
    back to ``open`` once that many draws have passed;
    ``requeue_at_cycle_end`` (defer_to_end) leaves it deferred — the engine
    plays deferred cards by itself once no open card remains (P6).
    """

    new_state: str
    consumed: bool
    requeue_after_draws: Optional[int] = None
    requeue_at_cycle_end: bool = False


# ---------------------------------------------------------------------------
# Defensive checks (shared by plan_cycle / select_next)
# ---------------------------------------------------------------------------

def _require_candidates(candidates: Sequence[Candidate]) -> None:
    """P5, defensively: excluded / not-admitted entries are NOT candidates.

    The caller (SQL: ``state IN ('open','played','deferred') AND admitted=1``)
    filters; the engine re-checks and refuses instead of silently dropping —
    a silent drop here would hide a broken pre-filter.  Duplicate
    ``run_track_id`` values are refused for the same reason (P1 would break).
    """
    seen: set[int] = set()
    for c in candidates:
        if c.excluded or not c.admitted:
            raise ValueError(
                f"{c.track_key}: ausgeschlossene/nicht zugelassene Titel sind "
                "keine Kandidaten (P5) — Aufrufer muss vorfiltern"
            )
        if c.run_track_id in seen:
            raise ValueError(f"run_track_id {c.run_track_id} ist doppelt")
        seen.add(c.run_track_id)


def _require_valid_rules(rules: Rules) -> None:
    conflicts = rules.validate()
    if conflicts:
        raise ValueError("ungültige Regeln: " + "; ".join(c.message for c in conflicts))


def _effective_weight(candidate: Candidate, rules: Rules) -> float:
    """P4: ``weight × favorite_weight`` for favourites, plain weight otherwise."""
    if candidate.favorite:
        return candidate.weight * rules.favorite_weight
    return candidate.weight


def _weighted_pick(pool: Sequence[Candidate], rules: Rules, rng: HashPRNG) -> Candidate:
    """Weighted draw over the pool, independent of the caller's ordering (P3)."""
    ordered = sorted(pool, key=lambda c: c.run_track_id)
    weights = [_effective_weight(c, rules) for c in ordered]
    threshold = rng.random() * sum(weights)
    acc = 0.0
    for candidate, weight in zip(ordered, weights, strict=True):
        acc += weight
        if threshold < acc:
            return candidate
    return ordered[-1]  # float-edge fallback: threshold == sum(weights)


# ---------------------------------------------------------------------------
# select_next (contract §Funktionen 2)
# ---------------------------------------------------------------------------

def select_next(
    candidates: Sequence[Candidate],
    rules: Rules,
    seed: int,
    seq: int,
    *,
    recent_repeat_share: float = 0.0,
) -> Selection:
    """Pick the card for draw ``seq``.  Same input ⇒ same Selection (P3).

    The draw seed is ``draw_seed(seed, seq)`` — hashlib, never ``hash()``.

    Pipeline (contract §Funktionen 2):

    1. **Hard filters.**  ``state='open'`` cards are always eligible.  With
       ``limited_repeat`` / ``free_repeat``, played cards join the pool when
       ``seq - last_played_seq > min_gap`` (P2, strict) AND the quota allows
       another repeat.  The quota check is strict (< not ≤): the caller
       passes the repeat share of the last :data:`QUOTA_WINDOW` draws, and
       only a share strictly below ``repeat_quota_pct`` guarantees the
       ceiling still holds after this draw (P7).  ``free_repeat`` ignores
       the quota.  Deferred cards are counted, not pooled (P6).
    2. **Deferred endgame** (P6): when step 1 leaves nothing, deferred cards
       become the pool — defer_to_end plays them after the open cards are
       through; a requeue_later card the caller has not re-opened yet is
       played out here rather than lost.
    3. **Relaxation ladder, min_gap ONLY** (ADR-003 F6, P2): when nothing is
       left AND repeats are allowed AND the quota permits, ``min_gap`` drops
       to the largest satisfiable ``k`` (the maximum observed distance minus
       one, never below 0) and the draw is taken from the cards at maximum
       distance.  Always recorded as ``gap_relaxed_from`` / ``gap_relaxed_to``
       — never a silent rule violation.  User exclusions are never relaxed
       (they are not candidates, P5); the quota is never relaxed.
    4. **Weighted draw** over the pool with the draw seed
       (``weight × favorite_weight`` for favourites, P4).
    5. **Exhaustion** (P8): ``exhausted=True`` exactly when steps 1–3 leave
       no admissible candidate — under ``no_repeat`` that means no open and
       no deferred admitted card remains.

    ``recent_repeat_share`` keeps the function pure: the caller supplies the
    repeat share of its last :data:`QUOTA_WINDOW` draws as a float in
    ``[0, 1]`` (contract: repeat_count_window as a parameter).
    """
    _require_candidates(candidates)
    _require_valid_rules(rules)
    if not 0.0 <= recent_repeat_share <= 1.0:
        raise ValueError(
            f"recent_repeat_share muss in [0, 1] liegen, nicht {recent_repeat_share!r}"
        )

    seed_used = draw_seed(seed, seq)
    filtered: Dict[str, int] = {}

    open_pool = [c for c in candidates if c.state == "open"]
    deferred_pool = [c for c in candidates if c.state == "deferred"]
    played_pool = [c for c in candidates if c.state == "played"]

    allow_repeats = rules.repeat_mode in ("limited_repeat", "free_repeat")
    quota_ok = True
    if rules.repeat_mode == "limited_repeat":
        quota_ok = recent_repeat_share * 100.0 < rules.repeat_quota_pct

    pool: List[Candidate] = list(open_pool)
    if allow_repeats:
        gap_failed = quota_blocked = 0
        for c in played_pool:
            # last_played_seq is never None for state='played' (Candidate invariant)
            distance = seq - int(c.last_played_seq)  # type: ignore[arg-type]
            if distance <= rules.min_gap:
                gap_failed += 1  # P2: strict ">" — distance == min_gap is a violation
            elif not quota_ok:
                quota_blocked += 1
            else:
                pool.append(c)
        if gap_failed:
            filtered["gap"] = gap_failed
        if quota_blocked:
            filtered["quota_blocked"] = quota_blocked
    elif played_pool:
        filtered["played"] = len(played_pool)  # no_repeat: structurally out

    if pool:
        if deferred_pool:
            filtered["deferred"] = len(deferred_pool)
    elif deferred_pool:
        # Step 2 — deferred endgame (P6).
        pool = list(deferred_pool)
    elif allow_repeats and played_pool and quota_ok:
        # Step 3 — F6 relaxation ladder, min_gap only, always recorded.
        max_distance = max(
            seq - int(c.last_played_seq)  # type: ignore[arg-type]
            for c in played_pool
        )
        if max_distance >= 1:  # a repeat needs at least one draw of distance
            relaxed = max_distance - 1
            pool = [
                c for c in played_pool
                if seq - int(c.last_played_seq) > relaxed  # type: ignore[arg-type]
            ]
            still_blocked = len(played_pool) - len(pool)
            if still_blocked:
                filtered["gap"] = still_blocked
            else:
                filtered.pop("gap", None)
            filtered["gap_relaxed_from"] = rules.min_gap
            filtered["gap_relaxed_to"] = relaxed

    if not pool:
        # P8: nothing rule-conformant and no admissible relaxation.
        return Selection(
            run_track_id=None,
            seq=seq,
            seed_used=seed_used,
            candidate_count=len(candidates),
            filtered_by=filtered,
            exhausted=True,
        )

    chosen = _weighted_pick(pool, rules, HashPRNG(seed_used))
    return Selection(
        run_track_id=chosen.run_track_id,
        seq=seq,
        seed_used=seed_used,
        candidate_count=len(candidates),
        filtered_by=filtered,
        exhausted=False,
    )


# ---------------------------------------------------------------------------
# plan_cycle (contract §Funktionen 1)
# ---------------------------------------------------------------------------

def plan_cycle(
    candidates: Sequence[Candidate],
    rules: Rules,
    seed: int,
    *,
    previous_order: Optional[Sequence[int]] = None,
) -> List[int]:
    """Plan a cycle; returns ``run_track_id`` values in play order.

    ``no_repeat`` (P1): one full Fisher–Yates permutation of the **open**
    candidates via :func:`core.shuffle.shuffle_with_guard` — the existing
    similarity guard re-shuffles when the plan would open too much like
    ``previous_order`` (the previous cycle's order, as run_track_ids).
    Deferred candidates follow after the open block, shuffled among
    themselves (P6: defer_to_end plays them once the open cards are
    through).  Already-played candidates of the current cycle are not
    planned again (P1: every admitted open title exactly once).

    ``limited_repeat`` / ``free_repeat``: a rolling horizon of length
    ``min(PLAN_HORIZON, n)`` built by repeated :func:`select_next` draws
    against a local simulation (seq starts at 1).  P2/P7 hold inside the
    plan because every draw enforces them; the repeat share is tracked over
    a :data:`QUOTA_WINDOW`-sized window whose empty slots count as
    non-repeats.  ``previous_order`` is ignored here — a rolling horizon
    has no cycle opening to guard.

    Determinism (P3): the permutation stream is domain-separated from the
    per-draw stream (``draw_seed(seed, 0, label="plan")``), and candidates
    are canonically sorted first, so the caller's ordering cannot change
    the plan.
    """
    _require_candidates(candidates)
    _require_valid_rules(rules)

    if rules.repeat_mode == "no_repeat":
        rng = HashPRNG(draw_seed(seed, 0, label="plan"))
        opens = sorted(c.run_track_id for c in candidates if c.state == "open")
        deferred = sorted(c.run_track_id for c in candidates if c.state == "deferred")
        order = shuffle_with_guard(opens, previous_order=previous_order, rng=rng)
        if deferred:
            order += fisher_yates_shuffle(list(deferred), rng=rng)
        return order

    by_id: Dict[int, Candidate] = {c.run_track_id: c for c in candidates}
    horizon = min(PLAN_HORIZON, len(by_id))
    repeat_window: List[int] = []
    plan: List[int] = []
    for step in range(horizon):
        seq = step + 1
        share = sum(repeat_window[-QUOTA_WINDOW:]) / float(QUOTA_WINDOW)
        selection = select_next(
            list(by_id.values()), rules, seed, seq, recent_repeat_share=share
        )
        if selection.exhausted or selection.run_track_id is None:
            break
        chosen = by_id[selection.run_track_id]
        # A repeat is a draw of a card already played in this cycle — state,
        # not play_count: play_count is cumulative across cycles (ADR-003 F2).
        repeat_window.append(1 if chosen.state == "played" else 0)
        by_id[chosen.run_track_id] = replace(
            chosen,
            state="played",
            play_count=chosen.play_count + 1,
            last_played_seq=seq,
        )
        plan.append(chosen.run_track_id)
    return plan


# ---------------------------------------------------------------------------
# apply_skip (contract §Funktionen 3)
# ---------------------------------------------------------------------------

def apply_skip(state: str, skip_policy: str) -> SkipOutcome:
    """Map a user skip onto the card state (P6; ADR-003 F4: a user skip
    counts per skip policy, never twice).

    * ``consume`` → ``played``: the card is used up for this cycle.
    * ``keep_open`` → stays ``open``, NOT consumed — the cursor still moves
      on in the plan, the title remains in the pool.
    * ``requeue_later`` → ``deferred`` with a resubmission instruction: the
      caller re-opens the card after at least :data:`REQUEUE_AFTER_DRAWS`
      draws (P6: requeue_later titles reappear).
    * ``defer_to_end`` → ``deferred`` until every open card is through — no
      resubmission needed, :func:`select_next` plays deferred cards itself
      once the open pool is empty (P6: defer_to_end order).

    Pure state mapping: ``last_played_seq`` / ``play_count`` bookkeeping is
    the service layer's job (it knows the ledger seq of the skip).
    """
    if state not in CANDIDATE_STATES:
        raise ValueError(
            f"unbekannter Kandidaten-Zustand {state!r} "
            f"(erlaubt: {', '.join(CANDIDATE_STATES)})"
        )
    if skip_policy not in SKIP_POLICIES:
        raise ValueError(
            f"unbekannte Skip-Policy {skip_policy!r} "
            f"(erlaubt: {', '.join(SKIP_POLICIES)})"
        )
    if skip_policy == "consume":
        return SkipOutcome(new_state="played", consumed=True)
    if skip_policy == "keep_open":
        return SkipOutcome(new_state="open", consumed=False)
    if skip_policy == "requeue_later":
        return SkipOutcome(
            new_state="deferred",
            consumed=False,
            requeue_after_draws=REQUEUE_AFTER_DRAWS,
        )
    return SkipOutcome(new_state="deferred", consumed=False, requeue_at_cycle_end=True)


# ---------------------------------------------------------------------------
# preflight (contract §Funktionen 4, RUN-05)
# ---------------------------------------------------------------------------

def preflight(candidates: Sequence[Candidate], rules: Rules) -> List[RuleConflict]:
    """RUN-05 pre-start check: conflicts with corrections, before the run.

    Unlike the selection functions, preflight accepts the UNFILTERED
    candidate set — excluded / not-admitted rows included — because its job
    is to predict what the engine will actually see: ``admitted_count`` is
    the number of admitted, not-excluded candidates.

    Conflicts (each on top of :meth:`Rules.validate`):

    * ``empty_candidates`` — nothing admitted, nothing to select.
    * ``min_gap_unsatisfiable`` — ``min_gap >= admitted_count``; the
      suggestion is the maximum satisfiable ``k = admitted_count - 1``
      (ADR-003 F6: pre-flight error with a concrete correction instead of a
      runtime relaxation surprise).
    * ``quota_zero_limited`` — ``repeat_quota_pct == 0`` with
      ``repeat_mode='limited_repeat'`` never allows a repeat; either raise
      the quota or use ``no_repeat``.
    """
    conflicts = rules.validate()
    admitted = [c for c in candidates if c.admitted and not c.excluded]
    if not admitted:
        conflicts.append(RuleConflict(
            "empty_candidates", "",
            "Keine spielbaren Titel: Es gibt nichts auszuwählen.",
        ))
    if admitted and rules.min_gap >= len(admitted):
        k = len(admitted) - 1
        conflicts.append(RuleConflict(
            "min_gap_unsatisfiable", "min_gap",
            f"Bei {len(admitted)} Titeln sind höchstens {k} Titel Abstand möglich.",
            suggestion=k,
        ))
    if rules.repeat_mode == "limited_repeat" and rules.repeat_quota_pct == 0:
        conflicts.append(RuleConflict(
            "quota_zero_limited", "repeat_quota_pct",
            "repeat_quota_pct=0 zusammen mit repeat_mode='limited_repeat' erlaubt "
            "nie eine Wiederholung — Quote erhöhen oder repeat_mode='no_repeat' "
            "wählen.",
        ))
    return conflicts


__all__ = [
    "CANDIDATE_STATES",
    "DUPLICATE_POLICIES",
    "EXECUTION_STRATEGIES",
    "MANUAL_USE_POLICIES",
    "NEW_TRACKS_POLICIES",
    "PLAN_HORIZON",
    "PLAYED_THRESHOLDS",
    "QUOTA_WINDOW",
    "REPEAT_MODES",
    "REQUEUE_AFTER_DRAWS",
    "SKIP_POLICIES",
    "UNPLAYABLE_POLICIES",
    "Candidate",
    "HashPRNG",
    "RuleConflict",
    "Rules",
    "Selection",
    "SkipOutcome",
    "apply_skip",
    "draw_seed",
    "plan_cycle",
    "preflight",
    "select_next",
]
