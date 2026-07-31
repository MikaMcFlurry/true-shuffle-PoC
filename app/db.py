"""Async SQLite persistence.

Schema v3 (WP3-A): the v2 baseline below is only ever executed on an EMPTY
database; everything after that is the job of the versioned migration runner
in :mod:`app.migrations` (M001–M010).  Re-running the baseline script on a
migrated database would silently recreate ``idx_runs_one_live`` via
``CREATE INDEX IF NOT EXISTS`` and re-block UC-16 — Blueprint risk 1.

Two bugs from the Spotify-only schema remain fixed here:

* ``UNIQUE(user_id, playlist_id, mode, status)`` made a *second completed run*
  of the same playlist impossible.  v2 replaced it with a partial unique
  index on live runs; v3 (M005) replaces that again with
  ``idx_runs_one_playing`` — at most one actively playing controller run per
  (user, provider), any number of live decks per playlist (UC-16).
* Tokens were stored as plain JSON.  They now go through
  :class:`~app.crypto.TokenVault`.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, Dict, List, Optional

import aiosqlite

from app import migrations
from app.config import get_settings
from app.crypto import TokenVault

# Module-level connection (set during lifespan startup).
_db: Optional[aiosqlite.Connection] = None
_vault: Optional[TokenVault] = None

SCHEMA_VERSION = migrations.TARGET_SCHEMA_VERSION

# ---------------------------------------------------------------------------
# Schema — the frozen v2 BASELINE (fresh databases only; see module docstring)
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
    """Open (or create) the SQLite database and bring it to schema v3."""
    global _db, _vault
    settings = get_settings()

    _db = await aiosqlite.connect(str(settings.db_abs_path))
    _db.row_factory = aiosqlite.Row
    await _db.execute("PRAGMA foreign_keys = ON")
    await _db.execute("PRAGMA journal_mode = WAL")

    await _migrate_legacy(_db)

    # Blueprint risk 1: the v2 baseline script runs ONLY on an empty database
    # (no ``users`` table yet).  On anything else it would resurrect
    # ``idx_runs_one_live`` (CREATE INDEX IF NOT EXISTS) on every restart and
    # silently re-block UC-16.  A fresh database therefore takes the same
    # road as an old one: baseline v2, then the versioned steps M001–M010.
    cur = await _db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
    )
    if await cur.fetchone() is None:
        await _db.executescript(_SCHEMA_SQL)
        await _db.commit()

    await migrations.run(_db, db_path=settings.db_abs_path)

    # schema_meta stays in sync with the migration ledger — it is the value
    # v2-era code reads (Blueprint risk 8).
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
    name: str = "",
    config_id: Optional[int] = None,
    snapshot_id: Optional[int] = None,
) -> int:
    """Create a run.

    v3 additions are backwards compatible: ``config_id=None`` binds the run
    to the user's behaviour-neutral legacy preset („Ohne Wiederholungen",
    M003), so every pre-v3 caller keeps exactly today's behaviour.
    """
    db = get_db()
    try:
        if config_id is None:
            config_id = await migrations.ensure_legacy_config(db, user_id)
        cur = await db.execute(
            """
            INSERT INTO runs (user_id, provider, playlist_id, playlist_name, mode,
                              order_json, cursor, status, seed, copy_playlist_id,
                              name, config_id, snapshot_id, selection_seq)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id, provider, playlist_id, playlist_name, mode,
                json.dumps(order), cursor, status, seed, copy_playlist_id,
                name, config_id, snapshot_id, cursor,
            ),
        )
    except aiosqlite.Error:
        # e.g. idx_runs_one_playing: leave no half-open transaction behind
        # (a fresh user's just-created preset rolls back with it).
        await db.rollback()
        raise
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
    rows = await list_live_runs(user_id, provider, playlist_id, mode)
    return rows[0] if rows else None


async def list_live_runs(
    user_id: int, provider: str, playlist_id: str, mode: str
) -> List[Dict[str, Any]]:
    """ALL live (active/paused) runs of the combination, newest first.

    WP3-D2: since M005 removed ``idx_runs_one_live`` there may legally be
    several (UC-16).  The deprecated ``build_run`` wrapper auto-resumes only
    when exactly one exists — with two or more, "the" live run is ambiguous
    (Blueprint §5.2) and the caller must name a run id.
    """
    db = get_db()
    cur = await db.execute(
        f"""
        SELECT * FROM runs
        WHERE user_id = ? AND provider = ? AND playlist_id = ? AND mode = ?
          AND status IN ({','.join('?' * len(_LIVE))})
          AND archived_at IS NULL
        ORDER BY updated_at DESC
        """,
        (user_id, provider, playlist_id, mode, *_LIVE),
    )
    rows = []
    for row in await cur.fetchall():
        data = dict(row)
        data["order"] = json.loads(data.pop("order_json") or "[]")
        rows.append(data)
    return rows


async def count_active_controller_runs(user_id: int, provider: str) -> int:
    """How many runs currently occupy the one-playing-controller slot.

    ``idx_runs_one_playing`` allows at most ONE active controller run per
    (user, provider) — two runs cannot drive one device (SP-003).  Creation
    and resume check this up front so the answer is a German sentence or a
    paused run instead of a bare IntegrityError.
    """
    db = get_db()
    cur = await db.execute(
        "SELECT count(*) FROM runs WHERE user_id = ? AND provider = ? "
        "AND status = 'active' AND mode = 'controller'",
        (user_id, provider),
    )
    return int((await cur.fetchone())[0])


async def unique_run_name(user_id: int, playlist_id: str, base: str) -> str:
    """A run name that satisfies ``idx_runs_name`` (unique per user+playlist
    among non-archived runs).  ``base`` is used verbatim when free; otherwise
    the smallest ``base · N`` suffix is chosen (same convention as the M004
    backfill)."""
    db = get_db()
    cur = await db.execute(
        "SELECT name FROM runs WHERE user_id = ? AND playlist_id = ? "
        "AND archived_at IS NULL AND name != ''",
        (user_id, playlist_id),
    )
    taken = {str(r[0]) for r in await cur.fetchall()}
    if base not in taken:
        return base
    n = 2
    while f"{base} · {n}" in taken:
        n += 1
    return f"{base} · {n}"


async def latest_completed_order(
    user_id: int,
    provider: str,
    playlist_id: str,
    config_id: Optional[int] = None,
) -> Optional[List[str]]:
    """Order of the most recent finished run — feeds the similarity guard.

    WP3-D2 (Blueprint §5.3): the guard is scoped to (user, provider, playlist,
    **config**).  Two runs of the same playlist under different configurations
    are independent by the run-isolation invariant — without the scope, run B's
    finished cycle would bias run A's next shuffle, i.e. two differently
    configured runs would influence each other.  ``config_id=None`` keeps the
    pre-v3 behaviour (no config filter) for legacy callers and legacy rows.
    """
    db = get_db()
    sql = """
        SELECT order_json FROM runs
        WHERE user_id = ? AND provider = ? AND playlist_id = ?
          AND status = 'completed'
        """
    params: List[Any] = [user_id, provider, playlist_id]
    if config_id is not None:
        sql += " AND config_id = ?"
        params.append(config_id)
    sql += " ORDER BY updated_at DESC LIMIT 1"
    cur = await db.execute(sql, params)
    row = await cur.fetchone()
    return json.loads(row[0]) if row else None


async def list_runs(
    user_id: int, limit: int = 50, *, include_archived: bool = False
) -> List[Dict[str, Any]]:
    """The dashboard listing.  Archived (soft-deleted, UC-26) runs are hidden
    by default — they await their confirmed hard deletion and must not look
    resumable."""
    db = get_db()
    sql = """
        SELECT id, provider, playlist_id, playlist_name, mode, cursor, status,
               created_at, updated_at, completed_at,
               name, config_id, snapshot_id, cycle, stopped_at, archived_at,
               json_array_length(order_json) AS total
        FROM runs WHERE user_id = ?
        """
    if not include_archived:
        sql += " AND archived_at IS NULL"
    sql += " ORDER BY updated_at DESC LIMIT ?"
    cur = await db.execute(sql, (user_id, limit))
    return [dict(r) for r in await cur.fetchall()]


async def update_run(
    run_id: int,
    *,
    cursor: Optional[int] = None,
    status: Optional[str] = None,
    device_id: Optional[str] = None,
    order: Optional[List[str]] = None,
    cycle: Optional[int] = None,
    plan_version: Optional[int] = None,
    clear_device: bool = False,
    archive: bool = False,
) -> None:
    """Mutate one run row.

    WP3-D2 additions: ``cycle``/``plan_version`` (F2 reset), ``clear_device``
    (F1 stop releases the device — ``device_id=None`` has always meant "leave
    it alone", so clearing needs its own flag) and ``archive`` (UC-26 soft
    delete stamps ``archived_at``).

    May raise ``aiosqlite.IntegrityError`` (e.g. ``idx_runs_one_playing`` on a
    resume to 'active'); the failed statement is rolled back before re-raising
    so no half-open transaction leaks into the next caller.
    """
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
        # F1 (ADR-003): 'stopped' is a deliberate session end — stamped, fully
        # resumable, and NOT live (find_live_run ignores it).
        if status == "stopped":
            sets.append("stopped_at = datetime('now')")
    if device_id is not None:
        sets.append("device_id = ?")
        params.append(device_id)
    if clear_device:
        sets.append("device_id = NULL")
    if order is not None:
        sets.append("order_json = ?")
        params.append(json.dumps(order))
    if cycle is not None:
        sets.append("cycle = ?")
        params.append(cycle)
    if plan_version is not None:
        sets.append("plan_version = ?")
        params.append(plan_version)
    if archive:
        sets.append("archived_at = datetime('now')")
    params.append(run_id)

    db = get_db()
    try:
        await db.execute(f"UPDATE runs SET {', '.join(sets)} WHERE id = ?", params)
    except aiosqlite.Error:
        await db.rollback()
        raise
    await db.commit()


async def hard_delete_run(run_id: int) -> None:
    """UC-26 hard deletion: remove exactly this run and (via the FK cascades)
    its run_tracks / run_plan / run_selections / run_events / skipped_tracks.

    Content stays: ``playlists`` / ``playlist_snapshots`` / ``tracks`` are
    referenced BY the run, never owned by it — deleting a run must leave the
    imported library untouched (RUN-12).
    """
    db = get_db()
    await db.execute("DELETE FROM runs WHERE id = ?", (run_id,))
    await db.commit()


async def close_live_runs(
    user_id: int,
    provider: str,
    playlist_id: str,
    mode: str,
    *,
    run_id: Optional[int] = None,
) -> None:
    """Cancel live run(s) for this combination (used before a re-shuffle).

    v3 (UC-16): several live runs per playlist are legal, so pass ``run_id``
    to close exactly one and leave its siblings untouched — the run-isolation
    invariant (Blueprint §5.1).  Without ``run_id`` the v2 behaviour remains:
    every live run of the combination is cancelled.
    """
    db = get_db()
    sql = f"""
        UPDATE runs SET status = 'cancelled', updated_at = datetime('now')
        WHERE user_id = ? AND provider = ? AND playlist_id = ? AND mode = ?
          AND status IN ({','.join('?' * len(_LIVE))})
        """
    params: List[Any] = [user_id, provider, playlist_id, mode, *_LIVE]
    if run_id is not None:
        sql += " AND id = ?"
        params.append(run_id)
    await db.execute(sql, params)
    await db.commit()


# ---------------------------------------------------------------------------
# Configs (rule layer — read side; the write side comes with WP3-D3)
# ---------------------------------------------------------------------------

async def get_config(config_id: int) -> Optional[Dict[str, Any]]:
    """One ``run_configs`` row plus the frozen rules of its current version.

    ``rules_json`` / ``rules_hash`` come from ``run_config_versions`` at
    ``current_version`` — the immutable, hash-verifiable document that
    :class:`core.selection.Rules` loads (reproducibility invariant).
    """
    db = get_db()
    cur = await db.execute(
        """
        SELECT c.*, v.id AS config_version_id, v.rules_json, v.rules_hash
        FROM run_configs c
        JOIN run_config_versions v
          ON v.config_id = c.id AND v.version = c.current_version
        WHERE c.id = ?
        """,
        (config_id,),
    )
    row = await cur.fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Run deck & plan (v3 run layer — WP3-D2)
# ---------------------------------------------------------------------------

async def create_run_deck(
    run_id: int, entries: List[Dict[str, Any]]
) -> List[int]:
    """Materialise the run's candidate set as ``run_tracks`` rows (state open).

    ``entries``: ``{"track_pk", "entry_uid" (optional), "source_snapshot_id"
    (optional)}`` in deck order.  One transaction, one commit — a 10 000-track
    deck must not pay 10 000 fsyncs.  Returns the new run_track ids in input
    order.
    """
    db = get_db()
    ids: List[int] = []
    try:
        for e in entries:
            cur = await db.execute(
                "INSERT INTO run_tracks (run_id, track_id, entry_uid, state, "
                "source_snapshot_id) VALUES (?, ?, ?, 'open', ?)",
                (run_id, e["track_pk"], e.get("entry_uid", ""),
                 e.get("source_snapshot_id")),
            )
            ids.append(int(cur.lastrowid or 0))
    except aiosqlite.Error:
        await db.rollback()
        raise
    await db.commit()
    return ids


async def list_run_tracks(
    run_id: int,
    *,
    states: Optional[List[str]] = None,
    admitted_only: bool = False,
) -> List[Dict[str, Any]]:
    """Deck rows of one run, joined with their track identity."""
    db = get_db()
    sql = """
        SELECT rt.id, rt.run_id, rt.track_id, rt.entry_uid, rt.state,
               rt.play_count, rt.last_played_seq, rt.favorite, rt.weight,
               rt.admitted, rt.added_in_cycle, rt.source_snapshot_id,
               rt.removed_from_snapshot, rt.excluded_reason,
               t.provider_track_id, t.name, t.artist
        FROM run_tracks rt JOIN tracks t ON t.id = rt.track_id
        WHERE rt.run_id = ?
        """
    params: List[Any] = [run_id]
    if states:
        sql += f" AND rt.state IN ({','.join('?' * len(states))})"
        params.extend(states)
    if admitted_only:
        sql += " AND rt.admitted = 1"
    sql += " ORDER BY rt.id"
    cur = await db.execute(sql, params)
    return [dict(r) for r in await cur.fetchall()]


async def reopen_run_tracks(run_id: int) -> int:
    """F2 (ADR-003) reset: every admitted deck card back to 'open'.

    ``play_count`` stays cumulative across cycles and ``excluded_*`` states
    stay excluded — a reset re-opens the deck, it never rewrites history or
    lifts a user exclusion.  ``last_played_seq`` clears so the new cycle
    starts distance-free (F2).  Returns the number of re-opened rows.
    """
    db = get_db()
    cur = await db.execute(
        "UPDATE run_tracks SET state = 'open', last_played_seq = NULL "
        "WHERE run_id = ? AND admitted = 1 "
        "AND state IN ('open', 'played', 'deferred')",
        (run_id,),
    )
    await db.commit()
    return int(cur.rowcount or 0)


async def write_run_plan(
    run_id: int,
    run_track_ids: List[int],
    *,
    plan_version: int,
    start_seq: int,
    live: bool = True,
) -> None:
    """Persist one materialised cycle plan.

    ``seq`` is the run's monotonic plan clock (PRIMARY KEY(run_id, seq)): a
    reset does NOT reuse old positions, it appends the new plan after
    ``max(seq)`` — discarded rows keep their history (RUN-04/05 evidence).
    The first row of a live run's plan is 'current', the rest 'planned'
    (same convention as the M006 backfill).
    """
    db = get_db()
    try:
        for offset, run_track_id in enumerate(run_track_ids):
            state = "current" if (live and offset == 0) else "planned"
            await db.execute(
                "INSERT INTO run_plan (run_id, seq, run_track_id, plan_version, "
                "state) VALUES (?, ?, ?, ?, ?)",
                (run_id, start_seq + offset, run_track_id, plan_version, state),
            )
    except aiosqlite.Error:
        await db.rollback()
        raise
    await db.commit()


async def list_run_plan(
    run_id: int, *, plan_version: Optional[int] = None
) -> List[Dict[str, Any]]:
    db = get_db()
    sql = "SELECT * FROM run_plan WHERE run_id = ?"
    params: List[Any] = [run_id]
    if plan_version is not None:
        sql += " AND plan_version = ?"
        params.append(plan_version)
    sql += " ORDER BY seq"
    cur = await db.execute(sql, params)
    return [dict(r) for r in await cur.fetchall()]


async def discard_run_plan(run_id: int) -> int:
    """Mark every not-yet-discarded plan row 'discarded' (F2 reset).

    Discard, never delete: the old plan is evidence of what was planned and
    played (Blueprint §2.3 — 'discarded' statt Löschung).
    """
    db = get_db()
    cur = await db.execute(
        "UPDATE run_plan SET state = 'discarded' "
        "WHERE run_id = ? AND state != 'discarded'",
        (run_id,),
    )
    await db.commit()
    return int(cur.rowcount or 0)


async def max_plan_seq(run_id: int) -> int:
    """Highest used plan seq for this run, or -1 when no plan exists yet."""
    db = get_db()
    cur = await db.execute(
        "SELECT COALESCE(MAX(seq), -1) FROM run_plan WHERE run_id = ?", (run_id,)
    )
    return int((await cur.fetchone())[0])


async def set_plan_state(run_id: int, seq: int, state: str) -> None:
    db = get_db()
    await db.execute(
        "UPDATE run_plan SET state = ? WHERE run_id = ? AND seq = ?",
        (state, run_id, seq),
    )
    await db.commit()


# ---------------------------------------------------------------------------
# Snapshot read side for run creation (content layer is app/library_service.py)
# ---------------------------------------------------------------------------

async def latest_ready_snapshot(
    user_id: int, provider: str, provider_playlist_id: str
) -> Optional[Dict[str, Any]]:
    """Newest READY snapshot of the caller's playlist, or None.

    Ownership is part of the query (via the ``playlists`` row) — the same rule
    every accessor follows.
    """
    db = get_db()
    cur = await db.execute(
        """
        SELECT s.* FROM playlist_snapshots s
        JOIN playlists p ON p.id = s.playlist_id
        WHERE p.user_id = ? AND p.provider = ? AND p.provider_playlist_id = ?
          AND s.status = 'ready'
        ORDER BY s.id DESC LIMIT 1
        """,
        (user_id, provider, provider_playlist_id),
    )
    row = await cur.fetchone()
    return dict(row) if row else None


async def snapshot_items_with_tracks(snapshot_id: int) -> List[Dict[str, Any]]:
    """Every entry of a snapshot, in playlist order, with its track identity."""
    db = get_db()
    cur = await db.execute(
        """
        SELECT si.position, si.entry_uid, si.availability,
               si.track_id AS track_pk,
               t.provider_track_id, t.name, t.artist, t.album, t.duration_ms
        FROM snapshot_items si JOIN tracks t ON t.id = si.track_id
        WHERE si.snapshot_id = ? ORDER BY si.position
        """,
        (snapshot_id,),
    )
    return [dict(r) for r in await cur.fetchall()]


# ---------------------------------------------------------------------------
# Skipped tracks & events
# ---------------------------------------------------------------------------

async def record_skipped(run_id: int, entries: List[Dict[str, str]]) -> None:
    """Persist import exclusions.

    M008 (v3.0): dual-write.  ``skipped_tracks`` keeps its v2 shape so every
    existing reader stays green, and each exclusion is mirrored into
    ``run_tracks`` (state='excluded_rule') so UC-22 can show it.  OR IGNORE:
    a 'duplicate' exclusion collides with its own deck row by design.
    """
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
    cur = await db.execute("SELECT provider FROM runs WHERE id = ?", (run_id,))
    row = await cur.fetchone()
    if row is not None:
        provider = str(row[0])
        for e in entries:
            track_pk = await migrations.ensure_track(
                db, provider, e.get("id", ""),
                name=e.get("name", ""), artist=e.get("artist", ""),
            )
            await db.execute(
                "INSERT OR IGNORE INTO run_tracks (run_id, track_id, state, "
                "admitted, excluded_reason, excluded_at) "
                "VALUES (?, ?, 'excluded_rule', 0, ?, datetime('now'))",
                (run_id, track_pk, e.get("reason", "not_playable")),
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
    event_key: Optional[str] = None,
    correlation_id: str = "",
    source: str = "system",
    applied: bool = True,
    seq: int = 0,
    run_track_id: Optional[int] = None,
) -> None:
    """Append to the run ledger.

    M007: every event carries an ``event_key`` under ``UNIQUE(run_id,
    event_key)``.  Callers with a deterministic transition key (ADR-003 F5:
    ``run:planversion:seq:from:to``) pass it and treat the IntegrityError as
    "already applied"; everyone else gets a generated unique key, which keeps
    the v2 call sites append-only as before.
    """
    db = get_db()
    if event_key is None:
        event_key = f"evt:{uuid.uuid4().hex}"
    await db.execute(
        "INSERT INTO run_events (run_id, type, cursor, reason, detail, "
        "event_key, correlation_id, source, applied, seq, run_track_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (run_id, type_, cursor, reason, json.dumps(detail or {}),
         event_key, correlation_id, source, 1 if applied else 0, seq,
         run_track_id),
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
