"""Tests for the run state machine — the deck-of-cards rules."""

from __future__ import annotations

import pytest

from core import engine
from core.engine import RunError
from core.models import AdvanceReason, PlaybackState, RunMode, RunState, RunStatus


def make_run(total: int = 6, cursor: int = 0, status=RunStatus.ACTIVE) -> RunState:
    return RunState(
        run_id=1, user_id=1, provider="fake", playlist_id="pl1",
        mode=RunMode.CONTROLLER,
        order=[f"t{i}" for i in range(total)],
        cursor=cursor, status=status,
    )


# ---------------------------------------------------------------------------
# start / resume
# ---------------------------------------------------------------------------

def test_start_plays_the_first_card():
    decision = engine.start(make_run(), queue_buffer=3)
    assert decision.play_track_id == "t0"
    assert decision.queue_track_ids == ["t1", "t2", "t3"]
    assert decision.advanced is False


def test_resume_returns_to_the_stored_cursor_not_the_top():
    """The whole point of the product: come back to the same card."""
    decision = engine.start(make_run(cursor=3))
    assert decision.play_track_id == "t3"
    assert decision.note == "resume"


def test_start_on_a_finished_deck_reports_completion():
    decision = engine.start(make_run(total=4, cursor=4))
    assert decision.completed is True
    assert decision.play_track_id is None


def test_cannot_start_a_cancelled_run():
    with pytest.raises(RunError):
        engine.start(make_run(status=RunStatus.CANCELLED))


def test_a_paused_run_can_still_be_resumed():
    decision = engine.start(make_run(cursor=2, status=RunStatus.PAUSED))
    assert decision.play_track_id == "t2"


# ---------------------------------------------------------------------------
# advance
# ---------------------------------------------------------------------------

def test_advance_consumes_exactly_one_card():
    decision = engine.advance(make_run(cursor=1), reason=AdvanceReason.TRACK_ENDED)
    assert decision.cursor == 2
    assert decision.play_track_id == "t2"
    assert decision.advanced is True


def test_a_user_skip_consumes_a_card_like_a_finished_track():
    """Handoff §2.2: a skipped *playable* track is used up for this run."""
    ended = engine.advance(make_run(cursor=1), reason=AdvanceReason.TRACK_ENDED)
    skipped = engine.advance(make_run(cursor=1), reason=AdvanceReason.USER_SKIP)
    assert ended.cursor == skipped.cursor == 2


def test_a_skip_forces_an_override_but_a_natural_end_may_not():
    """After a skip we must jump; after a clean end the queued track is fine."""
    assert engine.advance(make_run(), reason=AdvanceReason.USER_SKIP).needs_override
    assert not engine.advance(make_run(), reason=AdvanceReason.TRACK_ENDED).needs_override


def test_advancing_past_the_last_card_completes_the_run():
    decision = engine.advance(make_run(total=3, cursor=2), reason=AdvanceReason.TRACK_ENDED)
    assert decision.completed is True
    assert decision.cursor == 3
    assert decision.play_track_id is None


def test_advance_never_runs_past_the_end():
    decision = engine.advance(make_run(total=3, cursor=1), reason=AdvanceReason.MANUAL,
                              steps=99)
    assert decision.cursor == 3
    assert decision.completed is True


def test_advance_must_move_forward():
    with pytest.raises(RunError):
        engine.advance(make_run(), reason=AdvanceReason.MANUAL, steps=0)


def test_cannot_advance_a_completed_run():
    with pytest.raises(RunError):
        engine.advance(make_run(status=RunStatus.COMPLETED), reason=AdvanceReason.MANUAL)


# ---------------------------------------------------------------------------
# previous
# ---------------------------------------------------------------------------

def test_previous_steps_back_one_card():
    decision = engine.previous(make_run(cursor=3))
    assert decision.cursor == 2
    assert decision.play_track_id == "t2"


def test_previous_is_clamped_at_the_first_card():
    decision = engine.previous(make_run(cursor=0))
    assert decision.cursor == 0
    assert decision.advanced is False


# ---------------------------------------------------------------------------
# reconcile — reading a polled playback snapshot
# ---------------------------------------------------------------------------

def state(track_id, progress=0, duration=180_000, playing=True) -> PlaybackState:
    return PlaybackState(is_playing=playing, track_id=track_id,
                         progress_ms=progress, duration_ms=duration)


def test_playing_the_expected_track_changes_nothing():
    verdict = engine.reconcile(make_run(cursor=2), state("t2", progress=40_000))
    assert verdict.should_advance is False
    assert verdict.drifted is False


def test_no_playback_session_is_idle_not_drift():
    verdict = engine.reconcile(make_run(), PlaybackState(is_idle=True))
    assert verdict.idle is True
    assert verdict.drifted is False
    assert verdict.should_advance is False


def test_missing_state_is_treated_as_idle():
    assert engine.reconcile(make_run(), None).idle is True


def test_track_played_to_the_end_advances_as_track_ended():
    run = make_run(cursor=1)
    previous = state("t1", progress=178_000)   # 2 s left
    verdict = engine.reconcile(run, state("t2", progress=500), previous_state=previous)
    assert verdict.reason is AdvanceReason.TRACK_ENDED


def test_skipping_inside_the_provider_app_is_detected():
    """Listener pressed *next* in Spotify — we must consume one card, not desync."""
    run = make_run(cursor=1)
    previous = state("t1", progress=20_000)    # nowhere near the end
    verdict = engine.reconcile(run, state("t2", progress=300), previous_state=previous)
    assert verdict.reason is AdvanceReason.NATIVE_SKIP


def test_late_poll_into_the_next_track_is_read_as_a_clean_end():
    """If we only notice once the next track is well underway, assume it ended."""
    verdict = engine.reconcile(make_run(cursor=1), state("t2", progress=30_000))
    assert verdict.reason is AdvanceReason.TRACK_ENDED


def test_playing_something_outside_the_deck_is_drift_not_an_advance():
    verdict = engine.reconcile(make_run(cursor=1), state("some-other-song"))
    assert verdict.drifted is True
    assert verdict.should_advance is False


def test_jumping_to_another_card_of_the_same_deck_is_also_drift():
    """Do not silently burn four cards because the listener jumped ahead."""
    verdict = engine.reconcile(make_run(cursor=1), state("t5"))
    assert verdict.drifted is True
    assert verdict.should_advance is False


def test_a_finished_deck_reconciles_to_nothing():
    verdict = engine.reconcile(make_run(total=3, cursor=3), state("anything"))
    assert verdict.should_advance is False
    assert verdict.drifted is False
