"""Tests for the core shuffle engine — pure logic, no I/O."""

from __future__ import annotations

import random
from collections import Counter

from core.models import Track
from core.shuffle import (
    _first_n_similarity,
    dedup_by_uri,
    filter_valid_tracks,
    fisher_yates_shuffle,
    prepare_shuffled_run,
    shuffle_with_guard,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _track(uri: str, **kwargs) -> Track:
    return Track(uri=uri, name=uri, **kwargs)


# ---------------------------------------------------------------------------
# filter_valid_tracks
# ---------------------------------------------------------------------------

class TestFilterValidTracks:
    def test_filters_local(self):
        tracks = [_track("spotify:track:a"), _track("spotify:local:b", is_local=True)]
        valid, skipped = filter_valid_tracks(tracks)
        assert len(valid) == 1
        assert len(skipped) == 1
        assert skipped[0].uri == "spotify:local:b"

    def test_filters_episodes(self):
        tracks = [_track("spotify:track:a"), _track("spotify:episode:b", track_type="episode")]
        valid, skipped = filter_valid_tracks(tracks)
        assert len(valid) == 1
        assert len(skipped) == 1

    def test_filters_unplayable(self):
        tracks = [_track("spotify:track:a"), _track("spotify:track:b", is_playable=False)]
        valid, skipped = filter_valid_tracks(tracks)
        assert len(valid) == 1
        assert skipped[0].uri == "spotify:track:b"

    def test_all_valid(self):
        tracks = [_track(f"spotify:track:{i}") for i in range(5)]
        valid, skipped = filter_valid_tracks(tracks)
        assert len(valid) == 5
        assert len(skipped) == 0


# ---------------------------------------------------------------------------
# dedup_by_uri
# ---------------------------------------------------------------------------

class TestDedupByUri:
    def test_removes_duplicates(self):
        tracks = [_track("spotify:track:a"), _track("spotify:track:a"), _track("spotify:track:b")]
        result = dedup_by_uri(tracks)
        assert len(result) == 2
        assert result[0].uri == "spotify:track:a"
        assert result[1].uri == "spotify:track:b"

    def test_preserves_order_of_first_occurrence(self):
        tracks = [_track("spotify:track:c"), _track("spotify:track:a"), _track("spotify:track:c")]
        result = dedup_by_uri(tracks)
        assert [t.uri for t in result] == ["spotify:track:c", "spotify:track:a"]

    def test_no_duplicates(self):
        tracks = [_track(f"spotify:track:{i}") for i in range(3)]
        result = dedup_by_uri(tracks)
        assert len(result) == 3


# ---------------------------------------------------------------------------
# fisher_yates_shuffle
# ---------------------------------------------------------------------------

class TestFisherYatesShuffle:
    def test_shuffles_in_place(self):
        items = list("abcde")
        result = fisher_yates_shuffle(items, rng=random.Random(42))
        assert result is items  # same object

    def test_deterministic_with_seed(self):
        a = fisher_yates_shuffle(list("abcdefgh"), rng=random.Random(123))
        b = fisher_yates_shuffle(list("abcdefgh"), rng=random.Random(123))
        assert a == b

    def test_contains_same_elements(self):
        items = list(range(100))
        original = list(items)
        fisher_yates_shuffle(items, rng=random.Random(99))
        assert sorted(items) == sorted(original)

    def test_distribution_is_uniform(self):
        """Run many shuffles and check each element appears in each
        position roughly equally (chi-square-like sanity check)."""
        n = 4
        runs = 10_000
        position_counts: list[Counter] = [Counter() for _ in range(n)]

        for _ in range(runs):
            items = list(range(n))
            fisher_yates_shuffle(items)
            for pos, val in enumerate(items):
                position_counts[pos][val] += 1

        expected = runs / n
        for pos in range(n):
            for val in range(n):
                count = position_counts[pos][val]
                # Allow 20% deviation — generous for 10k samples
                assert abs(count - expected) / expected < 0.20, (
                    f"Element {val} at position {pos}: {count} vs expected ~{expected}"
                )


# ---------------------------------------------------------------------------
# Similarity guard
# ---------------------------------------------------------------------------

class TestSimilarityGuard:
    def test_no_previous_order(self):
        result = shuffle_with_guard(list("abcde"), rng=random.Random(42))
        assert len(result) == 5

    def test_different_enough_passes(self):
        prev = list("abcdefghij")
        result = shuffle_with_guard(
            list("abcdefghij"),
            previous_order=prev,
            similarity_threshold=0.5,
            rng=random.Random(42),
        )
        sim = _first_n_similarity(result, prev, 10)
        assert sim <= 0.5

    def test_similarity_function(self):
        a = ["a", "b", "c", "d", "e"]
        b = ["a", "b", "x", "y", "z"]
        assert _first_n_similarity(a, b, 5) == 2 / 5

    def test_similarity_short_lists(self):
        assert _first_n_similarity(["a"], ["a"], 10) == 0.0

    def test_identical_lists_high_similarity(self):
        a = list("abcdefghij")
        assert _first_n_similarity(a, a, 10) == 1.0


# ---------------------------------------------------------------------------
# prepare_shuffled_run (full pipeline)
# ---------------------------------------------------------------------------

class TestPrepareShuffledRun:
    def test_full_pipeline(self):
        tracks = [
            _track("spotify:track:a"),
            _track("spotify:track:b"),
            _track("spotify:track:a"),  # duplicate
            _track("spotify:track:c", is_playable=False),  # unplayable
            _track("spotify:track:d"),
        ]
        uris, skipped = prepare_shuffled_run(tracks, rng=random.Random(42))
        assert len(uris) == 3  # a, b, d (c filtered, dup removed)
        assert len(skipped) == 1  # c
        assert set(uris) == {"spotify:track:a", "spotify:track:b", "spotify:track:d"}

    def test_empty_playlist(self):
        uris, skipped = prepare_shuffled_run([])
        assert uris == []
        assert skipped == []
