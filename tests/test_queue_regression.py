"""SP-008 — queue-duplication forensics against the honest Spotify simulator.

Evidence class: **VERIFIED_AUTOMATED**.  The real app code (``runs.start`` /
``runs.advance`` → ``app/runs.py::_apply``) runs unchanged against
:mod:`tests.sim_spotify`; only the provider is simulated, with its documented
facts and declared assumptions (AN-1..AN-7) spelled out in that module.

SP-008 rot→grün: the two reproduction tests below were marked
``xfail(strict=True)`` against the additive queue prefetch — they failed, on
purpose, which was the "rot vor Fix" proof.  ADR-002 replaced that prefetch
with the uris-window execution, the xfail markers are gone, and the identical
assertions now run as the permanent regression guard ("grün nach Fix"):
zero queue appends, zero duplicates, zero audible restarts.

The historical caveat that the skip-path proof was AN-1-conditional is kept
testable: ``test_skip_path_is_an1_independent_after_the_fix`` runs the same
sequence under both AN-1 branches and shows the fixed path does not depend on
the assumption at all (the queue is simply never written).

Also here: the ADR-002 execution pins (window boundary, device loss / Auflage
1, AN-2 both policies / Auflage 2, TS-skip via ``next``) driven watcher-shaped
through ``engine.reconcile → runs.advance``, plus the simulator's own contract
tests (documented semantics + AN-1/AN-3/AN-5/AN-6/AN-7/429/offset), so the
evidence does not rest on an untested instrument.
"""

from __future__ import annotations

from collections import Counter

import pytest

from app import db, runs
from app.accounts import open_session
from core import engine
from core.models import AdvanceReason, RunStatus
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
# SP-008 regression guard — red before ADR-002 (strict xfail), green since
# ---------------------------------------------------------------------------

async def test_start_then_natural_ends_duplicates_queue(database, monkeypatch):
    """SP-008 rot→grün, natural-end path (the unconditional core proof).

    Before ADR-002 (xfail strict): start → play(s0) + enqueue s1..s5, and
    every watcher-shaped advance(TRACK_ENDED) re-appended the next five —
    max 5 copies of one title in the queue.  Since ADR-002 the same real app
    path sends ONE play with the uris window and, inside the window, nothing
    at all: the identical duplicate assertion now guards the fix.
    """
    provider = _make_provider(monkeypatch)
    player = provider.player
    run_id, user_id, order = await _setup_run(total=12)
    session = await open_session(user_id, "spotifysim")

    state = await runs.get_state(run_id, user_id)
    await runs.start(session, state)
    # ADR-002: the user's queue is never written — the window IS the context.
    assert player.queue_ids == []
    assert player.counts["enqueue"] == 0
    assert player.counts["play"] == 1

    for _ in range(2):
        player.tick(TRACK_MS + 10)                 # track ends; context plays on
        fresh = await runs.get_state(run_id, user_id)
        await runs.advance(session, fresh, reason=AdvanceReason.TRACK_ENDED)

    counts = Counter(player.queue_ids)
    worst = max(counts.values(), default=1)
    assert worst == 1, (
        f"SP-008 reproduced: additive prefetch duplicated the queue — "
        f"max occurrences of one track: {worst}; {_dup_report(player.queue_ids)}"
    )
    # And the natural run stayed command-free inside the window.
    assert player.counts["play"] == 1
    assert player.counts["enqueue"] == 0
    assert player.played_ids == order[:3]          # each title started exactly once


async def test_native_skip_reappends(database, monkeypatch):
    """SP-008 rot→grün, skip path (historically AN-1-BEDINGT).

    Before ADR-002 (xfail strict): a native skip made the watcher-shaped
    advance(NATIVE_SKIP) re-play s1 (restarting it audibly from 0:00) and
    re-append five titles on top of the still-filled queue.  Since ADR-002 a
    native skip inside the window sends NO command at all — the listener's
    skip already moved the context, and one skip consumed exactly one card.
    """
    provider = _make_provider(monkeypatch)
    player = provider.player
    run_id, user_id, order = await _setup_run(total=12)
    session = await open_session(user_id, "spotifysim")

    state = await runs.get_state(run_id, user_id)
    await runs.start(session, state)

    player.tick(5_000)
    player.user_next()                             # native skip → context moves on
    assert player.current_id == order[1]

    fresh = await runs.get_state(run_id, user_id)
    await runs.advance(session, fresh, reason=AdvanceReason.NATIVE_SKIP)

    counts = Counter(player.queue_ids)
    worst = max(counts.values(), default=1)
    assert worst == 1, (
        f"SP-008 reproduced (skip path): override left the old queue in place "
        f"(AN-1) and re-appended — {_dup_report(player.queue_ids)}"
    )
    # No override, no re-append, no audible restart of s1:
    assert player.counts["play"] == 1              # only the start's window
    assert player.counts["enqueue"] == 0
    assert player.played_ids == [order[0], order[1]]

    run = await db.get_run(run_id, user_id=user_id)
    assert run["cursor"] == 1                      # the skip consumed one card


@pytest.mark.parametrize("clear_queue_on_play", [False, True])
async def test_skip_path_is_an1_independent_after_the_fix(
    database, monkeypatch, clear_queue_on_play
):
    """The historical skip-path proof was AN-1-BEDINGT — the fix is not.

    Pre-ADR-002 the severity of the skip path stood and fell with AN-1 (does
    a play override keep the manual queue?); the negated branch made the red
    proof vanish.  The uris-window execution never writes the queue in the
    first place, so BOTH AN-1 branches now produce byte-identical command
    traces: one play at start, zero enqueues, zero duplicates.  LT-7 may still
    settle AN-1 for the record — the app no longer depends on the answer.
    """
    provider = _make_provider(monkeypatch, clear_queue_on_play=clear_queue_on_play)
    player = provider.player
    run_id, user_id, order = await _setup_run(total=12)
    session = await open_session(user_id, "spotifysim")

    state = await runs.get_state(run_id, user_id)
    await runs.start(session, state)

    player.tick(5_000)
    player.user_next()                             # native skip → context moves on
    assert player.current_id == order[1]

    fresh = await runs.get_state(run_id, user_id)
    await runs.advance(session, fresh, reason=AdvanceReason.NATIVE_SKIP)

    assert player.counts["play"] == 1
    assert player.counts["enqueue"] == 0
    assert player.queue_ids == []
    assert max(Counter(player.played_ids).values()) == 1


# ---------------------------------------------------------------------------
# SP-001 — the "Titel 6 = Titel 1" mechanism, shown as PLAUSIBLE (not live truth)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("policy", ["replay_context", "stop"])
async def test_sixth_title_hypothesis(database, monkeypatch, policy):
    """6-track deck, no interference, NO watcher driving — then AN-2 decides.

    Historically this pinned the old mechanism (single-URI context + 5 queue
    appends → "Titel 6 = Titel 1" via context replay).  Since ADR-002
    ``runs.start`` sets ONE uris window covering the whole deck and appends
    nothing — but the AN-2 mechanism itself survives at the end of the deck:
    with nobody driving, an exhausted uris context either

    * ``replay_context`` → **replays from its first title** (the same audible
      "first title returns" pattern — which is exactly what
      ``engine.reconcile`` now recognises and overrides when the watcher IS
      driving, see the Auflage-2 tests below), or
    * ``stop`` → simply ends after the last title.

    Neither policy is claimed as live truth (AN-2; live proof: LT-1).
    """
    provider = _make_provider(monkeypatch, exhausted_context_policy=policy)
    player = provider.player
    run_id, user_id, order = await _setup_run(total=6)
    session = await open_session(user_id, "spotifysim")

    state = await runs.get_state(run_id, user_id)
    await runs.start(session, state)
    # ADR-002: one window play, zero appends — the queue stays the user's.
    assert player.counts["play"] == 1
    assert player.counts["enqueue"] == 0
    assert player.queue_ids == []

    for _ in range(7):                             # let everything play out
        player.tick(TRACK_MS + 10)

    assert player.played_ids[:6] == order          # all six played once, in order

    if policy == "replay_context":
        assert len(player.played_ids) >= 7
        assert player.played_ids[6] == order[0], (
            "mechanism: after the uris window is exhausted, the context "
            "replays — the first title returns"
        )
        assert any(e["event"] == "context_replayed" for e in player.event_log), (
            "the repeat must come from the context replay, not from the queue"
        )
    else:
        assert player.played_ids == order          # exactly once each, then quiet
        assert not player.is_playing


# ---------------------------------------------------------------------------
# ADR-002 execution pins — window boundary, Auflage 1 (device loss),
# Auflage 2 (AN-2 both policies), TS-skip via `next`
# ---------------------------------------------------------------------------

def _set_window_size(monkeypatch, size: int) -> None:
    from app.config import get_settings
    monkeypatch.setenv("CONTEXT_WINDOW_SIZE", str(size))
    get_settings.cache_clear()


async def _watcher_pass(provider, session, run_id, user_id, *, window_size):
    """One adaptive-poll cycle, exactly watcher-shaped.

    Mirrors ``app.watcher._playback_loop``: a poll shortly before the running
    track ends (the adaptive poller's wake-up → ``previous_state``), a poll
    just after it, then ``engine.reconcile → runs.advance`` under the advance
    lock.  Simulated time moves via ``player.tick``; nothing else differs
    from the production loop.  Returns the verdict, or ``None`` once the run
    is no longer active.
    """
    player = provider.player

    # Top-of-loop check, exactly like the production loop: a run that is no
    # longer active is not watched (and simulated time stops moving for it).
    state = await runs.get_state(run_id, user_id)
    if state is None or state.status is not RunStatus.ACTIVE:
        return None

    playback = await session.provider.get_playback_state(session.token)
    if playback is not None and playback.duration_ms:
        remaining = playback.duration_ms - playback.progress_ms
        if remaining > 1_000:
            player.tick(remaining - 1_000)         # wake just before the end
    previous = await session.provider.get_playback_state(session.token)
    player.tick(1_010)                             # ... and just after it
    current = await session.provider.get_playback_state(session.token)

    state = await runs.get_state(run_id, user_id)
    if state is None or state.status is not RunStatus.ACTIVE:
        return None
    verdict = engine.reconcile(state, current, previous_state=previous,
                               window_size=window_size)
    if verdict.should_advance:
        async with runs.advance_lock(run_id):
            fresh = await runs.get_state(run_id, user_id)
            if (
                fresh is not None
                and fresh.status is RunStatus.ACTIVE
                and fresh.cursor == state.cursor
            ):
                await runs.advance(session, fresh, reason=verdict.reason)
    return verdict


async def test_natural_run_uses_exactly_one_play_per_window(database, monkeypatch):
    """200 titles, window 50: a full natural run costs exactly 4 plays.

    ADR-002 Kernvertrag: inside a window the set context plays on its own
    (zero commands); only the start and the three window boundaries speak,
    and the queue is never written.  Driven watcher-shaped under the AN-2
    'stop' policy, so the audible sequence is byte-exact the deck order.
    """
    _set_window_size(monkeypatch, 50)
    provider = _make_provider(monkeypatch, exhausted_context_policy="stop")
    player = provider.player
    run_id, user_id, order = await _setup_run(total=200)
    session = await open_session(user_id, "spotifysim")

    state = await runs.get_state(run_id, user_id)
    await runs.start(session, state)

    for _ in range(210):
        verdict = await _watcher_pass(provider, session, run_id, user_id,
                                      window_size=50)
        if verdict is None:
            break

    run = await db.get_run(run_id, user_id=user_id)
    assert run["status"] == "completed"
    assert run["cursor"] == 200
    assert player.counts["play"] == 4              # start + 3 window boundaries
    assert player.counts["enqueue"] == 0
    assert player.queue_ids == []
    assert player.played_ids == order              # every card exactly once, in order


async def test_device_loss_consumes_no_card(database, monkeypatch):
    """ADR-002 Auflage 1: Geräteverlust ⇒ Zustand D (idle), KEIN advance.

    The bench's minimal S1 variant read device loss as "card consumed" and
    skipped a title — this pin moved onto the real implementation: mid-window
    the device disappears (the sim's ``has_active_device`` toggle models the
    404/204 semantics of AN-7).  reconcile reports idle, the watcher-shaped
    pass does not advance, no command goes out, and when the device returns
    the SAME card is still the expected one.
    """
    provider = _make_provider(monkeypatch)
    player = provider.player
    run_id, user_id, order = await _setup_run(total=12)
    session = await open_session(user_id, "spotifysim")

    state = await runs.get_state(run_id, user_id)
    await runs.start(session, state)
    player.tick(5_000)                             # mid-track
    commands_before = player.counts["play"] + player.counts["next"]

    player.has_active_device = False
    previous = None
    for _ in range(3):                             # several idle polls in a row
        current = await session.provider.get_playback_state(session.token)
        fresh = await runs.get_state(run_id, user_id)
        verdict = engine.reconcile(fresh, current, previous_state=previous,
                                   window_size=250)
        assert verdict.idle is True
        assert verdict.should_advance is False     # the watcher must NOT advance
        previous = current

    run = await db.get_run(run_id, user_id=user_id)
    assert run["cursor"] == 0                      # no card consumed
    assert player.counts["play"] + player.counts["next"] == commands_before
    assert player.played_ids == [order[0]]         # nothing was skipped over

    player.has_active_device = True                # the device returns
    back = await session.provider.get_playback_state(session.token)
    assert back.track_id == order[0]               # same card, same run


async def test_failed_override_leaves_the_cursor_untouched(database, monkeypatch):
    """Auflage 1 at the command layer: the cursor is persisted only AFTER the
    command landed.  A 404 (no active device) on the override play therefore
    consumes nothing — the next poll simply sees Zustand D and waits."""
    provider = _make_provider(monkeypatch)
    provider.player.has_active_device = False
    run_id, user_id, order = await _setup_run(total=12)
    session = await open_session(user_id, "spotifysim")

    # No start() in this process → no known window → this advance MUST send an
    # override play, which the deviceless player answers with the 404.
    fresh = await runs.get_state(run_id, user_id)
    with pytest.raises(ProviderError):
        await runs.advance(session, fresh, reason=AdvanceReason.TRACK_ENDED)

    run = await db.get_run(run_id, user_id=user_id)
    assert run["cursor"] == 0                      # the card was not burnt


@pytest.mark.parametrize("policy", ["replay_context", "stop"])
async def test_an2_both_policies_continue_across_the_window_boundary(
    database, monkeypatch, policy
):
    """ADR-002 Auflage 2: AN-2 is handled on BOTH branches.

    60 titles, window 50 — after the window runs out the simulator either
    *replays* its context (→ reconcile recognises the ``context_replayed``
    pattern and the run overrides immediately with the next window) or
    *stops* (→ reconcile reads the played-out idle as TRACK_ENDED and the
    run plays the next window).  Either way the deck continues seamlessly,
    finishes, and consumes every card exactly once.
    """
    _set_window_size(monkeypatch, 50)
    provider = _make_provider(monkeypatch, exhausted_context_policy=policy)
    player = provider.player
    run_id, user_id, order = await _setup_run(total=60)
    session = await open_session(user_id, "spotifysim")

    state = await runs.get_state(run_id, user_id)
    await runs.start(session, state)

    for _ in range(70):
        verdict = await _watcher_pass(provider, session, run_id, user_id,
                                      window_size=50)
        if verdict is None:
            break

    run = await db.get_run(run_id, user_id=user_id)
    assert run["status"] == "completed"
    assert run["cursor"] == 60
    assert player.counts["play"] == 2              # start + the one boundary
    assert player.counts["enqueue"] == 0

    if policy == "stop":
        assert player.played_ids == order          # byte-exact, then quiet
        assert not player.is_playing
    else:
        # The replay starts the window's FIRST title again for one poll; the
        # very next entry is the next window's first title — the override
        # landed immediately (that flash is the poll-latency cost of AN-2
        # 'replay', bounded to one per boundary).
        assert player.played_ids == [
            *order[:50], order[0], *order[50:], order[50],
        ]
        assert any(e["event"] == "context_replayed" for e in player.event_log)


async def test_ts_skip_uses_the_next_command_inside_the_window(database, monkeypatch):
    """ADR-002: a TS-UI skip while the provider plays our window is ONE
    lightweight ``POST /next`` — no re-sent window, no queue append, no
    audible restart.  Without a known window (process restart) the same skip
    falls back to asserting a fresh window."""
    provider = _make_provider(monkeypatch)
    player = provider.player
    run_id, user_id, order = await _setup_run(total=12)
    session = await open_session(user_id, "spotifysim")

    state = await runs.get_state(run_id, user_id)
    await runs.start(session, state)
    player.tick(5_000)

    fresh = await runs.get_state(run_id, user_id)
    await runs.advance(session, fresh, reason=AdvanceReason.MANUAL)
    assert player.counts["next"] == 1              # the lightweight command ...
    assert player.counts["play"] == 1              # ... not a re-sent window
    assert player.counts["enqueue"] == 0
    assert player.current_id == order[1]
    assert (await db.get_run(run_id, user_id=user_id))["cursor"] == 1

    # A restart forgets which window is set (the registry is in-memory by
    # design) — then the skip must re-assert a window instead of a blind next.
    runs._forget_window(run_id)
    fresh = await runs.get_state(run_id, user_id)
    await runs.advance(session, fresh, reason=AdvanceReason.MANUAL)
    assert player.counts["next"] == 1
    assert player.counts["play"] == 2
    assert player.current_id == order[2]


# ---------------------------------------------------------------------------
# Simulator contract — the instrument itself is tested
# ---------------------------------------------------------------------------

def test_sim_an5_queue_plays_before_context_continuation():
    """AN-5 (assumed, live: LT-10): the user queue pre-empts the context.

    Real-Spotify-plausible, but NOT covered by the BASE-05 documented facts —
    declared as an assumption because the whole multiplication mechanism
    rests on it.
    """
    player = SimulatedSpotifyPlayer(default_duration_ms=TRACK_MS)
    player.play(uris=["spotify:track:a", "spotify:track:b"])
    player.user_add_to_queue("m1")
    player.tick(TRACK_MS + 10)
    assert player.current_id == "m1"               # queue first ...
    player.tick(TRACK_MS + 10)
    assert player.current_id == "b"                # ... then the context resumes


def test_sim_an1_play_replaces_context_but_keeps_queue():
    """AN-1 (default branch): a play override does not clear queued items."""
    player = SimulatedSpotifyPlayer(default_duration_ms=TRACK_MS)
    player.play(uris=["spotify:track:a"])
    player.user_add_to_queue("m1")
    player.play(uris=["spotify:track:x"])          # override
    assert player.current_id == "x"
    assert player.queue_ids == ["m1"]              # survived the override
    player.tick(TRACK_MS + 10)
    assert player.current_id == "m1"


def test_sim_an1_negation_clears_queue_on_play():
    """AN-1 negated (clear_queue_on_play=True): the override drops the queue.

    This makes AN-1 testable in both directions — the only assumption that
    previously had no switch.
    """
    player = SimulatedSpotifyPlayer(
        default_duration_ms=TRACK_MS, clear_queue_on_play=True,
    )
    player.play(uris=["spotify:track:a"])
    player.user_add_to_queue("m1")
    player.play(uris=["spotify:track:x"])          # override
    assert player.current_id == "x"
    assert player.queue_ids == []                  # dropped by the override
    player.tick(TRACK_MS + 10)
    assert player.current_id == "x"                # AN-2 replay, not m1


def test_sim_an6_same_uri_enqueues_as_separate_entries():
    """AN-6 (assumed, live: LT-11): POST queue does not dedup identical URIs.

    Silently load-bearing for the duplication proof until now — declared and
    pinned: two appends of the same URI are two queue entries.
    """
    player = SimulatedSpotifyPlayer(default_duration_ms=TRACK_MS)
    player.play(uris=["spotify:track:a"])
    player.add_to_queue("spotify:track:d")
    player.add_to_queue("spotify:track:d")
    assert player.queue_ids == ["d", "d"]          # no dedup
    assert player.max_queue_dup_seen == 2


def test_sim_no_active_device_yields_204_and_404():
    """204 documented for GET /me/player (BASE-05); the rest is AN-7.

    Assumed, live zu bestätigen (LT-12): player COMMANDS without an active
    device fail 404 NO_ACTIVE_DEVICE — consistently for play, enqueue, next
    AND pause — and the queue read yields no usable body (None).  BASE-05
    documents only the 204 for ``GET /me/player``.
    """
    player = SimulatedSpotifyPlayer(has_active_device=False)
    assert player.get_playback_state() is None     # the documented 204 shape
    assert player.get_queue() is None              # AN-7: queue read unusable
    with pytest.raises(SimNoActiveDevice):
        player.play(uris=["spotify:track:a"])
    with pytest.raises(SimNoActiveDevice):
        player.add_to_queue("spotify:track:a")
    with pytest.raises(SimNoActiveDevice):
        player.next()                              # AN-7: no silent success
    with pytest.raises(SimNoActiveDevice):
        player.pause()                             # AN-7: no silent success


def test_sim_injected_429_carries_retry_after():
    """Documented: 429 with Retry-After; injectable per Nth command."""
    player = SimulatedSpotifyPlayer(rate_limit_every=2, retry_after_s=3)
    player.play(uris=["spotify:track:a"])          # command 1 — fine
    with pytest.raises(SimRateLimited) as exc:     # command 2 — rejected
        player.add_to_queue("spotify:track:b")
    assert exc.value.retry_after_s == 3
    assert exc.value.http_status == 429
    assert player.queue_ids == []                  # the rejected append did not land


def test_sim_reads_share_the_quota_window_when_enabled():
    """BASE-05: the rolling 30 s window covers the API, not only writes.

    With ``rate_limit_reads=True`` the two read endpoints pass the same 429
    intake as commands, so the quota model can be exercised for the dominant
    request class (polling).  Default stays False — pinned below — so the
    write-only model remains available for contrast.
    """
    player = SimulatedSpotifyPlayer(rate_limit_every=2, rate_limit_reads=True)
    player.play(uris=["spotify:track:a"])          # request 1 — fine
    with pytest.raises(SimRateLimited):            # request 2 — a READ 429s
        player.get_playback_state()
    player.get_playback_state()                    # request 3 — fine again
    with pytest.raises(SimRateLimited) as exc:     # request 4 — queue read 429s
        player.get_queue()
    assert exc.value.http_status == 429

    # Default: reads bypass the limiter entirely (the historical model).
    lenient = SimulatedSpotifyPlayer(rate_limit_every=1)
    assert lenient.get_playback_state() is not None
    assert lenient.get_queue() is not None


def test_sim_offset_takes_object_form_and_rejects_out_of_range():
    """BASE-05: ``offset`` is an object ``{"position": N}``; no clamping.

    A bare int (the previous simulator shape) is rejected, and an
    out-of-range position is an error instead of silently landing on the
    last title — an out-of-range cursor in a context play must FAIL loudly.
    """
    player = SimulatedSpotifyPlayer(default_duration_ms=TRACK_MS)
    player.register_context("spotify:playlist:p", ["a", "b", "c"])

    player.play(context_uri="spotify:playlist:p", offset={"position": 1})
    assert player.current_id == "b"                # object form works

    with pytest.raises(ProviderError):             # bare int rejected
        player.play(context_uri="spotify:playlist:p", offset=1)
    with pytest.raises(ProviderError):             # unknown key rejected
        player.play(context_uri="spotify:playlist:p", offset={"uri": "x"})
    with pytest.raises(ProviderError):             # out of range → error
        player.play(context_uri="spotify:playlist:p", offset={"position": 3})
    with pytest.raises(ProviderError):
        player.play(context_uri="spotify:playlist:p", offset={"position": -1})
    assert player.current_id == "b"                # nothing moved silently


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
