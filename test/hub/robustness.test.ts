/**
 * Real-life situations that must not corrupt the memory or stop a station.
 * Several of these were found by the independent red-team review (RT-n).
 */

import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "../../src/core/types";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;
type Policy = "later_less" | "ban" | "consume";

function stationDeck(h: H, sid: number) {
	const row = h.sql.first<{ deck: string; playlist_id: string }>(
		`SELECT deck, playlist_id FROM stations WHERE id = ?`,
		sid,
	)!;
	return {
		deck: JSON.parse(row.deck) as { version: number; lastIndex: number | null },
		pl: h.fake.playlists.get(row.playlist_id)!,
	};
}

function falseSkips(h: H): number {
	return h.sql.first<{ n: number }>(`SELECT COUNT(*) AS n FROM memory WHERE early_skips > 0`)!.n;
}

describe("car stop: the deck is rewritten while the player is paused in it (RT-1)", () => {
	async function carStop(policy: Policy) {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		if (policy !== "later_less") await h.hub.updateStation(sid, { rules: { skipPolicy: policy } });
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(20 * MINUTE_MS);
		const before = stationDeck(h, sid).deck;
		const position = before.lastIndex!;
		h.fake.pause();
		await h.listen(15 * MINUTE_MS);
		const { deck: after, pl } = stationDeck(h, sid);
		expect(after.version).toBeGreaterThan(before.version);
		// Spotify resumes: the loaded song ends, then it continues with the new
		// playlist contents after the old position (skipping the song at it).
		const p = h.fake.user().player;
		p.currentFromQueue = h.fake.current()!;
		p.order = pl.items.slice();
		p.index = position;
		const neverPlayed = pl.items[position]!;
		p.isPlaying = true;
		await h.listen(45 * MINUTE_MS);
		return { h, sid, neverPlayed };
	}

	for (const policy of ["later_less", "ban", "consume"] as const) {
		it(`books nothing for a song that never played (${policy})`, async () => {
			const { h, sid, neverPlayed } = await carStop(policy);
			const mem = h.sql.first<{ early_skips: number }>(
				`SELECT early_skips FROM memory WHERE id = ?`,
				neverPlayed,
			);
			expect(mem?.early_skips ?? 0).toBe(0);
			expect(
				h.sql.first(`SELECT 1 FROM bans WHERE station_id = ? AND track_id = ?`, sid, neverPlayed),
			).toBeNull();
		});
	}

	for (const size of [650, 700, 750]) {
		it(`never books a skip when nobody skipped, whatever order Spotify resumes in (${size} songs)`, async () => {
			const h = await onboarded({ tracks: size });
			const sid = h.stationIds[0]!;
			expect((await h.hub.play(sid)).ok).toBe(true);
			await h.listen(25 * MINUTE_MS);
			h.fake.pause();
			await h.listen(15 * MINUTE_MS);
			// The fake keeps the order it loaded before the rewrite.
			h.fake.user().player.isPlaying = true;
			await h.listen(90 * MINUTE_MS);
			h.fake.pause();
			await h.listen(40 * MINUTE_MS);
			expect(falseSkips(h)).toBe(0);
		});
	}

	it("still books a real early skip after a car stop", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(20 * MINUTE_MS);
		h.fake.pause();
		await h.listen(15 * MINUTE_MS);
		h.fake.user().player.isPlaying = true;
		await h.listen(4 * MINUTE_MS);
		// Wait for a song to begin, then the listener (watching the app, which
		// looks every few seconds) skips it after 10 s.
		const running = h.fake.current();
		while (h.fake.current() === running) await h.listen(5_000);
		await h.hub.state({ live: true });
		const skipped = h.fake.current()!;
		await h.listen(5_000);
		h.fake.skip();
		h.clock.t += 16_000;
		await h.hub.state({ live: true });
		await h.listen(40 * MINUTE_MS);
		const mem = h.sql.first<{ early_skips: number }>(
			`SELECT early_skips FROM memory WHERE id = ?`,
			skipped,
		);
		expect(mem?.early_skips).toBe(1);
	});
});

describe("a source playlist deleted in Spotify (RT-3)", () => {
	it("plays on without it, says so, and does not keep polling", async () => {
		const h = await onboarded({ tracks: 600, playlists: [300, 300] });
		const s2 = h.stationIds[1]!;
		const p2 = [...h.fake.playlists.values()].find((p) => p.name === "Playlist 2")!;
		p2.followedBy.delete("mika");
		await h.listen(26 * 60 * MINUTE_MS);
		const before = h.fake.calls.filter((c) => c === "GET /v1/me/player").length;
		await h.listen(60 * MINUTE_MS);
		const idleCalls = h.fake.calls.filter((c) => c === "GET /v1/me/player").length - before;
		expect(idleCalls).toBeLessThan(10);

		const st = await h.hub.state();
		expect(
			st.warnings.some((w) => w.code === "source_gone" && w.message.includes("Playlist 2")),
		).toBe(true);
		expect(h.hub.listPlaylists().some((p) => p.name === "Playlist 2")).toBe(false);

		// "Alles" plays, without the deleted playlist's songs.
		expect((await h.hub.play(h.allId)).ok).toBe(true);
		const allDeck = stationDeck(h, h.allId).pl.items;
		const gone = new Set(p2.items);
		const pool1 = new Set(
			[...h.fake.playlists.values()].find((p) => p.name === "Playlist 1")!.items,
		);
		const liked = new Set(h.fake.user().liked);
		const onlyInGone = allDeck.filter((id) => gone.has(id) && !pool1.has(id) && !liked.has(id));
		expect(onlyInGone).toEqual([]);

		// The station made only of it says what happened instead of "still importing".
		h.fake.pause();
		await h.listen(20 * MINUTE_MS);
		const r = await h.hub.play(s2);
		expect(r.ok).toBe(false);
		expect(r.error?.message).toMatch(/gibt es in deinem Spotify nicht mehr/);
	});

	it("takes the playlist back when the listener follows it again", async () => {
		const h = await onboarded({ tracks: 600, playlists: [300, 300] });
		const p2 = [...h.fake.playlists.values()].find((p) => p.name === "Playlist 2")!;
		p2.followedBy.delete("mika");
		await h.listen(13 * 60 * MINUTE_MS);
		expect((await h.hub.state()).warnings.some((w) => w.code === "source_gone")).toBe(true);
		p2.followedBy.add("mika");
		await h.listen(13 * 60 * MINUTE_MS);
		expect((await h.hub.state()).warnings.some((w) => w.code === "source_gone")).toBe(false);
	});
});

describe("a big playlist collection read over several invocations (RT-5)", () => {
	it("keeps every playlist read in an earlier invocation", async () => {
		const h = await onboarded({ tracks: 600, playlists: [300, 300] });
		for (let i = 0; i < 2000; i++) h.fake.addPlaylist("mika", `Extra ${i}`, []);
		await h.listen(13 * 60 * MINUTE_MS);
		await h.settle();
		const names = new Set(h.hub.listPlaylists().map((p) => p.name));
		expect(names.has("Playlist 1")).toBe(true);
		expect(names.size).toBe(2002);
		expect((await h.hub.play(h.allId)).ok).toBe(true);
	});
});

describe("plays that reach recently-played late (RT-2)", () => {
	it("counts offline listening that shows up after newer plays, exactly once", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		const offlineStart = h.clock.t;
		const pl = [...h.fake.playlists.values()].find((p) => p.name === "Playlist 1")!;
		const offline = pl.items.slice(200, 208);
		h.clock.t += 45 * MINUTE_MS;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(20 * MINUTE_MS);
		const u = h.fake.user();
		offline.forEach((id, i) => {
			u.recent.push({
				trackId: id,
				playedAt: offlineStart + (i + 1) * 5 * MINUTE_MS,
				contextUri: null,
			});
		});
		u.recent.sort((a, b) => b.playedAt - a.playedAt);
		await h.listen(40 * MINUTE_MS);
		const got = h.sql.all<{ id: string; plays: number }>(
			`SELECT id, plays FROM memory WHERE id IN (${offline.map(() => "?").join(",")})`,
			...offline,
		);
		expect(got.length).toBe(offline.length);
		for (const g of got) expect(g.plays).toBe(1);
	});
});
