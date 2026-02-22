"""Async SQLite database layer.

Uses aiosqlite for non-blocking access.  Tables are created on first
startup via ``init_db()``.
"""

from __future__ import annotations

import aiosqlite

from app.config import get_settings

# Module-level connection (set during lifespan startup).
_db: aiosqlite.Connection | None = None

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    spotify_user_id TEXT    NOT NULL UNIQUE,
    display_name    TEXT    NOT NULL DEFAULT '',
    token_data      TEXT    NOT NULL DEFAULT '',   -- encrypted JSON blob
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    playlist_id     TEXT    NOT NULL,
    mode            TEXT    NOT NULL CHECK(mode IN ('utility', 'controller')),
    shuffled_order  TEXT    NOT NULL DEFAULT '[]',  -- JSON array of track URIs
    cursor          INTEGER NOT NULL DEFAULT 0,
    status          TEXT    NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active', 'completed', 'cancelled')),
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, playlist_id, mode, status)      -- one active run per combo
);

CREATE INDEX IF NOT EXISTS idx_runs_user_playlist
    ON runs(user_id, playlist_id, mode);
"""


# ---------------------------------------------------------------------------
# Lifecycle helpers
# ---------------------------------------------------------------------------

async def init_db() -> aiosqlite.Connection:
    """Open (or create) the SQLite database and ensure schema exists."""
    global _db  # noqa: PLW0603
    settings = get_settings()
    db_path = settings.db_abs_path

    _db = await aiosqlite.connect(str(db_path))
    _db.row_factory = aiosqlite.Row  # type: ignore[assignment]
    await _db.executescript(_SCHEMA_SQL)
    await _db.commit()
    return _db


async def close_db() -> None:
    """Close the database connection."""
    global _db  # noqa: PLW0603
    if _db is not None:
        await _db.close()
        _db = None


def get_db() -> aiosqlite.Connection:
    """Return the current database connection (call after init)."""
    if _db is None:
        raise RuntimeError("Database not initialised — call init_db() first.")
    return _db
