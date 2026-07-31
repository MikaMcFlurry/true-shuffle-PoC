"""The demo connector: a complete service that plays nothing.

Its job is to make every function testable without credentials. Its other job
is to never be mistaken for evidence that a real service works — so these
tests pin the default-off behaviour and the honesty of its own notes as hard
as they pin the mapping.
"""

from __future__ import annotations

import pytest

from providers.base import PlaybackControl, ProviderNotConfigured, TokenBundle
from providers.demo import TRACK_MS, DemoProvider
from providers.registry import all_providers

TOKEN = TokenBundle(access_token="demo-token")


@pytest.fixture
def demo(monkeypatch):
    monkeypatch.setenv("ENABLE_DEMO_PROVIDER", "true")
    from app.config import get_settings
    get_settings.cache_clear()
    return DemoProvider()


def test_it_is_off_unless_switched_on(monkeypatch):
    monkeypatch.delenv("ENABLE_DEMO_PROVIDER", raising=False)
    from app.config import get_settings
    get_settings.cache_clear()

    provider = DemoProvider()
    assert provider.is_configured() is False
    assert provider.missing_config() == ["ENABLE_DEMO_PROVIDER=true"]


async def test_connecting_while_off_is_refused(monkeypatch):
    monkeypatch.delenv("ENABLE_DEMO_PROVIDER", raising=False)
    from app.config import get_settings
    get_settings.cache_clear()

    with pytest.raises(ProviderNotConfigured):
        await DemoProvider().begin_auth(redirect_uri="http://x/cb", state="s")


def test_it_says_plainly_that_it_is_not_a_streaming_service(demo):
    joined = " ".join(demo.capabilities.notes).lower()
    assert "kein echter streamingdienst" in joined
    assert "status.md" in joined
    assert demo.capabilities.experimental is True


def test_it_comes_last_so_it_is_never_the_default_path():
    ids = [p.capabilities.id for p in all_providers()]
    assert ids[-1] == "demo"


def test_the_library_is_realistically_large(demo):
    """A twelve-track demo hides every problem that only appears at scale."""
    assert len(demo.tracks) == 1_482


async def test_it_offers_a_deliberately_dirty_playlist(demo):
    """So the "nicht ins Fach gekommen" reporting has something to report."""
    pages = [p async for p in demo.iter_playlist_tracks(TOKEN, "demo-dirty")]
    tracks = [t for page in pages for t in page]

    assert any(not t.id for t in tracks)                      # local file
    assert any(t.is_playable is False for t in tracks)        # unavailable
    assert any(t.kind.value == "episode" for t in tracks)     # not music
    ids = [t.id for t in tracks if t.id]
    assert len(ids) != len(set(ids))                          # duplicates


async def test_live_mode_reports_a_finished_track_so_the_deck_advances(demo, monkeypatch):
    """The watcher reads this; without it Live Mode cannot be demonstrated."""
    clock = {"t": 1_000.0}
    monkeypatch.setattr("providers.demo.time.monotonic", lambda: clock["t"])

    # ADR-002 play signature: one call carries the (here: one-title) window.
    await demo.play(TOKEN, track_ids=["demo-00000"], device_id="demo-speaker")
    state = await demo.get_playback_state(TOKEN)
    assert state.is_playing and state.progress_ms == 0

    clock["t"] += (TRACK_MS / 1000) + 1
    state = await demo.get_playback_state(TOKEN)
    assert state.progress_ms == TRACK_MS          # the track is over


async def test_handoff_history_reports_a_listener_working_through_the_copy(
    demo, monkeypatch
):
    """The half of the product that needs nothing of ours open."""
    clock = {"t": 500.0}
    monkeypatch.setattr("providers.demo.time.monotonic", lambda: clock["t"])

    created = await demo.create_playlist(TOKEN, name="true-shuffle · Demo")
    await demo.add_tracks(TOKEN, created.id, ["a", "b", "c", "d"])

    assert await demo.get_recently_played(TOKEN) == []        # nothing yet

    from providers.demo import HANDOFF_SECONDS_PER_TRACK
    clock["t"] += HANDOFF_SECONDS_PER_TRACK * 2.5
    played = await demo.get_recently_played(TOKEN)

    # Newest first, which is what every real service returns.
    assert [p.track_id for p in played] == ["b", "a"]


def test_it_is_shaped_like_spotify_so_both_modes_are_demonstrable(demo):
    assert demo.capabilities.playback is PlaybackControl.REMOTE_DEVICE
    assert demo.capabilities.supports_history_sync is True
    assert demo.capabilities.tracks_progress_without_tab is True
    assert demo.capabilities.live_mode_needs_open_tab is False


async def test_the_demo_device_plays_through_its_window_by_itself(demo, monkeypatch):
    """The property Live Mode depends on.

    true-shuffle does not push the next track on a timer: ADR-002 hands the
    device the whole uris window in ONE play call, the service's own device
    plays through it, and the watcher notices the device has moved on. A demo
    device that sat on one track forever would show a run that never advances
    — which is exactly what happened before this.
    """
    clock = {"t": 0.0}
    monkeypatch.setattr("providers.demo.time.monotonic", lambda: clock["t"])

    await demo.play(TOKEN, track_ids=["a", "b", "c"])

    assert (await demo.get_playback_state(TOKEN)).track_id == "a"

    clock["t"] += TRACK_MS / 1000 + 0.1
    assert (await demo.get_playback_state(TOKEN)).track_id == "b"

    clock["t"] += TRACK_MS / 1000
    assert (await demo.get_playback_state(TOKEN)).track_id == "c"

    # Window exhausted: it holds on the last card instead of inventing one.
    clock["t"] += TRACK_MS / 1000 * 5
    end = await demo.get_playback_state(TOKEN)
    assert end.track_id == "c"
    assert end.progress_ms == TRACK_MS


async def test_the_demo_device_takes_a_ts_skip_as_one_next_command(demo, monkeypatch):
    """ADR-002: a TS-skip inside the window is skip_next, not a fresh window."""
    clock = {"t": 0.0}
    monkeypatch.setattr("providers.demo.time.monotonic", lambda: clock["t"])

    await demo.play(TOKEN, track_ids=["a", "b", "c"])
    clock["t"] += 3
    await demo.skip_next(TOKEN)

    state = await demo.get_playback_state(TOKEN)
    assert state.track_id == "b"
    assert state.progress_ms == 0            # the skip starts the next title fresh

    # At the end of the window a skip sits at the end instead of inventing.
    await demo.skip_next(TOKEN)
    await demo.skip_next(TOKEN)
    end = await demo.get_playback_state(TOKEN)
    assert end.track_id == "c"
    assert end.progress_ms == TRACK_MS


async def test_pausing_the_demo_device_stops_its_clock(demo, monkeypatch):
    clock = {"t": 0.0}
    monkeypatch.setattr("providers.demo.time.monotonic", lambda: clock["t"])

    await demo.play(TOKEN, track_ids=["a", "b"])
    clock["t"] += 3
    await demo.pause(TOKEN)

    clock["t"] += 60          # an hour of wall time changes nothing
    state = await demo.get_playback_state(TOKEN)
    assert state.is_playing is False
    assert state.track_id == "a"
    assert 2_900 <= state.progress_ms <= 3_100
