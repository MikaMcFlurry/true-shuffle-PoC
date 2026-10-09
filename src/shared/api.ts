/**
 * Wire types between the Worker API and the Preact client.
 */

import type { SlotKind, StationRules } from "../core/types";

export type StationKind = "playlist" | "all" | "custom";

export type StationSource = { type: "playlist"; id: string } | { type: "liked" };

export interface StationSummary {
	id: number;
	name: string;
	kind: StationKind;
	sources: StationSource[];
	rules: StationRules;
	roundNo: number;
	poolSize: number | null;
	freshRemaining: number | null;
	/** Heard share of the current round, 0..1, or null before the first deck. */
	progress: number | null;
	playlistId: string | null;
	ready: boolean;
	importing: boolean;
	lastPlayedAt: number | null;
	playing: boolean;
	imageUrl: string | null;
}

export interface TrackView {
	id: string;
	name: string;
	artists: string;
	album: string;
	imageUrl: string | null;
	durationMs: number;
	/** Thumb in true-shuffle: -1 never again, 1 favourite, 0 none. */
	thumb: -1 | 0 | 1;
}

export interface NowPlaying extends TrackView {
	isPlaying: boolean;
	progressMs: number;
	stationId: number | null;
	kind: SlotKind | null;
	deviceName: string | null;
	orderBroken: boolean;
	smartShuffle: boolean;
	thumb: -1 | 0 | 1;
	observedAt: number;
}

export interface Warning {
	code: string;
	message: string;
}

export interface JobView {
	key: string;
	label: string;
	done: number | null;
	total: number | null;
	error: string | null;
}

/**
 * Read-only labels for one song in a queue, so the listener can see whether
 * it is new to them, new to this station, or how often they have heard it.
 * Derived from stored memory only — never from a Spotify request.
 */
export interface SongFacts {
	/**
	 * Counted plays (>= 30 s) known for this song in total: live true-shuffle
	 * plays (any station or outside a station, guest-mode plays excluded) plus
	 * plays from an imported Spotify streaming history (which only covers time
	 * before true-shuffle started counting live, so nothing is counted twice).
	 */
	plays: number;
	/** Last counted play anywhere, live or imported, or null if never heard. */
	lastPlayedAt: number | null;
	/**
	 * A non-guest play on this station is in the plays log. The log keeps at
	 * least the last 180 days, so `false` means "not here in half a year".
	 */
	inStation: boolean;
	/** Why the planner put it here, when known. */
	kind: SlotKind | null;
}

export interface SessionView {
	controller?: { kind: "spotify" | "home-assistant"; deviceId: string; deviceName?: string };
	sessionId: string;
	stationId: number;
	entryId: string;
	orderRevision: number;
	progressMs: number | null;
	observedAt: number | null;
	status: "active" | "paused" | "disconnected" | "external" | "ambiguous" | "saved";
	pending: boolean;
	queue: { entryId: string; track: TrackView; facts?: SongFacts }[];
}

export interface AppState {
	session?: SessionView | null;
	profile: { id: string; name: string; imageUrl: string | null };
	onboarded: boolean;
	stations: StationSummary[];
	nowPlaying: NowPlaying | null;
	guest: {
		active: boolean;
		until: number | null;
		/** Devices whose music never counts, as if guest mode were on. */
		devices?: { id: string; name: string }[];
		/** Name of the guest device that holds guest time open right now, if any. */
		device?: string | null;
	};
	warnings: Warning[];
	jobs: JobView[];
	/** `liveSince`: from here on true-shuffle counts live; an import covers what came before. */
	history: { importedTracks: number; importedAt: number | null; liveSince: number | null };
	aiSource: "anthropic" | "workers-ai" | "off";
	serverTime: number;
}

export interface PlaylistView {
	id: string;
	name: string;
	ownerName: string | null;
	imageUrl: string | null;
	total: number | null;
	readable: boolean;
	imported: boolean;
	importedCount: number | null;
	skippedCount: number | null;
}

export interface StationDetail extends StationSummary {
	upcoming: (TrackView & { kind: SlotKind; facts?: SongFacts })[];
	recent: (TrackView & { playedAt: number })[];
	counts: Record<SlotKind, number> | null;
	discoveries: { pending: number; kept: number; rejected: number };
}

export interface HistoryEntry extends TrackView {
	playedAt: number;
	stationName: string | null;
	ignored: boolean;
	/**
	 * Same read-only counts as in a queue. `kind` is always null: the lane
	 * that brought a play is not recorded per play, so no source is claimed.
	 * `inStation` is always true: the song was heard there.
	 */
	facts?: SongFacts;
}

/** What a personal remote key can do (Siri, CarPlay, a watch, a widget). */
export type RemoteAction = "like" | "dislike" | "skip";

export interface RemoteKeyView {
	/** The key itself, or null when none is set up. */
	key: string | null;
	createdAt: number | null;
	usedAt: number | null;
}

export interface DeviceView {
	id: string;
	name: string;
	type: string;
	active: boolean;
	restricted: boolean;
}

export type PlayErrorCode =
	| "premium"
	| "no_device"
	| "restricted"
	| "not_ready"
	| "empty"
	| "rate"
	| "quota"
	| "auth"
	| "unknown";

export interface PlayResult {
	/** Transport outcome cannot be established from a lost or server-error response. */
	uncertain?: boolean;
	ok: boolean;
	/** Server time of a successful provider acknowledgment, not a playback observation. */
	acceptedAt?: number;
	error?: { code: PlayErrorCode; message: string };
	deviceName?: string;
}

export interface ApiError {
	error: { code: string; message: string };
}
