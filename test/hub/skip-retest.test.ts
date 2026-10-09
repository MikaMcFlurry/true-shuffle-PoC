import { describe, expect, it } from "vitest";
import { aggregateHistory, emptyAggregate, toRows } from "../../src/core/history";
import { addListens, finishListens, type ListenEntry, newListens } from "../../src/core/listens";
import { tasteWeight } from "../../src/core/memory";
import { DAY_MS } from "../../src/core/types";
import { onboarded } from "./harness";

it("an imported skip is dated: the song is asked about again once its check is due", async () => {
	const h = await onboarded({ tracks: 40 });
	const id = h.sql.first<{ data: string }>(`SELECT data FROM pages WHERE data <> '[]' LIMIT 1`)!;
	const song = (JSON.parse(id.data) as [string][])[0]![0];
	const now = h.clock.t;
	// 34 early skips, the last 400 days ago; another 10 days ago; and one with undated skips.
	h.hub.importHistory(
		[
			[song, 0, 34, 0, now - 400 * DAY_MS],
			["b".repeat(22), 0, 3, 0, now - 10 * DAY_MS],
			["c".repeat(22), 0, 3, 0],
		],
		0,
		1,
	);
	expect(h.hub.memory(song).lastSkippedAt).toBe(now - 400 * DAY_MS);
	expect(h.hub.memory("c".repeat(22)).lastSkippedAt).toBeNull();
	expect(() => h.hub.importHistory([[song, 0, 1, 0, now + 2 * DAY_MS]], 0, 1)).toThrow();
});

describe("the first song after a start: one verdict for the mix and the Hörprofil (PR27-OPENER-PODCAST-01)", () => {
	const id = (c: string) => c.repeat(22);
	const iso = (t: number) => new Date(t).toISOString();
	const music = (end: number, song: string, ms: number, extra: Partial<ListenEntry> = {}) => ({
		ts: iso(end),
		ms_played: ms,
		spotify_track_uri: `spotify:track:${id(song)}`,
		master_metadata_track_name: song,
		master_metadata_album_artist_name: `Artist ${song}`,
		...extra,
	});
	const skip = (end: number, song: string, reason_start?: string) =>
		music(end, song, 3_000, { reason_start, reason_end: "fwdbtn" });

	it("podcast, silence, a fresh start, mid-listening, several files: aggregate, hub memory and profile agree", async () => {
		const h = await onboarded({ tracks: 40 });
		const T = h.clock.t - 30 * DAY_MS;
		const H = 3_600_000;
		const files: ListenEntry[][] = [
			[
				music(T, "a", 180_000),
				// A podcast right after, then a song skipped straight away: listening went on.
				{ ts: iso(T + H), ms_played: 3_500_000, spotify_track_uri: null },
				skip(T + H + 3_000, "p", "trackdone"),
				// Twenty minutes of nothing, then a skip.
				music(T + 3 * H, "a", 180_000),
				skip(T + 3 * H + 20 * 60_000, "s"),
				// Started afresh two minutes later.
				music(T + 4 * H, "a", 180_000),
				skip(T + 4 * H + 120_000, "r", "clickrow"),
				// Mid-listening.
				music(T + 5 * H, "a", 180_000),
				skip(T + 5 * H + 3_000, "m", "trackdone"),
			],
			// The first entry of another file: nothing known before it.
			[skip(T + 6 * H, "f", "fwdbtn"), music(T + 6 * H + 200_000, "a", 180_000)],
		];
		const agg = emptyAggregate();
		const all = newListens();
		for (const f of files) {
			aggregateHistory(f, agg);
			addListens(f, all);
		}
		expect(agg).toMatchObject({ openers: 3, skipped: 2 });
		h.hub.importHistory(toRows(agg), 0, 1);
		const { tracks, rows } = finishListens(all);
		let upload: string | undefined;
		for (const [part, b] of [
			{ kind: "tracks", data: tracks },
			{ kind: "rows", data: rows },
		].entries())
			upload = h.hub.importListens({ upload, part, parts: 2, tracks: tracks.length, ...b }).upload;

		const now = h.clock.t;
		const weight = (s: string) => tasteWeight(h.hub.memory(id(s)), "later_less", now);
		for (const s of ["p", "m"]) {
			expect(h.hub.memory(id(s)).earlySkips).toBe(1);
			expect(weight(s)).toBe(0.5);
		}
		for (const s of ["s", "r", "f"]) {
			expect(h.hub.memory(id(s)).earlySkips).toBe(0);
			expect(weight(s)).toBe(1);
		}
		const p = h.hub.listeningProfile("UTC");
		expect(p.skips).toMatchObject({ early: 2, openers: 3 });
		expect(p.skips!.top.map((x) => x.name).sort()).toEqual(["m", "p"]);
		expect(p.skips!.topOpeners.map((x) => x.name).sort()).toEqual(["f", "r", "s"]);
	});
});
