"""Tests for the run state machine — the deck-of-cards rules."""

from __future__ import annotations

import pytest

from core import engine
from core.engine import RunError
from core.models import AdvanceReason, PlaybackState, RunMode, RunState, RunStatus


def make_run(total: int = 6, cursor: int = 0, status=RunStatus.ACTIVE,
             window_anchor=None) -> RunState:
    return RunState(
        run_id=1, user_id=1, provider="fake", playlist_id="pl1",
        mode=RunMode.CONTROLLER,
        order=[f"t{i}" for i in range(total)],
        cursor=cursor, status=status,
        # ADR-002: cursor at which the caller last asserted a uris window;
        # None = no window known (fresh process / web player).
        window_anchor=window_anchor,
    )


# ---------------------------------------------------------------------------
# start / resume
# ---------------------------------------------------------------------------

def test_start_plays_the_first_card_as_a_uris_window():
    # ADR-002: the window starts AT the cursor and is capped at window_size —
    # it replaces the old queue prefetch (which listed the titles after the
    # cursor).
    decision = engine.start(make_run(), window_size=3)
    assert decision.play_track_id == "t0"
    assert decision.play_window == ["t0", "t1", "t2"]
    assert decision.needs_override is True
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


# -- ADR-002 command discipline ---------------------------------------------
# The old rule ("a skip overrides, a natural end may not") became: inside the
# asserted window NOTHING natural sends a command; a TS-skip is one `next`;
# everything outside a known window re-asserts a fresh uris window.

def test_inside_the_window_natural_moves_send_no_command():
    """The set context plays on its own — sending anything is SP-008 again."""
    for reason in (AdvanceReason.TRACK_ENDED, AdvanceReason.NATIVE_SKIP):
        decision = engine.advance(make_run(cursor=1, window_anchor=0),
                                  reason=reason, window_size=6)
        assert decision.needs_override is False
        assert decision.play_window == []
        assert decision.use_skip_next is False


def test_a_ts_skip_inside_the_window_prefers_the_next_command():
    """One lightweight `next` beats re-sending 250 uris (ADR-002)."""
    for reason in (AdvanceReason.MANUAL, AdvanceReason.USER_SKIP):
        decision = engine.advance(make_run(cursor=1, window_anchor=0),
                                  reason=reason, window_size=6)
        assert decision.use_skip_next is True
        assert decision.needs_override is False
        # The fallback window is there for providers without a skip command.
        assert decision.play_window == ["t2", "t3", "t4", "t5"]


def test_without_a_known_window_every_move_asserts_a_fresh_one():
    """window_anchor is None after a restart — re-assert instead of guessing."""
    decision = engine.advance(make_run(cursor=1), reason=AdvanceReason.TRACK_ENDED,
                              window_size=3)
    assert decision.needs_override is True
    assert decision.play_window == ["t2", "t3", "t4"]


def test_crossing_the_window_boundary_asserts_the_next_window():
    """cursor >= anchor + window_size ⇒ the set context is used up."""
    decision = engine.advance(make_run(total=8, cursor=3, window_anchor=0),
                              reason=AdvanceReason.TRACK_ENDED, window_size=4)
    assert decision.cursor == 4
    assert decision.needs_override is True
    assert decision.play_window == ["t4", "t5", "t6", "t7"]


def test_a_failed_playback_always_reasserts_the_window():
    """PLAYBACK_FAILED must jump even inside the window — the context stalled."""
    decision = engine.advance(make_run(cursor=1, window_anchor=0),
                              reason=AdvanceReason.PLAYBACK_FAILED, window_size=6)
    assert decision.needs_override is True
    assert decision.play_window == ["t2", "t3", "t4", "t5"]


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
    decision = engine.previous(make_run(cursor=3), window_size=3)
    assert decision.cursor == 2
    assert decision.play_track_id == "t2"
    # ADR-002: a step back always re-asserts a fresh window from the new
    # cursor — the set context only ever runs forward.
    assert decision.needs_override is True
    assert decision.play_window == ["t2", "t3", "t4"]


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


# ---------------------------------------------------------------------------
# reconcile — ADR-002 window-end patterns (AN-2, Auflagen 1 + 2)
# ---------------------------------------------------------------------------

def test_a_context_replay_after_window_end_is_an_advance_not_drift():
    """AN-2 'replay': window [t0..t2] ran out, the service replays t0 while
    the deck stands on t2 — the caller must override with the next window
    immediately, otherwise old titles repeat audibly ("Titel 6 = Titel 1")."""
    run = make_run(total=6, cursor=2, window_anchor=0)
    verdict = engine.reconcile(run, state("t0", progress=200), window_size=3)
    assert verdict.reason is AdvanceReason.TRACK_ENDED
    assert verdict.drifted is False
    assert "replayed" in verdict.note


def test_the_replay_pattern_needs_the_window_context_to_fire():
    """Without a known window the same snapshot stays what it always was:
    a jump inside the deck, i.e. drift — the pattern must not over-trigger."""
    run = make_run(total=6, cursor=2)                  # anchor unknown
    verdict = engine.reconcile(run, state("t0", progress=200), window_size=3)
    assert verdict.drifted is True
    assert verdict.should_advance is False


def test_a_context_stop_after_the_window_played_out_advances():
    """AN-2 'stop': idle right after the window's last card demonstrably
    played out ⇒ TRACK_ENDED, so the caller plays the next window."""
    run = make_run(total=6, cursor=2, window_anchor=0)
    nearly_done = state("t2", progress=178_000)        # 2 s left on the last card
    verdict = engine.reconcile(
        run, PlaybackState(is_idle=True),
        previous_state=nearly_done, window_size=3,
    )
    assert verdict.reason is AdvanceReason.TRACK_ENDED
    assert "stopped" in verdict.note


def test_idle_without_played_out_evidence_stays_idle_and_burns_no_card():
    """ADR-002 Auflage 1: a device that vanishes mid-track (404 / no active
    device) is Zustand D — idle, NO advance, no card consumed."""
    run = make_run(total=6, cursor=2, window_anchor=0)
    mid_track = state("t2", progress=20_000)           # nowhere near the end
    verdict = engine.reconcile(
        run, PlaybackState(is_idle=True),
        previous_state=mid_track, window_size=3,
    )
    assert verdict.idle is True
    assert verdict.should_advance is False


def test_idle_after_a_card_played_out_consumes_it_wherever_the_window_ends():
    """Silence after a finished card is a track end, not a lost device.

    This test used to assert the opposite: idle mid-window was always read as
    "the device disappeared", on the reasoning that a context with more titles
    queued cannot stop by itself.  The live report falsified the premise — a
    client that honours only the first entry of a uris list HAS a one-track
    context, however long we believe our window to be, and with Spotify's
    Autoplay switched off it simply falls silent at the end of track one.  The
    deck then stood still for ever.

    The discriminator is the evidence, not the window arithmetic: a card
    observed to reach its end is consumed; a device that vanished mid-track is
    not (that is the test below, and ADR-002 Auflage 1).
    """
    run = make_run(total=6, cursor=1, window_anchor=0)
    nearly_done = state("t1", progress=178_000)
    verdict = engine.reconcile(
        run, PlaybackState(is_idle=True),
        previous_state=nearly_done, window_size=3,
    )
    assert verdict.reason is AdvanceReason.TRACK_ENDED
    assert verdict.context_lost is True
    assert verdict.idle is False
    assert verdict.should_advance is True
