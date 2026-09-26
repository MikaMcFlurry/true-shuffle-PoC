/**
 * UserHub storage schema.
 *
 * Designed for the Workers free plan's daily row budget (100 000 written,
 * 5 000 000 read, account-wide): big lists are stored packed — a playlist's
 * tracks as JSON pages of 50, imported history as pages of 500 — so a
 * 10 000-song library costs ~200 row writes instead of ~20 000, and the
 * planner reads it back in a few hundred rows.
 *
 * Migrations are append-only; each entry runs once, in order.
 */

import type { SqlDb } from "../lib/sql";

const MIGRATIONS: string[][] = [
	[
		`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`,
		`CREATE TABLE IF NOT EXISTS playlists (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			owner_id TEXT,
			owner_name TEXT,
			image_url TEXT,
			total INTEGER,
			snapshot_id TEXT,
			readable INTEGER NOT NULL DEFAULT 1,
			ours INTEGER NOT NULL DEFAULT 0,
			imported_snapshot TEXT,
			imported_count INTEGER,
			skipped_count INTEGER,
			imported_at INTEGER,
			sort INTEGER NOT NULL DEFAULT 0,
			seen_at INTEGER NOT NULL DEFAULT 0
		) WITHOUT ROWID`,
		// source = 'pl:<playlist id>' | 'liked'; data = JSON array of packed tracks.
		`CREATE TABLE IF NOT EXISTS pages (
			source TEXT NOT NULL,
			page INTEGER NOT NULL,
			data TEXT NOT NULL,
			PRIMARY KEY (source, page)
		) WITHOUT ROWID`,
		`CREATE TABLE IF NOT EXISTS memory (
			id TEXT PRIMARY KEY,
			last_played_at INTEGER,
			plays INTEGER NOT NULL DEFAULT 0,
			early_skips INTEGER NOT NULL DEFAULT 0,
			last_skipped_at INTEGER,
			thumb INTEGER NOT NULL DEFAULT 0
		) WITHOUT ROWID`,
		`CREATE TABLE IF NOT EXISTS hist_pages (page INTEGER PRIMARY KEY, data TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS stations (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			kind TEXT NOT NULL,
			sources TEXT NOT NULL,
			rules TEXT NOT NULL,
			sort INTEGER NOT NULL DEFAULT 0,
			round_no INTEGER NOT NULL DEFAULT 1,
			round_started_at INTEGER NOT NULL,
			fresh_remaining INTEGER,
			pool_size INTEGER,
			playlist_id TEXT,
			deck TEXT,
			deck_dirty INTEGER NOT NULL DEFAULT 1,
			stats TEXT,
			created_at INTEGER NOT NULL,
			last_played_at INTEGER
		)`,
		`CREATE TABLE IF NOT EXISTS bans (
			station_id INTEGER NOT NULL,
			track_id TEXT NOT NULL,
			at INTEGER NOT NULL,
			PRIMARY KEY (station_id, track_id)
		) WITHOUT ROWID`,
		`CREATE TABLE IF NOT EXISTS discoveries (
			station_id INTEGER NOT NULL,
			id TEXT NOT NULL,
			source TEXT NOT NULL,
			score REAL NOT NULL,
			status TEXT NOT NULL DEFAULT 'candidate',
			meta TEXT NOT NULL,
			heard INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (station_id, id)
		) WITHOUT ROWID`,
		`CREATE TABLE IF NOT EXISTS plays (
			played_at INTEGER NOT NULL,
			track_id TEXT NOT NULL,
			context_uri TEXT,
			station_id INTEGER,
			ignored INTEGER NOT NULL DEFAULT 0,
			meta TEXT,
			PRIMARY KEY (played_at, track_id)
		) WITHOUT ROWID`,
		`CREATE TABLE IF NOT EXISTS jobs (
			key TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			state TEXT NOT NULL,
			priority INTEGER NOT NULL DEFAULT 5,
			run_after INTEGER NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			error TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		) WITHOUT ROWID`,
		`CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY,
			at INTEGER NOT NULL,
			level TEXT NOT NULL,
			kind TEXT NOT NULL,
			message TEXT NOT NULL
		)`,
	],
	[
		// A source playlist the listener deleted in Spotify: kept (for its name)
		// and marked, so its station plays on without it instead of waiting.
		`ALTER TABLE playlists ADD COLUMN gone_at INTEGER`,
		// Recent plays per station without scanning the whole plays table.
		`CREATE INDEX IF NOT EXISTS plays_by_station ON plays (station_id, played_at)`,
		// A song's discovery rows, looked up on every play.
		`CREATE INDEX IF NOT EXISTS discoveries_by_track ON discoveries (id)`,
	],
	[
		// An early skip seen under the "consume" rule uses the song up for the
		// round; one only inferred does not (last_skipped_at covers both).
		`ALTER TABLE memory ADD COLUMN consumed_at INTEGER`,
	],
];

export function migrate(db: SqlDb): void {
	db.run(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`);
	const row = db.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'schema_version'`);
	let version = row ? Number(row.v) : 0;
	while (version < MIGRATIONS.length) {
		const steps = MIGRATIONS[version]!;
		db.transaction(() => {
			for (const stmt of steps) db.run(stmt);
			db.run(
				`INSERT INTO kv (k, v) VALUES ('schema_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
				String(version + 1),
			);
		});
		version++;
	}
}

export const SCHEMA_VERSION = MIGRATIONS.length;
