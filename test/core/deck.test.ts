import { describe, expect, it } from "vitest";
import {
	applyPlays,
	consumedCount,
	type Deck,
	MAX_SKIP_GAP,
	newDeck,
	observePlayer,
	type PlayerObservation,
	remainingAhead,
	SKIP_GRACE_MS,
	settleSkips,
} from "../../src/core/deck";

const URI = "spotify:playlist:deck";
const T0 = Date.UTC(2026, 8, 25, 8);

function deck(n = 20): Deck {
	return newDeck(
		Array.from({ length: n }, (_, i) => ({ trackId: `s${i}`, kind: "fresh" as const })),
		1,
		T0,
	);
}

/** A deck True Shuffle itself started at the top. */
function started(n = 20): Deck {
	return { ...deck(n), ours: true, top: true };
}

function obs(trackId: string | null, over: Partial<PlayerObservation> = {}): PlayerObservation {
	return {
		at: T0 + 60_000,
		contextUri: URI,
		trackId,
		isPlaying: true,
		progressMs: 10_000,
		durationMs: 200_000,
		shuffle: false,
		smartShuffle: false,
		...over,
	};
}

describe("observePlayer", () => {
	it("marks the songs between two positions as passed in a deck it started", () => {
		let d = started();
		d = observePlayer(d, obs("s0"), URI).deck;
		const r = observePlayer(d, obs("s3"), URI);
		expect(r.passed).toEqual(["s0", "s1", "s2"]);
		expect(r.index).toBe(3);
		expect(r.deck.items.slice(0, 4).map((i) => i.state)).toEqual([
			"passed",
			"passed",
			"passed",
			"pending",
		]);
	});

	it("treats the first observation as coming from the top when it started the deck", () => {
		const r = observePlayer(started(), obs("s2"), URI);
		expect(r.passed).toEqual(["s0", "s1"]);
	});

	it("infers nothing from a first observation it did not start (listener tapped a song)", () => {
		const r = observePlayer(deck(), obs("s4"), URI);
		expect(r.passed).toEqual([]);
		expect(r.index).toBe(4);
	});

	it("in a version it did not start, only a song seen playing can be passed", () => {
		// After a rewrite Spotify may still play the order it had loaded: s7, then s9.
		let d = deck();
		d = observePlayer(d, obs("s7"), URI).deck;
		const r = observePlayer(d, obs("s9"), URI);
		expect(r.passed).toEqual(["s7"]);
		expect(r.deck.items[8]!.state).toBe("pending");
	});

	it("never trusts gaps in a version it did not start, even after neighbours by chance", () => {
		let d = deck();
		d = observePlayer(d, obs("s3"), URI).deck;
		d = observePlayer(d, obs("s4"), URI).deck;
		const r = observePlayer(d, obs("s7"), URI);
		expect(r.passed).toEqual(["s4"]);
	});

	it("counts the song it saw as left when a song outside the deck follows", () => {
		let d = deck();
		d = observePlayer(d, obs("s6"), URI).deck;
		const r = observePlayer(d, obs("not-in-this-version"), URI);
		expect(r.passed).toEqual(["s6"]);
		expect(r.deck.lastIndex).toBe(6);
	});

	it("does not read a position carried over from another version", () => {
		// lastIndex points at s2, but the song seen there was a different one.
		const d: Deck = { ...deck(), lastIndex: 2, lastTrackId: "old-song" };
		const r = observePlayer(d, obs("s4"), URI);
		expect(r.passed).toEqual([]);
	});

	it("after shuffling, trusts positions only once True Shuffle starts it again", () => {
		let d = started();
		d = observePlayer(d, obs("s5", { shuffle: true }), URI).deck;
		expect(d.ours).toBe(false);
		const r = observePlayer(d, obs("s9"), URI);
		expect(r.passed).toEqual(["s5"]);
	});

	it("reads a long forward move as a jump, not as skips", () => {
		const r = observePlayer(started(40), obs(`s${MAX_SKIP_GAP + 5}`), URI);
		expect(r.passed).toEqual([]);
		expect(r.index).toBe(MAX_SKIP_GAP + 5);
	});

	it("after a long jump, only the song it jumped away from counts as left", () => {
		let d = started(40);
		d = observePlayer(d, obs("s1"), URI).deck;
		const r = observePlayer(d, obs(`s${MAX_SKIP_GAP + 8}`), URI);
		expect(r.passed).toEqual(["s1"]);
	});

	it("infers nothing while the service shuffles", () => {
		let d = deck();
		d = observePlayer(d, obs("s0"), URI).deck;
		const r = observePlayer(d, obs("s5", { shuffle: true }), URI);
		expect(r.orderBroken).toBe(true);
		expect(r.passed).toEqual([]);
	});

	it("ignores other contexts entirely", () => {
		const r = observePlayer(deck(), obs("s5", { contextUri: "spotify:album:x" }), URI);
		expect(r.inDeck).toBe(false);
		expect(r.passed).toEqual([]);
	});

	it("ignores a queued song that is not ours", () => {
		const r = observePlayer(deck(), obs("foreign"), URI);
		expect(r.inDeck).toBe(true);
		expect(r.index).toBeNull();
	});

	it("does not mark anything when the listener steps back", () => {
		let d = deck();
		d = observePlayer(d, obs("s5"), URI).deck;
		const r = observePlayer(d, obs("s4"), URI);
		expect(r.passed).toEqual([]);
		expect(r.deck.lastIndex).toBe(4);
	});
});

describe("applyPlays + settleSkips", () => {
	it("confirms plays from our playlist and books unconfirmed passes as skips after the grace", () => {
		let d = started();
		d = observePlayer(d, obs("s4", { at: T0 + 10 * 60_000 }), URI).deck; // s0..s3 passed
		const p = applyPlays(
			d,
			[
				{ trackId: "s0", playedAt: T0 + 3 * 60_000, contextUri: URI },
				{ trackId: "s2", playedAt: T0 + 7 * 60_000, contextUri: null }, // context missing
				{ trackId: "s1", playedAt: T0 + 5 * 60_000, contextUri: "spotify:album:other" },
			],
			URI,
		);
		expect(p.played.sort()).toEqual(["s0", "s2"]);
		const early = settleSkips(p.deck, T0 + 10 * 60_000 + SKIP_GRACE_MS - 1);
		expect(early.skipped).toEqual([]);
		const late = settleSkips(p.deck, T0 + 10 * 60_000 + SKIP_GRACE_MS);
		expect(late.skipped.sort()).toEqual(["s1", "s3"]);
		expect(consumedCount(late.deck)).toBe(4);
	});

	it("undoes a skip when the play arrives late", () => {
		let d = started();
		d = observePlayer(d, obs("s2", { at: T0 + 60_000 }), URI).deck;
		d = settleSkips(d, T0 + 60_000 + SKIP_GRACE_MS).deck;
		const p = applyPlays(d, [{ trackId: "s1", playedAt: T0 + 30_000, contextUri: URI }], URI);
		expect(p.unskipped).toEqual(["s1"]);
		expect(p.deck.items[1]!.state).toBe("played");
	});

	it("ignores plays from before the deck was written", () => {
		const p = applyPlays(deck(), [{ trackId: "s0", playedAt: T0 - 1, contextUri: URI }], URI);
		expect(p.played).toEqual([]);
	});

	it("counts what is still ahead", () => {
		let d = deck(10);
		d = observePlayer(d, obs("s3"), URI).deck;
		expect(remainingAhead(d)).toBe(6);
	});
});
