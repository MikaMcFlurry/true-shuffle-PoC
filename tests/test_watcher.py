"""The playback watcher: does the deck really move on its own?

These tests drive the watcher against the fake connector and assert on the
persisted cursor, which is the only thing that matters — the listener never
touched a button.
"""

from __future__ import annotations

import asyncio

from app import db
from app.watcher import Watcher, _next_delay
from core.models import PlaybackState

# pytest-asyncio runs in auto mode (see pyproject.toml), so async tests need no
# marker — and the sync polling tests at the bottom must not carry one.


async def setup_run(fake_provider, total: int = 6) -> tuple[int, int, list[str]]:
    """A connected account plus an active controller run."""
    user_id = await db.get_or_create_user("local-watch")
    await db.upsert_provider_account(
        user_id=user_id, provider="fake", provider_user_id="u",
        display_name="U", market="DE", product_tier="premium",
        token={"access_token": "t"},
    )
    order = [t.id for t in fake_provider.tracks[:total]]
    run_id = await db.create_run(
        user_id=user_id, provider="fake", playlist_id="pl1",
        playlist_name="Everything", mode="controller", order=order,
        status="active",
    )
    return run_id, user_id, order


async def wait_for_cursor(run_id: int, user_id: int, expected: int, timeout=3.0) -> int:
    deadline = asyncio.get_event_loop().time() + timeout
    cursor = -1
    while asyncio.get_event_loop().time() < deadline:
        run = await db.get_run(run_id, user_id=user_id)
        cursor = run["cursor"] if run else -1
        if cursor >= expected:
            return cursor
        await asyncio.sleep(0.02)
    return cursor


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

async def test_watcher_starts_for_a_remote_provider(database, fake_provider):
    run_id, user_id, _ = await setup_run(fake_provider)
    watcher = Watcher()
    try:
        assert await watcher.ensure(run_id, user_id) is True
        assert watcher.is_watching(run_id)
    finally:
        await watcher.stop_all()


async def test_watcher_does_not_start_for_a_browser_player(database, fake_web_provider):
    """Apple/YouTube report their own events; polling them would be pointless."""
    user_id = await db.get_or_create_user("local-watch")
    await db.upsert_provider_account(
        user_id=user_id, provider="fakeweb", provider_user_id="u",
        display_name="U", market="", product_tier="", token={"access_token": "t"},
    )
    run_id = await db.create_run(
        user_id=user_id, provider="fakeweb", playlist_id="pl1", playlist_name="P",
        mode="controller", order=["a", "b"], status="active",
    )
    watcher = Watcher()
    try:
        assert await watcher.ensure(run_id, user_id) is False
    finally:
        await watcher.stop_all()


async def test_watcher_refuses_a_run_it_does_not_own(database, fake_provider):
    run_id, _, _ = await setup_run(fake_provider)
    stranger = await db.get_or_create_user("local-stranger")
    watcher = Watcher()
    try:
        assert await watcher.ensure(run_id, stranger) is False
    finally:
        await watcher.stop_all()


async def test_watcher_is_idempotent(database, fake_provider):
    run_id, user_id, _ = await setup_run(fake_provider)
    watcher = Watcher()
    try:
        await watcher.ensure(run_id, user_id)
        await watcher.ensure(run_id, user_id)
        assert len(watcher._handles) == 1
    finally:
        await watcher.stop_all()


# ---------------------------------------------------------------------------
# The behaviour the old PoC was missing
# ---------------------------------------------------------------------------

async def test_a_finished_track_advances_the_deck_without_any_button(
    database, fake_provider
):
    run_id, user_id, order = await setup_run(fake_provider)
    fake_provider.state = PlaybackState(
        is_playing=True, track_id=order[0], progress_ms=179_000, duration_ms=180_000
    )

    watcher = Watcher()
    try:
        await watcher.ensure(run_id, user_id)
        await asyncio.sleep(0.05)
        # The provider rolls into the track we queued next.
        fake_provider.state = PlaybackState(
            is_playing=True, track_id=order[1], progress_ms=500, duration_ms=180_000
        )
        assert await wait_for_cursor(run_id, user_id, 1) == 1
    finally:
        await watcher.stop_all()

    events = await db.list_events(run_id)
    assert any(e["reason"] == "track_ended" for e in events)


async def test_a_skip_inside_the_providers_own_app_consumes_one_card(
    database, fake_provider
):
    """The listener pressed *next* in Spotify. We must stay on one deck."""
    run_id, user_id, order = await setup_run(fake_provider)
    fake_provider.state = PlaybackState(
        is_playing=True, track_id=order[0], progress_ms=5_000, duration_ms=180_000
    )

    watcher = Watcher()
    try:
        await watcher.ensure(run_id, user_id)
        await asyncio.sleep(0.05)
        fake_provider.state = PlaybackState(
            is_playing=True, track_id=order[1], progress_ms=200, duration_ms=180_000
        )
        assert await wait_for_cursor(run_id, user_id, 1) == 1
    finally:
        await watcher.stop_all()

    events = await db.list_events(run_id)
    assert any(e["reason"] == "native_skip" for e in events)


async def test_playing_something_outside_the_deck_is_drift_not_an_advance(
    database, fake_provider
):
    """Do not fight the listener for control of their own player."""
    run_id, user_id, order = await setup_run(fake_provider)
    fake_provider.state = PlaybackState(
        is_playing=True, track_id="some-podcast", progress_ms=1000, duration_ms=600_000
    )

    watcher = Watcher()
    try:
        await watcher.ensure(run_id, user_id)
        await asyncio.sleep(0.3)
        run = await db.get_run(run_id, user_id=user_id)
        assert run["cursor"] == 0
        assert watcher.status(run_id)["drifted"] is True
    finally:
        await watcher.stop_all()

    assert any(e["type"] == "drift" for e in await db.list_events(run_id))


async def test_watcher_stops_when_the_run_is_no_longer_active(database, fake_provider):
    run_id, user_id, _ = await setup_run(fake_provider)
    watcher = Watcher()
    try:
        await watcher.ensure(run_id, user_id)
        await db.update_run(run_id, status="cancelled")
        deadline = asyncio.get_event_loop().time() + 2
        while watcher.is_watching(run_id) and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.02)
        assert not watcher.is_watching(run_id)
    finally:
        await watcher.stop_all()


async def test_watcher_survives_a_provider_error(database, fake_provider):
    """A flaky API must not kill the watcher — it retries on the next tick."""
    from providers.base import ProviderError

    run_id, user_id, order = await setup_run(fake_provider)
    calls = {"n": 0}

    async def flaky(token):
        calls["n"] += 1
        if calls["n"] < 3:
            raise ProviderError("fake: temporary outage")
        return PlaybackState(is_playing=True, track_id=order[0],
                             progress_ms=1000, duration_ms=180_000)

    fake_provider.get_playback_state = flaky

    watcher = Watcher()
    try:
        await watcher.ensure(run_id, user_id)
        deadline = asyncio.get_event_loop().time() + 3
        while calls["n"] < 3 and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.02)
        assert calls["n"] >= 3
        assert watcher.is_watching(run_id)
    finally:
        await watcher.stop_all()


async def test_stopping_the_watcher_leaves_the_cursor_untouched(database, fake_provider):
    run_id, user_id, order = await setup_run(fake_provider)
    await db.update_run(run_id, cursor=3)

    watcher = Watcher()
    await watcher.ensure(run_id, user_id)
    await watcher.stop(run_id)

    run = await db.get_run(run_id, user_id=user_id)
    assert run["cursor"] == 3
    assert watcher.status(run_id) == {"watching": False, "drifted": False}


# ---------------------------------------------------------------------------
# Adaptive polling
# ---------------------------------------------------------------------------

def test_poll_sleeps_until_just_after_the_track_ends():
    """A five-minute song should not be polled 75 times."""
    state = PlaybackState(is_playing=True, progress_ms=10_000, duration_ms=300_000)
    assert _next_delay(state, base=4.0) == 4.0

    nearly_done = PlaybackState(is_playing=True, progress_ms=298_000, duration_ms=300_000)
    assert 2.0 < _next_delay(nearly_done, base=4.0) < 3.0


def test_poll_backs_off_while_drifted():
    state = PlaybackState(is_playing=True, progress_ms=0, duration_ms=200_000)
    assert _next_delay(state, base=4.0, paused=True) == 8.0


def test_poll_never_goes_below_the_floor():
    state = PlaybackState(is_playing=True, progress_ms=200_000, duration_ms=200_000)
    assert _next_delay(state, base=4.0) >= 1.0
    assert _next_delay(None, base=0.1) >= 1.0


# ---------------------------------------------------------------------------
# MAN-05 (Phase 4): the watcher follows a deliberate device change
# ---------------------------------------------------------------------------

async def test_the_watcher_follows_playback_to_a_new_device(
    database, fake_provider,
):
    """MAN-05: derselbe Plan-Titel läuft weiter, nur auf einem anderen Gerät —
    das ist bewusste Nutzung, keine Übernahme.  Der Watcher zieht die
    ``device_id`` des Runs nach (spätere Kommandos erreichen das Gerät, das
    der Hörer wirklich hört) und protokolliert das einmal (Event
    ``device_changed``); eine F8-Episode entsteht nicht."""
    run_id, user_id, order = await setup_run(fake_provider)
    await db.update_run(run_id, device_id="dev1")
    fake_provider.state = PlaybackState(
        is_playing=True, track_id=order[0], progress_ms=30_000,
        duration_ms=180_000, device_id="dev-neu",
    )

    watcher = Watcher()
    try:
        await watcher.ensure(run_id, user_id)
        deadline = asyncio.get_event_loop().time() + 3.0
        device = None
        while asyncio.get_event_loop().time() < deadline:
            run = await db.get_run(run_id, user_id=user_id)
            device = run["device_id"] if run else None
            if device == "dev-neu":
                break
            await asyncio.sleep(0.02)
    finally:
        await watcher.stop_all()

    assert device == "dev-neu"
    events = await db.list_events(run_id)
    assert [e["type"] for e in events].count("device_changed") == 1
    run = await db.get_run(run_id, user_id=user_id)
    assert run["manual_state"] in (None, "", "none")
    assert run["status"] == "active"
