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

import { HOUR_MS, MINUTE_MS, type PlannedSlot, type SlotKind, type TrackId } from "./types";

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
	/** Passed: the look before, when it was still ahead or playing — left between `from` and `at`. */
	from?: number;
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
	/**
	 * Places after `heldAt` whose song this version changed: a player still in
	 * the previous version plays something else there.
	 */
	changedAt?: number[];
	/**
	 * Songs of earlier versions a player may still have loaded that this
	 * version no longer holds, each until when (36 h after it left).
	 */
	former?: [TrackId, number][];
	/** Of those, the ones turned down or banned: they may still come up. */
	formerOff?: TrackId[];
	/** Until when the front (before `heldAt`) holds songs heard lately. */
	frontHeardUntil?: number;
	/**
	 * The songs a chain of continuations took out at the held position — the
	 * one a player paused on among them. Never planned back while the chain
	 * lasts: a player resuming it would be found in the front.
	 */
	leftOut?: TrackId[];
	/**
	 * Last place of the songs kept where they were (after `heldAt`). Past it a
	 * player still in an older order plays that order's own tail, which this
	 * version holds elsewhere or not at all.
	 */
	keptTo?: number | null;
	/**
	 * A player left the kept songs for another place in this version: it may
	 * still follow an older order, whose steps are no gaps here. Until then
	 * only a song seen playing counts as left, also in the continuations.
	 */
	strayedUntil?: number;
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

/** How long a player that strayed from the kept songs may still follow an older order. */
export const STRAY_MS = 36 * HOUR_MS;

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
		// been left all the same. The player may follow an order we do not know
		// now: nothing between here and the next song seen in this version is
		// inferred — the look after it starts afresh.
		const seen = {
			lastTrackId: obs.trackId,
			lastPlaying: obs.isPlaying,
			lastObservedAt: obs.at,
			top: false,
		};
		if (seenPrev && obs.trackId !== deck.lastTrackId && deck.items[prev]!.state === "pending") {
			const items = deck.items.slice();
			items[prev] = {
				...items[prev]!,
				state: "passed",
				at: obs.at,
				from: deck.lastObservedAt ?? obs.at,
				seen: true,
			};
			return {
				...base,
				inDeck: true,
				orderBroken,
				passed: [items[prev]!.id],
				deck: { ...deck, items, ...seen },
			};
		}
		return { ...base, inDeck: true, orderBroken, deck: { ...deck, ...seen } };
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
	// Out of the songs a continuation kept in place — back into its front, or
	// past their end with a gap: a player still in an older order plays that
	// order's tail there, and this version holds those songs anywhere.
	const keptTo = deck.keptTo ?? deck.items.length - 1;
	const strays =
		deck.continued === true &&
		deck.heldAt != null &&
		prev !== null &&
		prev > deck.heldAt &&
		prev <= keptTo &&
		(idx <= deck.heldAt || idx > keptTo + 1);
	const strayedUntil = strays ? obs.at + STRAY_MS : deck.strayedUntil;
	const trusted = ours && !(strayedUntil !== undefined && obs.at < strayedUntil);

	const items = deck.items.slice();
	const passed: TrackId[] = [];
	const pass = (i: number) => {
		const it = items[i]!;
		if (it.state === "pending") {
			items[i] = {
				...it,
				state: "passed",
				at: obs.at,
				from: deck.lastObservedAt ?? obs.at,
				seen: seenPrev && i === prev,
			};
			passed.push(it.id);
		}
	};
	const anchor = seenPrev ? prev : fromTop ? -1 : null;
	if (anchor !== null && idx > anchor) {
		const gap = idx - anchor - 1;
		// From a continuation's front into what it kept: the player came from
		// an order we do not know (a paused song found in the front, a restart
		// from the top). Only the song seen there was left.
		// Nor across a place this version changed: a player in the older order
		// played something else there, maybe several songs.
		const crosses =
			(deck.heldAt != null && anchor < deck.heldAt && idx > deck.heldAt) ||
			(deck.changedAt ?? []).some((c) => c > anchor && c <= idx);
		if (trusted && gap <= MAX_SKIP_GAP && !crosses) {
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
			...(strayedUntil !== undefined ? { strayedUntil } : {}),
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
): {
	deck: Deck;
	skipped: TrackId[];
	seen: Set<TrackId>;
	left: Map<TrackId, { from: number; at: number }>;
} {
	const skipped: TrackId[] = [];
	const seen = new Set<TrackId>();
	const left = new Map<TrackId, { from: number; at: number }>();
	const items = deck.items.map((it) => {
		if (it.state === "passed" && it.at !== null && now - it.at >= graceMs) {
			skipped.push(it.id);
			left.set(it.id, { from: it.from ?? it.at, at: it.at });
			if (it.seen) seen.add(it.id);
			return { ...it, state: "skipped" as const, at: now };
		}
		return it;
	});
	return { deck: { ...deck, items }, skipped, seen, left };
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

/** The longest deck a continuation writes: every 100 songs cost a request. */
export const MAX_CONTINUED_ITEMS = 2000;

/**
 * Songs a continuation keeps ahead of the player near the end of the
 * playlist. Appending while it plays may not help there: in a small station
 * every song is in the playlist already, and one song twice would make
 * positions ambiguous.
 */
export const CONTINUE_AHEAD = 25;

/**
 * Songs this version holds for a player: ahead of it, or already reached
 * (heard, or skipped with the booking still waiting). What stands in front
 * of where the player came in — a continuation's front — was never reached
 * and may be planned again; after a restart from the top, everything counts.
 */
export function heldForPlayer(deck: Deck): Set<TrackId> {
	const cameIn =
		deck.lastIndex != null && deck.lastIndex < (deck.heldAt ?? 0) ? 0 : (deck.heldAt ?? 0);
	return new Set([
		...deck.items.filter((it, i) => i >= cameIn || it.state !== "pending").map((it) => it.id),
		...(deck.leftOut ?? []),
	]);
}

export interface ContinueInput {
	/** The version a player still holds. */
	items: readonly DeckItem[];
	/** Where that player is in it. */
	held: number;
	/**
	 * New songs, best first: none of them heard or skipped lately, none in
	 * `items` after `held` or at it.
	 */
	fresh: readonly PlannedSlot[];
	/** May this song play now: not turned down or banned, not heard or skipped lately? */
	playable: (id: TrackId) => boolean;
	/** Turned down or banned: never back, not even to fill a gap. */
	blocked: (id: TrackId) => boolean;
}

/**
 * The next version of a deck a player may still hold (paused, or gone quiet
 * in it). Whatever the player does on resume, it meets no song it just heard:
 *  - resuming by position plays index `held` (a new song), then the songs
 *    after it — kept at their places, each one that may no longer play
 *    replaced by a new song or, with none left, taken out;
 *  - resuming its loaded order plays what it had anyway;
 *  - a restart from the top plays the front: new songs, or — when too few
 *    exist — the last kept songs moved forward, as long as at most half of
 *    them have to move. Otherwise the front keeps the old songs before the
 *    held one: only a restart from the top would repeat them, and the
 *    listener resuming where they stopped keeps every song ahead.
 * `null`: nothing better than the version the player holds — leave it.
 */
export function continueLayout(
	input: ContinueInput,
): { layout: PlannedSlot[]; keptFrom: number; keptTo: number } | null {
	const { items, held } = input;
	if (held < 0 || held >= items.length) return null;
	const fresh = input.fresh.slice();
	// The new songs up to `held`; the best one at `held` itself, which a
	// player resuming by position plays first.
	const front: PlannedSlot[] = fresh.length > 0 ? [fresh.shift()!] : [];
	let kept: PlannedSlot[] = [];
	for (const it of items.slice(held + 1)) {
		if (input.playable(it.id)) kept.push({ trackId: it.id, kind: it.kind });
		else if (fresh.length > 0) kept.push(fresh.shift()!);
	}
	// Near the end of the playlist the best new songs go ahead of the player
	// first — one resuming where it stopped hears them, not the front.
	const ahead = fresh.splice(0, Math.max(0, CONTINUE_AHEAD - kept.length));
	while (front.length < held + 1 && fresh.length > 0) front.unshift(fresh.shift()!);
	const short = held + 1 - front.length;
	if (short > 0 && ahead.length === 0 && short <= Math.floor(kept.length / 2)) {
		front.unshift(...kept.slice(kept.length - short));
		kept = kept.slice(0, kept.length - short);
	} else if (short > 0 && front.length === 0 && kept.length >= 2) {
		front.push(kept[kept.length - 1]!);
		kept = kept.slice(0, -1);
	}
	if (front.length === 0) return null;
	const used = new Set<TrackId>([items[held]!.id]);
	for (const s of [...front, ...kept, ...ahead, ...fresh]) used.add(s.trackId);
	const fill: PlannedSlot[] = [];
	for (let i = 0; i < held && fill.length + front.length < held + 1; i++) {
		const it = items[i]!;
		if (used.has(it.id) || input.blocked(it.id)) continue;
		used.add(it.id);
		fill.push({ trackId: it.id, kind: it.kind });
	}
	// Positions first: a station already whole in the playlist has no song to
	// spare for both, and a gap in front would shift every kept song.
	while (fill.length + front.length < held + 1 && ahead.length > 0) front.unshift(ahead.pop()!);
	// With old songs in front, a restart from the top still begins with one
	// nobody heard: while it plays, the hub sees the station and moves past
	// the heard ones behind it.
	let first: PlannedSlot | null = null;
	if (fill.length > 0) {
		if (front.length >= 2) first = front.shift()!;
		else if (ahead.length > 0 || kept.length >= 2) {
			first = ahead.length > 0 ? ahead.pop()! : kept.pop()!;
			fill.pop();
		}
	}
	const layout = [...(first ? [first] : []), ...fill, ...front, ...kept, ...ahead];
	if (layout.length > MAX_CONTINUED_ITEMS) return null;
	// Where the kept songs begin: right after `held`, or earlier when too few
	// songs were left to fill the front.
	const keptFrom = (first ? 1 : 0) + fill.length + front.length;
	return {
		layout: [...layout, ...fresh.slice(0, MAX_CONTINUED_ITEMS - layout.length)],
		keptFrom,
		keptTo: keptFrom + kept.length - 1,
	};
}
