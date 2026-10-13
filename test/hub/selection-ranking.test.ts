/**
 * The whole way from a selection to the planner: the hub's own call of
 * planQueue (when it writes a new queue) is watched, and the memory it hands
 * in — the ranking input, taste weight and staleness — is checked for a song
 * whose imported plays were left out and one whose were not.
 */

import { describe, expect, it, vi } from "vitest";
import { aggregateHistory, emptyAggregate, toRows } from "../../src/core/history";
import { addListens, finishListens, LISTEN_PAGE, newListens } from "../../src/core/listens";
import { stalenessBoost, tasteWeight } from "../../src/core/memory";
import type { PlanInput } from "../../src/core/planner";
import { DAY_MS } from "../../src/core/types";
import { onboarded } from "./harness";

const seen: PlanInput[] = [];
vi.mock("../../src/core/planner", async (original) => {
	const real = await original<typeof import("../../src/core/planner")>();
	return {
		...real,
		planQueue: (input: PlanInput) => {
			seen.push(input);
			return real.planQueue(input);
		},
	};
});

describe("the planner's ranking input follows the selection", () => {
	it("a left-out song reaches planQueue as never heard; an untouched one keeps its import", async () => {
		const h = await onboarded({ tracks: 120 });
		const tracks = [...h.fake.tracks.values()];
		const [gone, kept] = [tracks[3]!, tracks[4]!];
		const entries = [gone, kept].flatMap((t) =>
			Array.from({ length: 6 }, (_, i) => ({
				ts: new Date(Date.parse("2026-08-01T12:00:00Z") + i * DAY_MS).toISOString(),
				ms_played: 200_000,
				spotify_track_uri: `spotify:track:${t.id}`,
				master_metadata_track_name: t.name,
				master_metadata_album_artist_name: t.artistName,
				master_metadata_album_album_name: t.albumName,
				reason_start: "trackdone",
				reason_end: "trackdone",
			})),
		);
		entries.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
		const before = Number(h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'live_since'`)!.v);
		const { upload } = h.hub.importHistory(
			toRows(aggregateHistory(entries, emptyAggregate(), { before })),
			0,
			1,
		);
		const done = finishListens(addListens(entries, newListens()), before);
		expect(done.tracks.length).toBeLessThanOrEqual(LISTEN_PAGE);
		const first = h.hub.importListens({
			importId: upload,
			part: 0,
			parts: 2,
			tracks: done.tracks.length,
			kind: "tracks",
			data: done.tracks,
		});
		h.hub.importListens({
			upload: first.upload,
			part: 1,
			parts: 2,
			tracks: done.tracks.length,
			kind: "rows",
			data: done.rows,
		});
		h.hub.applySelection({
			baseRevision: 0,
			enabled: true,
			rules: [{ type: "track", kind: "exclude", id: gone.id }],
		});
		seen.length = 0;
		const sid = h.stationIds[0]!;
		expect(await h.hub.play(sid, undefined, { newQueue: true })).toMatchObject({ ok: true });
		expect(seen.length).toBeGreaterThan(0);
		const input = seen.at(-1)!;
		expect(input.pool.some((p) => p.id === gone.id)).toBe(true);
		const g = input.memory(gone.id);
		const k = input.memory(kept.id);
		expect(g).toMatchObject({ plays: 0, lastPlayedAt: null });
		expect(k).toMatchObject({ plays: 6 });
		// What the ranking weighs: the left-out song is new again, the other a known favourite.
		expect(tasteWeight(g, input.rules.skipPolicy, input.now)).toBe(1);
		expect(stalenessBoost(g, input.now)).toBe(1.6);
		expect(tasteWeight(k, input.rules.skipPolicy, input.now)).toBeCloseTo(1.3);
		expect(stalenessBoost(k, input.now)).toBeLessThan(1.6);
	});
});
