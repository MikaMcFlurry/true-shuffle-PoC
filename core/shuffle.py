"""Shuffle engine — pure business logic, no I/O, no provider knowledge.

Provides:
- Fisher–Yates shuffle (unbiased)
- Filtering of entries that can never be played
- Deduplication by track identity
- Similarity guard (re-shuffles if a new run starts too much like the last one)
"""

from __future__ import annotations

import random
import secrets
from typing import List, Optional, Sequence, Set, Tuple

from core.models import SkippedEntry, SkipReason, Track

# ---------------------------------------------------------------------------
# Filtering
# ---------------------------------------------------------------------------

def filter_valid_tracks(
    tracks: Sequence[Track],
) -> Tuple[List[Track], List[SkippedEntry]]:
    """Split tracks into ``(valid, skipped)``.

    Valid = playable, not a local file, a real track/video, and carrying a
    provider id.  Everything else is reported with the reason it was dropped —
    this is what makes the "every playable unique track" claim honest.
    """
    valid: List[Track] = []
    skipped: List[SkippedEntry] = []
    for t in tracks:
        reason = t.invalid_reason()
        if reason is None:
            valid.append(t)
        else:
            skipped.append(SkippedEntry(track=t, reason=reason))
    return valid, skipped


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def dedup_tracks(
    tracks: Sequence[Track],
) -> Tuple[List[Track], List[SkippedEntry]]:
    """Remove repeated entries of the same track, keeping the first occurrence.

    A playlist that lists the same song three times still yields exactly one
    card in the deck.
    """
    seen: Set[str] = set()
    result: List[Track] = []
    dupes: List[SkippedEntry] = []
    for t in tracks:
        if t.key in seen:
            dupes.append(SkippedEntry(track=t, reason=SkipReason.DUPLICATE))
            continue
        seen.add(t.key)
        result.append(t)
    return result, dupes


def dedup_by_uri(tracks: Sequence[Track]) -> List[Track]:
    """Backwards-compatible helper: dedup and return only the kept tracks."""
    kept, _ = dedup_tracks(tracks)
    return kept


# ---------------------------------------------------------------------------
# Fisher–Yates Shuffle
# ---------------------------------------------------------------------------

def fisher_yates_shuffle(
    items: List[str],
    rng: Optional[random.Random] = None,
) -> List[str]:
    """In-place unbiased Fisher–Yates (Knuth) shuffle.

    Parameters
    ----------
    items:
        List of ids to shuffle.  Will be **mutated** in place.
    rng:
        Optional ``random.Random`` instance for deterministic testing.

    Returns
    -------
    The same list (shuffled in place) for convenience.
    """
    rng = rng or random.Random()
    n = len(items)
    for i in range(n - 1, 0, -1):
        j = rng.randint(0, i)
        items[i], items[j] = items[j], items[i]
    return items


# ---------------------------------------------------------------------------
# Similarity Guard
# ---------------------------------------------------------------------------

def _first_n_similarity(a: Sequence[str], b: Sequence[str], n: int = 10) -> float:
    """Fraction of matching positions in the first *n* elements.

    Returns 0.0 if either list has fewer than *n* elements.
    """
    if len(a) < n or len(b) < n:
        return 0.0
    matches = sum(1 for x, y in zip(a[:n], b[:n], strict=True) if x == y)
    return matches / n


def shuffle_with_guard(
    ids: List[str],
    *,
    previous_order: Optional[List[str]] = None,
    similarity_threshold: float = 0.5,
    similarity_window: int = 10,
    max_retries: int = 5,
    rng: Optional[random.Random] = None,
) -> List[str]:
    """Shuffle ids with an optional similarity guard.

    If *previous_order* is provided, re-shuffles up to *max_retries* times when
    the first *similarity_window* positions match more than
    *similarity_threshold* of the previous run — so a deliberate re-shuffle
    does not feel like the same deck again.

    Returns a **new** list (does not mutate input).
    """
    candidate = list(ids)
    for _attempt in range(max_retries + 1):
        candidate = list(ids)  # copy
        fisher_yates_shuffle(candidate, rng=rng)

        if previous_order is None:
            return candidate

        sim = _first_n_similarity(candidate, previous_order, similarity_window)
        if sim <= similarity_threshold:
            return candidate
        # else retry

    # Exhausted retries — return last candidate anyway
    return candidate


# ---------------------------------------------------------------------------
# High-level entry point
# ---------------------------------------------------------------------------

def new_seed() -> int:
    """A reproducible-but-unguessable seed recorded with every run."""
    return secrets.randbits(63)


def prepare_shuffled_run(
    tracks: Sequence[Track],
    *,
    previous_order: Optional[List[str]] = None,
    seed: Optional[int] = None,
    rng: Optional[random.Random] = None,
) -> Tuple[List[str], List[SkippedEntry], int]:
    """Full pipeline: filter → dedup → shuffle (with guard).

    Returns
    -------
    ``(order, skipped, seed)`` where *order* is a list of provider-native track
    ids, *skipped* explains every dropped entry, and *seed* is recorded on the
    run so an identical deck can be reproduced for debugging.
    """
    if seed is None:
        seed = new_seed()
    if rng is None:
        rng = random.Random(seed)

    valid, skipped = filter_valid_tracks(tracks)
    deduped, dupes = dedup_tracks(valid)
    ids = [t.id for t in deduped]

    order = shuffle_with_guard(ids, previous_order=previous_order, rng=rng)
    return order, skipped + dupes, seed
