/**
 * The Hörprofil's cutoff (JH06): a play counts when its full original time is
 * before the cutoff (`at < before`, to the millisecond, as in the weighting),
 * decided before the rows are cut to whole seconds and before the same song in
 * the same second is kept once. A play left out never pushes aside one kept in
 * the same second, in the same file or across files, and never names its song.
 * All data is synthetic.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { aggregateHistory, type ExtendedEntry, emptyAggregate } from "../../src/core/history";
import {
	addListens,
	finishListens,
	isListenRow,
	isListenTrack,
	LISTEN_FLAG,
	type ListenBuilder,
	type ListenEntry,
	type ListenRow,
	type ListenTrack,
	newListens,
	startTracker,
} from "../../src/core/listens";

/** A fixed cutoff on a whole second, and the same half a second later. */
const L0 = Date.UTC(2026, 9, 17, 1, 39, 0);
const L5 = L0 + 500;

const id = (tag: string) => `JH06${tag}`.padEnd(22, "0");
const iso = (at: number) => new Date(at).toISOString();

/** One music play; `ms` tells the plays apart in the rows. */
function play(at: number | string, tag: string, ms: number, over: ListenEntry = {}): ListenEntry {
	return {
		ts: typeof at === "number" ? iso(at) : at,
		ms_played: ms,
		spotify_track_uri: `spotify:track:${id(tag)}`,
		master_metadata_track_name: `Song ${tag}`,
		master_metadata_album_artist_name: "Stichtag-Kapelle",
		master_metadata_album_album_name: "Platte",
		reason_start: "trackdone",
		reason_end: "trackdone",
		...over,
	};
}

/** A podcast episode at the same time: no song, but it keeps the listening going. */
const episode = (e: ListenEntry): ListenEntry => ({
	...e,
	spotify_track_uri: null,
	master_metadata_track_name: null,
	master_metadata_album_artist_name: null,
	master_metadata_album_album_name: null,
});

const build = (files: ListenEntry[][]): ListenBuilder => {
	const b = newListens();
	for (const f of files) addListens(f, b);
	return b;
};

/** What the import page decides (menu.tsx): files from the cutoff on only. */
const onlyLater = (b: ListenBuilder, before: number) =>
	b.rows.size > 0 && finishListens(b, before).rows.length === 0;

/**
 * The reference for a cutoff: the same files, every play from the cutoff on
 * turned into an episode at the same time (so no song, but the same
 * listening around it), finished without a cutoff.
 */
function beforeOnly(files: ListenEntry[][], before: number) {
	const masked = files.map((f) =>
		f.map((e) => {
			const at = e.ts ? Date.parse(e.ts) : Number.NaN;
			return Number.isFinite(at) && at >= before ? episode(e) : e;
		}),
	);
	return finishListens(build(masked));
}

const sec = (at: number) => Math.floor(at / 1000);
const DONE = LISTEN_FLAG.done | LISTEN_FLAG.rated;
const OPENER = DONE | LISTEN_FLAG.opener;
const track = (tag: string, name = `Song ${tag}`): ListenTrack => [
	id(tag),
	name,
	"Stichtag-Kapelle",
	"Platte",
];

describe("the Hörprofil cut at the cutoff, to the millisecond", () => {
	for (const [label, L] of [
		["on a whole second", L0],
		["half a second in", L5],
	] as const) {
		describe(`a cutoff ${label}`, () => {
			it("keeps L-1ms, leaves out L and L+1ms, for different songs", () => {
				const files = [
					[play(L - 1, "A", 101_000), play(L, "B", 102_000), play(L + 1, "C", 103_000)],
				];
				const done = finishListens(build(files), L);
				expect(done.tracks).toEqual([track("A")]);
				expect(done.rows).toEqual([[sec(L - 1), 0, 101_000, OPENER, 0]]);
				expect(done).toEqual(beforeOnly(files, L));
			});

			for (const order of ["earlier first", "later first"] as const) {
				it(`keeps the earlier play of the same song when the later one is at or after it (${order})`, () => {
					const early = play(L - 1, "A", 111_000);
					const at = play(L, "A", 222_000);
					const after = play(L + 1, "A", 333_000);
					const files = [order === "earlier first" ? [early, at, after] : [after, at, early]];
					const done = finishListens(build(files), L);
					expect(done.tracks).toEqual([track("A")]);
					expect(done.rows).toHaveLength(1);
					expect(done.rows[0]![0]).toBe(sec(L - 1));
					expect(done.rows[0]![2]).toBe(111_000);
					expect(done).toEqual(beforeOnly(files, L));
				});

				it(`keeps the earlier play across files (${order})`, () => {
					const early = [play(L - 10 * 86_400_000, "A", 90_000), play(L - 1, "A", 111_000)];
					const late = [play(L + 1, "A", 333_000), play(L + 5_000, "B", 50_000)];
					const files = order === "earlier first" ? [early, late] : [late, early];
					const done = finishListens(build(files), L);
					expect(done.tracks).toEqual([track("A")]);
					expect(done.rows.map((r) => [r[0], r[2]])).toEqual([
						[sec(L - 10 * 86_400_000), 90_000],
						[sec(L - 1), 111_000],
					]);
					expect(done).toEqual(beforeOnly(files, L));
				});
			}

			it("keeps an export sent twice once, with the overlap from the cutoff on left out", () => {
				const first = [
					play(L - 3_000, "A", 120_000),
					play(L - 1, "B", 130_000),
					play(L, "B", 140_000),
				];
				const second = [
					play(L - 1, "B", 130_000),
					play(L, "B", 140_000),
					play(L + 1, "C", 150_000),
				];
				const files = [first, second, first];
				const done = finishListens(build(files), L);
				expect(done.tracks).toEqual([track("A"), track("B")]);
				expect(done.rows.map((r) => [r[0], r[1], r[2]])).toEqual([
					[sec(L - 3_000), 0, 120_000],
					[sec(L - 1), 1, 130_000],
				]);
				expect(done).toEqual(beforeOnly(files, L));
			});

			it("names a song as its first kept play does, not as a left-out later one", () => {
				const later = [
					play(L, "A", 200_000, { master_metadata_track_name: "Später umbenannt" }),
					play(L + 1, "A", 200_000, { master_metadata_album_album_name: "Spätere Platte" }),
					play(L + 2, "D", 200_000, { master_metadata_track_name: "Nur später" }),
				];
				const earlier = [play(L - 2, "A", 180_000), play(L - 1, "D", 25_000)];
				const files = [later, earlier];
				const done = finishListens(build(files), L);
				expect(done.tracks).toEqual([track("A"), track("D")]);
				expect(done).toEqual(beforeOnly(files, L));
			});

			it("numbers the songs of the kept plays only, in the order they are first heard", () => {
				// Songs first seen from the cutoff on take the first places in the whole song list.
				const files = [
					[play(L + 1, "X", 60_000), play(L, "Y", 60_000)],
					[play(L - 5_000, "Z", 60_000), play(L - 1, "Y", 61_000), play(L - 7_000, "W", 62_000)],
				];
				const b = build(files);
				expect(b.tracks.map((t) => t[0])).toEqual([id("X"), id("Y"), id("Z"), id("W")]);
				const done = finishListens(b, L);
				expect(done.tracks.map((t) => t[0])).toEqual([id("W"), id("Z"), id("Y")]);
				expect(done.rows.map((r) => [r[0], r[1], r[2]])).toEqual([
					[sec(L - 7_000), 0, 62_000],
					[sec(L - 5_000), 1, 60_000],
					[sec(L - 1), 2, 61_000],
				]);
				for (const r of done.rows) expect(isListenRow(r, done.tracks.length, sec(L))).toBe(true);
				for (const t of done.tracks) expect(isListenTrack(t)).toBe(true);
				expect(done).toEqual(beforeOnly(files, L));
			});

			it("tells a file from the cutoff on only as later only", () => {
				const b = build([
					[play(L, "N", 200_000), play(L + 1, "N", 200_000), play(L + 60_000, "P", 1)],
				]);
				expect(finishListens(b, L)).toEqual({ tracks: [], rows: [] });
				expect(onlyLater(b, L)).toBe(true);
				// One play a millisecond before is enough to count.
				addListens([play(L - 1, "N", 5_000)], b);
				expect(onlyLater(b, L)).toBe(false);
				expect(finishListens(b, L).rows.map((r) => r[2])).toEqual([5_000]);
			});
		});
	}

	it("never calls podcasts, unreadable times or broken song ids later only", () => {
		const L = L5;
		const files = [
			[
				episode(play(L - 1, "A", 100_000)),
				episode(play(L + 1, "A", 100_000)),
				play(L + 2, "B", 100_000, { spotify_track_uri: "spotify:track:kurz" }),
				play("kein Datum", "C", 100_000),
				{ ...play(L + 3, "D", 100_000), ts: undefined },
				play("1970-01-01T00:00:00.000Z", "E", 100_000),
			],
		];
		const b = build(files);
		expect(b.rows.size).toBe(0);
		expect(onlyLater(b, L)).toBe(false);
		expect(finishListens(b, L)).toEqual({ tracks: [], rows: [] });
		expect(onlyLater(build([]), L)).toBe(false);
	});

	it("keeps every play without a cutoff, the last read of a song in a second winning", () => {
		const files = [
			[play(L5 - 1, "A", 111_000), play(L5, "A", 222_000), play(L5 + 1, "B", 333_000)],
			[play(L5 + 2, "A", 444_000, { master_metadata_track_name: "Anders" })],
		];
		for (const done of [finishListens(build(files)), finishListens(build(files), null)]) {
			expect(done.tracks).toEqual([track("A"), track("B")]);
			expect(done.rows).toEqual([
				[sec(L5), 0, 444_000, OPENER, 0],
				[sec(L5), 1, 333_000, DONE, 0],
			]);
		}
	});

	it("gives the same twice from one builder, and leaves the builder's own rows as read", () => {
		const b = build([
			[play(L5 - 9_000, "A", 1_000), play(L5 + 1, "B", 2_000), play(L5 - 1, "C", 3_000)],
		]);
		const rows = [...b.rows.values()].map((r) => [...r]);
		const first = finishListens(b, L5);
		expect(finishListens(b, L5)).toEqual(first);
		expect(finishListens(b).rows).toHaveLength(3);
		expect([...b.rows.values()]).toEqual(rows);
		expect(Object.keys(b).sort()).toEqual(["index", "rows", "tracks"]);
	});

	it("reads the same moment the same in UTC and with an offset", () => {
		const L = L5;
		const z = [
			play("2026-10-17T01:39:00.499Z", "A", 100_000),
			play("2026-10-17T01:39:00.500Z", "B", 1),
		];
		const offset = [
			play("2026-10-17T03:39:00.499+02:00", "A", 100_000),
			play("2026-10-17T03:39:00.500+02:00", "B", 1),
			play("2026-10-16T21:39:00.500-04:00", "C", 1),
		];
		for (const files of [[z], [offset], [z, offset], [offset, z]]) {
			const done = finishListens(build(files), L);
			expect(done.tracks).toEqual([track("A")]);
			expect(done.rows.map((r) => [r[0], r[2]])).toEqual([[sec(L), 100_000]]);
			expect(done).toEqual(beforeOnly(files, L));
		}
	});

	it("cuts by the moment across the switch back from summer time", () => {
		// 25 Oct 2026, Berlin: 03:00 CEST becomes 02:00 CET; 02:30 comes twice.
		const L = Date.parse("2026-10-25T02:30:00.500+02:00");
		const files = [
			[
				play("2026-10-25T02:30:00.499+02:00", "A", 100_000),
				play("2026-10-25T02:30:00.500+02:00", "A", 200_000),
				// The second 02:30, an hour later, though its clock reads earlier.
				play("2026-10-25T02:30:00.100+01:00", "B", 300_000),
			],
		];
		const done = finishListens(build(files), L);
		expect(done.tracks).toEqual([track("A")]);
		expect(done.rows.map((r) => [r[0], r[2]])).toEqual([[sec(L), 100_000]]);
		expect(done).toEqual(beforeOnly(files, L));
	});

	it("cuts by the moment across the switch to summer time", () => {
		// 29 Mar 2026, Berlin: 02:00 CET becomes 03:00 CEST.
		const L = Date.parse("2026-03-29T03:00:00.000+02:00");
		const files = [
			[
				play("2026-03-29T01:59:59.999+01:00", "A", 100_000),
				play("2026-03-29T03:00:00.000+02:00", "A", 200_000),
				play("2026-03-29T01:00:00.001Z", "B", 300_000),
			],
		];
		const done = finishListens(build(files), L);
		expect(done.tracks).toEqual([track("A")]);
		expect(done.rows.map((r) => [r[0], r[2]])).toEqual([[sec(L) - 1, 100_000]]);
		expect(done).toEqual(beforeOnly(files, L));
	});

	it("cuts by the moment at Berlin and UTC midnight", () => {
		for (const [L, before, at] of [
			[
				Date.parse("2026-10-17T00:00:00.000+02:00"),
				"2026-10-16T23:59:59.999+02:00",
				"2026-10-16T22:00:00.000Z",
			],
			[
				Date.parse("2026-10-18T00:00:00.500Z"),
				"2026-10-18T02:00:00.499+02:00",
				"2026-10-18T00:00:00.500Z",
			],
		] as const) {
			const files = [[play(before, "A", 100_000)], [play(at, "A", 200_000), play(L + 1, "B", 1)]];
			const done = finishListens(build(files), L);
			expect(done.tracks).toEqual([track("A")]);
			expect(done.rows.map((r) => r[2])).toEqual([100_000]);
			expect(done).toEqual(beforeOnly(files, L));
		}
	});

	it("tells openers from the whole file, plays left out and podcasts included", () => {
		const L = L5;
		// Out of order on purpose: a play left out came just before in the file.
		const files = [
			[
				play(L + 1, "X", 1_000),
				play(L - 1, "A", 100_000),
				episode(play(L - 20 * 60_000, "P", 60_000)),
				play(L - 19 * 60_000, "B", 30_000),
			],
		];
		const done = finishListens(build(files), L);
		const flags = new Map(done.rows.map((r) => [done.tracks[r[1]]![0], r[3]]));
		expect(flags.get(id("A"))).toBe(DONE);
		expect(flags.get(id("B"))).toBe(DONE);
		// The weighting walks the same file through the same rule.
		const opens = startTracker();
		expect(files[0]!.map((e) => opens(e))).toEqual([true, false, false, false]);
		expect(done).toEqual(beforeOnly(files, L));
	});

	it("keeps the plays the weighting keeps, by song and second", () => {
		const L = L5;
		const files = [
			[play(L - 2_000, "A", 40_000), play(L - 1, "B", 40_000), play(L, "B", 40_000)],
			[play(L + 1, "A", 40_000), play(L - 1, "A", 40_000), play(L + 3_000, "C", 40_000)],
		];
		const agg = emptyAggregate();
		for (const f of files) aggregateHistory(f as ExtendedEntry[], agg, { before: L });
		const done = finishListens(build(files), L);
		const keys = done.rows.map((r) => `${r[0]}:${done.tracks[r[1]]![0]}`);
		expect(new Set(keys)).toEqual(agg.seen);
		expect(keys).toHaveLength(agg.seen.size);
	});
});

/** finishListens as it was before the cut by the full time (04f8c900), for the no-cutoff output. */
function legacyFinish(b: ListenBuilder): { tracks: ListenTrack[]; rows: ListenRow[] } {
	const rows = [...b.rows.values()]
		.map((r): ListenRow => [r[0], r[1], r[2], r[3], r[4]])
		.sort((x, y) => x[0] - y[0]);
	const remap = new Map<number, number>();
	const tracks: ListenTrack[] = [];
	for (const r of rows) {
		let i = remap.get(r[1]);
		if (i === undefined) {
			i = tracks.length;
			remap.set(r[1], i);
			tracks.push(b.tracks[r[1]]!);
		}
		r[1] = i;
	}
	return { tracks, rows };
}

/** One generated entry, around the cutoff. */
interface Gen {
	offset: number;
	song: string;
	name: string;
	ms: number;
	kind: string;
	zone: string;
}

describe("the cut over many generated files (fixed seed)", () => {
	const entry: fc.Arbitrary<Gen> = fc.record({
		offset: fc.oneof(
			fc.integer({ min: -3_000, max: 3_000 }),
			fc.integer({ min: -40 * 86_400_000, max: 40 * 86_400_000 }),
		),
		song: fc.constantFrom("A", "B", "C"),
		name: fc.constantFrom("eins", "zwei"),
		ms: fc.integer({ min: 0, max: 400_000 }),
		kind: fc.constantFrom("music", "music", "music", "music", "episode", "broken"),
		zone: fc.constantFrom("Z", "+02:00", "-05:30"),
	});
	const files = fc.array(fc.array(entry, { maxLength: 12 }), { maxLength: 4 });
	const cutoff = fc.constantFrom(L0, L5, L0 + 999, L0 + 1);

	const toEntries = (L: number, fs: Gen[][]): ListenEntry[][] =>
		fs.map((f) =>
			f.map((x) => {
				const at = L + x.offset;
				const ts = x.zone === "Z" ? iso(at) : zoned(at, x.zone);
				const e = play(ts, x.song, x.ms, { master_metadata_track_name: x.name });
				if (x.kind === "episode") return episode(e);
				if (x.kind === "broken") return { ...e, spotify_track_uri: "spotify:track:x" };
				return e;
			}),
		);

	it("equals the before-only reference, keeps the no-cutoff output and tells later only", () => {
		fc.assert(
			fc.property(cutoff, files, (L, fs) => {
				const input = toEntries(L, fs);
				const b = build(input);
				expect(finishListens(b, L)).toEqual(beforeOnly(input, L));
				expect(finishListens(b)).toEqual(legacyFinish(build(input)));
				const music = input
					.flat()
					.filter((e) => /^spotify:track:\w{22}$/.test(e.spotify_track_uri ?? ""));
				const kept = music.filter((e) => Date.parse(e.ts!) < L);
				expect(onlyLater(b, L)).toBe(music.length > 0 && kept.length === 0);
			}),
			{ seed: 261017, numRuns: 400 },
		);
	});
});

/** The same moment written with a fixed offset, e.g. 2026-10-17T03:39:00.500+02:00. */
function zoned(at: number, zone: string): string {
	const sign = zone[0] === "-" ? -1 : 1;
	const [h, m] = zone.slice(1).split(":").map(Number);
	const shift = sign * (h! * 60 + m!) * 60_000;
	return `${iso(at + shift).slice(0, -1)}${zone}`;
}
