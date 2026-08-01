"""Schema v3 migration runner (WP3-A): M001–M010 against real databases.

Covers the acceptance points of the migration work package:

(a) a fresh database lands on complete v3 — and ``idx_runs_one_live`` does
    NOT exist;
(b) a populated v2 database migrates with exact data preservation (row
    counts, cursor → run_tracks states, legacy-preset binding, unique
    event keys);
(c) a second ``migrations.run()`` is a no-op (idempotency);
(d) the M005 trap: an app restart (``init_db`` again) does not resurrect
    ``idx_runs_one_live`` via the baseline script's CREATE IF NOT EXISTS;
(f) scripted rollback of M007 (index before columns) and a restore from the
    ``VACUUM INTO`` artifact.

The RUN-01 evidence tests (e) live in ``tests/test_db.py``
(``test_two_live_runs_of_the_same_playlist_are_allowed`` and
``test_cancelling_one_run_leaves_its_siblings_untouched``).
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import aiosqlite
import pytest
import pytest_asyncio

from app import db as db_module
from app import migrations, runs
from app.config import get_settings
from core import engine
from core.models import RunMode, RunState, RunStatus

# ---------------------------------------------------------------------------
# A real, populated v2 database (built with the frozen v2 baseline script)
# ---------------------------------------------------------------------------

#: run id → (user, playlist, mode, status, order, cursor)
V2_RUNS = {
    1: (1, "pl1", "controller", "active", ["a", "b", "c", "d", "e"], 2),
    2: (1, "pl1", "utility", "completed", ["c", "a", "b"], 3),
    3: (2, "pl2", "controller", "cancelled", ["x", "y"], 1),
    # A second active controller run for user 1 — legal in v2 (other
    # playlist), colliding with v3's idx_runs_one_playing → must be demoted.
    4: (1, "pl2", "controller", "active", ["m", "n"], 0),
}

V2_EVENTS = [  # (run_id, type, cursor, reason)
    (1, "run_created", 0, None),
    (1, "advanced", 1, "track_ended"),
    (1, "advanced", 2, "native_skip"),
    (2, "completed", 3, "track_ended"),
    (3, "cancelled", 1, None),
]

V2_SKIPPED = [  # (run_id, track_id, name, artist, reason)
    (1, "loc", "Home recording", "Me", "local_file"),
    (1, "a", "Twice", "Band", "duplicate"),   # collides with its own deck row
    (3, "", "Ohne ID", "X", "missing_id"),    # no provider id → local_key path
]


async def _seed_v2(path) -> None:
    """Build a real v2 database the way the v2 ``init_db`` did."""
    conn = await aiosqlite.connect(str(path))
    try:
        await conn.executescript(db_module._SCHEMA_SQL)
        await conn.execute(
            "INSERT INTO schema_meta (key, value) VALUES ('version', '2')"
        )
        await conn.execute(
            "INSERT INTO users (id, handle) VALUES (1, 'local-1'), (2, 'local-2')"
        )
        for run_id, (user_id, playlist, mode, status, order, cursor) in V2_RUNS.items():
            await conn.execute(
                "INSERT INTO runs (id, user_id, provider, playlist_id, "
                "playlist_name, mode, order_json, cursor, status, seed) "
                "VALUES (?, ?, 'spotify', ?, ?, ?, ?, ?, ?, 41)",
                (run_id, user_id, playlist,
                 "Alles" if playlist == "pl1" else "Zwei",
                 mode, json.dumps(order), cursor, status),
            )
        for run_id, type_, cursor, reason in V2_EVENTS:
            await conn.execute(
                "INSERT INTO run_events (run_id, type, cursor, reason) "
                "VALUES (?, ?, ?, ?)",
                (run_id, type_, cursor, reason),
            )
        for run_id, track_id, name, artist, reason in V2_SKIPPED:
            await conn.execute(
                "INSERT INTO skipped_tracks (run_id, track_id, name, artist, "
                "reason) VALUES (?, ?, ?, ?, ?)",
                (run_id, track_id, name, artist, reason),
            )
        await conn.commit()
    finally:
        await conn.close()


@pytest_asyncio.fixture
async def v2_database():
    """A populated v2 database, migrated to v3 by ``init_db``."""
    await _seed_v2(get_settings().db_abs_path)
    conn = await db_module.init_db()
    try:
        yield conn
    finally:
        await db_module.close_db()


async def _tables(conn) -> set:
    cur = await conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    return {row[0] for row in await cur.fetchall()}


async def _indexes(conn) -> set:
    cur = await conn.execute("SELECT name FROM sqlite_master WHERE type='index'")
    return {row[0] for row in await cur.fetchall()}


async def _one(conn, sql, params=()):
    cur = await conn.execute(sql, params)
    row = await cur.fetchone()
    return row[0] if row is not None else None


# ---------------------------------------------------------------------------
# (a) Fresh database → complete v3
# ---------------------------------------------------------------------------

async def test_fresh_database_lands_on_complete_v3(database):
    tables = await _tables(database)
    assert {"schema_migrations", "tracks", "playlists", "playlist_snapshots",
            "snapshot_items", "snapshot_diffs", "run_configs",
            "run_config_versions", "run_rule_bindings", "run_tracks",
            "run_plan", "run_selections", "provider_commands",
            "provider_observations", "deletion_requests"} <= tables

    indexes = await _indexes(database)
    assert {"idx_runs_user", "idx_runs_live", "idx_runs_one_playing",
            "idx_runs_name", "idx_events_key", "idx_tracks_provider",
            "idx_run_tracks_open", "idx_run_plan_state"} <= indexes
    # The UC-16 blocker must be gone — on a FRESH database too, because the
    # baseline script still creates it and M005 must take it away again.
    assert "idx_runs_one_live" not in indexes

    assert await _one(
        database, "SELECT value FROM schema_meta WHERE key='version'"
    ) == "3"
    cur = await database.execute("SELECT version FROM schema_migrations")
    versions = {row[0] for row in await cur.fetchall()}
    # Baseline + M001..M008 + M010 + M011.  M009 (order_json drop) is gated.
    # Teständerung 2026-08-01 (dokumentierte fachliche Begründung): M011
    # (deletion_requests.salt, F10-Stufe-3-Matching — app/retention.py) kam
    # als neue, nicht-destruktive Migration hinzu; der Versions-Pin wächst
    # exakt um diese eine erwartete Nummer.
    assert versions == {2, 301, 302, 303, 304, 305, 306, 307, 308, 310, 311}
    assert 309 not in versions


async def test_app_boot_smoke_create_run_on_fresh_v3(database):
    """App-boot smoke: the v2 call sites work unchanged on a fresh v3 DB,
    and a run without config lands on the user's legacy preset (M003)."""
    user_id = await db_module.get_or_create_user("local-1")
    run_id = await db_module.create_run(
        user_id=user_id, provider="spotify", playlist_id="pl1",
        playlist_name="Alles", mode="controller", order=["a", "b"],
    )
    run = await db_module.get_run(run_id, user_id=user_id)
    assert run["order"] == ["a", "b"]
    assert run["config_id"] is not None

    cur = await database.execute(
        "SELECT name, execution_strategy FROM run_configs WHERE id = ?",
        (run["config_id"],),
    )
    name, strategy = await cur.fetchone()
    assert name == migrations.LEGACY_PRESET_NAME
    assert strategy == "uris_window"          # ADR-002 default, frozen as data
    assert await _one(
        database,
        "SELECT rules_hash FROM run_config_versions WHERE config_id = ?",
        (run["config_id"],),
    ) == migrations.legacy_rules_hash()

    # The M007 unique key must not trip plain event recording.
    await db_module.record_event(run_id, "started", cursor=0)
    await db_module.record_event(run_id, "advanced", cursor=1)
    assert await _one(
        database, "SELECT count(*) FROM run_events WHERE run_id = ?", (run_id,)
    ) == 2


# ---------------------------------------------------------------------------
# (b) Populated v2 → migration → exact data preservation
# ---------------------------------------------------------------------------

async def test_v2_migration_preserves_row_counts(v2_database):
    assert await _one(v2_database, "SELECT count(*) FROM users") == 2
    assert await _one(v2_database, "SELECT count(*) FROM runs") == 4
    assert await _one(v2_database, "SELECT count(*) FROM skipped_tracks") == 3
    # 5 original events + exactly one audit event for the M005 demotion.
    assert await _one(v2_database, "SELECT count(*) FROM run_events") == 6
    assert await _one(
        v2_database,
        "SELECT count(*) FROM run_events WHERE reason = 'migration'"
    ) == 1
    # order_json stays authoritative until M009 — untouched.
    for run_id, (_, _, _, _, order, cursor) in V2_RUNS.items():
        run = await db_module.get_run(run_id)
        assert run["order"] == order
        assert run["cursor"] == cursor
        assert run["selection_seq"] == cursor
        assert run["snapshot_id"] is None     # no --derive-snapshots default


async def test_v2_migration_demotes_only_the_second_active_controller(v2_database):
    """idx_runs_one_playing: of user 1's two active controller runs the newest
    (id 4) stays active, the other becomes paused — live and resumable,
    nothing is cancelled or lost."""
    cur = await v2_database.execute("SELECT id, status FROM runs ORDER BY id")
    statuses = dict(await cur.fetchall())
    assert statuses == {1: "paused", 2: "completed", 3: "cancelled", 4: "active"}


async def test_v2_migration_backfills_the_run_layer_from_the_cursor(v2_database):
    # Run 1: order a..e, cursor 2 → a,b played (with their seq), c,d,e open.
    cur = await v2_database.execute(
        """
        SELECT t.provider_track_id, rt.state, rt.play_count, rt.last_played_seq
        FROM run_tracks rt JOIN tracks t ON t.id = rt.track_id
        WHERE rt.run_id = 1 AND rt.state IN ('open', 'played')
        ORDER BY t.provider_track_id
        """
    )
    deck = [tuple(r) for r in await cur.fetchall()]
    assert deck == [
        ("a", "played", 1, 0),
        ("b", "played", 1, 1),
        ("c", "open", 0, None),
        ("d", "open", 0, None),
        ("e", "open", 0, None),
    ]
    # Plan mirrors the cursor: consumed / current / planned.
    cur = await v2_database.execute(
        "SELECT seq, state FROM run_plan WHERE run_id = 1 ORDER BY seq"
    )
    assert [tuple(r) for r in await cur.fetchall()] == [
        (0, "consumed"), (1, "consumed"), (2, "current"),
        (3, "planned"), (4, "planned"),
    ]
    # Completed run: everything consumed, no current card.
    assert await _one(
        v2_database,
        "SELECT count(*) FROM run_plan WHERE run_id = 2 AND state != 'consumed'"
    ) == 0
    # Cancelled run keeps its history but holds no current card either.
    cur = await v2_database.execute(
        "SELECT seq, state FROM run_plan WHERE run_id = 3 ORDER BY seq"
    )
    assert [tuple(r) for r in await cur.fetchall()] == [(0, "consumed"), (1, "planned")]

    # Import exclusions became excluded_rule rows (M006/M008); the
    # 'duplicate' of run 1 collapses into its own deck row by design.
    assert await _one(
        v2_database, "SELECT count(*) FROM run_tracks WHERE run_id = 1"
    ) == 6  # 5 deck + 'loc'; the duplicate 'a' is already the deck row
    assert await _one(
        v2_database,
        "SELECT count(*) FROM run_tracks rt JOIN tracks t ON t.id = rt.track_id "
        "WHERE rt.run_id = 1 AND rt.state = 'excluded_rule' "
        "AND t.provider_track_id = 'loc'"
    ) == 1
    # The id-less exclusion of run 3 exists via its local_key identity.
    assert await _one(
        v2_database,
        "SELECT count(*) FROM run_tracks rt JOIN tracks t ON t.id = rt.track_id "
        "WHERE rt.run_id = 3 AND rt.state = 'excluded_rule' "
        "AND t.provider_track_id = '' AND t.local_key != ''"
    ) == 1
    assert await _one(v2_database, "SELECT count(*) FROM run_tracks") == 14
    assert await _one(v2_database, "SELECT count(*) FROM run_plan") == 12
    # Track identity dedup across runs: a..e, x, y, m, n, loc + 1 local-key.
    assert await _one(v2_database, "SELECT count(*) FROM tracks") == 11


async def test_v2_migration_binds_every_run_to_its_users_legacy_preset(v2_database):
    assert await _one(v2_database, "SELECT count(*) FROM run_configs") == 2
    cur = await v2_database.execute(
        "SELECT user_id, name, kind, repeat_mode, skip_policy, "
        "duplicate_policy, execution_strategy FROM run_configs ORDER BY user_id"
    )
    for user_id, row in zip((1, 2), await cur.fetchall(), strict=True):
        assert tuple(row) == (
            user_id, migrations.LEGACY_PRESET_NAME, "preset",
            "no_repeat", "consume", "collapse", "uris_window",
        )
    # Every run points at its OWN user's preset, never a stranger's.
    assert await _one(
        v2_database,
        "SELECT count(*) FROM runs r JOIN run_configs c ON c.id = r.config_id "
        "WHERE c.user_id != r.user_id"
    ) == 0
    assert await _one(
        v2_database, "SELECT count(*) FROM runs WHERE config_id IS NULL"
    ) == 0
    # The frozen version-1 rules are hash-verifiable (reproducibility).
    cur = await v2_database.execute(
        "SELECT rules_json, rules_hash FROM run_config_versions"
    )
    rows = await cur.fetchall()
    assert len(rows) == 2
    for rules_json, rules_hash in rows:
        assert json.loads(rules_json) == migrations.LEGACY_PRESET_RULES
        assert rules_hash == migrations.legacy_rules_hash()


async def test_v2_migration_makes_event_keys_unique(v2_database):
    cur = await v2_database.execute(
        "SELECT id, event_key, seq, applied, source FROM run_events ORDER BY id"
    )
    rows = await cur.fetchall()
    assert len(rows) == 6
    keys = set()
    for event_id, event_key, seq, applied, source in rows:
        assert event_key == f"legacy:{event_id}"
        assert seq == event_id
        assert applied == 1
        assert source == "system"
        keys.add(event_key)
    assert len(keys) == 6

    # playlists were normalised out of runs: one row per distinct triple.
    assert await _one(v2_database, "SELECT count(*) FROM playlists") == 3
    assert await _one(
        v2_database, "SELECT count(*) FROM runs WHERE playlist_ref_id IS NULL"
    ) == 0
    # Backfilled run names honour idx_runs_name (unique per user+playlist).
    cur = await v2_database.execute("SELECT id, name FROM runs ORDER BY id")
    assert dict(await cur.fetchall()) == {
        1: "Alles", 2: "Alles · 2", 3: "Zwei", 4: "Zwei",
    }


# ---------------------------------------------------------------------------
# (c) Idempotency
# ---------------------------------------------------------------------------

async def test_second_migration_run_is_a_noop(v2_database):
    cur = await v2_database.execute(
        "SELECT version, name, checksum, applied_at FROM schema_migrations "
        "ORDER BY version"
    )
    before = [tuple(r) for r in await cur.fetchall()]

    applied = await migrations.run(v2_database, db_path=get_settings().db_abs_path)
    assert applied == []

    cur = await v2_database.execute(
        "SELECT version, name, checksum, applied_at FROM schema_migrations "
        "ORDER BY version"
    )
    assert [tuple(r) for r in await cur.fetchall()] == before


# ---------------------------------------------------------------------------
# (d) The M005 trap: a restart must not resurrect idx_runs_one_live
# ---------------------------------------------------------------------------

async def test_restart_does_not_resurrect_idx_runs_one_live():
    """Blueprint risk 1: the baseline script says CREATE INDEX IF NOT EXISTS
    idx_runs_one_live — if init_db ever ran it against a migrated database,
    every restart would silently re-block UC-16."""
    await _seed_v2(get_settings().db_abs_path)
    conn = await db_module.init_db()
    try:
        assert "idx_runs_one_live" not in await _indexes(conn)
    finally:
        await db_module.close_db()

    # The app restart.
    conn = await db_module.init_db()
    try:
        assert "idx_runs_one_live" not in await _indexes(conn)
        # And the freedom it grants survives: a second live run of a playlist
        # that already has one (user 2, pl2 has the cancelled run 3 only —
        # use user 1 / pl1, whose paused run 1 is live).
        run_id = await db_module.create_run(
            user_id=1, provider="spotify", playlist_id="pl1",
            playlist_name="Alles", mode="controller", order=["z1", "z2"],
            status="paused",
        )
        assert run_id > 4
    finally:
        await db_module.close_db()


# ---------------------------------------------------------------------------
# M009 stays gated
# ---------------------------------------------------------------------------

async def test_m009_only_runs_behind_the_destructive_flag(v2_database):
    cur = await v2_database.execute("PRAGMA table_info(runs)")
    columns = {row[1] for row in await cur.fetchall()}
    assert "order_json" in columns            # the standard run must keep it

    applied = await migrations.run(
        v2_database, db_path=get_settings().db_abs_path, include_destructive=True
    )
    assert applied == [309]
    cur = await v2_database.execute("PRAGMA table_info(runs)")
    columns = {row[1] for row in await cur.fetchall()}
    assert "order_json" not in columns


# ---------------------------------------------------------------------------
# (f) Rollback: M007 scripted, M005 via the VACUUM INTO artifact
# ---------------------------------------------------------------------------

V2_EVENT_COLUMNS = {"id", "run_id", "type", "cursor", "reason", "detail",
                    "created_at"}


async def test_rollback_m007_drops_the_index_before_the_columns(v2_database):
    await migrations.rollback_m007(v2_database)

    cur = await v2_database.execute("PRAGMA table_info(run_events)")
    assert {row[1] for row in await cur.fetchall()} == V2_EVENT_COLUMNS
    indexes = await _indexes(v2_database)
    assert "idx_events_key" not in indexes
    tables = await _tables(v2_database)
    assert "provider_commands" not in tables
    assert "provider_observations" not in tables
    assert await _one(
        v2_database, "SELECT count(*) FROM schema_migrations WHERE version = 307"
    ) == 0
    # …and the events themselves survived the rollback.
    assert await _one(v2_database, "SELECT count(*) FROM run_events") == 6

    # Re-applying brings M007 back cleanly, with unique keys again.
    applied = await migrations.run(v2_database, db_path=get_settings().db_abs_path)
    assert applied == [307]
    total = await _one(v2_database, "SELECT count(*) FROM run_events")
    distinct = await _one(
        v2_database,
        "SELECT count(*) FROM (SELECT DISTINCT run_id, event_key FROM run_events)",
    )
    assert total == 6 and distinct == 6


async def test_vacuum_artifact_is_a_working_pre_v3_restore_point():
    db_path = get_settings().db_abs_path
    await _seed_v2(db_path)
    conn = await db_module.init_db()
    try:
        original_runs = await _one(conn, "SELECT count(*) FROM runs")
    finally:
        await db_module.close_db()

    artifact = migrations.backup_path(db_path)
    assert artifact.exists()

    # The artifact is the state right before the destructive M005: additive
    # steps applied, idx_runs_one_live still present, nothing demoted yet,
    # no run layer yet.
    backup = await aiosqlite.connect(str(artifact))
    try:
        assert "idx_runs_one_live" in await _indexes(backup)
        assert "run_tracks" not in await _tables(backup)
        assert await _one(backup, "SELECT count(*) FROM runs") == original_runs
        assert await _one(
            backup, "SELECT status FROM runs WHERE id = 1"
        ) == "active"                      # demotion happens only in M005
        assert await _one(
            backup, "SELECT max(version) FROM schema_migrations"
        ) == 304
        assert await _one(
            backup, "SELECT order_json FROM runs WHERE id = 1"
        ) == json.dumps(["a", "b", "c", "d", "e"])
    finally:
        await backup.close()

    # Restore drill: put the artifact in place of the database and boot the
    # app — init_db must migrate it forward to v3 again, losslessly.
    for leftover in (Path(str(db_path) + "-wal"), Path(str(db_path) + "-shm")):
        leftover.unlink(missing_ok=True)
    shutil.copyfile(artifact, db_path)

    conn = await db_module.init_db()
    try:
        assert "idx_runs_one_live" not in await _indexes(conn)
        assert await _one(conn, "SELECT count(*) FROM runs") == original_runs
        assert await _one(conn, "SELECT count(*) FROM run_plan") == 12
        assert await _one(
            conn, "SELECT value FROM schema_meta WHERE key='version'"
        ) == "3"
    finally:
        await db_module.close_db()


# ---------------------------------------------------------------------------
# F1: 'stopped' — not live, but resumable (models/engine/runs)
# ---------------------------------------------------------------------------

async def test_stopped_is_not_live_but_fully_resumable(database):
    user_id = await db_module.get_or_create_user("local-1")
    run_id = await db_module.create_run(
        user_id=user_id, provider="spotify", playlist_id="pl1",
        playlist_name="Alles", mode="controller", order=["a", "b", "c"],
    )
    await db_module.update_run(run_id, status="stopped", cursor=1)

    run = await db_module.get_run(run_id, user_id=user_id)
    assert run["status"] == "stopped"
    assert run["stopped_at"]                       # F1: the deliberate end is stamped
    # Not live: it leaves the "Jetzt" surface…
    assert await db_module.find_live_run(user_id, "spotify", "pl1", "controller") is None

    state = RunState(
        run_id=run_id, user_id=user_id, provider="spotify", playlist_id="pl1",
        mode=RunMode.CONTROLLER, order=["a", "b", "c"], cursor=1,
        status=RunStatus.STOPPED,
    )
    # …and the engine refuses to advance it, with a resume-friendly text
    # rather than the terminal one.
    with pytest.raises(engine.RunError) as excinfo:
        engine.ensure_live(state)
    assert "gestoppt" in str(excinfo.value)
    assert "fort" in str(excinfo.value)            # invites resumption

    # stopped → active brings it back at exactly the same card.
    resumed = await runs.resume(None, state)
    assert resumed.status is RunStatus.ACTIVE
    run = await db_module.get_run(run_id, user_id=user_id)
    assert run["status"] == "active"
    assert run["cursor"] == 1

    # Truly terminal statuses still refuse to resume.
    state.status = RunStatus.CANCELLED
    with pytest.raises(engine.RunError):
        engine.resume_status(state)
