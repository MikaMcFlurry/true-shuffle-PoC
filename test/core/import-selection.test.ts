import { describe, expect, it } from "vitest";
import {
	applyOverrides,
	cleanSelection,
	dayStart,
	type ImportSelection,
	type InspectQuery,
	inspectImport,
	type ListenColumns,
	matcher,
	periodBounds,
	SelectionError,
	selectImport,
	weightOf,
} from "../../src/core/import-selection";
import { LISTEN_FLAG, type ListenTrack } from "../../src/core/listens";
import type { ImportedStats } from "../../src/core/memory";

const tid = (s: string) => s.padEnd(22, "x").slice(0, 22);
const RATED = LISTEN_FLAG.rated;

interface Heard {
	at: number;
	song: string;
	artist: string;
	ms: number;
	flags?: number;
}

/** The hub's columns for some plays, oldest first. */
function columns(plays: Heard[]): ListenColumns {
	const sorted = plays.slice().sort((a, b) => a.at - b.at);
	const tracks: ListenTrack[] = [];
	const index = new Map<string, number>();
	const at: number[] = [];
	const track: number[] = [];
	const ms: number[] = [];
	const meta: number[] = [];
	for (const p of sorted) {
		let i = index.get(p.song);
		if (i === undefined) {
			i = tracks.length;
			index.set(p.song, i);
			tracks.push([tid(p.song), p.song, p.artist, `${p.artist} Album`]);
		}
		at.push(Math.floor(p.at / 1000));
		track.push(i);
		ms.push(p.ms);
		meta.push(p.flags ?? RATED, 0);
	}
	return {
		tracks,
		rows: sorted.length,
		at: Uint32Array.from(at),
		track: Uint32Array.from(track),
		ms: Uint32Array.from(ms),
		meta: Uint8Array.from(meta),
	};
}

/**
 * The reference: song totals counted straight from the plays a selection
 * keeps, written independently of selectImport (one pass, no overrides).
 */
function reference(plays: Heard[], keep: (p: Heard) => boolean): Map<string, ImportedStats> {
	const out = new Map<string, ImportedStats>();
	for (const p of plays.slice().sort((a, b) => a.at - b.at)) {
		if (!keep(p)) continue;
		const w = weightOf(p.ms, p.flags ?? RATED);
		if (w === 0) continue;
		const at = Math.floor(p.at / 1000) * 1000;
		const s = out.get(tid(p.song)) ?? {
			plays: 0,
			earlySkips: 0,
			lastPlayedAt: null,
			lastSkippedAt: null,
			playedBeforeSkips: 0,
		};
		if (w === 1) {
			s.plays++;
			s.lastPlayedAt = Math.max(s.lastPlayedAt ?? 0, at);
			if (s.earlySkips === 0) s.playedBeforeSkips = (s.playedBeforeSkips ?? 0) + 1;
		} else {
			s.earlySkips++;
			s.lastSkippedAt = Math.max(s.lastSkippedAt ?? 0, at);
		}
		out.set(tid(p.song), s);
	}
	return out;
}

const D = (iso: string) => Date.parse(iso);
const SKIP = RATED | LISTEN_FLAG.forward;

/** Plays across three years, three artists; one song skipped early now and then. */
const PLAYS: Heard[] = [
	{ at: D("2019-03-01T10:00:00Z"), song: "Alpha", artist: "Ann", ms: 200_000 },
	{ at: D("2019-06-01T10:00:00Z"), song: "Alpha", artist: "Ann", ms: 200_000 },
	{ at: D("2019-12-31T23:30:00Z"), song: "Beta", artist: "Ben", ms: 180_000 },
	{ at: D("2020-01-02T10:00:00Z"), song: "Beta", artist: "Ben", ms: 5_000, flags: SKIP },
	{ at: D("2020-05-01T10:00:00Z"), song: "Alpha", artist: "Ann", ms: 210_000 },
	{ at: D("2020-07-01T10:00:00Z"), song: "Gamma", artist: "Cleo", ms: 240_000 },
	{ at: D("2021-02-01T10:00:00Z"), song: "Gamma", artist: "Cleo", ms: 240_000 },
	{ at: D("2021-02-02T10:00:00Z"), song: "Beta", artist: "Ben", ms: 190_000 },
	// Said nothing to the memory: short and not skipped; and an opener skipped.
	{ at: D("2021-03-01T10:00:00Z"), song: "Delta", artist: "Dora", ms: 4_000, flags: RATED },
	{
		at: D("2021-03-02T10:00:00Z"),
		song: "Delta",
		artist: "Dora",
		ms: 3_000,
		flags: SKIP | LISTEN_FLAG.opener,
	},
];

const sel = (rules: unknown[], enabled = true): ImportSelection =>
	cleanSelection({ enabled, rules });

/** The song totals an import of PLAYS uploads (everything counted). */
const AGG = reference(PLAYS, () => true);

describe("import selection rules", () => {
	it("folds duplicates (the later wins) and sorts into one canonical form", () => {
		const a = sel([
			{ type: "artist", kind: "exclude", name: "Ann" },
			{ type: "track", kind: "exclude", id: tid("Beta") },
			{ type: "artist", kind: "include", name: "  ann " },
		]);
		const b = sel([
			{ type: "artist", kind: "include", name: "Ann" },
			{ type: "track", kind: "exclude", id: tid("Beta") },
		]);
		expect(JSON.stringify(a.rules.map((r) => r.type))).toBe('["artist","track"]');
		expect(a.rules[0]).toMatchObject({ kind: "include" });
		expect(a.rules.length).toBe(b.rules.length);
	});

	it("refuses what it cannot read", () => {
		const bad = [
			{ enabled: "yes", rules: [] },
			{
				enabled: true,
				rules: [
					{ type: "period", kind: "include", from: "2020-01-01", to: "2020-01-02", zone: "UTC" },
				],
			},
			{
				enabled: true,
				rules: [
					{ type: "period", kind: "exclude", from: "2020-02-30", to: "2020-03-01", zone: "UTC" },
				],
			},
			{
				enabled: true,
				rules: [
					{ type: "period", kind: "exclude", from: "2020-03-02", to: "2020-03-01", zone: "UTC" },
				],
			},
			{
				enabled: true,
				rules: [
					{
						type: "period",
						kind: "exclude",
						from: "2020-03-01",
						to: "2020-03-01",
						zone: "Mars/Base",
					},
				],
			},
			{ enabled: true, rules: [{ type: "track", kind: "exclude", id: "short" }] },
			{ enabled: true, rules: [{ type: "summary", kind: "include" }] },
			{ enabled: true, rules: [{ type: "artist", kind: "exclude", name: "   " }] },
		];
		for (const b of bad) expect(() => cleanSelection(b)).toThrow(SelectionError);
	});

	it("decides by the most specific rule: song, then artist, then period", () => {
		const m = matcher(
			sel([
				{ type: "period", kind: "exclude", from: "2020-01-01", to: "2020-12-31", zone: "UTC" },
				{ type: "artist", kind: "include", name: "Ann" },
				{ type: "track", kind: "exclude", id: tid("Alpha") },
			]),
		);
		const at = D("2020-05-01T10:00:00Z");
		expect(m.included(m.event(at, tid("Alpha"), "ann"))).toBe(false); // song rule
		expect(m.included(m.event(at, tid("Other"), "ann"))).toBe(true); // artist beats period
		expect(m.included(m.event(at, tid("Gamma"), "cleo"))).toBe(false); // period
		expect(m.included(m.event(D("2021-01-01T00:00:00Z"), tid("Gamma"), "cleo"))).toBe(true);
	});
});

describe("calendar days in a time zone", () => {
	it("a period covers whole local days, both ends included", () => {
		const [from, to] = periodBounds({
			from: "2020-01-01",
			to: "2020-01-01",
			zone: "Europe/Berlin",
		});
		expect(from).toBe(D("2019-12-31T23:00:00Z"));
		expect(to).toBe(D("2020-01-01T23:00:00Z"));
		// Summer time: the day is 23 hours on the change.
		const [a, b] = periodBounds({ from: "2021-03-28", to: "2021-03-28", zone: "Europe/Berlin" });
		expect(b - a).toBe(23 * 3_600_000);
	});

	it("a skipped midnight begins the day at the first moment after it", () => {
		// America/Santiago: 2022-09-11 clocks went from 00:00 straight to 01:00 (-04 → -03).
		const start = dayStart("2022-09-11", "America/Santiago");
		expect(start).toBe(D("2022-09-11T04:00:00Z"));
		expect(dayStart("2022-09-10", "America/Santiago")).toBe(D("2022-09-10T04:00:00Z"));
		// The day before ends where this one begins: 23 hours, nothing lost or shared.
		const [a, b] = periodBounds({ from: "2022-09-10", to: "2022-09-10", zone: "America/Santiago" });
		expect(b).toBe(start);
		expect(b - a).toBe(24 * 3_600_000);
		// A midnight that happens twice (back to 23:00): the day begins once, after it.
		expect(dayStart("2022-04-03", "America/Santiago")).toBe(D("2022-04-03T04:00:00Z"));
	});

	it("a calendar day the zone skipped holds no moment", () => {
		// Pacific/Apia went from 29 December 2011 straight to 31 December.
		const [a, b] = periodBounds({ from: "2011-12-30", to: "2011-12-30", zone: "Pacific/Apia" });
		expect(a).toBe(b);
		expect(a).toBe(dayStart("2011-12-31", "Pacific/Apia"));
		const [c, d] = periodBounds({ from: "2011-12-29", to: "2011-12-31", zone: "Pacific/Apia" });
		expect(d - c).toBe(48 * 3_600_000);
	});

	it("a play at the very first second of a period is in, at its end out", () => {
		const r = {
			type: "period",
			kind: "exclude",
			from: "2020-01-01",
			to: "2020-12-31",
			zone: "Europe/Berlin",
		};
		const m = matcher(sel([r]));
		const [from, to] = periodBounds(r as never);
		expect(m.included(m.event(from - 1000, "x", "y"))).toBe(true);
		expect(m.included(m.event(from, "x", "y"))).toBe(false);
		expect(m.included(m.event(to - 1000, "x", "y"))).toBe(false);
		expect(m.included(m.event(to, "x", "y"))).toBe(true);
	});
});

describe("what a selection makes of the import", () => {
	const events = columns(PLAYS);
	const run = (s: ImportSelection, liveSince: number | null = null) =>
		selectImport({ events, aggregate: AGG, selection: s, liveSince });

	it("without rules, nothing changes", () => {
		const r = run(sel([]));
		expect(r.overrides.size).toBe(0);
		expect(applyOverrides(AGG, r.overrides)).toEqual(AGG);
		expect(r.counts).toMatchObject({ plays: 7, skips: 1, songs: 3, includedPlays: 7 });
		// Stored and shown, but nothing for the memory.
		expect(r.counts).toMatchObject({ rows: 10, neutralRows: 2, afterLiveRows: 0 });
	});

	it("a left-out period matches a reference counted from the kept plays only", () => {
		const s = sel([
			{
				type: "period",
				kind: "exclude",
				from: "2020-01-01",
				to: "2020-12-31",
				zone: "Europe/Berlin",
			},
		]);
		const [from, to] = periodBounds(s.rules[0] as never);
		const eff = applyOverrides(AGG, run(s).overrides);
		const ref = reference(PLAYS, (p) => !(p.at >= from && p.at < to));
		expect(eff).toEqual(ref);
		// Beta's 23:30 UTC play on New Year's Eve is 00:30 on 1 January in Berlin: left out.
		expect(eff.get(tid("Beta"))?.plays).toBe(1);
		// Alpha untouched where no play of it was left out? It lost one: counted again.
		expect(eff.get(tid("Alpha"))).toEqual(ref.get(tid("Alpha")));
	});

	it("a song brought back into a left-out period keeps exactly its plays there", () => {
		const s = sel([
			{ type: "period", kind: "exclude", from: "2020-01-01", to: "2020-12-31", zone: "UTC" },
			{ type: "track", kind: "include", id: tid("Gamma") },
		]);
		const [from, to] = periodBounds(s.rules[0] as never);
		const eff = applyOverrides(AGG, run(s).overrides);
		expect(eff).toEqual(
			reference(PLAYS, (p) => p.song === "Gamma" || !(p.at >= from && p.at < to)),
		);
		expect(eff.get(tid("Gamma"))).toEqual(AGG.get(tid("Gamma")));
	});

	it("an excluded artist takes only that artist's imported plays", () => {
		const r = run(sel([{ type: "artist", kind: "exclude", name: "BEN" }]));
		const eff = applyOverrides(AGG, r.overrides);
		expect(eff.has(tid("Beta"))).toBe(false);
		expect(eff.get(tid("Alpha"))).toBe(AGG.get(tid("Alpha")));
		expect(r.counts.rules).toEqual([{ key: "artist:ben", plays: 2, skips: 1, songs: 1 }]);
	});

	it("switched off, nothing counts; switched on again, the same as before", () => {
		const off = run(sel([], false));
		expect(off.counts).toMatchObject({ includedPlays: 0, includedSongs: 0, changedSongs: 3 });
		const again = run(sel([]));
		expect(applyOverrides(AGG, again.overrides)).toEqual(AGG);
	});

	it("is a pure function: the same input gives the same result", () => {
		const s = sel([{ type: "artist", kind: "exclude", name: "Cleo" }]);
		expect(JSON.stringify([...run(s).overrides])).toBe(JSON.stringify([...run(s).overrides]));
	});

	it("plays after live counting began are not the import's", () => {
		// Totals and plays are cut at the same moment by the import page.
		const live = D("2021-01-01T00:00:00Z");
		const r = selectImport({
			events,
			aggregate: reference(PLAYS, (p) => p.at < live),
			selection: sel([{ type: "artist", kind: "exclude", name: "Cleo" }]),
			liveSince: live,
		});
		expect(r.counts.rules[0]).toMatchObject({ plays: 1 });
	});

	it("songs known only by their totals: left out whole or kept, never split", () => {
		const agg = new Map(AGG);
		agg.set(tid("Old"), { plays: 9, earlySkips: 0, lastPlayedAt: D("2018-01-01T00:00:00Z") });
		const base = { events, aggregate: agg, liveSince: null };
		const period = selectImport({
			...base,
			selection: sel([
				{ type: "period", kind: "exclude", from: "2018-01-01", to: "2018-12-31", zone: "UTC" },
			]),
		});
		// A period cannot reach it: it has no single plays to place in time.
		expect(applyOverrides(agg, period.overrides).get(tid("Old"))?.plays).toBe(9);
		expect(period.counts).toMatchObject({
			summarySongs: 1,
			summaryPlays: 9,
			includedSummarySongs: 1,
		});
		const out = selectImport({ ...base, selection: sel([{ type: "summary", kind: "exclude" }]) });
		expect(applyOverrides(agg, out.overrides).has(tid("Old"))).toBe(false);
		expect(applyOverrides(agg, out.overrides).get(tid("Alpha"))).toBe(agg.get(tid("Alpha")));
		const back = selectImport({
			...base,
			selection: sel([
				{ type: "summary", kind: "exclude" },
				{ type: "track", kind: "include", id: tid("Old") },
			]),
		});
		expect(applyOverrides(agg, back.overrides).get(tid("Old"))?.plays).toBe(9);
	});

	it("an empty import or none at all gives nothing and invents nothing", () => {
		const r = selectImport({
			events: null,
			aggregate: new Map(),
			selection: sel([{ type: "artist", kind: "exclude", name: "x" }]),
			liveSince: null,
		});
		expect(r.overrides.size).toBe(0);
		expect(r.counts).toMatchObject({ plays: 0, songs: 0, rows: 0, from: null });
	});
});

describe("looking through the import", () => {
	const events = columns(PLAYS);
	const q = (over: Partial<InspectQuery> = {}): InspectQuery => ({
		q: "",
		group: "track",
		status: "all",
		sort: "plays",
		from: null,
		to: null,
		offset: 0,
		limit: 50,
		...over,
	});
	const look = (s: ImportSelection, query: InspectQuery) =>
		inspectImport({ events, aggregate: AGG, selection: s, liveSince: null, query });

	it("keeps excluded entries findable, with the rule that decided", () => {
		const s = sel([{ type: "artist", kind: "exclude", name: "Ben" }]);
		const p = look(s, q({ q: "beta" }));
		expect(p.total).toBe(1);
		expect(p.items[0]).toMatchObject({
			name: "Beta",
			status: "excluded",
			plays: 2,
			includedPlays: 0,
			rules: ["artist:ben"],
		});
		expect(look(s, q({ status: "excluded" })).items.map((x) => x.name)).toEqual(["Beta"]);
	});

	it("shows stored plays that count for nothing, apart from what counts", () => {
		const p = look(sel([]), q({ q: "delta" }));
		expect(p.items[0]).toMatchObject({
			name: "Delta",
			status: "neutral",
			rows: 2,
			neutral: 2,
			plays: 0,
			skips: 0,
		});
		expect(look(sel([]), q({ status: "neutral" })).items.map((x) => x.name)).toEqual(["Delta"]);
		// A song with both: every stored play is listed, the neutral ones apart.
		const alpha = look(sel([]), q({ q: "alpha" })).items[0]!;
		expect(alpha).toMatchObject({ rows: 3, neutral: 0, plays: 3 });
	});

	it("lists stored plays from live time, apart and with no import influence", () => {
		const liveSince = D("2021-01-01T00:00:00Z");
		const s = sel([{ type: "artist", kind: "exclude", name: "Cleo" }]);
		// Totals and plays are cut at the same moment by the import page.
		const aggregate = reference(PLAYS, (p) => p.at < liveSince);
		const base = { events, aggregate, selection: s, liveSince };
		const delta = inspectImport({ ...base, query: q({ q: "delta" }) }).items[0]!;
		// Both of Delta's plays lie in live time: listed, none counted, none called "neutral" twice.
		expect(delta).toMatchObject({ rows: 2, afterLive: 2, neutral: 0, plays: 0, status: "neutral" });
		const gamma = inspectImport({ ...base, query: q({ q: "gamma" }) }).items[0]!;
		// One play before (left out by the artist rule), one in live time (no rule decides it).
		expect(gamma).toMatchObject({
			rows: 2,
			afterLive: 1,
			plays: 1,
			includedPlays: 0,
			status: "excluded",
		});
		const counts = selectImport(base).counts;
		expect(counts).toMatchObject({ rows: 10, afterLiveRows: 4, neutralRows: 0 });
		// The selection's effect on the memory is the same as without those rows.
		const before = { ...events, rows: 6 };
		expect([...selectImport(base).overrides]).toEqual([
			...selectImport({ ...base, events: before }).overrides,
		]);
	});

	it("groups by artist, filters by time without changing anything, sorts", () => {
		const p = look(sel([]), q({ group: "artist", sort: "name" }));
		expect(p.items.map((x) => x.name)).toEqual(["Ann", "Ben", "Cleo", "Dora"]);
		const y2021 = look(
			sel([]),
			q({ from: D("2021-01-01T00:00:00Z"), to: D("2022-01-01T00:00:00Z"), sort: "name" }),
		);
		expect(y2021.items.map((x) => x.name)).toEqual(["Beta", "Delta", "Gamma"]);
		expect(y2021.items.find((x) => x.name === "Gamma")!.plays).toBe(1);
		expect(look(sel([]), q({ sort: "recent" })).items[0]!.name).toBe("Delta");
	});
});

describe("size", () => {
	it("selects and looks through a history at the upper bound (300 000 plays, 100 000 songs) in seconds", () => {
		const songs = 100_000;
		const rows = 300_000;
		const tracks: ListenTrack[] = Array.from({ length: songs }, (_, i) => [
			tid(`s${i}`),
			`Song ${i}`,
			`Artist ${i % 5000}`,
			`Album ${i % 20000}`,
		]);
		const start = Math.floor(D("2015-01-01T00:00:00Z") / 1000);
		const events: ListenColumns = {
			tracks,
			rows,
			at: Uint32Array.from({ length: rows }, (_, i) => start + i * 900),
			track: Uint32Array.from({ length: rows }, (_, i) => (i * 7919) % songs),
			ms: Uint32Array.from({ length: rows }, (_, i) => (i % 9 === 0 ? 5000 : 200_000)),
			meta: Uint8Array.from({ length: rows * 2 }, (_, i) => (i % 2 === 0 ? SKIP : 0)),
		};
		const aggregate = new Map<string, ImportedStats>();
		const s = sel([
			{
				type: "period",
				kind: "exclude",
				from: "2016-01-01",
				to: "2016-12-31",
				zone: "Europe/Berlin",
			},
			{ type: "artist", kind: "exclude", name: "Artist 7" },
			{ type: "track", kind: "include", id: tid("s1") },
		]);
		const t0 = performance.now();
		const r = selectImport({ events, aggregate, selection: s, liveSince: null });
		const t1 = performance.now();
		const page = inspectImport({
			events,
			aggregate,
			selection: s,
			liveSince: null,
			query: {
				q: "song 12",
				group: "track",
				status: "all",
				sort: "plays",
				from: null,
				to: null,
				offset: 0,
				limit: 50,
			},
		});
		const t2 = performance.now();
		expect(r.counts.rows).toBe(rows);
		expect(r.counts.includedPlays).toBeLessThan(r.counts.plays);
		expect(page.items.length).toBeGreaterThan(0);
		console.log(`SIZE select ${Math.round(t1 - t0)} ms, inspect ${Math.round(t2 - t1)} ms`);
		expect(t1 - t0).toBeLessThan(5000);
		expect(t2 - t1).toBeLessThan(5000);
	});
});
