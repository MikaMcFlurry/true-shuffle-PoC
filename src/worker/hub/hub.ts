/**
 * HubCore — everything true-shuffle knows and does for one listener.
 *
 * Runs inside that listener's Durable Object (single-threaded, so the
 * background sync and a tap in the app never race), and in tests on
 * node:sqlite with the Spotify fake and a fake clock.
 *
 * The reliability model, in one paragraph: a station's order lives in a
 * private Spotify playlist that Spotify plays by itself on any device.
 * true-shuffle never has to be "in the loop" while music plays. It only
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
	DIRECT_MS,
	heldForPlayer,
	inRanges,
	markBooked,
	newDeck,
	observePlayer,
	type PlayerObservation,
	position,
	type RecentPlay,
	remainingAhead,
	SKIP_GRACE_MS,
	settleSkips,
	takeBackQueued,
	toRanges,
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
	RemoteAction,
	SongFacts,
	StationDetail,
	StationKind,
	StationSource,
	StationSummary,
	TrackView,
	Warning,
} from "../../shared/api";
import { type Keys, randomToken } from "../lib/crypto";
import type { SqlDb } from "../lib/sql";
import {
	type Fetcher,
	publicCooldown,
	RequestBudget,
	SPOTIFY_COOLDOWN_SCOPES,
	SpotifyClient,
	type SpotifyCooldown,
	type SpotifyCooldownScope,
	type SpotifyEndpoints,
	SpotifyError,
	type SpotifyRequestMetric,
	type SpotifyTokens,
	type TokenStore,
	validArtistAlbumsProbe,
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
import {
	foregroundObservationDeadline,
	MAX_RECENT_INTERVAL_MS,
	observationDeadline,
	pausedObservationPace,
} from "./observation-policy";
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

/** An early skip booked in memory. */
interface Booking {
	st: number;
	id: TrackId;
	/** When it was seen left: the skip's time in memory, and its ban's. */
	at: number;
	/** The look before, when it was still ahead or playing. */
	from?: number;
	seen: boolean;
}

/** An inferred skip booked with a condition: taken back once that play shows up. */
interface QueuedSkip {
	st: number;
	id: TrackId;
	/** When it was booked as left: the skip's own time in memory. */
	at: number;
	unless: { id: TrackId; from: number; to: number };
}

interface PendingSkip {
	id: TrackId;
	st: number;
	at: number;
	/** When it was first seen playing. */
	since?: number;
	/** Seen playing before it was left (not only inferred between two looks). */
	seen?: boolean;
	/** Not skipped if this play shows up (see `DeckItem.unless`). */
	unless?: { id: TrackId; from: number; to: number };
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
/** The lanes a play may be stamped with (see `laneOf`). */
/** How long a lane note waits for its play: pauses may stretch a play over hours. */
const LANE_NOTE_MS = 2 * DAY_MS;
/**
 * Slack between Spotify's stamp and our clock. Below 30 s, the least a
 * counted play lasts, so a later play of the song never fits a closed note.
 */
const LANE_STAMP_SLACK_MS = 15_000;
const LANES: ReadonlySet<SlotKind> = new Set<SlotKind>(["fresh", "favorite", "discovery"]);
const PLAYS_KEEP_MS = 180 * DAY_MS;
const PRUNE_PER_DAY = 500;

/**
 * How long a player that last played a station may still hold (a loaded
 * order of) its playlist — a car stop, a phone that went quiet, a night.
 * Within it, a rewrite continues the deck instead of replanning, the held
 * station is watched every minute, and its earlier songs are remembered.
 */
const HOLD_WATCH_MS = 36 * HOUR_MS;
const CONTINUE_WITHIN_MS = HOLD_WATCH_MS;

/** A player snapshot older than this cannot vouch that nobody is listening. */
const PLAYER_FRESH_MS = 5 * MINUTE_MS;
/**
 * A start or skip Spotify never confirmed stops holding the saved place after
 * this long: an unanswered command must not freeze the queue until the next
 * start, which then replays from wherever it froze.
 */
const PENDING_EXPIRE_MS = 5 * MINUTE_MS;
/**
 * How long after a play counted from the looks Spotify's listing of the same
 * song is still that play, not a second one.
 */
const SAME_PLAY_SLACK_MS = 10 * MINUTE_MS;
/** How old a look may be to say which song was playing as guest mode went off. */
const GUEST_TAIL_FRESH_MS = 2_000;
/** How long after a guest time its last play is followed. */
const GUEST_FOLLOW_MS = 2 * DAY_MS;
/**
 * After a guest time, listings wait for the first look that shows a song
 * (it tells which play was on the player across the end) — at most this long.
 */
const GUEST_DECIDE_MS = 12 * HOUR_MS;
/** Listings held meanwhile: enough for 12 hours of one-minute songs. */
const GUEST_HELD_MAX = 1000;
/** A remote key answers at most this many commands in ten minutes. */
const REMOTE_LIMIT = 20;
const REMOTE_WINDOW_MS = 10 * MINUTE_MS;
/** Refresh decks that were written longer ago than this (memory drifted). */
export const DECK_MAX_AGE_MS = 20 * HOUR_MS;
/** External requests per invocation (Workers free plan allows 50). */
export const BUDGET_PER_INVOCATION = 40;
/** Discoveries heard once may come back after this long ("probation"). */
export const DISCOVERY_SECOND_CHANCE_MS = 7 * DAY_MS;
/** Guest mode switches itself off after this long unless extended. */
export const GUEST_DEFAULT_HOURS = 6;

export const DECK_NAME_PREFIX = "true-shuffle · ";
/** How the playlists were named before the owner's spelling (until 2026-09-27). */
const LEGACY_DECK_NAME_PREFIX = "True Shuffle · ";
const DECK_DESCRIPTION = (name: string) =>
	`Dein true-shuffle-Sender „${name}“. Einfach abspielen — Shuffle bleibt aus. true-shuffle befüllt diese Playlist automatisch neu.`;
const DISCOVERIES_NAME = `${DECK_NAME_PREFIX}Entdeckungen`;
const DISCOVERIES_DESCRIPTION =
	"Neuentdeckungen, die dir in true-shuffle gefallen haben. Wird automatisch ergänzt.";

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
	sharedSpotify?: {
		getOperationSnapshot?(
			operation: string,
		): Promise<{ revision: number; cooldown: SpotifyCooldown | null }>;
		setOperationCooldown?(cooldown: SpotifyCooldown): Promise<number>;
		finishOperation?(operation: string, revision: number): Promise<void>;
		recordRequest?(metric: SpotifyRequestMetric): Promise<void>;
		getCooldown(scope?: SpotifyCooldownScope): Promise<SpotifyCooldown | null>;
		getSnapshot(
			scope?: SpotifyCooldownScope,
		): Promise<{ revision: number; cooldown: SpotifyCooldown | null }>;
		setCooldown(value: SpotifyCooldown): Promise<number>;
		quarantineLegacyGlobal?(
			expected: SpotifyCooldown,
			revision: number,
		): Promise<{ quarantined: boolean; globalRevision: number; catalogRevision: number }>;
		beginRecheck(scope?: SpotifyCooldownScope): Promise<boolean>;
		finishRecheck(success: boolean, scope?: SpotifyCooldownScope): Promise<void>;
	};
}

export interface SpotifyAvailabilityExperiment {
	testedAt: number;
	cached?: boolean;
	outcomes: Record<
		"devices" | "player" | "history",
		{
			state: "available" | "held" | "failed" | "not_tested";
			status?: number;
			kind?: string;
			reason?: string;
			retryAfter?: string | null;
		}
	>;
	controls: "untested";
	catalog: "held" | "untested";
	stopped: boolean;
	devices?: DeviceView[];
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

/**
 * A private session as looks saw it: from the look before the first that
 * showed it, to the first that no longer did — or, never seen to end, six
 * hours after it was last seen playing (Spotify ends it by then itself).
 */
interface PrivatePeriod {
	from: number;
	to: number | null;
	seen?: number;
}

function privateEnd(p: PrivatePeriod, now: number): number {
	return p.to ?? Math.min(now, (p.seen ?? p.from) + 6 * HOUR_MS);
}

/** The song playing in a private session, and how long looks saw it play. */
interface PrivateSong {
	id: TrackId;
	start: number;
	end: number;
	/** Played between looks: never more than the time that passed. */
	listened: number;
	/** Its position at the latest look, and when that was. */
	progress: number;
	at: number;
	contextUri: string | null;
	track: PackedTrack;
}

/** A play true-shuffle saw end in a private session (Spotify may never list it). */
interface SeenPlay {
	id: TrackId;
	at: number;
	start: number;
	/** Listings from then on are this play (default: a minute before its start). */
	after?: number;
	end: number;
	contextUri: string | null;
	track: PackedTrack;
	/**
	 * Still on the player when counted, its rest unplayed (default: by its
	 * duration). Only such a play may be listed minutes later — after a pause.
	 */
	open?: boolean;
}

/**
 * A play counted from the looks; Spotify's listing of it is not a second play.
 * Up to `to` any listing of the song is it (the original window). Up to
 * `until` only a listing in the same context, before any other song was heard
 * and before Spotify listed it at all: a pause can delay the end of a play
 * that was still on, never that of one that was over. Entries written before
 * `until` existed have the original window only.
 */
interface SeenEntry {
	id: TrackId;
	from: number;
	to: number;
	at?: number;
	ctx?: string | null;
	until?: number;
	listed?: boolean;
}

/** A song seen starting on a station, with its lane (see `noteLane`). */
interface LaneNote {
	station: number;
	id: TrackId;
	kind: SlotKind | null;
	seenAt: number;
	/** The first look that no longer showed this play. */
	goneAt?: number;
}

interface PlayerSnapshot {
	obs: PlayerObservation | null;
	track: PackedTrack | null;
	device: { id: string | null; name: string; restricted: boolean } | null;
	repeat?: SpPlaybackState["repeat_state"];
	at: number;
}

/**
 * The play the player shows, as looks saw it: how much of it they saw play —
 * how far it moved between looks, never more than the time between.
 */
interface HeardSong {
	id: TrackId;
	/** When it began: the first look that saw it, less its position. */
	start: number;
	listened: number;
	/** Its position at the latest look, and when that was. */
	progress: number;
	at: number;
	playing: boolean;
	durationMs: number;
	contextUri?: string | null;
	/** What to write if it counts from a note, whatever the player shows by then. */
	track?: PackedTrack | null;
	/** Over, seen playing, and the next song began right at its end. */
	ranOut?: true;
}

/**
 * The one play on the player when the guest time ended (running or paused):
 * the guest's, unless looks saw the owner play 30 s or more of it after.
 */
interface GuestLast {
	id: TrackId;
	start: number;
	/** Listened (HeardSong) that may still have been the guest's. */
	guest: number;
	/** Listened since: the owner's. */
	owner: number;
	/** The first look that no longer showed it (null: still on the player). */
	over: number | null;
	/** Its listing came: a later one is another play. */
	listed?: true;
	/** Looks saw it on the player across the end: no other play can be the guest's. */
	only?: true;
	/**
	 * Not seen across the end: plays may lie unseen between it and the first
	 * one seen after the end (`next`, begun at `gapTo`) — the guest's.
	 */
	gapTo?: number;
	next?: TrackId;
	/**
	 * `next` itself may be the guest's play, paused across the end and played
	 * on: when it began, what the look that first saw it showed (the guest's),
	 * what later looks saw play (the owner's), and when it was over.
	 */
	nextStart?: number;
	nextGuest?: number;
	nextOwner?: number;
	nextOver?: number | null;
	/** The play across the end is known among them (listed): the rest are the owner's. */
	gapTaken?: true;
}

interface GuestPeriod {
	/**
	 * The song seen playing when guest mode went off by hand (null: nothing
	 * played). Its play, ending later, is still the guest's.
	 */
	tail?: TrackId | null;
	/** The play across its end, once a look after it saw the player (null: none). */
	last?: GuestLast | null;
	/**
	 * No look showed a song after the end before the listings stopped waiting:
	 * the first one listed after the end has been taken as the guest's.
	 */
	firstTaken?: true;
	from: number;
	to: number;
}

/**
 * A song a start from the app replaced, which looks saw play 30 s or more:
 * counted from Spotify's listing, or from this note if none comes within
 * the grace. One per play.
 */
interface ShownPending {
	id: TrackId;
	/** Left for a start from the app, for another context in Spotify, or by a skip. */
	by?: "app" | "start" | "leave";
	/** The last look that saw it unfinished (left after that). */
	seen?: number;
	/** When the play began, and when the start replaced it. */
	start: number;
	at: number;
	durationMs: number;
	contextUri: string | null;
	track: PackedTrack;
	until: number;
}

/** The personal remote key: its id, and its recent commands for the rate limit. */
interface RemoteKey {
	kid: string;
	createdAt: number;
	usedAt: number | null;
	uses: number[];
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
	/** The last look at the newest Spotify hearts (while music plays). */
	lastLikedPeekAt?: number;
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

export interface SavedSession {
	sessionId: string;
	stationId: number;
	orderRevision: number;
	entryIds: string[];
	currentIndex: number;
	progressMs: number | null;
	observedAt: number | null;
	playbackEpoch: number;
	contextUri: string;
	status: "active" | "paused" | "disconnected" | "external" | "ambiguous" | "saved";
	sequence?: number;
	controller?: "native" | "spotify";
	pending: {
		operationId: string;
		kind: "resume" | "publish" | "next";
		deviceId?: string | null;
		phase?: "prepared" | "submitted";
		startedAt?: number;
	} | null;
}

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
	/** Reject observations that began before a transport command changed the player. */
	private transportRevision = 0;

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
		const s: SyncState = {
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
		s.lastPlayerAt = this.kvGet<number>("player_checked_at") ?? s.lastPlayerAt;
		s.lastRecentAt = this.kvGet<number>("history_checked_at") ?? s.lastRecentAt;
		return s;
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

	private client(
		budget: RequestBudget,
		singleTransport = false,
		allowUnknownRetry = true,
	): SpotifyClient {
		return new SpotifyClient({
			singleTransport,
			allowUnknownRetry,
			endpoints: this.d.env.endpoints,
			tokens: this.tokenStore(),
			budget,
			fetch: this.d.fetch,
			now: () => this.now(),
			policy: {
				getCooldown: () => null,
				setCooldown: () => {},
				getOperationSnapshot: (operation) => this.operationSnapshot(operation),
				setOperationCooldown: async (cooldown) => {
					if (
						cooldown.operation === "GET /artists/:id/albums" &&
						validArtistAlbumsProbe(cooldown.probePath)
					)
						this.kvSet("spotify_artist_probe_source", cooldown.probePath);
					const revision = await this.d.sharedSpotify?.setOperationCooldown?.(cooldown);
					const states = this.operationStates();
					states[cooldown.operation!] = {
						revision: revision ?? (states[cooldown.operation!]?.revision ?? 0) + 1,
						cooldown,
					};
					this.kvSet("spotify_operation_cooldowns", states);
				},
				finishOperation: async (operation, revision) => {
					await this.d.sharedSpotify?.finishOperation?.(operation, revision);
					if (this.d.sharedSpotify?.getOperationSnapshot) {
						const snapshot = await this.operationSnapshot(operation);
						if (!snapshot.cooldown) this.resumeOperationJobs(operation);
					} else {
						const states = this.operationStates();
						if (states[operation]?.revision === revision) {
							states[operation] = { revision: revision + 1, cooldown: null };
							this.kvSet("spotify_operation_cooldowns", states);
							this.resumeOperationJobs(operation);
						}
					}
				},
				record: (metric) => this.recordSpotifyRequest(metric),
			},
		});
	}

	private activateOperationPolicy(): void {
		if (this.kvGet("spotify_operation_policy") === 2) return;
		const legacy: Record<string, unknown> = {};
		for (const key of [
			"spotify_cooldown",
			"backoff",
			...SPOTIFY_COOLDOWN_SCOPES.map((scope) => this.cooldownKey(scope)),
		]) {
			const value = this.kvGet(key);
			if (value !== null) legacy[key] = value;
			this.kvDel(key);
			this.kvDel(`${key}_revision`);
		}
		// Old guard errors have no confirmed provider response for this job's operation.
		// Admit those jobs once under the new policy; genuine provider failures keep their schedule.
		this.db.run(
			"UPDATE jobs SET run_after=MIN(run_after,?),error=NULL,updated_at=? WHERE error=?",
			this.now(),
			this.now(),
			"Spotify wartet auf die Freigabe weiterer Anfragen",
		);
		this.kvSet("spotify_operation_policy_backup", { at: this.now(), legacy });
		this.kvDel("spotify_availability_experiment");
		this.kvSet("spotify_operation_policy", 2);
	}
	private operationStates(): Record<
		string,
		{ revision: number; cooldown: SpotifyCooldown | null }
	> {
		this.activateOperationPolicy();
		return this.kvGet("spotify_operation_cooldowns") ?? {};
	}
	private resumeOperationJobs(operation: string): void {
		const paused = this.kvGet<Record<string, string>>("spotify_unknown_jobs") ?? {};
		let changed = false;
		for (const [key, blocked] of Object.entries(paused))
			if (blocked === operation) {
				this.db.run("UPDATE jobs SET run_after=? WHERE key=?", this.now(), key);
				delete paused[key];
				changed = true;
			}
		if (changed) this.kvSet("spotify_unknown_jobs", paused);
	}
	private async operationSnapshot(
		operation: string,
	): Promise<{ revision: number; cooldown: SpotifyCooldown | null }> {
		const states = this.operationStates();
		const shared = await this.d.sharedSpotify?.getOperationSnapshot?.(operation);
		if (shared) {
			const previous = states[operation];
			if (JSON.stringify(states[operation]) !== JSON.stringify(shared)) {
				states[operation] = shared;
				this.kvSet("spotify_operation_cooldowns", states);
				if (previous?.cooldown && !shared.cooldown && shared.revision > previous.revision)
					this.resumeOperationJobs(operation);
			}
			return shared;
		}
		return states[operation] ?? { revision: 0, cooldown: null };
	}

	private cooldownKey(scope?: SpotifyCooldownScope): string {
		return scope ? `spotify_${scope.replaceAll("-", "_")}_cooldown` : "spotify_cooldown";
	}

	private async reconcileSharedCooldown(_scope?: SpotifyCooldownScope): Promise<void> {
		this.activateOperationPolicy();
	}

	private providerCooldown(_scope?: SpotifyCooldownScope): SpotifyCooldown | null {
		return null;
	}

	/** Explicit owner recheck for an unknown provider reset; known deadlines stay enforced. */
	async retryQuota(
		requestedScope?: Exclude<SpotifyCooldownScope, "legacy-catalog">,
	): Promise<void> {
		this.activateOperationPolicy();
		const family = requestedScope ?? "player";
		const path = {
			devices: "/me/player/devices",
			player: "/me/player",
			history: "/me/player/recently-played",
			"artist-albums": "/artists/:id/albums",
		}[family];
		let target = path;
		if (family === "artist-albums") {
			const saved = (await this.operationSnapshot(`GET ${path}`)).cooldown;
			const source = saved?.probePath ?? this.kvGet<string>("spotify_artist_probe_source");
			if (!validArtistAlbumsProbe(source))
				throw new HubError("quota", "Die Quelle der Künstleralben-Abfrage fehlt.", 409);
			target = source;
		}
		await this.client(new RequestBudget(2), true).request("GET", target, { query: { limit: 1 } });
	}

	private availabilityFlight: Promise<SpotifyAvailabilityExperiment> | null = null;
	testSpotifyAvailability(): Promise<SpotifyAvailabilityExperiment> {
		if (this.availabilityFlight) return this.availabilityFlight;
		const task = this.performAvailabilityTest();
		this.availabilityFlight = task;
		void task
			.finally(() => {
				this.availabilityFlight = null;
			})
			.catch(() => undefined);
		return task;
	}
	private async performAvailabilityTest(): Promise<SpotifyAvailabilityExperiment> {
		this.activateOperationPolicy();
		const previous = this.kvGet<SpotifyAvailabilityExperiment>("spotify_availability_experiment");
		if (previous && this.now() - previous.testedAt >= 0 && this.now() - previous.testedAt < 60000) {
			const cached = { ...previous, cached: true, outcomes: { ...previous.outcomes } };
			for (const family of ["devices", "player", "history"] as const) {
				const endpoint = {
					devices: "/me/player/devices",
					player: "/me/player",
					history: "/me/player/recently-played",
				}[family];
				const hold = (await this.operationSnapshot(`GET ${endpoint}`)).cooldown;
				if (hold?.until !== null && (hold?.until ?? 0) > this.now())
					cached.outcomes[family] = {
						state: "held",
						status: 429,
						kind: hold!.kind,
						reason: hold!.reason,
						retryAfter: hold!.retryAfter,
					};
			}
			return cached;
		}
		const result: SpotifyAvailabilityExperiment = {
			testedAt: this.now(),
			outcomes: {
				devices: { state: "not_tested" },
				player: { state: "not_tested" },
				history: { state: "not_tested" },
			},
			controls: "untested",
			catalog: "untested",
			stopped: false,
		};
		const client = this.client(new RequestBudget(4), true);
		for (const family of ["devices", "player", "history"] as const) {
			try {
				if (family === "devices") {
					const devices = await client.devices();
					result.devices = devices
						.filter((d) => d.id)
						.map((d) => ({
							id: d.id!,
							name: d.name,
							type: d.type,
							active: d.is_active,
							restricted: d.is_restricted,
						}));
				} else if (family === "player") await client.player();
				else await client.request("GET", "/me/player/recently-played", { query: { limit: 1 } });
				result.outcomes[family] = {
					state: "available",
					status:
						this.kvGet<{ latest: SpotifyRequestMetric }>("spotify_request_metrics")?.latest
							.status ?? 200,
				};
			} catch (e) {
				if (!(e instanceof SpotifyError)) throw e;
				result.outcomes[family] = {
					state: e.status === 429 ? "held" : "failed",
					status: e.status,
					kind: e.kind,
					reason: e.reason,
					retryAfter: e.retryAfter,
				};
				if ((e.kind !== "rate" && e.kind !== "quota") || e.operation === "POST /api/token") {
					result.stopped = true;
					break;
				}
			}
		}
		const { devices: _devices, ...saved } = result;
		this.kvSet("spotify_availability_experiment", saved);
		return result;
	}

	async spotifyDiagnostics(): Promise<unknown> {
		const states = this.operationStates();
		for (const operation of Object.keys(states)) await this.operationSnapshot(operation);
		const current = this.operationStates();
		return {
			policyVersion: 2,
			operationCooldowns: Object.values(current).flatMap((s) =>
				s.cooldown ? [publicCooldown(s.cooldown)] : [],
			),
			cooldown: null,
			artistAlbumsCooldown: null,
			devicesCooldown: null,
			playerCooldown: null,
			historyCooldown: null,
			catalogQuarantine: null,
			availability: this.kvGet("spotify_availability_experiment"),
			requests: this.kvGet("spotify_request_metrics"),
			recentRequests: this.kvGet("spotify_recent_requests"),
		};
	}

	/** Bounded, account-owned aggregates: no URLs, IDs, tokens or listener history. */
	private async recordSpotifyRequest(metric: SpotifyRequestMetric): Promise<void> {
		const hour = Math.floor(metric.at / HOUR_MS);
		const previous = this.kvGet<{
			hour: number;
			counts: Record<string, number>;
			latest: SpotifyRequestMetric;
		}>("spotify_request_metrics");
		const counts = previous?.hour === hour ? previous.counts : {};
		const key = `${metric.category}:${metric.endpoint}:${metric.status}:${metric.retryCategory}`;
		counts[key] = (counts[key] ?? 0) + 1;
		this.kvSet("spotify_request_metrics", { hour, counts, latest: metric });
		type Hour = {
			hour: number;
			counts: Record<string, number>;
			firstQuotaAt?: number;
			firstQuotaEndpoint?: string;
			firstQuotaReason?: string;
		};
		const recent = this.kvGet<{ startedAt: number; hours: Hour[] }>("spotify_recent_requests") ?? {
			startedAt: metric.at,
			hours: [],
		};
		recent.hours = recent.hours.filter((h) => h.hour >= hour - 23 && h.hour <= hour);
		let bucket = recent.hours.find((h) => h.hour === hour);
		if (!bucket) {
			bucket = { hour, counts: {} };
			recent.hours.push(bucket);
		}
		bucket.counts[key] = (bucket.counts[key] ?? 0) + 1;
		if (metric.retryCategory === "quota" && bucket.firstQuotaAt === undefined) {
			bucket.firstQuotaAt = metric.at;
			bucket.firstQuotaEndpoint = metric.endpoint;
			bucket.firstQuotaReason = metric.reason;
		}
		this.kvSet("spotify_recent_requests", recent);
		await this.d.sharedSpotify?.recordRequest?.(metric);
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
		// A key made with a session goes with it: signing out ends every way in.
		this.kvDel("remote_key");
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
		const client = this.client(budget, false, false);
		for (let guard = 0; guard < 50; guard++) {
			await this.reconcileSharedCooldown();
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
				if (err.retryAfter === null && err.operation) {
					const paused = this.kvGet<Record<string, string>>("spotify_unknown_jobs") ?? {};
					paused[job.key] = err.operation;
					this.kvSet("spotify_unknown_jobs", paused);
				}
				this.db.run(
					"UPDATE jobs SET run_after=?,error=? WHERE key=?",
					err.retryAfter === null
						? Number.MAX_SAFE_INTEGER
						: this.now() + Math.max(1000, err.retryAfterMs),
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
		this.activateOperationPolicy();
		return 0;
	}
	private setBackoff(_ms: number, _kind: string): void {
		this.activateOperationPolicy();
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
				return this.stepExtend(client, Number(state.stationId), budget);
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
					await client
						.updatePlaylistDetails(
							st.playlist_id,
							DECK_NAME_PREFIX + st.name,
							DECK_DESCRIPTION(st.name),
						)
						.catch((e) => {
							if (!(e instanceof SpotifyError && e.kind === "not_found")) throw e;
						});
				}
				return { done: true };
			}
			case "rename-discoveries": {
				const pid = this.kvGet<string>("discoveries_playlist");
				if (pid) {
					await client
						.updatePlaylistDetails(pid, DISCOVERIES_NAME, DISCOVERIES_DESCRIPTION)
						.catch((e) => {
							if (!(e instanceof SpotifyError && e.kind === "not_found")) throw e;
						});
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
					ours.has(p.id) ||
					(p.owner?.id === profile?.id &&
						(p.name.startsWith(DECK_NAME_PREFIX) || p.name.startsWith(LEGACY_DECK_NAME_PREFIX)));
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
		const startedAt = state.startedAt ?? this.now();
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
						this.finishImport(source, snapshot, count, skipped, 0, startedAt);
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
				this.finishImport(source, snapshot, count, skipped, pageNo + 1, startedAt);
				return { done: true };
			}
			state.total = total;
		}
		return {
			done: false,
			state: { source, offset, skipped, count, snapshot, total: state.total, startedAt },
		};
	}

	private finishImport(
		source: string,
		snapshot: string | null,
		count: number,
		skipped: number,
		pages: number,
		startedAt?: number,
	): void {
		this.db.run(`DELETE FROM pages WHERE source = ? AND page >= ?`, source, pages);
		if (source === "liked") {
			this.kvSet("liked_import", { at: this.now(), count });
			const s = this.syncState();
			s.lastLikedAt = this.now();
			this.setSyncState(s);
			// The full list has the hearts seen before it started; one seen while it
			// ran may be on a page it had already read, so that one stays.
			const rest = this.likedRecent().filter((r) => r.at >= (startedAt ?? this.now()));
			if (rest.length > 0) this.kvSet("liked_recent", rest);
			else this.kvDel("liked_recent");
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
		if (!this.likedCache)
			this.likedCache = new Set([
				...this.loadSource("liked").map((t) => t[0]),
				...this.likedRecent().map((r) => r.id),
			]);
		return this.likedCache;
	}

	/** Hearts seen since the last full import (older entries were bare ids). */
	private likedRecent(): { id: TrackId; at: number }[] {
		return (this.kvGet<(TrackId | { id: TrackId; at: number })[]>("liked_recent") ?? []).map((r) =>
			typeof r === "string" ? { id: r, at: 0 } : r,
		);
	}

	/**
	 * A heart set in Spotify — on the phone, in CarPlay or Android Auto, on a
	 * watch — makes a favourite within minutes: while music plays, the newest
	 * hearts are read every 10 minutes (one request).
	 */
	private async peekLiked(client: SpotifyClient, s: SyncState): Promise<void> {
		if (!this.kvGet("liked_import") || this.now() - (s.lastLikedPeekAt ?? 0) < 10 * MINUTE_MS)
			return;
		s.lastLikedPeekAt = this.now();
		const page = await client.likedTracks(0);
		const known = this.liked();
		// The same songs the full import takes: no local files, nothing greyed out.
		const fresh = (page?.items ?? []).filter(
			(i) => packTrack(i.track) !== null && !known.has(i.track.id!),
		);
		if (fresh.length === 0) return;
		const recent = this.likedRecent();
		this.kvSet(
			"liked_recent",
			[...recent, ...fresh.map((i) => ({ id: i.track.id!, at: this.now() }))].slice(-500),
		);
		this.likedCache = null;
		for (const i of fresh.slice(0, 5))
			this.log(
				"info",
				"liked",
				`Herz in Spotify: „${i.track.name}“ — ${(i.track.artists ?? []).map((a) => a.name).join(", ")} ist jetzt Favorit`,
			);
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
		const row = this.stationRow(stationId);
		if (row && this.deckOf(row)?.writtenAt !== deck.writtenAt) this.closeLaneNotes(stationId);
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
		this.heardOnStation.delete(id);
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
	 * `start`: true-shuffle starts it at the top, so it plans afresh.
	 * `background`: nobody asked to start it. If a player may still hold the
	 * previous version (it was in use lately), the new one continues it — see
	 * `continueLayout`: whatever the player resumes, it meets nothing it just
	 * heard. `null`: the held version cannot be improved and stays as it is.
	 */
	private async rebuildDeck(
		client: SpotifyClient,
		st: StationRow,
		mode?: "start",
		avoid?: TrackId | null,
	): Promise<Deck>;
	private async rebuildDeck(
		client: SpotifyClient,
		st: StationRow,
		mode: "background",
	): Promise<Deck | null>;
	private async rebuildDeck(
		client: SpotifyClient,
		st: StationRow,
		mode: "start" | "background" = "start",
		avoid: TrackId | null = null,
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
		if (mode === "background" && prev && this.savedSession(st.id)) return prev;
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
		// A fresh plan written in the background leaves out the song the player
		// was last seen on and those taken out before: it may still hold them.
		// Started from the app: the song the player shows, heard 30 s or more, is
		// heard — whether or when Spotify lists it.
		const exclude =
			continuing && prev
				? heldForPlayer(prev)
				: new Set([
						...(prev?.items ?? []).filter((it) => it.state === "passed").map((it) => it.id),
						...(mode === "background" && prev
							? [...(prev.leftOut ?? []), ...(prev.lastTrackId ? [prev.lastTrackId] : [])]
							: []),
						...(avoid ? [avoid] : []),
					]);
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
		let layout: PlannedSlot[];
		let keptFrom = 0;
		let keptTo = 0;
		if (continuing && prev && held !== null) {
			const cont = continueLayout({
				items: prev.items,
				held,
				fresh: result.slots,
				playable,
				blocked: (id) => isBlocked(this.memory(id), banned),
			});
			// Nothing better than what the player holds: leave it as it is.
			if (!cont) return null;
			layout = cont.layout;
			keptFrom = cont.keptFrom;
			keptTo = cont.keptTo;
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
		const savedIntent = this.kvGet<{ layout: PlannedSlot[]; version: number; writtenAt: number }>(
			`deck_intent:${st.id}`,
		);
		if (savedIntent) layout = savedIntent.layout;
		const intent = savedIntent ?? {
			layout,
			version: (prev?.version ?? 0) + 1,
			writtenAt: this.now(),
		};
		let playlistId = await this.ensurePlaylist(client, st);
		this.kvSet(`deck_intent:${st.id}`, intent);
		const draft = newDeck(intent.layout, intent.version, intent.writtenAt);
		this.saveDeck(st.id, draft);
		st.deck = JSON.stringify(draft);
		if (mode === "start") {
			const publishing = this.createSession(st, draft);
			publishing.pending = { operationId: crypto.randomUUID(), kind: "publish" };
			this.saveSession(publishing);
		}
		const intendedUris = intent.layout.map((slot) => `spotify:track:${slot.trackId}`);
		try {
			await client.replaceItems(playlistId, intendedUris.slice(0, 100));
		} catch (err) {
			if (err instanceof SpotifyError && (err.kind === "not_found" || err.kind === "forbidden")) {
				// The listener deleted the playlist in Spotify — make a new one.
				this.db.run(`UPDATE stations SET playlist_id = NULL WHERE id = ?`, st.id);
				st.playlist_id = null;
				playlistId = await this.ensurePlaylist(client, st);
				await client.replaceItems(playlistId, intendedUris.slice(0, 100));
			} else {
				throw err;
			}
		}
		for (let i = 100; i < intendedUris.length; i += 100) {
			await client.addItems(playlistId, intendedUris.slice(i, i + 100));
		}
		if (prev) this.carryPasses(st.id, prev);
		const deck = newDeck(layout, intent.version, intent.writtenAt);
		// Positions stay trustworthy only through a continuation of an order we
		// trusted. A fresh plan nobody started is not ours until true-shuffle
		// starts it: a player may still carry on with what it had loaded.
		deck.continued = continuing;
		deck.ours = continuing && prev?.ours === true;
		// The held place is the one just before the kept songs — also when too
		// few songs were left to keep them exactly where they were.
		deck.heldAt = continuing && held !== null ? keptFrom - 1 : null;
		deck.keptTo = continuing && held !== null ? keptTo : null;
		// A player that strayed may still be in that older order.
		if (continuing && prev?.strayedUntil !== undefined && prev.strayedUntil > this.now())
			deck.strayedUntil = prev.strayedUntil;
		if (continuing) {
			let heardUntil = 0;
			for (const s of layout.slice(0, keptFrom)) {
				const last = this.memory(s.trackId).lastPlayedAt;
				if (last !== null) heardUntil = Math.max(heardUntil, last + RECENT_GUARD_MS);
			}
			if (heardUntil > this.now()) deck.frontHeardUntil = heardUntil;
		}
		const inLayout = new Map(layout.map((s, i) => [s.trackId, i]));
		if (continuing && prev && held !== null) {
			// Where a player still in the previous version meets a song this one
			// dropped (heard since, turned down, banned): the place after the song
			// before it, as this version numbers it.
			const marks = new Set<number>();
			for (let u = held + 1; u < prev.items.length && marks.size < 50; u++) {
				if (playable(prev.items[u]!.id)) continue;
				let k = u - 1;
				while (k > held && !inLayout.has(prev.items[k]!.id)) k--;
				marks.add((k > held ? inLayout.get(prev.items[k]!.id)! : held) + 1);
			}
			// A player in a still older order meets something else also where the
			// previous version differed from its own predecessor: at its changed
			// places and after the songs it kept, wherever those songs sit now.
			// A place of the previous version as this one numbers it: where its
			// song sits among the kept ones, or — taken out — right after the last
			// song before it that is still kept.
			const here = (c: number) => {
				if (c <= held) return undefined;
				for (let u = c; u > held; u--) {
					const id = prev.items[u]?.id;
					const k = id === undefined ? undefined : inLayout.get(id);
					if (k !== undefined && k >= keptFrom) return u === c ? k : k + 1;
				}
				return keptFrom;
			};
			const prevEnds = [...(prev.endsAt ?? [])];
			if (prev.continued && prev.keptTo != null) prevEnds.push(prev.keptTo + 1);
			const ends = new Set<number>();
			for (const e of prevEnds) {
				const k = here(e);
				if (k !== undefined) ends.add(k);
			}
			for (const c of prev.changedAt ?? []) {
				const k = here(c);
				if (k !== undefined) marks.add(k);
			}
			for (const k of ends) marks.add(k);
			deck.changedAt = [...marks].slice(0, 50);
			deck.endsAt = [...ends].slice(0, 20);
			deck.leftOut = [...(prev.leftOut ?? []), prev.items[held]!.id].slice(-20);
			// Songs no player in an older order can still come to — only one in
			// this order reaches them. An older order goes on from where it was:
			// the previous version after the held place, and whatever it did not
			// count as new itself; songs that left the playlist lately too.
			// Where an older order is: the held place, or before it, where the
			// player last went on in order (a song from the queue, far down, is
			// no place in that order).
			const at = Math.max(0, Math.min(held, prev.orderAt ?? held));
			const older = new Set<TrackId>(prev.items.slice(at).map((it) => it.id));
			if (prev.continued)
				prev.items.forEach((it, i) => {
					if (!inRanges(prev.newAt, i)) older.add(it.id);
				});
			for (const [id, until] of prev.former ?? []) if (until > this.now()) older.add(id);
			for (const id of prev.leftOut ?? []) older.add(id);
			deck.newAt = toRanges(layout.map((sl) => !older.has(sl.trackId)));
			// Where the next song follows the same one in the previous version,
			// and there in every older one: steps across agree in every order.
			const prevAt = new Map(prev.items.map((it, j) => [it.id, j]));
			deck.sharedAt = toRanges(
				layout.map((sl, i) => {
					const j = prevAt.get(sl.trackId);
					return (
						j !== undefined &&
						i + 1 < layout.length &&
						prev.items[j + 1]?.id === layout[i + 1]!.trackId &&
						(!prev.continued || inRanges(prev.sharedAt, j))
					);
				}),
			);
		}
		// Songs a player may still have loaded from earlier versions: each one
		// for 36 h after it left the playlist, then forgotten.
		// Only what a player could have loaded counts: a version it was seen in
		// or true-shuffle started, or what a continuation kept of one; not a
		// background plan nobody played.
		if (prev) {
			const former = new Map<TrackId, number>();
			for (const [id, until] of prev.former ?? []) if (until > this.now()) former.set(id, until);
			const loadable =
				prev.lastIndex != null || prev.ours === true
					? 0
					: prev.continued && prev.heldAt != null
						? prev.heldAt + 1
						: prev.items.length;
			for (const it of prev.items.slice(loadable)) former.set(it.id, this.now() + HOLD_WATCH_MS);
			for (const id of inLayout.keys()) former.delete(id);
			deck.former = [...former].sort((a, b) => b[1] - a[1]).slice(0, 2000);
			// Turned down or banned, and still ahead of where the player was: it
			// may yet come up in that older order.
			const ahead = new Set(
				prev.items.slice(Math.max(loadable, (position(prev) ?? -1) + 1)).map((it) => it.id),
			);
			const still = new Set(deck.former.map(([id]) => id));
			deck.formerOff = [
				...new Set([
					...(prev.formerOff ?? []).filter((id) => still.has(id)),
					...deck.former
						.filter(([id]) => ahead.has(id) && isBlocked(this.memory(id), banned))
						.map(([id]) => id),
				]),
			];
		}
		// A new deck: notes of songs not playing now came from the deck before.
		this.closeLaneNotes(st.id);
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
		this.kvDel(`deck_intent:${st.id}`);
		return deck;
	}

	private async stepDeck(
		client: SpotifyClient,
		budget: RequestBudget,
		stationId: number,
	): Promise<StepResult> {
		const st = this.stationRow(stationId);
		if (this.savedSession(stationId)) return { done: true };
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
	private async stepExtend(
		client: SpotifyClient,
		stationId: number,
		budget: RequestBudget = new RequestBudget(8),
	): Promise<StepResult> {
		// A maintenance alarm no longer guarantees a preceding player/history read.
		// Capture a real current occurrence before planning or trimming its prefix.
		if (!this.playerFresh(1000)) {
			await this.sync(budget, { playerOnly: true });
			if (!this.playerFresh(1000)) return { done: false, state: { stationId }, delayMs: MINUTE_MS };
		}
		try {
			await this.freshenMemory(client);
		} catch (err) {
			// A confirmed history-only wait leaves fresh player observations and
			// playlist writes available. Preserve the old best-known-memory refill.
			if (
				!(err instanceof SpotifyError) ||
				err.operation !== "GET /me/player/recently-played" ||
				err.status !== 429 ||
				!this.operationStates()[err.operation]?.cooldown
			)
				throw err;
			this.handleSyncError(err);
			this.kvSet("history_due", 1);
			if (this.kvGet("history_due_at") === null) this.kvSet("history_due_at", this.now());
		}
		const st = this.stationRow(stationId);
		const deck = st ? this.deckOf(st) : null;
		if (!st || !deck || !st.playlist_id) return { done: true };
		const session = this.savedSession(stationId);
		const from = session?.currentIndex ?? position(deck) ?? 0;
		if (deck.items.length - from - 1 >= EXTEND_BELOW) return { done: true };
		const intentKey = `extend_intent:${stationId}`;
		let intent = this.kvGet<{ items: Deck["items"]; entryIds: string[]; trim: number }>(intentKey);
		if (!intent) {
			const held = new Set(deck.items.slice(session ? from : 0).map((it) => it.id));
			const pool = this.stationPool(st);
			const discoveries = this.discoveryEntries(st);
			this.preloadMemory([...pool.map((e) => e.id), ...discoveries.map((d) => d.id)]);
			const input = {
				now: this.now(),
				roundStartedAt: st.round_started_at,
				rules: this.rulesOf(st),
				pool,
				memory: (id: TrackId) => this.memory(id),
				banned: new Set([...this.bans(st.id), ...held]),
				discoveries,
				size: 100,
				rng: this.d.rng,
			};
			let res = planQueue(input);
			if (res.slots.length === 0 && session) {
				// Reserve the next round; history alone advances the completed round counter.
				res = planQueue({ ...input, roundStartedAt: this.now() + 1 });
			}
			if (!res.slots.length) return { done: true };
			const repeatsCompleted = res.slots.some((slot) =>
				deck.items.slice(0, from).some((it) => it.id === slot.trackId),
			);
			const trim = session && (deck.items.length > 800 || repeatsCompleted) ? from : 0;
			const items = [
				...deck.items.slice(trim),
				...res.slots.map((slot) => ({
					id: slot.trackId,
					kind: slot.kind,
					state: "pending" as const,
					at: null,
				})),
			];
			const entryIds = [
				...(session?.entryIds.slice(trim) ?? []),
				...res.slots.map(() => crypto.randomUUID()),
			];
			intent = { items, entryIds, trim };
			this.kvSet(intentKey, intent);
		}
		// Restart a complete replacement on retry. POST append alone cannot be retried safely.
		const uris = intent.items.map((it) => `spotify:track:${it.id}`);
		if (client.requestsLeft < Math.ceil(uris.length / 100) + (intent.trim > 0 ? 2 : 0))
			return { done: false, state: { stationId }, delayMs: MINUTE_MS };
		if (session && intent.trim > 0 && !session.pending) {
			session.currentIndex = 0;
			session.entryIds = intent.entryIds;
			session.pending = { operationId: crypto.randomUUID(), kind: "publish" };
			this.saveSession(session);
			deck.items = intent.items;
			deck.lastIndex = 0;
			deck.lastTrackId = deck.items[0]?.id ?? null;
			deck.version += 1;
			this.saveDeck(stationId, deck);
			this.kvSet(`deck_intent:${stationId}`, {
				layout: intent.items.map((it) => ({ trackId: it.id, kind: it.kind })),
				version: deck.version,
				writtenAt: deck.writtenAt,
			});
		}
		await client.replaceItems(st.playlist_id, uris.slice(0, 100));
		for (let i = 100; i < uris.length; i += 100)
			await client.addItems(st.playlist_id, uris.slice(i, i + 100));
		deck.items = intent.items;
		this.saveDeck(stationId, deck);
		if (session) {
			session.entryIds = intent.entryIds;
			if (intent.trim > 0) {
				const observed = toObservation(await client.player(), this.now());
				if (
					observed?.contextUri === session.contextUri &&
					observed.isPlaying &&
					observed.trackId === deck.items[0]?.id
				) {
					session.progressMs = observed.progressMs;
					session.observedAt = observed.at;
					await client.play({
						contextUri: session.contextUri,
						position: 0,
						progressMs: session.progressMs ?? 0,
					});
					session.pending = null;
					session.playbackEpoch += 1;
				}
				session.pending = null;
				this.kvDel(`deck_intent:${stationId}`);
			}
			session.orderRevision += 1;
			this.saveSession(session);
		}
		this.kvDel(intentKey);
		return { done: true };
	}

	private playerCheckedAt(): number | null {
		return (
			this.kvGet<number>("player_checked_at") ?? this.kvGet<PlayerSnapshot>("player")?.at ?? null
		);
	}

	private playerFresh(maxAge = PLAYER_FRESH_MS): boolean {
		const snap = this.kvGet<PlayerSnapshot>("player");
		const checkedAt = this.playerCheckedAt();
		return (
			!!snap &&
			checkedAt !== null &&
			!this.kvGet("player_stale") &&
			this.now() - checkedAt <= maxAge
		);
	}

	/** Only an actual failed GET advances this clock; a local 429 hold does not. */
	private noteReadFailure(endpoint: string, startedAt: number): void {
		const metric = this.kvGet<{ latest: SpotifyRequestMetric }>("spotify_request_metrics")?.latest;
		if (
			metric?.method === "GET" &&
			metric.endpoint === endpoint &&
			metric.at >= startedAt &&
			metric.retryCategory !== "blocked" &&
			(metric.status === 0 || metric.status >= 400)
		)
			this.kvSet(endpoint === "/me/player" ? "player_failed_at" : "history_failed_at", metric.at);
	}

	/** Scheduling reads a confirmed hold for this operation only; it never creates one. */
	private automaticReadAt(operation: string, at: number): number {
		const hold = this.operationStates()[operation]?.cooldown;
		return hold ? (hold.until === null ? Number.POSITIVE_INFINITY : Math.max(at, hold.until)) : at;
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

	async sync(
		budget: RequestBudget,
		opts: { force?: boolean; observationOnly?: boolean; playerOnly?: boolean } = {},
	): Promise<boolean> {
		if (!this.isConnected()) return false;
		await this.reconcileSharedCooldown();
		if (this.backoffUntil() > this.now()) return false;
		const client = this.client(budget, false, opts.force === true);
		const s = this.syncState();
		// Paused snapshots may not be rewritten. Preserve the actual previous look
		// across eviction for private/guest listening accounting as well as pacing.
		s.lastPlayerAt = this.playerCheckedAt() ?? s.lastPlayerAt;
		const observationAt = this.now();
		const transportRevision = this.transportRevision;
		const epochs = new Map(
			this.stations().map((st) => {
				const session = this.savedSession(st.id);
				return [st.id, session ? `${session.sessionId}:${session.playbackEpoch}` : null];
			}),
		);
		let state: SpPlaybackState | null;
		try {
			state = await client.player();
		} catch (err) {
			this.noteReadFailure("/me/player", observationAt);
			// Token/budget failures also need bounded local scheduling, but cannot
			// claim that a provider player request was sent or succeeded.
			this.kvSet("player_retry_at", this.now() + 15_000);
			this.handleSyncError(err);
			if (
				!opts.playerOnly &&
				err instanceof SpotifyError &&
				err.operation === "GET /me/player" &&
				err.status === 429
			) {
				const previouslyActive = s.idleSince === null && s.lastActivityAt > 0;
				if (opts.force || this.historyReadAt(previouslyActive) <= this.now()) {
					try {
						await this.readRecent(client, s);
						this.setSyncState(s);
					} catch (historyError) {
						this.handleSyncError(historyError);
					}
				}
			}
			return false;
		}
		if (transportRevision !== this.transportRevision) return false;
		this.kvSet("player_checked_at", this.now());
		if (this.kvGet("player_failed_at") !== null) this.kvDel("player_failed_at");
		if (this.kvGet("player_retry_at") !== null) this.kvDel("player_retry_at");
		const obs = toObservation(state, observationAt);
		this.notePrivate(
			state?.device ? state.device.is_private_session === true : null,
			s.lastPlayerAt,
			obs?.isPlaying === true,
		);
		const heardPrivately = this.notePrivateSong(
			obs,
			state?.item ? packTrack(state.item) : null,
			s.lastPlayerAt,
		);
		const shown = this.kvGet<PlayerSnapshot>("player");
		this.noteLane(obs, shown);
		const heard = this.noteHeardSong(
			obs,
			s.lastPlayerAt,
			state?.item ? packTrack(state.item) : null,
		);
		this.noteGuestLast(
			heard,
			!!obs?.trackId && !this.inPrivateNow(),
			s.lastPlayerAt,
			shown?.obs ?? null,
		);
		this.noteLeftEarly(heard, shown);
		s.lastPlayerAt = this.now();
		const snap: PlayerSnapshot = {
			obs,
			track: state?.item ? packTrack(state.item) : null,
			device: state?.device
				? { id: state.device.id, name: state.device.name, restricted: state.device.is_restricted }
				: null,
			repeat: state?.repeat_state,
			at: this.now(),
		};
		// The same picture as a few minutes ago (a paused player): not stored again.
		const before = this.kvGet<PlayerSnapshot>("player");
		const same =
			before &&
			this.now() - before.at < 3 * MINUTE_MS &&
			JSON.stringify({ ...before, at: 0, obs: before.obs ? { ...before.obs, at: 0 } : null }) ===
				JSON.stringify({ ...snap, at: 0, obs: snap.obs ? { ...snap.obs, at: 0 } : null });
		if (!same || this.kvGet("player_stale") || this.kvGet("player_observation_due"))
			this.kvSet("player", snap);
		this.lastLookAt = this.now();
		const observationDue = this.kvGet<number>("player_observation_due");
		if (observationDue !== null && observationAt >= observationDue - 1000)
			this.kvDel("player_observation_due");
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

		// Read fresh history on a provider transition, backwards seek/repeat, stop,
		// or every 90 seconds of unchanged active playback. Player observations
		// and queue checkpoints still run independently at their existing cadence.
		const justStopped = !obs?.isPlaying && wasPlaying;
		const changedPlayback =
			!!obs &&
			(obs.trackId !== before?.obs?.trackId ||
				obs.contextUri !== before?.obs?.contextUri ||
				(obs.progressMs !== null &&
					before?.obs?.progressMs !== null &&
					before?.obs?.progressMs !== undefined &&
					obs.progressMs < before.obs.progressMs));
		const recentDue =
			opts.force ||
			!!this.kvGet("history_due") ||
			justStopped ||
			(!!obs?.isPlaying && (changedPlayback || this.now() - s.lastRecentAt >= 90_000)) ||
			this.now() - s.lastRecentAt >= MAX_RECENT_INTERVAL_MS;
		let plays: RecentPlay[] = [];
		if (recentDue && opts.playerOnly) {
			this.kvSet("history_due", 1);
			if (this.kvGet("history_due_at") === null) this.kvSet("history_due_at", this.now() + 1000);
		}
		if (
			recentDue &&
			!opts.playerOnly &&
			(opts.force ||
				this.automaticReadAt(
					"GET /me/player/recently-played",
					this.kvGet<number>("history_retry_at") ?? 0,
				) <= this.now())
		) {
			try {
				plays = await this.readRecent(client, s);
			} catch (err) {
				this.handleSyncError(err);
			}
		}
		if (obs?.isPlaying && !opts.playerOnly) {
			try {
				await this.peekLiked(client, s);
			} catch (err) {
				this.handleSyncError(err);
			}
		}
		if (transportRevision !== this.transportRevision) return false;

		if (heardPrivately) {
			const own = this.recordSeenPlay(heardPrivately);
			if (own) plays = [...plays, own];
		}
		const replaced = this.settleShownPending();
		if (replaced.length > 0) plays = [...plays, ...replaced];

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
			const currentSession = this.savedSession(st.id);
			const epoch = currentSession
				? `${currentSession.sessionId}:${currentSession.playbackEpoch}`
				: null;
			if (epochs.get(st.id) === epoch) this.checkpoint(st, deck, obs);
			let changed = false;
			if (plays.length > 0) {
				const r = applyPlays(deck, plays, uri);
				if (r.played.length > 0 || r.unskipped.length > 0 || r.waiting.length > 0) changed = true;
				for (const id of r.unskipped) this.undoBooking(st.id, deck, id);
				deck = r.deck;
			}
			if (obs && obs.contextUri === uri) {
				// Only actual playback counts as activity: a deck paused and left
				// alone must still be refreshed for the next start.
				if (obs.isPlaying) activity[String(st.id)] = this.now();
				const r = observePlayer(deck, obs, uri);
				// Stored only when more than the time of the look changed.
				if (!sameDeck(deck, r.deck)) changed = true;
				deck = r.deck;
				// Songs just taken as skipped whose song before is known to have run
				// to its end: the song after them came from the queue.
				if (deck.items.some((it) => it.unless && it.state === "passed" && it.at === obs.at))
					deck = takeBackQueued(deck, (id, from, to) => this.heardBetween(id, from, to)).deck;
				inStation = { st: st.id, uri, inDeck: r.index !== null, index: r.index };
				if (obs.isPlaying && this.now() - (st.last_played_at ?? 0) >= 5 * MINUTE_MS)
					this.db.run(`UPDATE stations SET last_played_at = ? WHERE id = ?`, this.now(), st.id);
				if (
					!opts.observationOnly &&
					r.orderBroken &&
					obs.shuffle &&
					this.now() - s.shuffleFixAt > 10 * MINUTE_MS
				) {
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
				if (
					obs.isPlaying &&
					(this.savedSession(st.id)
						? deck.items.length - this.savedSession(st.id)!.currentIndex - 1
						: remainingAhead(deck)) < EXTEND_BELOW &&
					deck.items.length > 0
				) {
					this.enqueue(`extend:${st.id}`, "extend", { stationId: st.id }, 1);
				}
			}
			const settled = settleSkips(deck, this.now());
			if (settled.skipped.length > 0) {
				changed = true;
				deck = settled.deck;
				const rules = this.rulesOf(st);
				// Booked at the look that saw the song left; a guest period anywhere
				// between the look before and that one keeps it the guest's skip.
				for (const id of settled.skipped) {
					const left = settled.left.get(id);
					const at = left?.at ?? deck.lastObservedAt ?? this.now();
					const booked = this.bookEarlySkip(st, id, rules, at, settled.seen.has(id), left?.from);
					if (!booked) continue;
					deck = markBooked(deck, id, at);
					if (left?.unless) this.noteQueuedSkip({ st: st.id, id, at, unless: left.unless });
				}
			}
			if (changed) this.saveDeck(st.id, deck);
			// Rewrite a deck once nobody has listened to it for a while.
			const consumed = consumedCount(deck) > 0;
			const stale = this.now() - deck.writtenAt > DECK_MAX_AGE_MS;
			if (
				!this.savedSession(st.id) &&
				(consumed || st.deck_dirty || stale) &&
				!this.jobExists(`deck:${st.id}`)
			) {
				const lastActive = activity[String(st.id)] ?? 0;
				const wait = Math.max(0, lastActive + IDLE_BEFORE_REBUILD_MS - this.now());
				this.enqueue(`deck:${st.id}`, "deck", { stationId: st.id }, 3, wait);
			}
		}
		this.watchCurrent(obs, inStation);
		if (!opts.observationOnly) await this.guardStation(client, obs, inStation);
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
		return true;
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
		const startedAt = this.now();
		let page: Awaited<ReturnType<SpotifyClient["recentlyPlayed"]>>;
		try {
			page = await client.recentlyPlayed();
		} catch (err) {
			this.noteReadFailure("/me/player/recently-played", startedAt);
			this.kvSet("history_retry_at", this.now() + 15_000);
			throw err;
		}
		if (this.kvGet("history_due")) this.kvDel("history_due");
		for (const key of ["history_due_at", "history_retry_at", "history_failed_at"])
			if (this.kvGet(key) !== null) this.kvDel(key);
		s.lastRecentAt = this.now();
		this.kvSet("history_checked_at", this.now());
		const plays = this.recordPlays(page?.items ?? [], s);
		this.takeBackQueuedSkips(plays);
		return plays;
	}

	/** Make memory current before planning: read recently-played unless just read. */
	private async freshenMemory(client: SpotifyClient, force = false): Promise<void> {
		const s = this.syncState();
		if (!force && this.now() - s.lastRecentAt < 60_000) return;
		const plays = await this.readRecent(client, s);
		this.setSyncState(s);
		if (plays.length === 0) return;
		this.settleCarried(plays);
		for (const st of this.stations()) {
			const deck = this.deckOf(st);
			const uri = this.deckUri(st);
			if (!deck || !uri) continue;
			const r = applyPlays(deck, plays, uri);
			if (r.played.length > 0 || r.unskipped.length > 0 || r.waiting.length > 0) {
				for (const id of r.unskipped) this.undoBooking(st.id, deck, id);
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
			list.push({
				id: it.id,
				st: stationId,
				at: it.at ?? this.now(),
				since: it.from,
				seen: it.seen === true,
				...(it.unless ? { unless: it.unless } : {}),
			});
		this.kvSet("pending_skips", list.slice(-500));
	}

	/**
	 * A song playing in a station's playlist that is not in the deck version we
	 * know (Spotify can carry on with an order it loaded before a rewrite) is
	 * watched on its own: when another song takes over in the same playlist, it
	 * was left — an early skip unless its play shows up within the grace.
	 */
	/**
	 * A song true-shuffle did not choose for this moment comes up in a station:
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
		// A guest's music is theirs: true-shuffle only listens, never steers.
		if (!obs?.isPlaying || !obs.trackId || !at || this.inGuest(this.now())) return;
		const last = this.kvGet<{ id: TrackId; at: number }>("guard_try");
		if (last && last.id === obs.trackId && this.now() - last.at < MINUTE_MS) return;
		const st = this.stationRow(at.st);
		const deck = st ? this.deckOf(st) : null;
		if (!st || !deck) return;
		if (this.savedSession(st.id) && this.memory(obs.trackId).thumb !== -1) return;
		const m = this.memory(obs.trackId);
		if (m.thumb !== -1 && obs.progressMs >= 30_000) return;
		const heardToday = m.lastPlayedAt !== null && this.now() - m.lastPlayedAt < RECENT_GUARD_MS;
		let to: number | null = null;
		let why: string;
		if (m.thumb === -1) why = "abgelehnt";
		else if (heardToday && at.index === null && formerNow(deck, this.now()).has(obs.trackId))
			why = "heute schon gehört";
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
		this.kvSet("guard_try", { id: obs.trackId, at: this.now() });
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
		const label = this.describe(obs.trackId);
		this.kvSet("moved", { id: obs.trackId, at: this.now(), why, station: st.name, label });
		this.kvSet("player_stale", 1);
		this.log(
			"info",
			"guard",
			`„${st.name}“: ${this.describe(obs.trackId)} übersprungen (${why})${to === null ? "" : `, weiter bei Nr. ${to + 1}`}`,
		);
		// Our move, not the listener's: nothing is inferred from it.
		deck.lastTrackId = null;
		deck.lastPlaying = false;
		// Started at a place of this version: whatever order it had is gone.
		if (to !== null) {
			delete deck.strayedUntil;
			deck.inOrder = true;
		}
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
		const keep: typeof list = [];
		for (const e of list) {
			// A guest's play of the song later on takes nothing back from the
			// owner; the guest's play across the end of guest time does for a
			// skip seen during it — that was its own leaving.
			if (
				plays.some(
					(p) => p.trackId === e.id && (!p.ignored || (p.from !== undefined && e.at >= p.from)),
				)
			)
				continue; // it was a play after all
			// The song before it ran to its end: it never played.
			const u = e.unless;
			if (u && this.heardBetween(u.id, u.from, u.to)) continue;
			// …or its play was read in an earlier round than this one.
			const since = (e.since ?? e.at) - SKIP_GRACE_MS;
			const heard = this.db.first(
				`SELECT 1 FROM plays WHERE played_at >= ? AND track_id = ? AND ignored = 0 LIMIT 1`,
				since,
				e.id,
			);
			if (heard || this.guestLastRan(e.id, since, e.at)) continue;
			if (this.now() - e.at < SKIP_GRACE_MS) {
				keep.push(e);
				continue;
			}
			const st = this.stationRow(e.st);
			if (!st) continue;
			const booked = this.bookEarlySkip(st, e.id, this.rulesOf(st), e.at, e.seen === true, e.since);
			if (booked && e.unless)
				this.noteQueuedSkip({ st: st.id, id: e.id, at: e.at, unless: e.unless });
		}
		if (keep.length !== list.length) this.kvSet("pending_skips", keep);
	}

	/**
	 * A skip booked with a condition (`DeckItem.unless`) outlives its deck: the
	 * play that lifts it may reach recently-played late, also after a stop.
	 */
	private noteQueuedSkip(e: QueuedSkip): void {
		const list = this.kvGet<QueuedSkip[]>("queued_skips") ?? [];
		list.push(e);
		this.kvSet("queued_skips", list.slice(-500));
	}

	/** Plays just read that lift a booked skip's condition: that skip goes. */
	private takeBackQueuedSkips(plays: RecentPlay[]): void {
		if (plays.length === 0) return;
		const list = this.kvGet<QueuedSkip[]>("queued_skips");
		if (!list || list.length === 0) return;
		const keep: QueuedSkip[] = [];
		for (const e of list) {
			const u = e.unless;
			if (this.now() > u.to + LATE_PLAY_WINDOW_MS) continue;
			if (!plays.some((p) => p.trackId === u.id && p.playedAt >= u.from && p.playedAt <= u.to)) {
				keep.push(e);
				continue;
			}
			// Only that booking: a later skip of the song stays, and one never
			// booked (guest time) takes nothing else back.
			if (!this.undoBookingAt(e.st, e.id, e.at)) continue;
			this.log(
				"info",
				"skip",
				`Zurückgenommen: ${this.describe(e.id)} lief nicht, davor kam ein Song aus der Warteschlange`,
			);
		}
		if (keep.length !== list.length) this.kvSet("queued_skips", keep);
	}

	/** A play of the song stamped in that time, read now or before. */
	private heardBetween(id: TrackId, from: number, to: number): boolean {
		return (
			this.db.first(
				`SELECT 1 FROM plays WHERE played_at >= ? AND played_at <= ? AND track_id = ? LIMIT 1`,
				from,
				to,
				id,
			) !== null
		);
	}

	private handleSyncError(err: unknown): void {
		if (err instanceof SpotifyError) {
			if (err.kind === "budget") return;
			if (err.kind === "rate" || err.kind === "quota") {
				if (!err.scope) this.setBackoff(err.retryAfterMs, err.kind);
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

	/** A guest time ended and no look has shown a song since: listings after it wait. */
	private guestUndecided(at: number): boolean {
		const p = this.guestPeriods().at(-1);
		return !!p && p.last === undefined && at > p.to && this.now() - p.to < GUEST_DECIDE_MS;
	}

	private inGuest(at: number): boolean {
		return this.guestPeriods().some((p) => at >= p.from && at < p.to);
	}

	/**
	 * Was this play the guest's? Spotify stamps a play when it ends: one that
	 * ended in guest time was (also the song already running when guest mode
	 * came on). The one play on the player when it ended, running or paused,
	 * is the guest's unless looks saw the owner play 30 s or more of it after
	 * (GuestLast). Not seen: a play that can have begun before the end — after
	 * the play before it ended, and no earlier than its length allows — or the
	 * song seen playing when guest mode went off by hand.
	 */
	private guestPlay(
		id: TrackId,
		at: number,
		durationMs: number,
		before: () => number,
	): { ignored: boolean; from?: number } {
		const periods = this.guestPeriods();
		let listed = false;
		let from: number | undefined;
		const hit = periods.some((p) => {
			if (at > p.from && at <= p.to) return true;
			if (at <= p.to) return false;
			// No look has shown a song since the end, and the listings waited as long
			// as they may: the first one listed after the end may have been paused
			// across it — the guest's.
			if (p.last === undefined && !p.firstTaken && at - p.to < GUEST_FOLLOW_MS) {
				p.firstTaken = true;
				listed = true;
				return true;
			}
			const g = p.last;
			if (g) {
				if (
					g.id === id &&
					!g.listed &&
					at >= g.start &&
					at <= this.guestLastEnd(p, g) + MINUTE_MS
				) {
					g.listed = true;
					listed = true;
					// Listed after the end: it was the play across it.
					if (g.gapTo !== undefined) g.gapTaken = true;
					if (g.owner >= 30_000) return false;
					from = g.start;
					return true;
				}
				// Plays no look saw, over before the first one seen after the end:
				// the first listed of them may have been the guest's, paused across
				// the end; the ones after it began after it, the owner's.
				if (g.gapTo !== undefined && !g.gapTaken && id !== g.next && at <= g.gapTo + 10_000) {
					g.gapTaken = true;
					listed = true;
					return true;
				}
				// None of them listed: the first one seen after the end may itself
				// have been the guest's, paused across the end and played on later —
				// the guest's, unless looks saw the owner hear 30 s or more of it.
				if (
					g.next === id &&
					g.nextStart !== undefined &&
					!g.gapTaken &&
					at >= g.nextStart &&
					at <= (g.nextOver ?? p.to + GUEST_FOLLOW_MS) + MINUTE_MS &&
					(g.nextOwner ?? 0) < 30_000
				) {
					g.gapTaken = true;
					listed = true;
					return true;
				}
				// Looks saw the owner hear 30 s or more of it: the owner's.
				if (
					g.next === id &&
					g.nextStart !== undefined &&
					at >= g.nextStart &&
					(g.nextOwner ?? 0) >= 30_000
				)
					return false;
				// Looks saw the one play across the end: every other one is the owner's.
				if (g.only) return false;
			}
			if (at - durationMs >= p.to) return false;
			if (p.tail !== undefined) return p.tail === id;
			return Math.max(at - durationMs, before()) < p.to;
		});
		if (listed) this.kvSet("guest", periods);
		return hit ? { ignored: true, ...(from !== undefined ? { from } : {}) } : { ignored: false };
	}

	/**
	 * The guest's play across the end, listed since then, was the one left at
	 * `leftAt`: it ran, the owner skipped nothing.
	 */
	private guestLastRan(id: TrackId, since: number, leftAt: number): boolean {
		return this.guestPeriods().some((p) => {
			const g = p.last;
			if (!g?.listed || g.id !== id || leftAt < g.start) return false;
			return (
				this.db.first(
					`SELECT 1 FROM plays WHERE track_id = ? AND ignored = 1 AND played_at >= ? AND played_at >= ? AND played_at <= ? LIMIT 1`,
					id,
					since,
					g.start,
					this.guestLastEnd(p, g) + MINUTE_MS,
				) !== null
			);
		});
	}

	/** The guest's last play while looks still follow it. */
	private guestLastOpen(): { id: TrackId; to: number } | null {
		const p = this.guestPeriods().at(-1);
		const now = this.now();
		if (!p?.last || p.last.over !== null || now < p.to || now - p.to > GUEST_FOLLOW_MS) return null;
		return { id: p.last.id, to: p.to };
	}

	/** The first play seen after the end, which may be the guest's, while looks still follow it. */
	private guestNextOpen(): { id: TrackId; to: number } | null {
		const p = this.guestPeriods().at(-1);
		const g = p?.last;
		const now = this.now();
		if (!p || !g?.next || g.nextOver !== null || now - p.to > GUEST_FOLLOW_MS) return null;
		return { id: g.next, to: p.to };
	}

	/** Until when a listing can be the guest's last play: over, or followed for two days. */
	private guestLastEnd(p: GuestPeriod, g: GuestLast): number {
		return g.over ?? p.to + GUEST_FOLLOW_MS;
	}

	/**
	 * At each look after a guest time: the one play on the player when it
	 * ended, followed until a look no longer shows it. Of what looks saw it
	 * play (HeardSong), the part after the end is the owner's; the part a look
	 * gap spans across the end counts as the guest's.
	 */
	private noteGuestLast(
		h: { before: HeardSong | null; over: HeardSong | null; cur: HeardSong | null },
		seen: boolean,
		lookBefore: number,
		prev: PlayerObservation | null,
	): void {
		const now = this.now();
		const periods = this.guestPeriods();
		const p = periods.at(-1);
		// No song to see says nothing: wait for a look that shows one.
		if (!p || now < p.to || now - p.to > GUEST_FOLLOW_MS || !seen) return;
		const { before, over, cur } = h;
		const samePlay = (a: HeardSong | null, b: { id: TrackId; start: number } | null) =>
			a !== null && b !== null && a.id === b.id && a.start === b.start;
		if (p.last === undefined) {
			let last: GuestLast | null = null;
			if (cur && before && before.at <= p.to && samePlay(cur, before)) {
				// The play seen before the end goes on: it is the only one across it.
				// Seen paused as it was at the look before (not stored again): it
				// moved only after that look.
				const stillPaused =
					prev !== null &&
					!prev.isPlaying &&
					!before.playing &&
					prev.trackId === before.id &&
					prev.progressMs === before.progress;
				const saw =
					stillPaused && lookBefore > before.at && lookBefore <= p.to ? lookBefore : before.at;
				const guest =
					before.listened + Math.min(cur.listened - before.listened, Math.max(0, p.to - saw));
				last = {
					id: cur.id,
					start: cur.start,
					guest,
					owner: cur.listened - guest,
					over: null,
					only: true,
				};
			} else if (cur && !samePlay(cur, before) && (cur.start < p.to || !cur.playing)) {
				// First seen after the end, but begun before it — or paused, so it may
				// have been: what looks see play on is the owner's.
				last = { id: cur.id, start: cur.start, guest: cur.listened, owner: 0, over: null };
				// Surely begun before: no further in than the time since the look
				// before allows (a seek would fake an early start).
				const sought = lookBefore <= 0 || cur.progress > now - lookBefore + 2_000;
				if (cur.start < p.to && !sought) last.only = true;
				// Not surely across the end: a play no look saw before it (an earlier
				// play of the same song, too) may have been — the first one listed.
				else last.gapTo = cur.start;
			} else if (over && before && before.at <= p.to) {
				// Seen before the end, over by now: only a run to its end tells how long after.
				const ranOut = over.listened > before.listened;
				const end = before.at + before.durationMs - before.progress;
				const owner = ranOut ? Math.max(0, end - Math.max(p.to, before.at)) : 0;
				last = { id: over.id, start: over.start, guest: over.listened - owner, owner, over: now };
				// Not run out: plays no look saw may lie between it and the first one
				// seen after the end, and one of them may have been paused across it.
				if (!ranOut && cur && cur.start > p.to) {
					last.gapTo = cur.start;
					last.next = cur.id;
					last.nextStart = cur.start;
					last.nextGuest = cur.listened;
					last.nextOwner = 0;
					last.nextOver = null;
				}
			}
			p.last = last;
			this.kvSet("guest", periods);
			return;
		}
		const g = p.last;
		if (g && g.next !== undefined && g.nextStart !== undefined && g.nextOver === null) {
			const n = { id: g.next, start: g.nextStart };
			if (samePlay(cur, n)) g.nextOwner = Math.max(0, cur!.listened - (g.nextGuest ?? 0));
			else {
				if (samePlay(over, n)) g.nextOwner = Math.max(0, over!.listened - (g.nextGuest ?? 0));
				g.nextOver = now;
			}
			this.kvSet("guest", periods);
		}
		if (!g || g.over !== null) return;
		if (samePlay(cur, g)) {
			const owner = Math.max(0, cur!.listened - g.guest);
			if (owner === g.owner) return;
			g.owner = owner;
		} else {
			if (samePlay(over, g)) g.owner = Math.max(0, over!.listened - g.guest);
			g.over = now;
		}
		this.kvSet("guest", periods);
	}

	/**
	 * At each look: the play the player shows and how much of it looks saw
	 * play; and the play just over — with the rest of it when it was seen
	 * playing and the next one began right at its end (it ran out).
	 */
	private noteHeardSong(
		obs: PlayerObservation | null,
		lookBefore: number,
		track: PackedTrack | null,
	): {
		before: HeardSong | null;
		over: HeardSong | null;
		cur: HeardSong | null;
	} {
		const before = this.kvGet<HeardSong>("heard_song");
		// A private session: its own record counts what plays (private_song).
		if (this.inPrivateNow()) {
			if (before) this.kvDel("heard_song");
			return { before: null, over: null, cur: null };
		}
		// No song to see says nothing about it: it may still play.
		if (!obs?.trackId || obs.durationMs <= 0) return { before, over: null, cur: before };
		const now = this.now();
		// The same song, not begun again: a pause the looks did not see, or one
		// played again from where it was, is one play to them — never split, so
		// what they saw of it is never lost or given to someone else.
		// Played again after its end: seen playing at the look before (no look
		// between that showed no player or it paused), it would have ended since,
		// and it is not as far in as the time since that end — another play.
		const again =
			before !== null &&
			obs.trackId === before.id &&
			before.playing &&
			obs.isPlaying &&
			lookBefore <= before.at &&
			now - (before.at + before.durationMs - before.progress) > obs.progressMs + 5_000;
		const same =
			before !== null &&
			obs.trackId === before.id &&
			!again &&
			!(obs.isPlaying && obs.progressMs + 5_000 < before.progress);
		let over: HeardSong | null = null;
		if (before && !same) {
			over = { ...before };
			const end = before.at + before.durationMs - before.progress;
			// The next one playing, or held at its very start.
			const next = obs.isPlaying || obs.progressMs <= DIRECT_MS;
			if (before.playing && next && Math.abs(obs.at - obs.progressMs - end) <= DIRECT_MS) {
				over.listened += Math.max(0, before.durationMs - before.progress);
				over.ranOut = true;
			}
		}
		const cur: HeardSong =
			before && same
				? {
						...before,
						listened:
							before.listened +
							Math.max(0, Math.min(obs.progressMs - before.progress, now - before.at)),
						progress: obs.progressMs,
						at: now,
						playing: obs.isPlaying,
					}
				: {
						id: obs.trackId,
						start: obs.at - obs.progressMs,
						listened: this.firstHeard(obs, lookBefore),
						progress: obs.progressMs,
						at: now,
						playing: obs.isPlaying,
						durationMs: obs.durationMs,
						contextUri: obs.contextUri,
						track,
					};
		// A paused song seen again as it was: nothing new to store.
		const unchanged =
			before !== null &&
			same &&
			!obs.isPlaying &&
			!before.playing &&
			obs.progressMs === before.progress;
		if (!unchanged) this.kvSet("heard_song", cur);
		return { before, over, cur: unchanged ? before : cur };
	}

	/**
	 * A song first seen: its position, but no more than the time since the
	 * look before; further in than that, it was sought there, and nothing
	 * counts. (A seek within that time cannot be told from listening.)
	 */
	private firstHeard(obs: PlayerObservation, lookBefore: number): number {
		const since = lookBefore > 0 ? obs.at - lookBefore : obs.progressMs;
		return obs.progressMs > since + 2_000 ? 0 : Math.max(0, Math.min(obs.progressMs, since));
	}

	/** Any guest time between `from` and `to`? */
	private inGuestDuring(from: number, to: number): boolean {
		return this.guestPeriods().some((p) => p.from <= to && p.to > from);
	}

	/**
	 * A private session in Spotify: its plays may never reach recently-played,
	 * so a song left then cannot be told from one heard. From the look before
	 * the first one that saw it to the first one that no longer does.
	 */
	private notePrivate(now: boolean | null, lookBefore: number, playing: boolean): void {
		// No player to see (Spotify answered 204): nothing changes.
		if (now === null) return;
		const list = this.kvGet<PrivatePeriod[]>("private") ?? [];
		const last = list[list.length - 1];
		// One not seen for six hours ended then, whatever comes next.
		if (last && last.to === null && privateEnd(last, this.now()) < this.now())
			last.to = privateEnd(last, this.now());
		const open = last !== undefined && last.to === null;
		if (now && open) {
			// Refreshed every few minutes: it only has to outlast six hours.
			if (!playing || this.now() - (last!.seen ?? last!.from) < 5 * MINUTE_MS) return;
			last!.seen = this.now();
		} else if (now && playing)
			list.push({ from: lookBefore > 0 ? lookBefore : this.now(), to: null, seen: this.now() });
		else if (now) return;
		else if (open) last!.to = this.now();
		else return;
		this.kvSet(
			"private",
			list.filter((p) => p.to === null || p.to > this.now() - 2 * DAY_MS).slice(-50),
		);
	}

	private inPrivateDuring(from: number, to: number): boolean {
		const list = this.kvGet<PrivatePeriod[]>("private");
		return (list ?? []).some((p) => p.from <= to && privateEnd(p, this.now()) > from);
	}

	private inPrivateNow(): boolean {
		const last = this.kvGet<PrivatePeriod[]>("private")?.at(-1);
		return last !== undefined && privateEnd(last, this.now()) >= this.now();
	}

	/** A private session on, or seen within the last week: the next may begin any time. */
	private privateLately(): boolean {
		const last = this.kvGet<PrivatePeriod[]>("private")?.at(-1);
		return last !== undefined && this.now() - privateEnd(last, this.now()) < 7 * DAY_MS;
	}

	/**
	 * A song played in a private session counts as heard exactly when looks
	 * saw it play 30 s or more: the time it moved on between them, not how far
	 * it got (a seek is not listening). Kept per song, so it counts once it is
	 * over — also when the session ended meanwhile.
	 */
	private notePrivateSong(
		obs: PlayerObservation | null,
		track: PackedTrack | null,
		lookBefore: number,
	): SeenPlay | null {
		const rec = this.kvGet<PrivateSong>("private_song");
		const cur = obs?.trackId ? obs : null;
		// The same song, not begun again.
		const same =
			rec !== null &&
			cur !== null &&
			cur.trackId === rec.id &&
			!(cur.isPlaying && cur.progressMs + 5_000 < rec.progress);
		let out: SeenPlay | null = null;
		// No player to see says nothing about the song: it may still play.
		if (rec && !same && cur !== null) {
			out = this.privatePlay(rec);
			this.kvDel("private_song");
		}
		if (cur?.trackId && track && cur.durationMs > 0 && this.inPrivateNow()) {
			const now = this.now();
			// Heard since the look before: no more than the time that passed.
			const since = same ? now - rec!.at : lookBefore > 0 ? now - lookBefore : cur.progressMs;
			const moved = same ? cur.progressMs - rec!.progress : cur.progressMs;
			// A new song further in than the time since the look before allows was
			// sought there: only what later looks see it play counts.
			const sought = !same && moved > since + 2_000;
			const start = same ? rec!.start : cur.at - cur.progressMs;
			// Where it ends if it plays on from now: later after every pause.
			const end = cur.at + cur.durationMs - cur.progressMs;
			this.kvSet("private_song", {
				id: cur.trackId,
				start,
				end,
				listened: (same ? rec!.listened : 0) + (sought ? 0 : Math.max(0, Math.min(moved, since))),
				progress: cur.progressMs,
				at: now,
				contextUri: cur.contextUri,
				track,
			} satisfies PrivateSong);
		}
		return out;
	}

	private privatePlay(rec: PrivateSong): SeenPlay | null {
		if (rec.listened < 30_000) return null;
		const at = Math.min(rec.end, this.now());
		if (this.inGuest(at) || this.inGuestDuring(rec.start, at)) return null;
		return {
			id: rec.id,
			at,
			start: rec.start,
			end: rec.end,
			contextUri: rec.contextUri,
			track: rec.track,
		};
	}

	/**
	 * Starting a station replaces what the player shows: a song heard 30 s or
	 * more is kept out of the new plan, else it may come right back. It counts
	 * as heard when Spotify lists it (in a private session: by the looks).
	 */
	private shownHeardSong(): TrackId | null {
		const rec = this.kvGet<PrivateSong>("private_song");
		if (rec && rec.listened >= 30_000) return rec.id;
		const snap = this.kvGet<PlayerSnapshot>("player");
		const o = snap?.obs;
		// The look play() just made (an unchanged picture is not stored again).
		const fresh = this.now() - Math.max(snap?.at ?? 0, this.lastLookAt) <= MINUTE_MS;
		if (o?.trackId && o.progressMs >= 30_000 && fresh) return o.trackId;
		// No player in sight (the device went to sleep): the song looks saw last,
		// 30 s or more, is the one the start replaces.
		const heard = this.kvGet<HeardSong>("heard_song");
		return !o?.trackId && heard && heard.listened >= 30_000 ? heard.id : null;
	}

	/**
	 * The start worked and replaced a song looks saw play 30 s or more: it
	 * counts when Spotify lists it, and if Spotify does not within the grace,
	 * from here. In a private session the looks count it.
	 */
	private noteShownPending(id: TrackId | null): void {
		const rec = this.kvGet<HeardSong>("heard_song");
		const snap = this.kvGet<PlayerSnapshot>("player");
		if (!id || rec?.id !== id || rec.listened < 30_000) return;
		const track = rec.track ?? (snap?.obs?.trackId === id ? snap.track : null);
		if (!track) return;
		if (this.kvGet<PrivateSong>("private_song")?.id === id) return;
		this.addNote({
			id,
			by: "app",
			start: rec.start,
			at: this.now(),
			durationMs: rec.durationMs,
			contextUri: rec.contextUri ?? snap?.obs?.contextUri ?? null,
			track,
			until: this.now() + SKIP_GRACE_MS,
		});
	}

	/**
	 * A play looks saw 30 s or more, left before its end — for another context
	 * (a start in Spotify itself: another album, another playlist), or another
	 * song: like a start from the app, it counts when Spotify lists it, and
	 * else from here.
	 */
	private noteLeftEarly(
		h: { over: HeardSong | null; cur: HeardSong | null },
		shown: PlayerSnapshot | null,
	): void {
		const { over, cur } = h;
		if (!over || !cur || over.ranOut || over.listened < 30_000) return;
		// The same song again: one play or two, the looks cannot tell.
		if (cur.id === over.id) return;
		// Its track as the look that first saw it read it (a look without a
		// player since then changes nothing).
		const track = over.track ?? (shown?.obs?.trackId === over.id ? shown.track : null);
		if (!track) return;
		const now = this.now();
		// Left after the last look that saw it, and — seen playing — no later
		// than its own end; the new song began no earlier than that.
		const latest = over.playing ? over.at + over.durationMs - over.progress : now;
		this.addNote({
			id: over.id,
			by: (cur.contextUri ?? null) === (over.contextUri ?? null) ? "leave" : "start",
			seen: over.at,
			start: over.start,
			at: Math.max(over.at, Math.min(now, cur.start, latest)),
			durationMs: over.durationMs,
			contextUri: over.contextUri ?? null,
			track,
			until: now + SKIP_GRACE_MS,
		});
	}

	/** One note per play. */
	private addNote(e: ShownPending): void {
		const notes = this.shownNotes();
		if (notes.some((x) => x.id === e.id && x.start === e.start)) return;
		notes.push(e);
		this.kvSet("shown_pending", notes.slice(-20));
	}

	private shownNotes(): ShownPending[] {
		const v = this.kvGet<ShownPending[] | ShownPending>("shown_pending");
		if (!v) return [];
		// Kept as one note before: its play began at most a day before.
		return Array.isArray(v)
			? v
			: [{ ...v, start: (v as Partial<ShownPending>).start ?? v.at - DAY_MS }];
	}

	/** Not listed within the grace: each replaced song counts from its note. */
	private settleShownPending(): RecentPlay[] {
		const notes = this.shownNotes();
		const now = this.now();
		if (!notes.some((e) => now >= e.until)) return [];
		const left = notes.filter((e) => now < e.until);
		if (left.length > 0) this.kvSet("shown_pending", left);
		else this.kvDel("shown_pending");
		// Spotify has listed replaced songs lately: one it did not list was not
		// heard 30 s by its count (a seek, say) — better missed than made up.
		const listed = this.kvGet<number>("replaced_listed");
		if (listed !== null && now - listed < 30 * DAY_MS) return [];
		const out: RecentPlay[] = [];
		for (const e of notes) {
			if (now < e.until || this.guestNote(e)) continue;
			// Left between the last look that saw it and the next look: a song
			// listed since then began after it ended, 30 s or more before its own
			// listing — the earliest one bounds when it was left.
			let at = e.at;
			if (e.seen !== undefined) {
				const next = this.db.first<{ at: number | null }>(
					`SELECT MIN(played_at) AS at FROM plays WHERE played_at > ? AND track_id != ?`,
					e.seen,
					e.id,
				)?.at;
				if (next != null) at = Math.max(e.seen, Math.min(at, next - 30_000));
			}
			// Whenever Spotify may list it later (paused for hours: its stamp may be
			// old), it is this play.
			const r = this.recordSeenPlay({
				id: e.id,
				at,
				start: e.start,
				// Heard 30 s or more: its listing is stamped no earlier than that
				// after it began (one before is the play before it).
				after: e.start + 20_000,
				end: Math.max(at, e.at),
				contextUri: e.contextUri,
				track: e.track,
				// Replaced or left: over, no later end for a pause to delay.
				open: false,
			});
			if (!r) continue;
			out.push(r);
			this.log(
				"info",
				"replaced",
				`„${e.track[1]}“ zählt ohne Spotifys Meldung (${e.by === "leave" ? "weitergesprungen" : e.by === "start" ? "in Spotify ersetzt" : "ersetzt"})`,
			);
		}
		return out;
	}

	/** A replaced song the guest played: in guest time, or across its end unless the owner heard it. */
	private guestNote(e: ShownPending): boolean {
		if (this.inGuest(e.at)) return true;
		for (const p of this.guestPeriods()) {
			const g = p.last;
			if (g && g.id === e.id && g.start === e.start) return g.owner < 30_000;
			if (g && g.next === e.id && g.nextStart === e.start)
				return !g.gapTaken && (g.nextOwner ?? 0) < 30_000;
		}
		return this.inGuestDuring(e.start, e.at);
	}

	/**
	 * Count a play seen in a private session, unless Spotify listed it after
	 * all; and when it lists it later, do not count it again.
	 */
	private recordSeenPlay(e: SeenPlay): RecentPlay | null {
		// It was over by now (paused on the way, later than it would have been).
		// Before its start, a listing is the play before (RT24-02).
		const from = e.after ?? e.start - MINUTE_MS;
		const anchor = Math.max(e.end, this.now());
		const to = anchor + MINUTE_MS;
		// A play still on when counted may end minutes later after a pause, and
		// Spotify stamps it then: in its own context that listing is still this
		// play. A play that was over has no later end to wait for.
		const durationMs = e.track[5];
		const open = e.open ?? !(durationMs > 0 && e.start + durationMs - e.end <= 5_000);
		const until = open ? anchor + SAME_PLAY_SLACK_MS : to;
		const entry: SeenEntry = { id: e.id, from, to, at: e.at, ctx: e.contextUri, until };
		const listed = this.db.all<{ played_at: number; context_uri: string | null }>(
			`SELECT played_at, context_uri FROM plays WHERE played_at >= ? AND played_at <= ? AND track_id = ?`,
			from,
			until,
			e.id,
		);
		if (listed.some((r) => this.isSeenListing(entry, e.id, r.played_at, r.context_uri)))
			return null;
		const st = e.contextUri
			? this.stations().find((x) => this.deckUri(x) === e.contextUri)
			: undefined;
		this.db.run(
			`INSERT OR IGNORE INTO plays (played_at, track_id, context_uri, station_id, ignored, meta, lane) VALUES (?, ?, ?, ?, 0, ?, ?)`,
			e.at,
			e.id,
			e.contextUri,
			st?.id ?? null,
			JSON.stringify(e.track),
			st && e.contextUri === this.deckUri(st) ? this.laneFor(st.id, e.id, e.at) : null,
		);
		this.noteHeard(st?.id, e.id);
		const seen = (this.kvGet<SeenEntry[]>("seen_plays") ?? []).filter(
			(x) => Math.max(x.to, x.until ?? 0) > this.now() - LATE_PLAY_WINDOW_MS,
		);
		seen.push(entry);
		this.kvSet("seen_plays", seen.slice(-200));
		const before = this.memory(e.id);
		this.livePlay(e.id, e.at);
		this.countRound(e.id, before, e.at);
		this.noteDiscoveryHeard(e.id);
		this.dirtyDecksHolding(e.id, st?.id ?? null);
		return { trackId: e.id, playedAt: e.at, contextUri: e.contextUri };
	}

	/**
	 * Whether Spotify's listing (played at `at` in `ctx`) is the play a seen
	 * entry counted. Track and time alone do not tell a delayed listing from a
	 * new play of the same song: past the original window only one listing, in
	 * the same context, with nothing else heard since, is that play.
	 */
	private isSeenListing(e: SeenEntry, id: TrackId, at: number, ctx: string | null): boolean {
		if (e.id !== id || at < e.from) return false;
		if (at <= e.to) return true;
		if (e.until === undefined || at > e.until || e.listed || e.ctx === undefined) return false;
		// Spotify lists some plays without their context (API starts among them):
		// a context-less listing may still be this play; another context never is.
		if (ctx !== null && e.ctx !== ctx) return false;
		return !this.db.first(
			`SELECT 1 FROM plays WHERE played_at > ? AND played_at < ? AND track_id != ? LIMIT 1`,
			e.at ?? e.to,
			at,
			id,
		);
	}

	/**
	 * Listings made after a guest time wait until a look shows which play was
	 * on the player across its end (at most GUEST_DECIDE_MS). They are kept
	 * here meanwhile — Spotify's list holds only the last 50 — and join the
	 * read that no longer has to wait. A station they played in counts as in
	 * use, so its deck is not rewritten under the listener meanwhile.
	 */
	private holdGuestListings(
		read: { track: SpTrack; played_at: string; context: { uri: string } | null }[],
		key: (at: number, id: string) => string,
		released: Set<string>,
	): { track: SpTrack; played_at: string; context: { uri: string } | null }[] {
		type Held = { p: PackedTrack; at: string; ctx: string | null };
		const held = this.kvGet<Held[]>("guest_waiting") ?? [];
		const waits = (at: string) => this.guestUndecided(Date.parse(at));
		const seen = new Set(held.map((h) => key(Date.parse(h.at), h.p[0])));
		const add: Held[] = [];
		const activity = this.kvGet<Record<string, number>>("deck_activity") ?? {};
		let active = false;
		for (const i of read) {
			const id = i.track?.id;
			const at = Date.parse(i.played_at);
			if (!id || !Number.isFinite(at) || !waits(i.played_at) || seen.has(key(at, id))) continue;
			seen.add(key(at, id));
			const p: PackedTrack = packTrack(i.track) ?? [
				id,
				i.track.name ?? "",
				(i.track.artists ?? []).map((a) => [a.id ?? `name:${a.name}`, a.name] as [string, string]),
				i.track.album?.name ?? "",
				null,
				i.track.duration_ms ?? 0,
			];
			add.push({ p, at: i.played_at, ctx: i.context?.uri ?? null });
			const st = i.context?.uri
				? this.stations().find((x) => this.deckUri(x) === i.context!.uri)
				: undefined;
			if (st && at > (activity[String(st.id)] ?? 0)) {
				activity[String(st.id)] = at;
				active = true;
			}
		}
		if (active) this.kvSet("deck_activity", activity);
		// A read that is all new held listings may have missed older ones: say so,
		// as for any read (released listings are left out of that check later).
		if (read.length >= 50 && add.length >= 50)
			this.log(
				"warn",
				"gap",
				"Mehr als 50 Songs seit dem letzten Abgleich — ältere konnten nicht gelesen werden",
			);
		const release = held.filter((h) => !waits(h.at));
		const stay = [...held.filter((h) => waits(h.at)), ...add].sort(
			(a, b) => Date.parse(a.at) - Date.parse(b.at),
		);
		if (add.length > 0 || release.length > 0) {
			// Twelve hours of one-minute songs fit; beyond that the oldest go, said so.
			if (stay.length > GUEST_HELD_MAX)
				this.log(
					"warn",
					"gap",
					`${stay.length - GUEST_HELD_MAX} Songs nach der Gast-Zeit konnten nicht aufgehoben werden`,
				);
			if (stay.length > 0) this.kvSet("guest_waiting", stay.slice(-GUEST_HELD_MAX));
			else this.kvDel("guest_waiting");
		}
		for (const h of release) released.add(key(Date.parse(h.at), h.p[0]));
		if (release.length === 0) return read;
		const inRead = new Set(
			read.filter((i) => i.track?.id).map((i) => key(Date.parse(i.played_at), i.track.id!)),
		);
		return [
			...read,
			...release
				.filter((h) => !inRead.has(key(Date.parse(h.at), h.p[0])))
				.map((h) => ({
					track: {
						id: h.p[0],
						name: h.p[1],
						type: "track",
						duration_ms: h.p[5],
						artists: h.p[2].map(([aid, name]) => ({ id: aid, name })),
						album: { name: h.p[3], images: h.p[4] ? [{ url: h.p[4] }] : [] },
					} as SpTrack,
					played_at: h.at,
					context: h.ctx ? { uri: h.ctx } : null,
				})),
		];
	}

	/** Book new entries of the recently-played list into memory. */
	private recordPlays(
		read: { track: SpTrack; played_at: string; context: { uri: string } | null }[],
		s: SyncState,
	): RecentPlay[] {
		const out: RecentPlay[] = [];
		const key = (at: number, id: string) => `${at}|${id}`;
		const released = new Set<string>();
		const items = this.holdGuestListings(read, key, released);
		// What the previous read already returned. A play older than the cursor
		// that was not in it arrived late (offline listening synced afterwards):
		// it still counts, once — the plays table has the final say.
		const known = new Set(this.kvGet<string[]>("recent_keys") ?? []);
		// Plays true-shuffle counted itself in a private session: listed late, not again.
		const seen = this.kvGet<SeenEntry[]>("seen_plays") ?? [];
		let seenListed = false;
		// Never reaching back before the first sign-in: that belongs to the import.
		const lateFrom = Math.max(
			s.recentCursor - LATE_PLAY_WINDOW_MS,
			this.kvGet<number>("live_since") ?? Number.NEGATIVE_INFINITY,
		);
		// Listed after a guest time, before any look showed which play was on the
		// player across its end: held (holdGuestListings), judged once it is known.
		const waits = (at: number) => this.guestUndecided(at);
		const fresh = items
			.map((i) => ({ i, at: Date.parse(i.played_at) }))
			.filter((x) => {
				const id = x.i.track?.id;
				if (!Number.isFinite(x.at) || !id || waits(x.at)) return false;
				if (x.at > s.recentCursor) return true;
				if (x.at <= lateFrom || known.has(key(x.at, id))) return false;
				return !this.db.first(`SELECT 1 FROM plays WHERE played_at = ? AND track_id = ?`, x.at, id);
			})
			.sort((a, b) => a.at - b.at);
		// When each play of this read ended: one account plays one song at a time.
		const times = items.map((i) => Date.parse(i.played_at)).filter((t) => Number.isFinite(t));
		const keys = items
			.filter((i) => i.track?.id && !waits(Date.parse(i.played_at)))
			.map((i) => key(Date.parse(i.played_at), i.track.id!))
			.slice(0, 60);
		if (keys.length !== known.size || keys.some((k) => !known.has(k)))
			this.kvSet("recent_keys", keys);
		// Spotify's own read was full of new plays: older ones may be past its 50.
		// (Released held listings are not part of that read.)
		const freshRead = fresh.filter((x) => !released.has(key(x.at, x.i.track.id!))).length;
		if (freshRead >= 50 && read.length >= 50) {
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
		const notes = this.shownNotes();
		const noted = notes.length;
		for (const { i, at } of fresh) {
			const id = i.track.id!;
			const ctx = i.context?.uri ?? null;
			// Spotify listed a song a start replaced: this is its play — heard 30 s
			// or more, so stamped no earlier than that after it began.
			const k = notes.findIndex(
				(e) => e.id === id && at >= e.start + 20_000 && at <= e.at + MINUTE_MS,
			);
			if (k >= 0) {
				const e = notes[k]!;
				notes.splice(k, 1);
				// A start's from the app (its time is known), stamped when it was
				// replaced, before its own end: Spotify lists replaced songs, and its
				// word decides from now on.
				if (
					(e.by ?? "app") === "app" &&
					at >= e.at - 10_000 &&
					at < e.start + e.durationMs - 10_000
				) {
					if (this.now() - (this.kvGet<number>("replaced_listed") ?? 0) >= 30 * DAY_MS)
						this.log(
							"info",
							"replaced",
							"Spotify meldet ersetzte Songs — sie zählen ab jetzt über Spotify",
						);
					this.kvSet("replaced_listed", this.now());
				}
			}
			// Counted already from the looks in a private session: it still tells
			// the decks it was heard, and memory nothing new.
			const counted = seen.find((e) => this.isSeenListing(e, id, at, ctx));
			if (counted) {
				// Listed now: a further listing of the song is a play of its own.
				if (!counted.listed) {
					counted.listed = true;
					seenListed = true;
				}
				s.recentCursor = Math.max(s.recentCursor, at);
				out.push({ trackId: id, playedAt: at, contextUri: ctx });
				continue;
			}
			const guest = this.guestPlay(id, at, i.track.duration_ms ?? 0, () => {
				let before = Number.NEGATIVE_INFINITY;
				for (const t of times) if (t < at && t > before) before = t;
				if (before === Number.NEGATIVE_INFINITY)
					before =
						this.db.first<{ at: number | null }>(
							`SELECT MAX(played_at) AS at FROM plays WHERE played_at < ?`,
							at,
						)?.at ?? Number.NEGATIVE_INFINITY;
				return before;
			});
			const ignored = guest.ignored;
			const station = ctx ? deckByUri.get(ctx) : deckHolding(id, at);
			const packed = packTrack(i.track);
			this.db.run(
				`INSERT OR IGNORE INTO plays (played_at, track_id, context_uri, station_id, ignored, meta, lane) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				at,
				id,
				ctx,
				station?.id ?? null,
				ignored ? 1 : 0,
				packed ? JSON.stringify(packed) : null,
				station && ctx === this.deckUri(station) ? this.laneFor(station.id, id, at) : null,
			);
			if (!ignored) this.noteHeard(station?.id, id);
			s.recentCursor = Math.max(s.recentCursor, at);
			out.push({
				trackId: id,
				playedAt: at,
				contextUri: ctx,
				...(ignored ? { ignored } : {}),
				...(guest.from !== undefined ? { from: guest.from } : {}),
			});
			if (ignored) continue;
			// The round is judged on memory as it was: a skip that already used the
			// song up (consume rule) stands in for this play — never counted twice.
			const before = this.memory(id);
			// Its play arrived after all: the skip booked for the time it played
			// was none — that one, not whichever came last.
			const wrong = this.bookings().find(
				(b) =>
					b.id === id &&
					at >= (b.from ?? b.at - 30 * MINUTE_MS) - MINUTE_MS &&
					at <= b.at + 5 * MINUTE_MS,
			);
			if (wrong) this.undoBookingAt(wrong.st, id, wrong.at);
			this.livePlay(id, at);
			this.countRound(id, before, at);
			this.noteDiscoveryHeard(id);
			// Heard somewhere else: every other deck still holding it is stale.
			this.dirtyDecksHolding(id, station?.id ?? null);
		}
		if (seenListed) this.kvSet("seen_plays", seen);
		if (notes.length < noted) {
			if (notes.length > 0) this.kvSet("shown_pending", notes);
			else this.kvDel("shown_pending");
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
		from?: number,
	): boolean {
		if (this.inGuest(at) || (from !== undefined && this.inGuestDuring(from, at))) return false;
		if (this.inPrivateDuring(from ?? at, at)) return false;
		const before = this.memory(id);
		this.liveSkip(id, at);
		this.noteBooking({ st: st.id, id, at, ...(from !== undefined ? { from } : {}), seen });
		this.log(
			"info",
			"skip",
			`Früh übersprungen auf „${st.name}“${seen ? "" : " (erschlossen)"}: ${this.describe(id)}`,
		);
		this.dirtyDecksHolding(id, null);
		if (!seen) return true;
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
			// A round this skip completes begins now: plays already counted since
			// the song was left belong to the round that just ended.
			this.countRound(id, before, this.now(), "consume");
		}
		// A discovery skipped early is not for this listener.
		this.db.run(
			`UPDATE discoveries SET status = 'rejected', updated_at = ? WHERE id = ? AND status IN ('candidate', 'probation')`,
			this.now(),
			id,
		);
		return true;
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
	/**
	 * Take back exactly the skip a deck booked for this song: all of it while
	 * it is the song's latest, only its count once a later skip followed, and
	 * nothing if it is no longer there (taken back already).
	 */
	private bookings(): Booking[] {
		return this.kvGet<Booking[]>("bookings") ?? [];
	}

	/** Every early skip booked, for a day: a late play takes back the one it proves wrong. */
	private noteBooking(b: Booking): void {
		const keep = this.bookings().filter(
			(x) => x.at > this.now() - LATE_PLAY_WINDOW_MS - 2 * HOUR_MS,
		);
		keep.push(b);
		this.kvSet("bookings", keep.slice(-500));
	}

	/**
	 * Take back exactly that booking: all of it while it is the song's latest
	 * skip, only its count and its ban once a later skip followed, nothing if
	 * it was taken back already.
	 */
	private undoBookingAt(stationId: number, id: TrackId, at: number): boolean {
		const list = this.bookings();
		const i = list.findIndex((b) => b.st === stationId && b.id === id && b.at === at);
		if (i < 0) return false;
		const b = list[i]!;
		list.splice(i, 1);
		this.kvSet("bookings", list);
		const row = this.liveRow(id);
		if (!row || row.last_skipped_at === null || row.last_skipped_at < at) return false;
		if (row.last_skipped_at === at) {
			if (b.seen) this.undoSkip(stationId, id);
			else
				this.updateLive(id, (r) => ({
					...r,
					early_skips: Math.max(0, r.early_skips - 1),
					last_skipped_at: null,
				}));
		} else {
			this.updateLive(id, (r) => ({ ...r, early_skips: Math.max(0, r.early_skips - 1) }));
			if (b.seen)
				this.db.run(
					`DELETE FROM bans WHERE station_id = ? AND track_id = ? AND at = ?`,
					stationId,
					id,
					at,
				);
		}
		return true;
	}

	/** A deck's own record of what it booked: take back exactly that. */
	private undoBooking(stationId: number, deck: Deck, id: TrackId): void {
		const at = deck.items.find((x) => x.id === id && x.state === "skipped")?.booked;
		if (at !== undefined) this.undoBookingAt(stationId, id, at);
	}

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

	private commandTail: Promise<unknown> = Promise.resolve();

	/** Serialize commands across awaited provider requests; a stale tab cannot replace a run. */
	play(
		stationId: number,
		deviceId?: string | null,
		opts: { newQueue?: boolean; sessionId?: string } = {},
	): Promise<PlayResult> {
		const task = this.commandTail.then(() => this.resumeSession(stationId, deviceId, opts));
		this.commandTail = task.catch(() => undefined);
		return task;
	}

	public savedSession(stationId?: number): SavedSession | null {
		const id = stationId ?? this.kvGet<number>("active_session_station");
		if (id == null) return null;
		const row = this.db.first<{ data: string }>(
			`SELECT data FROM playback_sessions WHERE station_id = ?`,
			id,
		);
		return row ? (JSON.parse(row.data) as SavedSession) : null;
	}

	private saveSession(session: SavedSession): void {
		this.db.run(
			`INSERT INTO playback_sessions (station_id, data) VALUES (?, ?) ON CONFLICT(station_id) DO UPDATE SET data = excluded.data WHERE playback_sessions.data <> excluded.data`,
			session.stationId,
			JSON.stringify(session),
		);
	}

	private createSession(st: StationRow, deck: Deck): SavedSession {
		const sessionId = crypto.randomUUID();
		const index = deck.lastTrackId ? deck.items.findIndex((it) => it.id === deck.lastTrackId) : -1;
		const snap = this.kvGet<PlayerSnapshot>("player");
		const trustworthy =
			index >= 0 &&
			snap?.obs?.contextUri === this.deckUri(st) &&
			snap.obs.trackId === deck.lastTrackId;
		const session: SavedSession = {
			sessionId,
			stationId: st.id,
			orderRevision: deck.version,
			entryIds: deck.items.map((_, i) => `${sessionId}:${i}`),
			currentIndex: Math.max(0, index),
			progressMs: trustworthy ? snap.obs!.progressMs : null,
			observedAt: trustworthy ? snap!.obs!.at : null,
			playbackEpoch: 0,
			contextUri: this.deckUri(st)!,
			status: "saved",
			pending: null,
		};
		this.saveSession(session);
		return session;
	}

	/** Deliberate local replacement; normal native resume never calls this planner. */
	public newNativeQueue(stationId: number): SavedSession {
		const st = this.stationRow(stationId);
		if (!st || !this.stationReady(st))
			throw new HubError("not_ready", "Diese Warteschlange wird noch vorbereitet.");
		const pool = this.stationPool(st);
		const discoveries = this.discoveryEntries(st);
		this.preloadMemory([...pool.map((it) => it.id), ...discoveries.map((it) => it.id)]);
		const input = {
			now: this.now(),
			roundStartedAt: st.round_started_at,
			rules: this.rulesOf(st),
			pool,
			memory: (id: TrackId) => this.memory(id),
			banned: this.bans(stationId),
			discoveries,
			size: DECK_SIZE,
			rng: this.d.rng,
		};
		let result = planQueue(input);
		if (!result.slots.length && result.poolSize > 0)
			result = planQueue({ ...input, roundStartedAt: this.now() + 1 });
		if (!result.slots.length)
			throw new HubError("empty", "Diese Warteschlange hat keine abspielbaren Songs.");
		const deck = newDeck(result.slots, (this.deckOf(st)?.version ?? 0) + 1, this.now());
		return this.db.transaction(() => {
			this.saveDeck(stationId, deck);
			st.deck = JSON.stringify(deck);
			const session = this.createSession(st, deck);
			session.controller = "native";
			session.contextUri = this.deckUri(st) ?? `native:station:${stationId}`;
			this.saveSession(session);
			this.kvSet("active_session_station", stationId);
			this.kvDel(`native_tail:${stationId}`);
			this.kvDel(`extend_intent:${stationId}`);
			this.kvDel(`native_heard:${stationId}`);
			this.kvSet(`deck_intent:${stationId}`, {
				layout: result.slots,
				version: deck.version,
				writtenAt: deck.writtenAt,
			});
			this.db.run(
				`UPDATE stations SET deck_dirty = 0, fresh_remaining = ?, pool_size = ?, stats = ? WHERE id = ?`,
				result.freshRemaining,
				result.poolSize,
				JSON.stringify(result.counts),
				stationId,
			);
			return session;
		});
	}

	public nativeSession(stationId: number, advance = false): SavedSession {
		const st = this.stationRow(stationId);
		const deck = st ? this.deckOf(st) : null;
		if (!st || !deck?.items.length)
			throw new HubError("not_ready", "Diese Warteschlange wird noch vorbereitet.");
		const session = this.savedSession(stationId) ?? this.createSession(st, deck);
		if (advance && session.currentIndex + 1 < session.entryIds.length) {
			session.currentIndex += 1;
			session.progressMs = 0;
			session.observedAt = this.now();
		}
		session.controller = "native";
		session.pending = null;
		session.playbackEpoch += 1;
		session.sequence = -1;
		session.status = "saved";
		this.saveSession(session);
		this.kvSet("active_session_station", stationId);
		return session;
	}

	/** Reserve a local ordered tail. Transport retries receive exactly the same occurrence IDs. */
	public prepareNativeTail(
		stationId: number,
	): { orderRevision: number; entries: { entryId: string; mediaId: string }[] } | null {
		const session = this.savedSession(stationId);
		const st = this.stationRow(stationId);
		const deck = st ? this.deckOf(st) : null;
		if (session?.controller !== "native" || !st || !deck) return null;
		const key = `native_tail:${stationId}`;
		const pending = this.kvGet<{
			sessionId: string;
			orderRevision: number;
			entries: { entryId: string; mediaId: string }[];
		}>(key);
		if (pending?.sessionId === session.sessionId)
			return { orderRevision: pending.orderRevision, entries: pending.entries };
		if (deck.items.length - session.currentIndex - 1 >= EXTEND_BELOW) return null;
		const pool = this.stationPool(st);
		const discoveries = this.discoveryEntries(st);
		this.preloadMemory([...pool.map((it) => it.id), ...discoveries.map((it) => it.id)]);
		const prefix = deck.items.slice(0, session.currentIndex);
		const suffix = deck.items.slice(session.currentIndex);
		const blocked = new Set([...this.bans(st.id), ...suffix.map((it) => it.id)]);
		const input = {
			now: this.now(),
			roundStartedAt: st.round_started_at,
			rules: this.rulesOf(st),
			pool,
			memory: (id: TrackId) => this.memory(id),
			banned: new Set([...blocked, ...prefix.map((it) => it.id)]),
			discoveries,
			size: 100,
			rng: this.d.rng,
		};
		let result = planQueue(input);
		if (!result.slots.length)
			result = planQueue({ ...input, banned: blocked, roundStartedAt: this.now() + 1 });
		if (!result.slots.length) return null;
		const appended = result.slots.map((slot) => ({
			id: slot.trackId,
			kind: slot.kind,
			state: "pending" as const,
			at: null,
		}));
		const entries = appended.map((it) => ({
			entryId: crypto.randomUUID(),
			mediaId: it.id,
		}));
		const trim =
			deck.items.length > 800 || appended.some((it) => prefix.some((old) => old.id === it.id))
				? session.currentIndex
				: 0;
		this.db.transaction(() => {
			deck.items = [...deck.items.slice(trim), ...appended];
			deck.lastIndex = session.currentIndex - trim;
			deck.version += 1;
			session.entryIds = [...session.entryIds.slice(trim), ...entries.map((it) => it.entryId)];
			session.currentIndex -= trim;
			session.orderRevision += 1;
			this.saveDeck(stationId, deck);
			this.saveSession(session);
			this.kvSet(`deck_intent:${stationId}`, {
				layout: deck.items.map((it) => ({ trackId: it.id, kind: it.kind })),
				version: deck.version,
				writtenAt: deck.writtenAt,
			});
			this.kvSet(key, {
				sessionId: session.sessionId,
				orderRevision: session.orderRevision,
				entries,
			});
		});
		return { orderRevision: session.orderRevision, entries };
	}

	public acknowledgeNativeTail(stationId: number, revision: number): boolean {
		const key = `native_tail:${stationId}`;
		const intent = this.kvGet<{ sessionId: string; orderRevision: number }>(key);
		if (
			!intent ||
			intent.orderRevision !== revision ||
			this.savedSession(stationId)?.sessionId !== intent.sessionId
		)
			return false;
		this.kvDel(key);
		return true;
	}

	/** Compare-and-swap native command recovery; trusted events win over stale intents. */
	public commitNativeSession(
		snapshot: SavedSession,
		expectedEpoch: number,
		expectedSequence = -1,
	): boolean {
		const current = this.savedSession(snapshot.stationId);
		if (
			!current ||
			current.sessionId !== snapshot.sessionId ||
			current.playbackEpoch !== expectedEpoch ||
			(current.sequence ?? -1) !== expectedSequence
		)
			return false;
		this.saveSession({
			...snapshot,
			playbackEpoch: current.playbackEpoch,
			sequence: current.sequence,
			controller: "native",
		});
		return true;
	}

	public nativeObservationStatus(
		stationId: number,
		sessionId: string,
		playbackEpoch: number,
		status: "active" | "paused" | "disconnected" | "external" | "ambiguous",
		sequence?: number,
	): boolean {
		const session = this.savedSession(stationId);
		if (
			session?.controller !== "native" ||
			session.sessionId !== sessionId ||
			session.playbackEpoch !== playbackEpoch
		)
			return false;
		if (sequence != null && (!Number.isInteger(sequence) || sequence <= (session.sequence ?? -1)))
			return false;
		if (sequence != null) session.sequence = sequence;
		session.status = status;
		this.saveSession(session);
		return true;
	}

	private noteNativeSample(
		session: SavedSession,
		entryId: string,
		progress: number | null,
		playing: boolean,
	): void {
		const key = `native_heard:${session.stationId}`;
		type Sample = {
			entryId: string;
			epoch: number;
			at: number;
			progress: number | null;
			playing: boolean;
			listened: number;
			start: number;
			ignored: boolean;
			recorded: boolean;
		};
		const now = this.now();
		const prev = this.kvGet<Sample>(key);
		const sameEntry = prev?.entryId === entryId;
		const same = sameEntry && prev.epoch === session.playbackEpoch;
		const sample: Sample = sameEntry
			? { ...prev, epoch: session.playbackEpoch }
			: {
					entryId,
					epoch: session.playbackEpoch,
					at: now,
					progress,
					playing,
					listened: 0,
					start: now,
					ignored: this.inGuest(now),
					recorded: false,
				};
		if (same && prev.playing && progress != null && prev.progress != null) {
			const delta = progress - prev.progress;
			const elapsed = now - prev.at;
			// Provider movement corroborates heard time. A seek or wall time alone counts nothing.
			if (delta >= 0 && elapsed >= 0 && delta <= elapsed + 2000)
				sample.listened += Math.min(delta, elapsed);
		}
		sample.ignored ||=
			this.inGuest(now) ||
			this.guestPeriods().some((period) => period.from <= now && period.to > sample.at);
		sample.at = now;
		sample.progress = progress;
		sample.playing = playing;
		if (sample.listened >= 30_000 && !sample.recorded) {
			const st = this.stationRow(session.stationId);
			const deck = st ? this.deckOf(st) : null;
			const index = session.entryIds.indexOf(entryId);
			const id = index >= 0 ? deck?.items[index]?.id : null;
			const track = id ? this.lookupTracks([id], this.usedSources()).get(id) : null;
			if (id && track) {
				if (sample.ignored)
					this.db.run(
						`INSERT OR IGNORE INTO plays (played_at,track_id,context_uri,station_id,ignored,meta) VALUES (?,?,?,?,1,?)`,
						now,
						id,
						session.contextUri,
						session.stationId,
						JSON.stringify(track),
					);
				else
					this.recordSeenPlay({
						id,
						at: now,
						start: sample.start,
						end: now,
						after: sample.start,
						contextUri: session.contextUri,
						track,
					});
				sample.recorded = true;
			}
		}
		this.kvSet(key, sample);
	}

	/** Native events are fenced by account, session, occurrence, epoch and sequence. */
	public acceptSessionObservation(
		stationId: number,
		obs: {
			sessionId: string;
			entryId: string;
			playbackEpoch: number;
			sequence: number;
			progressMs: number | null;
			isPlaying: boolean;
		},
	): boolean {
		const session = this.savedSession(stationId);
		if (
			!session ||
			session.sessionId !== obs.sessionId ||
			session.playbackEpoch !== obs.playbackEpoch ||
			obs.sequence <= (session.sequence ?? -1)
		)
			return false;
		const index = session.entryIds.indexOf(obs.entryId);
		if (
			index < 0 ||
			(obs.progressMs != null && (!Number.isFinite(obs.progressMs) || obs.progressMs < 0))
		)
			return false;
		this.noteNativeSample(session, obs.entryId, obs.progressMs, obs.isPlaying);
		if (index !== session.currentIndex || obs.progressMs != null)
			session.progressMs = obs.progressMs;
		session.currentIndex = index;
		session.sequence = obs.sequence;
		session.controller = "native";
		session.observedAt = this.now();
		session.status = obs.isPlaying ? "active" : "paused";
		this.saveSession(session);
		return true;
	}

	/**
	 * Songs heard on each station (non-guest plays), kept per Durable Object so
	 * a poll never scans the plays log: a station is read once, then every new
	 * counted play is added where it is recorded (`noteHeard`). A label only:
	 * the set matches the plays table as of the last wake, so plays pruned after
	 * half a year (or a write rolled back) drop out of it at the next wake.
	 */
	private heardOnStation = new Map<number, Set<TrackId>>();

	private stationHeard(stationId: number): Set<TrackId> {
		let ids = this.heardOnStation.get(stationId);
		if (!ids) {
			ids = new Set(
				this.db
					.all<{ track_id: string }>(
						`SELECT DISTINCT track_id FROM plays WHERE station_id = ? AND ignored = 0`,
						stationId,
					)
					.map((r) => r.track_id),
			);
			this.heardOnStation.set(stationId, ids);
		}
		return ids;
	}

	/** A counted play was recorded: keep `stationHeard` current without reading. */
	private noteHeard(stationId: number | null | undefined, id: TrackId): void {
		if (stationId != null) this.heardOnStation.get(stationId)?.add(id);
	}

	/**
	 * A song seen starting on a station (see `noteLane`): its lane, frozen at
	 * that look, waits for the play to be recorded.
	 */
	private laneNotes(): LaneNote[] {
		return this.kvGet<LaneNote[]>("lane_notes") ?? [];
	}

	/**
	 * Notes why a song is on its station when a look first sees it as a new
	 * song in the station's own playlist: the look before showed another song
	 * (or another context), and the deck in that playlist was written before
	 * that look, so this play began from this deck. The lane is the deck's
	 * one reason for the song (null when it holds the song for several).
	 */
	private noteLane(obs: PlayerObservation | null, shown: PlayerSnapshot | null): void {
		const now = this.now();
		let notes = this.laneNotes().filter((n) => now - n.seenAt < LANE_NOTE_MS);
		const before = JSON.stringify(notes);
		// A look that no longer shows a noted song closes its note: that play
		// ended by now, and a later play of the song is another one.
		for (const n of notes)
			if (n.goneAt === undefined && (n.id !== obs?.trackId || this.stationRow(n.station) === null))
				n.goneAt = now;
		const isNew =
			obs?.trackId &&
			obs.contextUri &&
			shown &&
			!(shown.obs?.trackId === obs.trackId && shown.obs?.contextUri === obs.contextUri);
		const st = isNew ? this.stations().find((x) => this.deckUri(x) === obs.contextUri) : undefined;
		const deck = st ? this.deckOf(st) : null;
		if (st && deck && shown && obs?.trackId && deck.writtenAt <= shown.at) {
			const kinds = new Set(deck.items.filter((it) => it.id === obs.trackId).map((it) => it.kind));
			// Any open note of the song is another, earlier play.
			for (const n of notes) if (n.id === obs.trackId && n.goneAt === undefined) n.goneAt = now;
			notes.push({
				station: st.id,
				id: obs.trackId,
				kind: kinds.size === 1 ? ([...kinds][0] ?? null) : null,
				seenAt: now,
			});
		}
		notes = notes.slice(-50);
		if (JSON.stringify(notes) !== before) this.kvSet("lane_notes", notes);
	}

	/**
	 * A new deck on a station: notes of songs not playing right now belong to
	 * plays from the deck before and are closed; the song playing now keeps its
	 * note (it began from that deck and may still be listed).
	 */
	private closeLaneNotes(stationId: number): void {
		const playing = this.kvGet<PlayerSnapshot>("player")?.obs?.trackId ?? null;
		const now = this.now();
		const notes = this.laneNotes();
		let changed = false;
		for (const n of notes)
			if (n.station === stationId && n.goneAt === undefined && n.id !== playing) {
				n.goneAt = now;
				changed = true;
			}
		if (changed) this.kvSet("lane_notes", notes);
	}

	/**
	 * The lane for a play being recorded: the latest note of this song on this
	 * station seen before the play's stamp and not closed before it ended,
	 * used once. No note, no lane.
	 */
	private laneFor(stationId: number, id: TrackId, at: number): SlotKind | null {
		const notes = this.laneNotes();
		let best = -1;
		notes.forEach((n, i) => {
			if (n.station !== stationId || n.id !== id || n.seenAt > at || at - n.seenAt > LANE_NOTE_MS)
				return;
			// Spotify stamps a play when it ends: by the look that saw it gone.
			if (n.goneAt !== undefined && at > n.goneAt + LANE_STAMP_SLACK_MS) return;
			if (best < 0 || n.seenAt > notes[best]!.seenAt) best = i;
		});
		if (best < 0) return null;
		const [note] = notes.splice(best, 1);
		this.kvSet("lane_notes", notes);
		return note?.kind ?? null;
	}

	/**
	 * Read-only labels for songs in a queue (see `SongFacts`). `plays` and
	 * `lastPlayedAt` come from `memory()`: the live memory table — which only
	 * guest-free counted plays (>= 30 s) ever reach — merged with imported
	 * history, cut off at `live_since` so nothing is counted twice.
	 * `inStation` comes from `stationHeard` (non-guest plays on this station).
	 */
	private songFacts(
		stationId: number,
		items: readonly { id: TrackId; kind: SlotKind }[],
	): (it: { id: TrackId; kind: SlotKind }) => SongFacts {
		this.preloadMemory(new Set(items.map((it) => it.id)));
		const heardHere = this.stationHeard(stationId);
		return (it) => {
			const m = this.memory(it.id);
			return {
				plays: m.plays,
				lastPlayedAt: m.lastPlayedAt,
				inStation: heardHere.has(it.id),
				// Per deck item: the same song could sit in a deck twice for different reasons.
				kind: it.kind ?? null,
			};
		};
	}

	public sessionView(stationId?: number, limit = 51) {
		const session = this.savedSession(stationId);
		const st = session ? this.stationRow(session.stationId) : null;
		const deck = st ? this.deckOf(st) : null;
		if (!session || !deck) return null;
		const upcoming = deck.items.slice(
			session.currentIndex,
			session.currentIndex + Math.min(1000, Math.max(1, limit)),
		);
		const tracks = this.lookupTracks(
			upcoming.map((it) => it.id),
			this.usedSources(),
		);
		const facts = this.songFacts(session.stationId, upcoming);
		const queue = upcoming.flatMap((it, n) => {
			const track = tracks.get(it.id);
			return track
				? [
						{
							entryId: session.entryIds[session.currentIndex + n]!,
							track: this.view(track),
							facts: facts(it),
						},
					]
				: [];
		});
		return {
			sessionId: session.sessionId,
			stationId: session.stationId,
			entryId: session.entryIds[session.currentIndex]!,
			orderRevision: session.orderRevision,
			progressMs: session.progressMs,
			observedAt: session.observedAt,
			status: session.status,
			pending:
				session.pending !== null ||
				(session.controller !== "native" && !!this.kvGet(`deck_intent:${session.stationId}`)),
			queue,
		};
	}

	private checkpoint(st: StationRow, deck: Deck, obs: PlayerObservation | null): void {
		let session = this.savedSession(st.id);
		if (!session && (deck.lastTrackId || obs?.contextUri === this.deckUri(st)))
			session = this.createSession(st, deck);
		// An unconfirmed command expires instead of freezing the saved place. A
		// playlist write still being retried keeps its hold: until it lands,
		// positions in the player mean the order before it.
		if (
			session?.pending &&
			session.controller !== "native" &&
			this.now() - (session.pending.startedAt ?? 0) > PENDING_EXPIRE_MS &&
			(session.pending.kind !== "publish" ||
				(!this.kvGet(`deck_intent:${st.id}`) && !this.kvGet(`extend_intent:${st.id}`)))
		) {
			this.log(
				"info",
				"session",
				`„${st.name}“: unbestätigter Befehl (${session.pending.kind}) verworfen — die Stelle wird wieder mitgeschrieben`,
			);
			session.pending = null;
			this.saveSession(session);
		}
		if (
			session?.pending?.kind === "resume" &&
			session.controller !== "native" &&
			obs?.contextUri === session.contextUri &&
			obs.isPlaying &&
			obs.at >= (session.pending.startedAt ?? session.observedAt ?? 0)
		) {
			const matches = deck.items
				.map((it, i) => (it.id === obs.trackId ? i : -1))
				.filter((i) => i >= 0);
			const index =
				obs.contextOffset != null && matches.includes(obs.contextOffset)
					? obs.contextOffset
					: matches.length === 1
						? matches[0]!
						: -1;
			// A fresh own-context observation confirms the desired state. Unrelated
			// playback and ambiguous occurrences cannot acknowledge the operation.
			if (index >= 0 && (session.pending.phase === "prepared" || index === session.currentIndex))
				session.pending = null;
		}
		if (session?.pending?.kind === "next" && obs?.contextUri === session.contextUri) {
			const matches = deck.items
				.map((it, i) => (it.id === obs.trackId ? i : -1))
				.filter((i) => i >= 0);
			const index =
				obs.contextOffset != null && matches.includes(obs.contextOffset)
					? obs.contextOffset
					: matches.length === 1
						? matches[0]!
						: -1;
			if (index > session.currentIndex) {
				session.pending = null;
				session.currentIndex = index;
				session.progressMs = obs.progressMs;
				session.observedAt = obs.at;
				this.saveSession(session);
			}
		}
		if (
			!session ||
			(session.pending &&
				!(session.pending.kind === "resume" && session.pending.phase === "prepared")) ||
			session.controller === "native"
		)
			return;
		if (!obs) session.status = "disconnected";
		else if (obs.contextUri !== session.contextUri) session.status = "external";
		else if (session.observedAt == null || obs.at >= session.observedAt) {
			if (this.kvGet<number>("active_session_station") !== st.id)
				this.kvSet("active_session_station", st.id);
			const matches = deck.items
				.map((it, i) => (it.id === obs.trackId ? i : -1))
				.filter((i) => i >= 0);
			const offset = obs.contextOffset;
			if (matches.length > 1 && offset == null) {
				session.status = "ambiguous";
				this.saveSession(session);
				return;
			}
			const index =
				offset != null && matches.includes(offset)
					? offset
					: matches.length === 1
						? matches[0]!
						: matches.includes(session.currentIndex)
							? session.currentIndex
							: -1;
			if (index >= 0 && index < session.currentIndex) {
				// A player in this playlist at an earlier place: another device
				// resuming what it had loaded days ago, or a tap in Spotify itself.
				// The saved place is where true-shuffle's order got to, and it
				// never moves back — the station waits there until it is its turn.
				session.status = "external";
			} else if (index >= 0) {
				session.currentIndex = index;
				// Within the current song the latest observation wins, including a
				// backwards seek; across songs only forward (see above).
				session.progressMs =
					Number.isFinite(obs.progressMs) && obs.progressMs >= 0 ? obs.progressMs : null;
				session.observedAt = obs.at;
				session.status = obs.isPlaying ? "active" : "paused";
			} else session.status = "ambiguous";
		}
		this.saveSession(session);
	}

	private async resumeSession(
		stationId: number,
		deviceId?: string | null,
		opts: { newQueue?: boolean; sessionId?: string } = {},
	): Promise<PlayResult> {
		const st = this.stationRow(stationId);
		if (!st) return fail("unknown", "Diese Warteschlange gibt es nicht.");
		let session = this.savedSession(stationId);
		if (opts.sessionId && session?.sessionId !== opts.sessionId)
			return fail("unknown", "Die Ansicht ist veraltet. Bitte aktualisieren.");
		const budget = new RequestBudget(BUDGET_PER_INVOCATION);
		const client = this.client(budget);
		let transportAttempted = false;
		try {
			this.transportRevision += 1;
			const intent = this.kvGet<{ layout: PlannedSlot[] }>(`deck_intent:${stationId}`);
			if (intent && st.playlist_id) {
				const uris = intent.layout.map((slot) => `spotify:track:${slot.trackId}`);
				await client.replaceItems(st.playlist_id, uris.slice(0, 100));
				for (let i = 100; i < uris.length; i += 100)
					await client.addItems(st.playlist_id, uris.slice(i, i + 100));
				this.kvDel(`deck_intent:${stationId}`);
				this.kvDel(`extend_intent:${stationId}`);
			}
			// Capture the checkpoint without running automatic playback repair
			// ahead of this explicit start/device-selection command.
			const observed = await this.sync(budget, {
				force: true,
				observationOnly: true,
				// Replanning still needs fresh history; a stable resume only needs
				// the actual unfinished occurrence and provider mode/device sample.
				playerOnly: !!session && !opts.newQueue && !!st.deck && !!st.playlist_id && !intent,
			});
			const fresh = this.stationRow(stationId)!;
			if (!session && this.stationOrphaned(fresh))
				throw new HubError(
					"gone",
					"Die Playlist dieses Senders gibt es in deinem Spotify nicht mehr. Wähle unter Quellen eine andere.",
				);
			let deck = this.deckOf(fresh);
			if (
				(opts.newQueue && !intent) ||
				(!session && fresh.deck_dirty === 1) ||
				!deck ||
				!fresh.playlist_id
			) {
				if (opts.newQueue)
					this.db.run(`DELETE FROM playback_sessions WHERE station_id = ?`, stationId);
				deck = await this.rebuildDeck(
					client,
					fresh,
					"start",
					opts.newQueue ? this.shownHeardSong() : null,
				);
				session = this.savedSession(stationId);
			}
			if (!deck?.items.length) return fail("empty", "Diese Warteschlange hat keine Songs.");
			session = session ? this.savedSession(stationId) : null;
			session ??= this.createSession(fresh, deck);
			// Journal the candidate without replacing the visible saved station.
			// A definitive refusal must leave the previous station available.
			// Submitted ambiguous commands still become visible for reconciliation.
			session.pending = {
				operationId: session.pending?.operationId ?? crypto.randomUUID(),
				kind: "resume",
				deviceId,
				phase: "prepared",
				startedAt: this.now(),
			};
			this.saveSession(session);
			let target = await this.pickDevice(client, deviceId ?? null, { observed });
			if (!target) {
				const current = this.savedSession(stationId);
				if (
					current?.sessionId === session.sessionId &&
					current.pending?.operationId === session.pending?.operationId
				) {
					current.pending = null;
					current.status = "disconnected";
					this.saveSession(current);
				}
				return fail("no_device", "Öffne Spotify auf einem Gerät und setze dann fort.");
			}
			const snapshot = this.kvGet<PlayerSnapshot>("player");
			if (
				observed &&
				!opts.newQueue &&
				session.controller !== "native" &&
				snapshot?.obs?.isPlaying &&
				!snapshot.obs.shuffle &&
				snapshot.repeat === "off" &&
				snapshot.obs.contextUri === session.contextUri &&
				snapshot.obs.trackId === deck.items[session.currentIndex]?.id &&
				target.id === snapshot.device?.id
			) {
				session.pending = null;
				session.controller = "spotify";
				session.playbackEpoch += 1;
				session.status = "active";
				this.saveSession(session);
				this.kvSet("active_session_station", stationId);
				await this.deferPlayerObservation();
				return { ok: true, deviceName: target.name, acceptedAt: this.now() };
			}
			const replacedSong = this.shownHeardSong();
			const start = async (device: { id: string; name: string }) => {
				// Only a successful observation from this command can avoid mode writes.
				// Unknown modes and a different target retain the ordered-start sequence.
				const sameDevice = observed && snapshot?.device?.id === device.id;
				if (!sameDevice || !snapshot?.obs || snapshot.obs.shuffle)
					await client.setShuffle(false, device.id);
				if (!sameDevice || snapshot?.repeat !== "off") await client.setRepeat("off", device.id);
				session!.pending = { ...session!.pending!, phase: "submitted" };
				this.saveSession(session!);
				transportAttempted = true;
				await client.play({
					contextUri: session!.contextUri,
					position: session!.currentIndex,
					progressMs: session!.progressMs ?? 0,
					deviceId: device.id,
				});
			};
			try {
				try {
					await start(target);
				} catch (err) {
					if (!(err instanceof SpotifyError && err.kind === "no_device")) throw err;
					this.kvDel("spotify_devices");
					if (deviceId) throw err;
					// One definitive device rejection permits one fresh discovery; never
					// retry the vanished device or silently redirect an explicit selection.
					const fallback = await this.pickDevice(client, null, { exclude: target.id });
					if (!fallback) throw err;
					target = fallback;
					await start(target);
				}
			} catch (err) {
				if (
					!(
						err instanceof SpotifyError &&
						err.kind === "not_found" &&
						err.operation === "PUT /me/player/play"
					)
				)
					throw err;
				this.db.run(`UPDATE stations SET playlist_id = NULL WHERE id = ?`, stationId);
				fresh.playlist_id = null;
				const playlistId = await this.ensurePlaylist(client, fresh);
				session.contextUri = `spotify:playlist:${playlistId}`;
				this.saveSession(session);
				this.kvSet(`deck_intent:${stationId}`, {
					layout: deck.items.map((it) => ({ trackId: it.id, kind: it.kind })),
					version: deck.version,
					writtenAt: deck.writtenAt,
				});
				const uris = deck.items.map((it) => `spotify:track:${it.id}`);
				await client.replaceItems(playlistId, uris.slice(0, 100));
				for (let i = 100; i < uris.length; i += 100)
					await client.addItems(playlistId, uris.slice(i, i + 100));
				this.kvDel(`deck_intent:${stationId}`);
				await client.play({
					contextUri: session.contextUri,
					position: session.currentIndex,
					progressMs: session.progressMs ?? 0,
					deviceId: target.id,
				});
			}
			if (replacedSong && replacedSong !== deck.items[session.currentIndex]?.id)
				this.noteShownPending(replacedSong);
			session.pending = null;
			session.controller = "spotify";
			session.playbackEpoch += 1;
			session.status = "active";
			this.saveSession(session);
			this.kvSet("active_session_station", stationId);
			this.transportRevision += 1;
			deck.ours = true;
			deck.inOrder = true;
			deck.top = session.currentIndex === 0;
			this.saveDeck(stationId, deck);
			this.kvSet("player_stale", 1);
			this.db.run(`UPDATE stations SET last_played_at = ? WHERE id = ?`, this.now(), stationId);
			await this.deferPlayerObservation();
			return { ok: true, deviceName: target.name, acceptedAt: this.now() };
		} catch (err) {
			if (err instanceof SpotifyError && ["no_device", "restricted"].includes(err.kind))
				this.kvDel("spotify_devices");
			const current = this.savedSession(stationId);
			const result = this.playError(err, transportAttempted);
			// Rejected commands and preflight failures did not start playback. Keep
			// the checkpoint, but release the pending control so the listener can retry.
			// This includes a rejected 401 followed by a failed token refresh: the
			// refresh operation is distinct from an ambiguous player-write outcome.
			if (
				current?.pending?.kind === "resume" &&
				current.sessionId === session?.sessionId &&
				current.pending.operationId === session.pending?.operationId &&
				(current.pending.phase === "prepared" || !result.uncertain)
			) {
				current.pending = null;
				this.saveSession(current);
			}
			if (result.uncertain) {
				this.kvSet("active_session_station", stationId);
				this.transportRevision += 1;
			}
			if (result.uncertain || this.savedSession(stationId)?.pending?.phase === "submitted") {
				this.kvSet("player_stale", 1);
				await this.deferPlayerObservation();
			}
			return result;
		}
	}

	private playError(err: unknown, transportAttempted = false): PlayResult {
		if (
			transportAttempted &&
			!(err instanceof HubError) &&
			(!(err instanceof SpotifyError) ||
				((err.kind === "network" || err.kind === "server") &&
					(!err.operation || /^(PUT|POST) \/me\/player\/(play|pause|next)$/.test(err.operation))))
		)
			return {
				...fail(
					"unknown",
					"Spotify hat den Befehl noch nicht bestätigt. Der Zustand wird geprüft.",
				),
				uncertain: true,
			};
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
					if (!err.scope) this.setBackoff(err.retryAfterMs, "quota");
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
		opts: { observed?: boolean; exclude?: string } = {},
	): Promise<{ id: string; name: string } | null> {
		const snapshot = this.kvGet<PlayerSnapshot>("player");
		const known = snapshot?.device;
		const cached = this.kvGet<{ at: number; devices: DeviceView[] }>("spotify_devices");
		if (wanted)
			return {
				id: wanted,
				name:
					known?.id === wanted
						? known.name
						: (cached?.devices.find((d) => d.id === wanted)?.name ?? "Spotify"),
			};
		if (!opts.exclude && opts.observed && known?.id && !known.restricted)
			return { id: known.id, name: known.name };
		const usable = (devices: DeviceView[]) => {
			const candidates = devices.filter((d) => !d.restricted && d.id !== opts.exclude);
			return (
				candidates.find((d) => d.active) ??
				candidates.find((d) => d.type === "Smartphone") ??
				candidates[0] ??
				null
			);
		};
		if (!opts.exclude && cached && this.now() - cached.at < 60_000) {
			const pick = usable(cached.devices);
			if (pick) return pick;
		}
		try {
			return usable(await this.readDevices(client));
		} catch (e) {
			if (
				!(e instanceof SpotifyError) ||
				e.operation !== "GET /me/player/devices" ||
				e.status !== 429
			)
				throw e;
			if (
				snapshot &&
				this.now() - snapshot.at < 60_000 &&
				known?.id &&
				!known.restricted &&
				known.id !== opts.exclude
			)
				return { id: known.id, name: known.name };
			return null;
		}
	}

	async devices(): Promise<DeviceView[]> {
		const cached = this.kvGet<{ at: number; devices: DeviceView[] }>("spotify_devices");
		if (cached && this.now() - cached.at < (cached.devices.length ? 60_000 : 5000))
			return cached.devices;
		return this.readDevices(this.client(new RequestBudget(4)));
	}

	private async readDevices(client: SpotifyClient): Promise<DeviceView[]> {
		const list = await client.devices();
		const devices = list
			.filter((d) => d.id)
			.slice(0, 100)
			.map((d) => ({
				id: d.id!,
				name: d.name,
				type: d.type,
				active: d.is_active,
				restricted: d.is_restricted,
			}));
		this.kvSet("spotify_devices", { at: this.now(), devices });
		return devices;
	}

	private async deferPlayerObservation(): Promise<void> {
		this.kvSet("player_observation_due", this.now() + 1000);
		await this.scheduleSoon(1000);
	}

	playerAction(
		action: "pause" | "resume" | "next",
		expected: { sessionId?: string; entryId?: string } = {},
	): Promise<PlayResult> {
		const task = this.commandTail.then(() => this.performPlayerAction(action, expected));
		this.commandTail = task.catch(() => undefined);
		return task;
	}
	private async performPlayerAction(
		action: "pause" | "resume" | "next",
		expected: { sessionId?: string; entryId?: string },
	): Promise<PlayResult> {
		let current = this.savedSession();
		let nextObserved = false;
		// Unfenced remotes can request the next song immediately after a skip.
		// Reconcile the previous intent first; replaying an old entry stays rejected.
		if (action === "next" && current?.pending?.kind === "next" && !expected.entryId) {
			nextObserved = await this.sync(new RequestBudget(8), {
				force: true,
				observationOnly: true,
				playerOnly: true,
			});
			current = this.savedSession();
		}
		if (
			(expected.sessionId && current?.sessionId !== expected.sessionId) ||
			(expected.entryId && current?.entryIds[current.currentIndex] !== expected.entryId)
		)
			return fail("unknown", "Die Ansicht ist veraltet. Bitte aktualisieren.");
		if (action === "next" && current?.pending?.kind === "next")
			return fail(
				"unknown",
				"Spotify hat den letzten Sprung noch nicht bestätigt. Die Warteschlange bleibt gespeichert.",
			);
		const budget = new RequestBudget(6);
		const client = this.client(budget);
		let transportAttempted = false;
		try {
			if (action === "resume") {
				const session = this.savedSession();
				if (session) return this.resumeSession(session.stationId);
			}
			if (action === "pause") {
				this.transportRevision += 1;
				transportAttempted = true;
				await client.pause();
				this.transportRevision += 1;
				// Acknowledgement changes transport status, never observed position.
				// The durable alarm reads the stopped position after this response.
				const session = this.savedSession();
				if (
					session &&
					session.controller !== "native" &&
					this.kvGet<PlayerSnapshot>("player")?.obs?.contextUri === session.contextUri
				) {
					session.status = "paused";
					session.playbackEpoch += 1;
					this.saveSession(session);
				}
			} else if (action === "resume") {
				this.transportRevision += 1;
				transportAttempted = true;
				await client.resume();
				this.transportRevision += 1;
			} else {
				this.transportRevision += 1;
				const observed =
					nextObserved ||
					(await this.sync(new RequestBudget(8), {
						force: true,
						observationOnly: true,
						playerOnly: true,
					}));
				const session = this.savedSession();
				// The player can advance naturally after the UI was drawn. Check the
				// newly observed occurrence before journaling or sending a skip.
				if (
					(expected.sessionId && session?.sessionId !== expected.sessionId) ||
					(expected.entryId && session?.entryIds[session.currentIndex] !== expected.entryId)
				)
					return fail("unknown", "Die Ansicht ist veraltet. Bitte aktualisieren.");
				const obs = this.kvGet<PlayerSnapshot>("player")?.obs;
				const own =
					observed &&
					session &&
					session.controller !== "native" &&
					obs?.contextUri === session.contextUri;
				if (expected.entryId && (!own || session.status === "ambiguous"))
					return fail("unknown", "Der angezeigte Song ist nicht bestätigt. Bitte aktualisieren.");
				if (own) {
					session.pending = {
						operationId: crypto.randomUUID(),
						kind: "next",
						phase: "submitted",
						startedAt: this.now(),
					};
					this.saveSession(session);
				}
				transportAttempted = true;
				await client.next();
				this.transportRevision += 1;
				if (own) {
					session.pending = { ...session.pending!, phase: "submitted" };
					session.playbackEpoch += 1;
					this.saveSession(session);
				}
			}
			// The next look at the interface must read the player, not the old snapshot.
			this.kvSet("player_stale", 1);
			await this.deferPlayerObservation();
			return { ok: true, acceptedAt: this.now() };
		} catch (err) {
			const result = this.playError(err, transportAttempted);
			const pending = this.savedSession();
			if (action === "next" && pending?.pending?.kind === "next" && !result.uncertain) {
				pending.pending = null;
				this.saveSession(pending);
			}
			if (result.uncertain) {
				this.transportRevision += 1;
				this.kvSet("player_stale", 1);
				await this.deferPlayerObservation();
			}
			return result;
		}
	}

	// =======================================================================
	// Listener input
	// =======================================================================

	/**
	 * `playing` says whether the song plays right now, when the caller just
	 * read the player; otherwise the last snapshot decides.
	 */
	async thumb(
		trackId: TrackId,
		value: -1 | 0 | 1,
		playing?: boolean,
	): Promise<{ skipped: boolean; skipError?: string }> {
		let skipped = false;
		let skipError: string | undefined;
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
			// Stations whose older versions held it watch for it more closely.
			for (const st of this.stations()) {
				const d = this.deckOf(st);
				if (!d || d.formerOff?.includes(trackId) || !formerNow(d, this.now()).has(trackId))
					continue;
				d.formerOff = [...(d.formerOff ?? []), trackId];
				this.saveDeck(st.id, d);
			}
			// Skip it only while it plays. The stored picture of the player can be
			// a minute old: when it says so, a fresh look confirms it, or a song the
			// listener already left would take the next one with it.
			const native = this.savedSession()?.controller === "native";
			let now = native ? false : playing;
			if (!native && now === undefined) {
				const snap = this.kvGet<PlayerSnapshot>("player");
				if (snap?.obs?.isPlaying && snap.obs.trackId === trackId) {
					try {
						const st = await this.client(new RequestBudget(3)).player();
						now = !!st?.is_playing && st.item?.id === trackId;
					} catch {
						now = false;
					}
				}
			}
			if (now) {
				const r = await this.playerAction("next");
				skipped = r.ok;
				// Our move: a look that still shows the song (Spotify catches up a
				// moment later) must not skip it a second time. A skip that failed
				// is left to the station guard to try again.
				if (r.ok) this.kvSet("guard_try", { id: trackId, at: this.now() });
				else skipError = r.error?.message;
			}
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
		return skipError ? { skipped, skipError } : { skipped };
	}

	// =======================================================================
	// Remote: Siri, CarPlay, a watch, a widget
	// =======================================================================

	/** The current remote key's id (the Worker signs it into the key). */
	remoteKey(): { kid: string; createdAt: number; usedAt: number | null } | null {
		const k = this.kvGet<RemoteKey>("remote_key");
		return k ? { kid: k.kid, createdAt: k.createdAt, usedAt: k.usedAt } : null;
	}

	/** A new key; the one before stops working. */
	newRemoteKey(): string {
		const kid = randomToken(12);
		const had = this.kvGet<RemoteKey>("remote_key") !== null;
		this.kvSet("remote_key", { kid, createdAt: this.now(), usedAt: null, uses: [] });
		this.log(
			"info",
			"remote",
			had
				? "Neuer Schlüssel für die Fernbedienung — der alte gilt nicht mehr"
				: "Schlüssel für die Fernbedienung erstellt",
		);
		return kid;
	}

	dropRemoteKey(): void {
		if (this.kvGet("remote_key") === null) return;
		this.kvDel("remote_key");
		this.log("info", "remote", "Schlüssel für die Fernbedienung gelöscht");
	}

	/**
	 * A command from a personal key. Answers with a sentence to show or speak;
	 * a failure is a HubError whose message says the same.
	 */
	async remote(kid: string, action: RemoteAction): Promise<string> {
		const k = this.kvGet<RemoteKey>("remote_key");
		if (!k || k.kid !== kid)
			throw new HubError(
				"auth",
				"Dieser Schlüssel gilt nicht mehr. Einen neuen gibt es in true-shuffle unter Menü, Fernbedienung.",
				401,
			);
		const now = this.now();
		const uses = k.uses.filter((t) => now - t < REMOTE_WINDOW_MS);
		if (uses.length >= REMOTE_LIMIT)
			throw new HubError(
				"rate",
				"Zu viele Befehle kurz hintereinander. Warte ein paar Minuten.",
				429,
			);
		this.kvSet("remote_key", { ...k, usedAt: now, uses: [...uses, now] });
		if (!this.isConnected())
			throw new HubError(
				"auth",
				"true-shuffle ist nicht mit Spotify verbunden. Melde dich in der App neu an.",
				409,
			);
		const failed = (r: PlayResult): HubError =>
			new HubError(
				r.error?.code ?? "unknown",
				r.error?.message ?? "Das hat nicht geklappt.",
				r.error?.code === "rate" || r.error?.code === "quota" ? 429 : 409,
			);
		if (action === "skip") {
			const r = await this.playerAction("next");
			if (!r.ok) throw failed(r);
			return "Nächster Song.";
		}
		let state: SpPlaybackState | null;
		try {
			state = await this.client(new RequestBudget(3)).player();
		} catch (err) {
			throw failed(this.playError(err));
		}
		const t = state?.item;
		if (!state || !t?.id || t.is_local || (t.type && t.type !== "track"))
			throw new HubError("nothing", "In Spotify läuft gerade kein Song.", 409);
		const song = `„${t.name}“ von ${(t.artists ?? []).map((a) => a.name).join(", ")}`;
		if (action === "like") {
			await this.thumb(t.id, 1);
			return `${song} ist jetzt Favorit.`;
		}
		const r = await this.thumb(t.id, -1, state.is_playing);
		if (!state.is_playing) return `${song} kommt nie wieder.`;
		return r.skipped
			? `${song} kommt nie wieder. Nächster Song.`
			: `${song} kommt nie wieder. Weiterspringen ging nicht: ${r.skipError ?? "Spotify hat abgelehnt."}`;
	}

	async setGuest(on: boolean, hours = GUEST_DEFAULT_HOURS): Promise<void> {
		// Off by hand: the song playing right now is still the guest's. Know it
		// from a look just now, not from one minutes old.
		if (!on && this.inGuest(this.now()) && this.isConnected()) {
			const snap = this.kvGet<PlayerSnapshot>("player");
			if (!snap || this.now() - Math.max(snap.at, this.lastLookAt) > GUEST_TAIL_FRESH_MS) {
				try {
					await this.sync(new RequestBudget(8));
				} catch {
					// Without a look, the play's own times decide (guestPlay).
				}
			}
		}
		const now = this.now();
		let periods = this.guestPeriods().filter((p) => p.to > now - 90 * DAY_MS);
		const open = periods.find((p) => now >= p.from && now < p.to);
		if (on) {
			const to = now + Math.min(48, Math.max(1, hours)) * HOUR_MS;
			if (open) open.to = to;
			else {
				// An earlier guest time's last play still followed: the new one takes over.
				const prev = periods.at(-1)?.last;
				if (prev && prev.over === null) prev.over = now;
				periods.push({ from: now, to });
			}
		} else if (open) {
			open.to = now;
			const snap = this.kvGet<PlayerSnapshot>("player");
			const o = snap?.obs;
			// A look that found the picture unchanged does not store it again.
			if (snap && now - Math.max(snap.at, this.lastLookAt) <= GUEST_TAIL_FRESH_MS) {
				if (!o?.isPlaying || !o.trackId) open.tail = null;
				else if (snap.at + (o.durationMs - o.progressMs) > now) open.tail = o.trackId;
				// Its song must have ended since: the play's own times decide.
			}
		}
		periods = periods.slice(-50);
		this.kvSet("guest", periods);
		this.log(
			"info",
			"guest",
			on ? "Gast-Modus an — nichts zählt ins Gedächtnis" : "Gast-Modus aus",
		);
		// Its end, or the end of the play across it, sets the next look.
		if (this.isConnected()) await this.scheduleNext(new RequestBudget(8));
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

	async state(opts: { live?: boolean; refresh?: boolean } = {}): Promise<AppState> {
		await this.reconcileSharedCooldown();
		await this.reconcileSharedCooldown("artist-albums");
		const profile = this.kvGet<{ id: string; name: string; imageUrl: string | null }>(
			"profile",
		) ?? {
			id: "",
			name: "",
			imageUrl: null,
		};
		if (opts.live && this.isConnected()) {
			const snap = this.kvGet<PlayerSnapshot>("player");
			const now = this.now();
			const checkedAt = this.playerCheckedAt();
			// Reopen/focus within the shared five-second window still asks for a
			// new look. Keep one durable deadline rather than dropping that intent.
			if (opts.refresh && checkedAt !== null && now - checkedAt < 5000) {
				const due = checkedAt + 5000;
				const requested = this.kvGet<number>("player_observation_due");
				if (requested === null || requested > due) this.kvSet("player_observation_due", due);
				await this.scheduleSoon(Math.max(1, due - now));
			}
			const foregroundAt = foregroundObservationDeadline({
				now,
				checkedAt,
				playing: snap?.obs?.isPlaying === true,
				observedAt: snap?.obs?.at,
				durationMs: snap?.obs?.durationMs,
				progressMs: snap?.obs?.progressMs,
				failedAt: this.kvGet<number>("player_failed_at"),
			}).at;
			const refreshAt = opts.refresh ? (checkedAt ?? now - 5000) + 5000 : Infinity;
			const at = this.automaticReadAt(
				"GET /me/player",
				Math.max(
					Math.min(foregroundAt, refreshAt, this.backgroundObservationAt()),
					this.kvGet<number>("player_retry_at") ?? 0,
				),
			);
			if (at <= now) {
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
						? this.providerCooldown()?.until === null
							? "Spotify-Kontingent aufgebraucht — die Warteschlange bleibt gespeichert; der Freigabezeitpunkt ist unbekannt."
							: "Spotify-Kontingent aufgebraucht — die Warteschlange bleibt gespeichert; weitere Anfragen warten bis zur gemeldeten Freigabe."
						: "Spotify bremst gerade — die Warteschlange bleibt gespeichert; true-shuffle wartet auf die Freigabe.",
			});
		}
		if (this.inPrivateNow())
			warnings.push({
				code: "private_session",
				message:
					"Private Sitzung in Spotify — true-shuffle zählt jetzt nur Songs, die es selbst 30 Sekunden laufen sieht, und keine Skips.",
			});
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
					"Spotify-Shuffle ist an — die true-shuffle-Reihenfolge hält erst wieder, wenn es aus ist.",
			});
		}
		// Say it when true-shuffle moved the player on by itself.
		const moved = this.kvGet<{
			id: TrackId;
			at: number;
			why?: string;
			station?: string;
			label?: string;
		}>("moved");
		if (moved?.why && this.now() - moved.at < 3 * MINUTE_MS)
			warnings.push({
				code: "guard",
				message: `Übersprungen auf „${moved.station}“: ${moved.label ?? this.describe(moved.id)} — ${moved.why}`,
			});
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
			session: this.sessionView(),
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
			thumb: (this.liveRow(t[0])?.thumb ?? 0) as -1 | 0 | 1,
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
			const facts = this.songFacts(st.id, next);
			for (const it of next) {
				const t = found.get(it.id);
				if (t) upcoming.push({ ...this.view(t), kind: it.kind, facts: facts(it) });
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
			lane: string | null;
		}>(
			`SELECT played_at, track_id, meta, station_id, ignored, lane FROM plays WHERE played_at < ? ORDER BY played_at DESC LIMIT ?`,
			before ?? Number.MAX_SAFE_INTEGER,
			Math.min(200, Math.max(1, limit)),
		);
		const names = new Map(this.stations().map((s) => [s.id, s.name]));
		const bare = rows.filter((r) => !r.meta).map((r) => r.track_id);
		const index = bare.length > 0 ? this.lookupTracks(bare, this.usedSources()) : new Map();
		this.preloadMemory(new Set(rows.map((r) => r.track_id)));
		return rows
			.map((r) => {
				const t = (r.meta ? (JSON.parse(r.meta) as PackedTrack) : null) ?? index.get(r.track_id);
				if (!t) return null;
				const m = this.memory(r.track_id);
				const entry: HistoryEntry = {
					...this.view(t),
					playedAt: r.played_at,
					stationName: r.station_id !== null ? (names.get(r.station_id) ?? null) : null,
					ignored: r.ignored === 1,
					facts: {
						plays: m.plays,
						lastPlayedAt: m.lastPlayedAt,
						inStation: true,
						// Only the lane stamped when this very play was recorded; plays from
						// before, or recorded in doubt, claim none.
						kind: LANES.has(r.lane as SlotKind) ? (r.lane as SlotKind) : null,
					},
				};
				return entry;
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
		if (this.kvGet("suspended")) return;
		this.kvSet("suspended", 1);
		this.endSessions(); // signed out for good: a cookie from before never works again
	}

	/** On the allowlist (again): background work resumes. */
	async allow(): Promise<void> {
		if (this.kvGet("suspended")) this.kvDel("suspended");
		await this.ensureAlarm();
	}

	/**
	 * Once: playlists made before the owner's spelling of the name get it,
	 * "true-shuffle · Sender" instead of "True Shuffle · Sender".
	 */
	private renameLegacyPlaylists(): void {
		if (this.kvGet("names_v2") !== null) return;
		this.kvSet("names_v2", 1);
		for (const st of this.stations())
			if (st.playlist_id) this.enqueue(`rename:${st.id}`, "rename", { stationId: st.id }, 6);
		if (this.kvGet("discoveries_playlist"))
			this.enqueue("rename:discoveries", "rename-discoveries", {}, 6);
	}

	async alarm(): Promise<void> {
		if (this.kvGet("suspended")) return;
		if (!this.isConnected() && this.kvGet("tokens") === null) return;
		const budget = new RequestBudget(BUDGET_PER_INVOCATION);
		try {
			this.renameLegacyPlaylists();
			// Jobs, player observations and history have independent deadlines.
			if (this.backgroundObservationAt() <= this.now()) await this.sync(budget);
			if (this.historyReadAt() <= this.now()) {
				try {
					await this.freshenMemory(this.client(budget, false, false), true);
				} catch (err) {
					this.handleSyncError(err);
				}
			}
			await this.runJobs(budget);
		} catch (err) {
			this.log("error", "alarm", err instanceof Error ? err.message : String(err));
		} finally {
			await this.scheduleNext(budget);
		}
	}

	/** An independent history deadline cannot force repeated player requests. */
	private historyReadAt(
		active = !!this.operationStates()["GET /me/player"]?.cooldown &&
			this.kvGet<PlayerSnapshot>("player")?.obs?.isPlaying === true,
	): number {
		const checkedAt = this.syncState().lastRecentAt;
		let at = checkedAt + (active ? 90_000 : MAX_RECENT_INTERVAL_MS);
		if (this.kvGet("history_due"))
			at = Math.min(
				at,
				this.kvGet<number>("history_due_at") ?? (this.playerCheckedAt() ?? this.now()) + 1000,
			);
		return this.automaticReadAt(
			"GET /me/player/recently-played",
			Math.max(at, this.kvGet<number>("history_retry_at") ?? 0),
		);
	}

	/** Every interval is anchored to a successful GET, never an unrelated job wake. */
	private backgroundObservationAt(): number {
		const now = this.now();
		const checkedAt = this.playerCheckedAt();
		const base = checkedAt ?? now;
		const candidates: number[] = [];
		const s = this.syncState();
		const snap = this.kvGet<PlayerSnapshot>("player");
		const inDeck = snap?.obs?.contextUri
			? this.stations().some((st) => this.deckUri(st) === snap.obs?.contextUri)
			: false;
		const requested = this.kvGet<number>("player_observation_due");
		if (requested !== null) candidates.push(requested);
		else if (this.kvGet("player_stale")) candidates.push(base + 1000);
		if (snap?.obs?.isPlaying && this.guardedAhead(snap.obs.contextUri))
			candidates.push(base + 20_000);
		if (snap?.obs?.isPlaying && this.olderOrder(snap.obs)) candidates.push(base + 30_000);
		const privately = snap?.obs?.isPlaying === true && this.inPrivateNow();
		if (privately && snap!.obs!.progressMs < 30_000)
			candidates.push(Math.max(base + 15_000, snap!.obs!.at + 32_000 - snap!.obs!.progressMs));
		if (privately) candidates.push(base + 30_000);
		if (this.privateLately()) candidates.push(base + 2 * MINUTE_MS);
		const gp = this.guestPeriods().at(-1);
		if (gp && base < gp.to) candidates.push(gp.to + 2000);
		else if (gp && gp.last === undefined && now - gp.to < 10 * MINUTE_MS)
			candidates.push(base + 15_000);
		const last = this.guestLastOpen() ?? this.guestNextOpen();
		if (last && snap?.obs?.trackId === last.id) {
			const left = snap.obs.durationMs - snap.obs.progressMs;
			if (snap.obs.isPlaying && left > 0)
				candidates.push(Math.max(base + 15_000, snap.obs.at + left + 2000));
			else if (!snap.obs.isPlaying && now - last.to < 6 * HOUR_MS)
				candidates.push(base + 2 * MINUTE_MS);
		}
		let interval: number;
		if (snap?.obs?.isPlaying && (inDeck || privately)) {
			const left = snap.obs.durationMs - snap.obs.progressMs;
			const end = snap.obs.at + left + 1000;
			const aligned =
				snap.obs.durationMs > 0 &&
				left > 0 &&
				base - snap.obs.at <= PLAYER_FRESH_MS &&
				end - base <= 4 * MINUTE_MS;
			interval = aligned ? Math.max(1000, end - base) : 3 * MINUTE_MS;
			if (aligned) candidates.push(Math.max(base + 1000, end));
		} else if (snap?.obs?.isPlaying) interval = 10 * MINUTE_MS;
		else if (this.inPrivateNow() && s.idleSince !== null && base - s.idleSince < 6 * HOUR_MS)
			interval = base - s.idleSince < 30 * MINUTE_MS ? 30_000 : 2 * MINUTE_MS;
		else
			interval =
				this.heldPace(snap, base) ??
				(s.idleSince === null ? 20 * MINUTE_MS : pausedObservationPace(base - s.idleSince));
		const deadline = observationDeadline({
			now,
			checkedAt,
			intervalMs: interval,
			earlierAt: candidates,
			failedAt: this.kvGet<number>("player_failed_at"),
		});
		return this.automaticReadAt(
			"GET /me/player",
			Math.max(deadline.at, this.kvGet<number>("player_retry_at") ?? 0),
		);
	}

	private async scheduleNext(budget: RequestBudget): Promise<void> {
		const now = this.now();
		if (this.kvGet("auth_lost")) {
			await this.d.alarms.set(now + HOUR_MS);
			return;
		}
		const candidates = [this.backgroundObservationAt(), this.historyReadAt()];
		const job =
			this.db.first<{ t: number | null }>(`SELECT MIN(run_after) AS t FROM jobs`)?.t ?? null;
		if (job !== null)
			candidates.push(
				budget.left < 6 && job <= now
					? now + 2000
					: Math.min(Math.max(job, now + 1000), now + HOUR_MS),
			);
		const at = Math.min(...candidates);
		// Unknown operation waits do not generate provider probes. A slow local
		// wake can still discover configuration/auth changes and pending jobs.
		await this.d.alarms.set(Number.isFinite(at) ? (at > now ? at : now + 1000) : now + HOUR_MS);
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
		// In a continued playlist's front (started from the top): today's songs
		// ahead are jumped over, also when the listener skips onto one by hand.
		const front = deck.continued === true && deck.heldAt != null && at < deck.heldAt;
		for (let i = at + 1; i <= at + 3 && i < deck.items.length; i++) {
			const m = this.memory(deck.items[i]!.id);
			if (deck.changedAt?.includes(i) || m.thumb === -1) return true;
			if (front && m.lastPlayedAt !== null && this.now() - m.lastPlayedAt < RECENT_GUARD_MS)
				return true;
		}
		// A song turned down that an older version held, still ahead in it:
		// where a player still in that order meets it is unknown, so it may come
		// any time. Not once true-shuffle started the playlist itself: that
		// replaced the order the player had (a second device is out of sight).
		if ((deck.continued === true || deck.ours !== true) && deck.formerOff?.length) {
			const former = formerNow(deck, this.now());
			if (deck.formerOff.some((id) => former.has(id))) return true;
		}
		return false;
	}

	/** Ordinary pauses slow down; legacy recently-heard fronts retain their guard. */
	private heldPace(snap: PlayerSnapshot | null, checkedAt: number): number | null {
		const uri = snap?.obs ? snap.obs.contextUri : this.kvGet<string>("last_context");
		if (!uri) return null;
		const st = this.stations().find((x) => this.deckUri(x) === uri);
		if (!st) return null;
		const active = Math.max(
			this.kvGet<Record<string, number>>("deck_activity")?.[String(st.id)] ?? 0,
			st.last_played_at ?? 0,
		);
		const deck = this.deckOf(st);
		// A resumed old order or a restart from the top can reach any held
		// turned-down song. Keep the guard responsive even after a long pause.
		if (
			deck &&
			(this.guardedAhead(uri) ||
				this.db.first(
					`SELECT 1 FROM json_each(?) held JOIN memory ON memory.id = held.value
					 WHERE memory.thumb = -1 LIMIT 1`,
					JSON.stringify([...deck.items.map((it) => it.id), ...(deck.formerOff ?? [])]),
				))
		)
			return 20_000;
		return pausedObservationPace(checkedAt - active, (deck?.frontHeardUntil ?? 0) > this.now());
	}

	/** Explicit Sync queues observations even when the ordinary cache is fresh. */
	async requestSync(): Promise<void> {
		const now = this.now();
		for (const key of ["player_observation_due", "history_due_at"]) {
			const due = this.kvGet<number>(key);
			if (due === null || due > now) this.kvSet(key, now);
		}
		this.kvSet("history_due", 1);
		await this.scheduleSoon(0);
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
	/** When this import read its first page. */
	startedAt?: number;
	offset?: number;
	skipped?: number;
	count?: number;
	snapshot?: string | null;
	total?: number;
}

/** Songs of earlier versions a player may still hold, as of `now`. */
function formerNow(deck: Deck, now: number): Set<TrackId> {
	return new Set((deck.former ?? []).filter(([, until]) => until > now).map(([id]) => id));
}

/** Equal but for the moment of the last look at the player. */
export function sameDeck(a: Deck, b: Deck): boolean {
	// Each look moves its own time, and where it puts the song's end by a few
	// milliseconds: only a pause or a seek moves the end by more.
	const endA = a.lastEndAt ?? null;
	const endB = b.lastEndAt ?? null;
	const sameEnd =
		endA === endB || (endA !== null && endB !== null && Math.abs(endA - endB) < 1_000);
	return (
		sameEnd &&
		JSON.stringify({ ...a, lastObservedAt: null, lastEndAt: null }) ===
			JSON.stringify({ ...b, lastObservedAt: null, lastEndAt: null })
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
