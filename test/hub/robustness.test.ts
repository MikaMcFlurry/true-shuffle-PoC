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
		// Gone only after two complete walks of the list (every 12 h) without it.
		await h.listen(13 * 60 * MINUTE_MS);
		expect((await h.hub.state()).warnings.some((w) => w.code === "source_gone")).toBe(false);
		await h.listen(12 * 60 * MINUTE_MS);
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

describe("a rewrite continues what a player may still have loaded", () => {
	it("keeps the songs after the paused one at their places, with no heard song anywhere", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(30 * MINUTE_MS);
		h.fake.pause();
		await h.hub.state({ live: true });
		const before = stationDeck(h, sid);
		const beforeItems = before.pl.items.slice();
		const held = before.deck.lastIndex!;
		const pausedSong = beforeItems[held]!;
		h.clock.t += 15 * MINUTE_MS;
		await h.listen(1_000);
		const after = stationDeck(h, sid);
		expect(after.deck.version).toBeGreaterThan(before.deck.version);
		// Resuming by position or by the loaded order plays the same songs.
		expect(after.pl.items.slice(held + 1, held + 40)).toEqual(
			beforeItems.slice(held + 1, held + 40),
		);
		// A restart from the top plays nothing heard today, not even the paused song.
		const heard = new Set(
			h.sql.all<{ track_id: string }>(`SELECT track_id FROM plays`).map((r) => r.track_id),
		);
		for (const id of after.pl.items) expect(heard.has(id)).toBe(false);
		expect(after.pl.items.includes(pausedSong)).toBe(false);
	});

	it("a mix changed in the app applies at the next start from the app", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(30 * MINUTE_MS);
		h.fake.pause();
		await h.listen(15 * MINUTE_MS); // continuation written while paused
		await h.hub.updateStation(sid, { rules: { mix: 100 } });
		expect((await h.hub.play(sid)).ok).toBe(true);
		const row = h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!;
		const deck = JSON.parse(row.deck) as { continued: boolean; ours: boolean };
		expect(deck.continued).toBe(false);
		expect(deck.ours).toBe(true);
	});
});

describe("a skip booked before its play showed up", () => {
	it("is taken back exactly once when the play arrives late", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		const running = h.fake.current();
		while (h.fake.current() === running) await h.listen(5_000);
		await h.hub.state({ live: true });
		const song = h.fake.current()!;
		await h.listen(5_000);
		h.fake.skip(); // left after 5 s: Spotify records nothing
		const leftAt = h.clock.t;
		h.clock.t += 16_000;
		await h.hub.state({ live: true });
		await h.listen(30 * MINUTE_MS);
		const early = () =>
			h.sql.first<{ early_skips: number }>(`SELECT early_skips FROM memory WHERE id = ?`, song)
				?.early_skips;
		expect(early()).toBe(1);
		// Spotify's list catches up: it had been a play after all.
		const u = h.fake.user();
		const uri = `spotify:playlist:${stationDeck(h, sid).pl.id}`;
		u.recent.push({ trackId: song, playedAt: leftAt, contextUri: uri });
		u.recent.sort((a, b) => b.playedAt - a.playedAt);
		await h.listen(10 * MINUTE_MS);
		expect(early()).toBe(0);
	});
});

describe("the station limit", () => {
	it("refuses more stations than the free plan's budget allows, before creating any", async () => {
		const h = await onboarded({ tracks: 600 });
		const lists = Array.from({ length: 40 }, (_, i) =>
			h.fake.addPlaylist("mika", `Extra ${i}`, [...h.fake.tracks.keys()].slice(i, i + 5)),
		);
		await h.listen(13 * 60 * MINUTE_MS); // the list is read again
		const before = (await h.hub.state()).stations.length;
		await expect(h.hub.onboard(lists.map((p) => p.id))).rejects.toThrow(/Höchstens/);
		expect((await h.hub.state()).stations.length).toBe(before);
	});
});

describe("the consume rule with Spotify's list lagging behind (NF-6)", () => {
	it("ends a round only when every song was heard or used up once", async () => {
		const h = await onboarded({ tracks: 120, seed: 1 });
		const sid = h.stationIds[0]!;
		await h.hub.updateStation(sid, { rules: { skipPolicy: "consume" } });
		// recently-played shows every play 30 min late (longer than the skip grace).
		const u = h.fake.user();
		const held: { e: (typeof u.recent)[number]; due: number }[] = [];
		const known = new Set(u.recent.map((r) => `${r.playedAt}|${r.trackId}`));
		const lag = () => {
			for (const r of u.recent) {
				const k = `${r.playedAt}|${r.trackId}`;
				if (!known.has(k)) {
					known.add(k);
					held.push({ e: r, due: h.clock.t + 30 * MINUTE_MS });
				}
			}
			u.recent = u.recent.filter((r) => !held.some((x) => x.e === r));
			for (let i = held.length - 1; i >= 0; i--)
				if (held[i]!.due <= h.clock.t) {
					u.recent.push(held[i]!.e);
					held.splice(i, 1);
				}
			u.recent.sort((a, b) => b.playedAt - a.playedAt);
		};
		const ended = new Set<string>();
		const f = h.fake as unknown as { moveNext: (u: unknown, at: number) => void };
		const orig = f.moveNext.bind(h.fake);
		f.moveNext = (user: unknown, at: number) => {
			const cur = h.fake.current();
			if (cur) ended.add(cur);
			orig(user, at);
		};
		await h.hub.play(sid);
		for (let m = 0; m < 9 * 60; m++) {
			await h.listen(MINUTE_MS);
			lag();
			const st = h.sql.first<{ round_no: number }>(
				`SELECT round_no FROM stations WHERE id = ?`,
				sid,
			)!;
			if (st.round_no > 1) break;
		}
		const round = h.sql.first<{ round_no: number }>(
			`SELECT round_no FROM stations WHERE id = ?`,
			sid,
		)!;
		expect(round.round_no).toBeGreaterThan(1);
		// The round ended only once every one of the 120 songs had actually come.
		expect(ended.size).toBeGreaterThanOrEqual(118);
	}, 120_000);
});

describe("Spotify showing no player for a moment (NF-9)", () => {
	it("does not rewrite the deck under someone listening", async () => {
		for (const blip of [1, 2, 3]) {
			const h = await onboarded({ tracks: 300, seed: blip });
			const sid = h.stationIds[0]!;
			await h.hub.play(sid);
			await h.listen(22 * MINUTE_MS);
			const before = stationDeck(h, sid).deck.version;
			const p = h.fake.user().player;
			const device = p.deviceId;
			p.deviceId = null; // the Web API answers 204; the phone plays on
			await h.listen(blip * MINUTE_MS);
			p.deviceId = device;
			await h.listen(8 * MINUTE_MS);
			expect(stationDeck(h, sid).deck.version, `${blip} min`).toBe(before);
		}
	});
});

describe("a song turned down that a player still has queued", () => {
	it("is moved past as soon as it comes up in a station", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		await h.listen(5 * MINUTE_MS);
		const upcoming = stationDeck(h, sid).pl.items;
		const idx = upcoming.indexOf(h.fake.current()!);
		const later = upcoming[idx + 3]!;
		// Turned down from somewhere else (e.g. while another song played).
		await h.hub.thumb(later, -1);
		const f = h.fake as unknown as { moveNext: (u: unknown, at: number) => void };
		let heardFor = 0;
		const orig = f.moveNext.bind(h.fake);
		f.moveNext = (user: unknown, at: number) => {
			if (h.fake.current() === later) heardFor = h.fake.user().player.listenedMs;
			orig(user, at);
		};
		// The app is closed: only the hub's own looks at the player.
		await h.listen(15 * MINUTE_MS);
		expect(heardFor).toBeGreaterThan(0);
		expect(heardFor).toBeLessThan(30_000);
	});
});

describe("a small station after a car stop (red-team 4)", () => {
	for (const size of [60, 100, 200, 300]) {
		it(`keeps every song ahead and fills the front without repeats (${size} songs)`, async () => {
			const h = await onboarded({ tracks: size });
			const sid = h.stationIds[0]!;
			expect((await h.hub.play(sid)).ok).toBe(true);
			await h.listen(25 * MINUTE_MS);
			h.fake.pause();
			await h.hub.state({ live: true });
			const before = stationDeck(h, sid);
			const items = before.pl.items.slice();
			const held = before.deck.lastIndex!;
			h.clock.t += 15 * MINUTE_MS;
			await h.listen(1_000);
			const after = stationDeck(h, sid).pl.items.slice();
			// The songs after the paused one: at their places; at most the last
			// half of them moved to the front.
			const ahead = items.length - held - 1;
			const kept = after.slice(held + 1);
			expect(kept).toEqual(items.slice(held + 1, held + 1 + kept.length));
			expect(kept.length).toBeGreaterThanOrEqual(Math.ceil(ahead / 2));
			expect(after.length).toBeGreaterThanOrEqual(held + 1 + kept.length);
			// Nothing heard today anywhere: resuming by position, by song, or from the top.
			const heard = new Set(
				h.sql.all<{ track_id: string }>(`SELECT track_id FROM plays`).map((r) => r.track_id),
			);
			expect(after.filter((id) => heard.has(id))).toEqual([]);
			expect(new Set(after).size).toBe(after.length);
		});
	}
});

describe("a song heard somewhere else while a player holds the station (red-team 4)", () => {
	it("gives up its place in the continued playlist", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(20 * MINUTE_MS);
		h.fake.pause();
		await h.hub.state({ live: true });
		const before = stationDeck(h, sid);
		const items = before.pl.items.slice();
		const held = before.deck.lastIndex!;
		const elsewhere = items[held + 5]!;
		// Heard in full on another device, no context reported.
		h.fake.user().recent.unshift({ trackId: elsewhere, playedAt: h.clock.t, contextUri: null });
		h.clock.t += 15 * MINUTE_MS;
		await h.listen(1_000);
		const after = stationDeck(h, sid).pl.items.slice();
		expect(after).not.toContain(elsewhere);
		expect(after.slice(held + 1, held + 5)).toEqual(items.slice(held + 1, held + 5));
		expect(after.slice(held + 6, held + 30)).toEqual(items.slice(held + 6, held + 30));
	});
});

describe("skip rules the hub sees with the app closed (red-team 4)", () => {
	/** Wait until the next song has been playing for `ms`. */
	async function intoNextSong(h: H, ms: number) {
		const running = h.fake.current();
		while (h.fake.current() === running) await h.listen(1_000);
		await h.listen(ms);
		return h.fake.current()!;
	}

	it("a thumb up lifts a ban the skip rule set", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		await h.hub.updateStation(sid, { rules: { skipPolicy: "ban" } });
		expect((await h.hub.play(sid)).ok).toBe(true);
		const song = await intoNextSong(h, 10_000);
		h.fake.skip();
		await h.listen(30 * MINUTE_MS);
		const bans = () =>
			h.sql.all<{ track_id: string }>(`SELECT track_id FROM bans WHERE station_id = ?`, sid);
		expect(bans().map((b) => b.track_id)).toEqual([song]);
		await h.hub.thumb(song, 1);
		expect(bans()).toEqual([]);
	});

	it("under consume, only a skip seen playing uses the song up", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		await h.hub.updateStation(sid, { rules: { skipPolicy: "consume" } });
		expect((await h.hub.play(sid)).ok).toBe(true);
		const seen = await intoNextSong(h, 8_000);
		h.fake.skip();
		await h.listen(4_000);
		const inferred = h.fake.current()!; // skipped before any look at the player
		h.fake.skip();
		await h.listen(30 * MINUTE_MS);
		const row = (id: string) =>
			h.sql.first<{ early_skips: number; consumed_at: number | null }>(
				`SELECT early_skips, consumed_at FROM memory WHERE id = ?`,
				id,
			)!;
		expect(row(seen).early_skips).toBe(1);
		expect(row(seen).consumed_at).not.toBeNull();
		expect(row(inferred).early_skips).toBe(1);
		expect(row(inferred).consumed_at).toBeNull();
	});
});

describe("the rewrite after a stop (red-team 4)", () => {
	it("comes ten minutes after the last song, even with a rewrite queued while playing", async () => {
		// Whenever the stop falls between two looks of a waiting rewrite.
		for (let extra = 0; extra < 10; extra++) {
			const h = await onboarded({ tracks: 600 });
			const sid = h.stationIds[0]!;
			expect((await h.hub.play(sid)).ok).toBe(true);
			await h.listen(4 * MINUTE_MS);
			h.fake.skip(); // queues a rewrite for when nobody listens
			await h.listen((12 + extra) * MINUTE_MS);
			const version = stationDeck(h, sid).deck.version;
			h.fake.pause();
			const stoppedAt = h.clock.t;
			while (stationDeck(h, sid).deck.version === version && h.clock.t - stoppedAt < 30 * MINUTE_MS)
				await h.listen(15_000);
			expect(h.clock.t - stoppedAt, `stop ${extra} min later`).toBeLessThanOrEqual(11 * MINUTE_MS);
		}
	});
});

describe("songs a player brings back on its own (red-team 5)", () => {
	/** How long each song was heard every time it ended, from the simulator's side. */
	function earsOn(h: H) {
		const heard = new Map<string, number[]>();
		const f = h.fake as unknown as { moveNext: (u: unknown, at: number) => void };
		const orig = f.moveNext.bind(h.fake);
		f.moveNext = (user: unknown, at: number) => {
			const cur = h.fake.current();
			if (cur) heard.set(cur, [...(heard.get(cur) ?? []), h.fake.user().player.listenedMs]);
			orig(user, at);
		};
		return heard;
	}

	it("skips a song heard elsewhere that an old loaded order still has, and books nothing", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(20 * MINUTE_MS);
		h.fake.pause();
		await h.hub.state({ live: true });
		const before = stationDeck(h, sid);
		const items = before.pl.items.slice();
		const held = before.deck.lastIndex!;
		const x = items[held + 2]!;
		h.fake.user().recent.unshift({ trackId: x, playedAt: h.clock.t, contextUri: null });
		h.clock.t += 15 * MINUTE_MS;
		await h.listen(1_000);
		const after = stationDeck(h, sid).pl.items.slice();
		const f = after[held + 2]!; // x's place in the new version
		expect(f).not.toBe(x);
		const heard = earsOn(h);
		h.fake.user().player.isPlaying = true; // the phone plays on in the order it had loaded
		await h.listen(40 * MINUTE_MS);
		expect(heard.get(x)?.length).toBe(1);
		expect(heard.get(x)![0]).toBeLessThan(30_000);
		expect(falseSkips(h)).toBe(0);
	});

	for (const idle of [30 * MINUTE_MS, 8 * 60 * MINUTE_MS])
		it(`skips a song turned down while the player held the station (${idle / MINUTE_MS} min pause)`, async () => {
			const h = await onboarded({ tracks: 600 });
			const sid = h.stationIds[0]!;
			expect((await h.hub.play(sid)).ok).toBe(true);
			await h.listen(10 * MINUTE_MS);
			h.fake.pause();
			await h.hub.state({ live: true });
			const { pl, deck } = stationDeck(h, sid);
			const t = pl.items[deck.lastIndex! + 1]!; // the very next song
			await h.hub.thumb(t, -1);
			await h.listen(idle);
			const heard = earsOn(h);
			h.fake.user().player.isPlaying = true; // resumes its loaded order, app closed
			await h.listen(15 * MINUTE_MS);
			expect(heard.get(t)?.length).toBe(1);
			expect(heard.get(t)![0]).toBeLessThan(30_000);
		});

	it("skips a turned-down song every time it comes up, not only the first", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(5 * MINUTE_MS);
		const p = h.fake.user().player;
		const order = p.order.slice();
		const at = p.index + 3;
		const t = order[at]!;
		await h.hub.thumb(t, -1);
		const heard = earsOn(h);
		await h.listen(20 * MINUTE_MS);
		// Later the same loaded order again, two songs before it.
		Object.assign(p, { order: order.slice(), index: at - 2, progressMs: 0, listenedMs: 0 });
		await h.listen(20 * MINUTE_MS);
		expect(heard.get(t)?.length).toBe(2);
		for (const ms of heard.get(t)!) expect(ms).toBeLessThan(30_000);
	});

	it("a small station started from the top in Spotify later the same day repeats nothing", async () => {
		const h = await onboarded({ tracks: 120 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(3 * 60 * MINUTE_MS);
		h.fake.pause(); // car stop
		await h.listen(2 * 60 * MINUTE_MS); // continued meanwhile, its front full of today's songs
		const { pl, deck } = stationDeck(h, sid);
		expect((deck as { continued?: boolean }).continued).toBe(true);
		const heard = earsOn(h);
		const before = new Set(
			h.sql.all<{ track_id: string }>(`SELECT track_id FROM plays`).map((r) => r.track_id),
		);
		const phone = h.fake.user().player.deviceId!;
		h.fake.startContext("mika", `spotify:playlist:${pl.id}`, 0, phone, false);
		await h.listen(60 * MINUTE_MS);
		const repeats = [...heard.entries()].filter(
			([id, ms]) => before.has(id) && ms.some((x) => x >= 30_000),
		);
		expect(repeats.length).toBeLessThanOrEqual(1);
	});
});

describe("the listener's own choices and long stops (red-team 6)", () => {
	function earsOn(h: H) {
		const heard = new Map<string, number[]>();
		const f = h.fake as unknown as { moveNext: (u: unknown, at: number) => void };
		const orig = f.moveNext.bind(h.fake);
		f.moveNext = (user: unknown, at: number) => {
			const cur = h.fake.current();
			if (cur) heard.set(cur, [...(heard.get(cur) ?? []), h.fake.user().player.listenedMs]);
			orig(user, at);
		};
		return heard;
	}

	for (const guest of [false, true])
		it(`leaves a song the listener queues alone, even one heard today${guest ? " (guest mode)" : ""}`, async () => {
			const h = await onboarded({ tracks: 600, playlists: [500, 100] });
			const [s1, s2] = h.stationIds as [number, number];
			await h.hub.play(s2);
			await h.listen(2_000);
			const q = h.fake.current()!; // heard in full on the other station this morning
			await h.listen(5 * MINUTE_MS);
			h.fake.pause();
			await h.listen(2 * 60 * MINUTE_MS);
			if (guest) h.hub.setGuest(true, 2);
			await h.hub.play(s1);
			await h.listen(6 * MINUTE_MS);
			const heard = earsOn(h);
			h.fake.user().player.userQueue.push(q);
			await h.listen(20 * MINUTE_MS);
			expect(heard.get(q)?.[0]).toBeGreaterThanOrEqual(30_000);
		});

	for (const hours of [13, 20])
		it(`still skips a turned-down song an old order brings back after ${hours} h`, async () => {
			const h = await onboarded({ tracks: 600 });
			const sid = h.stationIds[0]!;
			expect((await h.hub.play(sid)).ok).toBe(true);
			await h.listen(10 * MINUTE_MS);
			h.fake.pause();
			await h.hub.state({ live: true });
			const { pl, deck } = stationDeck(h, sid);
			const t = pl.items[deck.lastIndex! + 2]!;
			await h.hub.thumb(t, -1);
			await h.listen(hours * 60 * MINUTE_MS);
			const heard = earsOn(h);
			h.fake.user().player.isPlaying = true; // the loaded order, app closed
			await h.listen(20 * MINUTE_MS);
			expect(heard.get(t)?.length).toBe(1);
			expect(heard.get(t)![0]).toBeLessThan(30_000);
		});

	it("a continued small station started from the top the next day repeats nothing", async () => {
		const h = await onboarded({ tracks: 120 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(3 * 60 * MINUTE_MS);
		h.fake.pause();
		await h.listen(13 * 60 * MINUTE_MS);
		const { pl } = stationDeck(h, sid);
		const heard = earsOn(h);
		const since = h.clock.t - 24 * 60 * MINUTE_MS;
		const before = new Set(
			h.sql
				.all<{ track_id: string }>(`SELECT track_id FROM plays WHERE played_at >= ?`, since)
				.map((r) => r.track_id),
		);
		h.fake.startContext(
			"mika",
			`spotify:playlist:${pl.id}`,
			0,
			h.fake.user().player.deviceId!,
			false,
		);
		await h.listen(60 * MINUTE_MS);
		const repeats = [...heard.entries()].filter(
			([id, ms]) => before.has(id) && ms.some((x) => x >= 30_000),
		);
		expect(repeats).toEqual([]);
	});

	for (const size of [80, 120, 300])
		it(`a second rewrite during one stop invents no skip and keeps the paused song out (${size} songs)`, async () => {
			const h = await onboarded({ tracks: size });
			const sid = h.stationIds[0]!;
			expect((await h.hub.play(sid)).ok).toBe(true);
			await h.listen(110 * MINUTE_MS);
			const p = h.fake.user().player;
			p.isPlaying = false;
			const paused = h.fake.current()!;
			await h.listen(30 * MINUTE_MS); // first continuation
			await h.hub.updateStation(sid, { rules: {} }); // marks the deck, like new discoveries
			await h.listen(30 * MINUTE_MS); // second continuation
			const { deck, pl } = stationDeck(h, sid);
			expect(deck.version).toBeGreaterThanOrEqual(3);
			expect(pl.items).not.toContain(paused);
			p.isPlaying = true; // the loaded order goes on
			await h.listen(60 * MINUTE_MS);
			expect(falseSkips(h)).toBe(0);
		});

	it("without Spotify access the hub looks only a few times an hour", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true); // just tapped: a quick look is due
		await h.listen(3 * MINUTE_MS);
		// Access removed in Spotify: no token works, none can be refreshed.
		h.fake.refreshTokens.clear();
		h.fake.tokens.clear();
		let alarms = 0;
		const hub = h.hub as unknown as { alarm: () => Promise<void> };
		const orig = hub.alarm.bind(h.hub);
		hub.alarm = () => {
			alarms++;
			return orig();
		};
		await h.listen(24 * 60 * MINUTE_MS);
		expect(alarms).toBeLessThanOrEqual(30);
	});
});

describe("the seventh review's cases", () => {
	function earsOn(h: H) {
		const heard = new Map<string, number[]>();
		const f = h.fake as unknown as { moveNext: (u: unknown, at: number) => void };
		const orig = f.moveNext.bind(h.fake);
		f.moveNext = (user: unknown, at: number) => {
			const cur = h.fake.current();
			if (cur) heard.set(cur, [...(heard.get(cur) ?? []), h.fake.user().player.listenedMs]);
			orig(user, at);
		};
		return heard;
	}

	it("a guest's early skip shortly before guest mode ends stays out of memory", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		await h.hub.updateStation(sid, { rules: { skipPolicy: "ban" } });
		h.hub.setGuest(true, 1);
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(52 * MINUTE_MS);
		let g: string | null = null;
		for (let i = 0; i < 200 && !g; i++) {
			await h.listen(1_000);
			const p = h.fake.user().player;
			if (p.listenedMs >= 8_000 && p.listenedMs < 12_000) {
				g = h.fake.current();
				h.fake.skip();
			}
		}
		await h.listen(40 * MINUTE_MS); // guest mode ends; the owner listens on
		const row = h.sql.first<{ early_skips: number }>(
			`SELECT early_skips FROM memory WHERE id = ?`,
			g,
		);
		expect(row?.early_skips ?? 0).toBe(0);
		expect(h.sql.first(`SELECT 1 FROM bans WHERE track_id = ?`, g)).toBeNull();
	});

	it("forgets songs of older versions after 36 h: a queued one plays", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(20 * MINUTE_MS);
		const first = stationDeck(h, sid).pl.items.slice();
		// Three days of one session a day, each started from the app.
		for (let day = 0; day < 3; day++) {
			h.fake.pause();
			await h.listen(22 * 60 * MINUTE_MS);
			expect((await h.hub.play(sid)).ok).toBe(true);
			await h.listen(20 * MINUTE_MS);
		}
		const now = stationDeck(h, sid).pl.items;
		const x = first.slice(150).find((id) => !now.includes(id))!; // only in the version of day 0
		h.fake.user().recent.unshift({ trackId: x, playedAt: h.clock.t, contextUri: null }); // heard today
		const heard = earsOn(h);
		h.fake.user().player.userQueue.push(x);
		await h.listen(15 * MINUTE_MS);
		expect(heard.get(x)?.[0]).toBeGreaterThanOrEqual(30_000);
	});

	for (const size of [120, 600])
		it(`a song turned down during a stop is caught in an order two versions old (${size} songs)`, async () => {
			const h = await onboarded({ tracks: size });
			const sid = h.stationIds[0]!;
			expect((await h.hub.play(sid)).ok).toBe(true);
			await h.listen(30 * MINUTE_MS);
			const p = h.fake.user().player;
			p.isPlaying = false;
			const t = p.order[p.index + 3]!;
			const before = p.order[p.index + 2]!;
			await h.listen(12 * MINUTE_MS); // first continuation
			await h.hub.thumb(t, -1); // turned down in the app while the car is parked
			await h.listen(30 * MINUTE_MS); // a continuation without it
			await h.hub.thumb(p.order[p.index + 9]!, -1); // another one: a further continuation
			await h.listen(30 * MINUTE_MS);
			expect(stationDeck(h, sid).deck.version).toBeGreaterThanOrEqual(3);
			const heard = earsOn(h);
			p.isPlaying = true; // the loaded order goes on …
			let skipped = false;
			for (let i = 0; i < 480; i++) {
				await h.listen(5_000);
				// … the song before t is skipped by hand after 5 s: t comes up
				if (!skipped && h.fake.current() === before && p.listenedMs >= 5_000) {
					h.fake.skip();
					skipped = true;
				}
			}
			expect(heard.get(t)?.length).toBe(1);
			expect(heard.get(t)![0]).toBeLessThan(30_000);
		});
});

describe("the eighth review's cases", () => {
	function earsOn(h: H) {
		const heard = new Map<string, number[]>();
		const f = h.fake as unknown as { moveNext: (u: unknown, at: number) => void };
		const orig = f.moveNext.bind(h.fake);
		f.moveNext = (user: unknown, at: number) => {
			const cur = h.fake.current();
			if (cur) heard.set(cur, [...(heard.get(cur) ?? []), h.fake.user().player.listenedMs]);
			orig(user, at);
		};
		return heard;
	}

	for (const beforeEnd of [30, 150])
		it(`a guest's skip ${beforeEnd} s before guest mode ends stays the guest's`, async () => {
			const h = await onboarded({ tracks: 300 });
			const sid = h.stationIds[0]!;
			await h.hub.updateStation(sid, { rules: { skipPolicy: "ban" } });
			h.hub.setGuest(true, 1);
			const end = (await h.hub.state()).guest.until!;
			expect((await h.hub.play(sid)).ok).toBe(true);
			await h.listen(end - h.clock.t - beforeEnd * 1000 - 4 * MINUTE_MS);
			let g: string | null = null;
			for (let i = 0; i < 600 && !g; i++) {
				await h.listen(1_000);
				const p = h.fake.user().player;
				if (h.clock.t >= end - beforeEnd * 1000 && p.listenedMs >= 8_000 && p.listenedMs < 12_000) {
					g = h.fake.current();
					h.fake.skip();
				}
			}
			expect(h.clock.t).toBeLessThan(end);
			await h.listen(40 * MINUTE_MS); // guest mode ends; the owner listens on
			const row = h.sql.first<{ early_skips: number }>(
				`SELECT early_skips FROM memory WHERE id = ?`,
				g,
			);
			expect(row?.early_skips ?? 0).toBe(0);
			expect(h.sql.first(`SELECT 1 FROM bans WHERE track_id = ?`, g)).toBeNull();
		});

	it("a song turned down during a 40-h hold is caught after a skip by hand onto it", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(30 * MINUTE_MS);
		const p = h.fake.user().player;
		p.isPlaying = false;
		const x = p.order[p.index + 3]!;
		const before = p.order[p.index + 2]!;
		await h.listen(38 * 60 * MINUTE_MS);
		await h.hub.thumb(x, -1);
		await h.listen(2 * 60 * MINUTE_MS);
		const heard = earsOn(h);
		p.isPlaying = true;
		let skipped = false;
		for (let i = 0; i < 480; i++) {
			await h.listen(5_000);
			if (!skipped && h.fake.current() === before && p.listenedMs >= 5_000) {
				h.fake.skip();
				skipped = true;
			}
		}
		expect(heard.get(x)?.length).toBe(1);
		expect(heard.get(x)![0]).toBeLessThan(30_000);
	});

	it("started from the top, the first song skipped early: today's songs behind it are jumped", async () => {
		const h = await onboarded({ tracks: 120 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(3 * 60 * MINUTE_MS);
		h.fake.pause();
		await h.listen(40 * MINUTE_MS);
		const { pl } = stationDeck(h, sid);
		const today = new Set(
			h.sql.all<{ track_id: string }>(`SELECT track_id FROM plays`).map((r) => r.track_id),
		);
		const heard = earsOn(h);
		const p = h.fake.user().player;
		h.fake.startContext("mika", `spotify:playlist:${pl.id}`, 0, p.deviceId!, false);
		let skipped = false;
		for (let i = 0; i < 3600; i++) {
			await h.listen(1_000);
			if (!skipped && p.index === 0 && p.listenedMs >= 5_000) {
				h.fake.skip();
				skipped = true;
			}
		}
		const repeats = [...heard.entries()].filter(
			([id, ms]) => today.has(id) && ms.some((x) => x >= 30_000),
		);
		expect(repeats).toEqual([]);
	});

	it('in "Alles", never played before, a song the listener queues plays', async () => {
		const h = await onboarded({ tracks: 1200, playlists: [600, 600] });
		const [s1] = h.stationIds as [number];
		const all = h.allId;
		await h.listen(20 * 60 * MINUTE_MS); // background rewrites of every station meanwhile
		expect((await h.hub.play(s1)).ok).toBe(true);
		await h.listen(90 * MINUTE_MS);
		h.fake.pause();
		await h.listen(3 * 60 * MINUTE_MS);
		const today = [
			...new Set(
				h.sql.all<{ track_id: string }>(`SELECT track_id FROM plays`).map((r) => r.track_id),
			),
		];
		expect((await h.hub.play(all)).ok).toBe(true);
		await h.listen(4 * MINUTE_MS);
		const inAll = new Set(stationDeck(h, all).pl.items);
		const q = today.find((id) => !inAll.has(id))!;
		const heard = earsOn(h);
		h.fake.user().player.userQueue.push(q);
		await h.listen(15 * MINUTE_MS);
		expect(heard.get(q)?.[0]).toBeGreaterThanOrEqual(30_000);
	});
});

describe("the ninth review's cases", () => {
	function earsOn(h: H) {
		const heard = new Map<string, number[]>();
		const f = h.fake as unknown as { moveNext: (u: unknown, at: number) => void };
		const orig = f.moveNext.bind(h.fake);
		f.moveNext = (user: unknown, at: number) => {
			const cur = h.fake.current();
			if (cur) heard.set(cur, [...(heard.get(cur) ?? []), h.fake.user().player.listenedMs]);
			orig(user, at);
		};
		return heard;
	}

	it("a guest's skip stays the guest's when the owner switches guest mode off and taps the station", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		await h.hub.updateStation(sid, { rules: { skipPolicy: "ban" } });
		h.hub.setGuest(true, 6);
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(40 * MINUTE_MS);
		let g: string | null = null;
		for (let i = 0; i < 600 && !g; i++) {
			await h.listen(1_000);
			const p = h.fake.user().player;
			if (p.listenedMs >= 8_000 && p.listenedMs < 12_000) {
				g = h.fake.current();
				h.fake.skip();
			}
		}
		await h.listen(20_000);
		h.hub.setGuest(false);
		expect((await h.hub.play(sid)).ok).toBe(true); // a rewrite within the skip's wait
		await h.listen(45 * MINUTE_MS);
		const row = h.sql.first<{ early_skips: number }>(
			`SELECT early_skips FROM memory WHERE id = ?`,
			g,
		);
		expect(row?.early_skips ?? 0).toBe(0);
		expect(h.sql.first(`SELECT 1 FROM bans WHERE track_id = ?`, g)).toBeNull();
	});

	it("infers no skip across a place the new version changed", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(30 * MINUTE_MS);
		const p = h.fake.user().player;
		p.isPlaying = false;
		const before = p.order[p.index + 2]!;
		const y = p.order[p.index + 3]!;
		await h.listen(15 * MINUTE_MS);
		await h.hub.thumb(y, -1); // the continuation puts another song in its place
		await h.listen(30 * MINUTE_MS);
		const replacement = stationDeck(h, sid).pl.items[p.index + 3]!;
		p.isPlaying = true; // the loaded order goes on
		let stage = 0;
		for (let i = 0; i < 900; i++) {
			await h.listen(1_000);
			const cur = h.fake.current();
			if (stage === 0 && cur === before && p.listenedMs >= 5_000) {
				h.fake.skip();
				stage = 1;
			} else if (stage === 1 && cur === y && p.listenedMs >= 2_000) {
				h.fake.skip();
				stage = 2;
			}
		}
		await h.listen(30 * MINUTE_MS);
		const row = h.sql.first<{ early_skips: number }>(
			`SELECT early_skips FROM memory WHERE id = ?`,
			replacement,
		);
		expect(row?.early_skips ?? 0).toBe(0);
	});

	for (const hours of [4, 8])
		it(`started from the top ${hours} h after a stop, the first song skipped early: nothing repeats`, async () => {
			const h = await onboarded({ tracks: 120 });
			const sid = h.stationIds[0]!;
			expect((await h.hub.play(sid)).ok).toBe(true);
			await h.listen(3 * 60 * MINUTE_MS);
			h.fake.pause();
			await h.listen(hours * 60 * MINUTE_MS);
			const { pl } = stationDeck(h, sid);
			const today = new Set(
				h.sql.all<{ track_id: string }>(`SELECT track_id FROM plays`).map((r) => r.track_id),
			);
			const heard = earsOn(h);
			const p = h.fake.user().player;
			h.fake.startContext("mika", `spotify:playlist:${pl.id}`, 0, p.deviceId!, false);
			let skipped = false;
			for (let i = 0; i < 3600; i++) {
				await h.listen(1_000);
				if (!skipped && p.index === 0 && p.listenedMs >= 5_000) {
					h.fake.skip();
					skipped = true;
				}
			}
			const repeats = [...heard.entries()].filter(
				([id, ms]) => today.has(id) && ms.some((x) => x >= 30_000),
			);
			expect(repeats).toEqual([]);
		});

	it("a turned-down song is skipped after a weekend with the phone out of sight", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(30 * MINUTE_MS);
		const p = h.fake.user().player;
		p.isPlaying = false;
		const device = p.deviceId;
		const x = p.order[p.index + 2]!;
		p.deviceId = null; // parked: Spotify shows no player
		await h.listen(18 * 60 * MINUTE_MS);
		await h.hub.thumb(x, -1);
		await h.listen(43 * 60 * MINUTE_MS);
		const heard = earsOn(h);
		p.deviceId = device;
		p.isPlaying = true; // Monday morning: the loaded order goes on
		await h.listen(20 * MINUTE_MS);
		expect(heard.get(x)?.length).toBe(1);
		expect(heard.get(x)![0]).toBeLessThan(30_000);
	});
});

describe("the tenth look: older orders and the edges of guest time", () => {
	it("infers no skip from an older order that runs past the songs a continuation kept", async () => {
		// A small station deep into its round: the continuation keeps the songs
		// after the held one at their places, but moves the last two forward.
		const h = await onboarded({ tracks: 24 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		const p = h.fake.user().player;
		while (p.index < 8) await h.listen(5_000);
		await h.listen(60_000);
		h.fake.pause();
		const loaded = p.order.slice();
		await h.listen(40 * MINUTE_MS);
		const { deck, pl } = stationDeck(h, sid);
		expect(deck.version).toBe(2);
		// The last songs of the order the phone still has sit in front now,
		// with songs it already played between them.
		const tail = loaded.slice(-2);
		expect(pl.items.indexOf(tail[0]!)).toBeLessThan(pl.items.indexOf(tail[1]!) - 1);
		p.isPlaying = true; // the loaded order goes on to its end, nothing skipped
		await h.listen(80 * MINUTE_MS);
		expect(p.order).toEqual(loaded);
		await h.listen(40 * MINUTE_MS);
		expect(falseSkips(h)).toBe(0);
		expect(
			(
				JSON.parse(
					h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!.deck,
				) as {
					strayedUntil?: number;
				}
			).strayedUntil,
		).toBeGreaterThan(h.clock.t);
	});

	it("a song still playing when guest mode goes off stays the guest's", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		h.hub.setGuest(true, 6);
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(10 * MINUTE_MS);
		const p = h.fake.user().player;
		const x = h.fake.current()!;
		while (h.fake.current() === x) await h.listen(1_000);
		const y = h.fake.current()!;
		await h.listen(60_000);
		h.hub.setGuest(false); // y plays on to its end, and the owner's music after it
		await h.listen(40 * MINUTE_MS);
		expect(p.isPlaying).toBe(true);
		const rows = h.sql.all<{ track_id: string; ignored: number }>(
			`SELECT track_id, ignored FROM plays ORDER BY played_at`,
		);
		expect(rows.find((r) => r.track_id === y)?.ignored).toBe(1);
		expect(rows.at(-1)?.ignored).toBe(0);
		const mem = h.sql.first<{ plays: number }>(`SELECT plays FROM memory WHERE id = ?`, y);
		expect(mem?.plays ?? 0).toBe(0);
	});

	it("a song that ended just as guest mode came on stays the owner's", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(10 * MINUTE_MS);
		const p = h.fake.user().player;
		const x = h.fake.current()!;
		await h.listen(h.fake.tracks.get(x)!.durationMs - p.progressMs); // ends right now
		expect(h.fake.current()).not.toBe(x);
		h.hub.setGuest(true, 1);
		await h.listen(30 * MINUTE_MS);
		const row = h.sql.first<{ ignored: number }>(`SELECT ignored FROM plays WHERE track_id = ?`, x);
		expect(row?.ignored).toBe(0);
		const mem = h.sql.first<{ plays: number }>(`SELECT plays FROM memory WHERE id = ?`, x);
		expect(mem?.plays).toBe(1);
	});
});

describe("the tenth review's cases", () => {
	function deckOf(h: H, sid: number) {
		return JSON.parse(
			h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!.deck,
		) as {
			version: number;
			items: { id: string }[];
			heldAt: number | null;
			changedAt?: number[];
			strayedUntil?: number;
		};
	}
	const ignoredOf = (h: H, id: string) =>
		h.sql.first<{ ignored: number }>(
			`SELECT ignored FROM plays WHERE track_id = ? ORDER BY played_at DESC`,
			id,
		)?.ignored;

	it("the owner's short plays right after guest mode goes off count", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		h.hub.setGuest(true, 6);
		await h.listen(20 * MINUTE_MS);
		const p = h.fake.user().player;
		const x = h.fake.current()!;
		while (h.fake.current() === x) await h.listen(1_000);
		await h.listen(60_000);
		const y = h.fake.current()!; // the guest's song, still running
		h.hub.setGuest(false);
		await h.listen(30_000);
		const mine: string[] = [];
		for (let i = 0; i < 4; i++) {
			h.fake.skip(); // the owner samples songs for 45 s each
			mine.push(h.fake.current()!);
			await h.listen(45_000);
		}
		h.fake.skip();
		await h.listen(20 * MINUTE_MS);
		p.isPlaying = false;
		await h.listen(30 * MINUTE_MS);
		expect(ignoredOf(h, y)).toBe(1);
		expect(mine.map((id) => ignoredOf(h, id))).toEqual([0, 0, 0, 0]);
	});

	it("after guest mode ran out on its own, the song running then is the guest's, the next ones count", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		h.hub.setGuest(true, 1);
		const p = h.fake.user().player;
		await h.listen(58 * MINUTE_MS);
		let y = h.fake.current()!;
		// the song running when the hour is up
		while ((await h.hub.state()).guest.active) {
			await h.listen(1_000);
			y = h.fake.current()!;
		}
		while (h.fake.current() === y) await h.listen(1_000);
		const mine: string[] = [];
		for (let i = 0; i < 3; i++) {
			mine.push(h.fake.current()!);
			await h.listen(45_000);
			h.fake.skip();
		}
		await h.listen(20 * MINUTE_MS);
		p.isPlaying = false;
		await h.listen(30 * MINUTE_MS);
		expect(ignoredOf(h, y)).toBe(1);
		expect(mine.map((id) => ignoredOf(h, id))).toEqual([0, 0, 0]);
	});

	it("a guest's play of a song the owner skipped leaves the skip and the ban", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		await h.hub.updateStation(sid, { rules: { skipPolicy: "ban" } });
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(8 * MINUTE_MS);
		const p = h.fake.user().player;
		const y = h.fake.current()!;
		while (h.fake.current() === y) await h.listen(1_000);
		const x = h.fake.current()!;
		while (p.listenedMs < 15_000) await h.listen(1_000);
		h.fake.skip();
		await h.listen(25 * MINUTE_MS);
		expect(h.sql.first(`SELECT 1 FROM bans WHERE track_id = ?`, x)).not.toBeNull();
		h.hub.setGuest(true, 6);
		const live = stationDeck(h, sid).pl.items.slice();
		p.order = live;
		p.index = live.indexOf(x); // the guest taps it in the same playlist
		p.progressMs = 0;
		p.listenedMs = 0;
		p.currentFromQueue = null;
		await h.listen(6 * MINUTE_MS);
		expect(ignoredOf(h, x)).toBe(1);
		const mem = h.sql.first<{ early_skips: number }>(
			`SELECT early_skips FROM memory WHERE id = ?`,
			x,
		);
		expect(mem?.early_skips).toBe(1);
		expect(h.sql.first(`SELECT 1 FROM bans WHERE track_id = ?`, x)).not.toBeNull();
	});

	it("restarting a continued playlist from the top keeps inferring skips", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(25 * MINUTE_MS);
		h.fake.pause();
		await h.listen(15 * MINUTE_MS);
		const { deck, pl } = stationDeck(h, sid);
		expect(deck.version).toBe(2);
		const p = h.fake.user().player;
		const live = pl.items.slice();
		p.order = live; // resumes the new version where it stopped
		p.currentFromQueue = null;
		p.isPlaying = true;
		await h.listen(4 * MINUTE_MS);
		p.index = 0; // then the listener starts it from the top in Spotify
		p.progressMs = 0;
		p.listenedMs = 0;
		await h.listen(60_000);
		// Two songs skipped in a row: the second is never seen playing.
		while (h.fake.current() === live[0]) await h.listen(1_000);
		await h.listen(8_000);
		h.fake.skip();
		const unseen = h.fake.current()!;
		await h.listen(3_000);
		h.fake.skip();
		await h.listen(30 * MINUTE_MS);
		expect(deckOf(h, sid).strayedUntil).toBeUndefined();
		const mem = h.sql.first<{ early_skips: number }>(
			`SELECT early_skips FROM memory WHERE id = ?`,
			unseen,
		);
		expect(mem?.early_skips).toBe(1);
	});

	it("a later continuation still knows where an older version changed", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(20 * MINUTE_MS);
		const p = h.fake.user().player;
		p.isPlaying = false;
		const loaded = p.order.slice();
		const x = loaded[p.index + 8]!;
		await h.listen(5 * MINUTE_MS);
		await h.hub.thumb(x, -1); // v2 takes it out: the old order differs there
		await h.listen(20 * MINUTE_MS);
		const v2 = deckOf(h, sid);
		// Where the old order has the turned-down song, v2 has another one.
		const mark = v2.changedAt?.[0];
		expect(mark).toBeDefined();
		expect(loaded.slice(loaded.indexOf(x) - 1, loaded.indexOf(x))).toContain(
			v2.items[mark! - 1]!.id,
		);
		const there = v2.items[mark!]!.id;
		p.isPlaying = true; // the old order goes on for a song, then stops again
		const cur = h.fake.current();
		while (h.fake.current() === cur) await h.listen(1_000);
		await h.listen(60_000);
		p.isPlaying = false;
		await h.hub.thumb(loaded[loaded.indexOf(x) + 4]!, -1); // another rewrite
		await h.listen(20 * MINUTE_MS);
		const v3 = deckOf(h, sid);
		expect(v3.version).toBeGreaterThan(v2.version);
		expect(v3.changedAt).toContain(v3.items.findIndex((it) => it.id === there));
	});
});
