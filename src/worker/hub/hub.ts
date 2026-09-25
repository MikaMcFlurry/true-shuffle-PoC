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
	consumedCount,
	type Deck,
	newDeck,
	observePlayer,
	type PlayerObservation,
	type RecentPlay,
	remainingAhead,
	SKIP_GRACE_MS,
	settleSkips,
} from "../../core/deck";
import { fromRow, type HistoryRow } from "../../core/history";
import { heardInRound, type ImportedStats, mergeMemory } from "../../core/memory";
import { type DiscoveryEntry, type PoolEntry, planQueue } from "../../core/planner";
import type { Rng } from "../../core/random";
import {
	DAY_MS,
	DEFAULT_RULES,
	emptyMemory,
	HOUR_MS,
	MINUTE_MS,
	normaliseRules,
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
	private memCache: Map<TrackId, MemoryRow> | null = null;
	private histCache: Map<TrackId, ImportedStats> | null = null;
	private likedCache: Set<TrackId> | null = null;
	private indexCache: Map<TrackId, PackedTrack> | null = null;

	constructor(private readonly d: HubDeps) {
		this.db = d.sql;
		migrate(this.db);
	}

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

	private setSyncState(s: SyncState): void {
		this.kvSet("sync", s);
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

	async connect(
		profile: { id: string; name: string; imageUrl: string | null },
		tokens: SpotifyTokens,
	): Promise<void> {
		await this.tokenStore().set(tokens);
		this.kvSet("profile", profile);
		this.kvDel("auth_lost");
		if (!this.kvGet("created_at")) {
			this.kvSet("created_at", this.now());
			// Start the recently-played cursor now: history from before the first
			// sign-in arrives through the optional import, not through a partial
			// 50-song window.
			const s = this.syncState();
			s.recentCursor = this.now() - HOUR_MS * 3;
			this.setSyncState(s);
		}
		this.enqueue("playlists", "playlists", {}, 1);
		this.log("info", "connect", `Mit Spotify verbunden als ${profile.name}`);
		await this.scheduleSoon(1000);
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
				return this.stepPlaylists(client, state as { offset?: number }, budget);
			case "import":
				return this.stepImport(client, state as unknown as ImportState, budget);
			case "deck":
				return this.stepDeck(client, Number(state.stationId));
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
		state: { offset?: number },
		budget: RequestBudget,
	): Promise<StepResult> {
		let offset = state.offset ?? 0;
		const seenAt = this.now();
		const ours = new Set(
			this.stations()
				.map((s) => s.playlist_id)
				.filter(Boolean) as string[],
		);
		const discoveriesId = this.kvGet<string>("discoveries_playlist");
		if (discoveriesId) ours.add(discoveriesId);
		const profile = this.kvGet<{ id: string }>("profile");
		while (budget.left > 4) {
			const page = await client.myPlaylists(offset);
			if (!page) break;
			page.items.forEach((p, i) => {
				if (!p?.id) return;
				const isOurs =
					ours.has(p.id) || (p.owner?.id === profile?.id && p.name.startsWith(DECK_NAME_PREFIX));
				const readable = p.owner?.id === profile?.id || p.collaborative === true;
				this.db.run(
					`INSERT INTO playlists (id, name, owner_id, owner_name, image_url, total, snapshot_id, readable, ours, sort, seen_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET name = excluded.name, owner_id = excluded.owner_id,
					   owner_name = excluded.owner_name, image_url = excluded.image_url, total = excluded.total,
					   snapshot_id = excluded.snapshot_id, readable = excluded.readable, ours = excluded.ours,
					   sort = excluded.sort, seen_at = excluded.seen_at`,
					p.id,
					p.name,
					p.owner?.id ?? null,
					p.owner?.display_name ?? null,
					pickImage(p.images),
					p.items?.total ?? null,
					p.snapshot_id,
					readable ? 1 : 0,
					isOurs ? 1 : 0,
					offset + i,
					seenAt,
				);
			});
			if (!page.next) {
				// Playlists the listener no longer follows disappear from the list.
				this.db.run(`DELETE FROM playlists WHERE seen_at < ?`, seenAt);
				const s = this.syncState();
				s.lastPlaylistsAt = this.now();
				this.setSyncState(s);
				this.queueChangedSources();
				return { done: true };
			}
			offset += page.items.length || 50;
		}
		return { done: false, state: { offset } };
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
		const rows = this.db.all<{ source: string }>(`SELECT DISTINCT source FROM pages`);
		for (const r of rows) for (const t of this.loadSource(r.source)) idx.set(t[0], t);
		for (const d of this.db.all<{ id: string; meta: string }>(`SELECT id, meta FROM discoveries`)) {
			if (!idx.has(d.id)) idx.set(d.id, JSON.parse(d.meta) as PackedTrack);
		}
		this.indexCache = idx;
		return idx;
	}

	// =======================================================================
	// Memory
	// =======================================================================

	/**
	 * All live memory rows. Only the planner needs this; the sync path uses
	 * point lookups so a background tick reads a handful of rows, not the
	 * listener's whole history (the free plan's daily read budget is shared).
	 */
	private memRows(): Map<TrackId, MemoryRow> {
		if (!this.memCache) {
			this.memCache = new Map();
			for (const r of this.db.all<MemoryRow>(`SELECT * FROM memory`)) this.memCache.set(r.id, r);
		}
		return this.memCache;
	}

	private liveLookups = new Map<TrackId, MemoryRow | null>();

	private liveRow(id: TrackId): MemoryRow | null {
		if (this.memCache) return this.memCache.get(id) ?? null;
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
			thumb: 0,
		};
		const next = fn({ ...cur });
		this.db.run(
			`INSERT INTO memory (id, last_played_at, plays, early_skips, last_skipped_at, thumb) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET last_played_at = excluded.last_played_at, plays = excluded.plays,
			   early_skips = excluded.early_skips, last_skipped_at = excluded.last_skipped_at, thumb = excluded.thumb`,
			id,
			next.last_played_at,
			next.plays,
			next.early_skips,
			next.last_skipped_at,
			next.thumb,
		);
		this.memCache?.set(id, next);
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
		return this.db.all<StationRow>(`SELECT * FROM stations ORDER BY sort, id`);
	}

	private stationRow(id: number): StationRow | null {
		return this.db.first<StationRow>(`SELECT * FROM stations WHERE id = ?`, id);
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
		for (const s of this.sourcesOf(st)) {
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
		const sources = this.sourcesOf(st);
		if (sources.length === 0) return false;
		return sources.every((s) => this.sourceImported(sourceKey(s)));
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

	/** Plan a fresh deck from memory and write it into the station's playlist. */
	private async rebuildDeck(client: SpotifyClient, st: StationRow): Promise<Deck> {
		if (!this.stationReady(st))
			throw new HubError("not_ready", "Dieser Sender wird noch eingelesen.");
		const pool = this.stationPool(st);
		if (pool.length === 0)
			throw new HubError("empty", "Dieser Sender hat keine abspielbaren Songs.");
		this.memRows(); // planning reads every song's memory: load it once
		let rules = this.rulesOf(st);
		const banned = this.bans(st.id);
		const discoveries = this.discoveryEntries(st);
		const plan = () =>
			planQueue({
				now: this.now(),
				roundStartedAt: st.round_started_at,
				rules,
				pool,
				memory: (id) => this.memory(id),
				banned,
				discoveries,
				size: DECK_SIZE,
				rng: this.d.rng,
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
		if (result.slots.length === 0) {
			throw new HubError(
				"empty",
				"Alle Songs dieses Senders liefen in den letzten 24 Stunden. Morgen geht es weiter.",
			);
		}
		let playlistId = await this.ensurePlaylist(client, st);
		const uris = result.slots.map((s) => `spotify:track:${s.trackId}`);
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
		const prev = this.deckOf(st);
		if (prev) this.carryPasses(st.id, prev);
		const deck = newDeck(result.slots, (prev?.version ?? 0) + 1, this.now());
		// Rewritten under a paused player: Spotify will continue after the old
		// position, so positions before it must not be read as skips.
		const snap = this.kvGet<PlayerSnapshot>("player");
		if (
			prev &&
			snap?.obs?.contextUri === `spotify:playlist:${playlistId}` &&
			prev.lastIndex !== null
		) {
			deck.lastIndex = prev.lastIndex;
		}
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

	private async stepDeck(client: SpotifyClient, stationId: number): Promise<StepResult> {
		const st = this.stationRow(stationId);
		if (!st) return { done: true };
		if (!this.stationReady(st)) return { done: false, state: { stationId }, delayMs: 30_000 };
		if (this.isListeningTo(st))
			return { done: false, state: { stationId }, delayMs: IDLE_BEFORE_REBUILD_MS };
		try {
			await this.freshenMemory(client);
			await this.rebuildDeck(client, this.stationRow(stationId) ?? st);
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
		this.memRows();
		const inDeck = new Set(deck.items.map((i) => i.id));
		const banned = new Set([...this.bans(st.id), ...inDeck]);
		const res = planQueue({
			now: this.now(),
			roundStartedAt: st.round_started_at,
			rules: this.rulesOf(st),
			pool: this.stationPool(st),
			memory: (id) => this.memory(id),
			banned,
			discoveries: this.discoveryEntries(st),
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

	/** Is the listener in this station's playlist right now (or was, moments ago)? */
	private isListeningTo(st: StationRow): boolean {
		const snap = this.kvGet<PlayerSnapshot>("player");
		const uri = this.deckUri(st);
		if (!uri || !snap?.obs) return false;
		if (snap.obs.contextUri !== uri) return false;
		if (snap.obs.isPlaying) return true;
		const activity = this.kvGet<Record<string, number>>("deck_activity")?.[String(st.id)] ?? 0;
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
		this.kvSet("player", snap);
		this.kvDel("player_stale");
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
		const activity = this.kvGet<Record<string, number>>("deck_activity") ?? {};
		for (const st of this.stations()) {
			let deck = this.deckOf(st);
			const uri = this.deckUri(st);
			if (!deck || !uri) continue;
			let changed = false;
			if (plays.length > 0) {
				const r = applyPlays(deck, plays, uri);
				if (r.played.length > 0 || r.unskipped.length > 0) changed = true;
				deck = r.deck;
				for (const id of r.unskipped) this.undoSkip(id);
			}
			if (obs && obs.contextUri === uri) {
				// Only actual playback counts as activity: a deck paused and left
				// alone must still be refreshed for the next start.
				if (obs.isPlaying) activity[String(st.id)] = this.now();
				const r = observePlayer(deck, obs, uri);
				deck = r.deck;
				changed = true;
				if (obs.isPlaying)
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
					this.bookEarlySkip(st, id, rules, deck.lastObservedAt ?? this.now());
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
		for (const st of this.stations()) {
			if (!st.deck && this.stationReady(st) && !this.jobExists(`deck:${st.id}`)) {
				this.enqueue(`deck:${st.id}`, "deck", { stationId: st.id }, 3);
			}
		}
		this.kvSet("deck_activity", activity);

		// Housekeeping on a slow clock.
		if (this.now() - s.lastPlaylistsAt > 12 * HOUR_MS)
			this.enqueue("playlists", "playlists", {}, 4);
		if (this.kvGet("onboarded") && this.now() - s.lastLikedAt > 3 * DAY_MS) {
			this.enqueue("import:liked", "import", { source: "liked", offset: 0 }, 6);
		}
		this.setSyncState(s);
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
				for (const id of r.unskipped) this.undoSkip(id);
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
		const list = this.kvGet<{ id: TrackId; st: number; at: number }[]>("pending_skips") ?? [];
		for (const it of waiting) list.push({ id: it.id, st: stationId, at: it.at ?? this.now() });
		this.kvSet("pending_skips", list.slice(-500));
	}

	private settleCarried(plays: RecentPlay[]): void {
		const list = this.kvGet<{ id: TrackId; st: number; at: number }[]>("pending_skips");
		if (!list || list.length === 0) return;
		const played = new Set(plays.map((p) => p.trackId));
		const keep: typeof list = [];
		for (const e of list) {
			if (played.has(e.id)) continue; // it was a play after all
			if (this.now() - e.at < SKIP_GRACE_MS) {
				keep.push(e);
				continue;
			}
			const st = this.stationRow(e.st);
			if (st) this.bookEarlySkip(st, e.id, this.rulesOf(st), e.at);
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
		const fresh = items
			.map((i) => ({ i, at: Date.parse(i.played_at) }))
			.filter((x) => Number.isFinite(x.at) && x.at > s.recentCursor && x.i.track?.id)
			.sort((a, b) => a.at - b.at);
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
		for (const { i, at } of fresh) {
			const id = i.track.id!;
			const ctx = i.context?.uri ?? null;
			const ignored = this.inGuest(at);
			const station = ctx ? deckByUri.get(ctx) : undefined;
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
			const before = this.memory(id);
			this.livePlay(id, at);
			this.countRound(id, before, at);
			this.noteDiscoveryHeard(id);
			// Heard somewhere else: every other deck still holding it is stale.
			this.dirtyDecksHolding(id, station?.id ?? null);
		}
		return out;
	}

	/** Keep each station's "fresh remaining" counter honest and start rounds. */
	private countRound(id: TrackId, before: TrackMemory, at: number): void {
		for (const st of this.stations()) {
			if (st.fresh_remaining === null) continue;
			const rules = this.rulesOf(st);
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

	private bookEarlySkip(st: StationRow, id: TrackId, rules: StationRules, at: number): void {
		if (this.inGuest(at)) return;
		const before = this.memory(id);
		this.liveSkip(id, at);
		this.dirtyDecksHolding(id, null);
		if (rules.skipPolicy === "ban") {
			this.db.run(
				`INSERT OR IGNORE INTO bans (station_id, track_id, at) VALUES (?, ?, ?)`,
				st.id,
				id,
				at,
			);
		}
		if (rules.skipPolicy === "consume") this.countRound(id, before, at);
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

	private undoSkip(id: TrackId): void {
		this.updateLive(id, (r) => ({ ...r, early_skips: Math.max(0, r.early_skips - 1) }));
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
		if (!rules.discoveryEnabled) return nextRun;
		if (!this.stationReady(st))
			return { done: false, state: { stationId }, delayMs: 5 * MINUTE_MS };
		const pending = this.db.first<{ n: number }>(
			`SELECT COUNT(*) AS n FROM discoveries WHERE station_id = ? AND status = 'candidate'`,
			stationId,
		)!.n;
		if (pending >= 150 && !state.phase) return nextRun;
		const pool = this.stationPool(st);
		const index = this.trackIndex();
		const known = (id: TrackId) => index.has(id) || this.hasLive(id) || this.hist().has(id);
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
			{ ...state, stationId },
		);
		if (result.done) {
			this.indexCache = null;
			return nextRun;
		}
		return { done: false, state: result.state };
	}

	/** Artists the listener demonstrably likes in this station — discovery seeds. */
	private seedArtists(pool: PoolEntry[]): { id: string; name: string; weight: number }[] {
		const index = this.trackIndex();
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
				this.now() - deck.writtenAt > DECK_MAX_AGE_MS ||
				!fresh.playlist_id;
			if (needsRebuild) deck = await this.rebuildDeck(client, fresh);
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
				deck.lastIndex = null;
				deck.lastObservedAt = null;
				this.saveDeck(fresh.id, deck);
			}
			const activity = this.kvGet<Record<string, number>>("deck_activity") ?? {};
			activity[String(fresh.id)] = this.now();
			this.kvSet("deck_activity", activity);
			this.db.run(`UPDATE stations SET last_played_at = ? WHERE id = ?`, this.now(), fresh.id);
			this.log("info", "play", `„${fresh.name}“ gestartet auf ${target.name}`);
			this.kvSet("player_stale", 1);
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
			// Marked stations will leave the song out next time.
			this.db.run(`UPDATE stations SET deck_dirty = 1`);
			const snap = this.kvGet<PlayerSnapshot>("player");
			if (snap?.obs?.isPlaying && snap.obs.trackId === trackId) await this.playerAction("next");
		}
		if (value === 1) {
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
		if (!Array.isArray(rows) || rows.length > 5000)
			throw new HubError("bad_import", "Ungültiger Import-Block");
		for (const r of rows) {
			if (!Array.isArray(r) || r.length !== 4 || !/^[A-Za-z0-9]{22}$/.test(String(r[0]))) {
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
			const snap = this.kvGet<PlayerSnapshot>("player");
			if (!snap || this.kvGet("player_stale") || this.now() - snap.at > 15_000) {
				const budget = new RequestBudget(8);
				await this.sync(budget);
				await this.ensureAlarm();
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
			history: { importedTracks: hist?.tracks ?? 0, importedAt: hist?.at ?? null },
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
		const t = snap.track ?? this.trackIndex().get(snap.obs.trackId) ?? null;
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

	private describe(id: TrackId): string {
		const t = this.trackIndex().get(id);
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
			}>(`SELECT * FROM playlists WHERE ours = 0 ORDER BY sort`)
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
		const index = this.trackIndex();
		const upcoming: StationDetail["upcoming"] = [];
		if (deck) {
			const from = (deck.lastIndex ?? -1) + 1;
			for (let i = from; i < deck.items.length && upcoming.length < 12; i++) {
				const it = deck.items[i]!;
				if (it.state !== "pending") continue;
				const t = index.get(it.id);
				if (t) upcoming.push({ ...this.view(t), kind: it.kind });
			}
		}
		const recent = this.db
			.all<{ played_at: number; track_id: string; meta: string | null }>(
				`SELECT played_at, track_id, meta FROM plays WHERE station_id = ? AND ignored = 0 ORDER BY played_at DESC LIMIT 15`,
				id,
			)
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
		const index = this.trackIndex();
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

	async alarm(): Promise<void> {
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
		if (snap?.obs?.isPlaying && inDeck) candidates.push(now + 3 * MINUTE_MS);
		else if (snap?.obs?.isPlaying) candidates.push(now + 10 * MINUTE_MS);
		else if (s.idleSince !== null && now - s.idleSince > 6 * HOUR_MS)
			candidates.push(now + 60 * MINUTE_MS);
		else candidates.push(now + 20 * MINUTE_MS);
		let at = Math.min(...candidates);
		if (backoff > now) at = Math.max(at, backoff + 1000);
		await this.d.alarms.set(at);
	}

	async scheduleSoon(ms: number): Promise<void> {
		const at = this.now() + ms;
		const cur = await this.d.alarms.get();
		if (cur === null || cur > at) await this.d.alarms.set(at);
	}

	async ensureAlarm(): Promise<void> {
		if (!this.isConnected()) return;
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
