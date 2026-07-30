"""Tests for the core shuffle engine — pure logic, no I/O."""

from __future__ import annotations

import random
from collections import Counter

from core.models import SkipReason, TrackKind
from core.shuffle import (
    _first_n_similarity,
    dedup_by_uri,
    dedup_tracks,
    filter_valid_tracks,
    fisher_yates_shuffle,
    prepare_shuffled_run,
    shuffle_with_guard,
)

# ---------------------------------------------------------------------------
# Filtering
# ---------------------------------------------------------------------------

def test_playable_tracks_survive(track_factory):
    tracks = [track_factory(f"t{i}") for i in range(5)]
    valid, skipped = filter_valid_tracks(tracks)
    assert len(valid) == 5
    assert skipped == []


def test_local_files_are_reported_not_dropped(track_factory):
    tracks = [track_factory("a"), track_factory("b", is_local=True)]
    valid, skipped = filter_valid_tracks(tracks)
    assert [t.id for t in valid] == ["a"]
    assert skipped[0].reason is SkipReason.LOCAL_FILE
    assert skipped[0].track.id == "b"


def test_episodes_are_excluded(track_factory):
    tracks = [track_factory("a"), track_factory("pod", kind=TrackKind.EPISODE)]
    valid, skipped = filter_valid_tracks(tracks)
    assert [t.id for t in valid] == ["a"]
    assert skipped[0].reason is SkipReason.WRONG_KIND


def test_unplayable_tracks_are_excluded(track_factory):
    valid, skipped = filter_valid_tracks(
        [track_factory("a"), track_factory("b", is_playable=False)]
    )
    assert [t.id for t in valid] == ["a"]
    assert skipped[0].reason is SkipReason.NOT_PLAYABLE


def test_entry_without_an_id_is_excluded(track_factory):
    valid, skipped = filter_valid_tracks([track_factory("")])
    assert valid == []
    assert skipped[0].reason is SkipReason.MISSING_ID


def test_youtube_videos_count_as_playable(track_factory):
    valid, _ = filter_valid_tracks([track_factory("vid", kind=TrackKind.VIDEO)])
    assert len(valid) == 1


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def test_duplicate_entries_yield_one_card(track_factory):
    tracks = [track_factory("a"), track_factory("b"), track_factory("a")]
    kept, dupes = dedup_tracks(tracks)
    assert [t.id for t in kept] == ["a", "b"]
    assert len(dupes) == 1
    assert dupes[0].reason is SkipReason.DUPLICATE


def test_dedup_keeps_first_occurrence(track_factory):
    tracks = [track_factory("a", name="first"), track_factory("a", name="second")]
    assert dedup_by_uri(tracks)[0].name == "first"


def test_same_id_on_different_providers_is_not_a_duplicate(track_factory):
    tracks = [track_factory("x", provider="spotify"), track_factory("x", provider="apple")]
    kept, dupes = dedup_tracks(tracks)
    assert len(kept) == 2
    assert dupes == []


# ---------------------------------------------------------------------------
# Fisher–Yates
# ---------------------------------------------------------------------------

def test_shuffle_is_a_permutation():
    items = [f"t{i}" for i in range(50)]
    shuffled = fisher_yates_shuffle(list(items), rng=random.Random(7))
    assert sorted(shuffled) == sorted(items)


def test_shuffle_is_deterministic_for_a_seed():
    items = [f"t{i}" for i in range(30)]
    a = fisher_yates_shuffle(list(items), rng=random.Random(99))
    b = fisher_yates_shuffle(list(items), rng=random.Random(99))
    assert a == b


def test_shuffle_of_empty_and_single_lists():
    assert fisher_yates_shuffle([]) == []
    assert fisher_yates_shuffle(["only"]) == ["only"]


def test_shuffle_is_unbiased_over_many_runs():
    """Every element should land in every position roughly equally often.

    A naive ``for i: swap(i, random(0, n-1))`` shuffle fails this; Fisher–Yates
    passes it.  The tolerance is loose enough not to flake.
    """
    items = ["a", "b", "c", "d"]
    trials = 6000
    rng = random.Random(2026)
    positions = {item: Counter() for item in items}
    for _ in range(trials):
        for index, item in enumerate(fisher_yates_shuffle(list(items), rng=rng)):
            positions[item][index] += 1

    expected = trials / len(items)
    for counter in positions.values():
        for index in range(len(items)):
            assert abs(counter[index] - expected) < expected * 0.15


# ---------------------------------------------------------------------------
# Similarity guard
# ---------------------------------------------------------------------------

def test_similarity_of_identical_prefixes_is_one():
    order = [f"t{i}" for i in range(10)]
    assert _first_n_similarity(order, order, 10) == 1.0


def test_similarity_is_zero_for_short_lists():
    assert _first_n_similarity(["a"], ["a"], 10) == 0.0


def test_guard_avoids_repeating_the_previous_opening():
    ids = [f"t{i}" for i in range(40)]
    previous = list(ids)
    order = shuffle_with_guard(ids, previous_order=previous, rng=random.Random(5))
    assert _first_n_similarity(order, previous, 10) <= 0.5


def test_guard_does_not_mutate_its_input():
    ids = [f"t{i}" for i in range(20)]
    original = list(ids)
    shuffle_with_guard(ids, rng=random.Random(1))
    assert ids == original


# ---------------------------------------------------------------------------
# Full pipeline
# ---------------------------------------------------------------------------

def test_pipeline_filters_dedups_and_shuffles(track_factory):
    tracks = [
        track_factory("a"),
        track_factory("b"),
        track_factory("a"),                        # duplicate
        track_factory("c", is_local=True),         # local file
        track_factory("d", is_playable=False),     # unavailable
        track_factory("e"),
    ]
    order, skipped, seed = prepare_shuffled_run(tracks, seed=42)

    assert sorted(order) == ["a", "b", "e"]
    assert seed == 42
    assert {s.reason for s in skipped} == {
        SkipReason.DUPLICATE, SkipReason.LOCAL_FILE, SkipReason.NOT_PLAYABLE
    }


def test_pipeline_is_reproducible_from_its_seed(track_factory):
    tracks = [track_factory(f"t{i}") for i in range(25)]
    first, _, seed = prepare_shuffled_run(tracks)
    second, _, _ = prepare_shuffled_run(tracks, seed=seed)
    assert first == second


def test_every_playable_track_appears_exactly_once(track_factory):
    tracks = [track_factory(f"t{i}") for i in range(200)]
    order, _, _ = prepare_shuffled_run(tracks)
    assert len(order) == len(set(order)) == 200
