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
	/**
	 * Passed between two looks, as the song after it began right when the song
	 * seen before would have ended. If that song's play (`id`, stamped between
	 * `from` and `to`) shows up, it ran to its end: the song after it came from
	 * the queue, and this one never played — it waits again.
	 */
	unless?: { id: TrackId; from: number; to: number };
	/**
	 * Skipped: when its early skip was booked in memory (the time it was seen
	 * left). Absent, nothing was booked (guest time, a private session), and a
	 * play later takes nothing back.
	 */
	booked?: number;
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
	/**
	 * Places (from, to exclusive) of songs no version a player may still have
	 * loaded held: only a player in this version's order reaches them.
	 */
	newAt?: [number, number][];
	/**
	 * Places right after the songs an earlier version of the chain kept, as
	 * this version numbers them: a player still in the order before that one
	 * plays its own tail from there.
	 */
	endsAt?: number[];
	/**
	 * A player is known to follow this version: True Shuffle started it or
	 * jumped it to a place, or it was seen playing a song only this version
	 * holds. Until then its front (up to `heldAt`) proves no gaps.
	 */
	inOrder?: boolean;
	/**
	 * Places i (from, to exclusive) whose next song follows the same one in
	 * every order a player may still have loaded: a step across them passes
	 * the same songs whichever of those orders the player follows.
	 */
	sharedAt?: [number, number][];
	/**
	 * The songs (from, to exclusive) the latest step took as skipped without
	 * seeing them, while the player is still where that step ended. Seen back
	 * inside them, a song from further down came from the queue: the player
	 * goes through them now.
	 */
	lastGap?: [number, number] | null;
	/**
	 * After moves back (a song from further up, from the queue or tapped):
	 * the places they came from. Nothing at or before one is taken as skipped
	 * on the way forward past it again — those songs were behind the player
	 * already, or never reached.
	 */
	backFrom?: number[];
	/**
	 * Where the player is in this version's order: moved on by plain steps
	 * forward and by moves back, not by a jump further down (maybe a song from
	 * the queue). Where an older order goes on from, once this one is replaced.
	 */
	orderAt?: number;
	/**
	 * When the song seen last ends if it plays on, as that look saw it. A song
	 * seen next that began right then may have followed it directly — the next
	 * in order, or one from the queue.
	 */
	lastEndAt?: number | null;
}

/** Runs of `true` as [from, to) pairs. */
export function toRanges(flags: readonly boolean[]): [number, number][] {
	const out: [number, number][] = [];
	for (let i = 0; i < flags.length; i++) {
		if (!flags[i]) continue;
		const last = out[out.length - 1];
		if (last && last[1] === i) last[1] = i + 1;
		else out.push([i, i + 1]);
	}
	return out;
}

export function inRanges(ranges: readonly [number, number][] | undefined, i: number): boolean {
	return (ranges ?? []).some(([from, to]) => i >= from && i < to);
}

function isNewAt(deck: Deck, i: number): boolean {
	return inRanges(deck.newAt, i);
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
	/** The guest's: it proves the song was not skipped then, but undoes no skip of the owner. */
	ignored?: boolean;
	/**
	 * The guest's play across the end of guest time, begun then: a skip seen
	 * after that is this play's own, and was none.
	 */
	from?: number;
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

/**
 * How closely a song's start must meet the end of the one seen before it to
 * count as following it directly. Two looks' delays, not a listener's skip.
 */
export const DIRECT_MS = 3_000;

/** How late after its end Spotify may stamp a song's play. */
const STAMP_LATE_MS = 60_000;

/**
 * How early before the end we put it a play may be stamped and still mean the
 * song ran to its end: the delays of our looks, a phone's clock. Leaving a
 * song in its last seconds is hearing it to the end.
 */
const STAMP_EARLY_MS = 10_000;

/** When the song seen now ends if it plays on. */
function endOf(obs: PlayerObservation): number | null {
	return obs.isPlaying && obs.durationMs > 0 ? obs.at + obs.durationMs - obs.progressMs : null;
}

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
			lastEndAt: endOf(obs),
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
				lastEndAt: endOf(obs),
				ours: false,
				top: false,
			},
		};
	}
	// What do we actually know was reached? Either the song we saw last time
	// (still at that index in this version), or the top, when we started it.
	const ours = deck.ours === true && obs.isPlaying;
	const fromTop = prev === null && ours && deck.top === true;
	// Off the end of the songs a continuation kept in place, back into its
	// front, onto a song an older version held: a player still in that order
	// plays its tail there — the songs this version moved forward. Only from
	// near that end (or the end of what an earlier version kept), on either
	// side: an older order passes every kept song first, and may meet a song
	// or two a later version planned there by chance. A song only this
	// version holds is reached in its own order. Going on past an end is a
	// changed place.
	const ends = [(deck.keptTo ?? deck.items.length - 1) + 1, ...(deck.endsAt ?? [])];
	const isNew = isNewAt(deck, idx);
	const heldAt = deck.heldAt;
	const strays =
		deck.continued === true &&
		heldAt != null &&
		prev !== null &&
		prev > heldAt &&
		idx <= heldAt &&
		!isNew &&
		ends.some((e) => prev >= e - 1 - MAX_SKIP_GAP && prev <= e + MAX_SKIP_GAP);
	// Seen going on in order onto such a song: the player follows this version.
	const backInOrder = seenPrev && prev !== null && idx === prev + 1 && isNew;
	const strayedUntil = strays
		? obs.at + STRAY_MS
		: backInOrder && deck.strayedUntil !== undefined
			? obs.at
			: deck.strayedUntil;
	const trusted = ours && !(strayedUntil !== undefined && obs.at < strayedUntil);

	// Began right when the song seen before it would end: it may have
	// followed that one directly — the next in order, or a song from the
	// queue. Or a run of skips took exactly that long: the song's own play
	// tells (see `unless`).
	const direct =
		seenPrev &&
		deck.lastEndAt != null &&
		Math.abs(obs.at - obs.progressMs - deck.lastEndAt) <= DIRECT_MS;
	// Where the player is in this order: on with plain steps forward, back
	// with a move back (a restart, a song from further up); a jump further
	// down may be a song from the queue, so the place stays. Following a song
	// directly, only the next in order (or the top after the last) moves it.
	// Only a new song seen playing moves it: a song seen again, or paused,
	// may be one from the queue all the same. Rather behind than ahead.
	const orderBase = deck.orderAt ?? (deck.continued ? (heldAt ?? null) : deck.top ? -1 : null);
	const next =
		orderBase !== null &&
		(idx === orderBase + 1 || (idx === 0 && orderBase === deck.items.length - 1));
	const moves = obs.isPlaying && idx !== prev;
	const orderAt =
		orderBase === null
			? undefined
			: !moves
				? orderBase
				: direct
					? next
						? idx
						: orderBase
					: idx <= orderBase + MAX_SKIP_GAP + 1
						? idx
						: orderBase;
	// A song from the queue says nothing about the order the player follows.
	const inOrder = deck.inOrder === true || (isNew && obs.isPlaying && !(direct && !next));

	const items = deck.items.slice();
	let lastGap = deck.lastGap ?? null;
	let backFrom = Array.isArray(deck.backFrom) ? deck.backFrom.slice() : [];
	if (prev !== null && idx < prev) {
		// Seen again before songs taken as skipped without being seen (a song
		// from further down came from the queue, a second device, a look back):
		// better missed than made up — they go back to waiting.
		for (let i = idx; i < prev; i++) {
			const it = items[i]!;
			if (it.state === "passed" && it.seen !== true)
				items[i] = { id: it.id, kind: it.kind, state: "pending", at: null };
		}
		// Inside the gap just inferred, the player now goes through those songs;
		// anywhere else it may go back to where it was — unless it follows the
		// order again right after a song from the queue.
		if (!(lastGap && idx >= lastGap[0] && idx < lastGap[1]) && !(direct && next)) {
			backFrom.push(prev);
			if (backFrom.length > 10) backFrom = backFrom.slice(-10);
		}
		lastGap = null;
	} else if (lastGap && idx > lastGap[1]) lastGap = null;
	// Back again beyond a place it came from (the song from further up came
	// from the queue, or was only a look back): only what lies beyond that
	// place was left now. Going on in order from the earlier place, all counts.
	const behind = backFrom.filter((b) => b < idx);
	const limit = behind.length > 0 ? Math.max(...behind) : null;
	if (limit !== null) backFrom = backFrom.filter((b) => b >= idx);
	const passed: TrackId[] = [];
	const pass = (i: number, unless?: DeckItem["unless"]) => {
		const it = items[i]!;
		if (it.state === "pending") {
			items[i] = {
				...it,
				state: "passed",
				at: obs.at,
				from: deck.lastObservedAt ?? obs.at,
				seen: seenPrev && i === prev,
				...(unless ? { unless } : {}),
			};
			passed.push(it.id);
		}
	};
	// The song seen before, if it ran to its end: Spotify stamps its play at
	// that end. One left earlier, in its outro, is stamped before — then the
	// songs between were skipped after all.
	const unless =
		direct && deck.lastTrackId != null && deck.lastEndAt != null
			? {
					id: deck.lastTrackId,
					from: Math.max(deck.lastObservedAt ?? 0, deck.lastEndAt - STAMP_EARLY_MS),
					to: deck.lastEndAt + STAMP_LATE_MS,
				}
			: undefined;
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
		// A continuation's front holds the tail of every older order a player
		// may still follow — the songs moved forward, among the old ones before
		// the held place. Steps there prove nothing until the player is known
		// to follow this version, however it came there (a first look after
		// the rewrite, a run of skips between two looks) — unless every order
		// it may follow has the same songs in between.
		// The same holds behind the kept songs: songs planned there later (new
		// ones appended as the playlist runs low) are the long unheard ones —
		// often exactly the rest of an older order.
		let shared = true;
		for (let i = Math.max(anchor, 0); i < idx && shared; i++) shared = inRanges(deck.sharedAt, i);
		const keptEnd = deck.keptTo ?? deck.items.length - 1;
		const outside = anchor <= (heldAt ?? -1) || anchor > keptEnd;
		const front = deck.continued === true && heldAt != null && outside && !inOrder && !shared;
		// Out of the kept songs with a gap: an older order goes on elsewhere.
		const leaves = deck.continued === true && !inOrder && anchor <= keptEnd && idx > keptEnd + 1;
		if (trusted && gap <= MAX_SKIP_GAP && !crosses && !front && !leaves) {
			// In our order: the song we saw and everything up to the current one
			// is behind us.
			let first = -1;
			for (let i = Math.max(anchor, 0); i < idx; i++) {
				if (i !== anchor && limit !== null && i <= limit) continue;
				if (i !== anchor && first < 0 && items[i]!.state === "pending") first = i;
				pass(i, i === anchor ? undefined : unless);
			}
			if (first >= 0) lastGap = [first, idx];
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
			lastEndAt: endOf(obs),
			top: false,
			...(strayedUntil !== undefined ? { strayedUntil } : {}),
			...(inOrder ? { inOrder } : {}),
			lastGap,
			backFrom,
			...(orderAt !== undefined ? { orderAt } : {}),
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
	/** Items that wait again: they came before a song from the queue (see `takeBackQueued`). */
	waiting: TrackId[];
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
		if (it.state === "skipped") {
			if (p.ignored) continue;
			// Its play after all: stamped between the look before and a few
			// minutes after the one that saw it left. A later play is a new one.
			const left = it.booked;
			if (
				left !== undefined &&
				p.playedAt >= (it.from ?? left) - MINUTE_MS &&
				p.playedAt <= left + 5 * MINUTE_MS
			)
				unskipped.push(it.id);
		}
		// A guest's play proves only its own listening: a song the owner left
		// before it (still waiting as a skip) stays left.
		if (p.ignored && it.state === "passed" && it.at !== null && p.playedAt > it.at + 60_000)
			continue;
		items[i] = { ...it, state: "played", at: p.playedAt };
		played.push(it.id);
	}
	const back = takeBackQueued({ ...deck, items }, (id, from, to) =>
		sorted.some(
			(p) =>
				p.trackId === id &&
				p.playedAt >= from &&
				p.playedAt <= to &&
				(p.contextUri === null || p.contextUri === deckUri),
		),
	);
	return { deck: back.deck, played, unskipped, waiting: back.waiting };
}

/**
 * Songs taken as skipped between two looks, whose song before ran to its end
 * after all (`heard` finds its play): the song after them came from the
 * queue, and they never played. They wait again. A skip already booked for
 * one is taken back from memory by whoever booked it (the hub keeps a record).
 */
export function takeBackQueued(
	deck: Deck,
	heard: (id: TrackId, from: number, to: number) => boolean,
): { deck: Deck; waiting: TrackId[] } {
	let items: DeckItem[] | null = null;
	const waiting: TrackId[] = [];
	deck.items.forEach((it, i) => {
		const u = it.unless;
		if (!u || (it.state !== "passed" && it.state !== "skipped")) return;
		if (!heard(u.id, u.from, u.to)) return;
		items ??= deck.items.slice();
		waiting.push(it.id);
		items[i] = { id: it.id, kind: it.kind, state: "pending", at: null };
	});
	return { deck: items ? { ...deck, items } : deck, waiting };
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
	left: Map<TrackId, { from: number; at: number; unless?: DeckItem["unless"] }>;
} {
	const skipped: TrackId[] = [];
	const seen = new Set<TrackId>();
	const left = new Map<TrackId, { from: number; at: number; unless?: DeckItem["unless"] }>();
	const items = deck.items.map((it) => {
		if (it.state === "passed" && it.at !== null && now - it.at >= graceMs) {
			skipped.push(it.id);
			left.set(it.id, {
				from: it.from ?? it.at,
				at: it.at,
				...(it.unless ? { unless: it.unless } : {}),
			});
			if (it.seen) seen.add(it.id);
			return { ...it, state: "skipped" as const, at: now };
		}
		return it;
	});
	return { deck: { ...deck, items }, skipped, seen, left };
}

/** The skip of a skipped item was booked in memory, as left at `at`. */
export function markBooked(deck: Deck, id: TrackId, at: number): Deck {
	const i = deck.items.findIndex((it) => it.id === id && it.state === "skipped");
	if (i < 0) return deck;
	const items = deck.items.slice();
	items[i] = { ...items[i]!, booked: at };
	return { ...deck, items };
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
