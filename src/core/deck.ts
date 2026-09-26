/**
 * Deck progress — what happened to the songs we wrote into a station's
 * Spotify playlist.
 *
 * Two sources of truth, and neither is trusted alone:
 *  - the player (`GET /me/player`): where in our playlist the listener is
 *    right now. Moving from item 3 to item 5 means item 4 was passed.
 *  - the recently-played list: Spotify records a song only after 30 s, so a
 *    passed song that never shows up there was skipped early.
 *
 * Nothing here moves on a timer and nothing counts a song that was not
 * observed; memory (plays) is recorded from the recently-played list only.
 */

import { MINUTE_MS, type SlotKind, type TrackId } from "./types";

export type DeckItemState = "pending" | "passed" | "played" | "skipped";

export interface DeckItem {
	id: TrackId;
	kind: SlotKind;
	state: DeckItemState;
	/** When the state last changed. */
	at: number | null;
	/**
	 * It was seen playing before it was left. A song passed only by inference
	 * (between two looks) may be booked as "not now", never as banned or used up.
	 */
	seen?: boolean;
}

export interface Deck {
	/** Increments with every rewrite of the playlist. */
	version: number;
	items: DeckItem[];
	writtenAt: number;
	/** Last index observed in the player for this version, or null. */
	lastIndex: number | null;
	/** The song seen at `lastIndex` — the only position we know was reached. */
	lastTrackId?: TrackId | null;
	/**
	 * That song was playing when seen. A song last seen paused and later
	 * replaced (Spotify resuming with something else after a stop) was not
	 * skipped by the listener.
	 */
	lastPlaying?: boolean;
	lastObservedAt: number | null;
	/**
	 * Spotify plays exactly this order: True Shuffle started it, or this
	 * version continues one it started (whatever a player had loaded goes on
	 * the same way). Only then do positions between two looks at the player
	 * prove anything; otherwise only a song seen playing can count as left.
	 */
	ours?: boolean;
	/** Just started by True Shuffle at its first song; nothing seen since. */
	top?: boolean;
	/** Built as a continuation of the previous version. */
	continued?: boolean;
	/**
	 * Index at which a player still holds the previous version (paused). The
	 * songs after it were kept at their places, so resuming by position and
	 * resuming the loaded order play the same songs.
	 */
	heldAt?: number | null;
}

/** Where the player is (or was last seen) in this version. */
export function position(deck: Deck): number | null {
	return deck.lastIndex ?? deck.heldAt ?? null;
}

export interface PlayerObservation {
	at: number;
	contextUri: string | null;
	trackId: TrackId | null;
	isPlaying: boolean;
	progressMs: number;
	durationMs: number;
	shuffle: boolean;
	smartShuffle: boolean;
}

export interface RecentPlay {
	trackId: TrackId;
	playedAt: number;
	contextUri: string | null;
}

/**
 * A forward move over more than this many items is a deliberate jump (the
 * listener tapped a song further down), not a run of skips.
 */
export const MAX_SKIP_GAP = 10;

/**
 * How long a passed song waits for its play to appear in recently-played
 * before it is booked as an early skip. Spotify's list can lag.
 */
export const SKIP_GRACE_MS = 20 * MINUTE_MS;

export function newDeck(
	ids: readonly { trackId: TrackId; kind: SlotKind }[],
	version: number,
	now: number,
): Deck {
	return {
		version,
		items: ids.map((s) => ({ id: s.trackId, kind: s.kind, state: "pending", at: null })),
		writtenAt: now,
		lastIndex: null,
		lastTrackId: null,
		lastObservedAt: null,
		ours: false,
		top: false,
		continued: false,
		heldAt: null,
	};
}

export interface ObserveResult {
	deck: Deck;
	/** The player is inside our playlist. */
	inDeck: boolean;
	/** Index of the current song in the deck, if it is one of ours. */
	index: number | null;
	/** The service is re-ordering our playlist (shuffle / smart shuffle). */
	orderBroken: boolean;
	/** Items newly marked as passed. */
	passed: TrackId[];
}

/** Read one player snapshot against the deck. */
export function observePlayer(deck: Deck, obs: PlayerObservation, deckUri: string): ObserveResult {
	const base: ObserveResult = {
		deck,
		inDeck: false,
		index: null,
		orderBroken: false,
		passed: [],
	};
	if (obs.contextUri !== deckUri || obs.trackId === null) return base;
	const orderBroken = obs.shuffle || obs.smartShuffle;
	const idx = deck.items.findIndex((it) => it.id === obs.trackId);
	const prev = deck.lastIndex;
	// Left by the listener: seen playing, and now another song plays.
	const seenPrev =
		prev !== null &&
		deck.lastTrackId != null &&
		deck.items[prev]?.id === deck.lastTrackId &&
		deck.lastPlaying === true &&
		obs.isPlaying;
	if (idx < 0) {
		// A song that is not in this version (the listener's own queue, or an
		// order Spotify loaded before a rewrite). The song we saw before it has
		// been left all the same; positions stay where they were.
		if (seenPrev && obs.trackId !== deck.lastTrackId && deck.items[prev]!.state === "pending") {
			const items = deck.items.slice();
			items[prev] = { ...items[prev]!, state: "passed", at: obs.at, seen: true };
			return {
				...base,
				inDeck: true,
				orderBroken,
				passed: [items[prev]!.id],
				deck: { ...deck, items, lastObservedAt: obs.at },
			};
		}
		return { ...base, inDeck: true, orderBroken };
	}
	// Positions between two looks mean something only while it plays on.
	if (orderBroken) {
		// Positions mean nothing while the service shuffles — infer nothing,
		// and trust the order again only once it is seen to hold.
		return {
			...base,
			inDeck: true,
			index: idx,
			orderBroken,
			deck: {
				...deck,
				lastIndex: idx,
				lastTrackId: obs.trackId,
				lastPlaying: obs.isPlaying,
				lastObservedAt: obs.at,
				ours: false,
				top: false,
			},
		};
	}
	// What do we actually know was reached? Either the song we saw last time
	// (still at that index in this version), or the top, when we started it.
	const ours = deck.ours === true && obs.isPlaying;
	const fromTop = prev === null && ours && deck.top === true;

	const items = deck.items.slice();
	const passed: TrackId[] = [];
	const pass = (i: number) => {
		const it = items[i]!;
		if (it.state === "pending") {
			items[i] = { ...it, state: "passed", at: obs.at, seen: seenPrev && i === prev };
			passed.push(it.id);
		}
	};
	const anchor = seenPrev ? prev : fromTop ? -1 : null;
	if (anchor !== null && idx > anchor) {
		const gap = idx - anchor - 1;
		if (ours && gap <= MAX_SKIP_GAP) {
			// In our order: the song we saw and everything up to the current one
			// is behind us.
			for (let i = Math.max(anchor, 0); i < idx; i++) pass(i);
		} else if (seenPrev) {
			// A long jump, or an order we cannot trust: only the song we
			// actually saw playing was left behind.
			pass(prev);
		}
	}
	return {
		deck: {
			...deck,
			items,
			lastIndex: idx,
			lastTrackId: obs.trackId,
			lastPlaying: obs.isPlaying,
			lastObservedAt: obs.at,
			top: false,
		},
		inDeck: true,
		index: idx,
		orderBroken: false,
		passed,
	};
}

export interface PlaysResult {
	deck: Deck;
	/** Items confirmed as played (>= 30 s). */
	played: TrackId[];
	/** Items that had been booked as skipped and were in fact played. */
	unskipped: TrackId[];
}

/**
 * Apply recently-played entries to the deck. A play belongs to the deck when
 * Spotify says it came from our playlist, or — because Spotify sometimes
 * omits the context for plays started through the API — when the context is
 * missing and the song is one of ours played after the deck was written.
 */
export function applyPlays(deck: Deck, plays: readonly RecentPlay[], deckUri: string): PlaysResult {
	const items = deck.items.slice();
	const played: TrackId[] = [];
	const unskipped: TrackId[] = [];
	const sorted = plays.slice().sort((a, b) => a.playedAt - b.playedAt);
	for (const p of sorted) {
		if (p.playedAt < deck.writtenAt) continue;
		if (p.contextUri !== null && p.contextUri !== deckUri) continue;
		const i = items.findIndex((it) => it.id === p.trackId && it.state !== "played");
		if (i < 0) continue;
		const it = items[i]!;
		if (it.state === "skipped") unskipped.push(it.id);
		items[i] = { ...it, state: "played", at: p.playedAt };
		played.push(it.id);
	}
	return { deck: { ...deck, items }, played, unskipped };
}

/** Passed items that never showed up as a play within the grace period. */
export function settleSkips(
	deck: Deck,
	now: number,
	graceMs = SKIP_GRACE_MS,
): { deck: Deck; skipped: TrackId[]; seen: Set<TrackId> } {
	const skipped: TrackId[] = [];
	const seen = new Set<TrackId>();
	const items = deck.items.map((it) => {
		if (it.state === "passed" && it.at !== null && now - it.at >= graceMs) {
			skipped.push(it.id);
			if (it.seen) seen.add(it.id);
			return { ...it, state: "skipped" as const, at: now };
		}
		return it;
	});
	return { deck: { ...deck, items }, skipped, seen };
}

/** Songs of the deck the listener has moved past or heard. */
export function consumedCount(deck: Deck): number {
	return deck.items.reduce((n, it) => (it.state === "pending" ? n : n + 1), 0);
}

/** Songs still ahead of the current position. */
export function remainingAhead(deck: Deck): number {
	const from = (position(deck) ?? -1) + 1;
	let n = 0;
	for (let i = from; i < deck.items.length; i++) if (deck.items[i]!.state === "pending") n++;
	return n;
}
