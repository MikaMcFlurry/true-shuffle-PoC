import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	aggregateHistory,
	detectHistoryFile,
	emptyAggregate,
	fromRow,
	playedBeforeSkips,
	toRows,
	trackIdFromUri,
} from "../../src/core/history";
import {
	coolingDown,
	isFavorite,
	isOverplayed,
	mergeMemory,
	OVERPLAYED_REST_MS,
	retestAfter,
	skipsWeigh,
	tasteWeight,
	withEarlySkip,
	withPlay,
} from "../../src/core/memory";
import { PRESETS, sharesForMix, sharesForRules } from "../../src/core/mix";
import { DAY_MS, DEFAULT_RULES, emptyMemory, normaliseRules } from "../../src/core/types";

describe("mix", () => {
	it("defaults to the Entdecker preset (60/10/30)", () => {
		const s = sharesForMix(PRESETS.entdecker);
		expect(s.fresh).toBeCloseTo(0.6);
		expect(s.favorite).toBeCloseTo(0.1);
		expect(s.discovery).toBeCloseTo(0.3);
		expect(DEFAULT_RULES.mix).toBe(PRESETS.entdecker);
	});

	it("always sums to one", () => {
		fc.assert(
			fc.property(fc.integer({ min: -50, max: 150 }), (mix) => {
				const s = sharesForMix(mix);
				expect(s.fresh + s.favorite + s.discovery).toBeCloseTo(1);
				expect(Math.min(s.fresh, s.favorite, s.discovery)).toBeGreaterThanOrEqual(0);
			}),
		);
	});

	it("moves toward favourites as the slider moves toward Vertraut", () => {
		expect(sharesForMix(100).favorite).toBeGreaterThan(sharesForMix(0).favorite);
		expect(sharesForMix(0).discovery).toBeGreaterThan(sharesForMix(100).discovery);
	});

	it("applies the favourite override and switching discovery off", () => {
		const s = sharesForRules({ ...DEFAULT_RULES, favoriteShare: 0.5, discoveryEnabled: false });
		expect(s.favorite).toBeCloseTo(0.5);
		expect(s.discovery).toBe(0);
		expect(s.fresh).toBeCloseTo(0.5);
	});

	it("normalises garbage rules to safe values", () => {
		const r = normaliseRules({ mix: 999, artistSpacing: -3, skipPolicy: "nope" as never });
		expect(r.mix).toBe(100);
		expect(r.artistSpacing).toBe(0);
		expect(r.skipPolicy).toBe("later_less");
	});
});

describe("memory", () => {
	it("recognises favourites from hearts, thumbs and behaviour", () => {
		expect(isFavorite({ ...emptyMemory("a"), liked: true })).toBe(true);
		expect(isFavorite({ ...emptyMemory("a"), thumb: 1 })).toBe(true);
		expect(isFavorite({ ...emptyMemory("a"), plays: 6, earlySkips: 1 })).toBe(true);
		expect(isFavorite({ ...emptyMemory("a"), plays: 6, earlySkips: 4 })).toBe(false);
		expect(isFavorite({ ...emptyMemory("a"), liked: true, thumb: -1 })).toBe(false);
	});

	it("makes a song barely playable after three early skips (later_less), not under consume", () => {
		let m = emptyMemory("a");
		for (let i = 0; i < 3; i++) m = withEarlySkip(m, i);
		expect(tasteWeight(m, "later_less", 3)).toBeLessThan(0.05);
		expect(tasteWeight(m, "consume", 3)).toBe(1);
	});

	describe("overplayed: loved first, skipped later", () => {
		const tiredOf = (before: number, skippedAt: number) =>
			mergeMemory(emptyMemory("a"), {
				plays: before + 2,
				earlySkips: 12,
				lastPlayedAt: skippedAt - DAY_MS,
				lastSkippedAt: skippedAt,
				playedBeforeSkips: before,
			});

		it("rests after its last skip instead of being held against, then plays like any other", () => {
			const m = tiredOf(5, 0);
			expect(isOverplayed(m)).toBe(true);
			expect(skipsWeigh(m, DAY_MS)).toBe(false);
			expect(tasteWeight(m, "later_less", DAY_MS)).toBe(1);
			expect(coolingDown(m, OVERPLAYED_REST_MS - 1)).toBe(true);
			expect(coolingDown(m, OVERPLAYED_REST_MS)).toBe(false);
			// Skipped again later: rests again.
			const again = withEarlySkip(m, 200 * DAY_MS);
			expect(isOverplayed(again)).toBe(true);
			expect(coolingDown(again, 201 * DAY_MS)).toBe(true);
		});

		it("four plays before the first skip are not enough; an older import does not tell", () => {
			const m = tiredOf(4, 0);
			expect(isOverplayed(m)).toBe(false);
			expect(tasteWeight(m, "later_less", DAY_MS)).toBeLessThan(0.05);
			const old = mergeMemory(emptyMemory("a"), { plays: 50, earlySkips: 12, lastPlayedAt: 1 });
			expect(isOverplayed(old)).toBe(false);
			// Never skipped in the import: every imported play came before a live skip.
			const live = mergeMemory(withEarlySkip(emptyMemory("a"), 9), {
				plays: 7,
				earlySkips: 0,
				lastPlayedAt: 1,
			});
			expect(live.playedBeforeSkips).toBe(7);
			expect(isOverplayed(live)).toBe(true);
		});

		it("counts the plays before the first early skip, whatever the order of the files, each play once", () => {
			const uri = `spotify:track:${"o".repeat(22)}`;
			const play = (ts: string) => ({ ts, ms_played: 200_000, spotify_track_uri: uri });
			const skip = (ts: string) => ({
				ts,
				ms_played: 3_000,
				spotify_track_uri: uri,
				reason_start: "trackdone",
				reason_end: "fwdbtn",
			});
			const filler = (ts: string) => ({ ts, ms_played: 200_000, spotify_track_uri: null });
			const later = [
				filler("2025-06-01T09:59:00Z"),
				skip("2025-06-01T10:00:00Z"),
				play("2025-07-01T10:00:00Z"),
			];
			const earlier = [
				play("2025-01-01T10:00:00Z"),
				play("2025-01-02T10:00:00Z"),
				play("2025-01-03T10:00:00Z"),
				play("2025-01-04T10:00:00Z"),
				play("2025-01-05T10:00:00Z"),
			];
			const agg = emptyAggregate();
			aggregateHistory(later, agg);
			aggregateHistory(earlier, agg);
			// The same file twice: nothing counts twice.
			aggregateHistory(earlier, agg);
			const id = "o".repeat(22);
			expect(agg.stats.get(id)).toMatchObject({ plays: 6, earlySkips: 1 });
			expect(playedBeforeSkips(agg, id)).toBe(5);
			expect(toRows(agg)[0]).toEqual([
				id,
				6,
				1,
				Date.parse("2025-07-01T10:00:00Z"),
				Date.parse("2025-06-01T10:00:00Z"),
				5,
			]);
			expect(fromRow(toRows(agg)[0]!)[1].playedBeforeSkips).toBe(5);
		});
	});

	describe("asking again about a skipped song", () => {
		const skipped = (n: number, at: number) => {
			let m = emptyMemory("a");
			for (let i = 0; i < n; i++) m = withEarlySkip(m, at);
			return m;
		};

		it("is due a month after one skip, twice as long per further skip, at most a year", () => {
			expect(retestAfter(1)).toBe(30 * DAY_MS);
			expect(retestAfter(2)).toBe(60 * DAY_MS);
			expect(retestAfter(3)).toBe(120 * DAY_MS);
			expect(retestAfter(34)).toBe(365 * DAY_MS);
			const m = skipped(3, 0);
			expect(tasteWeight(m, "later_less", 120 * DAY_MS - 1)).toBeLessThan(0.05);
			// Due: it plays like any other song once more.
			expect(tasteWeight(m, "later_less", 120 * DAY_MS)).toBe(1);
		});

		it("heard to 30 s since: the skips stop counting; skipped again: they count, the next check further off", () => {
			let m = withPlay(skipped(3, 0), 200 * DAY_MS);
			expect(skipsWeigh(m, 201 * DAY_MS)).toBe(false);
			expect(tasteWeight(m, "later_less", 201 * DAY_MS)).toBe(1);
			m = withEarlySkip(m, 300 * DAY_MS);
			expect(tasteWeight(m, "later_less", 301 * DAY_MS)).toBeLessThan(0.05);
			expect(skipsWeigh(m, 300 * DAY_MS + retestAfter(4) - 1)).toBe(true);
			expect(skipsWeigh(m, 300 * DAY_MS + retestAfter(4))).toBe(false);
		});

		it("imported skips are dated; an older undated import keeps counting until imported again", () => {
			const dated = mergeMemory(emptyMemory("a"), {
				plays: 0,
				earlySkips: 34,
				lastPlayedAt: null,
				lastSkippedAt: DAY_MS,
			});
			expect(dated.lastSkippedAt).toBe(DAY_MS);
			expect(skipsWeigh(dated, 2 * DAY_MS)).toBe(true);
			expect(skipsWeigh(dated, DAY_MS + 365 * DAY_MS)).toBe(false);
			const undated = mergeMemory(emptyMemory("a"), {
				plays: 0,
				earlySkips: 34,
				lastPlayedAt: null,
			});
			expect(skipsWeigh(undated, 10_000 * DAY_MS)).toBe(true);
			// A live skip is later than anything imported, and keeps its "nicht jetzt".
			const live = mergeMemory(withEarlySkip(emptyMemory("a"), 5 * DAY_MS), {
				plays: 0,
				earlySkips: 34,
				lastPlayedAt: null,
			});
			expect(live.lastSkippedAt).toBe(5 * DAY_MS);
			expect(fromRow(["a".repeat(22), 1, 2, 3, 4])[1].lastSkippedAt).toBe(4);
			expect(fromRow(["a".repeat(22), 1, 2, 3])[1].lastSkippedAt).toBeUndefined();
		});
	});

	it("merges live memory with imported history", () => {
		const live = withPlay(emptyMemory("a"), 100);
		const merged = mergeMemory(live, { plays: 10, earlySkips: 2, lastPlayedAt: 50 });
		expect(merged.plays).toBe(11);
		expect(merged.earlySkips).toBe(2);
		expect(merged.lastPlayedAt).toBe(100);
	});
});

describe("history import", () => {
	const id = "4uLU6hMCjMI75M1A2tKUQC";
	it("detects the export formats", () => {
		expect(detectHistoryFile([{ ts: "x", ms_played: 1, spotify_track_uri: null }])).toBe(
			"extended",
		);
		expect(detectHistoryFile([{ endTime: "x", msPlayed: 1, trackName: "y" }])).toBe("account");
		expect(detectHistoryFile({})).toBe("unknown");
	});

	it("parses track uris strictly", () => {
		expect(trackIdFromUri(`spotify:track:${id}`)).toBe(id);
		expect(trackIdFromUri("spotify:episode:4uLU6hMCjMI75M1A2tKUQC")).toBeNull();
		expect(trackIdFromUri(null)).toBeNull();
	});

	it("counts >= 30 s as plays and short forward-button ends as early skips", () => {
		const agg = aggregateHistory([
			{
				ts: "2025-01-01T10:00:00Z",
				ms_played: 200_000,
				spotify_track_uri: `spotify:track:${id}`,
				reason_end: "trackdone",
			},
			{
				ts: "2025-02-01T10:00:00Z",
				ms_played: 31_000,
				spotify_track_uri: `spotify:track:${id}`,
				reason_end: "fwdbtn",
			},
			// Skipped right after another song ended (podcasts keep the listening going too).
			{ ts: "2025-03-01T09:59:50Z", ms_played: 600_000, spotify_track_uri: null },
			{
				ts: "2025-03-01T10:00:00Z",
				ms_played: 4_000,
				spotify_track_uri: `spotify:track:${id}`,
				reason_start: "trackdone",
				reason_end: "fwdbtn",
			},
			{
				ts: "2025-03-02T10:00:00Z",
				ms_played: 4_000,
				spotify_track_uri: `spotify:track:${id}`,
				reason_end: "logout",
			},
			{ ts: "2025-03-03T10:00:00Z", ms_played: 90_000, spotify_track_uri: null },
		]);
		const s = agg.stats.get(id)!;
		expect(s.plays).toBe(2);
		expect(s.earlySkips).toBe(1);
		expect(s.lastPlayedAt).toBe(Date.parse("2025-02-01T10:00:00Z"));
		expect(agg.ignored).toBe(3);
		expect(agg.openers).toBe(0);
		const [rid, rs] = fromRow(toRows(agg)[0]!);
		expect(rid).toBe(id);
		expect(rs).toEqual({ ...s, playedBeforeSkips: 2 });
	});
});

describe("aggregateHistory and the first song after a start", () => {
	const uri = `spotify:track:${"o".repeat(22)}`;
	const play = (ts: string) => ({
		ts,
		ms_played: 200_000,
		spotify_track_uri: `spotify:track:${"p".repeat(22)}`,
	});
	const skip = (ts: string, reason_start?: string) => ({
		ts,
		ms_played: 3_000,
		spotify_track_uri: uri,
		reason_start,
		reason_end: "fwdbtn",
	});

	it("does not hold a skipped opener against the song: started afresh, after a silence, or first in the file", () => {
		const agg = aggregateHistory([
			skip("2025-01-01T08:00:00Z"),
			play("2025-01-01T08:04:00Z"),
			// Shuffle pressed again two minutes later: Spotify's reason_start tells.
			skip("2025-01-01T08:06:00Z", "clickrow"),
			play("2025-01-01T08:10:00Z"),
			// Twenty minutes of nothing, then a skip with no reason_start.
			skip("2025-01-01T08:30:00Z"),
			play("2025-01-01T08:34:00Z"),
			// Mid-listening: counts.
			skip("2025-01-01T08:34:10Z", "trackdone"),
			skip("2025-01-01T08:34:20Z"),
		]);
		expect(agg.openers).toBe(3);
		expect(agg.skipped).toBe(2);
		expect(agg.stats.get("o".repeat(22))?.earlySkips).toBe(2);
	});
});

describe("aggregateHistory with a live start", () => {
	it("counts only listening before true-shuffle started counting live", () => {
		const uri = "spotify:track:0123456789abcdefghijkl";
		const agg = aggregateHistory(
			[
				{ ts: "2026-09-01T10:00:00Z", ms_played: 200_000, spotify_track_uri: uri },
				{ ts: "2026-09-20T10:00:00Z", ms_played: 200_000, spotify_track_uri: uri },
			] as never,
			undefined,
			{ before: Date.parse("2026-09-10T00:00:00Z") },
		);
		expect(agg.stats.get("0123456789abcdefghijkl")?.plays).toBe(1);
	});
});
