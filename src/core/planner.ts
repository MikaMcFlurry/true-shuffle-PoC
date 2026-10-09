/**
 * The queue planner — decides the next N songs of a station.
 *
 * It is rebuilt from memory every time, never "reshuffled": the same
 * queue cannot come back, because everything that was heard is remembered
 * and everything that is chosen is chosen with fresh randomness.
 *
 * Guarantees, each covered by tests:
 *  - a song appears at most once per queue;
 *  - blocked songs (thumb down, station ban) never appear;
 *  - nothing heard in the last 24 h appears;
 *  - nothing skipped early in the last 24 h appears while anything else is
 *    left — and never with `allowCooling: false`;
 *  - songs not yet heard in the current round come before any song of the
 *    next round ("every song eventually");
 *  - favourites repeat only after their cooldown;
 *  - the fresh / favourite / discovery shares follow the mix, and unused
 *    share flows to whatever is still available;
 *  - songs by the same artist are spread apart when the pool allows it;
 *  - with `retestEnabled`, one song early skips keep rare is placed on
 *    purpose every PROBE_EVERY places (kind "probe", outside the shares).
 */

import {
	coolingDown,
	favoriteReady,
	heardInRound,
	isBlocked,
	isFavorite,
	lastNo,
	probeDue,
	stalenessBoost,
	tasteWeight,
} from "./memory";
import { type MixShares, sharesForRules } from "./mix";
import { type Rng, weightedShuffle } from "./random";
import {
	DAY_MS,
	type PlannedSlot,
	type SlotKind,
	type StationRules,
	type TrackId,
	type TrackMemory,
} from "./types";

/** One retest ("Nachprüfung") every this many places, at the PROBE_AT-th of each. */
export const PROBE_EVERY = 30;
export const PROBE_AT = 14;

export interface PoolEntry {
	id: TrackId;
	/** Primary artist, used to spread artists apart. */
	artistId: string;
}

export interface DiscoveryEntry extends PoolEntry {
	/** Source confidence in (0, 1]. */
	score: number;
}

export interface PlanInput {
	now: number;
	roundStartedAt: number;
	rules: StationRules;
	pool: readonly PoolEntry[];
	memory: (id: TrackId) => TrackMemory;
	banned: ReadonlySet<TrackId>;
	discoveries: readonly DiscoveryEntry[];
	size: number;
	rng: Rng;
	/**
	 * Songs that are already placed elsewhere in the deck (kept from the
	 * previous version): never chosen again, but still part of the station —
	 * they count for the round like every other song.
	 */
	exclude?: ReadonlySet<TrackId>;
	/**
	 * May songs skipped early in the last 24 h fill up the end when nothing
	 * else is left? Default yes — a small station must still play when the
	 * listener starts it; no for a deck rewritten in the background.
	 */
	allowCooling?: boolean;
}

export interface PlanResult {
	slots: PlannedSlot[];
	/** Songs of the pool not yet heard in this round (excluding blocked ones). */
	freshRemaining: number;
	/** Songs in the pool that may play at all (excluding blocked ones). */
	poolSize: number;
	/** How many slots came from each source. */
	counts: Record<SlotKind, number>;
	/** Slots filled from the next round because this round ran out. */
	overflow: number;
	shares: MixShares;
}

/** How far ahead the planner looks for a song that keeps artists apart. */
const SPACING_LOOKAHEAD = 60;

interface Candidate {
	id: TrackId;
	artistId: string;
	overflow?: boolean;
}

export function planQueue(input: PlanInput): PlanResult {
	const { now, roundStartedAt, rules, rng } = input;
	const policy = rules.skipPolicy;

	const fresh: Candidate[] = [];
	const freshCooling: Candidate[] = [];
	const favorites: Candidate[] = [];
	const nextRound: Candidate[] = [];
	const memo = new Map<TrackId, TrackMemory>();
	const candidates = new Map<TrackId, Candidate>();

	const seen = new Set<TrackId>();
	let poolSize = 0;
	for (const entry of input.pool) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		const m = input.memory(entry.id);
		if (isBlocked(m, input.banned)) continue;
		poolSize++;
		memo.set(entry.id, m);
		const c: Candidate = { id: entry.id, artistId: entry.artistId };
		candidates.set(entry.id, c);
		const cooling = coolingDown(m, now);
		if (!heardInRound(m, roundStartedAt, policy)) {
			(cooling ? freshCooling : fresh).push(c);
		} else if (!cooling) {
			if (isFavorite(m)) {
				// A favourite inside its cooldown waits — also as overflow.
				if (favoriteReady(m, now, rules)) favorites.push(c);
			} else {
				nextRound.push({ ...c, overflow: true });
			}
		}
	}

	const mem = (id: TrackId) => memo.get(id)!;

	const freshOrdered = weightedShuffle(
		fresh,
		(c) => tasteWeight(mem(c.id), policy, now) * stalenessBoost(mem(c.id), now),
		rng,
	);
	const favoritesOrdered = weightedShuffle(
		favorites,
		(c) => {
			const m = mem(c.id);
			const days = m.lastPlayedAt === null ? 60 : (now - m.lastPlayedAt) / DAY_MS;
			return tasteWeight(m, policy, now) * (1 + Math.min(1, days / 60));
		},
		rng,
	);
	const nextRoundOrdered = weightedShuffle(
		nextRound,
		(c) => {
			const m = mem(c.id);
			const days = m.lastPlayedAt === null ? 30 : (now - m.lastPlayedAt) / DAY_MS;
			return tasteWeight(m, policy, now) * (1 + days / 7);
		},
		rng,
	);
	const coolingOrdered = weightedShuffle(
		freshCooling,
		(c) => tasteWeight(mem(c.id), policy, now),
		rng,
	);

	const discoveryCandidates: Candidate[] = [];
	if (rules.discoveryEnabled) {
		const ordered = weightedShuffle(
			input.discoveries.filter((d) => {
				if (seen.has(d.id)) return false;
				const m = input.memory(d.id);
				return !isBlocked(m, input.banned) && !coolingDown(m, now);
			}),
			(d) => Math.max(0.01, d.score),
			rng,
		);
		for (const d of ordered) discoveryCandidates.push({ id: d.id, artistId: d.artistId });
	}

	// Retests ("Nachprüfung"): songs early skips keep rare, played now and then
	// on purpose; those heard often before come first, then the long unasked.
	const probes: Candidate[] =
		rules.retestEnabled && policy !== "consume"
			? weightedShuffle(
					[...memo.entries()]
						.filter(([, m]) => !coolingDown(m, now) && probeDue(m, now))
						.map(([id]) => ({ ...candidates.get(id)!, overflow: false })),
					(c) => {
						const m = mem(c.id);
						const no = lastNo(m);
						const months = no === null ? 12 : Math.min(12, (now - no) / (30 * DAY_MS));
						return (1 + Math.min(50, m.plays)) * (1 + months);
					},
					rng,
				)
			: [];

	// The fresh lane continues into the next round once this round is used up:
	// nothing of the next round is ever placed before a song of this round.
	const lanes: Record<SlotKind, Candidate[]> = {
		fresh: [
			...freshOrdered,
			...nextRoundOrdered,
			...(input.allowCooling === false ? [] : coolingOrdered),
		],
		favorite: favoritesOrdered,
		discovery: discoveryCandidates,
		probe: probes,
	};

	const shares = sharesForRules(rules);
	const taken: Record<SlotKind, number> = { fresh: 0, favorite: 0, discovery: 0, probe: 0 };
	const kinds: Exclude<SlotKind, "probe">[] = ["fresh", "favorite", "discovery"];
	const used = new Set<TrackId>();
	const recentArtists: string[] = [];
	const slots: PlannedSlot[] = [];
	let overflow = 0;

	// Songs placed elsewhere in the deck are never picked twice.
	for (const id of input.exclude ?? []) used.add(id);

	for (let i = 0; slots.length < input.size; i++) {
		// One retest every PROBE_EVERY places, outside the mix's shares.
		if (slots.length % PROBE_EVERY === PROBE_AT && lanes.probe.length > 0) {
			const pick = takeSpaced(lanes.probe, recentArtists, rules.artistSpacing, used);
			if (pick) {
				used.add(pick.id);
				taken.probe++;
				slots.push({ trackId: pick.id, kind: "probe" });
				if (rules.artistSpacing > 0) {
					recentArtists.push(pick.artistId);
					if (recentArtists.length > rules.artistSpacing) recentArtists.shift();
				}
				continue;
			}
			lanes.probe = [];
		}
		// Deficit round robin: the lane furthest behind its share goes next. A
		// lane that ran dry hands its share to the others in proportion, so
		// "Vertraut" without favourites yet does not turn into discoveries.
		let best: Exclude<SlotKind, "probe"> | null = null;
		let bestDeficit = Number.NEGATIVE_INFINITY;
		const live = kinds.filter((k) => lanes[k].length > 0 && shares[k] > 0);
		const liveShare = live.reduce((sum, k) => sum + shares[k], 0);
		for (const k of kinds) {
			if (lanes[k].length === 0) continue;
			const share = liveShare > 0 && shares[k] > 0 ? shares[k] / liveShare : shares[k];
			const deficit = share * (slots.length + 1) - taken[k];
			// Lanes with a zero share only step in when nothing else is left.
			const adjusted = share === 0 ? deficit - 1e6 : deficit;
			if (adjusted > bestDeficit) {
				bestDeficit = adjusted;
				best = k;
			}
		}
		if (best === null) break;

		const lane = lanes[best];
		const pick = takeSpaced(lane, recentArtists, rules.artistSpacing, used);
		if (!pick) {
			lanes[best] = [];
			continue;
		}
		used.add(pick.id);
		taken[best]++;
		if (pick.overflow) overflow++;
		slots.push({ trackId: pick.id, kind: best });
		if (rules.artistSpacing > 0) {
			recentArtists.push(pick.artistId);
			if (recentArtists.length > rules.artistSpacing) recentArtists.shift();
		}
		if (i > input.size * 4 + 1000) break; // defensive: cannot loop forever
	}

	return {
		slots,
		freshRemaining: fresh.length + freshCooling.length,
		poolSize,
		counts: taken,
		overflow,
		shares,
	};
}

/**
 * Remove and return the first candidate of `lane` whose artist is not among
 * the recent ones. Falls back to the front of the lane when no spaced
 * candidate exists within the lookahead — a small pool must still play.
 */
function takeSpaced(
	lane: Candidate[],
	recentArtists: readonly string[],
	spacing: number,
	used: ReadonlySet<TrackId>,
): Candidate | null {
	// Drop anything already placed (a song can sit in two lanes at most in
	// theory; never twice in one queue).
	while (lane.length > 0 && used.has(lane[0]!.id)) lane.shift();
	if (lane.length === 0) return null;
	if (spacing > 0 && recentArtists.length > 0) {
		const limit = Math.min(lane.length, SPACING_LOOKAHEAD);
		for (let j = 0; j < limit; j++) {
			const c = lane[j]!;
			if (used.has(c.id)) continue;
			if (!recentArtists.includes(c.artistId)) {
				lane.splice(j, 1);
				return c;
			}
		}
	}
	return lane.shift() ?? null;
}
