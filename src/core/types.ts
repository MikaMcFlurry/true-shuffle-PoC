/**
 * Domain vocabulary shared by the Worker, the Durable Object and the client.
 * Pure data — no I/O, no platform types.
 */

export type TrackId = string;

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/** What Spotify counts as a stream — and what its recently-played list records. */
export const PLAY_THRESHOLD_MS = 30_000;

export interface ArtistRef {
	id: string;
	name: string;
}

export interface TrackMeta {
	id: TrackId;
	name: string;
	artists: ArtistRef[];
	albumName: string;
	imageUrl: string | null;
	durationMs: number;
}

/**
 * The listener's memory of one song. Global across every station: a song
 * heard yesterday on "Rock" is just as fresh in memory on "Alles" today.
 */
export interface TrackMemory {
	id: TrackId;
	/** Last counted play (>= 30 s), live or imported. `null` = never heard. */
	lastPlayedAt: number | null;
	/** Counted plays (>= 30 s). */
	plays: number;
	/** Skips under 30 s. They lower the weight; three make a song rare. */
	earlySkips: number;
	lastSkippedAt: number | null;
	/**
	 * Used up for the round by an early skip seen under the `consume` rule —
	 * never by one only inferred between two looks at the player.
	 */
	consumedAt?: number | null;
	/** In the listener's Spotify "Lieblingssongs". */
	liked: boolean;
	/** Thumb in True Shuffle: -1 = never again, 0 = none, 1 = favourite. */
	thumb: -1 | 0 | 1;
}

export function emptyMemory(id: TrackId): TrackMemory {
	return {
		id,
		lastPlayedAt: null,
		plays: 0,
		earlySkips: 0,
		lastSkippedAt: null,
		liked: false,
		thumb: 0,
	};
}

/** Why a card is in the queue — shown to the listener as a small label. */
export type SlotKind = "fresh" | "favorite" | "discovery";

export interface PlannedSlot {
	trackId: TrackId;
	kind: SlotKind;
}

export type SkipPolicy = "later_less" | "consume" | "ban";

/**
 * Per-station rules. `mix` is the one control most people will ever touch:
 * 0 = maximal discovery, 100 = maximal familiarity. Everything else lives
 * behind "Erweitert".
 */
export interface StationRules {
	mix: number;
	favoriteCooldownDays: number;
	/** Overrides the favourite share derived from `mix` (0..1), or null. */
	favoriteShare: number | null;
	skipPolicy: SkipPolicy;
	discoveryEnabled: boolean;
	/** Minimum number of other songs between two songs of the same artist. */
	artistSpacing: number;
}

/** "Entdecker" — the owner's chosen default (≈ 60 / 10 / 30). */
export const DEFAULT_RULES: StationRules = {
	mix: 25,
	favoriteCooldownDays: 7,
	favoriteShare: null,
	skipPolicy: "later_less",
	discoveryEnabled: true,
	artistSpacing: 4,
};

export function normaliseRules(input: Partial<StationRules> | null | undefined): StationRules {
	const r = { ...DEFAULT_RULES, ...(input ?? {}) };
	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
	return {
		mix: clamp(Math.round(Number(r.mix) || 0), 0, 100),
		favoriteCooldownDays: clamp(Number(r.favoriteCooldownDays) || 0, 0, 365),
		favoriteShare:
			r.favoriteShare === null || r.favoriteShare === undefined
				? null
				: clamp(Number(r.favoriteShare), 0, 1),
		skipPolicy: (["later_less", "consume", "ban"] as const).includes(r.skipPolicy)
			? r.skipPolicy
			: "later_less",
		discoveryEnabled: Boolean(r.discoveryEnabled),
		artistSpacing: clamp(Math.round(Number(r.artistSpacing) || 0), 0, 20),
	};
}
