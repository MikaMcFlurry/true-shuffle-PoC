/**
 * HubCore — everything True Shuffle knows and does for one listener.
 *
 * Runs inside that listener's Durable Object (single-threaded, so the
 * background sync and a tap in the app never race), and in tests on
 * node:sqlite with the Spotify fake and a fake clock.
 *
 * The reliability model, in one paragraph: a station's order lives in a
 * private Spotify playlist that Spotify plays by itself on any device.
 * True Shuffle never has to be "in the loop" while music plays. It only
 * (a) reads what was heard from Spotify's recently-played list into a
 * global per-song memory, (b) reads the player position to tell early skips
 * from plays, and (c) rewrites a station's playlist from that memory when
 * nobody is listening to it. If anything is missed, memory still holds —
 * which is why progress cannot be lost.
 */

import {
	applyPlays,
	CONTINUE_AHEAD,
	consumedCount,
	continueLayout,
	type Deck,
	heldForPlayer,
	newDeck,
	observePlayer,
	type PlayerObservation,
	position,
	type RecentPlay,
	remainingAhead,
	SKIP_GRACE_MS,
	settleSkips,
} from "../../core/deck";
import { fromRow, type HistoryRow } from "../../core/history";
import {
	coolingDown,
	heardInRound,
	type ImportedStats,
	isBlocked,
	mergeMemory,
	RECENT_GUARD_MS,
} from "../../core/memory";
import { type DiscoveryEntry, type PoolEntry, planQueue } from "../../core/planner";
import type { Rng } from "../../core/random";
import {
	DAY_MS,
	DEFAULT_RULES,
	emptyMemory,
	HOUR_MS,
	MINUTE_MS,
	normaliseRules,
	type PlannedSlot,
	type SkipPolicy,
	type SlotKind,
	type StationRules,
	type TrackId,
	type TrackMemory,
} from "../../core/types";
import type {
	AppState,
	DeviceView,
	HistoryEntry,
	JobView,
	NowPlaying,
	PlayErrorCode,
	PlaylistView,
	PlayResult,
	StationDetail,
	StationKind,
	StationSource,
	StationSummary,
	TrackView,
	Warning,
} from "../../shared/api";
import type { Keys } from "../lib/crypto";
import type { SqlDb } from "../lib/sql";
import {
	type Fetcher,
	RequestBudget,
	SpotifyClient,
	type SpotifyEndpoints,
	SpotifyError,
	type SpotifyTokens,
	type TokenStore,
} from "../spotify/client";
import type { SpPlaybackState, SpTrack } from "../spotify/types";
import { type AiRunner, type DiscoveryState, discoverStep } from "./discovery";
import {
	artistLine,
	PAGE_SIZE,
	type PackedTrack,
	packTrack,
	pickImage,
	sourceKey,
	toPoolEntry,
} from "./library";
import { migrate } from "./schema";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Songs written into a station's playlist: ~17 hours of music. */
export const DECK_SIZE = 300;
/** Append more songs when fewer than this are left ahead while playing. */
export const EXTEND_BELOW = 25;
/** A deck is rewritten only after nobody listened to it for this long. */
export const IDLE_BEFORE_REBUILD_MS = 10 * MINUTE_MS;
/** A song left behind, waiting for its play to show up before it counts as skipped. */
/** The player is in this station's playlist; `index` in the current version, if there. */
interface InStation {
	st: number;
	uri: string;
	inDeck: boolean;
	index: number | null;
}

interface PendingSkip {
	id: TrackId;
	st: number;
	at: number;
	/** When it was first seen playing. */
	since?: number;
	/** Seen playing before it was left (not only inferred between two looks). */
	seen?: boolean;
}

/**
 * Stations per account. Measured with a Durable Object evicted between
 * requests: 33 stations and 25 000 remembered songs cost ≈ 260 000 rows read
 * per listener-day, so five such accounts stay near a quarter of the free plan.
 */
export const MAX_STATIONS = 30;

/** How far back a play may arrive late in recently-played and still count. */
const LATE_PLAY_WINDOW_MS = 24 * HOUR_MS;
/** Single plays are kept this long (memory keeps the totals for good). */
const PLAYS_KEEP_MS = 180 * DAY_MS;
const PRUNE_PER_DAY = 500;

/**
 * A deck used this recently may still be loaded in a player (a car stop, a
 * phone that went quiet): its rewrite continues it instead of replanning.
 */
const CONTINUE_WITHIN_MS = 12 * HOUR_MS;

/** A player snapshot older than this cannot vouch that nobody is listening. */
const PLAYER_FRESH_MS = 5 * MINUTE_MS;
/** Refresh decks that were written longer ago than this (memory drifted). */
export const DECK_MAX_AGE_MS = 20 * HOUR_MS;
/** External requests per invocation (Workers free plan allows 50). */
export const BUDGET_PER_INVOCATION = 40;
/** Discoveries heard once may come back after this long ("probation"). */
export const DISCOVERY_SECOND_CHANCE_MS = 7 * DAY_MS;
/** Guest mode switches itself off after this long unless extended. */
export const GUEST_DEFAULT_HOURS = 6;

export const DECK_NAME_PREFIX = "True Shuffle · ";
const DECK_DESCRIPTION = (name: string) =>
	`Dein True-Shuffle-Sender „${name}“. Einfach abspielen — Shuffle bleibt aus. True Shuffle befüllt diese Playlist automatisch neu.`;
const DISCOVERIES_NAME = `${DECK_NAME_PREFIX}Entdeckungen`;
const DISCOVERIES_DESCRIPTION =
	"Neuentdeckungen, die dir in True Shuffle gefallen haben. Wird automatisch ergänzt.";

export interface HubEnv {
	endpoints: SpotifyEndpoints;
	lastfmBase: string;
	lastfmKey: string | null;
	deezerBase: string;
	anthropicKey: string | null;
	anthropicModel: string;
}

export interface HubDeps {
	sql: SqlDb;
	fetch: Fetcher;
	now: () => number;
	rng: Rng;
	keys: Keys;
	env: HubEnv;
	alarms: { set(at: number): Promise<void>; get(): Promise<number | null> };
	ai: AiRunner | null;
	wipe?: () => Promise<void>;
}

interface StationRow {
	id: number;
	name: string;
	kind: StationKind;
	sources: string;
	rules: string;
	sort: number;
	round_no: number;
	round_started_at: number;
	fresh_remaining: number | null;
	pool_size: number | null;
	playlist_id: string | null;
	deck: string | null;
	deck_dirty: number;
	stats: string | null;
	created_at: number;
	last_played_at: number | null;
}

interface MemoryRow {
	id: string;
	last_played_at: number | null;
	plays: number;
	early_skips: number;
	last_skipped_at: number | null;
	consumed_at: number | null;
	thumb: number;
}

interface JobRow {
	key: string;
	kind: string;
	state: string;
	priority: number;
	run_after: number;
	attempts: number;
	error: string | null;
}

interface PlayerSnapshot {
	obs: PlayerObservation | null;
	track: PackedTrack | null;
	device: { id: string | null; name: string; restricted: boolean } | null;
	at: number;
}

interface GuestPeriod {
	from: number;
	to: number;
}

interface SyncState {
	recentCursor: number;
	lastRecentAt: number;
	lastPlayerAt: number;
	lastActivityAt: number;
	idleSince: number | null;
	shuffleFixAt: number;
	lastPlaylistsAt: number;
	lastLikedAt: number;
}

type StepResult = { done: true } | { done: false; state: unknown; delayMs?: number };

export class HubError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

// ---------------------------------------------------------------------------

export class HubCore {
	private readonly db: SqlDb;
	private sourceCache = new Map<string, PackedTrack[]>();
	private histCache: Map<TrackId, ImportedStats> | null = null;
	private likedCache: Set<TrackId> | null = null;
	private indexCache: Map<TrackId, PackedTrack> | null = null;

	constructor(private readonly d: HubDeps) {
		const raw = d.sql;
		const cache = this.cache;
		// Every write to the stations table drops the cached list of stations.
		this.db = {
			all: (q, ...p) => raw.all(q, ...p),
			first: (q, ...p) => raw.first(q, ...p),
			run: (q, ...p) => {
				if (/\bstations\b/i.test(q)) cache.stations = null;
				raw.run(q, ...p);
			},
			transaction: (fn) => raw.transaction(fn),
		};
		migrate(this.db);
	}

	/**
	 * The stations, read once until one of them changes (handed out as copies:
	 * callers may edit). Shared with the write path above, which clears it.
	 */
	private readonly cache: { stations: StationRow[] | null } = { stations: null };
	/** When this instance last looked at the player (also when nothing changed). */
	private lastLookAt = 0;

	private now(): number {
		return this.d.now();
	}

	// =======================================================================
	// Key/value and small helpers
	// =======================================================================

	private kvGet<T>(k: string): T | null {
		const row = this.db.first<{ v: string }>(`SELECT v FROM kv WHERE k = ?`, k);
		if (!row) return null;
		try {
			return JSON.parse(row.v) as T;
		} catch {
			return null;
		}
	}

	private kvSet(k: string, v: unknown): void {
		this.db.run(
			`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
			k,
			JSON.stringify(v),
		);
	}

	private kvDel(k: string): void {
		this.db.run(`DELETE FROM kv WHERE k = ?`, k);
	}

	private log(level: "info" | "warn" | "error", kind: string, message: string): void {
		this.db.run(
			`INSERT INTO events (at, level, kind, message) VALUES (?, ?, ?, ?)`,
			this.now(),
			level,
			kind,
			message.slice(0, 500),
		);
		this.db.run(`DELETE FROM events WHERE id <= (SELECT MAX(id) - 300 FROM events)`);
		// Also to the Worker's logs (dashboard → Observability).
		console.log(JSON.stringify({ level, kind, message: message.slice(0, 500) }));
	}

	private syncState(): SyncState {
		return {
			recentCursor: 0,
			lastRecentAt: 0,
			lastPlayerAt: 0,
			lastActivityAt: 0,
			idleSince: null,
			shuffleFixAt: 0,
			lastPlaylistsAt: 0,
			lastLikedAt: 0,
			...(this.kvGet<Partial<SyncState>>("sync") ?? {}),
		};
	}

	/**
	 * Every row written counts against the account's daily writes: clocks that
	 * moved by less than a minute change no decision and are not stored.
	 */
	private setSyncState(s: SyncState): void {
		const cur = this.kvGet<SyncState>("sync");
		const clocks: (keyof SyncState)[] = ["lastActivityAt", "lastRecentAt"];
		const same =
			cur &&
			(Object.keys(s) as (keyof SyncState)[]).every((k) =>
				k === "lastPlayerAt"
					? true
					: clocks.includes(k)
						? Math.abs((s[k] ?? 0) - (cur[k] ?? 0)) < MINUTE_MS
						: s[k] === (cur[k] ?? null),
			);
		if (!same) this.kvSet("sync", s);
	}

	// =======================================================================
	// Connection
	// =======================================================================

	private tokenStore(): TokenStore {
		return {
			get: async () => {
				const box = this.kvGet<string>("tokens");
				if (!box) return null;
				return JSON.parse(await this.d.keys.decrypt(box)) as SpotifyTokens;
			},
			set: async (t) => {
				this.kvSet("tokens", await this.d.keys.encrypt(JSON.stringify(t)));
			},
		};
	}

	private client(budget: RequestBudget): SpotifyClient {
		return new SpotifyClient({
			endpoints: this.d.env.endpoints,
			tokens: this.tokenStore(),
			budget,
			fetch: this.d.fetch,
			now: () => this.now(),
		});
	}

	isConnected(): boolean {
		return this.kvGet<string>("tokens") !== null && this.kvGet("auth_lost") === null;
	}

	/** The listener's current sign-in generation; signing out anywhere ends all. */
	sessionEpoch(): number {
		let epoch = this.kvGet<number>("session_epoch");
		if (epoch === null) {
			// Random start: after an account is deleted and made again, cookies
			// revoked before must not match the new count.
			epoch = 1 + Math.floor(this.d.rng() * 2 ** 30);
			this.kvSet("session_epoch", epoch);
		}
		return epoch;
	}

	checkSession(epoch: number): void {
		if (epoch !== this.sessionEpoch())
			throw new HubError("auth", "Bitte mit Spotify anmelden.", 401);
	}

	/** Sign out: every session cookie issued so far stops working. */
	endSessions(): void {
		this.kvSet("session_epoch", this.sessionEpoch() + 1);
		this.log("info", "connect", "Abgemeldet");
	}

	async connect(
		profile: { id: string; name: string; imageUrl: string | null },
		tokens: SpotifyTokens,
	): Promise<number> {
		await this.tokenStore().set(tokens);
		this.kvSet("profile", profile);
		this.kvDel("auth_lost");
		this.kvDel("suspended");
		if (!this.kvGet("created_at")) {
			this.kvSet("created_at", this.now());
			// Start the recently-played cursor now: history from before the first
			// sign-in arrives through the optional import, not through a partial
			// 50-song window.
			const s = this.syncState();
			s.recentCursor = this.now() - HOUR_MS * 3;
			this.setSyncState(s);
			this.kvSet("live_since", s.recentCursor);
		}
		this.enqueue("playlists", "playlists", {}, 1);
		this.log("info", "connect", `Mit Spotify verbunden als ${profile.name}`);
		await this.scheduleSoon(1000);
		return this.sessionEpoch();
	}

	private markAuthLost(): void {
		if (this.kvGet("auth_lost") === null) {
			this.kvSet("auth_lost", this.now());
			this.log("warn", "auth", "Spotify-Anmeldung abgelaufen — bitte neu verbinden");
		}
	}

	// =======================================================================
	// Jobs
	// =======================================================================

	private enqueue(key: string, kind: string, state: unknown, priority = 5, delayMs = 0): void {
		const now = this.now();
		this.db.run(
			`INSERT INTO jobs (key, kind, state, priority, run_after, attempts, error, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET
			   run_after = MIN(jobs.run_after, excluded.run_after),
			   priority = MIN(jobs.priority, excluded.priority),
			   updated_at = excluded.updated_at`,
			key,
			kind,
			JSON.stringify(state),
			priority,
			now + delayMs,
			now,
			now,
		);
	}

	private jobExists(key: string): boolean {
		return this.db.first(`SELECT key FROM jobs WHERE key = ?`, key) !== null;
	}

	private async runJobs(budget: RequestBudget): Promise<void> {
		const client = this.client(budget);
		for (let guard = 0; guard < 50; guard++) {
			if (this.backoffUntil() > this.now()) return;
			if (budget.left < 6) return;
			const job = this.db.first<JobRow>(
				`SELECT * FROM jobs WHERE run_after <= ? ORDER BY priority ASC, run_after ASC LIMIT 1`,
				this.now(),
			);
			if (!job) return;
			let result: StepResult;
			try {
				result = await this.step(job, client, budget);
			} catch (err) {
				if (err instanceof SpotifyError && err.kind === "budget") {
					return; // resume on the next invocation
				}
				this.handleJobError(job, err);
				continue;
			}
			if (result.done) {
				this.db.run(`DELETE FROM jobs WHERE key = ?`, job.key);
			} else {
				this.db.run(
					`UPDATE jobs SET state = ?, run_after = ?, attempts = 0, error = NULL, updated_at = ? WHERE key = ?`,
					JSON.stringify(result.state),
					this.now() + (result.delayMs ?? 0),
					this.now(),
					job.key,
				);
			}
		}
	}

	private handleJobError(job: JobRow, err: unknown): void {
		const msg = err instanceof Error ? err.message : String(err);
		if (err instanceof SpotifyError) {
			if (err.kind === "rate" || err.kind === "quota") {
				this.setBackoff(err.retryAfterMs, err.kind);
				this.db.run(
					`UPDATE jobs SET run_after = ?, error = ? WHERE key = ?`,
					this.now() + err.retryAfterMs,
					msg,
					job.key,
				);
				return;
			}
			if (err.kind === "auth") {
				this.markAuthLost();
				this.db.run(
					`UPDATE jobs SET run_after = ?, error = ? WHERE key = ?`,
					this.now() + HOUR_MS,
					msg,
					job.key,
				);
				return;
			}
		}
		const attempts = job.attempts + 1;
		if (attempts >= 6) {
			this.log("error", "job", `${job.key} aufgegeben: ${msg}`);
			this.db.run(`DELETE FROM jobs WHERE key = ?`, job.key);
			return;
		}
		const delay = Math.min(6 * HOUR_MS, 30_000 * 2 ** attempts);
		this.log("warn", "job", `${job.key} fehlgeschlagen (Versuch ${attempts}): ${msg}`);
		this.db.run(
			`UPDATE jobs SET attempts = ?, run_after = ?, error = ?, updated_at = ? WHERE key = ?`,
			attempts,
			this.now() + delay,
			msg,
			this.now(),
			job.key,
		);
	}

	private backoffUntil(): number {
		return this.kvGet<{ until: number }>("backoff")?.until ?? 0;
	}

	private setBackoff(ms: number, kind: string): void {
		const until = this.now() + Math.max(1000, ms);
		this.kvSet("backoff", { until, kind });
		if (kind === "quota")
			this.log(
				"warn",
				"quota",
				"Spotify-Kontingent aufgebraucht — True Shuffle pausiert eine Stunde",
			);
	}

	private async step(
		job: JobRow,
		client: SpotifyClient,
		budget: RequestBudget,
	): Promise<StepResult> {
		const state = JSON.parse(job.state) as Record<string, unknown>;
		switch (job.kind) {
			case "playlists":
				return this.stepPlaylists(client, state as { offset?: number; seen?: string[] }, budget);
			case "import":
				return this.stepImport(client, state as unknown as ImportState, budget);
			case "deck":
				return this.stepDeck(client, budget, Number(state.stationId));
			case "extend":
				return this.stepExtend(client, Number(state.stationId));
			case "keep":
				return this.stepKeep(client, String(state.trackId));
			case "unfollow":
				await client.unfollowPlaylist(String(state.playlistId)).catch((e) => {
					if (!(e instanceof SpotifyError && e.kind === "not_found")) throw e;
				});
				return { done: true };
			case "rename": {
				const st = this.stationRow(Number(state.stationId));
				if (st?.playlist_id) {
					await client.updatePlaylistDetails(
						st.playlist_id,
						DECK_NAME_PREFIX + st.name,
						DECK_DESCRIPTION(st.name),
					);
				}
				return { done: true };
			}
			case "discover":
				return this.stepDiscover(
					client,
					budget,
					Number(state.stationId),
					state as unknown as DiscoveryState,
				);
			default:
				return { done: true };
		}
	}

	// =======================================================================
	// Library import
	// =======================================================================

	private async stepPlaylists(
		client: SpotifyClient,
		state: { offset?: number; seen?: string[] },
		budget: RequestBudget,
	): Promise<StepResult> {
		let offset = state.offset ?? 0;
		// Which playlists the walk has seen, across however many invocations it
		// takes: only what the complete list no longer contains may be forgotten.
		const seen = new Set(state.seen ?? []);
		const ours = new Set(
			this.stations()
				.map((s) => s.playlist_id)
				.filter(Boolean) as string[],
		);
		const discoveriesId = this.kvGet<string>("discoveries_playlist");
		if (discoveriesId) ours.add(discoveriesId);
		const profile = this.kvGet<{ id: string }>("profile");
		type Row = {
			id: string;
			name: string;
			owner_id: string | null;
			owner_name: string | null;
			image_url: string | null;
			total: number | null;
			snapshot_id: string | null;
			readable: number;
			ours: number;
			sort: number;
		};
		while (budget.left > 4) {
			const page = await client.myPlaylists(offset);
			if (!page) break;
			const ids = page.items.map((p) => p?.id).filter(Boolean) as string[];
			const known = new Map<string, Row>();
			if (ids.length > 0) {
				for (const r of this.db.all<Row>(
					`SELECT id, name, owner_id, owner_name, image_url, total, snapshot_id, readable, ours, sort
					 FROM playlists WHERE id IN (${ids.map(() => "?").join(",")})`,
					...ids,
				))
					known.set(r.id, r);
			}
			page.items.forEach((p, i) => {
				if (!p?.id) return;
				seen.add(p.id);
				const isOurs =
					ours.has(p.id) || (p.owner?.id === profile?.id && p.name.startsWith(DECK_NAME_PREFIX));
				const readable = p.owner?.id === profile?.id || p.collaborative === true;
				const next: Row = {
					id: p.id,
					name: p.name,
					owner_id: p.owner?.id ?? null,
					owner_name: p.owner?.display_name ?? null,
					image_url: pickImage(p.images),
					total: p.items?.total ?? null,
					snapshot_id: p.snapshot_id ?? null,
					readable: readable ? 1 : 0,
					ours: isOurs ? 1 : 0,
					sort: offset + i,
				};
				const cur = known.get(p.id);
				// Every written row counts against the day's budget: unchanged ones stay.
				if (cur && (Object.keys(next) as (keyof Row)[]).every((k) => cur[k] === next[k])) return;
				this.db.run(
					`INSERT INTO playlists (id, name, owner_id, owner_name, image_url, total, snapshot_id, readable, ours, sort, seen_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET name = excluded.name, owner_id = excluded.owner_id,
					   owner_name = excluded.owner_name, image_url = excluded.image_url, total = excluded.total,
					   snapshot_id = excluded.snapshot_id, readable = excluded.readable, ours = excluded.ours,
					   sort = excluded.sort, seen_at = excluded.seen_at`,
					next.id,
					next.name,
					next.owner_id,
					next.owner_name,
					next.image_url,
					next.total,
					next.snapshot_id,
					next.readable,
					next.ours,
					next.sort,
					this.now(),
				);
			});
			if (!page.next) {
				// Playlists the listener no longer follows disappear from the list —
				// except a station's sources: those stay, marked gone, so the station
				// can say what happened and play on with what is left.
				// A source counts as gone only after two complete walks without it:
				// one short list from Spotify must not take a station's music away.
				const used = this.usedSources();
				const missed = this.kvGet<Record<string, number>>("sources_missed") ?? {};
				const stillMissed: Record<string, number> = {};
				for (const r of this.db.all<{ id: string; gone_at: number | null }>(
					`SELECT id, gone_at FROM playlists`,
				)) {
					if (seen.has(r.id)) {
						if (r.gone_at !== null)
							this.db.run(`UPDATE playlists SET gone_at = NULL WHERE id = ?`, r.id);
						continue;
					}
					if (used.has(`pl:${r.id}`)) {
						const n = (missed[r.id] ?? 0) + 1;
						stillMissed[r.id] = n;
						if (n >= 2 && r.gone_at === null)
							this.db.run(`UPDATE playlists SET gone_at = ? WHERE id = ?`, this.now(), r.id);
					} else {
						this.db.run(`DELETE FROM playlists WHERE id = ?`, r.id);
					}
				}
				this.kvSet("sources_missed", stillMissed);
				// Stations whose sources changed this way must be rewritten (when idle).
				const goneNow = new Set(
					this.db
						.all<{ id: string }>(`SELECT id FROM playlists WHERE gone_at IS NOT NULL`)
						.map((r) => r.id),
				);
				const goneBefore = new Set(
					(this.kvGet<{ id: string }[]>("sources_gone") ?? []).map((r) => r.id),
				);
				const changed = [...goneNow, ...goneBefore].filter(
					(id) => goneNow.has(id) !== goneBefore.has(id),
				);
				if (changed.length > 0) {
					for (const st of this.stations()) {
						const hit =
							st.kind === "all" ||
							this.sourcesOf(st).some((x) => x.type === "playlist" && changed.includes(x.id));
						if (hit) this.db.run(`UPDATE stations SET deck_dirty = 1 WHERE id = ?`, st.id);
					}
					this.poolVersion++;
				}
				// Read by every look at the app: kept ready instead of scanning the list.
				this.kvSet(
					"sources_gone",
					this.db.all<{ id: string; name: string }>(
						`SELECT id, name FROM playlists WHERE gone_at IS NOT NULL`,
					),
				);
				const s = this.syncState();
				s.lastPlaylistsAt = this.now();
				this.setSyncState(s);
				this.queueChangedSources();
				return { done: true };
			}
			offset += page.items.length || 50;
		}
		return { done: false, state: { offset, seen: [...seen] } };
	}

	/** Re-import any source playlist whose snapshot changed since its import. */
	private queueChangedSources(): void {
		const used = this.usedSources();
		for (const key of used) {
			if (key === "liked") continue;
			const id = key.slice(3);
			const row = this.db.first<{
				snapshot_id: string;
				imported_snapshot: string | null;
				readable: number;
			}>(`SELECT snapshot_id, imported_snapshot, readable FROM playlists WHERE id = ?`, id);
			if (row?.readable && row.snapshot_id !== row.imported_snapshot) {
				this.enqueue(`import:${key}`, "import", { source: key, offset: 0 }, 2);
			}
		}
	}

	private usedSources(): Set<string> {
		const out = new Set<string>();
		for (const st of this.stations()) {
			for (const s of this.sourcesOf(st)) out.add(sourceKey(s));
		}
		return out;
	}

	private async stepImport(
		client: SpotifyClient,
		state: ImportState,
		budget: RequestBudget,
	): Promise<StepResult> {
		const source = state.source;
		let offset = state.offset ?? 0;
		let skipped = state.skipped ?? 0;
		let count = state.count ?? 0;
		let snapshot = state.snapshot ?? null;
		if (offset === 0 && source.startsWith("pl:")) {
			const row = this.db.first<{ snapshot_id: string }>(
				`SELECT snapshot_id FROM playlists WHERE id = ?`,
				source.slice(3),
			);
			snapshot = row?.snapshot_id ?? null;
		}
		while (budget.left > 4) {
			let items: (SpTrack | null)[] = [];
			let next: string | null = null;
			let total = 0;
			if (source === "liked") {
				const page = await client.likedTracks(offset);
				items = (page?.items ?? []).map((i) => i.track);
				next = page?.next ?? null;
				total = page?.total ?? 0;
			} else {
				let page: Awaited<ReturnType<SpotifyClient["playlistItems"]>>;
				try {
					page = await client.playlistItems(source.slice(3), offset);
				} catch (err) {
					if (
						err instanceof SpotifyError &&
						(err.kind === "forbidden" || err.kind === "not_found")
					) {
						this.db.run(`UPDATE playlists SET readable = 0 WHERE id = ?`, source.slice(3));
						this.log(
							"warn",
							"import",
							`Playlist ${source.slice(3)} ist nicht lesbar (${err.kind})`,
						);
						this.finishImport(source, snapshot, count, skipped, 0);
						return { done: true };
					}
					throw err;
				}
				items = (page?.items ?? []).map((i) => (i.is_local ? null : i.item));
				next = page?.next ?? null;
				total = page?.total ?? 0;
			}
			const packed: PackedTrack[] = [];
			for (const t of items) {
				const p = t ? packTrack(t) : null;
				if (p) packed.push(p);
				else skipped++;
			}
			count += packed.length;
			const pageNo = Math.floor(offset / PAGE_SIZE);
			this.db.run(
				`INSERT INTO pages (source, page, data) VALUES (?, ?, ?)
				 ON CONFLICT(source, page) DO UPDATE SET data = excluded.data`,
				source,
				pageNo,
				JSON.stringify(packed),
			);
			offset += items.length || PAGE_SIZE;
			if (!next || items.length === 0) {
				this.finishImport(source, snapshot, count, skipped, pageNo + 1);
				return { done: true };
			}
			state.total = total;
		}
		return { done: false, state: { source, offset, skipped, count, snapshot, total: state.total } };
	}

	private finishImport(
		source: string,
		snapshot: string | null,
		count: number,
		skipped: number,
		pages: number,
	): void {
		this.db.run(`DELETE FROM pages WHERE source = ? AND page >= ?`, source, pages);
		if (source === "liked") {
			this.kvSet("liked_import", { at: this.now(), count });
			const s = this.syncState();
			s.lastLikedAt = this.now();
			this.setSyncState(s);
			this.likedCache = null;
		} else {
			this.db.run(
				`UPDATE playlists SET imported_snapshot = ?, imported_count = ?, skipped_count = ?, imported_at = ? WHERE id = ?`,
				snapshot,
				count,
				skipped,
				this.now(),
				source.slice(3),
			);
		}
		this.sourceCache.delete(source);
		this.indexCache = null;
		this.poolVersion++;
		// Stations fed by this source get a new deck as soon as nobody listens.
		for (const st of this.stations()) {
			if (this.sourcesOf(st).some((s) => sourceKey(s) === source)) {
				this.db.run(`UPDATE stations SET deck_dirty = 1 WHERE id = ?`, st.id);
			}
		}
		this.log(
			"info",
			"import",
			`${sourceLabel(source, this)}: ${count} Songs übernommen, ${skipped} übersprungen`,
		);
	}

	private loadSource(key: string): PackedTrack[] {
		const cached = this.sourceCache.get(key);
		if (cached) return cached;
		const rows = this.db.all<{ data: string }>(
			`SELECT data FROM pages WHERE source = ? ORDER BY page`,
			key,
		);
		const out: PackedTrack[] = [];
		for (const r of rows) for (const t of JSON.parse(r.data) as PackedTrack[]) out.push(t);
		this.sourceCache.set(key, out);
		return out;
	}

	/** A source playlist that is no longer in the listener's Spotify. */
	private sourceGone(key: string): boolean {
		if (key === "liked") return false;
		const row = this.db.first<{ gone_at: number | null }>(
			`SELECT gone_at FROM playlists WHERE id = ?`,
			key.slice(3),
		);
		return !row || row.gone_at !== null;
	}

	/** The sources a station can still draw from. */
	private liveSources(st: StationRow): StationSource[] {
		return this.sourcesOf(st).filter((s) => !this.sourceGone(sourceKey(s)));
	}

	private sourceImported(key: string): boolean {
		if (this.jobExists(`import:${key}`)) return false;
		if (key === "liked") return this.kvGet("liked_import") !== null;
		const row = this.db.first<{ imported_at: number | null }>(
			`SELECT imported_at FROM playlists WHERE id = ?`,
			key.slice(3),
		);
		return row?.imported_at != null;
	}

	private trackIndex(): Map<TrackId, PackedTrack> {
		if (this.indexCache) return this.indexCache;
		const idx = new Map<TrackId, PackedTrack>();
		// The sources in use, not a scan of every stored page.
		const sources = this.usedSources();
		if (this.kvGet("onboarded")) sources.add("liked");
		for (const key of sources) for (const t of this.loadSource(key)) idx.set(t[0], t);
		this.indexCache = idx;
		return idx;
	}

	/**
	 * Tracks by id without building the whole index: the given sources (read
	 * once per source and kept), then discoveries by id.
	 */
	private lookupTracks(
		ids: readonly TrackId[],
		sources: Iterable<string>,
	): Map<TrackId, PackedTrack> {
		const want = new Set(ids);
		const out = new Map<TrackId, PackedTrack>();
		if (this.indexCache) {
			for (const id of want) {
				const t = this.indexCache.get(id);
				if (t) out.set(id, t);
			}
		} else {
			for (const key of sources) {
				for (const t of this.loadSource(key)) if (want.has(t[0])) out.set(t[0], t);
				if (out.size === want.size) break;
			}
		}
		const missing = [...want].filter((id) => !out.has(id));
		for (let i = 0; i < missing.length; i += 100) {
			const chunk = missing.slice(i, i + 100);
			for (const d of this.db.all<{ id: string; meta: string }>(
				`SELECT id, meta FROM discoveries WHERE id IN (${chunk.map(() => "?").join(",")})`,
				...chunk,
			))
				out.set(d.id, JSON.parse(d.meta) as PackedTrack);
		}
		return out;
	}

	private isDiscovery(id: TrackId): boolean {
		return this.db.first(`SELECT 1 FROM discoveries WHERE id = ? LIMIT 1`, id) !== null;
	}

	// =======================================================================
	// Memory
	// =======================================================================

	private liveLookups = new Map<TrackId, MemoryRow | null>();

	/**
	 * Read the memory of just these songs (a station's pool), a hundred per
	 * query. A Durable Object forgets its caches minutes after going idle, so
	 * every rebuild reads again: reading only the pool instead of the whole
	 * memory table keeps a many-station account inside the daily row budget.
	 */
	private preloadMemory(ids: Iterable<TrackId>): void {
		const missing: TrackId[] = [];
		for (const id of ids) if (!this.liveLookups.has(id)) missing.push(id);
		for (let i = 0; i < missing.length; i += 100) {
			const chunk = missing.slice(i, i + 100);
			for (const id of chunk) this.liveLookups.set(id, null);
			const rows = this.db.all<MemoryRow>(
				`SELECT * FROM memory WHERE id IN (${chunk.map(() => "?").join(",")})`,
				...chunk,
			);
			for (const r of rows) this.liveLookups.set(r.id, r);
		}
	}

	private liveRow(id: TrackId): MemoryRow | null {
		if (this.liveLookups.has(id)) return this.liveLookups.get(id) ?? null;
		const r = this.db.first<MemoryRow>(`SELECT * FROM memory WHERE id = ?`, id);
		this.liveLookups.set(id, r);
		return r;
	}

	private hasLive(id: TrackId): boolean {
		return this.liveRow(id) !== null;
	}

	/** Change the live part of a song's memory (imported history stays separate). */
	private updateLive(id: TrackId, fn: (r: MemoryRow) => MemoryRow): void {
		const cur: MemoryRow = this.liveRow(id) ?? {
			id,
			last_played_at: null,
			plays: 0,
			early_skips: 0,
			last_skipped_at: null,
			consumed_at: null,
			thumb: 0,
		};
		const next = fn({ ...cur });
		this.db.run(
			`INSERT INTO memory (id, last_played_at, plays, early_skips, last_skipped_at, consumed_at, thumb) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET last_played_at = excluded.last_played_at, plays = excluded.plays,
			   early_skips = excluded.early_skips, last_skipped_at = excluded.last_skipped_at,
			   consumed_at = excluded.consumed_at, thumb = excluded.thumb`,
			id,
			next.last_played_at,
			next.plays,
			next.early_skips,
			next.last_skipped_at,
			next.consumed_at ?? null,
			next.thumb,
		);
		this.liveLookups.set(id, next);
	}

	private livePlay(id: TrackId, at: number): void {
		this.updateLive(id, (r) => ({
			...r,
			plays: r.plays + 1,
			last_played_at: Math.max(r.last_played_at ?? 0, at),
		}));
	}

	private liveSkip(id: TrackId, at: number): void {
		this.updateLive(id, (r) => ({
			...r,
			early_skips: r.early_skips + 1,
			last_skipped_at: Math.max(r.last_skipped_at ?? 0, at),
		}));
	}

	private hist(): Map<TrackId, ImportedStats> {
		if (!this.histCache) {
			this.histCache = new Map();
			for (const r of this.db.all<{ data: string }>(`SELECT data FROM hist_pages ORDER BY page`)) {
				for (const row of JSON.parse(r.data) as HistoryRow[]) {
					const [id, s] = fromRow(row);
					this.histCache.set(id, s);
				}
			}
		}
		return this.histCache;
	}

	private liked(): Set<TrackId> {
		if (!this.likedCache) this.likedCache = new Set(this.loadSource("liked").map((t) => t[0]));
		return this.likedCache;
	}

	/** Effective memory of a song: live + imported history + Spotify heart. */
	memory(id: TrackId): TrackMemory {
		const r = this.liveRow(id);
		const live: TrackMemory = r
			? {
					id,
					lastPlayedAt: r.last_played_at,
					plays: r.plays,
					earlySkips: r.early_skips,
					lastSkippedAt: r.last_skipped_at,
					consumedAt: r.consumed_at ?? null,
					liked: false,
					thumb: (r.thumb as -1 | 0 | 1) ?? 0,
				}
			: emptyMemory(id);
		const merged = mergeMemory(live, this.hist().get(id));
		merged.liked = this.liked().has(id);
		return merged;
	}

	// =======================================================================
	// Stations
	// =======================================================================

	private stations(): StationRow[] {
		if (!this.cache.stations)
			this.cache.stations = this.db.all<StationRow>(`SELECT * FROM stations ORDER BY sort, id`);
		return this.cache.stations.map((r) => ({ ...r }));
	}

	private stationRow(id: number): StationRow | null {
		const r = this.stations().find((x) => x.id === id);
		return r ?? null;
	}

	private sourcesOf(st: StationRow): StationSource[] {
		if (st.kind === "all") {
			const out = new Map<string, StationSource>();
			for (const other of this.stations()) {
				if (other.kind === "all") continue;
				for (const s of JSON.parse(other.sources) as StationSource[]) out.set(sourceKey(s), s);
			}
			out.set("liked", { type: "liked" });
			return [...out.values()];
		}
		return JSON.parse(st.sources) as StationSource[];
	}

	private rulesOf(st: StationRow): StationRules {
		return normaliseRules(JSON.parse(st.rules) as Partial<StationRules>);
	}

	private deckOf(st: StationRow): Deck | null {
		return st.deck ? (JSON.parse(st.deck) as Deck) : null;
	}

	private saveDeck(stationId: number, deck: Deck): void {
		this.db.run(`UPDATE stations SET deck = ? WHERE id = ?`, JSON.stringify(deck), stationId);
	}

	private deckUri(st: StationRow): string | null {
		return st.playlist_id ? `spotify:playlist:${st.playlist_id}` : null;
	}

	private stationPool(st: StationRow): PoolEntry[] {
		const out: PoolEntry[] = [];
		const seen = new Set<TrackId>();
		for (const s of this.liveSources(st)) {
			for (const t of this.loadSource(sourceKey(s))) {
				if (seen.has(t[0])) continue;
				seen.add(t[0]);
				out.push(toPoolEntry(t));
			}
		}
		// Kept discoveries belong to the station they were found for.
		for (const d of this.db.all<{ id: string; meta: string }>(
			`SELECT id, meta FROM discoveries WHERE station_id = ? AND status = 'kept'`,
			st.id,
		)) {
			if (seen.has(d.id)) continue;
			seen.add(d.id);
			out.push(toPoolEntry(JSON.parse(d.meta) as PackedTrack));
		}
		return out;
	}

	private stationReady(st: StationRow): boolean {
		const sources = this.liveSources(st);
		if (sources.length === 0) return false;
		return sources.every((s) => this.sourceImported(sourceKey(s)));
	}

	/** Every source of this station was deleted in Spotify: nothing will come. */
	private stationOrphaned(st: StationRow): boolean {
		return this.sourcesOf(st).length > 0 && this.liveSources(st).length === 0;
	}

	private bans(stationId: number): Set<TrackId> {
		return new Set(
			this.db
				.all<{ track_id: string }>(`SELECT track_id FROM bans WHERE station_id = ?`, stationId)
				.map((r) => r.track_id),
		);
	}

	private discoveryEntries(st: StationRow): DiscoveryEntry[] {
		const cutoff = this.now() - DISCOVERY_SECOND_CHANCE_MS;
		return this.db
			.all<{ id: string; score: number; meta: string; status: string; updated_at: number }>(
				`SELECT id, score, meta, status, updated_at FROM discoveries
				 WHERE station_id = ? AND (status = 'candidate' OR (status = 'probation' AND updated_at <= ?))`,
				st.id,
				cutoff,
			)
			.filter((d) => this.memory(d.id).thumb !== -1)
			.map((d) => ({ ...toPoolEntry(JSON.parse(d.meta) as PackedTrack), score: d.score }));
	}

	createStation(input: {
		name: string;
		kind?: StationKind;
		sources: StationSource[];
		rules?: Partial<StationRules>;
	}): number {
		const name = input.name.trim().slice(0, 80) || "Sender";
		const kind = input.kind ?? "custom";
		if (kind !== "all" && this.stations().filter((st) => st.kind !== "all").length >= MAX_STATIONS)
			throw new HubError(
				"too_many",
				`Mehr als ${MAX_STATIONS} Sender gehen nicht — sonst reicht das kostenlose Tageskontingent nicht. Lösche einen, den du nicht mehr hörst.`,
			);
		const sort =
			(this.db.first<{ m: number | null }>(`SELECT MAX(sort) AS m FROM stations`)?.m ?? 0) + 1;
		this.db.run(
			`INSERT INTO stations (name, kind, sources, rules, sort, round_no, round_started_at, deck_dirty, created_at)
			 VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?)`,
			name,
			kind,
			JSON.stringify(kind === "all" ? [] : input.sources),
			JSON.stringify(normaliseRules({ ...DEFAULT_RULES, ...(input.rules ?? {}) })),
			kind === "all" ? 0 : sort,
			// A new station's first round counts everything heard in the last year
			// as heard — "Alles" must not start by replaying yesterday's songs.
			this.now() - 365 * DAY_MS,
			this.now(),
		);
		const id = this.db.first<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id;
		for (const s of this.sourcesOf(this.stationRow(id)!)) {
			const key = sourceKey(s);
			if (!this.sourceImported(key))
				this.enqueue(`import:${key}`, "import", { source: key, offset: 0 }, 2);
		}
		this.enqueue(`deck:${id}`, "deck", { stationId: id }, 3);
		this.enqueue(`discover:${id}`, "discover", { stationId: id }, 7, 2 * MINUTE_MS);
		return id;
	}

	async onboard(playlistIds: string[]): Promise<void> {
		const existing = new Set(
			this.stations()
				.filter((s) => s.kind === "playlist")
				.flatMap((s) =>
					(JSON.parse(s.sources) as StationSource[]).map((x) =>
						x.type === "playlist" ? x.id : "",
					),
				),
		);
		const adding = new Set(playlistIds.filter((id) => !existing.has(id))).size;
		const have = this.stations().filter((st) => st.kind !== "all").length;
		if (have + adding > MAX_STATIONS)
			throw new HubError(
				"too_many",
				`Höchstens ${MAX_STATIONS} Sender — wähle ${have + adding - MAX_STATIONS} Playlist(s) weniger.`,
			);
		for (const id of playlistIds) {
			if (existing.has(id)) continue;
			const row = this.db.first<{ name: string; readable: number }>(
				`SELECT name, readable FROM playlists WHERE id = ?`,
				id,
			);
			if (!row) continue;
			if (!row.readable)
				throw new HubError(
					"not_readable",
					`„${row.name}“ gehört dir nicht — Spotify gibt ihre Songs nicht heraus.`,
				);
			this.createStation({ name: row.name, kind: "playlist", sources: [{ type: "playlist", id }] });
		}
		if (!this.stations().some((s) => s.kind === "all")) {
			this.createStation({ name: "Alles", kind: "all", sources: [] });
		}
		this.enqueue("import:liked", "import", { source: "liked", offset: 0 }, 2);
		this.kvSet("onboarded", true);
		await this.scheduleSoon(500);
	}

	updateStation(
		id: number,
		patch: { name?: string; rules?: Partial<StationRules>; sources?: StationSource[] },
	): void {
		const st = this.stationRow(id);
		if (!st) throw new HubError("not_found", "Diesen Sender gibt es nicht.", 404);
		const newName = patch.name?.trim();
		if (newName && newName !== st.name) {
			this.db.run(`UPDATE stations SET name = ? WHERE id = ?`, newName.slice(0, 80), id);
			if (st.playlist_id) this.enqueue(`rename:${id}`, "rename", { stationId: id }, 6);
		}
		if (patch.rules) {
			const rules = normaliseRules({ ...this.rulesOf(st), ...patch.rules });
			this.db.run(
				`UPDATE stations SET rules = ?, deck_dirty = 1 WHERE id = ?`,
				JSON.stringify(rules),
				id,
			);
			this.enqueue(`deck:${id}`, "deck", { stationId: id }, 3);
		}
		if (patch.sources && st.kind !== "all") {
			if (patch.sources.length === 0)
				throw new HubError("no_sources", "Ein Sender braucht mindestens eine Quelle.");
			this.db.run(
				`UPDATE stations SET sources = ?, deck_dirty = 1 WHERE id = ?`,
				JSON.stringify(patch.sources),
				id,
			);
			this.poolVersion++;
			for (const s of patch.sources) {
				const key = sourceKey(s);
				if (!this.sourceImported(key))
					this.enqueue(`import:${key}`, "import", { source: key, offset: 0 }, 2);
			}
			this.enqueue(`deck:${id}`, "deck", { stationId: id }, 3);
		}
	}

	async deleteStation(id: number): Promise<void> {
		const st = this.stationRow(id);
		if (!st) return;
		this.db.run(`DELETE FROM stations WHERE id = ?`, id);
		this.db.run(`DELETE FROM bans WHERE station_id = ?`, id);
		this.db.run(`DELETE FROM discoveries WHERE station_id = ? AND status != 'kept'`, id);
		for (const k of [`deck:${id}`, `extend:${id}`, `discover:${id}`, `rename:${id}`]) {
			this.db.run(`DELETE FROM jobs WHERE key = ?`, k);
		}
		if (st.playlist_id)
			this.enqueue(`unfollow:${st.playlist_id}`, "unfollow", { playlistId: st.playlist_id }, 8);
		await this.scheduleSoon(1000);
	}

	// =======================================================================
	// Deck (the station's Spotify playlist)
	// =======================================================================

	private async ensurePlaylist(client: SpotifyClient, st: StationRow): Promise<string> {
		if (st.playlist_id) return st.playlist_id;
		const pl = await client.createPlaylist(DECK_NAME_PREFIX + st.name, DECK_DESCRIPTION(st.name));
		if (!pl?.id) throw new HubError("spotify", "Spotify hat keine Playlist angelegt");
		this.db.run(`UPDATE stations SET playlist_id = ? WHERE id = ?`, pl.id, st.id);
		this.db.run(
			`INSERT INTO playlists (id, name, owner_id, readable, ours, seen_at, snapshot_id) VALUES (?, ?, ?, 1, 1, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET ours = 1`,
			pl.id,
			pl.name,
			this.kvGet<{ id: string }>("profile")?.id ?? null,
			this.now(),
			pl.snapshot_id ?? "",
		);
		st.playlist_id = pl.id;
		return pl.id;
	}

	/**
	 * Plan a deck from memory and write it into the station's playlist.
	 *
	 * `start`: True Shuffle starts it at the top, so it plans afresh.
	 * `background`: nobody asked to start it. If a player may still hold the
	 * previous version (it was in use lately), the new one continues it — see
	 * `continueLayout`: whatever the player resumes, it meets nothing it just
	 * heard. `null`: the held version cannot be improved and stays as it is.
	 */
	private async rebuildDeck(client: SpotifyClient, st: StationRow, mode?: "start"): Promise<Deck>;
	private async rebuildDeck(
		client: SpotifyClient,
		st: StationRow,
		mode: "background",
	): Promise<Deck | null>;
	private async rebuildDeck(
		client: SpotifyClient,
		st: StationRow,
		mode: "start" | "background" = "start",
	): Promise<Deck | null> {
		if (this.stationOrphaned(st))
			throw new HubError(
				"gone",
				"Die Playlist dieses Senders gibt es in deinem Spotify nicht mehr. Wähle unter „Quellen“ eine andere.",
			);
		if (!this.stationReady(st))
			throw new HubError("not_ready", "Dieser Sender wird noch eingelesen.");
		const pool = this.stationPool(st);
		if (pool.length === 0)
			throw new HubError("empty", "Dieser Sender hat keine abspielbaren Songs.");
		let rules = this.rulesOf(st);
		const banned = this.bans(st.id);
		const discoveries = this.discoveryEntries(st);
		// Planning reads every candidate's memory: fetch them in one sweep.
		this.preloadMemory([...pool.map((e) => e.id), ...discoveries.map((d) => d.id)]);
		const prev = this.deckOf(st);
		// Continue, rather than replan, when a player may still hold this
		// playlist (paused in it, or gone quiet while in it) and resume it.
		const lastUse = this.kvGet<Record<string, number>>("deck_activity")?.[String(st.id)] ?? 0;
		const uri = this.deckUri(st);
		const snap = this.kvGet<PlayerSnapshot>("player");
		const heldByPlayer =
			!!uri &&
			(snap?.obs?.contextUri === uri || (!snap?.obs && this.kvGet<string>("last_context") === uri));
		const held = prev ? position(prev) : null;
		const continuing =
			mode === "background" &&
			!!prev &&
			held !== null &&
			heldByPlayer &&
			this.now() - lastUse < CONTINUE_WITHIN_MS;
		// The songs after the held position stay exactly where they are, so a
		// player resuming by position and one resuming its loaded order play the
		// same songs. The held song itself leaves this version.
		const suffix = continuing && prev && held !== null ? prev.items.slice(held + 1) : [];
		// New songs never come from what the held version holds for the player:
		// ahead of it, or reached (see `heldForPlayer`). Without a player, a skip
		// still waiting for its booking keeps the song out as well.
		const exclude =
			continuing && prev
				? heldForPlayer(prev)
				: new Set((prev?.items ?? []).filter((it) => it.state === "passed").map((it) => it.id));
		const playable = (id: TrackId) => {
			const m = this.memory(id);
			return !isBlocked(m, banned) && !coolingDown(m, this.now());
		};
		const gaps = suffix.filter((it) => !playable(it.id)).length;
		const plan = () =>
			planQueue({
				now: this.now(),
				roundStartedAt: st.round_started_at,
				rules,
				pool,
				memory: (id) => this.memory(id),
				banned,
				discoveries,
				size: continuing
					? Math.max((held ?? 0) + 1, DECK_SIZE - suffix.length) + gaps + CONTINUE_AHEAD
					: DECK_SIZE,
				rng: this.d.rng,
				exclude,
				// Written while a player may resume it: nothing skipped lately.
				allowCooling: !continuing,
			});
		let result = plan();
		if (result.freshRemaining === 0 && result.poolSize > 0) {
			// Every song of the station was heard: the next round starts now.
			st.round_no += 1;
			st.round_started_at = this.now();
			this.db.run(
				`UPDATE stations SET round_no = ?, round_started_at = ? WHERE id = ?`,
				st.round_no,
				st.round_started_at,
				st.id,
			);
			this.log(
				"info",
				"round",
				`„${st.name}“: Runde ${st.round_no} beginnt — alle Songs wurden gehört`,
			);
			result = plan();
		}
		rules = this.rulesOf(st);
		let layout: PlannedSlot[] | null;
		if (continuing && prev && held !== null) {
			layout = continueLayout({
				items: prev.items,
				held,
				fresh: result.slots,
				playable,
				blocked: (id) => isBlocked(this.memory(id), banned),
			});
			// Nothing better than what the player holds: leave it as it is.
			if (!layout) return null;
		} else {
			if (result.slots.length === 0) {
				throw new HubError(
					"empty",
					"Alle Songs dieses Senders liefen in den letzten 24 Stunden. Morgen geht es weiter.",
				);
			}
			layout = result.slots;
		}
		const uris = layout.map((s) => `spotify:track:${s.trackId}`);
		// Never half a playlist: the whole write must fit this invocation.
		if (client.requestsLeft < Math.ceil(uris.length / 100) + 2)
			throw new SpotifyError("budget", "Anfragebudget reicht nicht für die ganze Playlist");
		let playlistId = await this.ensurePlaylist(client, st);
		try {
			await client.replaceItems(playlistId, uris.slice(0, 100));
		} catch (err) {
			if (err instanceof SpotifyError && (err.kind === "not_found" || err.kind === "forbidden")) {
				// The listener deleted the playlist in Spotify — make a new one.
				this.db.run(`UPDATE stations SET playlist_id = NULL WHERE id = ?`, st.id);
				st.playlist_id = null;
				playlistId = await this.ensurePlaylist(client, st);
				await client.replaceItems(playlistId, uris.slice(0, 100));
			} else {
				throw err;
			}
		}
		for (let i = 100; i < uris.length; i += 100) {
			await client.addItems(playlistId, uris.slice(i, i + 100));
		}
		if (prev) this.carryPasses(st.id, prev);
		const deck = newDeck(layout, (prev?.version ?? 0) + 1, this.now());
		// Positions stay trustworthy only through a continuation of an order we
		// trusted. A fresh plan nobody started is not ours until True Shuffle
		// starts it: a player may still carry on with what it had loaded.
		deck.continued = continuing;
		deck.ours = continuing && prev?.ours === true;
		deck.heldAt = continuing && held !== null ? Math.min(held, layout.length - 1) : null;
		if (continuing && prev && held !== null)
			deck.changedAt = layout
				.map((s, i) =>
					i > held && i < prev.items.length && prev.items[i]!.id !== s.trackId ? i : -1,
				)
				.filter((i) => i >= 0)
				.slice(0, 50);
		this.db.run(
			`UPDATE stations SET deck = ?, deck_dirty = 0, fresh_remaining = ?, pool_size = ?, stats = ? WHERE id = ?`,
			JSON.stringify(deck),
			result.freshRemaining,
			result.poolSize,
			JSON.stringify({ counts: result.counts, overflow: result.overflow, at: this.now() }),
			st.id,
		);
		st.deck = JSON.stringify(deck);
		st.deck_dirty = 0;
		return deck;
	}

	private async stepDeck(
		client: SpotifyClient,
		budget: RequestBudget,
		stationId: number,
	): Promise<StepResult> {
		const st = this.stationRow(stationId);
		if (!st) return { done: true };
		if (!this.stationReady(st)) {
			// Waiting is only worth it while something is being read in; otherwise
			// the next import or source change queues the deck again.
			const importing = this.liveSources(st).some((s) => this.jobExists(`import:${sourceKey(s)}`));
			return importing ? { done: false, state: { stationId }, delayMs: 30_000 } : { done: true };
		}
		// Never rewrite a playlist on an old picture of the player: someone may be
		// listening to it right now. Look first; if Spotify cannot say, wait.
		if (st.deck && !this.playerFresh()) {
			await this.sync(budget);
			if (!this.playerFresh())
				return { done: false, state: { stationId }, delayMs: IDLE_BEFORE_REBUILD_MS };
		}
		if (this.isListeningTo(st)) {
			// Look again the moment the pause is long enough, not a step later.
			const active = this.kvGet<Record<string, number>>("deck_activity")?.[String(st.id)] ?? 0;
			const wait = Math.max(MINUTE_MS, active + IDLE_BEFORE_REBUILD_MS - this.now());
			return { done: false, state: { stationId }, delayMs: wait };
		}
		try {
			await this.freshenMemory(client);
			const deck = await this.rebuildDeck(client, this.stationRow(stationId) ?? st, "background");
			// A player holds a version nothing better can replace yet: songs cool
			// down by the hour, so look again then.
			if (!deck) return { done: false, state: { stationId }, delayMs: HOUR_MS };
		} catch (err) {
			if (err instanceof HubError && err.code === "empty") {
				this.log("info", "deck", err.message);
				return { done: false, state: { stationId }, delayMs: 6 * HOUR_MS };
			}
			throw err;
		}
		return { done: true };
	}

	/** Append more songs to a deck that is running out while it plays. */
	private async stepExtend(client: SpotifyClient, stationId: number): Promise<StepResult> {
		const st = this.stationRow(stationId);
		const deck = st ? this.deckOf(st) : null;
		if (!st || !deck || !st.playlist_id) return { done: true };
		if (remainingAhead(deck) >= EXTEND_BELOW) return { done: true };
		// Never a song twice in one playlist: positions must stay unambiguous.
		const inDeck = new Set(deck.items.map((i) => i.id));
		const banned = new Set([...this.bans(st.id), ...inDeck]);
		const pool = this.stationPool(st);
		const discoveries = this.discoveryEntries(st);
		this.preloadMemory([...pool.map((e) => e.id), ...discoveries.map((d) => d.id)]);
		const res = planQueue({
			now: this.now(),
			roundStartedAt: st.round_started_at,
			rules: this.rulesOf(st),
			pool,
			memory: (id) => this.memory(id),
			banned,
			discoveries,
			size: 100,
			rng: this.d.rng,
		});
		if (res.slots.length === 0) return { done: true };
		await client.addItems(
			st.playlist_id,
			res.slots.map((s) => `spotify:track:${s.trackId}`),
		);
		deck.items.push(
			...res.slots.map((s) => ({
				id: s.trackId,
				kind: s.kind,
				state: "pending" as const,
				at: null,
			})),
		);
		this.saveDeck(st.id, deck);
		return { done: true };
	}

	private playerFresh(): boolean {
		const snap = this.kvGet<PlayerSnapshot>("player");
		return !!snap && this.now() - snap.at <= PLAYER_FRESH_MS;
	}

	/** Is the listener in this station's playlist right now (or was, moments ago)? */
	private isListeningTo(st: StationRow): boolean {
		const snap = this.kvGet<PlayerSnapshot>("player");
		const uri = this.deckUri(st);
		if (!uri || !snap) return false;
		const activity = this.kvGet<Record<string, number>>("deck_activity")?.[String(st.id)] ?? 0;
		// Spotify briefly shows no player at all (a phone switching networks):
		// that is not "nobody listens" — the last thing playing was this.
		if (!snap.obs)
			return (
				this.kvGet<string>("last_context") === uri && this.now() - activity < IDLE_BEFORE_REBUILD_MS
			);
		if (snap.obs.contextUri !== uri) return false;
		if (snap.obs.isPlaying) return true;
		return this.now() - activity < IDLE_BEFORE_REBUILD_MS;
	}

	// =======================================================================
	// Sync — read Spotify, update memory and decks
	// =======================================================================

	async sync(budget: RequestBudget, opts: { force?: boolean } = {}): Promise<void> {
		if (!this.isConnected()) return;
		if (this.backoffUntil() > this.now()) return;
		const client = this.client(budget);
		const s = this.syncState();
		let state: SpPlaybackState | null;
		try {
			state = await client.player();
		} catch (err) {
			this.handleSyncError(err);
			return;
		}
		const obs = toObservation(state, this.now());
		s.lastPlayerAt = this.now();
		const snap: PlayerSnapshot = {
			obs,
			track: state?.item ? packTrack(state.item) : null,
			device: state?.device
				? { id: state.device.id, name: state.device.name, restricted: state.device.is_restricted }
				: null,
			at: this.now(),
		};
		// The same picture as a few minutes ago (a paused player): not stored again.
		const before = this.kvGet<PlayerSnapshot>("player");
		const same =
			before &&
			this.now() - before.at < 3 * MINUTE_MS &&
			JSON.stringify({ ...before, at: 0, obs: before.obs ? { ...before.obs, at: 0 } : null }) ===
				JSON.stringify({ ...snap, at: 0, obs: snap.obs ? { ...snap.obs, at: 0 } : null });
		if (!same) this.kvSet("player", snap);
		this.lastLookAt = this.now();
		if (this.kvGet("player_stale")) this.kvDel("player_stale");
		if (obs?.contextUri && obs.contextUri !== this.kvGet<string>("last_context"))
			this.kvSet("last_context", obs.contextUri);
		const wasPlaying = s.idleSince === null && s.lastActivityAt > 0;
		if (obs?.isPlaying) {
			s.lastActivityAt = this.now();
			s.idleSince = null;
		} else if (s.idleSince === null) {
			s.idleSince = this.now();
		}

		// Recently played: while something plays, right after it stopped, and
		// otherwise every 30 min. The moment playback stops matters most: the
		// last songs of a session must be in memory before any deck is rewritten.
		const justStopped = !obs?.isPlaying && wasPlaying;
		const recentDue =
			opts.force || obs?.isPlaying || justStopped || this.now() - s.lastRecentAt >= 30 * MINUTE_MS;
		let plays: RecentPlay[] = [];
		if (recentDue) {
			try {
				plays = await this.readRecent(client, s);
			} catch (err) {
				this.handleSyncError(err);
			}
		}

		this.settleCarried(plays);

		// Walk every deck: confirm plays, read the position, book early skips.
		const activityBefore = this.kvGet<Record<string, number>>("deck_activity") ?? {};
		const activity = { ...activityBefore };
		// A play inside a station's playlist is activity there too — also when
		// the player itself cannot be seen (a phone playing offline).
		for (const p of plays) {
			const st = p.contextUri
				? this.stations().find((x) => this.deckUri(x) === p.contextUri)
				: null;
			if (st && p.playedAt > (activity[String(st.id)] ?? 0)) activity[String(st.id)] = p.playedAt;
		}
		let inStation: InStation | null = null;
		for (const st of this.stations()) {
			let deck = this.deckOf(st);
			const uri = this.deckUri(st);
			if (!deck || !uri) continue;
			let changed = false;
			if (plays.length > 0) {
				const r = applyPlays(deck, plays, uri);
				if (r.played.length > 0 || r.unskipped.length > 0) changed = true;
				deck = r.deck;
				for (const id of r.unskipped) this.undoSkip(st.id, id);
			}
			if (obs && obs.contextUri === uri) {
				// Only actual playback counts as activity: a deck paused and left
				// alone must still be refreshed for the next start.
				if (obs.isPlaying) activity[String(st.id)] = this.now();
				const r = observePlayer(deck, obs, uri);
				// Stored only when more than the time of the look changed.
				if (!sameDeck(deck, r.deck)) changed = true;
				deck = r.deck;
				inStation = { st: st.id, uri, inDeck: r.index !== null, index: r.index };
				if (obs.isPlaying && this.now() - (st.last_played_at ?? 0) >= 5 * MINUTE_MS)
					this.db.run(`UPDATE stations SET last_played_at = ? WHERE id = ?`, this.now(), st.id);
				if (r.orderBroken && obs.shuffle && this.now() - s.shuffleFixAt > 10 * MINUTE_MS) {
					s.shuffleFixAt = this.now();
					try {
						await client.setShuffle(false);
						this.log(
							"info",
							"shuffle",
							"Spotify-Shuffle war an — für diesen Sender wieder ausgeschaltet",
						);
					} catch {
						/* Free account or restricted device: the warning below says it. */
					}
				}
				if (obs.isPlaying && remainingAhead(deck) < EXTEND_BELOW && deck.items.length > 0) {
					this.enqueue(`extend:${st.id}`, "extend", { stationId: st.id }, 1);
				}
			}
			const settled = settleSkips(deck, this.now());
			if (settled.skipped.length > 0) {
				changed = true;
				deck = settled.deck;
				const rules = this.rulesOf(st);
				for (const id of settled.skipped)
					this.bookEarlySkip(
						st,
						id,
						rules,
						deck.lastObservedAt ?? this.now(),
						settled.seen.has(id),
					);
			}
			if (changed) this.saveDeck(st.id, deck);
			// Rewrite a deck once nobody has listened to it for a while.
			const consumed = consumedCount(deck) > 0;
			const stale = this.now() - deck.writtenAt > DECK_MAX_AGE_MS;
			if ((consumed || st.deck_dirty || stale) && !this.jobExists(`deck:${st.id}`)) {
				const lastActive = activity[String(st.id)] ?? 0;
				const wait = Math.max(0, lastActive + IDLE_BEFORE_REBUILD_MS - this.now());
				this.enqueue(`deck:${st.id}`, "deck", { stationId: st.id }, 3, wait);
			}
		}
		this.watchCurrent(obs, inStation);
		await this.guardStation(client, obs, inStation);
		for (const st of this.stations()) {
			if (!st.deck && this.stationReady(st) && !this.jobExists(`deck:${st.id}`)) {
				this.enqueue(`deck:${st.id}`, "deck", { stationId: st.id }, 3);
			}
		}
		if (
			Object.entries(activity).some(
				([k, v]) => activityBefore[k] === undefined || v - activityBefore[k]! >= MINUTE_MS,
			)
		)
			this.kvSet("deck_activity", activity);

		// Housekeeping on a slow clock.
		if (this.now() - s.lastPlaylistsAt > 12 * HOUR_MS)
			this.enqueue("playlists", "playlists", {}, 4);
		if (this.kvGet("onboarded") && this.now() - s.lastLikedAt > 3 * DAY_MS) {
			this.enqueue("import:liked", "import", { source: "liked", offset: 0 }, 6);
		}
		this.prune();
		this.setSyncState(s);
	}

	/**
	 * Once a day, drop single plays older than half a year (memory keeps every
	 * song's totals) so the table — and every read of it — stays small. At most
	 * a few hundred per day: every deleted row counts against the day's writes.
	 */
	private prune(): void {
		const last = this.kvGet<number>("pruned_at") ?? 0;
		if (this.now() - last < DAY_MS) return;
		this.kvSet("pruned_at", this.now());
		this.db.run(
			`DELETE FROM plays WHERE (played_at, track_id) IN
			 (SELECT played_at, track_id FROM plays WHERE played_at < ? ORDER BY played_at LIMIT ?)`,
			this.now() - PLAYS_KEEP_MS,
			PRUNE_PER_DAY,
		);
	}

	private async readRecent(client: SpotifyClient, s: SyncState): Promise<RecentPlay[]> {
		const page = await client.recentlyPlayed();
		s.lastRecentAt = this.now();
		return this.recordPlays(page?.items ?? [], s);
	}

	/** Make memory current before planning: read recently-played unless just read. */
	private async freshenMemory(client: SpotifyClient): Promise<void> {
		const s = this.syncState();
		if (this.now() - s.lastRecentAt < 60_000) return;
		const plays = await this.readRecent(client, s);
		this.setSyncState(s);
		if (plays.length === 0) return;
		this.settleCarried(plays);
		for (const st of this.stations()) {
			const deck = this.deckOf(st);
			const uri = this.deckUri(st);
			if (!deck || !uri) continue;
			const r = applyPlays(deck, plays, uri);
			if (r.played.length > 0 || r.unskipped.length > 0) {
				for (const id of r.unskipped) this.undoSkip(st.id, id);
				this.saveDeck(st.id, r.deck);
			}
		}
	}

	/**
	 * A deck can be rewritten while some of its songs are still waiting for
	 * their play to show up (the skip grace). Those waits outlive the deck.
	 */
	private carryPasses(stationId: number, deck: Deck): void {
		const waiting = deck.items.filter((it) => it.state === "passed");
		if (waiting.length === 0) return;
		const list = this.kvGet<PendingSkip[]>("pending_skips") ?? [];
		for (const it of waiting)
			list.push({ id: it.id, st: stationId, at: it.at ?? this.now(), seen: it.seen === true });
		this.kvSet("pending_skips", list.slice(-500));
	}

	/**
	 * A song playing in a station's playlist that is not in the deck version we
	 * know (Spotify can carry on with an order it loaded before a rewrite) is
	 * watched on its own: when another song takes over in the same playlist, it
	 * was left — an early skip unless its play shows up within the grace.
	 */
	/**
	 * A song True Shuffle did not choose for this moment comes up in a station:
	 * turned down, or heard in the last 24 h and there only because a player
	 * holds an older version of the playlist or restarts a continued one from
	 * the top (its front keeps songs heard today when a small station has
	 * nothing else). Move on at once — and never count that as the listener's
	 * skip. A song turned down goes whenever it is seen; any other song only
	 * within its first 30 s (after that its play counts anyway). A song the
	 * listener picks inside the current version is left alone.
	 */
	private async guardStation(
		client: SpotifyClient,
		obs: PlayerObservation | null,
		at: InStation | null,
	): Promise<void> {
		if (!obs?.isPlaying || !obs.trackId || !at) return;
		const last = this.kvGet<{ id: TrackId; at: number }>("moved");
		if (last && last.id === obs.trackId && this.now() - last.at < MINUTE_MS) return;
		const st = this.stationRow(at.st);
		const deck = st ? this.deckOf(st) : null;
		if (!st || !deck) return;
		const m = this.memory(obs.trackId);
		if (m.thumb !== -1 && obs.progressMs >= 30_000) return;
		const heardToday = m.lastPlayedAt !== null && this.now() - m.lastPlayedAt < RECENT_GUARD_MS;
		let to: number | null = null;
		let why: string;
		if (m.thumb === -1) why = "abgelehnt";
		else if (heardToday && at.index === null)
			why = "heute schon gehört, aus einer alten Reihenfolge";
		else if (
			heardToday &&
			at.index !== null &&
			deck.continued === true &&
			deck.heldAt != null &&
			at.index < deck.heldAt
		) {
			const banned = this.bans(st.id);
			const from = at.index;
			to = deck.items.findIndex((it, i) => {
				if (i <= from || it.state !== "pending") return false;
				const mm = this.memory(it.id);
				return !isBlocked(mm, banned) && !coolingDown(mm, this.now());
			});
			if (to < 0) return;
			why = "heute schon gehört, von oben gestartet";
		} else return;
		this.kvSet("moved", { id: obs.trackId, at: this.now() });
		try {
			if (to === null) await client.next();
			else
				await client.play({
					contextUri: at.uri,
					position: to,
					deviceId: this.kvGet<PlayerSnapshot>("player")?.device?.id ?? undefined,
				});
		} catch {
			return; // a restricted device: nothing we can do from here
		}
		this.kvSet("player_stale", 1);
		this.log(
			"info",
			"guard",
			`„${st.name}“: ${this.describe(obs.trackId)} übersprungen (${why})${to === null ? "" : `, weiter bei Nr. ${to + 1}`}`,
		);
		// Our move, not the listener's: nothing is inferred from it.
		deck.lastTrackId = null;
		deck.lastPlaying = false;
		this.saveDeck(st.id, deck);
		if (this.kvGet<{ id: TrackId }>("watch")?.id === obs.trackId) this.kvDel("watch");
	}

	private watchCurrent(obs: PlayerObservation | null, inStation: InStation | null): void {
		const watch = this.kvGet<{ id: TrackId; st: number; uri: string; since: number }>("watch");
		const cur = obs?.trackId ?? null;
		if (watch && cur && cur !== watch.id && obs?.contextUri === watch.uri && obs.isPlaying) {
			const list = this.kvGet<PendingSkip[]>("pending_skips") ?? [];
			list.push({ id: watch.id, st: watch.st, at: this.now(), since: watch.since, seen: true });
			this.kvSet("pending_skips", list.slice(-500));
		}
		if (inStation && cur && !inStation.inDeck && obs?.isPlaying) {
			if (watch?.id !== cur)
				this.kvSet("watch", { id: cur, st: inStation.st, uri: inStation.uri, since: this.now() });
		} else if (watch && (cur !== watch.id || obs?.contextUri !== watch.uri || !obs?.isPlaying)) {
			// Moved on, or paused: a paused song Spotify later replaces was not skipped.
			this.kvDel("watch");
		}
	}

	private settleCarried(plays: RecentPlay[]): void {
		const list = this.kvGet<PendingSkip[]>("pending_skips");
		if (!list || list.length === 0) return;
		const played = new Set(plays.map((p) => p.trackId));
		const keep: typeof list = [];
		for (const e of list) {
			if (played.has(e.id)) continue; // it was a play after all
			// …or its play was read in an earlier round than this one.
			const heard = this.db.first(
				`SELECT 1 FROM plays WHERE played_at >= ? AND track_id = ? LIMIT 1`,
				(e.since ?? e.at) - SKIP_GRACE_MS,
				e.id,
			);
			if (heard) continue;
			if (this.now() - e.at < SKIP_GRACE_MS) {
				keep.push(e);
				continue;
			}
			const st = this.stationRow(e.st);
			if (st) this.bookEarlySkip(st, e.id, this.rulesOf(st), e.at, e.seen === true);
		}
		if (keep.length !== list.length) this.kvSet("pending_skips", keep);
	}

	private handleSyncError(err: unknown): void {
		if (err instanceof SpotifyError) {
			if (err.kind === "budget") return;
			if (err.kind === "rate" || err.kind === "quota") {
				this.setBackoff(err.retryAfterMs, err.kind);
				return;
			}
			if (err.kind === "auth") {
				this.markAuthLost();
				return;
			}
		}
		this.log(
			"warn",
			"sync",
			`Abgleich fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	private guestPeriods(): GuestPeriod[] {
		return this.kvGet<GuestPeriod[]>("guest") ?? [];
	}

	private inGuest(at: number): boolean {
		return this.guestPeriods().some((p) => at >= p.from && at < p.to);
	}

	/** Book new entries of the recently-played list into memory. */
	private recordPlays(
		items: { track: SpTrack; played_at: string; context: { uri: string } | null }[],
		s: SyncState,
	): RecentPlay[] {
		const out: RecentPlay[] = [];
		const key = (at: number, id: string) => `${at}|${id}`;
		// What the previous read already returned. A play older than the cursor
		// that was not in it arrived late (offline listening synced afterwards):
		// it still counts, once — the plays table has the final say.
		const known = new Set(this.kvGet<string[]>("recent_keys") ?? []);
		// Never reaching back before the first sign-in: that belongs to the import.
		const lateFrom = Math.max(
			s.recentCursor - LATE_PLAY_WINDOW_MS,
			this.kvGet<number>("live_since") ?? Number.NEGATIVE_INFINITY,
		);
		const fresh = items
			.map((i) => ({ i, at: Date.parse(i.played_at) }))
			.filter((x) => {
				const id = x.i.track?.id;
				if (!Number.isFinite(x.at) || !id) return false;
				if (x.at > s.recentCursor) return true;
				if (x.at <= lateFrom || known.has(key(x.at, id))) return false;
				return !this.db.first(`SELECT 1 FROM plays WHERE played_at = ? AND track_id = ?`, x.at, id);
			})
			.sort((a, b) => a.at - b.at);
		this.kvSet(
			"recent_keys",
			items
				.filter((i) => i.track?.id)
				.map((i) => key(Date.parse(i.played_at), i.track.id!))
				.slice(0, 60),
		);
		if (fresh.length >= 50 && items.length >= 50) {
			this.log(
				"warn",
				"gap",
				"Mehr als 50 Songs seit dem letzten Abgleich — ältere konnten nicht gelesen werden",
			);
		}
		const deckByUri = new Map<string, StationRow>();
		for (const st of this.stations()) {
			const uri = this.deckUri(st);
			if (uri) deckByUri.set(uri, st);
		}
		// Spotify leaves the context out for some plays; a song that was waiting in
		// exactly one station's deck came from there.
		const deckHolding = (id: TrackId, at: number): StationRow | undefined => {
			let hit: StationRow | undefined;
			for (const st of deckByUri.values()) {
				const d = this.deckOf(st);
				if (!d || d.writtenAt > at || !d.items.some((it) => it.id === id)) continue;
				if (hit) return undefined;
				hit = st;
			}
			return hit;
		};
		for (const { i, at } of fresh) {
			const id = i.track.id!;
			const ctx = i.context?.uri ?? null;
			const ignored = this.inGuest(at);
			const station = ctx ? deckByUri.get(ctx) : deckHolding(id, at);
			const packed = packTrack(i.track);
			this.db.run(
				`INSERT OR IGNORE INTO plays (played_at, track_id, context_uri, station_id, ignored, meta) VALUES (?, ?, ?, ?, ?, ?)`,
				at,
				id,
				ctx,
				station?.id ?? null,
				ignored ? 1 : 0,
				packed ? JSON.stringify(packed) : null,
			);
			s.recentCursor = Math.max(s.recentCursor, at);
			out.push({ trackId: id, playedAt: at, contextUri: ctx });
			if (ignored) continue;
			// The round is judged on memory as it was: a skip that already used the
			// song up (consume rule) stands in for this play — never counted twice.
			const before = this.memory(id);
			// Its play arrived after all: a skip booked around that time was none.
			const skippedAt = this.liveRow(id)?.last_skipped_at ?? null;
			if (skippedAt !== null && at >= skippedAt - 30 * MINUTE_MS && at <= skippedAt + 5 * MINUTE_MS)
				this.undoSkip(null, id);
			this.livePlay(id, at);
			this.countRound(id, before, at);
			this.noteDiscoveryHeard(id);
			// Heard somewhere else: every other deck still holding it is stale.
			this.dirtyDecksHolding(id, station?.id ?? null);
		}
		return out;
	}

	/**
	 * Keep each station's "fresh remaining" counter honest and start rounds.
	 * `only`: a skip under that rule — it uses the song up only there.
	 */
	private countRound(id: TrackId, before: TrackMemory, at: number, only?: SkipPolicy): void {
		for (const st of this.stations()) {
			if (st.fresh_remaining === null) continue;
			const rules = this.rulesOf(st);
			if (only && rules.skipPolicy !== only) continue;
			if (heardInRound(before, st.round_started_at, rules.skipPolicy)) continue;
			if (!this.stationPoolHas(st, id)) continue;
			const left = st.fresh_remaining - 1;
			if (left <= 0) {
				// This play completed the round; everything after it belongs to the next.
				this.db.run(
					`UPDATE stations SET fresh_remaining = NULL, round_no = round_no + 1, round_started_at = ?, deck_dirty = 1 WHERE id = ?`,
					at + 1,
					st.id,
				);
				this.log(
					"info",
					"round",
					`„${st.name}“: Runde ${st.round_no} komplett — jeder Song lief einmal`,
				);
			} else {
				this.db.run(`UPDATE stations SET fresh_remaining = ? WHERE id = ?`, left, st.id);
			}
		}
	}

	private poolSets = new Map<number, { key: string; set: Set<TrackId> }>();
	/** Bumped whenever a station pool can change (import, kept discovery, sources). */
	private poolVersion = 0;

	private stationPoolHas(st: StationRow, id: TrackId): boolean {
		const key = `${this.poolVersion}:${st.sources}`;
		let entry = this.poolSets.get(st.id);
		if (!entry || entry.key !== key) {
			entry = { key, set: new Set(this.stationPool(st).map((e) => e.id)) };
			this.poolSets.set(st.id, entry);
		}
		return entry.set.has(id);
	}

	/**
	 * `seen`: the song was seen playing and then left. Only then may a skip ban
	 * it or use it up for the round; a skip inferred from positions between
	 * two looks is booked softly ("not now, and rarer") and nothing more.
	 */
	private bookEarlySkip(
		st: StationRow,
		id: TrackId,
		rules: StationRules,
		at: number,
		seen: boolean,
	): void {
		if (this.inGuest(at)) return;
		const before = this.memory(id);
		this.liveSkip(id, at);
		this.log(
			"info",
			"skip",
			`Früh übersprungen auf „${st.name}“${seen ? "" : " (erschlossen)"}: ${this.describe(id)}`,
		);
		this.dirtyDecksHolding(id, null);
		if (!seen) return;
		if (rules.skipPolicy === "ban") {
			this.db.run(
				`INSERT OR IGNORE INTO bans (station_id, track_id, at) VALUES (?, ?, ?)`,
				st.id,
				id,
				at,
			);
		}
		if (rules.skipPolicy === "consume") {
			this.updateLive(id, (r) => ({ ...r, consumed_at: Math.max(r.consumed_at ?? 0, at) }));
			this.countRound(id, before, at, "consume");
		}
		// A discovery skipped early is not for this listener.
		this.db.run(
			`UPDATE discoveries SET status = 'rejected', updated_at = ? WHERE id = ? AND status IN ('candidate', 'probation')`,
			this.now(),
			id,
		);
	}

	/** Decks that still plan to play `id` must be rewritten when idle. */
	private dirtyDecksHolding(id: TrackId, exceptStation: number | null): void {
		for (const other of this.stations()) {
			if (other.id === exceptStation || other.deck_dirty === 1) continue;
			const d = this.deckOf(other);
			if (d?.items.some((it) => it.id === id && it.state === "pending")) {
				this.db.run(`UPDATE stations SET deck_dirty = 1 WHERE id = ?`, other.id);
			}
		}
	}

	/**
	 * A song booked as skipped turned out to be heard: take the skip back
	 * entirely — once, however many paths notice it.
	 */
	private undoSkip(stationId: number | null, id: TrackId): void {
		const row = this.liveRow(id);
		if (!row || row.last_skipped_at === null) return;
		const at = row.last_skipped_at;
		this.updateLive(id, (r) => ({
			...r,
			early_skips: Math.max(0, r.early_skips - 1),
			// Its "not now" pause goes too; having just been heard keeps it away anyway.
			last_skipped_at: null,
			consumed_at: null,
		}));
		// A ban that false skip caused: in this station's deck no ban existed
		// before it; elsewhere, the one booked at that very moment.
		if (stationId !== null)
			this.db.run(`DELETE FROM bans WHERE station_id = ? AND track_id = ?`, stationId, id);
		else this.db.run(`DELETE FROM bans WHERE track_id = ? AND at = ?`, id, at);
		this.db.run(
			`UPDATE discoveries SET status = 'probation', updated_at = ? WHERE id = ? AND status = 'rejected'`,
			this.now(),
			id,
		);
	}

	private noteDiscoveryHeard(id: TrackId): void {
		const rows = this.db.all<{ station_id: number; status: string; heard: number }>(
			`SELECT station_id, status, heard FROM discoveries WHERE id = ?`,
			id,
		);
		for (const r of rows) {
			const heard = r.heard + 1;
			let status = r.status;
			if (status === "candidate") status = "probation";
			else if (status === "probation" && heard >= 2) status = "kept";
			this.db.run(
				`UPDATE discoveries SET heard = ?, status = ?, updated_at = ? WHERE station_id = ? AND id = ?`,
				heard,
				status,
				this.now(),
				r.station_id,
				id,
			);
			if (status === "kept" && r.status !== "kept") this.keepDiscovery(id);
		}
	}

	private keepDiscovery(id: TrackId): void {
		this.enqueue(`keep:${id}`, "keep", { trackId: id }, 6);
		this.poolVersion++;
		this.log("info", "discovery", `Neuentdeckung behalten: ${this.describe(id)}`);
	}

	private async stepKeep(client: SpotifyClient, trackId: TrackId): Promise<StepResult> {
		let pid = this.kvGet<string>("discoveries_playlist");
		if (!pid) {
			const pl = await client.createPlaylist(DISCOVERIES_NAME, DISCOVERIES_DESCRIPTION);
			if (!pl?.id) throw new Error("Spotify hat keine Playlist angelegt");
			pid = pl.id;
			this.kvSet("discoveries_playlist", pid);
		}
		try {
			await client.addItems(pid, [`spotify:track:${trackId}`]);
		} catch (err) {
			if (err instanceof SpotifyError && (err.kind === "not_found" || err.kind === "forbidden")) {
				this.kvDel("discoveries_playlist");
				return { done: false, state: { trackId } };
			}
			throw err;
		}
		return { done: true };
	}

	// =======================================================================
	// Discovery
	// =======================================================================

	private async stepDiscover(
		client: SpotifyClient,
		budget: RequestBudget,
		stationId: number,
		state: DiscoveryState,
	): Promise<StepResult> {
		const st = this.stationRow(stationId);
		if (!st) return { done: true };
		const rules = this.rulesOf(st);
		const nextRun = { done: false as const, state: { stationId }, delayMs: 20 * HOUR_MS };
		if (!rules.discoveryEnabled || this.stationOrphaned(st)) return nextRun;
		if (!this.stationReady(st))
			return { done: false, state: { stationId }, delayMs: 5 * MINUTE_MS };
		const pending = this.db.first<{ n: number }>(
			`SELECT COUNT(*) AS n FROM discoveries WHERE station_id = ? AND status = 'candidate'`,
			stationId,
		)!.n;
		if (pending >= 150 && !state.phase) return nextRun;
		const pool = this.stationPool(st);
		const index = this.trackIndex();
		const known = (id: TrackId) =>
			index.has(id) || this.isDiscovery(id) || this.hasLive(id) || this.hist().has(id);
		const startedAt = state.startedAt ?? this.now();
		const result = await discoverStep(
			{
				client,
				budget,
				fetch: this.d.fetch,
				env: this.d.env,
				ai: this.d.ai,
				rng: this.d.rng,
				now: () => this.now(),
				seeds: () => this.seedArtists(pool),
				known,
				stationName: st.name,
				add: (t, source, score) => this.addDiscovery(stationId, t, source, score),
			},
			{ ...state, stationId, startedAt },
		);
		if (result.done) {
			this.indexCache = null;
			// Fresh finds belong in the station now, not at tomorrow's refresh; the
			// deck is only rewritten while nobody listens, as always.
			const found = this.db.first<{ n: number }>(
				`SELECT COUNT(*) AS n FROM discoveries WHERE station_id = ? AND created_at >= ?`,
				stationId,
				startedAt,
			)!.n;
			if (found > 0) this.db.run(`UPDATE stations SET deck_dirty = 1 WHERE id = ?`, stationId);
			return nextRun;
		}
		return { done: false, state: result.state };
	}

	/** Artists the listener demonstrably likes in this station — discovery seeds. */
	private seedArtists(pool: PoolEntry[]): { id: string; name: string; weight: number }[] {
		const index = this.lookupTracks(
			pool.map((e) => e.id),
			this.usedSources(),
		);
		const byArtist = new Map<string, { id: string; name: string; weight: number }>();
		for (const e of pool) {
			const m = this.memory(e.id);
			if (m.thumb === -1) continue;
			const t = index.get(e.id);
			const a = t?.[2][0];
			if (!a || a[0].startsWith("name:")) continue;
			const w =
				(m.liked ? 2 : 0) +
				(m.thumb === 1 ? 3 : 0) +
				Math.min(5, m.plays) * 0.5 -
				m.earlySkips +
				0.1;
			const cur = byArtist.get(a[0]) ?? { id: a[0], name: a[1], weight: 0 };
			cur.weight += Math.max(0, w);
			byArtist.set(a[0], cur);
		}
		return [...byArtist.values()].sort((x, y) => y.weight - x.weight).slice(0, 60);
	}

	private addDiscovery(stationId: number, t: PackedTrack, source: string, score: number): boolean {
		const exists = this.db.first(`SELECT id FROM discoveries WHERE id = ?`, t[0]);
		if (exists) return false;
		this.db.run(
			`INSERT OR IGNORE INTO discoveries (station_id, id, source, score, status, meta, heard, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'candidate', ?, 0, ?, ?)`,
			stationId,
			t[0],
			source,
			Math.max(0.05, Math.min(1, score)),
			JSON.stringify(t),
			this.now(),
			this.now(),
		);
		return true;
	}

	// =======================================================================
	// Playback
	// =======================================================================

	async play(stationId: number, deviceId?: string | null): Promise<PlayResult> {
		const st = this.stationRow(stationId);
		if (!st) return fail("unknown", "Diesen Sender gibt es nicht.");
		if (this.backoffUntil() > this.now()) {
			const kind = this.kvGet<{ kind: string }>("backoff")?.kind === "quota" ? "quota" : "rate";
			return fail(
				kind,
				kind === "quota"
					? "Spotify-Kontingent aufgebraucht — bitte später erneut."
					: "Spotify bremst gerade — gleich noch einmal versuchen.",
			);
		}
		const budget = new RequestBudget(BUDGET_PER_INVOCATION);
		const client = this.client(budget);
		try {
			await this.sync(budget, { force: true });
			const fresh = this.stationRow(stationId)!;
			let deck = this.deckOf(fresh);
			const needsRebuild =
				!deck ||
				fresh.deck_dirty === 1 ||
				consumedCount(deck) > 0 ||
				deck.continued === true ||
				this.now() - deck.writtenAt > DECK_MAX_AGE_MS ||
				!fresh.playlist_id;
			if (needsRebuild) deck = await this.rebuildDeck(client, fresh, "start");
			const target = await this.pickDevice(client, deviceId ?? null);
			if (!target)
				return fail(
					"no_device",
					"Öffne Spotify auf einem Gerät (Handy, PC, Box) — dann nochmal tippen.",
				);
			// Our order only holds with the service's own shuffle and repeat off.
			for (const fix of [
				() => client.setShuffle(false, target.id),
				() => client.setRepeat("off", target.id),
			]) {
				try {
					await fix();
				} catch (err) {
					if (err instanceof SpotifyError && (err.kind === "premium" || err.kind === "restricted"))
						throw err;
				}
			}
			try {
				await client.play({
					contextUri: `spotify:playlist:${fresh.playlist_id}`,
					position: 0,
					deviceId: target.id,
				});
			} catch (err) {
				if (!(err instanceof SpotifyError && err.kind === "not_found")) throw err;
				// The listener deleted the station's playlist in Spotify: make a new one.
				this.db.run(`UPDATE stations SET playlist_id = NULL WHERE id = ?`, fresh.id);
				fresh.playlist_id = null;
				deck = await this.rebuildDeck(client, fresh);
				await client.play({
					contextUri: `spotify:playlist:${fresh.playlist_id}`,
					position: 0,
					deviceId: target.id,
				});
			}
			if (deck) {
				// We started it at the top: positions from here on are ours.
				deck.lastIndex = null;
				deck.lastTrackId = null;
				deck.lastObservedAt = null;
				deck.ours = true;
				deck.top = true;
				this.saveDeck(fresh.id, deck);
			}
			const activity = this.kvGet<Record<string, number>>("deck_activity") ?? {};
			activity[String(fresh.id)] = this.now();
			this.kvSet("deck_activity", activity);
			this.db.run(`UPDATE stations SET last_played_at = ? WHERE id = ?`, this.now(), fresh.id);
			this.log("info", "play", `„${fresh.name}“ gestartet auf ${target.name}`);
			this.kvSet("player_stale", 1);
			// The deck is current now: a rewrite queued before would only wait on
			// its own clock and come late after the next stop.
			this.db.run(`DELETE FROM jobs WHERE key = ?`, `deck:${fresh.id}`);
			await this.scheduleSoon(20_000);
			return { ok: true, deviceName: target.name };
		} catch (err) {
			return this.playError(err);
		}
	}

	private playError(err: unknown): PlayResult {
		if (err instanceof HubError) {
			const code: PlayErrorCode =
				err.code === "not_ready" || err.code === "empty" ? err.code : "unknown";
			return fail(code, err.message);
		}
		if (err instanceof SpotifyError) {
			switch (err.kind) {
				case "premium":
					return fail("premium", "Spotify erlaubt das Starten nur mit Premium.");
				case "no_device":
					return fail(
						"no_device",
						"Kein Spotify-Gerät aktiv. Öffne Spotify auf Handy, PC oder Box und tippe nochmal.",
					);
				case "restricted":
					return fail(
						"restricted",
						"Dieses Gerät nimmt keine Fernsteuerung an. Wähle ein anderes.",
					);
				case "rate":
					this.setBackoff(err.retryAfterMs, "rate");
					return fail("rate", "Spotify bremst gerade — gleich noch einmal versuchen.");
				case "quota":
					this.setBackoff(err.retryAfterMs, "quota");
					return fail("quota", "Spotify-Kontingent aufgebraucht — bitte später erneut.");
				case "auth":
					this.markAuthLost();
					return fail("auth", "Spotify-Anmeldung abgelaufen — bitte neu verbinden.");
				case "budget":
					return fail("unknown", "Zu viel auf einmal — tippe gleich nochmal.");
				default:
					return fail("unknown", `Spotify meldet: ${err.message}`);
			}
		}
		this.log("error", "play", String(err));
		return fail("unknown", "Das hat nicht geklappt. Versuch es nochmal.");
	}

	private async pickDevice(
		client: SpotifyClient,
		wanted: string | null,
	): Promise<{ id: string; name: string } | null> {
		const devices = await client.devices();
		if (wanted) {
			const d = devices.find((x) => x.id === wanted);
			if (d?.id) return { id: d.id, name: d.name };
		}
		const usable = devices.filter((d) => d.id && !d.is_restricted);
		const active = usable.find((d) => d.is_active);
		const pick = active ?? usable.find((d) => d.type === "Smartphone") ?? usable[0];
		return pick?.id ? { id: pick.id, name: pick.name } : null;
	}

	async devices(): Promise<DeviceView[]> {
		const budget = new RequestBudget(4);
		const list = await this.client(budget).devices();
		return list
			.filter((d) => d.id)
			.map((d) => ({
				id: d.id!,
				name: d.name,
				type: d.type,
				active: d.is_active,
				restricted: d.is_restricted,
			}));
	}

	async playerAction(action: "pause" | "resume" | "next"): Promise<PlayResult> {
		const budget = new RequestBudget(6);
		const client = this.client(budget);
		try {
			if (action === "pause") await client.pause();
			else if (action === "resume") await client.resume();
			else await client.next();
			// The next look at the interface must read the player, not the old snapshot.
			this.kvSet("player_stale", 1);
			await this.scheduleSoon(4000);
			return { ok: true };
		} catch (err) {
			return this.playError(err);
		}
	}

	// =======================================================================
	// Listener input
	// =======================================================================

	async thumb(trackId: TrackId, value: -1 | 0 | 1): Promise<void> {
		if (!/^[A-Za-z0-9]{22}$/.test(trackId)) throw new HubError("bad_track", "Ungültige Song-ID");
		this.updateLive(trackId, (r) => ({ ...r, thumb: value }));
		if (value === -1) {
			this.db.run(
				`UPDATE discoveries SET status = 'rejected', updated_at = ? WHERE id = ?`,
				this.now(),
				trackId,
			);
			// Stations planning to play it leave it out next time.
			this.dirtyDecksHolding(trackId, null);
			const snap = this.kvGet<PlayerSnapshot>("player");
			if (snap?.obs?.isPlaying && snap.obs.trackId === trackId) await this.playerAction("next");
		}
		if (value === 1) {
			// "Nie wieder auf diesem Sender" ends with a thumb up, on every station.
			this.db.run(`DELETE FROM bans WHERE track_id = ?`, trackId);
			const rows = this.db.all<{ status: string }>(
				`SELECT status FROM discoveries WHERE id = ?`,
				trackId,
			);
			if (rows.some((r) => r.status !== "kept")) {
				this.db.run(
					`UPDATE discoveries SET status = 'kept', updated_at = ? WHERE id = ?`,
					this.now(),
					trackId,
				);
				this.keepDiscovery(trackId);
			}
		}
		this.log(
			"info",
			"thumb",
			`${value === 1 ? "Daumen hoch" : value === -1 ? "Daumen runter" : "Daumen zurückgesetzt"}: ${this.describe(trackId)}`,
		);
		await this.scheduleSoon(2000);
	}

	setGuest(on: boolean, hours = GUEST_DEFAULT_HOURS): void {
		const now = this.now();
		let periods = this.guestPeriods().filter((p) => p.to > now - 90 * DAY_MS);
		const open = periods.find((p) => now >= p.from && now < p.to);
		if (on) {
			const to = now + Math.min(48, Math.max(1, hours)) * HOUR_MS;
			if (open) open.to = to;
			else periods.push({ from: now, to });
		} else if (open) {
			open.to = now;
		}
		periods = periods.slice(-50);
		this.kvSet("guest", periods);
		this.log(
			"info",
			"guest",
			on ? "Gast-Modus an — nichts zählt ins Gedächtnis" : "Gast-Modus aus",
		);
	}

	importHistory(rows: HistoryRow[], part: number, parts: number): { stored: number } {
		if (
			!Array.isArray(rows) ||
			rows.length > 5000 ||
			!Number.isInteger(part) ||
			!Number.isInteger(parts) ||
			part < 0 ||
			part >= parts ||
			parts > 200
		)
			throw new HubError("bad_import", "Ungültiger Import-Block");
		// Rows come from the browser: only well-formed counts and times reach the memory.
		const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1e6;
		const latest = this.now() + DAY_MS;
		for (const r of rows) {
			if (
				!Array.isArray(r) ||
				r.length !== 4 ||
				typeof r[0] !== "string" ||
				!/^[A-Za-z0-9]{22}$/.test(r[0]) ||
				!count(r[1]) ||
				!count(r[2]) ||
				!Number.isInteger(r[3]) ||
				r[3] < 0 ||
				r[3] > latest
			) {
				throw new HubError("bad_import", "Ungültige Zeile im Import");
			}
		}
		if (part === 0) this.db.run(`DELETE FROM hist_pages`);
		const base =
			(this.db.first<{ m: number | null }>(`SELECT MAX(page) AS m FROM hist_pages`)?.m ?? -1) + 1;
		for (let i = 0; i < rows.length; i += 500) {
			this.db.run(
				`INSERT INTO hist_pages (page, data) VALUES (?, ?)`,
				base + i / 500,
				JSON.stringify(rows.slice(i, i + 500)),
			);
		}
		this.histCache = null;
		if (part === parts - 1) {
			const total = this.hist().size;
			this.kvSet("history_import", { at: this.now(), tracks: total });
			this.db.run(`UPDATE stations SET deck_dirty = 1`);
			this.log("info", "history", `Hörverlauf übernommen: ${total} Songs mit Vorgeschichte`);
		}
		return { stored: rows.length };
	}

	// =======================================================================
	// Reading for the interface
	// =======================================================================

	async state(opts: { live?: boolean } = {}): Promise<AppState> {
		const profile = this.kvGet<{ id: string; name: string; imageUrl: string | null }>(
			"profile",
		) ?? {
			id: "",
			name: "",
			imageUrl: null,
		};
		if (opts.live && this.isConnected()) {
			// An open app looks at Spotify when the picture may have changed: after
			// a tap, when the song should have ended, and otherwise every 45 s — the
			// display runs the progress on by itself in between.
			const snap = this.kvGet<PlayerSnapshot>("player");
			const age = snap ? this.now() - Math.max(snap.at, this.lastLookAt) : Number.POSITIVE_INFINITY;
			const ended =
				!!snap?.obs?.isPlaying &&
				snap.obs.durationMs > 0 &&
				snap.obs.progressMs + age > snap.obs.durationMs + 2000;
			if (!snap || this.kvGet("player_stale") || age > 45_000 || (ended && age > 5_000)) {
				const budget = new RequestBudget(8);
				await this.sync(budget);
				// What this look saw decides the next one (a song end, a held station).
				if (this.isConnected()) await this.scheduleNext(budget);
			}
		}
		const snap = this.kvGet<PlayerSnapshot>("player");
		const stations = this.stations().map((st) => this.summary(st, snap));
		const warnings: Warning[] = [];
		if (this.kvGet("auth_lost"))
			warnings.push({
				code: "auth",
				message: "Spotify-Anmeldung abgelaufen — bitte neu verbinden.",
			});
		const backoff = this.kvGet<{ until: number; kind: string }>("backoff");
		if (backoff && backoff.until > this.now()) {
			warnings.push({
				code: backoff.kind,
				message:
					backoff.kind === "quota"
						? "Spotify-Kontingent aufgebraucht — True Shuffle macht kurz Pause."
						: "Spotify bremst gerade — True Shuffle wartet kurz.",
			});
		}
		const np = this.nowPlaying(snap);
		if (np?.smartShuffle) {
			warnings.push({
				code: "smart_shuffle",
				message:
					"Smart Shuffle ist in Spotify an — dann mischt Spotify fremde Songs dazu. Schalte es in der Spotify-App aus.",
			});
		} else if (np?.orderBroken) {
			warnings.push({
				code: "shuffle",
				message:
					"Spotify-Shuffle ist an — die True-Shuffle-Reihenfolge hält erst wieder, wenn es aus ist.",
			});
		}
		for (const r of this.kvGet<{ id: string; name: string }[]>("sources_gone") ?? []) {
			const users = this.stations().filter(
				(st) =>
					st.kind !== "all" &&
					this.sourcesOf(st).some((x) => x.type === "playlist" && x.id === r.id),
			);
			if (users.length === 0) continue;
			const names = (list: StationRow[]) => list.map((st) => `„${st.name}“`).join(", ");
			const orphaned = users.filter((st) => this.stationOrphaned(st));
			const playingOn = users.filter((st) => !this.stationOrphaned(st));
			const parts: string[] = [];
			if (playingOn.length > 0)
				parts.push(
					`${names(playingOn)} ${playingOn.length === 1 ? "spielt" : "spielen"} ohne sie weiter`,
				);
			if (orphaned.length > 0)
				parts.push(
					`${names(orphaned)} ${orphaned.length === 1 ? "hat" : "haben"} damit keine Quelle mehr — wähle unter „Quellen“ eine neue`,
				);
			warnings.push({
				code: "source_gone",
				message: `Die Playlist „${r.name}“ gibt es in deinem Spotify nicht mehr: ${parts.join("; ")}.`,
			});
		}
		const guestNow = this.guestPeriods().find((p) => this.now() >= p.from && this.now() < p.to);
		const hist = this.kvGet<{ at: number; tracks: number }>("history_import");
		return {
			profile,
			onboarded: this.kvGet<boolean>("onboarded") === true,
			stations,
			nowPlaying: np,
			guest: { active: !!guestNow, until: guestNow?.to ?? null },
			warnings,
			jobs: this.jobViews(),
			history: {
				importedTracks: hist?.tracks ?? 0,
				importedAt: hist?.at ?? null,
				liveSince: this.kvGet<number>("live_since"),
			},
			aiSource: this.d.env.anthropicKey ? "anthropic" : this.d.ai ? "workers-ai" : "off",
			serverTime: this.now(),
		};
	}

	private summary(st: StationRow, snap: PlayerSnapshot | null): StationSummary {
		const uri = this.deckUri(st);
		const pool = st.pool_size;
		const fresh = st.fresh_remaining;
		const imageSource = this.sourcesOf(st).find((s) => s.type === "playlist") as
			| { type: "playlist"; id: string }
			| undefined;
		const image = imageSource
			? (this.db.first<{ image_url: string | null }>(
					`SELECT image_url FROM playlists WHERE id = ?`,
					imageSource.id,
				)?.image_url ?? null)
			: null;
		const importing = this.sourcesOf(st).some((s) => this.jobExists(`import:${sourceKey(s)}`));
		return {
			id: st.id,
			name: st.name,
			kind: st.kind,
			sources: st.kind === "all" ? [] : (JSON.parse(st.sources) as StationSource[]),
			rules: this.rulesOf(st),
			roundNo: st.round_no,
			poolSize: pool,
			freshRemaining: fresh,
			progress:
				pool && fresh !== null && pool > 0 ? Math.min(1, Math.max(0, (pool - fresh) / pool)) : null,
			playlistId: st.playlist_id,
			ready: !!st.deck && !!st.playlist_id,
			importing,
			lastPlayedAt: st.last_played_at,
			playing: !!(uri && snap?.obs?.contextUri === uri && snap.obs.isPlaying),
			imageUrl: image,
		};
	}

	private nowPlaying(snap: PlayerSnapshot | null): NowPlaying | null {
		if (!snap?.obs?.trackId) return null;
		const t =
			snap.track ??
			this.lookupTracks([snap.obs.trackId], this.usedSources()).get(snap.obs.trackId) ??
			null;
		if (!t) return null;
		let stationId: number | null = null;
		let kind: SlotKind | null = null;
		for (const st of this.stations()) {
			if (this.deckUri(st) === snap.obs.contextUri) {
				stationId = st.id;
				kind = this.deckOf(st)?.items.find((i) => i.id === t[0])?.kind ?? null;
			}
		}
		const elapsed = snap.obs.isPlaying ? this.now() - snap.at : 0;
		return {
			...this.view(t),
			isPlaying: snap.obs.isPlaying,
			progressMs: Math.min(t[5], snap.obs.progressMs + elapsed),
			stationId,
			kind,
			deviceName: snap.device?.name ?? null,
			orderBroken: stationId !== null && (snap.obs.shuffle || snap.obs.smartShuffle),
			smartShuffle: stationId !== null && snap.obs.smartShuffle,
			thumb: this.memory(t[0]).thumb,
			observedAt: snap.at,
		};
	}

	private view(t: PackedTrack): TrackView {
		return {
			id: t[0],
			name: t[1],
			artists: artistLine(t),
			album: t[3],
			imageUrl: t[4],
			durationMs: t[5],
		};
	}

	/** A song's name for a log line, from what is already in memory — no reads. */
	private describe(id: TrackId): string {
		const snap = this.kvGet<PlayerSnapshot>("player");
		let t: PackedTrack | undefined = snap?.track?.[0] === id ? snap.track : undefined;
		if (!t)
			for (const list of this.sourceCache.values()) {
				t = list.find((x) => x[0] === id);
				if (t) break;
			}
		return t ? `${t[1]} — ${artistLine(t)}` : id;
	}

	private jobViews(): JobView[] {
		const out: JobView[] = [];
		for (const j of this.db.all<JobRow>(
			`SELECT * FROM jobs WHERE kind IN ('import', 'deck') ORDER BY priority, run_after`,
		)) {
			const s = JSON.parse(j.state) as ImportState & { stationId?: number };
			if (j.kind === "import") {
				out.push({
					key: j.key,
					label: `${sourceLabel(s.source, this)} einlesen`,
					done: s.count ?? 0,
					total: s.total ?? null,
					error: j.error,
				});
			} else if (j.kind === "deck" && s.stationId !== undefined) {
				const st = this.stationRow(s.stationId);
				if (st && !st.deck)
					out.push({
						key: j.key,
						label: `„${st.name}“ vorbereiten`,
						done: null,
						total: null,
						error: j.error,
					});
			}
		}
		return out;
	}

	playlistName(id: string): string | null {
		return (
			this.db.first<{ name: string }>(`SELECT name FROM playlists WHERE id = ?`, id)?.name ?? null
		);
	}

	/** Read the listener's playlist list again soon, unless that just happened. */
	async refreshPlaylistsSoon(): Promise<void> {
		if (this.now() - this.syncState().lastPlaylistsAt < 10 * MINUTE_MS) return;
		if (this.jobExists("playlists")) return;
		this.enqueue("playlists", "playlists", {}, 1);
		await this.scheduleSoon(1000);
	}

	listPlaylists(): PlaylistView[] {
		return this.db
			.all<{
				id: string;
				name: string;
				owner_name: string | null;
				image_url: string | null;
				total: number | null;
				readable: number;
				imported_at: number | null;
				imported_count: number | null;
				skipped_count: number | null;
			}>(`SELECT * FROM playlists WHERE ours = 0 AND gone_at IS NULL ORDER BY sort`)
			.map((p) => ({
				id: p.id,
				name: p.name,
				ownerName: p.owner_name,
				imageUrl: p.image_url,
				total: p.total,
				readable: p.readable === 1,
				imported: p.imported_at !== null,
				importedCount: p.imported_count,
				skippedCount: p.skipped_count,
			}));
	}

	stationDetail(id: number): StationDetail {
		const st = this.stationRow(id);
		if (!st) throw new HubError("not_found", "Diesen Sender gibt es nicht.", 404);
		const snap = this.kvGet<PlayerSnapshot>("player");
		const deck = this.deckOf(st);
		const upcoming: StationDetail["upcoming"] = [];
		if (deck) {
			const from = (position(deck) ?? -1) + 1;
			const next = deck.items
				.slice(from)
				.filter((it) => it.state === "pending")
				.slice(0, 12);
			const found = this.lookupTracks(
				next.map((it) => it.id),
				this.liveSources(st).map(sourceKey),
			);
			for (const it of next) {
				const t = found.get(it.id);
				if (t) upcoming.push({ ...this.view(t), kind: it.kind });
			}
		}
		const recentRows = this.db.all<{ played_at: number; track_id: string; meta: string | null }>(
			`SELECT played_at, track_id, meta FROM plays WHERE station_id = ? AND ignored = 0 ORDER BY played_at DESC LIMIT 15`,
			id,
		);
		const bare = recentRows.filter((r) => !r.meta).map((r) => r.track_id);
		const index =
			bare.length > 0 ? this.lookupTracks(bare, this.liveSources(st).map(sourceKey)) : new Map();
		const recent = recentRows
			.map((r) => {
				const t = (r.meta ? (JSON.parse(r.meta) as PackedTrack) : null) ?? index.get(r.track_id);
				return t ? { ...this.view(t), playedAt: r.played_at } : null;
			})
			.filter((x): x is TrackView & { playedAt: number } => x !== null);
		const disc = this.db.all<{ status: string; n: number }>(
			`SELECT status, COUNT(*) AS n FROM discoveries WHERE station_id = ? GROUP BY status`,
			id,
		);
		const count = (s: string) => disc.filter((d) => d.status === s).reduce((a, b) => a + b.n, 0);
		const stats = st.stats ? (JSON.parse(st.stats) as { counts: Record<SlotKind, number> }) : null;
		return {
			...this.summary(st, snap),
			upcoming,
			recent,
			counts: stats?.counts ?? null,
			discoveries: {
				pending: count("candidate") + count("probation"),
				kept: count("kept"),
				rejected: count("rejected"),
			},
		};
	}

	history(limit = 50, before?: number): HistoryEntry[] {
		const rows = this.db.all<{
			played_at: number;
			track_id: string;
			meta: string | null;
			station_id: number | null;
			ignored: number;
		}>(
			`SELECT played_at, track_id, meta, station_id, ignored FROM plays WHERE played_at < ? ORDER BY played_at DESC LIMIT ?`,
			before ?? Number.MAX_SAFE_INTEGER,
			Math.min(200, Math.max(1, limit)),
		);
		const names = new Map(this.stations().map((s) => [s.id, s.name]));
		const bare = rows.filter((r) => !r.meta).map((r) => r.track_id);
		const index = bare.length > 0 ? this.lookupTracks(bare, this.usedSources()) : new Map();
		return rows
			.map((r) => {
				const t = (r.meta ? (JSON.parse(r.meta) as PackedTrack) : null) ?? index.get(r.track_id);
				if (!t) return null;
				return {
					...this.view(t),
					playedAt: r.played_at,
					stationName: r.station_id !== null ? (names.get(r.station_id) ?? null) : null,
					ignored: r.ignored === 1,
				};
			})
			.filter((x): x is HistoryEntry => x !== null);
	}

	// =======================================================================
	// Alarm — the only thing that runs without the listener
	// =======================================================================

	/**
	 * Taken off `ALLOWED_SPOTIFY_IDS`: no more background work on the shared
	 * free-plan quotas. Signing in again (once allowed) wakes the hub.
	 */
	suspend(): void {
		this.kvSet("suspended", 1);
	}

	async alarm(): Promise<void> {
		if (this.kvGet("suspended")) return;
		if (!this.isConnected() && this.kvGet("tokens") === null) return;
		const budget = new RequestBudget(BUDGET_PER_INVOCATION);
		try {
			// Sync first: memory must be current before any deck is planned.
			await this.sync(budget);
			await this.runJobs(budget);
		} catch (err) {
			this.log("error", "alarm", err instanceof Error ? err.message : String(err));
		} finally {
			await this.scheduleNext(budget);
		}
	}

	private async scheduleNext(budget: RequestBudget): Promise<void> {
		const now = this.now();
		const candidates: number[] = [];
		const backoff = this.backoffUntil();
		const job =
			this.db.first<{ t: number | null }>(`SELECT MIN(run_after) AS t FROM jobs`)?.t ?? null;
		if (job !== null) {
			// Work left over because the budget ran out: continue almost at once.
			candidates.push(budget.left < 6 && job <= now ? now + 2000 : Math.max(job, now + 1000));
		}
		const snap = this.kvGet<PlayerSnapshot>("player");
		const s = this.syncState();
		const inDeck = snap?.obs?.contextUri
			? this.stations().some((st) => this.deckUri(st) === snap.obs?.contextUri)
			: false;
		// Just moved the player (a tap, or past a song): see where it went.
		if (this.kvGet("player_stale")) candidates.push(now + 15_000);
		// A few songs ahead the player may meet one True Shuffle would not play
		// (turned down, or replaced since the player loaded the playlist): look
		// every 20 s, so a skip by hand onto it is caught too.
		if (snap?.obs?.isPlaying && this.guardedAhead(snap.obs.contextUri))
			candidates.push(now + 20_000);
		// A station playing a song its playlist no longer holds: the player
		// follows an older order, and what comes next is unknown — look often.
		if (snap?.obs?.isPlaying && this.olderOrder(snap.obs)) candidates.push(now + 30_000);
		if (snap?.obs?.isPlaying && inDeck) {
			// Look right after the song ends: the next one is then seen in its
			// first seconds — a song turned down is skipped before it is heard,
			// and a skip is seen rather than inferred. Songs longer than a few
			// minutes get a look in between.
			const left = snap.obs.durationMs - snap.obs.progressMs;
			const end = snap.at + left + 2000;
			const aligned =
				snap.obs.durationMs > 0 &&
				left > 0 &&
				now - snap.at <= PLAYER_FRESH_MS &&
				end - now <= 4 * MINUTE_MS;
			candidates.push(aligned ? Math.max(now + 15_000, end) : now + 3 * MINUTE_MS);
		} else if (snap?.obs?.isPlaying) candidates.push(now + 10 * MINUTE_MS);
		else if (this.stationHeld(snap))
			// A player holds a station (paused, or out of sight): whatever it plays
			// on resume is seen within a minute.
			candidates.push(now + MINUTE_MS);
		else if (s.idleSince !== null && now - s.idleSince > 6 * HOUR_MS)
			candidates.push(now + 60 * MINUTE_MS);
		else candidates.push(now + 20 * MINUTE_MS);
		let at = Math.min(...candidates);
		if (backoff > now) at = Math.max(at, backoff + 1000);
		await this.d.alarms.set(at);
	}

	private olderOrder(obs: PlayerObservation): boolean {
		const st = obs.contextUri
			? this.stations().find((x) => this.deckUri(x) === obs.contextUri)
			: null;
		const deck = st ? this.deckOf(st) : null;
		return !!deck && !!obs.trackId && !deck.items.some((it) => it.id === obs.trackId);
	}

	private guardedAhead(uri: string | null): boolean {
		const st = uri ? this.stations().find((x) => this.deckUri(x) === uri) : null;
		const deck = st ? this.deckOf(st) : null;
		const at = deck ? position(deck) : null;
		if (!deck || at === null) return false;
		for (let i = at + 1; i <= at + 3 && i < deck.items.length; i++) {
			if (deck.changedAt?.includes(i) || this.memory(deck.items[i]!.id).thumb === -1) return true;
		}
		return false;
	}

	/** A player paused in a station's playlist, or gone quiet in it, within the last 12 h. */
	private stationHeld(snap: PlayerSnapshot | null): boolean {
		const uri = snap?.obs ? snap.obs.contextUri : this.kvGet<string>("last_context");
		if (!uri) return false;
		const st = this.stations().find((x) => this.deckUri(x) === uri);
		if (!st) return false;
		const active = this.kvGet<Record<string, number>>("deck_activity")?.[String(st.id)] ?? 0;
		return this.now() - active < CONTINUE_WITHIN_MS;
	}

	async scheduleSoon(ms: number): Promise<void> {
		const at = this.now() + ms;
		const cur = await this.d.alarms.get();
		if (cur === null || cur > at) await this.d.alarms.set(at);
	}

	async ensureAlarm(): Promise<void> {
		if (!this.isConnected() || this.kvGet("suspended")) return;
		const cur = await this.d.alarms.get();
		if (cur === null) await this.d.alarms.set(this.now() + 5000);
	}

	// =======================================================================
	// Leaving
	// =======================================================================

	async deleteAccount(): Promise<{ stuck: string[] }> {
		const budget = new RequestBudget(BUDGET_PER_INVOCATION);
		const client = this.client(budget);
		const ids = [
			...this.stations().map((s) => s.playlist_id),
			this.kvGet<string>("discoveries_playlist"),
		].filter((x): x is string => !!x);
		const stuck: string[] = [];
		for (const id of ids) {
			try {
				await client.unfollowPlaylist(id);
			} catch {
				stuck.push(id);
			}
		}
		if (this.d.wipe) await this.d.wipe();
		return { stuck };
	}
}

// ---------------------------------------------------------------------------

interface ImportState {
	source: string;
	offset?: number;
	skipped?: number;
	count?: number;
	snapshot?: string | null;
	total?: number;
}

/** Equal but for the moment of the last look at the player. */
function sameDeck(a: Deck, b: Deck): boolean {
	return (
		JSON.stringify({ ...a, lastObservedAt: null }) ===
		JSON.stringify({ ...b, lastObservedAt: null })
	);
}

function fail(code: PlayErrorCode, message: string): PlayResult {
	return { ok: false, error: { code, message } };
}

function sourceLabel(source: string, hub: HubCore): string {
	if (source === "liked") return "Lieblingssongs";
	return `„${hub.playlistName(source.slice(3)) ?? "Playlist"}“`;
}

export function toObservation(
	state: SpPlaybackState | null,
	now: number,
): PlayerObservation | null {
	if (!state) return null;
	const item = state.item;
	return {
		at: now,
		contextUri: state.context?.uri ?? null,
		trackId: item?.id ?? null,
		isPlaying: state.is_playing === true,
		progressMs: state.progress_ms ?? 0,
		durationMs: item?.duration_ms ?? 0,
		shuffle: state.shuffle_state === true,
		smartShuffle: state.smart_shuffle === true,
	};
}
