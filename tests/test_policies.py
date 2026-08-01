"""WP3-D3 — policies, ledger idempotency, configs and sync-apply.

Acceptance evidence for the D3 slice of Phase 3:

* F5 (ADR-003): the deterministic advance event key makes double application
  impossible — the duplicate is booked ``applied=0``/stale and moves nothing
  (SP-004/005 hardening, restart-proof unlike the in-process lock);
* RUN-06: all four skip policies over the REAL advance path (consume /
  keep_open / requeue_later / defer_to_end), incl. the F4 rule that a natural
  track end is always the consume-equivalent;
* MAN-01 / F8: the manual-use state machine — auto_resume, auto_pause, ask
  (awaiting_decision + decision API) and the suspended timeout, with an
  injected clock;
* UC-27: run-local rule changes are versioned with effective-from-seq — the
  selection AFTER the change follows the new rules, history stays untouched;
* P4 through the service layer: favourite weighting changes the replanned
  tail deterministically (seed check, no statistics — the property run owns
  the statistical claims);
* RUN-08: exclude / reactivate takes effect immediately (tail replan);
* RUN-09/10: apply_sync_to_run under all three new-track policies, removed /
  re-added entries, and idempotent replay;
* UC-28/29 / F7: a config is playlist-neutral and duplicable — track-bound
  facts (favourites) never travel with it.

Fixtures are local on purpose (Limit-Abbruch-Resilienz): this file must run
on its own with nothing but ``tests/conftest.py``'s database isolation.
"""

from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass, replace

import pytest
import pytest_asyncio

from app import db, library_service, runs
from core import engine
from core.models import AdvanceReason, PlaylistRef, RunMode, Track
from core.selection import (
    QUOTA_WINDOW,
    REQUEUE_AFTER_DRAWS,
    Candidate,
    Rules,
    select_next,
)
from providers.base import TokenBundle
from tests.conftest import FakeProvider

# pytest-asyncio auto mode (pyproject.toml) marks async tests automatically.


# ---------------------------------------------------------------------------
# Local fixtures
# ---------------------------------------------------------------------------

@dataclass
class Service:
    session: object
    provider: FakeProvider
    playlist: PlaylistRef
    user_id: int


@pytest_asyncio.fixture
async def service(database) -> Service:
    from app.accounts import Session

    provider = FakeProvider()
    user_id = await db.get_or_create_user("local-policies")
    session = Session(
        user_id=user_id, provider=provider, token=TokenBundle(access_token="t")
    )
    playlist = (await provider.list_playlists(None))[0]  # "pl1", 12 tracks
    return Service(session=session, provider=provider, playlist=playlist,
                   user_id=user_id)


async def _one(conn, sql, params=()):
    cur = await conn.execute(sql, params)
    row = await cur.fetchone()
    return row[0] if row is not None else None


async def _config(service: Service, name: str, **rule_overrides) -> int:
    return await db.create_config(
        service.user_id, name, Rules(**rule_overrides)
    )


async def _run(service: Service, *, name: str, config_id=None):
    state, _ = await runs.create_run_v3(
        service.session, service.playlist, RunMode.CONTROLLER,
        name=name, config_id=config_id,
    )
    return state


# ---------------------------------------------------------------------------
# F5 — the ledger decides, not the timer (SP-004/005 hardening)
# ---------------------------------------------------------------------------

async def test_f5_duplicate_event_key_is_applied_exactly_once(database, service):
    """The same transition key twice → one effective advance, one stale row.

    The forged row below is exactly what a concurrent writer (second process,
    or a crashed-and-retried one) would have booked for the SAME draw: same
    plan_version, same next selection seq, same from→to transition.  The
    second application must fall off ``UNIQUE(run_id, event_key)`` and change
    NOTHING — no cursor, no seq, no card, no selection row.
    """
    state = await _run(service, name="F5")
    await runs.advance(service.session, state, reason=AdvanceReason.TRACK_ENDED)
    run = await db.get_run(state.run_id)
    assert run["cursor"] == 1 and run["selection_seq"] == 1

    next_seq = run["selection_seq"] + 1
    forged_key = (
        f"{state.run_id}:{run['plan_version']}:{next_seq}:"
        f"{state.order[1]}:{state.order[2]}"
    )
    await db.record_event(state.run_id, "advanced", cursor=2,
                          event_key=forged_key, seq=next_seq)

    decision = await runs.advance(
        service.session, state, reason=AdvanceReason.TRACK_ENDED
    )
    assert decision.advanced is False
    assert "stale" in decision.note

    fresh = await db.get_run(state.run_id)
    assert fresh["cursor"] == 1                    # nothing moved
    assert fresh["selection_seq"] == 1             # the seq clock did not tick
    assert await _one(
        database,
        "SELECT count(*) FROM run_events WHERE run_id = ? AND applied = 0 "
        "AND reason = 'stale'",
        (state.run_id,),
    ) == 1
    # The card of the duplicate transition was NOT consumed …
    assert await _one(
        database,
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND state = 'played'",
        (state.run_id,),
    ) == 1                                          # only the first advance
    # … and no second selection row exists.
    assert await _one(
        database,
        "SELECT count(*) FROM run_selections WHERE run_id = ?",
        (state.run_id,),
    ) == 1


# ---------------------------------------------------------------------------
# RUN-06 — the four skip policies over the real advance path
# ---------------------------------------------------------------------------

async def test_skip_policy_consume_marks_the_card_played(database, service):
    config_id = await _config(service, "Consume", skip_policy="consume")
    state = await _run(service, name="c", config_id=config_id)
    skipped_track = state.order[0]

    await runs.advance(service.session, state, reason=AdvanceReason.USER_SKIP)

    card = await db.find_run_track(state.run_id, provider_track_id=skipped_track)
    assert card["state"] == "played"
    assert card["play_count"] == 1
    assert card["last_played_seq"] == 1
    plan = await db.list_active_plan(state.run_id)
    assert plan[0]["state"] == "consumed"
    assert plan[1]["state"] == "current"
    assert len(plan) == 12                          # no extension
    # The selection ledger carries the draw: seq, config version, rules hash.
    sel = await database.execute(
        "SELECT * FROM run_selections WHERE run_id = ?", (state.run_id,))
    row = dict(await sel.fetchone())
    assert row["seq"] == 1
    assert row["run_track_id"] == card["id"]
    assert row["rules_hash"] == Rules(skip_policy="consume").rules_hash()


async def test_skip_policy_keep_open_leaves_the_card_in_the_pool(database, service):
    config_id = await _config(service, "KeepOpen", skip_policy="keep_open")
    state = await _run(service, name="k", config_id=config_id)
    skipped_track = state.order[0]

    await runs.advance(service.session, state, reason=AdvanceReason.USER_SKIP)

    card = await db.find_run_track(state.run_id, provider_track_id=skipped_track)
    assert card["state"] == "open"                  # NOT consumed
    assert card["play_count"] == 0
    assert (await db.get_run(state.run_id))["cursor"] == 1  # plan moved on
    assert len(await db.list_active_plan(state.run_id)) == 12

    # F4: a natural end consumes regardless of the skip policy.
    ended_track = state.order[1]
    await runs.advance(service.session, state, reason=AdvanceReason.TRACK_ENDED)
    ended = await db.find_run_track(state.run_id, provider_track_id=ended_track)
    assert ended["state"] == "played" and ended["play_count"] == 1


@pytest.mark.parametrize("policy", ["requeue_later", "defer_to_end"])
async def test_skip_policy_deferral_extends_the_plan_at_the_end(
    database, service, policy
):
    """requeue_later / defer_to_end: plan extension instead of a replan."""
    config_id = await _config(service, f"Defer {policy}", skip_policy=policy)
    state = await _run(service, name=policy, config_id=config_id)
    skipped_track = state.order[0]

    await runs.advance(service.session, state, reason=AdvanceReason.USER_SKIP)

    card = await db.find_run_track(state.run_id, provider_track_id=skipped_track)
    assert card["state"] == "deferred"
    assert card["play_count"] == 0
    run = await db.get_run(state.run_id)
    assert run["cursor"] == 1
    assert len(run["order"]) == 13                  # order grew at the end …
    assert run["order"][-1] == skipped_track
    plan = await db.list_active_plan(state.run_id)
    assert len(plan) == 13                          # … and so did the plan
    assert plan[-1]["run_track_id"] == card["id"]
    assert plan[-1]["state"] == "planned"
    # The in-memory state was extended too — the dual source stays in step.
    assert state.order[-1] == skipped_track

    # Reaching the deferred card at the end consumes it like any other.
    for _ in range(12):
        await runs.advance(service.session, state,
                           reason=AdvanceReason.TRACK_ENDED)
    final = await db.find_run_track(state.run_id, provider_track_id=skipped_track)
    assert final["state"] == "played" and final["play_count"] == 1
    assert (await db.get_run(state.run_id))["status"] == "completed"


async def test_requeue_later_returns_no_earlier_than_the_deadline(database, service):
    """RUN-06 × P6: over the REAL advance path a requeue_later card is
    consumed again no earlier than :data:`REQUEUE_AFTER_DRAWS` draws after
    the skip — or not at all in this cycle.

    Regression (WP3-C Anbindungslücke): the booking path used to stamp no
    ``last_played_seq`` on the deferral AND to append the card blindly to
    the plan end — skipped with only three rows left, the card came back a
    mere four draws later.  Now the skip stamps the deferral seq, and an
    extension that would land inside the deadline window is NOT appended:
    the card stays parked as 'deferred', the cycle completes without it,
    and F2's reset lifts the deadline (contract §Funktionen 3).
    """
    config_id = await _config(service, "Requeue", skip_policy="requeue_later")
    state = await _run(service, name="requeue-deadline", config_id=config_id)

    for _ in range(8):                          # seqs 1..8 — natural ends
        await runs.advance(service.session, state,
                           reason=AdvanceReason.TRACK_ENDED)
    skipped_track = state.order[8]
    await runs.advance(service.session, state, reason=AdvanceReason.USER_SKIP)
    skip_seq = (await db.get_run(state.run_id))["selection_seq"]
    assert skip_seq == 9
    card = await db.find_run_track(state.run_id, provider_track_id=skipped_track)
    assert card["state"] == "deferred"

    for _ in range(20):                         # play the cycle out
        if (await db.get_run(state.run_id))["status"] == "completed":
            break
        await runs.advance(service.session, state,
                           reason=AdvanceReason.TRACK_ENDED)
    assert (await db.get_run(state.run_id))["status"] == "completed"

    # The deadline: every consumption after the skip happens >= 10 draws
    # later — this cycle has no room for that, so there must be none at all.
    cur = await database.execute(
        "SELECT seq FROM run_selections WHERE run_id = ? AND run_track_id = ? "
        "AND seq > ?", (state.run_id, card["id"], skip_seq))
    comebacks = [row[0] for row in await cur.fetchall()]
    assert all(
        seq - skip_seq >= REQUEUE_AFTER_DRAWS for seq in comebacks
    ), comebacks

    final = await db.find_run_track(state.run_id, provider_track_id=skipped_track)
    assert final["state"] == "deferred"             # parked, not burnt …
    assert final["play_count"] == 0
    assert final["last_played_seq"] == skip_seq     # … the deferral stamped

    # F2: the next cycle lifts the deadline — the card comes back openly.
    await runs.reset_run(service.session, state)
    reopened = await db.find_run_track(
        state.run_id, provider_track_id=skipped_track
    )
    assert reopened["state"] == "open"
    assert reopened["last_played_seq"] is None
    assert skipped_track in state.order


async def test_keep_open_skip_stamps_the_touch_for_the_gap_check(database, service):
    """RUN-06 × P2: a keep_open skip stamps ``last_played_seq`` (skip-touch
    convention) while the card stays open and unconsumed — ``state`` is
    consumption, ``last_played_seq`` is listening history (contract
    §Datentypen), and the skipped title WAS just offered to the ear.

    Productive effect over the real path: in a replan where every card is
    gap-blocked, the F6 ladder prefers the least recently heard card — the
    just-skipped title comes back LAST.  Regression: without the stamp the
    skipped card looked box-fresh and the replanned tail opened with exactly
    the title the user just skipped away.
    """
    config_id = await _config(service, "KeepOpen Gap", skip_policy="keep_open")
    state = await _run(service, name="keep-open-gap", config_id=config_id)

    for _ in range(10):                         # seqs 1..10 — natural ends
        await runs.advance(service.session, state,
                           reason=AdvanceReason.TRACK_ENDED)
    skipped_track = state.order[10]
    await runs.advance(service.session, state, reason=AdvanceReason.USER_SKIP)
    card = await db.find_run_track(state.run_id, provider_track_id=skipped_track)
    assert card["state"] == "open"              # NOT consumed (P1) …
    assert card["play_count"] == 0              # … and no play counted

    # Every other card carries a played history; min_gap=20 blocks them all,
    # so the ladder must order the tail by "longest not heard" (deterministic:
    # each relaxation step frees exactly the oldest card).
    await runs.change_run_rules(
        state, {"repeat_mode": "free_repeat", "min_gap": 20}
    )
    tail = state.order[12:]
    assert len(tail) == 11
    assert tail[0] != skipped_track             # never right back …
    assert tail[-1] == skipped_track            # … but last of the rotation
    assert card["last_played_seq"] == 11        # the skip stamped the touch


# ---------------------------------------------------------------------------
# MAN-01 / F8 — the manual-use state machine (time injected)
# ---------------------------------------------------------------------------

async def test_f8_auto_resume_reasserts_the_window(database, service):
    state = await _run(service, name="auto-resume")  # legacy preset: auto_resume
    await runs.start(service.session, state, device_id="dev1")
    plays_before = len(service.provider.play_windows)

    assert await runs.manual_tick(
        service.session, state, drifted=True, now=1_000.0
    ) == runs.MANUAL_DETECTED
    run = await db.get_run(state.run_id)
    assert run["manual_state"] == "manual_detected"
    assert run["manual_since"]
    # Observation only: detection sends no command.
    assert len(service.provider.play_windows) == plays_before

    # Playback returns to the plan → auto_resume re-asserts the window.
    assert await runs.manual_tick(
        service.session, state, drifted=False, now=1_010.0
    ) == runs.MANUAL_NONE
    run = await db.get_run(state.run_id)
    assert run["manual_state"] == "none" and run["manual_since"] is None
    assert run["status"] == "active"
    assert len(service.provider.play_windows) == plays_before + 1

    events = [e["type"] for e in await db.list_events(state.run_id)]
    assert "manual_detected" in events and "manual_resumed" in events


async def test_f8_auto_pause_pauses_without_commands(database, service):
    config_id = await _config(service, "AutoPause",
                              manual_use_policy="auto_pause")
    state = await _run(service, name="auto-pause", config_id=config_id)
    await runs.start(service.session, state, device_id="dev1")
    plays_before = len(service.provider.play_windows)

    await runs.manual_tick(service.session, state, drifted=True, now=2_000.0)
    await runs.manual_tick(service.session, state, drifted=False, now=2_030.0)

    run = await db.get_run(state.run_id)
    assert run["status"] == "paused"
    assert run["manual_state"] == "none"
    assert len(service.provider.play_windows) == plays_before  # no takeover
    events = [e["type"] for e in await db.list_events(state.run_id)]
    assert "manual_paused" in events


async def test_f8_ask_awaits_the_decision_and_the_api_resolves_it(
    database, service
):
    config_id = await _config(service, "Ask", manual_use_policy="ask")
    state = await _run(service, name="ask", config_id=config_id)
    await runs.start(service.session, state, device_id="dev1")

    await runs.manual_tick(service.session, state, drifted=True, now=3_000.0)
    assert await runs.manual_tick(
        service.session, state, drifted=False, now=3_040.0
    ) == runs.MANUAL_AWAITING
    run = await db.get_run(state.run_id)
    assert run["manual_state"] == "awaiting_decision"   # UX-Zustand C
    assert run["status"] == "active"                    # held, not paused

    # Holding: further observations change nothing until the listener decides.
    assert await runs.manual_tick(
        service.session, state, drifted=False, now=3_050.0
    ) == runs.MANUAL_AWAITING

    plays_before = len(service.provider.play_windows)
    result = await runs.manual_decision(
        service.session, state.run_id, service.user_id, "resume"
    )
    assert result["status"] == "active"
    assert result["manual_state"] == "none"
    assert len(service.provider.play_windows) == plays_before + 1
    run = await db.get_run(state.run_id)
    assert run["manual_state"] == "none"
    events = [e["type"] for e in await db.list_events(state.run_id)]
    assert "manual_awaiting_decision" in events and "manual_resumed" in events

    # A decision without a question is a 409-shaped refusal.
    with pytest.raises(engine.RunError):
        await runs.manual_decision(
            service.session, state.run_id, service.user_id, "pause"
        )


async def test_f8_ask_decision_pause_keeps_the_position(database, service):
    config_id = await _config(service, "Ask2", manual_use_policy="ask")
    state = await _run(service, name="ask-pause", config_id=config_id)
    await runs.start(service.session, state, device_id="dev1")
    await runs.advance(service.session, state, reason=AdvanceReason.TRACK_ENDED)

    await runs.manual_tick(service.session, state, drifted=True, now=4_000.0)
    await runs.manual_tick(service.session, state, drifted=False, now=4_010.0)
    result = await runs.manual_decision(
        service.session, state.run_id, service.user_id, "pause"
    )
    assert result["status"] == "paused"
    run = await db.get_run(state.run_id)
    assert run["status"] == "paused" and run["manual_state"] == "none"
    assert run["cursor"] == 1                       # the position survived
    events = [e["type"] for e in await db.list_events(state.run_id)]
    assert "manual_paused" in events


async def test_f8_timeout_suspends_the_run(database, service):
    config_id = await _config(service, "Kurz", manual_wait_seconds=100)
    state = await _run(service, name="timeout", config_id=config_id)
    await runs.start(service.session, state, device_id="dev1")

    await runs.manual_tick(service.session, state, drifted=True, now=5_000.0)
    # Still inside the window: nothing happens.
    assert await runs.manual_tick(
        service.session, state, drifted=True, now=5_090.0
    ) == runs.MANUAL_DETECTED
    # Past manual_wait_seconds of continuous foreign playback → suspended.
    assert await runs.manual_tick(
        service.session, state, drifted=True, now=5_101.0
    ) == runs.MANUAL_SUSPENDED

    run = await db.get_run(state.run_id)
    assert run["status"] == "paused"
    assert run["manual_state"] == "suspended"
    events = [e["type"] for e in await db.list_events(state.run_id)]
    assert "manual_suspended" in events

    # The way back: resume + start clears the manual episode (F8).
    await runs.resume_run(service.session, state.run_id)
    fresh = await runs.get_state(state.run_id, service.user_id)
    await runs.start(service.session, fresh, device_id="dev1")
    run = await db.get_run(state.run_id)
    assert run["status"] == "active" and run["manual_state"] == "none"


# ---------------------------------------------------------------------------
# UC-27 — run-local rule change: versioned, effective-from, history untouched
# ---------------------------------------------------------------------------

async def test_rule_change_takes_effect_from_the_next_selection(
    database, service
):
    state = await _run(service, name="regeln")
    legacy_hash = Rules().rules_hash()

    # Draw 1 under the old rules: a user skip consumes.
    first_track = state.order[0]
    await runs.advance(service.session, state, reason=AdvanceReason.USER_SKIP)
    assert (await db.find_run_track(
        state.run_id, provider_track_id=first_track))["state"] == "played"

    result = await runs.change_run_rules(state, {"skip_policy": "keep_open"})
    assert result["effective_from_seq"] == 2
    assert result["rules"]["skip_policy"] == "keep_open"
    assert result["replanned"] == 10                # 12 - played - current
    run = await db.get_run(state.run_id)
    assert run["plan_version"] == 2
    # The run's preset was NOT mutated — the change lives in a run-local
    # container (F7: presets stay transferable).
    preset = await db.get_config(run["config_id"])
    assert json.loads(preset["rules_json"])["skip_policy"] == "consume"
    binding = await db.latest_rule_binding(state.run_id, 2)
    assert binding is not None
    assert binding["rules_hash"] == result["rules_hash"]
    assert binding["effective_from_seq"] == 2
    # Before the change (seq 1) no binding applies — the config governed.
    assert await db.latest_rule_binding(state.run_id, 1) is None

    # Draw 2 follows the NEW rules: the skipped card stays open.
    second_track = state.order[1]
    await runs.advance(service.session, state, reason=AdvanceReason.USER_SKIP)
    card = await db.find_run_track(state.run_id, provider_track_id=second_track)
    assert card["state"] == "open" and card["play_count"] == 0

    # History untouched: selection 1 keeps the old version's hash, and the
    # new selection records the new one (reproducibility invariant).
    cur = await database.execute(
        "SELECT seq, rules_hash FROM run_selections WHERE run_id = ? ORDER BY seq",
        (state.run_id,),
    )
    rows = [dict(r) for r in await cur.fetchall()]
    assert rows[0]["seq"] == 1 and rows[0]["rules_hash"] == legacy_hash
    assert rows[1]["seq"] == 2 and rows[1]["rules_hash"] == result["rules_hash"]
    assert rows[0]["rules_hash"] != rows[1]["rules_hash"]

    # The discarded tail is evidence, not garbage (RUN-04/05): 10 future rows
    # were discarded (12 minus the consumed row 0 and the current row 1).
    assert await _one(
        database,
        "SELECT count(*) FROM run_plan WHERE run_id = ? AND state = 'discarded'",
        (state.run_id,),
    ) == 10


async def test_rule_change_refuses_nonsense(database, service):
    state = await _run(service, name="unfug")
    with pytest.raises(ValueError):
        await runs.change_run_rules(state, {"skip_policy": "yolo"})
    with pytest.raises(ValueError):
        await runs.change_run_rules(state, {"unknown_key": 1})
    # Nothing was half-applied.
    assert (await db.get_run(state.run_id))["plan_version"] == 1


# ---------------------------------------------------------------------------
# P4 through the service — favourite weighting, deterministic seed check
# ---------------------------------------------------------------------------

async def test_favorite_weighting_changes_the_replanned_tail_deterministically(
    database, service
):
    """No statistics: same seed, same deck, same seq — the only difference is
    the favourite flag, and the tail must (a) change and (b) equal the pure
    engine's own answer, draw for draw.  The property run (WP3-E) owns the
    statistical claims about HOW favourites shift."""
    state = await _run(service, name="fav")
    await database.execute(
        "UPDATE runs SET seed = 424242 WHERE id = ?", (state.run_id,))
    await database.commit()

    baseline = await runs.change_run_rules(state, {"favorite_weight": 8.0})
    assert baseline["replanned"] == 11
    plan_before = await db.list_active_plan(state.run_id)
    tail_before = [r["run_track_id"] for r in plan_before[1:]]

    # Favour one specific card from the middle of the tail.
    favorite_rt = tail_before[5]
    marked = await runs.mark_favorite(
        service.user_id, state.run_id, favorite_rt, True
    )
    assert marked == {"run_id": state.run_id, "run_track_id": favorite_rt,
                      "favorite": True}

    # Same rules again → same seeds, same seq — only the flag differs.
    await runs.change_run_rules(state, {"favorite_weight": 8.0})
    plan_after = await db.list_active_plan(state.run_id)
    tail_after = [r["run_track_id"] for r in plan_after[1:]]
    assert sorted(tail_after) == sorted(tail_before)   # same cards …
    assert tail_after != tail_before                   # … different order

    # Reproduce the tail with the pure engine — byte-for-byte.
    run = await db.get_run(state.run_id)
    deck = await db.list_run_tracks(
        state.run_id, states=["open", "played", "deferred"], admitted_only=True
    )
    current_rt = plan_after[0]["run_track_id"]
    rules = Rules(favorite_weight=8.0)
    sim = {
        int(r["id"]): Candidate(
            run_track_id=int(r["id"]),
            track_key=f"fake:{r['provider_track_id']}",
            state=r["state"], play_count=r["play_count"],
            last_played_seq=r["last_played_seq"],
            favorite=bool(r["favorite"]), weight=float(r["weight"]),
        )
        for r in deck if int(r["id"]) != current_rt
    }
    expected = []
    window: list[int] = []
    step = 0
    while len(expected) < len(sim):
        share = sum(window[-QUOTA_WINDOW:]) / float(QUOTA_WINDOW)
        selection = select_next(list(sim.values()), rules, int(run["seed"]),
                                int(run["selection_seq"]) + 1 + step,
                                recent_repeat_share=share)
        step += 1
        if selection.exhausted or selection.run_track_id is None:
            break
        chosen = sim[selection.run_track_id]
        window.append(1 if chosen.state == "played" else 0)
        sim[chosen.run_track_id] = replace(
            chosen, state="played", play_count=chosen.play_count + 1,
            last_played_seq=int(run["selection_seq"]) + step,
        )
        expected.append(chosen.run_track_id)
    assert tail_after == expected


# ---------------------------------------------------------------------------
# RUN-08 — exclude / reactivate with immediate effect
# ---------------------------------------------------------------------------

async def test_exclude_and_reactivate_take_effect_immediately(database, service):
    state = await _run(service, name="bann")
    victim_track = state.order[5]
    card = await db.find_run_track(state.run_id, provider_track_id=victim_track)

    result = await runs.set_track_exclusion(state, int(card["id"]), True)
    assert result["excluded"] is True and result["replanned"] == 10
    fresh = await db.get_run(state.run_id)
    assert victim_track not in fresh["order"][1:]   # gone from the remainder
    assert len(fresh["order"]) == 11
    assert (await db.find_run_track(
        state.run_id, run_track_id=int(card["id"])))["state"] == "excluded_user"

    # Excluding twice is idempotent, not an error.
    again = await runs.set_track_exclusion(state, int(card["id"]), True)
    assert again["replanned"] == 0

    # Reactivate: the title re-enters the remaining order NOW (UC-21).
    back = await runs.set_track_exclusion(state, int(card["id"]), False)
    assert back["excluded"] is False and back["replanned"] == 11
    fresh = await db.get_run(state.run_id)
    assert victim_track in fresh["order"]
    assert len(fresh["order"]) == 12
    events = [e["type"] for e in await db.list_events(state.run_id)]
    assert "track_excluded" in events and "track_reactivated" in events


async def test_import_exclusions_are_not_user_revocable(database, service):
    """UC-20/21 edge: 'excluded_rule' cards (import verdicts) are no user
    exclusions — only a sync that makes the entry playable again re-opens
    them (ERR-06), never this endpoint."""
    state = await _run(service, name="regel-bann")
    # Forge an import exclusion the way record_skipped writes them.
    await database.execute(
        "INSERT INTO tracks (provider, provider_track_id) VALUES ('fake', 'tx')")
    cur = await database.execute(
        "SELECT id FROM tracks WHERE provider = 'fake' AND provider_track_id = 'tx'")
    track_pk = int((await cur.fetchone())[0])
    cur = await database.execute(
        "INSERT INTO run_tracks (run_id, track_id, state, admitted, "
        "excluded_reason) VALUES (?, ?, 'excluded_rule', 0, 'not_playable')",
        (state.run_id, track_pk))
    rt_id = int(cur.lastrowid)
    await database.commit()

    with pytest.raises(engine.RunError):
        await runs.set_track_exclusion(state, rt_id, False)
    with pytest.raises(engine.RunError):
        await runs.set_track_exclusion(state, rt_id, True)


# ---------------------------------------------------------------------------
# RUN-09/10 — apply_sync_to_run: three policies, removed, re-added, idempotent
# ---------------------------------------------------------------------------

async def _synced_diff(service: Service) -> dict:
    """Import → mutate provider → import again → diff (the RUN-09 walk)."""
    imported = await library_service.import_playlist(
        service.session, service.playlist
    )
    diff = await library_service.compute_sync_diff(imported["playlist_id"])
    assert diff is not None
    return diff


async def test_apply_sync_include_now_adds_and_removes(database, service):
    await library_service.import_playlist(service.session, service.playlist)
    config_id = await _config(service, "Sync now",
                              new_tracks_policy="include_now")
    state = await _run(service, name="sync-now", config_id=config_id)
    assert len(state.order) == 12

    removed_track = service.provider.tracks[3].id
    del service.provider.tracks[3]
    service.provider.tracks.append(
        Track(provider="fake", id="t99", name="Neu", artist="A",
              duration_ms=1000)
    )
    diff = await _synced_diff(service)

    result = await library_service.apply_sync_to_run(
        state.run_id, diff_id=diff["diff_id"], user_id=service.user_id,
    )
    assert result["added"] == 1
    assert result["removed"] == 1
    assert result["policy"] == "include_now"
    assert result["replanned"] > 0

    run = await db.get_run(state.run_id)
    assert run["snapshot_id"] == diff["to_snapshot_id"]
    assert "t99" in run["order"]                        # mixed in NOW
    assert removed_track not in run["order"][1:]        # out of the remainder
    new_card = await db.find_run_track(state.run_id, provider_track_id="t99")
    assert new_card["admitted"] == 1
    assert new_card["added_in_cycle"] == 1
    old_card = await db.find_run_track(
        state.run_id, provider_track_id=removed_track)
    assert old_card["removed_from_snapshot"] == 1       # history stays (UC-04)
    assert await _one(
        database,
        "SELECT applied_at FROM snapshot_diffs WHERE id = ?",
        (diff["diff_id"],),
    ) is not None


async def test_apply_sync_after_cycle_parks_the_card_for_the_next_cycle(
    database, service
):
    await library_service.import_playlist(service.session, service.playlist)
    config_id = await _config(service, "Sync später",
                              new_tracks_policy="after_cycle")
    state = await _run(service, name="sync-später", config_id=config_id)

    service.provider.tracks.append(
        Track(provider="fake", id="t77", name="Später", artist="A",
              duration_ms=1000)
    )
    diff = await _synced_diff(service)
    result = await library_service.apply_sync_to_run(
        state.run_id, diff_id=diff["diff_id"], user_id=service.user_id,
    )
    assert result["added"] == 1 and result["replanned"] == 0

    card = await db.find_run_track(state.run_id, provider_track_id="t77")
    assert card["admitted"] == 0
    assert card["added_in_cycle"] == 2                  # parked for cycle 2
    run = await db.get_run(state.run_id)
    assert "t77" not in run["order"]                    # not in THIS cycle

    # F2 reset starts cycle 2 — now the card joins the deck (UC-25).
    summary = await runs.reset_run(service.session, state)
    assert summary["cycle"] == 2 and summary["total"] == 13
    assert "t77" in (await db.get_run(state.run_id))["order"]


async def test_apply_sync_ignore_creates_nothing(database, service):
    await library_service.import_playlist(service.session, service.playlist)
    state = await _run(service, name="sync-ignore")   # legacy preset: ignore

    service.provider.tracks.append(
        Track(provider="fake", id="t55", name="Nie", artist="A",
              duration_ms=1000)
    )
    diff = await _synced_diff(service)
    result = await library_service.apply_sync_to_run(
        state.run_id, diff_id=diff["diff_id"], user_id=service.user_id,
    )
    assert result["added"] == 0 and result["policy"] == "ignore"
    assert await db.find_run_track(
        state.run_id, provider_track_id="t55") is None  # gar nicht angelegt
    # The run still moved to the new snapshot — the library is current, the
    # deck deliberately is not.
    assert (await db.get_run(state.run_id))["snapshot_id"] == diff["to_snapshot_id"]


async def test_apply_sync_is_idempotent(database, service):
    await library_service.import_playlist(service.session, service.playlist)
    config_id = await _config(service, "Sync idem",
                              new_tracks_policy="include_now")
    state = await _run(service, name="sync-idem", config_id=config_id)
    service.provider.tracks.append(
        Track(provider="fake", id="t42", name="Einmal", artist="A",
              duration_ms=1000)
    )
    diff = await _synced_diff(service)

    first = await library_service.apply_sync_to_run(
        state.run_id, diff_id=diff["diff_id"], user_id=service.user_id,
    )
    second = await library_service.apply_sync_to_run(
        state.run_id, diff_id=diff["diff_id"], user_id=service.user_id,
    )
    assert second["already_applied"] is True
    assert second["added"] == first["added"] == 1
    # Exactly one card — the replay created nothing.
    assert await _one(
        database,
        "SELECT count(*) FROM run_tracks rt JOIN tracks t ON t.id = rt.track_id "
        "WHERE rt.run_id = ? AND t.provider_track_id = 't42'",
        (state.run_id,),
    ) == 1


async def test_apply_sync_readded_reopens_under_retry_policy(database, service):
    """ERR-06 / RUN-09: a title that comes back into the market re-enters the
    run on the next cycle — but only under unplayable_policy='retry_next_cycle'."""
    service.provider.tracks.append(
        Track(provider="fake", id="tback", name="Wieder da", artist="A",
              duration_ms=1000, is_playable=False)
    )
    await library_service.import_playlist(service.session, service.playlist)
    config_id = await _config(service, "Retry",
                              unplayable_policy="retry_next_cycle")
    state = await _run(service, name="retry", config_id=config_id)
    assert len(state.order) == 12                     # tback excluded on entry
    assert (await db.find_run_track(
        state.run_id, provider_track_id="tback"))["state"] == "excluded_rule"

    service.provider.tracks[-1] = Track(
        provider="fake", id="tback", name="Wieder da", artist="A",
        duration_ms=1000, is_playable=True,
    )
    diff = await _synced_diff(service)
    result = await library_service.apply_sync_to_run(
        state.run_id, diff_id=diff["diff_id"], user_id=service.user_id,
    )
    assert result["reopened"] == 1

    card = await db.find_run_track(state.run_id, provider_track_id="tback")
    assert card["state"] == "open"
    assert card["admitted"] == 0                      # NEXT cycle, not this one
    assert card["added_in_cycle"] == 2

    summary = await runs.reset_run(service.session, state)
    assert summary["total"] == 13
    assert "tback" in (await db.get_run(state.run_id))["order"]


async def test_apply_sync_readded_after_removal_restores_the_same_card(
    database, service
):
    """RUN-09: removed → re-added keeps ONE card and its history."""
    await library_service.import_playlist(service.session, service.playlist)
    config_id = await _config(service, "Zurück",
                              new_tracks_policy="include_now")
    state = await _run(service, name="zurück", config_id=config_id)
    victim = service.provider.tracks[2]

    # Simulate played history on the victim's card.
    card = await db.find_run_track(state.run_id, provider_track_id=victim.id)
    await db.set_run_track(int(card["id"]), state="played", last_played_seq=0)
    await database.execute(
        "UPDATE run_tracks SET play_count = 3 WHERE id = ?", (int(card["id"]),))
    await database.commit()

    del service.provider.tracks[2]
    diff = await _synced_diff(service)
    await library_service.apply_sync_to_run(
        state.run_id, diff_id=diff["diff_id"], user_id=service.user_id,
    )
    assert (await db.find_run_track(
        state.run_id, run_track_id=int(card["id"])))["removed_from_snapshot"] == 1

    service.provider.tracks.insert(2, victim)
    diff2 = await _synced_diff(service)
    result = await library_service.apply_sync_to_run(
        state.run_id, diff_id=diff2["diff_id"], user_id=service.user_id,
    )
    assert result["added"] == 1

    restored = await db.find_run_track(state.run_id, run_track_id=int(card["id"]))
    assert restored["removed_from_snapshot"] == 0     # the SAME card is back
    assert restored["play_count"] == 3                # history intact
    assert await _one(
        database,
        "SELECT count(*) FROM run_tracks rt JOIN tracks t ON t.id = rt.track_id "
        "WHERE rt.run_id = ? AND t.provider_track_id = ?",
        (state.run_id, victim.id),
    ) == 1                                            # no duplicate card


async def test_apply_sync_refuses_a_foreign_diff(database, service):
    """A diff of ANOTHER playlist must never partially apply (RUN-10)."""
    state = await _run(service, name="fremd")
    with pytest.raises(engine.RunError):
        await library_service.apply_sync_to_run(
            state.run_id, diff_id=12345, user_id=service.user_id,
        )


# ---------------------------------------------------------------------------
# UC-28/29 / F7 — configs travel, track-bound rules do not
# ---------------------------------------------------------------------------

async def test_config_applies_to_another_playlist_without_track_rules(
    database, service
):
    config_id = await _config(service, "Wanderconfig", favorite_weight=5.0)
    state_a = await _run(service, name="A", config_id=config_id)

    # Track-bound facts on run A: a favourite and a user exclusion.
    card = await db.find_run_track(
        state_a.run_id, provider_track_id=state_a.order[1])
    await runs.mark_favorite(service.user_id, state_a.run_id,
                             int(card["id"]), True)
    banned = await db.find_run_track(
        state_a.run_id, provider_track_id=state_a.order[2])
    await runs.set_track_exclusion(state_a, int(banned["id"]), True)

    playlist_b = PlaylistRef(provider="fake", id="pl2", name="Zweite Playlist",
                             track_count=12)
    state_b, _ = await runs.create_run_v3(
        service.session, playlist_b, RunMode.CONTROLLER,
        name="B", config_id=config_id,
    )
    assert (await db.get_run(state_b.run_id))["config_id"] == config_id
    assert len(state_b.order) == 12                   # nothing pre-excluded

    # F7/UC-29 pinned: favourites and exclusions did NOT travel.
    assert await _one(
        database,
        "SELECT count(*) FROM run_tracks WHERE run_id = ? AND favorite = 1",
        (state_b.run_id,),
    ) == 0
    assert await _one(
        database,
        "SELECT count(*) FROM run_tracks WHERE run_id = ? "
        "AND state = 'excluded_user'",
        (state_b.run_id,),
    ) == 0


# ---------------------------------------------------------------------------
# API contracts (TestClient, fake connector — same walk as test_api.py)
# ---------------------------------------------------------------------------

def _connect(client):
    from itsdangerous import TimestampSigner

    from app.config import get_settings

    client.get("/auth/fake/login", follow_redirects=False)
    cookie = client.cookies.get("session")
    data = TimestampSigner(get_settings().secret_key).unsign(cookie, max_age=3600)
    oauth_state = json.loads(base64.urlsafe_b64decode(data))["oauth_state"]
    client.get("/auth/fake/callback",
               params={"code": "c", "state": oauth_state},
               follow_redirects=False)


def _wait_for_job(client, job_id: str) -> dict:
    deadline = time.time() + 10
    while time.time() < deadline:
        snap = client.get(f"/api/jobs/{job_id}").json()
        if snap["status"] == "done":
            return snap["result"]
        if snap["status"] == "error":
            pytest.fail(f"job failed: {snap['message']}")
        time.sleep(0.05)
    pytest.fail("job did not finish in time")


def test_configs_api_crud_duplicate_and_preflight(fake_provider):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        _connect(client)

        # Create (UC-07/10).
        created = client.post("/api/configs", json={
            "name": "Meine Regeln", "rules": {"skip_policy": "keep_open"},
        })
        assert created.status_code == 201, created.text
        config = created.json()
        assert config["rules"]["skip_policy"] == "keep_open"
        assert config["current_version"] == 1

        # A taken name answers 409, invalid rules answer 400.
        assert client.post("/api/configs", json={
            "name": "Meine Regeln"}).status_code == 409
        assert client.post("/api/configs", json={
            "name": "Kaputt", "rules": {"skip_policy": "yolo"},
        }).status_code == 400
        assert client.post("/api/configs", json={
            "name": "Kaputt", "rules": {"nope": 1},
        }).status_code == 400

        # PATCH freezes a NEW version (UC-27, preset side).
        patched = client.patch(f"/api/configs/{config['id']}", json={
            "rules": {"min_gap": 3, "repeat_mode": "free_repeat"},
        }).json()
        assert patched["current_version"] == 2
        assert patched["rules"]["min_gap"] == 3
        assert patched["rules"]["skip_policy"] == "keep_open"  # merge, not reset
        assert patched["rules_hash"] != config["rules_hash"]

        # Duplicate (UC-28): ancestry recorded, fresh version 1.
        copy = client.post(f"/api/configs/{config['id']}/duplicate").json()
        assert copy["origin_config_id"] == config["id"]
        assert copy["name"] == "Meine Regeln (Kopie)"
        assert copy["current_version"] == 1
        assert copy["rules"] == patched["rules"]      # current rules travelled

        listed = client.get("/api/configs").json()["configs"]
        names = {c["name"] for c in listed}
        assert {"Meine Regeln", "Meine Regeln (Kopie)"} <= names

        # Preflight (RUN-05): concrete corrections before the run starts.
        answer = client.post("/api/runs/preflight", json={
            "provider": "fake", "playlist_id": "pl1",
            "rules": {"min_gap": 20, "repeat_mode": "free_repeat"},
            "track_count": 8,
        }).json()
        codes = {c["code"]: c for c in answer["conflicts"]}
        assert "min_gap_unsatisfiable" in codes
        assert codes["min_gap_unsatisfiable"]["suggestion"] == 7
        assert answer["candidate_count"] == 8
        assert answer["candidate_source"] == "hint"


def test_manual_decision_api_contract(fake_provider):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        _connect(client)
        response = client.post("/api/runs", json={
            "provider": "fake", "playlist_id": "pl1", "mode": "controller",
        })
        run_id = _wait_for_job(client, response.json()["job_id"])["run_id"]

        # The player learns the state from the run payload (UX-Zustand C).
        payload = client.get(f"/api/runs/{run_id}").json()
        assert payload["manual_state"] == "none"

        # Invalid action → 400; no pending question → 409.
        assert client.post(f"/api/runs/{run_id}/manual-decision",
                           json={"action": "later"}).status_code == 400
        assert client.post(f"/api/runs/{run_id}/manual-decision",
                           json={"action": "resume"}).status_code == 409


def test_run_rules_and_track_actions_api_contract(fake_provider):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        _connect(client)
        response = client.post("/api/runs", json={
            "provider": "fake", "playlist_id": "pl1", "mode": "controller",
        })
        run_id = _wait_for_job(client, response.json()["job_id"])["run_id"]

        # UC-27 over the wire.
        changed = client.post(f"/api/runs/{run_id}/rules", json={
            "rules": {"skip_policy": "defer_to_end"},
        })
        assert changed.status_code == 200, changed.text
        assert changed.json()["rules"]["skip_policy"] == "defer_to_end"
        assert client.post(f"/api/runs/{run_id}/rules", json={
            "rules": {"skip_policy": "nope"}}).status_code == 400
        assert client.post(f"/api/runs/{run_id}/rules",
                           json={}).status_code == 400

        # The run payload names the deck card behind each visible row.
        payload = client.get(f"/api/runs/{run_id}").json()
        upcoming = payload["upcoming"]
        assert upcoming and all("run_track_id" in e for e in upcoming)
        target = upcoming[0]

        # Favourite round trip (UC-08).
        marked = client.post(
            f"/api/runs/{run_id}/tracks/{target['run_track_id']}/favorite")
        assert marked.status_code == 200
        assert marked.json()["favorite"] is True
        unmarked = client.delete(
            f"/api/runs/{run_id}/tracks/{target['run_track_id']}/favorite")
        assert unmarked.json()["favorite"] is False

        # Exclude / reactivate round trip (UC-20/21, RUN-08).
        excluded = client.post(
            f"/api/runs/{run_id}/tracks/{target['run_track_id']}/exclude")
        assert excluded.status_code == 200
        fresh = client.get(f"/api/runs/{run_id}").json()
        assert all(e["run_track_id"] != target["run_track_id"]
                   for e in fresh["upcoming"])
        restored = client.delete(
            f"/api/runs/{run_id}/tracks/{target['run_track_id']}/exclude")
        assert restored.status_code == 200
        assert restored.json()["excluded"] is False

        # A card that does not exist in this run is a 404.
        assert client.post(
            f"/api/runs/{run_id}/tracks/999999/favorite").status_code == 404
