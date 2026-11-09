/**
 * The commands of a replay: one account, three songs, no account change and
 * no navigation (the Verlauf's first page is asked for once). At most one
 * snapshot is on its way at a time (the store serialises refreshes), at most
 * one Verlauf page (the page waits for one before asking for the next), at
 * most one Verlauf rate/undo per song (the keys are busy meanwhile). Commands
 * that do not apply at their point are recorded as skipped, never reordered.
 */
import fc from "fast-check";
import type { SongIx, Value } from "./model";

export type Command =
	/** The clock moves on one millisecond (otherwise everything falls in one). */
	| { k: "tick" }
	/** Rated elsewhere (another tab, Siri): a new server write only. */
	| { k: "ext"; s: SongIx; v: Value }
	/** Rated here (sheet / player keys): the server stores it, then the store hears it. */
	| { k: "thumb"; s: SongIx; v: Value }
	| { k: "snapAsk" }
	| { k: "snapAnswer" }
	/** A Verlauf page: the first one, then later ones, with the songs it lists. */
	| { k: "listAsk"; songs: [boolean, boolean, boolean] }
	| { k: "listAnswer" }
	| { k: "rate"; s: SongIx; v: Value }
	| { k: "undo"; s: SongIx }
	/** The answer to the rate/undo on song s, or (none there) to the first song with one on its way. */
	| { k: "opAnswer"; s: SongIx }
	| { k: "open"; s: SongIx }
	| { k: "close" };

export const MAX_COMMANDS = 25;

const song = fc.constantFrom<SongIx>(0, 1, 2);
const value = fc.constantFrom<Value>(-1, 0, 1);

export const commandArb: fc.Arbitrary<Command> = fc.oneof(
	{ arbitrary: fc.constant({ k: "tick" } as const), weight: 1 },
	{ arbitrary: fc.record({ k: fc.constant("ext" as const), s: song, v: value }), weight: 3 },
	{ arbitrary: fc.record({ k: fc.constant("thumb" as const), s: song, v: value }), weight: 3 },
	{ arbitrary: fc.constant({ k: "snapAsk" } as const), weight: 3 },
	{ arbitrary: fc.constant({ k: "snapAnswer" } as const), weight: 2 },
	{
		arbitrary: fc.record({
			k: fc.constant("listAsk" as const),
			songs: fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()),
		}),
		weight: 4,
	},
	{ arbitrary: fc.constant({ k: "listAnswer" } as const), weight: 3 },
	{ arbitrary: fc.record({ k: fc.constant("rate" as const), s: song, v: value }), weight: 4 },
	{ arbitrary: fc.record({ k: fc.constant("undo" as const), s: song }), weight: 2 },
	{ arbitrary: fc.record({ k: fc.constant("opAnswer" as const), s: song }), weight: 3 },
	{ arbitrary: fc.record({ k: fc.constant("open" as const), s: song }), weight: 1 },
	{ arbitrary: fc.constant({ k: "close" } as const), weight: 1 },
);

const pages = fc.tuple(fc.boolean(), fc.boolean(), fc.boolean());
const page = (s: SongIx, extra: [boolean, boolean, boolean]): Command => ({
	k: "listAsk",
	songs: extra.map((b, i) => b || i === s) as [boolean, boolean, boolean],
});

/**
 * Race fragments (random song, values, page contents), mixed with single
 * commands: they make the interleavings the contracts are about likely within
 * 25 commands. They are ordinary commands, checked and shrunk like any other.
 */
const fragmentArb: fc.Arbitrary<Command[]> = fc.oneof(
	// A decision, a page asked while it stands, a newer write, a snapshot in the same millisecond.
	fc
		.tuple(song, value, value, pages)
		.map(([s, v, w, p]): Command[] => [
			{ k: "thumb", s, v },
			page(s, p),
			{ k: "ext", s, v: w },
			{ k: "listAnswer" },
			{ k: "snapAsk" },
			{ k: "snapAnswer" },
		]),
	// A snapshot asked, a newer write heard by a page, the snapshot answered late.
	fc
		.tuple(song, value, pages)
		.map(([s, v, p]): Command[] => [
			{ k: "snapAsk" },
			{ k: "ext", s, v },
			page(s, p),
			{ k: "listAnswer" },
			{ k: "snapAnswer" },
		]),
	// A Verlauf rating and an answer racing snapshots and writes.
	fc
		.tuple(song, value, value, fc.boolean())
		.map(([s, v, w, ext]): Command[] => [
			{ k: "rate", s, v },
			...(ext ? [{ k: "ext", s, v: w } as const] : []),
			{ k: "snapAsk" },
			{ k: "snapAnswer" },
			{ k: "opAnswer", s },
			{ k: "ext", s, v: w },
			{ k: "snapAsk" },
			{ k: "snapAnswer" },
		]),
	// A decision, a newer write heard in the same millisecond, then a page at that same number.
	fc
		.tuple(song, value, value, pages)
		.map(([s, v, w, p]): Command[] => [
			{ k: "thumb", s, v },
			{ k: "ext", s, v: w },
			{ k: "snapAsk" },
			{ k: "snapAnswer" },
			page(s, p),
			{ k: "listAnswer" },
		]),
);

export const commandsArb: fc.Arbitrary<Command[]> = fc
	.array(
		fc.oneof(
			{ arbitrary: commandArb.map((c) => [c]), weight: 5 },
			{ arbitrary: fragmentArb, weight: 2 },
		),
		{
			minLength: 1,
			maxLength: MAX_COMMANDS,
			size: "max",
		},
	)
	.map((parts) => parts.flat().slice(0, MAX_COMMANDS))
	.filter((c) => c.length > 0);

/** 100 fixed seeds (never derived from time or randomness). */
export const SEEDS: readonly number[] = Array.from({ length: 100 }, (_, i) => 0x7a11 + i * 7919);

export function show(c: Command): string {
	const name = (s: SongIx) => "ABC"[s];
	switch (c.k) {
		case "ext":
		case "thumb":
		case "rate":
			return `${c.k}(${name(c.s)},${c.v})`;
		case "undo":
		case "opAnswer":
		case "open":
			return `${c.k}(${name(c.s)})`;
		case "listAsk":
			return `listAsk(${c.songs.map((b, i) => (b ? "ABC"[i] : "")).join("") || "-"})`;
		default:
			return c.k;
	}
}
