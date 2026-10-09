/**
 * What the listener's history says about a song: is it a favourite, how
 * strongly should it be weighted, may it play right now?
 *
 * Every rule here is a pure function of the memory and the clock, so the
 * planner stays testable and the numbers stay explainable in the interface.
 */

import {
	DAY_MS,
	HOUR_MS,
	type SkipPolicy,
	type StationRules,
	type TrackId,
	type TrackMemory,
} from "./types";

/** Early skips after which a song is "kaum noch" (barely ever) played. */
export const RARE_AFTER_EARLY_SKIPS = 3;

/**
 * A skipped song is asked about again: after a month for the first early
 * skip, twice as long for each further one, at most a year.
 */
export const RETEST_FIRST_MS = 30 * DAY_MS;
export const RETEST_MAX_MS = 365 * DAY_MS;

export function retestAfter(earlySkips: number): number {
	return Math.min(
		RETEST_MAX_MS,
		RETEST_FIRST_MS * 2 ** (Math.min(Math.max(1, earlySkips), 16) - 1),
	);
}

/**
 * Do early skips still lower the song? Only while the last word on it is a
 * skip, and only until its next check is due: then it plays like any other
 * song once more. Heard to 30 s or more since, the skips stop counting; one
 * skipped again counts again, and its next check is twice as far off. Skips
 * of unknown date (an import from before this rule) keep counting until
 * the history is imported again.
 */
export function skipsWeigh(m: TrackMemory, now: number): boolean {
	if (m.earlySkips <= 0) return false;
	if (m.lastSkippedAt === null) return true;
	if (m.lastPlayedAt !== null && m.lastPlayedAt > m.lastSkippedAt) return false;
	return now - m.lastSkippedAt < retestAfter(m.earlySkips);
}

/** A song skipped early is "nicht jetzt": kept out of decks for this long. */
export const NOT_NOW_MS = 24 * HOUR_MS;

/**
 * Nothing that was heard this recently comes back, whatever the round says.
 * This is what stops a freshly started round from replaying the songs that
 * just finished the previous one.
 */
export const RECENT_GUARD_MS = 24 * HOUR_MS;

/** Plays after which a rarely-skipped song counts as "known and liked". */
export const FAMILIAR_PLAYS = 5;

/**
 * Favourite = the listener has told us (thumb up, Spotify heart) or their
 * behaviour has (played often, hardly ever skipped).
 */
export function isFavorite(m: TrackMemory): boolean {
	if (m.thumb === -1) return false;
	if (m.thumb === 1 || m.liked) return true;
	return m.plays >= FAMILIAR_PLAYS && m.earlySkips <= m.plays * 0.2;
}

/** Hard exclusions: thumb down or a per-station ban. */
export function isBlocked(m: TrackMemory, banned: ReadonlySet<TrackId>): boolean {
	return m.thumb === -1 || banned.has(m.id);
}

/**
 * Taste weight in (0, ~4]. Under the `consume` skip policy a skip says
 * nothing about taste, so skips are ignored there; elsewhere only while
 * they weigh (see `skipsWeigh`).
 */
export function tasteWeight(m: TrackMemory, policy: SkipPolicy, now: number): number {
	let w = 1;
	if (m.thumb === 1) w *= 2;
	if (m.liked) w *= 1.5;
	if (m.plays >= FAMILIAR_PLAYS && m.earlySkips <= m.plays * 0.2) w *= 1.3;
	if (policy !== "consume" && skipsWeigh(m, now)) {
		if (m.earlySkips >= RARE_AFTER_EARLY_SKIPS) w *= 0.03;
		else if (m.earlySkips > 0) w *= 0.5 ** m.earlySkips;
	}
	return w;
}

/** Longer unheard ⇒ earlier. Never heard gets the strongest pull. */
export function stalenessBoost(m: TrackMemory, now: number): number {
	if (m.lastPlayedAt === null) return 1.6;
	const days = Math.max(0, (now - m.lastPlayedAt) / DAY_MS);
	return 1 + Math.min(0.6, days / 180);
}

/** Heard in this round? (The round is what "every song eventually" counts.) */
export function heardInRound(m: TrackMemory, roundStartedAt: number, policy: SkipPolicy): boolean {
	if (m.lastPlayedAt !== null && m.lastPlayedAt >= roundStartedAt) return true;
	// Under `consume`, an early skip (seen, not inferred) uses up the song for this round.
	if (policy === "consume" && m.consumedAt != null && m.consumedAt >= roundStartedAt) {
		return true;
	}
	return false;
}

/** Temporarily off-limits: heard very recently, or skipped very recently. */
export function coolingDown(m: TrackMemory, now: number): boolean {
	if (m.lastPlayedAt !== null && now - m.lastPlayedAt < RECENT_GUARD_MS) return true;
	if (m.lastSkippedAt !== null && now - m.lastSkippedAt < NOT_NOW_MS) return true;
	return false;
}

/** A favourite may repeat only after its cooldown (default one week). */
export function favoriteReady(m: TrackMemory, now: number, rules: StationRules): boolean {
	if (m.lastPlayedAt === null) return true;
	return now - m.lastPlayedAt >= rules.favoriteCooldownDays * DAY_MS;
}

/** Record a counted play (>= 30 s). Idempotence is the caller's job. */
export function withPlay(m: TrackMemory, playedAt: number): TrackMemory {
	return {
		...m,
		plays: m.plays + 1,
		lastPlayedAt: m.lastPlayedAt === null ? playedAt : Math.max(m.lastPlayedAt, playedAt),
	};
}

/** Record an early skip (< 30 s). */
export function withEarlySkip(m: TrackMemory, at: number): TrackMemory {
	return {
		...m,
		earlySkips: m.earlySkips + 1,
		lastSkippedAt: m.lastSkippedAt === null ? at : Math.max(m.lastSkippedAt, at),
	};
}

/** Undo a skip that turned out to be a play reported late by Spotify. */
export function withoutEarlySkip(m: TrackMemory): TrackMemory {
	return { ...m, earlySkips: Math.max(0, m.earlySkips - 1) };
}

/** Merge live memory with imported history (sums and maxima). */
export function mergeMemory(live: TrackMemory, imported: ImportedStats | undefined): TrackMemory {
	if (!imported) return live;
	const last =
		live.lastPlayedAt === null
			? imported.lastPlayedAt
			: imported.lastPlayedAt === null
				? live.lastPlayedAt
				: Math.max(live.lastPlayedAt, imported.lastPlayedAt);
	const skipped = [live.lastSkippedAt, imported.lastSkippedAt ?? null].filter(
		(x): x is number => x !== null,
	);
	return {
		...live,
		plays: live.plays + imported.plays,
		earlySkips: live.earlySkips + imported.earlySkips,
		lastPlayedAt: last,
		// The import ends where live counting begins: a live date is the later one.
		// Imported skips of unknown date and none live leave it unknown (see skipsWeigh).
		lastSkippedAt: skipped.length > 0 ? Math.max(...skipped) : null,
	};
}

/** Aggregated stats for one track from a Spotify streaming-history export. */
export interface ImportedStats {
	plays: number;
	earlySkips: number;
	lastPlayedAt: number | null;
	/** Absent in an import from before skips were dated. */
	lastSkippedAt?: number | null;
}
