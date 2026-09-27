/**
 * New music: found by the hub, verified on Spotify, mixed into the station,
 * kept when the listener likes it, dropped when not. Plus the housekeeping
 * around stations and imports.
 */

import { describe, expect, it } from "vitest";
import { HOUR_MS, MINUTE_MS } from "../../src/core/types";
import { parseSuggestions } from "../../src/worker/hub/discovery";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

function deckPlaylist(h: H, stationId: number) {
	const row = h.sql.first<{ playlist_id: string }>(
		`SELECT playlist_id FROM stations WHERE id = ?`,
		stationId,
	)!;
	return h.fake.playlists.get(row.playlist_id)!;
}

function discoveries(h: H, stationId: number) {
	return h.sql.all<{ id: string; source: string; status: string }>(
		`SELECT id, source, status FROM discoveries WHERE station_id = ?`,
		stationId,
	);
}

/** 600 songs by 120 artists; the station holds the first 300 of them. */
async function halfLibrary(opts: Parameters<typeof onboarded>[0] = {}) {
	const h = await onboarded({ tracks: 600, playlists: [300], ...opts });
	const pool = new Set([...h.fake.playlists.values()].find((p) => p.name === "Playlist 1")!.items);
	return Object.assign(h, { pool, sid: h.stationIds[0]! });
}

describe("discovery", () => {
	it("finds unknown songs by the station's artists and mixes them into the deck", async () => {
		const h = await halfLibrary({ env: { lastfmKey: "k" } });
		await h.listen(3 * HOUR_MS);
		const found = discoveries(h, h.sid);
		expect(found.length).toBeGreaterThan(0);
		// Only songs the listener does not have: none from the station's playlist.
		for (const d of found) expect(h.pool.has(d.id)).toBe(false);
		expect(new Set(found.map((d) => d.source)).size).toBeGreaterThan(1);

		// The finds reach the station without waiting for tomorrow's refresh.
		const deck = deckPlaylist(h, h.sid).items;
		const ids = new Set(found.map((d) => d.id));
		const mixedIn = deck.filter((id) => ids.has(id));
		expect(mixedIn.length).toBeGreaterThan(0);
		// Entdecker: roughly three in ten slots are new music, never all of them.
		expect(mixedIn.length).toBeLessThan(deck.length * 0.5);
	});

	it("uses AI suggestions only after verifying them on Spotify", async () => {
		const prompts: string[] = [];
		const h = await halfLibrary({
			ai: {
				async run(_model, input) {
					prompts.push(input.messages.map((m) => m.content).join("\n"));
					return {
						response: JSON.stringify({
							songs: [
								{ artist: "Artist 7", title: "Song 487" },
								{ artist: "Nobody Real", title: "Invented Song" },
							],
						}),
					};
				},
			},
		});
		await h.listen(3 * HOUR_MS);
		expect(prompts.length).toBeGreaterThan(0);
		const ai = discoveries(h, h.sid).filter((d) => d.source === "ai");
		// The invented song is not on Spotify and never enters the station.
		for (const d of ai) expect(h.fake.tracks.get(d.id)?.artistName).toBe("Artist 7");
	});

	it("keeps a discovery the listener likes in its own playlist", async () => {
		const h = await halfLibrary();
		await h.listen(3 * HOUR_MS);
		const d = discoveries(h, h.sid)[0]!;
		await h.hub.thumb(d.id, 1);
		await h.settle();
		await h.listen(10 * MINUTE_MS);
		const kept = [...h.fake.playlists.values()].find(
			(p) => p.name === "true-shuffle · Entdeckungen",
		);
		expect(kept?.items).toContain(d.id);
		expect(discoveries(h, h.sid).find((x) => x.id === d.id)?.status).toBe("kept");
	});

	it("drops a discovery the listener turns down", async () => {
		const h = await halfLibrary();
		await h.listen(3 * HOUR_MS);
		const d = discoveries(h, h.sid)[0]!;
		await h.hub.thumb(d.id, -1);
		expect(discoveries(h, h.sid).find((x) => x.id === d.id)?.status).toBe("rejected");
		await h.listen(HOUR_MS);
		expect(deckPlaylist(h, h.sid).items).not.toContain(d.id);
	});

	it("stays out of a station that has discovery switched off", async () => {
		const h = await halfLibrary();
		await h.hub.updateStation(h.sid, { rules: { discoveryEnabled: false } });
		await h.listen(3 * HOUR_MS);
		const ids = new Set(discoveries(h, h.sid).map((d) => d.id));
		expect(deckPlaylist(h, h.sid).items.filter((id) => ids.has(id))).toEqual([]);
	});
});

describe("suggestion parsing", () => {
	it("reads the JSON object out of a chatty answer", () => {
		const text =
			'Sure! ```json\n{"songs":[{"artist":"A","title":"B"},{"artist":1,"title":"x"}]}\n``` Enjoy.';
		expect(parseSuggestions(text)).toEqual([{ artist: "A", title: "B" }]);
	});

	it("returns nothing for broken or empty answers", () => {
		expect(parseSuggestions("")).toEqual([]);
		expect(parseSuggestions("no json here")).toEqual([]);
		expect(parseSuggestions('{"songs": "nope"}')).toEqual([]);
		expect(parseSuggestions('{"songs": [')).toEqual([]);
	});

	it("caps the list and the lengths", () => {
		const songs = Array.from({ length: 40 }, (_, i) => ({
			artist: "x".repeat(500),
			title: `t${i}`,
		}));
		const out = parseSuggestions(JSON.stringify({ songs }));
		expect(out).toHaveLength(25);
		expect(out[0]!.artist.length).toBeLessThanOrEqual(120);
	});
});

describe("stations and imports", () => {
	it("deleting a station removes its playlist from the listener's library", async () => {
		const h = await halfLibrary();
		const pl = deckPlaylist(h, h.sid);
		await h.hub.deleteStation(h.sid);
		await h.settle();
		await h.listen(5 * MINUTE_MS);
		expect(pl.followedBy.has("mika")).toBe(false);
		const st = await h.hub.state();
		expect(st.stations.some((s) => s.id === h.sid)).toBe(false);
	});

	it("rejects malformed history rows from the browser", async () => {
		const h = await halfLibrary();
		const id = [...h.pool][0]!;
		const bad: unknown[][] = [
			[["short", 1, 0, 0]],
			[[id, -1, 0, 0]],
			[[id, 1.5, 0, 0]],
			[[id, "3", 0, 0]],
			[[id, 1, 0, h.clock.t + 7 * 24 * HOUR_MS]],
			[[id, 1, 0]],
		];
		for (const rows of bad) {
			expect(() => h.hub.importHistory(rows as never, 0, 1)).toThrow(/Ungültige Zeile/);
		}
		expect(() => h.hub.importHistory([[id, 1, 0, 0]], 2, 2)).toThrow(/Import-Block/);
		expect(h.hub.importHistory([[id, 4, 1, h.clock.t - HOUR_MS]], 0, 1)).toEqual({ stored: 1 });
	});
});
