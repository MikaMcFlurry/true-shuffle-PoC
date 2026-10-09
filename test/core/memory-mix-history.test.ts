import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	aggregateHistory,
	detectHistoryFile,
	fromRow,
	toRows,
	trackIdFromUri,
} from "../../src/core/history";
import {
	isFavorite,
	mergeMemory,
	tasteWeight,
	withEarlySkip,
	withPlay,
} from "../../src/core/memory";
import { PRESETS, sharesForMix, sharesForRules } from "../../src/core/mix";
import { DEFAULT_RULES, emptyMemory, normaliseRules } from "../../src/core/types";

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
		expect(tasteWeight(m, "later_less")).toBeLessThan(0.05);
		expect(tasteWeight(m, "consume")).toBe(1);
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
		expect(rs).toEqual(s);
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
