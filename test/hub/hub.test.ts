import { describe, expect, it } from "vitest";
import { HOUR_MS, MINUTE_MS } from "../../src/core/types";
import { DECK_SIZE } from "../../src/worker/hub/hub";
import { onboarded } from "./harness";

function deckPlaylist(h: Awaited<ReturnType<typeof onboarded>>, stationId: number) {
	const row = h.sql.first<{ playlist_id: string }>(
		`SELECT playlist_id FROM stations WHERE id = ?`,
		stationId,
	)!;
	return h.fake.playlists.get(row.playlist_id)!;
}

function memoryPlays(h: Awaited<ReturnType<typeof onboarded>>): number {
	return h.sql.first<{ n: number }>(`SELECT COALESCE(SUM(plays), 0) AS n FROM memory`)!.n;
}

describe("onboarding", () => {
	it("imports the playlists and writes one private deck playlist per station", async () => {
		const h = await onboarded({ tracks: 600, playlists: [400, 200] });
		const st = await h.hub.state();
		expect(st.onboarded).toBe(true);
		expect(st.stations.map((s) => s.name)).toEqual(["Alles", "Playlist 1", "Playlist 2"]);
		for (const s of st.stations) {
			expect(s.ready).toBe(true);
			const pl = h.fake.playlists.get(s.playlistId!)!;
			expect(pl.public).toBe(false);
			expect(pl.name).toBe(`True Shuffle · ${s.name}`);
			expect(new Set(pl.items).size).toBe(pl.items.length);
		}
		expect(deckPlaylist(h, st.stations[1]!.id).items.length).toBe(Math.min(DECK_SIZE, 400));
		expect(st.jobs).toEqual([]);
	});

	it("imports a big library across several invocations within the request budget", async () => {
		const h = await onboarded({ tracks: 3000, playlists: [3000] });
		const st = await h.hub.state();
		const station = st.stations.find((s) => s.kind === "playlist")!;
		expect(station.poolSize).toBe(3000);
		expect(station.ready).toBe(true);
	});
});

describe("listening", () => {
	it("starts the station on the listener's device with shuffle and repeat off", async () => {
		const h = await onboarded();
		h.fake.user().player.shuffle = true;
		h.fake.user().player.repeat = "context";
		const res = await h.hub.play(h.stationIds[0]!);
		expect(res).toEqual({ ok: true, deviceName: "iPhone" });
		const p = h.fake.user().player;
		expect(p.contextUri).toBe(`spotify:playlist:${deckPlaylist(h, h.stationIds[0]!).id}`);
		expect(p.shuffle).toBe(false);
		expect(p.repeat).toBe("off");
		expect(p.isPlaying).toBe(true);
	});

	it("remembers everything heard and never rewrites the deck while it plays", async () => {
		const h = await onboarded();
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		const before = deckPlaylist(h, sid).items.slice();
		await h.listen(2 * HOUR_MS);
		// ~ 2 h of ~3.5 min songs.
		expect(memoryPlays(h)).toBeGreaterThanOrEqual(30);
		expect(deckPlaylist(h, sid).items).toEqual(before);
		const st = await h.hub.state();
		expect(st.stations.find((s) => s.id === sid)!.playing).toBe(true);
	});

	it("writes a fresh deck without any heard song once the listener stopped", async () => {
		const h = await onboarded();
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		await h.listen(HOUR_MS);
		h.fake.pause();
		await h.listen(40 * MINUTE_MS);
		const heard = new Set(
			h.sql.all<{ track_id: string }>(`SELECT track_id FROM plays`).map((r) => r.track_id),
		);
		expect(heard.size).toBeGreaterThan(10);
		const deck = deckPlaylist(h, sid).items;
		for (const id of deck) expect(heard.has(id)).toBe(false);
		// Pressing play in Spotify directly now starts with a song never heard today.
		expect(heard.has(deck[0]!)).toBe(false);
	});

	it("starting again never replays the same queue", async () => {
		const h = await onboarded();
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		await h.listen(30 * MINUTE_MS);
		const first = deckPlaylist(h, sid).items.slice(0, 50);
		h.fake.pause();
		await h.listen(15 * MINUTE_MS);
		await h.hub.play(sid);
		const second = deckPlaylist(h, sid).items.slice(0, 50);
		const overlap = first.filter((id, i) => second[i] === id).length;
		expect(overlap).toBeLessThan(3);
	});

	it("books early skips (< 30 s) and keeps skipped songs out of the next deck", async () => {
		const h = await onboarded();
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		await h.listen(4 * MINUTE_MS);
		const skipped: string[] = [];
		for (let i = 0; i < 3; i++) {
			h.fake.skip(); // leave the current song (heard long enough to count)
			await h.listen(5_000);
			skipped.push(h.fake.current()!);
			h.fake.skip(); // ...and skip this one after only 5 s
			await h.listen(3 * MINUTE_MS + 30_000); // let the next song play and the sync look
		}
		h.fake.pause();
		await h.listen(40 * MINUTE_MS);
		const rows = h.sql.all<{ id: string; early_skips: number }>(
			`SELECT id, early_skips FROM memory WHERE early_skips > 0`,
		);
		const booked = new Set(rows.map((r) => r.id));
		for (const id of skipped) expect(booked.has(id)).toBe(true);
		const deck = deckPlaylist(h, sid).items;
		for (const id of skipped) expect(deck.includes(id)).toBe(false);
	});

	it("counts music heard outside True Shuffle and leaves the deck alone meanwhile", async () => {
		const h = await onboarded();
		const sid = h.stationIds[0]!;
		const deckBefore = deckPlaylist(h, sid).items.slice();
		// The listener plays an album that contains songs of the station.
		const album = [...h.fake.playlists.values()].find((p) => p.name === "Playlist 1")!;
		const outside = h.fake.addPlaylist("mika", "Album", album.items.slice(500, 520));
		h.fake.startContext("mika", `spotify:playlist:${outside.id}`, 0, "mika-phone", false);
		await h.listen(HOUR_MS);
		const heard = h.sql.all<{ track_id: string; station_id: number | null }>(
			`SELECT track_id, station_id FROM plays`,
		);
		expect(heard.length).toBeGreaterThan(10);
		expect(heard.every((p) => p.station_id === null)).toBe(true);
		// Heard elsewhere ⇒ not fresh any more for the station.
		await h.hub.play(sid);
		const deck = deckPlaylist(h, sid).items;
		for (const p of heard) expect(deck.includes(p.track_id)).toBe(false);
		expect(deck).not.toEqual(deckBefore);
	});

	it("survives a restart of the hub in the middle of listening", async () => {
		const h = await onboarded();
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		await h.listen(30 * MINUTE_MS);
		const mid = memoryPlays(h);
		h.restart();
		await h.listen(30 * MINUTE_MS);
		expect(memoryPlays(h)).toBeGreaterThan(mid + 5);
		const dupes = h.sql.first<{ n: number }>(
			`SELECT COUNT(*) AS n FROM (SELECT track_id FROM plays GROUP BY track_id HAVING COUNT(*) > 1)`,
		)!.n;
		expect(dupes).toBe(0);
	});

	it("switches Spotify's own shuffle off when it is on inside our deck", async () => {
		const h = await onboarded();
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		h.fake.user().player.shuffle = true;
		await h.listen(5 * MINUTE_MS);
		expect(h.fake.user().player.shuffle).toBe(false);
	});

	it("appends songs when a deck is about to run out while playing", async () => {
		const h = await onboarded({ tracks: 600, durationMs: 40_000 });
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		// 300 songs x 40 s = 200 min; listen long enough to approach the end.
		await h.listen(195 * MINUTE_MS);
		expect(deckPlaylist(h, sid).items.length).toBeGreaterThan(DECK_SIZE);
		expect(h.fake.user().player.contextUri).toContain(deckPlaylist(h, sid).id);
	});
});

describe("rounds", () => {
	it("plays every song of a small station once before the next round, then starts over", async () => {
		const h = await onboarded({ tracks: 40, durationMs: 60_000 });
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		await h.listen(50 * MINUTE_MS); // 40 songs x 1 min, plus time for the sync to read them
		const heard = h.sql.all<{ track_id: string }>(
			`SELECT track_id FROM plays WHERE station_id = ?`,
			sid,
		);
		expect(new Set(heard.map((r) => r.track_id)).size).toBe(heard.length);
		expect(heard.length).toBeGreaterThanOrEqual(38);
		const st = (await h.hub.state()).stations.find((s) => s.id === sid)!;
		expect(st.roundNo).toBe(2);
	});
});

describe("guest mode", () => {
	it("ignores everything played while it is on", async () => {
		const h = await onboarded();
		const sid = h.stationIds[0]!;
		h.hub.setGuest(true, 1);
		await h.hub.play(sid);
		await h.listen(30 * MINUTE_MS);
		expect(memoryPlays(h)).toBe(0);
		const ignored = h.sql.first<{ n: number }>(
			`SELECT COUNT(*) AS n FROM plays WHERE ignored = 1`,
		)!.n;
		expect(ignored).toBeGreaterThan(3);
		// Switches itself off after the hour.
		await h.listen(40 * MINUTE_MS);
		expect((await h.hub.state()).guest.active).toBe(false);
		await h.listen(20 * MINUTE_MS);
		expect(memoryPlays(h)).toBeGreaterThan(0);
	});
});

describe("errors", () => {
	it("tells a free account that starting needs Premium", async () => {
		const h = await onboarded({ premium: false });
		const res = await h.hub.play(h.stationIds[0]!);
		expect(res.ok).toBe(false);
		expect(res.error!.code).toBe("premium");
	});

	it("asks to open Spotify when there is no device", async () => {
		const h = await onboarded();
		h.fake.user().devices = [];
		const res = await h.hub.play(h.stationIds[0]!);
		expect(res.error!.code).toBe("no_device");
	});

	it("backs off for an hour when the Spotify quota is exhausted", async () => {
		const h = await onboarded();
		h.fake.failNext = {
			status: 429,
			count: 1,
			body: { error: { status: 429, message: "quota", reason: "QUOTA_EXCEEDED" } },
		};
		await h.listen(25 * MINUTE_MS);
		const st = await h.hub.state();
		expect(st.warnings.some((w) => w.code === "quota")).toBe(true);
		const calls = h.fake.calls.length;
		// The quota was hit within the first minutes: silence for the hour.
		await h.listen(30 * MINUTE_MS);
		expect(h.fake.calls.length).toBe(calls);
		// ...and then True Shuffle carries on by itself.
		await h.listen(HOUR_MS);
		expect(h.fake.calls.length).toBeGreaterThan(calls);
		expect((await h.hub.state()).warnings.some((w) => w.code === "quota")).toBe(false);
	});

	it("recreates the deck playlist if the listener deleted it in Spotify", async () => {
		const h = await onboarded();
		const sid = h.stationIds[0]!;
		const old = deckPlaylist(h, sid).id;
		h.fake.playlists.delete(old);
		const res = await h.hub.play(sid);
		expect(res.ok).toBe(true);
		expect(deckPlaylist(h, sid).id).not.toBe(old);
	});

	it("refreshes the access token when it expires", async () => {
		const h = await onboarded();
		await h.listen(3 * HOUR_MS);
		const res = await h.hub.play(h.stationIds[0]!);
		expect(res.ok).toBe(true);
	});

	it("marks the account when Spotify revoked the grant", async () => {
		const h = await onboarded();
		h.fake.refreshTokens.clear();
		await h.listen(2 * HOUR_MS);
		const st = await h.hub.state();
		expect(st.warnings.some((w) => w.code === "auth")).toBe(true);
	});
});

describe("listener input", () => {
	it("thumb down skips the current song and bans it everywhere", async () => {
		const h = await onboarded();
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		await h.listen(MINUTE_MS);
		const cur = h.fake.current()!;
		await h.hub.thumb(cur, -1);
		expect(h.fake.current()).not.toBe(cur);
		h.fake.pause();
		await h.listen(40 * MINUTE_MS);
		for (const id of [h.stationIds[0]!, h.allId])
			expect(deckPlaylist(h, id).items.includes(cur)).toBe(false);
	});

	it("imports streaming history and prefers songs not heard for a long time", async () => {
		const h = await onboarded({ tracks: 400 });
		const sid = h.stationIds[0]!;
		const ids = deckPlaylist(h, sid).items;
		// Pretend the first 350 songs of the playlist were heard last week.
		const all = [...h.fake.playlists.values()].find((p) => p.name === "Playlist 1")!.items;
		const lastWeek = h.clock.t - 7 * 24 * HOUR_MS;
		const rows = all
			.slice(0, 350)
			.map((id) => [id, 3, 0, lastWeek] as [string, number, number, number]);
		h.hub.importHistory(rows, 0, 1);
		await h.hub.play(sid);
		const deck = deckPlaylist(h, sid).items;
		const unheard = new Set(all.slice(350));
		// The 50 songs never heard come first.
		expect(deck.slice(0, 50).filter((id) => unheard.has(id)).length).toBe(50);
		expect(ids.length).toBeGreaterThan(0);
	});
});
