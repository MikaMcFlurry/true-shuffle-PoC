"""Async SQLite persistence.

Schema v2 is multi-provider: one local user can connect Spotify, Apple Music
and YouTube Music side by side, and every run belongs to exactly one of those
accounts.

Two bugs from the Spotify-only schema are fixed here:

* ``UNIQUE(user_id, playlist_id, mode, status)`` made a *second completed run*
  of the same playlist impossible.  It is replaced by a partial unique index
  that only constrains **active** runs — which is the rule that was actually
  intended.
* Tokens were stored as plain JSON.  They now go through
  :class:`~app.crypto.TokenVault`.
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

import aiosqlite

from app.config import get_settings
from app.crypto import TokenVault

# Module-level connection (set during lifespan startup).
_db: Optional[aiosqlite.Connection] = None
_vault: Optional[TokenVault] = None

SCHEMA_VERSION = 2

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- A local true-shuffle identity.  One person, many streaming accounts.
CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    handle       TEXT    NOT NULL UNIQUE,
    display_name TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One connected streaming service per row.
CREATE TABLE IF NOT EXISTS provider_accounts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider         TEXT    NOT NULL,
    provider_user_id TEXT    NOT NULL DEFAULT '',
    display_name     TEXT    NOT NULL DEFAULT '',
    market           TEXT    NOT NULL DEFAULT '',
    product_tier     TEXT    NOT NULL DEFAULT '',
    token_blob       TEXT    NOT NULL DEFAULT '',   -- AES-256-GCM sealed
    scope            TEXT    NOT NULL DEFAULT '',
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, provider)
);

CREATE TABLE IF NOT EXISTS runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider        TEXT    NOT NULL,
    playlist_id     TEXT    NOT NULL,
    playlist_name   TEXT    NOT NULL DEFAULT '',
    mode            TEXT    NOT NULL CHECK(mode IN ('utility', 'controller')),
    order_json      TEXT    NOT NULL DEFAULT '[]',  -- JSON array of track ids
    cursor          INTEGER NOT NULL DEFAULT 0,
    status          TEXT    NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','paused','completed','cancelled')),
    seed            INTEGER,
    device_id       TEXT,
    copy_playlist_id TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    completed_at    TEXT
);

-- Only ONE live run per (user, provider, playlist, mode).  Completed and
-- cancelled runs accumulate freely as history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_live
    ON runs(user_id, provider, playlist_id, mode)
    WHERE status IN ('active', 'paused');

CREATE INDEX IF NOT EXISTS idx_runs_user
    ON runs(user_id, provider, updated_at DESC);

-- Playlist entries that never entered the deck (local files, unavailable,
-- episodes, duplicates).  Keeping these is what lets the UI say "1 482 of
-- 1 500 tracks" instead of claiming "0 skipped".
CREATE TABLE IF NOT EXISTS skipped_tracks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    track_id   TEXT    NOT NULL DEFAULT '',
    name       TEXT    NOT NULL DEFAULT '',
    artist     TEXT    NOT NULL DEFAULT '',
    reason     TEXT    NOT NULL DEFAULT 'not_playable',
    skipped_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_skipped_run ON skipped_tracks(run_id);

-- How the run actually progressed: every cursor move with its cause.
CREATE TABLE IF NOT EXISTS run_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    type       TEXT    NOT NULL,
    cursor     INTEGER NOT NULL DEFAULT 0,
    reason     TEXT,
    detail     TEXT    NOT NULL DEFAULT '{}',
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, id DESC);

-- Background work (large playlist reads/writes) with live progress.
CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT    PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pending',
    phase       TEXT    NOT NULL DEFAULT '',
    processed   INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL DEFAULT 0,
    message     TEXT    NOT NULL DEFAULT '',
    result_json TEXT    NOT NULL DEFAULT '{}',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at DESC);
"""


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

async def init_db() -> aiosqlite.Connection:
    """Open (or create) the SQLite database and ensure the schema exists."""
    global _db, _vault
    settings = get_settings()

    _db = await aiosqlite.connect(str(settings.db_abs_path))
    _db.row_factory = aiosqlite.Row
    await _db.execute("PRAGMA foreign_keys = ON")
    await _db.execute("PRAGMA journal_mode = WAL")

    await _migrate_legacy(_db)
    await _db.executescript(_SCHEMA_SQL)
    await _db.execute(
        "INSERT INTO schema_meta (key, value) VALUES ('version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (str(SCHEMA_VERSION),),
    )
    await _db.commit()

    _vault = TokenVault(settings.secret_key)
    return _db


async def _migrate_legacy(db: aiosqlite.Connection) -> None:
    """Move a v1 (Spotify-only) database aside so v2 can be created cleanly.

    The v1 tables carried a UNIQUE constraint and a ``spotify_user_id`` column
    that cannot be reconciled in place.  Rather than silently losing data we
    rename the old tables to ``*_v1`` and leave them for inspection.
    """
    cur = await db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
    )
    if await cur.fetchone() is None:
        return  # fresh database

    cur = await db.execute("PRAGMA table_info(users)")
    columns = {row[1] for row in await cur.fetchall()}
    if "spotify_user_id" not in columns:
        return  # already v2

    for table in ("users", "runs", "skipped_tracks"):
        cur = await db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        )
        if await cur.fetchone() is not None:
            await db.execute(f"DROP TABLE IF EXISTS {table}_v1")
            await db.execute(f"ALTER TABLE {table} RENAME TO {table}_v1")
    await db.execute("DROP INDEX IF EXISTS idx_runs_user_playlist")
    await db.commit()


async def close_db() -> None:
    """Close the database connection."""
    global _db, _vault
    if _db is not None:
        await _db.close()
        _db = None
    _vault = None


def get_db() -> aiosqlite.Connection:
    """Return the current database connection (call after init)."""
    if _db is None:
        raise RuntimeError("Database not initialised — call init_db() first.")
    return _db


def get_vault() -> TokenVault:
    if _vault is None:
        raise RuntimeError("Token vault not initialised — call init_db() first.")
    return _vault


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

async def get_or_create_user(handle: str, display_name: str = "") -> int:
    """Return the local user id for *handle*, creating the row if needed."""
    db = get_db()
    await db.execute(
        "INSERT INTO users (handle, display_name) VALUES (?, ?) "
        "ON CONFLICT(handle) DO UPDATE SET display_name = "
        "CASE WHEN excluded.display_name != '' THEN excluded.display_name "
        "ELSE users.display_name END",
        (handle, display_name),
    )
    await db.commit()
    cur = await db.execute("SELECT id FROM users WHERE handle = ?", (handle,))
    row = await cur.fetchone()
    assert row is not None
    return int(row[0])


# ---------------------------------------------------------------------------
# Provider accounts
# ---------------------------------------------------------------------------

async def upsert_provider_account(
    *,
    user_id: int,
    provider: str,
    provider_user_id: str,
    display_name: str,
    market: str,
    product_tier: str,
    token: Dict[str, Any],
    scope: str = "",
) -> int:
    """Store (sealed) credentials for one connected service."""
    db = get_db()
    blob = get_vault().seal(token)
    await db.execute(
        """
        INSERT INTO provider_accounts
            (user_id, provider, provider_user_id, display_name, market,
             product_tier, token_blob, scope)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, provider) DO UPDATE SET
            provider_user_id = excluded.provider_user_id,
            display_name     = excluded.display_name,
            market           = excluded.market,
            product_tier     = excluded.product_tier,
            token_blob       = excluded.token_blob,
            scope            = excluded.scope,
            updated_at       = datetime('now')
        """,
        (
            user_id, provider, provider_user_id, display_name, market,
            product_tier, blob, scope,
        ),
    )
    await db.commit()
    cur = await db.execute(
        "SELECT id FROM provider_accounts WHERE user_id = ? AND provider = ?",
        (user_id, provider),
    )
    row = await cur.fetchone()
    assert row is not None
    return int(row[0])


async def get_provider_account(user_id: int, provider: str) -> Optional[Dict[str, Any]]:
    """Return the connected account row with its credentials opened."""
    db = get_db()
    cur = await db.execute(
        """
        SELECT id, provider, provider_user_id, display_name, market,
               product_tier, token_blob, scope, updated_at
        FROM provider_accounts WHERE user_id = ? AND provider = ?
        """,
        (user_id, provider),
    )
    row = await cur.fetchone()
    if row is None:
        return None
    account = dict(row)
    account["token"] = get_vault().open(account.pop("token_blob"))
    return account


async def list_provider_accounts(user_id: int) -> List[Dict[str, Any]]:
    """Connected accounts *without* credentials — safe to hand to a template."""
    db = get_db()
    cur = await db.execute(
        """
        SELECT provider, provider_user_id, display_name, market, product_tier,
               scope, updated_at
        FROM provider_accounts WHERE user_id = ? ORDER BY provider
        """,
        (user_id,),
    )
    return [dict(r) for r in await cur.fetchall()]


async def update_account_token(
    user_id: int, provider: str, token: Dict[str, Any]
) -> None:
    db = get_db()
    await db.execute(
        "UPDATE provider_accounts SET token_blob = ?, updated_at = datetime('now') "
        "WHERE user_id = ? AND provider = ?",
        (get_vault().seal(token), user_id, provider),
    )
    await db.commit()


async def delete_provider_account(user_id: int, provider: str) -> None:
    db = get_db()
    await db.execute(
        "DELETE FROM provider_accounts WHERE user_id = ? AND provider = ?",
        (user_id, provider),
    )
    await db.commit()


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

_LIVE = ("active", "paused")


async def create_run(
    *,
    user_id: int,
    provider: str,
    playlist_id: str,
    playlist_name: str,
    mode: str,
    order: List[str],
    seed: Optional[int] = None,
    status: str = "active",
    cursor: int = 0,
    copy_playlist_id: Optional[str] = None,
) -> int:
    db = get_db()
    cur = await db.execute(
        """
        INSERT INTO runs (user_id, provider, playlist_id, playlist_name, mode,
                          order_json, cursor, status, seed, copy_playlist_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            user_id, provider, playlist_id, playlist_name, mode,
            json.dumps(order), cursor, status, seed, copy_playlist_id,
        ),
    )
    await db.commit()
    return int(cur.lastrowid or 0)


async def get_run(run_id: int, *, user_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """Fetch a run.  Pass *user_id* to enforce ownership.

    Every caller that acts on behalf of a session must pass ``user_id`` — the
    old PoC let any logged-in user advance or export any run by guessing its
    integer id.
    """
    db = get_db()
    if user_id is None:
        cur = await db.execute("SELECT * FROM runs WHERE id = ?", (run_id,))
    else:
        cur = await db.execute(
            "SELECT * FROM runs WHERE id = ? AND user_id = ?", (run_id, user_id)
        )
    row = await cur.fetchone()
    if row is None:
        return None
    data = dict(row)
    data["order"] = json.loads(data.pop("order_json") or "[]")
    return data


async def find_live_run(
    user_id: int, provider: str, playlist_id: str, mode: str
) -> Optional[Dict[str, Any]]:
    db = get_db()
    cur = await db.execute(
        f"""
        SELECT * FROM runs
        WHERE user_id = ? AND provider = ? AND playlist_id = ? AND mode = ?
          AND status IN ({','.join('?' * len(_LIVE))})
        ORDER BY updated_at DESC LIMIT 1
        """,
        (user_id, provider, playlist_id, mode, *_LIVE),
    )
    row = await cur.fetchone()
    if row is None:
        return None
    data = dict(row)
    data["order"] = json.loads(data.pop("order_json") or "[]")
    return data


async def latest_completed_order(
    user_id: int, provider: str, playlist_id: str
) -> Optional[List[str]]:
    """Order of the most recent finished run — feeds the similarity guard."""
    db = get_db()
    cur = await db.execute(
        """
        SELECT order_json FROM runs
        WHERE user_id = ? AND provider = ? AND playlist_id = ?
          AND status = 'completed'
        ORDER BY updated_at DESC LIMIT 1
        """,
        (user_id, provider, playlist_id),
    )
    row = await cur.fetchone()
    return json.loads(row[0]) if row else None


async def list_runs(user_id: int, limit: int = 50) -> List[Dict[str, Any]]:
    db = get_db()
    cur = await db.execute(
        """
        SELECT id, provider, playlist_id, playlist_name, mode, cursor, status,
               created_at, updated_at, completed_at,
               json_array_length(order_json) AS total
        FROM runs WHERE user_id = ?
        ORDER BY updated_at DESC LIMIT ?
        """,
        (user_id, limit),
    )
    return [dict(r) for r in await cur.fetchall()]


async def update_run(
    run_id: int,
    *,
    cursor: Optional[int] = None,
    status: Optional[str] = None,
    device_id: Optional[str] = None,
    order: Optional[List[str]] = None,
) -> None:
    sets: List[str] = ["updated_at = datetime('now')"]
    params: List[Any] = []
    if cursor is not None:
        sets.append("cursor = ?")
        params.append(cursor)
    if status is not None:
        sets.append("status = ?")
        params.append(status)
        if status == "completed":
            sets.append("completed_at = datetime('now')")
    if device_id is not None:
        sets.append("device_id = ?")
        params.append(device_id)
    if order is not None:
        sets.append("order_json = ?")
        params.append(json.dumps(order))
    params.append(run_id)

    db = get_db()
    await db.execute(f"UPDATE runs SET {', '.join(sets)} WHERE id = ?", params)
    await db.commit()


async def close_live_runs(
    user_id: int, provider: str, playlist_id: str, mode: str
) -> None:
    """Cancel any live run for this combination (used before a re-shuffle)."""
    db = get_db()
    await db.execute(
        f"""
        UPDATE runs SET status = 'cancelled', updated_at = datetime('now')
        WHERE user_id = ? AND provider = ? AND playlist_id = ? AND mode = ?
          AND status IN ({','.join('?' * len(_LIVE))})
        """,
        (user_id, provider, playlist_id, mode, *_LIVE),
    )
    await db.commit()


# ---------------------------------------------------------------------------
# Skipped tracks & events
# ---------------------------------------------------------------------------

async def record_skipped(run_id: int, entries: List[Dict[str, str]]) -> None:
    if not entries:
        return
    db = get_db()
    await db.executemany(
        "INSERT INTO skipped_tracks (run_id, track_id, name, artist, reason) "
        "VALUES (?, ?, ?, ?, ?)",
        [
            (run_id, e.get("id", ""), e.get("name", ""), e.get("artist", ""),
             e.get("reason", "not_playable"))
            for e in entries
        ],
    )
    await db.commit()


async def list_skipped(run_id: int) -> List[Dict[str, Any]]:
    db = get_db()
    cur = await db.execute(
        "SELECT track_id, name, artist, reason FROM skipped_tracks "
        "WHERE run_id = ? ORDER BY id",
        (run_id,),
    )
    return [dict(r) for r in await cur.fetchall()]


async def record_event(
    run_id: int,
    type_: str,
    *,
    cursor: int = 0,
    reason: Optional[str] = None,
    detail: Optional[Dict[str, Any]] = None,
) -> None:
    db = get_db()
    await db.execute(
        "INSERT INTO run_events (run_id, type, cursor, reason, detail) "
        "VALUES (?, ?, ?, ?, ?)",
        (run_id, type_, cursor, reason, json.dumps(detail or {})),
    )
    await db.commit()


async def list_events(run_id: int, limit: int = 100) -> List[Dict[str, Any]]:
    db = get_db()
    cur = await db.execute(
        "SELECT type, cursor, reason, detail, created_at FROM run_events "
        "WHERE run_id = ? ORDER BY id DESC LIMIT ?",
        (run_id, limit),
    )
    rows = [dict(r) for r in await cur.fetchall()]
    for r in rows:
        r["detail"] = json.loads(r["detail"] or "{}")
    return rows


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

async def create_job(job_id: str, user_id: int, kind: str, total: int = 0) -> None:
    db = get_db()
    await db.execute(
        "INSERT INTO jobs (id, user_id, kind, status, total) "
        "VALUES (?, ?, ?, 'pending', ?)",
        (job_id, user_id, kind, total),
    )
    await db.commit()


async def update_job(
    job_id: str,
    *,
    status: Optional[str] = None,
    phase: Optional[str] = None,
    processed: Optional[int] = None,
    total: Optional[int] = None,
    message: Optional[str] = None,
    result: Optional[Dict[str, Any]] = None,
) -> None:
    sets: List[str] = ["updated_at = datetime('now')"]
    params: List[Any] = []
    for column, value in (
        ("status", status), ("phase", phase), ("processed", processed),
        ("total", total), ("message", message),
    ):
        if value is not None:
            sets.append(f"{column} = ?")
            params.append(value)
    if result is not None:
        sets.append("result_json = ?")
        params.append(json.dumps(result))
    params.append(job_id)

    db = get_db()
    await db.execute(f"UPDATE jobs SET {', '.join(sets)} WHERE id = ?", params)
    await db.commit()


async def get_job(job_id: str, user_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    db = get_db()
    if user_id is None:
        cur = await db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,))
    else:
        cur = await db.execute(
            "SELECT * FROM jobs WHERE id = ? AND user_id = ?", (job_id, user_id)
        )
    row = await cur.fetchone()
    if row is None:
        return None
    data = dict(row)
    data["result"] = json.loads(data.pop("result_json") or "{}")
    return data


def now_ts() -> int:
    return int(time.time())
