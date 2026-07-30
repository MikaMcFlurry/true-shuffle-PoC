"""Persistence: schema, the live-run constraint, and ownership."""

from __future__ import annotations

import aiosqlite
import pytest

from app import db
from app.crypto import TokenVault

# pytest-asyncio auto mode (pyproject.toml) marks async tests automatically.


async def test_init_creates_the_v2_schema(database):
    cur = await database.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    tables = {row[0] for row in await cur.fetchall()}
    assert {"users", "provider_accounts", "runs", "run_events",
            "skipped_tracks", "jobs"} <= tables


async def test_get_db_before_init_raises():
    await db.close_db()
    with pytest.raises(RuntimeError):
        db.get_db()


# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------

async def test_one_user_can_connect_several_services(database):
    user_id = await db.get_or_create_user("local-1")
    for provider in ("spotify", "apple", "youtube"):
        await db.upsert_provider_account(
            user_id=user_id, provider=provider, provider_user_id=f"{provider}-id",
            display_name=provider.title(), market="DE", product_tier="premium",
            token={"access_token": f"{provider}-token"},
        )
    accounts = await db.list_provider_accounts(user_id)
    assert {a["provider"] for a in accounts} == {"spotify", "apple", "youtube"}


async def test_reconnecting_replaces_credentials_rather_than_duplicating(database):
    user_id = await db.get_or_create_user("local-1")
    for token in ("first", "second"):
        await db.upsert_provider_account(
            user_id=user_id, provider="spotify", provider_user_id="u",
            display_name="U", market="DE", product_tier="premium",
            token={"access_token": token},
        )
    assert len(await db.list_provider_accounts(user_id)) == 1
    account = await db.get_provider_account(user_id, "spotify")
    assert account["token"]["access_token"] == "second"


async def test_tokens_are_encrypted_on_disk(database, tmp_path):
    user_id = await db.get_or_create_user("local-1")
    await db.upsert_provider_account(
        user_id=user_id, provider="spotify", provider_user_id="u",
        display_name="U", market="DE", product_tier="premium",
        token={"access_token": "plaintext-would-leak"},
    )

    cur = await database.execute("SELECT token_blob FROM provider_accounts")
    blob = (await cur.fetchone())[0]
    assert "plaintext-would-leak" not in blob
    assert TokenVault.is_sealed(blob)


async def test_account_listing_never_returns_credentials(database):
    user_id = await db.get_or_create_user("local-1")
    await db.upsert_provider_account(
        user_id=user_id, provider="spotify", provider_user_id="u",
        display_name="U", market="DE", product_tier="premium",
        token={"access_token": "secret"},
    )
    for account in await db.list_provider_accounts(user_id):
        assert "token" not in account
        assert "token_blob" not in account


async def test_disconnecting_removes_the_account(database):
    user_id = await db.get_or_create_user("local-1")
    await db.upsert_provider_account(
        user_id=user_id, provider="spotify", provider_user_id="u",
        display_name="U", market="", product_tier="", token={"access_token": "t"},
    )
    await db.delete_provider_account(user_id, "spotify")
    assert await db.get_provider_account(user_id, "spotify") is None


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

async def make_run(user_id: int, **kw) -> int:
    params = dict(
        user_id=user_id, provider="spotify", playlist_id="pl1",
        playlist_name="Everything", mode="controller", order=["a", "b", "c"],
    )
    params.update(kw)
    return await db.create_run(**params)


async def test_only_one_live_run_per_playlist_and_mode(database):
    """Two live decks for the same playlist would mean two conflicting orders."""
    user_id = await db.get_or_create_user("local-1")
    await make_run(user_id)
    with pytest.raises(aiosqlite.IntegrityError):
        await make_run(user_id)


async def test_many_completed_runs_of_the_same_playlist_are_allowed(database):
    """The old UNIQUE(user, playlist, mode, status) made a second finished run
    impossible — you could never listen to the same playlist twice."""
    user_id = await db.get_or_create_user("local-1")
    for _ in range(3):
        await make_run(user_id, status="completed")
    runs = await db.list_runs(user_id)
    assert len(runs) == 3


async def test_a_cancelled_run_frees_the_slot(database):
    user_id = await db.get_or_create_user("local-1")
    run_id = await make_run(user_id)
    await db.close_live_runs(user_id, "spotify", "pl1", "controller")
    assert await make_run(user_id) != run_id


async def test_the_same_playlist_can_run_on_two_services_at_once(database):
    user_id = await db.get_or_create_user("local-1")
    await make_run(user_id, provider="spotify")
    await make_run(user_id, provider="apple")
    assert len(await db.list_runs(user_id)) == 2


async def test_find_live_run_returns_active_and_paused(database):
    user_id = await db.get_or_create_user("local-1")
    run_id = await make_run(user_id, status="paused")
    found = await db.find_live_run(user_id, "spotify", "pl1", "controller")
    assert found is not None and found["id"] == run_id


async def test_find_live_run_ignores_finished_decks(database):
    user_id = await db.get_or_create_user("local-1")
    await make_run(user_id, status="completed")
    assert await db.find_live_run(user_id, "spotify", "pl1", "controller") is None


async def test_a_run_is_only_visible_to_its_owner(database):
    """Ownership is part of the query, not an afterthought."""
    owner = await db.get_or_create_user("local-owner")
    stranger = await db.get_or_create_user("local-stranger")
    run_id = await make_run(owner)

    assert await db.get_run(run_id, user_id=owner) is not None
    assert await db.get_run(run_id, user_id=stranger) is None


async def test_completing_a_run_stamps_completed_at(database):
    user_id = await db.get_or_create_user("local-1")
    run_id = await make_run(user_id)
    await db.update_run(run_id, status="completed", cursor=3)
    run = await db.get_run(run_id, user_id=user_id)
    assert run["status"] == "completed"
    assert run["completed_at"]


async def test_latest_completed_order_feeds_the_similarity_guard(database):
    user_id = await db.get_or_create_user("local-1")
    await make_run(user_id, status="completed", order=["x", "y", "z"])
    assert await db.latest_completed_order(user_id, "spotify", "pl1") == ["x", "y", "z"]


# ---------------------------------------------------------------------------
# Skipped tracks & events
# ---------------------------------------------------------------------------

async def test_skipped_entries_keep_their_reason(database):
    user_id = await db.get_or_create_user("local-1")
    run_id = await make_run(user_id)
    await db.record_skipped(run_id, [
        {"id": "loc", "name": "Home recording", "artist": "Me", "reason": "local_file"},
        {"id": "dup", "name": "Twice", "artist": "Band", "reason": "duplicate"},
    ])
    skipped = await db.list_skipped(run_id)
    assert {s["reason"] for s in skipped} == {"local_file", "duplicate"}


async def test_events_record_how_the_cursor_moved(database):
    user_id = await db.get_or_create_user("local-1")
    run_id = await make_run(user_id)
    await db.record_event(run_id, "advanced", cursor=1, reason="native_skip",
                          detail={"track_id": "b"})
    events = await db.list_events(run_id)
    assert events[0]["reason"] == "native_skip"
    assert events[0]["detail"]["track_id"] == "b"


async def test_deleting_a_user_cascades_to_their_runs(database):
    user_id = await db.get_or_create_user("local-1")
    await make_run(user_id)
    await database.execute("DELETE FROM users WHERE id = ?", (user_id,))
    await database.commit()
    assert await db.list_runs(user_id) == []


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

async def test_job_progress_is_persisted(database):
    user_id = await db.get_or_create_user("local-1")
    await db.create_job("job1", user_id, "utility:spotify")
    await db.update_job("job1", status="running", processed=50, total=100,
                        phase="reading playlist")
    job = await db.get_job("job1", user_id)
    assert job["processed"] == 50
    assert job["phase"] == "reading playlist"


async def test_a_job_is_only_visible_to_its_owner(database):
    owner = await db.get_or_create_user("local-owner")
    stranger = await db.get_or_create_user("local-stranger")
    await db.create_job("job1", owner, "utility:spotify")
    assert await db.get_job("job1", stranger) is None
