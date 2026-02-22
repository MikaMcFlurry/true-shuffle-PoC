"""Shuffle engine — pure business logic, no I/O.

Provides:
- Fisher–Yates shuffle (unbiased)
- Deduplication by URI
- Similarity guard (retries if new order is too similar to previous)
- Track filtering (skip unavailable / local / episodes)
"""

from __future__ import annotations

import random
from typing import List, Optional, Sequence, Set, Tuple

from core.models import Track


# ---------------------------------------------------------------------------
# Filtering
# ---------------------------------------------------------------------------

def filter_valid_tracks(tracks: Sequence[Track]) -> Tuple[List[Track], List[Track]]:
    """Split tracks into (valid, skipped).

    Valid = playable, not local, is a track (not episode), has a spotify URI.
    """
    valid: List[Track] = []
    skipped: List[Track] = []
    for t in tracks:
        if t.is_valid:
            valid.append(t)
        else:
            skipped.append(t)
    return valid, skipped


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def dedup_by_uri(tracks: Sequence[Track]) -> List[Track]:
    """Remove duplicate tracks (same URI), keeping first occurrence."""
    seen: Set[str] = set()
    result: List[Track] = []
    for t in tracks:
        if t.uri not in seen:
            seen.add(t.uri)
            result.append(t)
    return result


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
        List of URIs to shuffle.  Will be **mutated** in place.
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
    matches = sum(1 for x, y in zip(a[:n], b[:n]) if x == y)
    return matches / n


def shuffle_with_guard(
    uris: List[str],
    *,
    previous_order: Optional[List[str]] = None,
    similarity_threshold: float = 0.5,
    similarity_window: int = 10,
    max_retries: int = 5,
    rng: Optional[random.Random] = None,
) -> List[str]:
    """Shuffle URIs with optional similarity guard.

    If *previous_order* is provided, re-shuffles up to *max_retries* times
    if the first *similarity_window* elements match more than
    *similarity_threshold* fraction of positions.

    Returns a **new** list (does not mutate input).
    """
    for attempt in range(max_retries + 1):
        candidate = list(uris)  # copy
        fisher_yates_shuffle(candidate, rng=rng)

        if previous_order is None:
            return candidate

        sim = _first_n_similarity(candidate, previous_order, similarity_window)
        if sim <= similarity_threshold:
            return candidate
        # else retry

    # Exhausted retries — return last candidate anyway
    return candidate  # type: ignore[possibly-undefined]


# ---------------------------------------------------------------------------
# High-level entry point
# ---------------------------------------------------------------------------

def prepare_shuffled_run(
    tracks: Sequence[Track],
    *,
    previous_order: Optional[List[str]] = None,
    rng: Optional[random.Random] = None,
) -> Tuple[List[str], List[Track]]:
    """Full pipeline: filter → dedup → shuffle (with guard).

    Returns
    -------
    (shuffled_uris, skipped_tracks)
    """
    valid, skipped = filter_valid_tracks(tracks)
    deduped = dedup_by_uri(valid)
    uris = [t.uri for t in deduped]

    shuffled = shuffle_with_guard(uris, previous_order=previous_order, rng=rng)
    return shuffled, skipped
