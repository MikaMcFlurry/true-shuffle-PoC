"""SP-008 — queue-duplication forensics against the honest Spotify simulator.

Evidence class: **VERIFIED_AUTOMATED**.  The real app code (``runs.start`` /
``runs.advance`` → ``app/runs.py::_apply``) runs unchanged against
:mod:`tests.sim_spotify`; only the provider is simulated, with its documented
facts and declared assumptions (AN-1..AN-4) spelled out in that module.

The two reproduction tests are marked ``xfail(strict=True)``: they FAIL with
the current additive prefetch — which is exactly the proof SP-008 asks for
("rot vor Fix") — while keeping the suite green.  After the fix (ADR-002) the
xfail markers are removed and the same assertions become the regression guard
("grün nach Fix").

Also here: the simulator's own contract tests (documented semantics + AN-1/
AN-3/429/204), so the evidence does not rest on an untested instrument.
"""

from __future__ import annotations

from collections import Counter

import pytest

from app import db, runs
from app.accounts import open_session
from core.models import AdvanceReason
from providers import registry
from providers.base import ProviderError
from tests.sim_spotify import (
    SimNoActiveDevice,
    SimRateLimited,
    SimulatedSpotifyPlayer,
    SimulatedSpotifyProvider,
)

pytestmark = pytest.mark.queue_forensics

TRACK_MS = 30_000


def _make_provider(monkeypatch, **player_kwargs) -> SimulatedSpotifyProvider:
    player = SimulatedSpotifyPlayer(default_duration_ms=TRACK_MS, **player_kwargs)
    provider = SimulatedSpotifyProvider(player)
    monkeypatch.setitem(registry._PROVIDERS, "spotifysim", provider)
    return provider


async def _setup_run(total: int) -> tuple[int, int, list[str]]:
    """A connected account plus an active controller run on the simulator."""
    user_id = await db.get_or_create_user("local-sim")
    await db.upsert_provider_account(
        user_id=user_id, provider="spotifysim", provider_user_id="sim-user",
        display_name="Sim User", market="", product_tier="",
        token={"access_token": "sim-token"},
    )
    order = [f"s{i}" for i in range(total)]
    run_id = await db.create_run(
        user_id=user_id, provider="spotifysim", playlist_id="sim-pl",
        playlist_name="Sim Playlist", mode="controller", order=order,
        status="active",
    )
    return run_id, user_id, order


def _dup_report(queue: list[str]) -> str:
    counts = Counter(queue)
    dups = {tid: n for tid, n in counts.items() if n > 1}
    return f"queue={queue} duplicates={dups}"


# ---------------------------------------------------------------------------
# SP-008 reproduction — red before the fix, by design
# ---------------------------------------------------------------------------

@pytest.mark.xfail(
    strict=True,
    reason="SP-008: aktueller additiver Prefetch erzeugt Queue-Duplikate — Fix in ADR-002",
)
async def test_start_then_natural_ends_duplicates_queue(database, monkeypatch):
    """Natural track ends alone multiply the queue — no skip needed.

    Sequence (all through real app code):
    start → play(s0) + enqueue s1..s5; the device rolls into s1 on its own;
    the watcher-shaped advance(TRACK_ENDED) then appends s2..s6 — although
    s2..s5 are still sitting in the queue.
    """
    provider = _make_provider(monkeypatch)
    player = provider.player
    run_id, user_id, order = await _setup_run(total=12)
    session = await open_session(user_id, "spotifysim")

    state = await runs.get_state(run_id, user_id)
    await runs.start(session, state)
    assert player.queue_ids == order[1:6]          # exactly one prefetch window

    for _ in range(2):
        player.tick(TRACK_MS + 10)                 # track ends; queue plays next
        fresh = await runs.get_state(run_id, user_id)
        await runs.advance(session, fresh, reason=AdvanceReason.TRACK_ENDED)

    counts = Counter(player.queue_ids)
    worst = max(counts.values(), default=1)
    assert worst == 1, (
        f"SP-008 reproduced: additive prefetch duplicated the queue — "
        f"max occurrences of one track: {worst}; {_dup_report(player.queue_ids)}"
    )


@pytest.mark.xfail(
    strict=True,
    reason="SP-008: aktueller additiver Prefetch erzeugt Queue-Duplikate — Fix in ADR-002",
)
async def test_native_skip_reappends(database, monkeypatch):
    """A native skip triggers the worse path: play-override + full re-append.

    The listener presses *next* in the Spotify app; the queued s1 starts.  The
    watcher-shaped advance(NATIVE_SKIP) has ``needs_override=True``, so the app
    re-plays s1 (AN-1: the manual queue survives the override — s2..s5 stay)
    and appends s2..s6 on top.  Besides the duplicates this restarts s1 from
    0:00, which the listener hears.
    """
    provider = _make_provider(monkeypatch)
    player = provider.player
    run_id, user_id, order = await _setup_run(total=12)
    session = await open_session(user_id, "spotifysim")

    state = await runs.get_state(run_id, user_id)
    await runs.start(session, state)

    player.tick(5_000)
    player.user_next()                             # native skip → queued s1 plays
    assert player.current_id == order[1]

    fresh = await runs.get_state(run_id, user_id)
    await runs.advance(session, fresh, reason=AdvanceReason.NATIVE_SKIP)

    counts = Counter(player.queue_ids)
    worst = max(counts.values(), default=1)
    assert worst == 1, (
        f"SP-008 reproduced (skip path): override left the old queue in place "
        f"(AN-1) and re-appended — {_dup_report(player.queue_ids)}"
    )


# ---------------------------------------------------------------------------
# SP-001 — the "Titel 6 = Titel 1" mechanism, shown as PLAUSIBLE (not live truth)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("policy", ["replay_context", "stop"])
async def test_sixth_title_hypothesis(database, monkeypatch, policy):
    """6-track playlist, 5 appends, no interference — then AN-2 decides.

    ``runs.start`` plays s0 as a **single-URI context** and appends s1..s5.
    The listener lets everything play out in the Spotify app, with no watcher
    driving.  After the queue drains, the one-URI context is exhausted:

    * ``replay_context`` → the context restarts and **the first title plays
      again** right after the last appended one.  With a 5-track playlist the
      identical mechanism makes the literal sixth audible slot the first title
      — a PLAUSIBLE explanation for the observed "Titel 6 = Titel 1"
      (OBSERVED_USER + INFERRED, Phase 0).
    * ``stop`` → playback simply ends after the last appended title.

    The assertion is on the *mechanism* under each declared policy — neither
    policy is claimed as live truth (AN-2; live proof: LIVE_TEST_GUIDE.md LT-1).
    """
    provider = _make_provider(monkeypatch, exhausted_context_policy=policy)
    player = provider.player
    run_id, user_id, order = await _setup_run(total=6)
    session = await open_session(user_id, "spotifysim")

    state = await runs.get_state(run_id, user_id)
    await runs.start(session, state)
    assert player.counts["enqueue"] == 5           # exactly 5 appends (buffer=5)

    for _ in range(7):                             # let everything play out
        player.tick(TRACK_MS + 10)

    assert player.played_ids[:6] == order          # all six played once, in order

    if policy == "replay_context":
        assert len(player.played_ids) >= 7
        assert player.played_ids[6] == order[0], (
            "mechanism: after queue + one-URI context are exhausted, the "
            "context replays — the first title returns"
        )
        assert any(e["event"] == "context_replayed" for e in player.event_log), (
            "the repeat must come from the context replay, not from the queue"
        )
    else:
        assert player.played_ids == order          # exactly once each, then quiet
        assert not player.is_playing


# ---------------------------------------------------------------------------
# Simulator contract — the instrument itself is tested
# ---------------------------------------------------------------------------

def test_sim_queue_plays_before_context_continuation():
    """Documented: the user queue pre-empts the context."""
    player = SimulatedSpotifyPlayer(default_duration_ms=TRACK_MS)
    player.play(uris=["spotify:track:a", "spotify:track:b"])
    player.user_add_to_queue("m1")
    player.tick(TRACK_MS + 10)
    assert player.current_id == "m1"               # queue first ...
    player.tick(TRACK_MS + 10)
    assert player.current_id == "b"                # ... then the context resumes


def test_sim_an1_play_replaces_context_but_keeps_queue():
    """AN-1: a play override does not clear manually queued items."""
    player = SimulatedSpotifyPlayer(default_duration_ms=TRACK_MS)
    player.play(uris=["spotify:track:a"])
    player.user_add_to_queue("m1")
    player.play(uris=["spotify:track:x"])          # override
    assert player.current_id == "x"
    assert player.queue_ids == ["m1"]              # survived the override
    player.tick(TRACK_MS + 10)
    assert player.current_id == "m1"


def test_sim_no_active_device_yields_204_and_404():
    """Documented: GET /me/player → 204; player commands → NO_ACTIVE_DEVICE."""
    player = SimulatedSpotifyPlayer(has_active_device=False)
    assert player.get_playback_state() is None     # the 204 shape
    with pytest.raises(SimNoActiveDevice):
        player.play(uris=["spotify:track:a"])
    with pytest.raises(SimNoActiveDevice):
        player.add_to_queue("spotify:track:a")


def test_sim_injected_429_carries_retry_after():
    """Documented: 429 with Retry-After; injectable per Nth command."""
    player = SimulatedSpotifyPlayer(rate_limit_every=2, retry_after_s=3)
    player.play(uris=["spotify:track:a"])          # command 1 — fine
    with pytest.raises(SimRateLimited) as exc:     # command 2 — rejected
        player.add_to_queue("spotify:track:b")
    assert exc.value.retry_after_s == 3
    assert exc.value.http_status == 429
    assert player.queue_ids == []                  # the rejected append did not land


def test_sim_an3_command_reordering_is_observable():
    """AN-3: two appends taking effect in swapped order swap the queue."""
    player = SimulatedSpotifyPlayer(command_latency_ms=500)
    player.play(uris=["spotify:track:a"])
    player.tick(600)                               # play has landed
    player.swap_next_two()
    player.add_to_queue("spotify:track:q1")
    player.add_to_queue("spotify:track:q2")
    player.tick(600)
    assert player.queue_ids == ["q2", "q1"]        # arrival order != send order


async def test_provider_get_queue_shape(monkeypatch):
    """The adapter's get_queue matches the SpotifyProvider return shape."""
    provider = _make_provider(monkeypatch)
    provider.player.play(uris=["spotify:track:a", "spotify:track:b"])
    provider.player.user_add_to_queue("m1")
    from providers.base import TokenBundle
    view = await provider.get_queue(TokenBundle(access_token="sim"))
    assert view == {"currently_playing_id": "a", "queue_ids": ["m1", "b"]}


def test_sim_rejects_unknown_exhaustion_policy():
    with pytest.raises(ValueError):
        SimulatedSpotifyPlayer(exhausted_context_policy="repeat")


def test_sim_play_needs_exactly_one_target():
    player = SimulatedSpotifyPlayer()
    player.register_context("spotify:playlist:p", ["a"])
    with pytest.raises(ProviderError):
        player.play(uris=["spotify:track:a"], context_uri="spotify:playlist:p")
    with pytest.raises(ProviderError):
        player.play()
