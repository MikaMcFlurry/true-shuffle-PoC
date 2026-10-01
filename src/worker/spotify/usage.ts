import type {
	SpotifyUsageEpisode,
	SpotifyUsageOperation,
	SpotifyUsageReport,
	SpotifyUsageTotals,
} from "../../shared/spotify-usage";
import type { SqlDb } from "../lib/sql";
import { parseRetryAfter, type SpotifyRequestMetric } from "./client";
import { safeOperation } from "./operation-gates";

const HOUR = 3_600_000;
export const USAGE_RETENTION_HOURS = 720;
const empty = (): SpotifyUsageTotals => ({
	sent: 0,
	read: 0,
	write: 0,
	refresh: 0,
	blocked: 0,
	quota: 0,
	rate: 0,
	network: 0,
});
function add(to: SpotifyUsageTotals, from: SpotifyUsageTotals) {
	for (const k of Object.keys(to) as Array<keyof SpotifyUsageTotals>) to[k] += from[k];
}
interface Bucket {
	totals: SpotifyUsageTotals;
	operations: Record<string, { totals: SpotifyUsageTotals; responses: Record<string, number> }>;
}
/** SQLite-only aggregate recorder; never causes Spotify requests or inferred quota limits. */
export class SpotifyUsageTracker {
	constructor(
		private readonly sql: SqlDb,
		private readonly now: () => number,
	) {}
	init() {
		this.sql.run(
			"CREATE TABLE IF NOT EXISTS spotify_usage_meta (id INTEGER PRIMARY KEY CHECK(id=1), started_at INTEGER NOT NULL)",
		);
		this.sql.run(
			"CREATE TABLE IF NOT EXISTS spotify_usage_listeners (private_key TEXT PRIMARY KEY, slot INTEGER NOT NULL) WITHOUT ROWID",
		);
		this.sql.run(
			"CREATE TABLE IF NOT EXISTS spotify_usage_hours (hour INTEGER NOT NULL, slot INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(hour,slot)) WITHOUT ROWID",
		);
		this.sql.run(
			"CREATE TABLE IF NOT EXISTS spotify_usage_episodes (id INTEGER PRIMARY KEY AUTOINCREMENT, slot INTEGER NOT NULL, actor TEXT, operation TEXT NOT NULL, first_failure_at INTEGER NOT NULL, last_failure_at INTEGER NOT NULL, reason TEXT, retry_after TEXT, earliest_retry_at INTEGER, attempts INTEGER NOT NULL, last_attempt_at INTEGER NOT NULL, last_status INTEGER NOT NULL, first_success_at INTEGER)",
		);
		if (
			!this.sql
				.all<{ name: string }>("PRAGMA table_info(spotify_usage_episodes)")
				.some((c) => c.name === "actor")
		)
			this.sql.run("ALTER TABLE spotify_usage_episodes ADD COLUMN actor TEXT");
		this.sql.run(
			"UPDATE spotify_usage_episodes SET first_success_at=NULL WHERE actor IS NULL AND first_success_at IS NOT NULL",
		);
	}
	private slot(privateKey: string): number {
		if (privateKey === "@signin" || privateKey.startsWith("@signin:")) return 0;
		const existing = this.sql.first<{ slot: number }>(
			"SELECT slot FROM spotify_usage_listeners WHERE private_key=?",
			privateKey,
		);
		if (existing) return existing.slot;
		const used =
			this.sql.first<{ n: number }>("SELECT COUNT(*) AS n FROM spotify_usage_listeners")?.n ?? 0;
		// First five observed listeners have stable anonymous labels; overflow remains counted, never dropped.
		if (used >= 5) return 6;
		const slot = used + 1;
		this.sql.run(
			"INSERT INTO spotify_usage_listeners(private_key,slot) VALUES(?,?)",
			privateKey,
			slot,
		);
		return slot;
	}
	record(privateKey: string, metric: SpotifyRequestMetric): void {
		this.init();
		this.sql.transaction(() => {
			const now = this.now();
			const at = Math.min(now, Math.max(0, metric.at));
			const hour = Math.floor(at / HOUR);
			this.sql.run("INSERT OR IGNORE INTO spotify_usage_meta(id,started_at) VALUES(1,?)", at);
			this.sql.run(
				"DELETE FROM spotify_usage_hours WHERE hour < ?",
				Math.floor(now / HOUR) - USAGE_RETENTION_HOURS + 1,
			);
			const slot = this.slot(privateKey);
			const method = (metric.method ?? (metric.category === "read" ? "GET" : "POST")).toUpperCase();
			// Client already sanitizes paths; independently refuse dynamic/raw data at this storage boundary.
			const operation = safeOperation(method, metric.endpoint);
			const row = this.sql.first<{ data: string }>(
				"SELECT data FROM spotify_usage_hours WHERE hour=? AND slot=?",
				hour,
				slot,
			);
			const bucket: Bucket = row ? JSON.parse(row.data) : { totals: empty(), operations: {} };
			const delta = empty();
			if (metric.retryCategory === "blocked") delta.blocked = 1;
			else {
				delta.sent = 1;
				delta[metric.category] = 1;
				if (metric.status === 429) {
					if (metric.retryCategory === "quota") delta.quota = 1;
					else delta.rate = 1;
				}
				if (metric.status === 0) delta.network = 1;
			}
			add(bucket.totals, delta);
			if (!bucket.operations[operation])
				bucket.operations[operation] = { totals: empty(), responses: {} };
			const op = bucket.operations[operation]!;
			add(op.totals, delta);
			const response = `${metric.status}:${metric.retryCategory}`;
			op.responses[response] = (op.responses[response] ?? 0) + 1;
			this.sql.run(
				"INSERT INTO spotify_usage_hours(hour,slot,data) VALUES(?,?,?) ON CONFLICT(hour,slot) DO UPDATE SET data=excluded.data",
				hour,
				slot,
				JSON.stringify(bucket),
			);
			if (metric.retryCategory !== "blocked") {
				const pending = this.sql.first<{ id: number; last_failure_at: number }>(
					"SELECT id,last_failure_at FROM spotify_usage_episodes WHERE actor=? AND operation=? AND first_success_at IS NULL ORDER BY id DESC LIMIT 1",
					privateKey,
					operation,
				);
				if (metric.status === 429) {
					const parsed = parseRetryAfter(metric.retryAfter, at);
					const retryAfter = parsed?.raw ?? null;
					const earliest = parsed ? at + parsed.ms : null;
					const reason = ["QUOTA_EXCEEDED", "RATE_LIMITED", "UNKNOWN"].includes(metric.reason ?? "")
						? metric.reason!
						: null;
					if (pending)
						this.sql.run(
							"UPDATE spotify_usage_episodes SET last_failure_at=?, reason=?,retry_after=?,earliest_retry_at=?,attempts=attempts+1,last_attempt_at=?,last_status=? WHERE id=?",
							at,
							reason,
							retryAfter,
							earliest,
							at,
							metric.status,
							pending.id,
						);
					else
						this.sql.run(
							"INSERT INTO spotify_usage_episodes(slot,actor,operation,first_failure_at,last_failure_at,reason,retry_after,earliest_retry_at,attempts,last_attempt_at,last_status) VALUES(?,?,?,?,?,?,?,?,1,?,?)",
							slot,
							privateKey,
							operation,
							at,
							at,
							reason,
							retryAfter,
							earliest,
							at,
							metric.status,
						);
				} else if (pending)
					this.sql.run(
						"UPDATE spotify_usage_episodes SET attempts=attempts+1,last_attempt_at=?,last_status=?,first_success_at=? WHERE id=?",
						at,
						metric.status,
						privateKey !== "@signin" &&
							metric.status >= 200 &&
							metric.status < 300 &&
							(metric.startedAt ?? at) >= pending.last_failure_at
							? at
							: null,
						pending.id,
					);
			}
			this.sql.run(
				"DELETE FROM spotify_usage_episodes WHERE id NOT IN (SELECT id FROM spotify_usage_episodes ORDER BY id DESC LIMIT 200)",
			);
			this.sql.run(
				"DELETE FROM spotify_usage_episodes WHERE last_attempt_at < ?",
				now - USAGE_RETENTION_HOURS * HOUR,
			);
		});
	}
	report(registeredListeners: number): SpotifyUsageReport {
		this.init();
		const now = this.now();
		const totals = empty();
		const listeners = new Map<number, SpotifyUsageTotals>();
		const operations = new Map<string, SpotifyUsageOperation>();
		const hours = new Map<number, SpotifyUsageTotals>();
		for (const row of this.sql.all<{ hour: number; slot: number; data: string }>(
			"SELECT hour,slot,data FROM spotify_usage_hours WHERE hour>=? AND hour<=? ORDER BY hour",
			Math.floor(now / HOUR) - USAGE_RETENTION_HOURS + 1,
			Math.floor(now / HOUR),
		)) {
			const bucket: Bucket = JSON.parse(row.data);
			add(totals, bucket.totals);
			if (!listeners.has(row.slot)) listeners.set(row.slot, empty());
			add(listeners.get(row.slot)!, bucket.totals);
			if (!hours.has(row.hour)) hours.set(row.hour, empty());
			add(hours.get(row.hour)!, bucket.totals);
			for (const [operation, value] of Object.entries(bucket.operations)) {
				if (!operations.has(operation))
					operations.set(operation, { operation, totals: empty(), responses: {} });
				const op = operations.get(operation)!;
				add(op.totals, value.totals);
				for (const [k, n] of Object.entries(value.responses))
					op.responses[k] = (op.responses[k] ?? 0) + n;
			}
		}
		const label = (slot: number) =>
			slot === 0 ? "Anmeldung" : slot === 6 ? "Weitere Nutzer" : `Nutzer ${slot}`;
		const episodes = this.sql
			.all<{
				id: number;
				slot: number;
				operation: string;
				first_failure_at: number;
				last_failure_at: number;
				reason: string | null;
				retry_after: string | null;
				earliest_retry_at: number | null;
				attempts: number;
				last_attempt_at: number;
				last_status: number;
				first_success_at: number | null;
			}>(
				"SELECT * FROM spotify_usage_episodes WHERE last_attempt_at>=? ORDER BY id DESC LIMIT 200",
				now - USAGE_RETENTION_HOURS * HOUR,
			)
			.map(
				(x): SpotifyUsageEpisode => ({
					id: x.id,
					listener: label(x.slot),
					operation: x.operation,
					firstFailureAt: x.first_failure_at,
					lastFailureAt: x.last_failure_at,
					reason: x.reason,
					retryAfter: x.retry_after,
					earliestRetryAt: x.earliest_retry_at,
					attempts: x.attempts,
					lastAttemptAt: x.last_attempt_at,
					lastStatus: x.last_status,
					firstSuccessAt: x.first_success_at,
				}),
			);
		return {
			policy: "confirmed-operation-v1",
			generatedAt: now,
			startedAt:
				this.sql.first<{ started_at: number }>(
					"SELECT started_at FROM spotify_usage_meta WHERE id=1",
				)?.started_at ?? null,
			retentionHours: USAGE_RETENTION_HOURS,
			listenerCapacity: 5,
			registeredListeners,
			observedListeners: [...listeners.keys()].filter((n) => n > 0 && n < 6).length,
			overflowObserved: listeners.has(6),
			totals,
			listeners: [...listeners].map(([slot, totals]) => ({ listener: label(slot), totals })),
			operations: [...operations.values()].sort((a, b) => b.totals.sent - a.totals.sent),
			hours: [...hours].map(([hour, totals]) => ({ hour, totals })),
			episodes,
		};
	}
}
