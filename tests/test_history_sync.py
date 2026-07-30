"""Handoff Mode: a deck that advances with no browser tab open.

The listener plays the shuffled playlist in the service's own app; the server
reconciles the cursor from the service's recently-played list. These tests
cover the rule, the connectors that implement it, and the watcher that runs it.
"""

from __future__ import annotations

import asyncio

import pytest

from app import db, runs
from app.accounts import open_session
from app.watcher import Watcher
from core import engine
from core.models import RunMode, RunState, RunStatus
from providers.apple import AppleMusicProvider
from providers.base import TokenBundle, Unsupported
from providers.spotify import SpotifyProvider
from providers.youtube import YouTubeMusicProvider

TOKEN = TokenBundle(access_token="test-token")


def make_run(total: int = 10, cursor: int = 0) -> RunState:
    return RunState(
        run_id=1, user_id=1, provider="fakehist", playlist_id="pl1",
        mode=RunMode.UTILITY, order=[f"t{i}" for i in range(total)],
        cursor=cursor, status=RunStatus.ACTIVE,
    )


# ---------------------------------------------------------------------------
# The rule
# ---------------------------------------------------------------------------

def test_nothing_played_leaves_the_cursor_alone():
    verdict = engine.reconcile_history(make_run(), [])
    assert verdict.advanced is False
    assert verdict.cursor == 0


def test_tracks_from_another_playlist_do_not_move_the_deck():
    verdict = engine.reconcile_history(make_run(), ["something-else", "and-another"])
    assert verdict.advanced is False


def test_playing_the_first_card_advances_by_one():
    verdict = engine.reconcile_history(make_run(), ["t0"])
    assert verdict.cursor == 1
    assert verdict.advanced is True
    assert verdict.matched == 1


def test_the_cursor_lands_past_the_furthest_card_played():
    """Playing the copy in order means everything before it was played too."""
    verdict = engine.reconcile_history(make_run(), ["t3", "t2", "t1", "t0"])
    assert verdict.cursor == 4
    assert verdict.matched == 4


def test_a_gap_in_the_history_still_advances_to_the_furthest_card():
    """Services keep a limited history; a missing middle entry is normal."""
    verdict = engine.reconcile_history(make_run(), ["t4", "t0"])
    assert verdict.cursor == 5
    assert verdict.matched == 2


def test_history_is_read_relative_to_the_current_cursor():
    verdict = engine.reconcile_history(make_run(cursor=6), ["t7"])
    assert verdict.cursor == 8


def test_already_consumed_cards_cannot_pull_the_cursor_backwards():
    """Yesterday's plays are still in the history; the deck only shrinks."""
    verdict = engine.reconcile_history(make_run(cursor=6), ["t0", "t1", "t2"])
    assert verdict.advanced is False
    assert verdict.cursor == 6


def test_a_far_future_match_is_ignored():
    """A song played from an album must not yank the deck to the end."""
    run = RunState(
        run_id=1, provider="fakehist", playlist_id="p", mode=RunMode.UTILITY,
        order=[f"t{i}" for i in range(500)], cursor=0, status=RunStatus.ACTIVE,
    )
    verdict = engine.reconcile_history(run, ["t400"])
    assert verdict.advanced is False


def test_playing_the_last_card_completes_the_deck():
    verdict = engine.reconcile_history(make_run(total=5, cursor=4), ["t4"])
    assert verdict.cursor == 5
    assert verdict.completed is True


def test_a_finished_deck_reports_complete():
    verdict = engine.reconcile_history(make_run(total=5, cursor=5), ["t4"])
    assert verdict.completed is True
    assert verdict.advanced is False


# ---------------------------------------------------------------------------
# Which connectors offer it
# ---------------------------------------------------------------------------

def test_spotify_and_apple_track_progress_without_a_tab():
    assert SpotifyProvider().capabilities.supports_history_sync is True
    assert AppleMusicProvider().capabilities.supports_history_sync is True
    assert SpotifyProvider().capabilities.tracks_progress_without_tab is True
    assert AppleMusicProvider().capabilities.tracks_progress_without_tab is True


def test_youtube_cannot_and_says_so():
    """YouTube removed watch-history from the Data API; do not pretend."""
    caps = YouTubeMusicProvider().capabilities
    assert caps.supports_history_sync is False
    assert caps.tracks_progress_without_tab is False
    assert any("hörverlauf" in note.lower() for note in caps.notes)


def test_only_browser_players_need_an_open_tab_for_live_mode():
    assert SpotifyProvider().capabilities.live_mode_needs_open_tab is False
    assert AppleMusicProvider().capabilities.live_mode_needs_open_tab is True
    assert YouTubeMusicProvider().capabilities.live_mode_needs_open_tab is True


async def test_a_provider_without_history_raises_rather_than_lying():
    with pytest.raises(Unsupported):
        await YouTubeMusicProvider().get_recently_played(TOKEN)


# ---------------------------------------------------------------------------
# Connector implementations (network stubbed)
# ---------------------------------------------------------------------------

async def test_spotify_reads_its_recently_played_list(monkeypatch):
    calls = []

    async def stub(method, url, **kwargs):
        calls.append((url, kwargs.get("params")))
        return {"items": [
            {"track": {"id": "t2"}, "played_at": "2026-07-30T10:02:00Z"},
            {"track": {"id": "t1"}, "played_at": "2026-07-30T09:58:00Z"},
            {"track": None},
        ]}

    monkeypatch.setattr("providers.spotify.http.request", stub)
    played = await SpotifyProvider().get_recently_played(TOKEN)

    assert [p.track_id for p in played] == ["t2", "t1"]
    assert played[0].played_at == "2026-07-30T10:02:00Z"
    assert "/me/player/recently-played" in calls[0][0]


async def test_spotify_history_scope_is_requested():
    from providers.spotify import SCOPES

    assert "user-read-recently-played" in SCOPES


async def test_apple_pages_its_ten_at_a_time_history(monkeypatch):
    """Apple caps this endpoint at 10 per request, so a full read is 5 calls."""
    pages = [
        {"data": [
            {"id": f"i.{n}", "attributes": {"playParams": {"catalogId": f"c{n}"}}}
            for n in range(page * 10, page * 10 + 10)
        ]}
        for page in range(5)
    ]
    seen = []

    async def stub(method, url, **kwargs):
        seen.append(kwargs.get("params"))
        return pages.pop(0) if pages else {"data": []}

    monkeypatch.setattr("providers.apple.http.request", stub)
    monkeypatch.setenv("APPLE_TEAM_ID", "TEAM123456")
    monkeypatch.setenv("APPLE_KEY_ID", "KEY1234567")
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    monkeypatch.setenv("APPLE_PRIVATE_KEY", ec.generate_private_key(
        ec.SECP256R1()).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()).decode())
    from app.config import get_settings
    get_settings.cache_clear()

    played = await AppleMusicProvider().get_recently_played(TOKEN)

    assert len(played) == 50
    assert played[0].track_id == "c0"
    assert [p["offset"] for p in seen] == [0, 10, 20, 30, 40]
    assert all(p["limit"] == 10 for p in seen)


async def test_apple_history_stops_early_on_a_short_page(monkeypatch):
    async def stub(method, url, **kwargs):
        return {"data": [
            {"id": "i.1", "attributes": {"playParams": {"catalogId": "c1"}}}
        ]}

    monkeypatch.setattr("providers.apple.http.request", stub)
    monkeypatch.setenv("APPLE_TEAM_ID", "T")
    monkeypatch.setenv("APPLE_KEY_ID", "K")
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    monkeypatch.setenv("APPLE_PRIVATE_KEY", ec.generate_private_key(
        ec.SECP256R1()).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()).decode())
    from app.config import get_settings
    get_settings.cache_clear()

    played = await AppleMusicProvider().get_recently_played(TOKEN)
    assert [p.track_id for p in played] == ["c1"]


# ---------------------------------------------------------------------------
# End to end through the watcher
# ---------------------------------------------------------------------------

async def setup_handoff_run(provider, total: int = 8) -> tuple[int, int, list[str]]:
    user_id = await db.get_or_create_user("local-handoff")
    await db.upsert_provider_account(
        user_id=user_id, provider=provider.capabilities.id, provider_user_id="u",
        display_name="U", market="DE", product_tier="premium",
        token={"access_token": "t"},
    )
    order = [t.id for t in provider.tracks[:total]]
    run_id = await db.create_run(
        user_id=user_id, provider=provider.capabilities.id, playlist_id="pl1",
        playlist_name="Everything", mode="utility", order=order, status="active",
    )
    return run_id, user_id, order


async def test_history_sync_advances_a_run(database, fake_history_provider):
    run_id, user_id, order = await setup_handoff_run(fake_history_provider)
    fake_history_provider.history = [order[2], order[1], order[0]]

    session = await open_session(user_id, "fakehist")
    state = await runs.get_state(run_id, user_id)
    verdict = await runs.sync_from_history(session, state)

    assert verdict.advanced is True
    run = await db.get_run(run_id, user_id=user_id)
    assert run["cursor"] == 3


async def test_history_sync_is_a_no_op_when_nothing_was_played(
    database, fake_history_provider
):
    run_id, user_id, _ = await setup_handoff_run(fake_history_provider)
    fake_history_provider.history = []

    session = await open_session(user_id, "fakehist")
    state = await runs.get_state(run_id, user_id)
    verdict = await runs.sync_from_history(session, state)

    assert verdict.advanced is False
    assert (await db.get_run(run_id, user_id=user_id))["cursor"] == 0


async def test_history_sync_completes_the_run_at_the_end(
    database, fake_history_provider
):
    run_id, user_id, order = await setup_handoff_run(fake_history_provider)
    fake_history_provider.history = list(reversed(order))

    session = await open_session(user_id, "fakehist")
    state = await runs.get_state(run_id, user_id)
    await runs.sync_from_history(session, state)

    run = await db.get_run(run_id, user_id=user_id)
    assert run["status"] == "completed"
    assert run["cursor"] == len(order)


async def test_history_sync_returns_none_for_a_provider_without_history(
    database, fake_web_provider
):
    user_id = await db.get_or_create_user("local-handoff")
    await db.upsert_provider_account(
        user_id=user_id, provider="fakeweb", provider_user_id="u",
        display_name="U", market="", product_tier="", token={"access_token": "t"},
    )
    run_id = await db.create_run(
        user_id=user_id, provider="fakeweb", playlist_id="pl1", playlist_name="P",
        mode="utility", order=["a", "b"], status="active",
    )
    session = await open_session(user_id, "fakeweb")
    state = await runs.get_state(run_id, user_id)
    assert await runs.sync_from_history(session, state) is None


async def test_the_watcher_follows_a_handoff_run_with_no_tab_open(
    database, fake_history_provider, monkeypatch
):
    """The whole point: no page of ours is open, and the deck still moves."""
    monkeypatch.setenv("HISTORY_POLL_SECONDS", "0.02")
    from app.config import get_settings
    get_settings.cache_clear()

    run_id, user_id, order = await setup_handoff_run(fake_history_provider)
    watcher = Watcher()
    try:
        assert await watcher.ensure(run_id, user_id) is True

        fake_history_provider.history = [order[1], order[0]]
        deadline = asyncio.get_event_loop().time() + 3
        cursor = 0
        while asyncio.get_event_loop().time() < deadline:
            run = await db.get_run(run_id, user_id=user_id)
            cursor = run["cursor"]
            if cursor >= 2:
                break
            await asyncio.sleep(0.02)
        assert cursor == 2
    finally:
        await watcher.stop_all()

    assert any(e["type"] == "history_sync" for e in await db.list_events(run_id))


async def test_the_watcher_skips_a_handoff_run_it_cannot_track(
    database, fake_web_provider
):
    """No history API means no tracking — and no pretending there is."""
    user_id = await db.get_or_create_user("local-handoff")
    await db.upsert_provider_account(
        user_id=user_id, provider="fakeweb", provider_user_id="u",
        display_name="U", market="", product_tier="", token={"access_token": "t"},
    )
    run_id = await db.create_run(
        user_id=user_id, provider="fakeweb", playlist_id="pl1", playlist_name="P",
        mode="utility", order=["a", "b"], status="active",
    )
    watcher = Watcher()
    try:
        assert await watcher.ensure(run_id, user_id) is False
    finally:
        await watcher.stop_all()


async def test_a_handoff_deck_survives_a_restart(database, fake_history_provider):
    """Resume is the product. Re-opening the run must not re-deal it."""
    run_id, user_id, order = await setup_handoff_run(fake_history_provider)
    fake_history_provider.history = [order[3], order[2], order[1], order[0]]

    session = await open_session(user_id, "fakehist")
    await runs.sync_from_history(session, await runs.get_state(run_id, user_id))

    reopened = await runs.get_state(run_id, user_id)
    assert reopened.cursor == 4
    assert reopened.order == order          # same deck, not a new deal
    assert reopened.current_track_id == order[4]
