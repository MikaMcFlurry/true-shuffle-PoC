"""Versioned schema migrations: v2 → v3 (WP3-A).

The runner replaces the old "``executescript`` on every start" approach with an
ordered list of individually transactional steps recorded in
``schema_migrations``.  Design rules (Blueprint §3, "Anforderungen an den
Runner"):

* **No ``executescript`` in versioned steps** — it commits implicitly and
  destroys atomicity.  Every step is an ordered ``execute()`` sequence inside
  one ``BEGIN IMMEDIATE`` transaction.
* ``PRAGMA foreign_keys`` cannot be toggled inside a transaction, so the
  runner switches it **outside** the step transaction (needed for M005).
* Before the first destructive step (M005) the runner writes a rollback
  artifact via ``VACUUM INTO '<db>.pre-v3.db'`` next to the database file.
* After every step: ``PRAGMA foreign_key_check`` (before commit),
  ``PRAGMA integrity_check`` (after commit), and row-count assertions inside
  the step functions themselves.
* SQLite floor **3.35** (DROP COLUMN, partial indexes); checked on start.
  Production (python:3.11-slim / bookworm) ships 3.40.1.

``schema_meta.version`` is kept in sync with the migration ledger so v2 code
reading that key still sees a sensible value (Blueprint risk 8).
"""

from __future__ import annotations

import contextlib
import hashlib
import inspect
import json
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Sequence, Tuple

import aiosqlite

#: What ``schema_meta.version`` reads after a complete standard run.
TARGET_SCHEMA_VERSION = 3

#: DROP COLUMN and partial indexes need 3.35; STRICT would need 3.37 and is
#: deliberately not used so the floor stays low (Blueprint §1.2).
MIN_SQLITE_VERSION: Tuple[int, int, int] = (3, 35, 0)

#: The pre-existing v2 schema is recorded as this baseline row so a migrated
#: and a freshly created database share one ledger history.
BASELINE_VERSION = 2
BASELINE_NAME = "baseline_v2"

#: Suffix of the rollback artifact written before M005 (next to the DB file).
PRE_V3_BACKUP_SUFFIX = ".pre-v3.db"


class MigrationError(RuntimeError):
    """A migration step failed, refused to run, or left the DB inconsistent."""


# ---------------------------------------------------------------------------
# The behaviour-neutral legacy preset (M003, ADR-003)
# ---------------------------------------------------------------------------

#: Name of the per-user preset every pre-v3 run is bound to.
LEGACY_PRESET_NAME = "Ohne Wiederholungen"

#: Exactly today's behaviour, frozen as data (Blueprint M003): no repeats, a
#: user skip consumes the card, manual use auto-resumes, new tracks are
#: ignored until re-import, duplicates collapse to one card, unplayable
#: entries are excluded, "played" means the track ended.  The execution
#: strategy is the ADR-002 default (``uris_window``).
LEGACY_PRESET_RULES: Dict[str, Any] = {
    "repeat_mode": "no_repeat",
    "min_gap": 0,
    "repeat_quota_pct": 0,
    "favorite_weight": 1.0,
    "skip_policy": "consume",
    "manual_use_policy": "auto_resume",
    "manual_wait_seconds": 900,
    "new_tracks_policy": "ignore",
    "duplicate_policy": "collapse",
    "unplayable_policy": "exclude",
    "played_threshold": "on_track_end",
    "played_threshold_seconds": 30,
    "execution_strategy": "uris_window",
}


def legacy_rules_json() -> str:
    """Canonical JSON of the legacy rules — the frozen ``rules_json`` copy."""
    return json.dumps(LEGACY_PRESET_RULES, sort_keys=True, separators=(",", ":"))


def legacy_rules_hash() -> str:
    """sha256 over the canonical JSON — the reproducibility hash."""
    return hashlib.sha256(legacy_rules_json().encode("utf-8")).hexdigest()


async def ensure_legacy_config(db: aiosqlite.Connection, user_id: int) -> int:
    """Return the user's legacy preset id, creating preset + version 1 if needed.

    Used by M003 for existing users and by ``db.create_run`` for users created
    after the migration (``config_id=None`` defaults to this preset, which is
    what keeps ``tests/test_watcher.py`` & friends behaviour-neutral).

    Does NOT commit — it joins the caller's transaction.
    """
    cur = await db.execute(
        "SELECT id FROM run_configs WHERE user_id = ? AND kind = 'preset' AND name = ?",
        (user_id, LEGACY_PRESET_NAME),
    )
    row = await cur.fetchone()
    if row is not None:
        return int(row[0])
    cur = await db.execute(
        "INSERT INTO run_configs (user_id, name, kind) VALUES (?, ?, 'preset')",
        (user_id, LEGACY_PRESET_NAME),
    )
    config_id = int(cur.lastrowid or 0)
    await db.execute(
        "INSERT INTO run_config_versions (config_id, version, rules_json, rules_hash) "
        "VALUES (?, 1, ?, ?)",
        (config_id, legacy_rules_json(), legacy_rules_hash()),
    )
    return config_id


def _local_key(name: str, artist: str, album: str, duration_ms: int) -> str:
    """Fallback identity for tracks without a provider id (Blueprint §2.1)."""
    raw = f"{name}\x1f{artist}\x1f{album}\x1f{duration_ms // 1000}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def ensure_track(
    db: aiosqlite.Connection,
    provider: str,
    provider_track_id: str,
    *,
    name: str = "",
    artist: str = "",
    album: str = "",
    duration_ms: int = 0,
    is_local: bool = False,
) -> int:
    """Get-or-create a ``tracks`` row by provider identity (or local_key).

    Shared by the M006 backfill and the M008 dual-write in
    ``db.record_skipped``.  Does NOT commit — joins the caller's transaction.
    """
    local_key = "" if provider_track_id else _local_key(name, artist, album, duration_ms)
    if provider_track_id:
        cur = await db.execute(
            "SELECT id FROM tracks WHERE provider = ? AND provider_track_id = ?",
            (provider, provider_track_id),
        )
    else:
        cur = await db.execute(
            "SELECT id FROM tracks WHERE provider = ? AND provider_track_id = '' "
            "AND local_key = ?",
            (provider, local_key),
        )
    row = await cur.fetchone()
    if row is not None:
        return int(row[0])
    cur = await db.execute(
        "INSERT INTO tracks (provider, provider_track_id, local_key, name, artist, "
        "album, duration_ms, is_local) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (provider, provider_track_id, local_key, name, artist, album,
         duration_ms, 1 if is_local else 0),
    )
    return int(cur.lastrowid or 0)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

async def _one(db: aiosqlite.Connection, sql: str, params: Sequence[Any] = ()) -> Any:
    cur = await db.execute(sql, params)
    row = await cur.fetchone()
    return row[0] if row is not None else None


async def _assert_count(
    db: aiosqlite.Connection, sql: str, expected: int, what: str
) -> None:
    actual = await _one(db, sql)
    if actual != expected:
        raise MigrationError(f"row-count assertion failed for {what}: "
                             f"expected {expected}, got {actual}")


async def _table_exists(db: aiosqlite.Connection, name: str) -> bool:
    return await _one(
        db, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ) > 0


async def _index_exists(db: aiosqlite.Connection, name: str) -> bool:
    return await _one(
        db, "SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?", (name,)
    ) > 0


# ---------------------------------------------------------------------------
# Migration steps
# ---------------------------------------------------------------------------

async def _m001_schema_migrations(db: aiosqlite.Connection) -> None:
    """M001 — the migration ledger itself, plus the v2 baseline row."""
    await db.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            checksum   TEXT NOT NULL DEFAULT '',
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    await db.execute(
        "INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)",
        (BASELINE_VERSION, BASELINE_NAME),
    )
    await _assert_count(
        db, f"SELECT count(*) FROM schema_migrations WHERE version = {BASELINE_VERSION}",
        1, "baseline row",
    )


async def _m002_content_layer(db: aiosqlite.Connection) -> None:
    """M002 — tracks / playlists / snapshots / diffs, plus the playlist backfill.

    Default deliberately does NOT derive snapshots from ``order_json`` (the
    shuffle order is not the playlist order); ``runs.snapshot_id`` stays NULL
    and legacy runs keep running from ``order_json`` until M009.
    """
    await db.execute(
        """
        CREATE TABLE tracks (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            provider          TEXT    NOT NULL,
            provider_track_id TEXT    NOT NULL DEFAULT '',
            local_key         TEXT    NOT NULL DEFAULT '',
            work_key          TEXT    NOT NULL DEFAULT '',
            name              TEXT    NOT NULL DEFAULT '',
            artist            TEXT    NOT NULL DEFAULT '',
            album             TEXT    NOT NULL DEFAULT '',
            duration_ms       INTEGER NOT NULL DEFAULT 0,
            kind              TEXT    NOT NULL DEFAULT 'track',
            artwork_url       TEXT    NOT NULL DEFAULT '',
            is_local          INTEGER NOT NULL DEFAULT 0,
            first_seen_at     TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    await db.execute(
        "CREATE UNIQUE INDEX idx_tracks_provider ON tracks(provider, provider_track_id) "
        "WHERE provider_track_id != ''"
    )
    await db.execute(
        "CREATE UNIQUE INDEX idx_tracks_local ON tracks(provider, local_key) "
        "WHERE provider_track_id = '' AND local_key != ''"
    )
    await db.execute(
        "CREATE INDEX idx_tracks_work ON tracks(work_key) WHERE work_key != ''"
    )
    await db.execute(
        """
        CREATE TABLE playlists (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            provider             TEXT    NOT NULL,
            provider_playlist_id TEXT    NOT NULL,
            name                 TEXT    NOT NULL DEFAULT '',
            owner                TEXT    NOT NULL DEFAULT '',
            is_own               INTEGER NOT NULL DEFAULT 1,
            editable             INTEGER NOT NULL DEFAULT 1,
            readable             INTEGER NOT NULL DEFAULT 1,
            unreadable_reason    TEXT    NOT NULL DEFAULT '',
            image_url            TEXT    NOT NULL DEFAULT '',
            last_imported_at     TEXT,
            UNIQUE(user_id, provider, provider_playlist_id)
        )
        """
    )
    await db.execute(
        """
        CREATE TABLE playlist_snapshots (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            playlist_id    INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
            version        INTEGER NOT NULL,
            source_etag    TEXT    NOT NULL DEFAULT '',
            content_hash   TEXT    NOT NULL DEFAULT '',
            item_count     INTEGER NOT NULL DEFAULT 0,
            playable_count INTEGER NOT NULL DEFAULT 0,
            excluded_count INTEGER NOT NULL DEFAULT 0,
            status         TEXT    NOT NULL DEFAULT 'importing'
                               CHECK(status IN ('importing','ready','failed')),
            derived        INTEGER NOT NULL DEFAULT 0,
            job_id         TEXT    NOT NULL DEFAULT '',
            imported_at    TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(playlist_id, version)
        )
        """
    )
    await db.execute(
        """
        CREATE TABLE snapshot_items (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id  INTEGER NOT NULL
                             REFERENCES playlist_snapshots(id) ON DELETE CASCADE,
            position     INTEGER NOT NULL,
            track_id     INTEGER NOT NULL REFERENCES tracks(id),
            entry_uid    TEXT    NOT NULL,
            added_at     TEXT    NOT NULL DEFAULT '',
            availability TEXT    NOT NULL DEFAULT 'playable'
                             CHECK(availability IN ('playable','unavailable','local',
                                                    'wrong_kind','missing_id','not_music')),
            UNIQUE(snapshot_id, position),
            UNIQUE(snapshot_id, entry_uid)
        )
        """
    )
    await db.execute(
        "CREATE INDEX idx_snapshot_items_track ON snapshot_items(snapshot_id, track_id)"
    )
    await db.execute(
        """
        CREATE TABLE snapshot_diffs (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            from_snapshot_id INTEGER NOT NULL
                                 REFERENCES playlist_snapshots(id) ON DELETE CASCADE,
            to_snapshot_id   INTEGER NOT NULL
                                 REFERENCES playlist_snapshots(id) ON DELETE CASCADE,
            added_json       TEXT NOT NULL DEFAULT '[]',
            removed_json     TEXT NOT NULL DEFAULT '[]',
            moved_count      INTEGER NOT NULL DEFAULT 0,
            applied_at       TEXT,
            created_at       TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(from_snapshot_id, to_snapshot_id)
        )
        """
    )
    # Backfill: one playlists row per distinct (user, provider, playlist) seen
    # in runs; the name comes from the newest run of the triple.
    await db.execute(
        """
        INSERT INTO playlists (user_id, provider, provider_playlist_id, name)
        SELECT r.user_id, r.provider, r.playlist_id, r.playlist_name
        FROM runs r
        WHERE r.id IN (
            SELECT MAX(id) FROM runs GROUP BY user_id, provider, playlist_id
        )
        """
    )
    expected = await _one(
        db,
        "SELECT count(*) FROM (SELECT DISTINCT user_id, provider, playlist_id FROM runs)",
    )
    await _assert_count(db, "SELECT count(*) FROM playlists", int(expected),
                        "playlists backfill")


async def _m003_rule_layer(db: aiosqlite.Connection) -> None:
    """M003 — run_configs / versions / bindings + the legacy preset per user."""
    await db.execute(
        """
        CREATE TABLE run_configs (
            id                     INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name                   TEXT    NOT NULL,
            kind                   TEXT    NOT NULL DEFAULT 'preset'
                                       CHECK(kind IN ('preset','run_local')),
            origin_config_id       INTEGER REFERENCES run_configs(id) ON DELETE SET NULL,
            current_version        INTEGER NOT NULL DEFAULT 1,
            repeat_mode            TEXT    NOT NULL DEFAULT 'no_repeat'
                                       CHECK(repeat_mode IN ('no_repeat','limited_repeat',
                                                             'free_repeat')),
            min_gap                INTEGER NOT NULL DEFAULT 0,
            repeat_quota_pct       INTEGER NOT NULL DEFAULT 0,
            favorite_weight        REAL    NOT NULL DEFAULT 1.0,
            skip_policy            TEXT NOT NULL DEFAULT 'consume'
                                       CHECK(skip_policy IN ('consume','keep_open',
                                                             'requeue_later','defer_to_end')),
            manual_use_policy      TEXT NOT NULL DEFAULT 'auto_resume'
                                       CHECK(manual_use_policy IN ('auto_resume',
                                                                   'auto_pause','ask')),
            manual_wait_seconds    INTEGER NOT NULL DEFAULT 900,
            new_tracks_policy      TEXT NOT NULL DEFAULT 'ignore'
                                       CHECK(new_tracks_policy IN ('include_now',
                                                                   'after_cycle','ignore')),
            duplicate_policy       TEXT NOT NULL DEFAULT 'collapse'
                                       CHECK(duplicate_policy IN ('collapse','keep_entries')),
            unplayable_policy      TEXT NOT NULL DEFAULT 'exclude'
                                       CHECK(unplayable_policy IN ('exclude',
                                                                   'retry_next_cycle')),
            played_threshold       TEXT NOT NULL DEFAULT 'on_track_end'
                                       CHECK(played_threshold IN ('on_start','on_min_seconds',
                                                                  'on_track_end')),
            played_threshold_seconds INTEGER NOT NULL DEFAULT 30,
            execution_strategy     TEXT NOT NULL DEFAULT 'uris_window'
                                       CHECK(execution_strategy IN ('single_uri','uris_window',
                                                                    'context_playlist',
                                                                    'no_prefetch')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    await db.execute(
        "CREATE UNIQUE INDEX idx_configs_name ON run_configs(user_id, name) "
        "WHERE kind = 'preset'"
    )
    await db.execute(
        """
        CREATE TABLE run_config_versions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            config_id  INTEGER NOT NULL REFERENCES run_configs(id) ON DELETE CASCADE,
            version    INTEGER NOT NULL,
            rules_json TEXT    NOT NULL,
            rules_hash TEXT    NOT NULL,
            created_at TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(config_id, version)
        )
        """
    )
    await db.execute(
        """
        CREATE TABLE run_rule_bindings (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id              INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            config_version_id   INTEGER NOT NULL REFERENCES run_config_versions(id)
                                    ON DELETE CASCADE,
            effective_from_seq  INTEGER NOT NULL,
            replan              TEXT    NOT NULL DEFAULT 'tail_only'
                                    CHECK(replan IN ('none','tail_only','full')),
            applied_at          TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(run_id, effective_from_seq)
        )
        """
    )
    # The behaviour-neutral legacy preset, one per existing user.  The column
    # defaults ARE today's behaviour, so only identity columns are written.
    await db.execute(
        "INSERT INTO run_configs (user_id, name, kind) "
        "SELECT id, ?, 'preset' FROM users",
        (LEGACY_PRESET_NAME,),
    )
    await db.execute(
        "INSERT INTO run_config_versions (config_id, version, rules_json, rules_hash) "
        "SELECT id, 1, ?, ? FROM run_configs",
        (legacy_rules_json(), legacy_rules_hash()),
    )
    users = int(await _one(db, "SELECT count(*) FROM users"))
    await _assert_count(db, "SELECT count(*) FROM run_configs", users, "legacy presets")
    await _assert_count(db, "SELECT count(*) FROM run_config_versions", users,
                        "legacy preset versions")


async def _m004_runs_additive(db: aiosqlite.Connection) -> None:
    """M004 — additive ``runs`` columns + backfill.

    SQLite ADD COLUMN traps (Blueprint §3, risk 4): no expression defaults
    (``datetime('now')`` is rejected — backfill happens via UPDATE), and a
    column with ``REFERENCES`` must default to NULL while foreign keys are on.
    Columns are deliberately neither indexed nor CHECKed here so the whole
    step stays rollback-able via ``DROP COLUMN``; the constraints arrive with
    the M005 rebuild.
    """
    for ddl in (
        "ALTER TABLE runs ADD COLUMN name TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE runs ADD COLUMN config_id INTEGER REFERENCES run_configs(id)",
        "ALTER TABLE runs ADD COLUMN snapshot_id INTEGER REFERENCES playlist_snapshots(id)",
        "ALTER TABLE runs ADD COLUMN playlist_ref_id INTEGER REFERENCES playlists(id)",
        "ALTER TABLE runs ADD COLUMN cycle INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE runs ADD COLUMN selection_seq INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE runs ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE runs ADD COLUMN manual_state TEXT NOT NULL DEFAULT 'none'",
        "ALTER TABLE runs ADD COLUMN manual_since TEXT",
        "ALTER TABLE runs ADD COLUMN last_activity_at TEXT",
        "ALTER TABLE runs ADD COLUMN stopped_at TEXT",
        "ALTER TABLE runs ADD COLUMN archived_at TEXT",
    ):
        await db.execute(ddl)

    await db.execute(
        """
        UPDATE runs SET
            config_id = (SELECT c.id FROM run_configs c
                         WHERE c.user_id = runs.user_id
                           AND c.kind = 'preset' AND c.name = ?),
            playlist_ref_id = (SELECT p.id FROM playlists p
                               WHERE p.user_id = runs.user_id
                                 AND p.provider = runs.provider
                                 AND p.provider_playlist_id = runs.playlist_id),
            cycle = 1,
            selection_seq = cursor,
            plan_version = 1,
            last_activity_at = updated_at
        """,
        (LEGACY_PRESET_NAME,),
    )
    # Run names must satisfy the upcoming partial unique index
    # idx_runs_name(user_id, playlist_id, name) WHERE name != '' (M005), so
    # only the oldest run per (user, playlist) gets the plain playlist name;
    # further runs are disambiguated with their id.
    await db.execute(
        """
        UPDATE runs SET name = playlist_name
        WHERE playlist_name != '' AND id IN (
            SELECT MIN(id) FROM runs WHERE playlist_name != ''
            GROUP BY user_id, playlist_id
        )
        """
    )
    await db.execute(
        "UPDATE runs SET name = playlist_name || ' · ' || id "
        "WHERE playlist_name != '' AND name = ''"
    )
    await _assert_count(db, "SELECT count(*) FROM runs WHERE config_id IS NULL", 0,
                        "runs.config_id backfill")
    await _assert_count(db, "SELECT count(*) FROM runs WHERE playlist_ref_id IS NULL",
                        0, "runs.playlist_ref_id backfill")
    await _assert_count(
        db,
        "SELECT count(*) FROM (SELECT user_id, playlist_id, name FROM runs "
        "WHERE name != '' GROUP BY user_id, playlist_id, name HAVING count(*) > 1)",
        0, "unique run names",
    )


async def _m005_runs_rebuild(db: aiosqlite.Connection) -> None:
    """M005 — rebuild ``runs``: status CHECK incl. 'stopped' + index swap.

    The two named traps (Blueprint §3 / risks 2+3):

    1. With ``foreign_keys=ON`` a ``DROP TABLE runs`` performs an implicit
       DELETE and cascade-wipes ``run_events`` and ``skipped_tracks``.  The
       runner therefore switches the pragma OFF (outside this transaction)
       before this step runs, and back ON afterwards.
    2. ``ALTER TABLE ... RENAME`` drags index names along — a rename-instead-
       of-drop would keep ``idx_runs_one_live`` alive and turn a later
       ``CREATE UNIQUE INDEX IF NOT EXISTS`` into a silent no-op.  Hence
       **DROP TABLE, never RENAME** for the old table.

    ``idx_runs_one_live`` (one live run per playlist+mode — the UC-16
    blocker) is replaced by ``idx_runs_one_playing``: at most ONE actively
    playing controller run per (user, provider).  Pre-existing data may hold
    several active controller runs (v2 allowed one per playlist); all but the
    newest per (user, provider) are demoted to 'paused' — they stay live and
    resumable, nothing is lost.
    """
    count_before = int(await _one(db, "SELECT count(*) FROM runs"))
    events_before = int(await _one(db, "SELECT count(*) FROM run_events"))
    skipped_before = int(await _one(db, "SELECT count(*) FROM skipped_tracks"))

    # Normalise data for idx_runs_one_playing, audibly (a run_events row per
    # demoted run — run_events still has its v2 shape at this point).
    cur = await db.execute(
        """
        SELECT id, cursor FROM runs
        WHERE status = 'active' AND mode = 'controller' AND id NOT IN (
            SELECT MAX(id) FROM runs
            WHERE status = 'active' AND mode = 'controller'
            GROUP BY user_id, provider
        )
        """
    )
    demoted = await cur.fetchall()
    if demoted:
        await db.execute(
            """
            UPDATE runs SET status = 'paused', updated_at = datetime('now')
            WHERE status = 'active' AND mode = 'controller' AND id NOT IN (
                SELECT MAX(id) FROM runs
                WHERE status = 'active' AND mode = 'controller'
                GROUP BY user_id, provider
            )
            """
        )
        for run_id, cursor_pos in demoted:
            await db.execute(
                "INSERT INTO run_events (run_id, type, cursor, reason, detail) "
                "VALUES (?, 'paused', ?, 'migration', ?)",
                (run_id, cursor_pos,
                 json.dumps({"note": "demoted to paused: only one active controller "
                                     "run per (user, provider) — idx_runs_one_playing"})),
            )

    await db.execute(
        """
        CREATE TABLE runs_new (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            provider         TEXT    NOT NULL,
            playlist_ref_id  INTEGER REFERENCES playlists(id),
            playlist_id      TEXT    NOT NULL,
            playlist_name    TEXT    NOT NULL DEFAULT '',
            snapshot_id      INTEGER REFERENCES playlist_snapshots(id),
            config_id        INTEGER REFERENCES run_configs(id),
            name             TEXT    NOT NULL DEFAULT '',
            mode             TEXT    NOT NULL CHECK(mode IN ('utility','controller')),
            status           TEXT    NOT NULL DEFAULT 'active'
                                 CHECK(status IN ('active','paused','stopped',
                                                  'completed','cancelled')),
            cycle            INTEGER NOT NULL DEFAULT 1,
            selection_seq    INTEGER NOT NULL DEFAULT 0,
            cursor           INTEGER NOT NULL DEFAULT 0,
            plan_version     INTEGER NOT NULL DEFAULT 1,
            order_json       TEXT    NOT NULL DEFAULT '[]',
            seed             INTEGER,
            device_id        TEXT,
            copy_playlist_id TEXT,
            manual_state     TEXT    NOT NULL DEFAULT 'none'
                                 CHECK(manual_state IN ('none','manual_detected',
                                                        'awaiting_decision','suspended')),
            manual_since     TEXT,
            created_at       TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
            last_activity_at TEXT,
            stopped_at       TEXT,
            completed_at     TEXT,
            archived_at      TEXT
        )
        """
    )
    await db.execute(
        """
        INSERT INTO runs_new (id, user_id, provider, playlist_ref_id, playlist_id,
            playlist_name, snapshot_id, config_id, name, mode, status, cycle,
            selection_seq, cursor, plan_version, order_json, seed, device_id,
            copy_playlist_id, manual_state, manual_since, created_at, updated_at,
            last_activity_at, stopped_at, completed_at, archived_at)
        SELECT id, user_id, provider, playlist_ref_id, playlist_id,
            playlist_name, snapshot_id, config_id, name, mode, status, cycle,
            selection_seq, cursor, plan_version, order_json, seed, device_id,
            copy_playlist_id, manual_state, manual_since, created_at, updated_at,
            last_activity_at, stopped_at, completed_at, archived_at
        FROM runs
        """
    )
    # Trap 1+2: DROP (never RENAME) the old table; foreign_keys is OFF.
    await db.execute("DROP TABLE runs")
    await db.execute("ALTER TABLE runs_new RENAME TO runs")

    # The index swap that unlocks UC-16 (Blueprint §2.3): idx_runs_one_live
    # died with the old table and is intentionally NOT recreated.
    await db.execute(
        "CREATE INDEX idx_runs_user ON runs(user_id, provider, updated_at DESC)"
    )
    await db.execute(
        "CREATE INDEX idx_runs_live ON runs(user_id, provider, playlist_id, status)"
    )
    await db.execute(
        "CREATE UNIQUE INDEX idx_runs_one_playing ON runs(user_id, provider) "
        "WHERE status = 'active' AND mode = 'controller'"
    )
    await db.execute(
        "CREATE UNIQUE INDEX idx_runs_name ON runs(user_id, playlist_id, name) "
        "WHERE archived_at IS NULL AND name != ''"
    )

    await _assert_count(db, "SELECT count(*) FROM runs", count_before, "runs rebuild")
    await _assert_count(db, "SELECT count(*) FROM run_events",
                        events_before + len(demoted), "run_events survived the rebuild")
    await _assert_count(db, "SELECT count(*) FROM skipped_tracks", skipped_before,
                        "skipped_tracks survived the rebuild")
    if await _index_exists(db, "idx_runs_one_live"):
        raise MigrationError("idx_runs_one_live survived M005 — rebuild went wrong")


async def _m006_run_layer(db: aiosqlite.Connection) -> None:
    """M006 — run_tracks / run_plan / run_selections + per-run backfill.

    Runs with ``own_transactions``: table creation is one transaction, then
    ONE transaction per legacy run (Blueprint: batch-wise for 10k-track
    volumes).  ``order_json`` stays authoritative until M009, so the step is
    resumable: a run that already has plan rows is skipped.
    """
    await db.execute("BEGIN IMMEDIATE")
    await db.execute(
        """
        CREATE TABLE IF NOT EXISTS run_tracks (
            id                     INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id                 INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            track_id               INTEGER NOT NULL REFERENCES tracks(id),
            entry_uid              TEXT    NOT NULL DEFAULT '',
            state                  TEXT    NOT NULL DEFAULT 'open'
                                       CHECK(state IN ('open','played','deferred',
                                                       'excluded_user','excluded_rule')),
            play_count             INTEGER NOT NULL DEFAULT 0,
            last_played_seq        INTEGER,
            favorite               INTEGER NOT NULL DEFAULT 0,
            weight                 REAL    NOT NULL DEFAULT 1.0,
            admitted               INTEGER NOT NULL DEFAULT 1,
            added_in_cycle         INTEGER NOT NULL DEFAULT 1,
            source_snapshot_id     INTEGER REFERENCES playlist_snapshots(id),
            removed_from_snapshot  INTEGER NOT NULL DEFAULT 0,
            excluded_reason        TEXT    NOT NULL DEFAULT '',
            excluded_at            TEXT,
            UNIQUE(run_id, track_id, entry_uid)
        )
        """
    )
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_run_tracks_open "
        "ON run_tracks(run_id, state, admitted)"
    )
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_run_tracks_gap "
        "ON run_tracks(run_id, last_played_seq)"
    )
    await db.execute(
        """
        CREATE TABLE IF NOT EXISTS run_plan (
            run_id       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            seq          INTEGER NOT NULL,
            run_track_id INTEGER NOT NULL REFERENCES run_tracks(id) ON DELETE CASCADE,
            plan_version INTEGER NOT NULL DEFAULT 1,
            state        TEXT NOT NULL DEFAULT 'planned'
                             CHECK(state IN ('planned','current','consumed','discarded')),
            planned_at   TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY(run_id, seq)
        )
        """
    )
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_run_plan_state ON run_plan(run_id, state)"
    )
    await db.execute(
        """
        CREATE TABLE IF NOT EXISTS run_selections (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id            INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            seq               INTEGER NOT NULL,
            run_track_id      INTEGER REFERENCES run_tracks(id),
            config_version_id INTEGER REFERENCES run_config_versions(id),
            rules_hash        TEXT    NOT NULL DEFAULT '',
            seed              INTEGER NOT NULL,
            candidate_hash    TEXT    NOT NULL DEFAULT '',
            candidate_count   INTEGER NOT NULL DEFAULT 0,
            filtered_by_json  TEXT    NOT NULL DEFAULT '{}',
            decided_at        TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(run_id, seq)
        )
        """
    )
    await db.execute("COMMIT")

    cur = await db.execute(
        "SELECT id, provider, cursor, status, order_json FROM runs ORDER BY id"
    )
    legacy_runs = await cur.fetchall()

    for run_id, provider, cursor_pos, status, order_json in legacy_runs:
        order: List[str] = json.loads(order_json or "[]")
        await db.execute("BEGIN IMMEDIATE")
        try:
            already = await _one(
                db, "SELECT count(*) FROM run_plan WHERE run_id = ?", (run_id,)
            )
            if already:
                await db.execute("COMMIT")  # resumed after a crash — run is done
                continue

            # Deck: everything before the cursor was played, the rest is open.
            seen: Dict[int, int] = {}  # track_id -> run_tracks.id (collapse dups)
            for index, provider_track_id in enumerate(order):
                track_pk = await ensure_track(db, provider, provider_track_id)
                run_track_id = seen.get(track_pk)
                if run_track_id is None:
                    played = index < cursor_pos
                    ins = await db.execute(
                        "INSERT INTO run_tracks (run_id, track_id, state, play_count, "
                        "last_played_seq) VALUES (?, ?, ?, ?, ?)",
                        (run_id, track_pk,
                         "played" if played else "open",
                         1 if played else 0,
                         index if played else None),
                    )
                    run_track_id = int(ins.lastrowid or 0)
                    seen[track_pk] = run_track_id
                if index < cursor_pos:
                    plan_state = "consumed"
                elif index == cursor_pos and status in ("active", "paused"):
                    plan_state = "current"
                else:
                    plan_state = "planned"
                await db.execute(
                    "INSERT INTO run_plan (run_id, seq, run_track_id, plan_version, "
                    "state) VALUES (?, ?, ?, 1, ?)",
                    (run_id, index, run_track_id, plan_state),
                )

            # Import exclusions (skipped_tracks = SkipReason, NOT user skips)
            # become excluded_rule rows so UC-22 can show them.  OR IGNORE:
            # a 'duplicate' exclusion collides with its deck row by design.
            cur2 = await db.execute(
                "SELECT track_id, name, artist, reason, skipped_at "
                "FROM skipped_tracks WHERE run_id = ? ORDER BY id",
                (run_id,),
            )
            for track_id, name, artist, reason, skipped_at in await cur2.fetchall():
                track_pk = await ensure_track(
                    db, provider, track_id, name=name or "", artist=artist or "",
                )
                await db.execute(
                    "INSERT OR IGNORE INTO run_tracks (run_id, track_id, state, "
                    "admitted, excluded_reason, excluded_at) "
                    "VALUES (?, ?, 'excluded_rule', 0, ?, ?)",
                    (run_id, track_pk, reason or "not_playable", skipped_at),
                )

            await _assert_count(
                db, f"SELECT count(*) FROM run_plan WHERE run_id = {int(run_id)}",
                len(order), f"run_plan backfill of run {run_id}",
            )
            await _assert_count(
                db,
                f"SELECT count(*) FROM run_tracks WHERE run_id = {int(run_id)} "
                "AND state IN ('open','played')",
                len(set(order)), f"run_tracks deck backfill of run {run_id}",
            )
            await db.execute("COMMIT")
        except BaseException:
            await db.execute("ROLLBACK")
            raise


async def _m007_ledger(db: aiosqlite.Connection) -> None:
    """M007 — event idempotency columns + command log tables.

    No table rebuild is needed: all defaults are constant, and the FK column
    defaults to NULL (SQLite's ADD COLUMN rule).  The backfill makes legacy
    rows unique (``legacy:<id>``) without judging them.  Rollback order is
    mandatory: drop ``idx_events_key`` BEFORE dropping ``event_key`` —
    indexed columns cannot be dropped (see :func:`rollback_m007`).
    """
    for ddl in (
        "ALTER TABLE run_events ADD COLUMN event_key TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE run_events ADD COLUMN correlation_id TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE run_events ADD COLUMN source TEXT NOT NULL DEFAULT 'system'",
        "ALTER TABLE run_events ADD COLUMN applied INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE run_events ADD COLUMN seq INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE run_events ADD COLUMN run_track_id INTEGER REFERENCES run_tracks(id)",
    ):
        await db.execute(ddl)
    await db.execute(
        "UPDATE run_events SET event_key = 'legacy:' || id, seq = id "
        "WHERE event_key = ''"
    )
    await db.execute(
        "CREATE UNIQUE INDEX idx_events_key ON run_events(run_id, event_key)"
    )
    await db.execute(
        """
        CREATE TABLE provider_commands (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id          INTEGER REFERENCES runs(id) ON DELETE CASCADE,
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            provider        TEXT    NOT NULL,
            kind            TEXT    NOT NULL
                                CHECK(kind IN ('play','enqueue','pause','transfer',
                                               'create_playlist','add_tracks','read_queue')),
            idempotency_key TEXT    NOT NULL,
            correlation_id  TEXT    NOT NULL DEFAULT '',
            target_track_id TEXT    NOT NULL DEFAULT '',
            device_id       TEXT    NOT NULL DEFAULT '',
            payload_json    TEXT    NOT NULL DEFAULT '{}',
            status          TEXT    NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending','sent','succeeded','failed',
                                                 'skipped','superseded')),
            attempt         INTEGER NOT NULL DEFAULT 0,
            http_status     INTEGER,
            retry_after_ms  INTEGER,
            error           TEXT    NOT NULL DEFAULT '',
            created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
            sent_at         TEXT,
            settled_at      TEXT,
            UNIQUE(idempotency_key)
        )
        """
    )
    await db.execute(
        "CREATE INDEX idx_commands_run ON provider_commands(run_id, created_at DESC)"
    )
    await db.execute(
        """
        CREATE TABLE provider_observations (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id         INTEGER REFERENCES runs(id) ON DELETE CASCADE,
            correlation_id TEXT NOT NULL DEFAULT '',
            kind           TEXT NOT NULL CHECK(kind IN ('playback_state','queue')),
            payload_json   TEXT NOT NULL DEFAULT '{}',
            observed_at    TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    await db.execute(
        "CREATE INDEX idx_obs_run ON provider_observations(run_id, observed_at DESC)"
    )
    await _assert_count(db, "SELECT count(*) FROM run_events WHERE event_key = ''",
                        0, "event_key backfill")
    total = int(await _one(db, "SELECT count(*) FROM run_events"))
    await _assert_count(
        db,
        "SELECT count(*) FROM (SELECT DISTINCT run_id, event_key FROM run_events)",
        total, "event_key uniqueness",
    )


async def _m008_skipped_compat(db: aiosqlite.Connection) -> None:
    """M008 — ``skipped_tracks`` compatibility contract (v3.0: dual-write).

    Schema-neutral by design: the table keeps its v2 shape so every existing
    test and reader stays green (BASE-02).  From this version on,
    ``app.db.record_skipped`` dual-writes each import exclusion into
    ``run_tracks`` (state='excluded_rule'); historical rows were mirrored by
    M006.  The v3.1 follow-up (RENAME to import_exclusions_legacy + view) is
    deliberately NOT part of this run.
    """
    # Sanity only: the M006 mirror exists for historical exclusions.
    mirrored = await _one(
        db, "SELECT count(*) FROM run_tracks WHERE state = 'excluded_rule'"
    )
    if mirrored is None:  # pragma: no cover — run_tracks must exist after M006
        raise MigrationError("run_tracks missing — M006 must precede M008")


async def _m009_drop_order_json(db: aiosqlite.Connection) -> None:
    """M009 — decouple ``order_json`` (destructive, LAST, and gated).

    NOT part of the standard run: it only executes with an explicit
    ``include_destructive=True``.  Reason: ``order_json`` remains the
    authoritative order for all v2 code paths (``app.db.get_run``,
    ``latest_completed_order``, exporter) until the v3 service layer (WP3-D)
    has run in production on ``run_plan``.  Dropping it earlier would break
    the running application, and a restore would need the VACUUM artifact.
    Legal as a plain DROP COLUMN: no index, CHECK, view or trigger references
    the column (Blueprint M009).
    """
    await db.execute("ALTER TABLE runs DROP COLUMN order_json")


async def _m010_deletion_requests(db: aiosqlite.Connection) -> None:
    """M010 — retention/deletion ledger (ADR-003 F10: 5-day deadline, provable)."""
    await db.execute(
        """
        CREATE TABLE deletion_requests (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            provider     TEXT    NOT NULL,
            scope        TEXT    NOT NULL DEFAULT 'provider_content',
            requested_at TEXT    NOT NULL DEFAULT (datetime('now')),
            due_at       TEXT    NOT NULL,
            status       TEXT    NOT NULL DEFAULT 'pending'
                             CHECK(status IN ('pending','done','failed')),
            completed_at TEXT
        )
        """
    )


async def _m011_deletion_salt(db: aiosqlite.Connection) -> None:
    """M011 — Stufe-3-Matching-Salt am Löschantrag (ADR-003 F10).

    Der Opaque-Hash der anonymisierten Titel-Referenzen ist
    HMAC(salt, provider_track_id); der Salt lebt am ``deletion_requests``-
    Antrag, damit ein Reconnect denselben Hörstand wieder verknüpfen kann
    (:func:`app.retention.relink_after_import`).  Rollback: schlichtes
    ``ALTER TABLE deletion_requests DROP COLUMN salt`` — kein Index, keine
    Constraint, keine View referenziert die Spalte.
    """
    await db.execute(
        "ALTER TABLE deletion_requests ADD COLUMN salt TEXT NOT NULL DEFAULT ''"
    )


# ---------------------------------------------------------------------------
# Rollbacks (per-step, for the steps that need scripted reversal)
# ---------------------------------------------------------------------------

async def rollback_m007(db: aiosqlite.Connection) -> None:
    """Reverse M007.  Order is load-bearing (Blueprint risk 5): the UNIQUE
    index must be dropped BEFORE the columns — SQLite refuses to drop an
    indexed column."""
    await db.commit()
    await db.execute("BEGIN IMMEDIATE")
    try:
        await db.execute("DROP INDEX idx_events_key")  # FIRST — before the columns
        for column in ("run_track_id", "seq", "applied", "source",
                       "correlation_id", "event_key"):
            await db.execute(f"ALTER TABLE run_events DROP COLUMN {column}")
        await db.execute("DROP TABLE provider_commands")
        await db.execute("DROP TABLE provider_observations")
        await db.execute("DELETE FROM schema_migrations WHERE version = 307")
        await db.execute("COMMIT")
    except BaseException:
        await db.execute("ROLLBACK")
        raise


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    fn: Callable[[aiosqlite.Connection], Awaitable[None]]
    #: M009: only runs with an explicit ``include_destructive=True``.
    optional: bool = False
    #: M005: PRAGMA foreign_keys OFF before / ON after (outside the TX).
    disable_foreign_keys: bool = False
    #: M005: VACUUM INTO '<db>.pre-v3.db' before the step.
    backup_before: bool = False
    #: M006: the step manages its own transactions (one per legacy run).
    own_transactions: bool = False


MIGRATIONS: Tuple[Migration, ...] = (
    Migration(301, "m001_schema_migrations", _m001_schema_migrations),
    Migration(302, "m002_content_layer", _m002_content_layer),
    Migration(303, "m003_rule_layer", _m003_rule_layer),
    Migration(304, "m004_runs_additive", _m004_runs_additive),
    Migration(305, "m005_runs_rebuild", _m005_runs_rebuild,
              disable_foreign_keys=True, backup_before=True),
    Migration(306, "m006_run_layer", _m006_run_layer, own_transactions=True),
    Migration(307, "m007_ledger", _m007_ledger),
    Migration(308, "m008_skipped_compat", _m008_skipped_compat),
    Migration(309, "m009_drop_order_json", _m009_drop_order_json, optional=True),
    Migration(310, "m010_deletion_requests", _m010_deletion_requests),
    Migration(311, "m011_deletion_salt", _m011_deletion_salt),
)


def backup_path(db_path: Any) -> Path:
    """Where the pre-v3 rollback artifact lives (next to the DB file)."""
    return Path(str(db_path) + PRE_V3_BACKUP_SUFFIX)


def _checksum(fn: Callable[..., Any]) -> str:
    source = textwrap.dedent(inspect.getsource(fn))
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


async def _check_sqlite_floor(db: aiosqlite.Connection) -> None:
    raw = str(await _one(db, "SELECT sqlite_version()"))
    parts = tuple(int(p) for p in raw.split("."))
    if parts < MIN_SQLITE_VERSION:
        floor = ".".join(str(p) for p in MIN_SQLITE_VERSION)
        raise MigrationError(
            f"SQLite {raw} is below the required floor {floor} "
            "(DROP COLUMN / partial indexes)"
        )


async def _applied_rows(db: aiosqlite.Connection) -> Dict[int, str]:
    if not await _table_exists(db, "schema_migrations"):
        return {}
    cur = await db.execute("SELECT version, checksum FROM schema_migrations")
    return {int(v): str(c) for v, c in await cur.fetchall()}


async def _assert_foreign_keys_clean(db: aiosqlite.Connection) -> None:
    cur = await db.execute("PRAGMA foreign_key_check")
    rows = await cur.fetchall()
    if rows:
        sample = ", ".join(f"{r[0]}→{r[2]} (rowid {r[1]})" for r in rows[:5])
        raise MigrationError(f"foreign_key_check found {len(rows)} violation(s): {sample}")


async def _assert_integrity(db: aiosqlite.Connection) -> None:
    verdict = await _one(db, "PRAGMA integrity_check")
    if verdict != "ok":
        raise MigrationError(f"integrity_check failed: {verdict}")


async def _record(db: aiosqlite.Connection, migration: Migration) -> None:
    await db.execute(
        "INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)",
        (migration.version, migration.name, _checksum(migration.fn)),
    )


async def _sync_schema_meta(db: aiosqlite.Connection) -> None:
    """Keep the value that v2 code reads in step with the ledger (risk 8)."""
    if not await _table_exists(db, "schema_meta"):
        return
    await db.execute(
        "INSERT INTO schema_meta (key, value) VALUES ('version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (str(TARGET_SCHEMA_VERSION),),
    )
    await db.commit()


async def _apply(
    db: aiosqlite.Connection, migration: Migration, *, db_path: Any
) -> None:
    # Never enter a step with a half-open implicit transaction.
    await db.commit()

    if migration.backup_before:
        # VACUUM INTO must run outside any transaction.  The artifact is the
        # rollback path for the destructive rebuild (and doubles as the
        # "migration test against a copy of a real DB" fixture).
        target = backup_path(db_path)
        if str(db_path) and str(db_path) != ":memory:":
            if target.exists():
                target.unlink()
            await db.execute("VACUUM INTO ?", (str(target),))

    if migration.disable_foreign_keys:
        # Cannot be toggled inside a transaction — hence out here.
        await db.execute("PRAGMA foreign_keys = OFF")
    try:
        if migration.own_transactions:
            await migration.fn(db)
            await _assert_foreign_keys_clean(db)
            await db.execute("BEGIN IMMEDIATE")
            await _record(db, migration)
            await db.execute("COMMIT")
        else:
            await db.execute("BEGIN IMMEDIATE")
            try:
                await migration.fn(db)
                await _record(db, migration)
                await _assert_foreign_keys_clean(db)
                await db.execute("COMMIT")
            except BaseException:
                # The TX may already have auto-rolled-back — suppress that.
                with contextlib.suppress(aiosqlite.Error):
                    await db.execute("ROLLBACK")
                raise
    finally:
        if migration.disable_foreign_keys:
            await db.execute("PRAGMA foreign_keys = ON")
    await _assert_integrity(db)


async def run(
    db: aiosqlite.Connection,
    *,
    db_path: Any,
    include_destructive: bool = False,
) -> List[int]:
    """Bring the database to schema v3.  Returns the versions applied now.

    Idempotent: already-recorded steps are verified (checksum) and skipped.
    ``include_destructive`` additionally runs the gated M009 — do NOT pass it
    until the v3 service layer has run in production (see :func:`_m009_...`).
    """
    await _check_sqlite_floor(db)
    applied = await _applied_rows(db)
    done: List[int] = []
    for migration in MIGRATIONS:
        if migration.optional and not include_destructive:
            continue
        if migration.version in applied:
            recorded = applied[migration.version]
            if recorded and recorded != _checksum(migration.fn):
                raise MigrationError(
                    f"checksum mismatch for applied migration "
                    f"{migration.version} ({migration.name}) — "
                    "migration history must not be rewritten"
                )
            continue
        await _apply(db, migration, db_path=db_path)
        done.append(migration.version)
    await _sync_schema_meta(db)
    return done


__all__ = [
    "LEGACY_PRESET_NAME",
    "LEGACY_PRESET_RULES",
    "MIGRATIONS",
    "TARGET_SCHEMA_VERSION",
    "MigrationError",
    "backup_path",
    "ensure_legacy_config",
    "ensure_track",
    "legacy_rules_hash",
    "legacy_rules_json",
    "rollback_m007",
    "run",
]
