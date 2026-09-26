import { describe, expect, it } from "vitest";
import {
	applyPlays,
	consumedCount,
	continueLayout,
	type Deck,
	heldForPlayer,
	MAX_CONTINUED_ITEMS,
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

describe("continueLayout — the next version of a deck a player still holds", () => {
	const items = (n: number) => deck(n).items;
	const slots = (ids: string[]) => ids.map((trackId) => ({ trackId, kind: "fresh" as const }));
	const ids = (l: { trackId: string }[] | null) => l?.map((s) => s.trackId) ?? null;
	const all = () => true;
	const none = () => false;

	it("keeps every song after the held one at its place and puts new songs in front", () => {
		const out = ids(
			continueLayout({
				items: items(40),
				held: 3,
				fresh: slots(["n1", "n2", "n3", "n4", "n5", "n6"]),
				playable: all,
				blocked: none,
			}),
		)!;
		expect(out.slice(4, 40)).toEqual(
			items(40)
				.slice(4)
				.map((i) => i.id),
		);
		expect(out.slice(0, 4).every((id) => id.startsWith("n"))).toBe(true);
		expect(out[3]).toBe("n1"); // the best new song where a player resuming by position starts
		expect(out.slice(40)).toEqual(["n5", "n6"]);
		expect(new Set(out).size).toBe(out.length);
	});

	it("never shrinks a small station: with no new songs the last kept songs move forward", () => {
		const out = ids(
			continueLayout({ items: items(100), held: 8, fresh: [], playable: all, blocked: none }),
		)!;
		// Songs 9… stay where they were; the nine front slots hold the last nine songs.
		expect(out.length).toBe(100 - 9 + 0);
		expect(out.slice(9, 20)).toEqual(
			items(100)
				.slice(9, 20)
				.map((i) => i.id),
		);
		expect(out.slice(0, 9)).toEqual(
			items(100)
				.slice(91, 100)
				.map((i) => i.id),
		);
		expect(out.some((id) => ["s0", "s1", "s8"].includes(id))).toBe(false);
	});

	it("deep in a short deck: keeps the songs ahead for a player resuming where it stopped", () => {
		const out = ids(
			continueLayout({ items: items(300), held: 250, fresh: [], playable: all, blocked: none }),
		)!;
		expect(out.length).toBeGreaterThanOrEqual(300 - 2);
		// Position 250 holds a song nobody heard yet, and everything after it too.
		expect(Number(out[250]!.slice(1))).toBeGreaterThan(250);
		for (let i = 251; i < out.length; i++) expect(Number(out[i]!.slice(1))).toBeGreaterThan(250);
	});

	it("replaces a kept song heard elsewhere in the meantime, at its place", () => {
		const out = ids(
			continueLayout({
				items: items(12),
				held: 2,
				fresh: slots(["n1", "n2", "n3", "n4"]),
				playable: (id) => id !== "s6",
				blocked: none,
			}),
		)!;
		expect(out[6]).toBe("n2");
		expect(out).not.toContain("s6");
		expect(out.slice(3, 6)).toEqual(["s3", "s4", "s5"]);
		expect(out.slice(7, 12)).toEqual(["s7", "s8", "s9", "s10", "s11"]);
	});

	it("takes out a kept song that may not play when nothing can replace it", () => {
		const out = ids(
			continueLayout({
				items: items(12),
				held: 1,
				fresh: slots(["n1", "n2"]),
				playable: (id) => id !== "s5",
				blocked: (id) => id === "s5",
			}),
		)!;
		expect(out).not.toContain("s5");
		expect(out.slice(2, 5)).toEqual(["s2", "s3", "s4"]);
	});

	it("near the end with few new songs: keeps some ahead of the player", () => {
		const out = ids(
			continueLayout({
				items: items(100),
				held: 95,
				fresh: slots(Array.from({ length: 40 }, (_, i) => `n${i}`)),
				playable: all,
				blocked: none,
			}),
		)!;
		// The four kept songs, then new ones: 25 ahead of the player in all.
		expect(out.slice(96, 100)).toEqual(["s96", "s97", "s98", "s99"]);
		expect(out.slice(100).length).toBe(21);
		expect(out.slice(100).every((id) => id.startsWith("n"))).toBe(true);
		expect(new Set(out).size).toBe(out.length);
	});

	it("near the end of a station already whole in the playlist: positions come first", () => {
		// The new songs are the front's own, never reached: nothing to spare.
		const all100 = items(100);
		const front = all100.slice(0, 80).map((i) => ({ trackId: i.id, kind: i.kind }));
		const out = ids(
			continueLayout({ items: all100, held: 95, fresh: front, playable: all, blocked: none }),
		)!;
		expect(out.length).toBe(99);
		// One song fewer than before (the held one): the kept songs move up by one at most.
		expect(out.slice(95)).toEqual(["s96", "s97", "s98", "s99"]);
		expect(new Set(out).size).toBe(out.length);
	});

	it("leaves a version alone whose held position lies past its end", () => {
		expect(
			continueLayout({
				items: items(5),
				held: 5,
				fresh: slots(["n1"]),
				playable: all,
				blocked: none,
			}),
		).toBeNull();
	});

	it("leaves the version alone when it cannot be improved", () => {
		expect(
			continueLayout({ items: items(3), held: 1, fresh: [], playable: all, blocked: none }),
		).toBeNull();
	});

	it("never writes more than the budget allows", () => {
		expect(
			continueLayout({
				items: items(MAX_CONTINUED_ITEMS + 50),
				held: 10,
				fresh: slots(["n1"]),
				playable: all,
				blocked: none,
			}),
		).toBeNull();
		const out = continueLayout({
			items: items(20),
			held: 2,
			fresh: slots(Array.from({ length: MAX_CONTINUED_ITEMS }, (_, i) => `n${i}`)),
			playable: all,
			blocked: none,
		})!;
		expect(out.length).toBe(MAX_CONTINUED_ITEMS);
	});
});

describe("heldForPlayer — what a new plan must not take from a deck", () => {
	it("a deck started from the top: every song", () => {
		expect(heldForPlayer({ ...deck(10), lastIndex: 4 }).size).toBe(10);
	});

	it("a continuation: not its front, which the player never reached", () => {
		const d: Deck = { ...deck(10), heldAt: 5, lastIndex: 7 };
		d.items[2] = { ...d.items[2]!, state: "played", at: T0 };
		expect([...heldForPlayer(d)].sort()).toEqual(["s2", "s5", "s6", "s7", "s8", "s9"].sort());
	});

	it("a continuation restarted from the top: every song", () => {
		expect(heldForPlayer({ ...deck(10), heldAt: 5, lastIndex: 1 }).size).toBe(10);
	});
});
