"""Tests for the SQLite database layer (app/db.py)."""

from __future__ import annotations

import pytest
import aiosqlite

from app.db import init_db, close_db, get_db


@pytest.fixture(autouse=True)
def _override_db_path(monkeypatch, tmp_path):
    """Use a temporary database for every test."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    # Clear the cached settings so it picks up the new env var.
    from app.config import get_settings
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_init_creates_tables(tmp_path, monkeypatch):
    """init_db should create users and runs tables."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    from app.config import get_settings
    get_settings.cache_clear()

    db = await init_db()
    try:
        cursor = await db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        tables = [row[0] for row in await cursor.fetchall()]
        assert "users" in tables
        assert "runs" in tables
        assert "tokens" in tables
    finally:
        await close_db()


@pytest.mark.asyncio
async def test_get_db_before_init_raises():
    """get_db should raise RuntimeError if called before init_db."""
    # Ensure db is closed from any prior test.
    await close_db()
    with pytest.raises(RuntimeError, match="not initialised"):
        get_db()


@pytest.mark.asyncio
async def test_insert_user_and_run(tmp_path, monkeypatch):
    """Verify basic insert into users and runs tables."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    from app.config import get_settings
    get_settings.cache_clear()

    db = await init_db()
    try:
        await db.execute(
            "INSERT INTO users (spotify_user_id, display_name) VALUES (?, ?)",
            ("user123", "Test User"),
        )
        await db.commit()

        cursor = await db.execute(
            "SELECT id, spotify_user_id FROM users WHERE spotify_user_id = ?",
            ("user123",),
        )
        user = await cursor.fetchone()
        assert user is not None
        user_id = user[0]

        await db.execute(
            "INSERT INTO runs (user_id, playlist_id, mode, shuffled_order) VALUES (?, ?, ?, ?)",
            (user_id, "playlist_abc", "utility", '["track1","track2"]'),
        )
        await db.commit()

        cursor = await db.execute(
            "SELECT cursor, status FROM runs WHERE user_id = ?", (user_id,)
        )
        run = await cursor.fetchone()
        assert run is not None
        assert run[0] == 0       # default cursor
        assert run[1] == "active" # default status
    finally:
        await close_db()


@pytest.mark.asyncio
async def test_runs_mode_check_constraint(tmp_path, monkeypatch):
    """runs.mode must be 'utility' or 'controller'."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    from app.config import get_settings
    get_settings.cache_clear()

    db = await init_db()
    try:
        await db.execute(
            "INSERT INTO users (spotify_user_id) VALUES (?)", ("u1",)
        )
        await db.commit()

        with pytest.raises(aiosqlite.IntegrityError):
            await db.execute(
                "INSERT INTO runs (user_id, playlist_id, mode) VALUES (1, 'p1', 'invalid_mode')"
            )
            await db.commit()
    finally:
        await close_db()
