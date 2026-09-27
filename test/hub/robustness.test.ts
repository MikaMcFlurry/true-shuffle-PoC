/**
 * Real-life situations that must not corrupt the memory or stop a station.
 * Several of these were found by the independent red-team review (RT-n).
 */

import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "../../src/core/types";
import { FakeSpotify } from "../fakes/fake-spotify";
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
			if (guest) await h.hub.setGuest(true, 2);
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
		await h.hub.setGuest(true, 1);
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
		// When each song was last seen in a version of the station.
		const lastIn = new Map<string, number>();
		const sample = () => {
			for (const id of stationDeck(h, sid).pl.items) lastIn.set(id, h.clock.t);
		};
		// Three days of one session a day, each started from the app.
		for (let day = 0; day < 3; day++) {
			h.fake.pause();
			// Rewritten in the background meanwhile, maybe more than once.
			for (let hour = 0; hour < 22; hour++) {
				await h.listen(60 * MINUTE_MS);
				sample();
			}
			expect((await h.hub.play(sid)).ok).toBe(true);
			sample();
			await h.listen(20 * MINUTE_MS);
			sample();
		}
		// In no version of the last 36 hours.
		const x = first
			.slice(150)
			.find((id) => (lastIn.get(id) ?? 0) < h.clock.t - 37 * 60 * MINUTE_MS)!;
		expect(x).toBeDefined();
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
			await h.hub.setGuest(true, 1);
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
		await h.hub.setGuest(true, 6);
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
		await h.hub.setGuest(false);
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

	for (const owner of ["skips it", "hears it on"] as const)
		it(`a song still playing when guest mode goes off: the guest's unless the owner hears 30 s of it (${owner})`, async () => {
			const h = await onboarded({ tracks: 300 });
			const sid = h.stationIds[0]!;
			await h.hub.setGuest(true, 6);
			expect((await h.hub.play(sid)).ok).toBe(true);
			await h.listen(10 * MINUTE_MS);
			const p = h.fake.user().player;
			const x = h.fake.current()!;
			while (h.fake.current() === x) await h.listen(1_000);
			const y = h.fake.current()!;
			await h.listen(60_000);
			expect(h.fake.tracks.get(y)!.durationMs - p.progressMs).toBeGreaterThan(40_000);
			await h.hub.setGuest(false);
			if (owner === "skips it") {
				await h.listen(5_000);
				h.fake.skip();
			} // else y plays on to its end, and the owner's music after it
			await h.listen(40 * MINUTE_MS);
			expect(p.isPlaying).toBe(true);
			const rows = h.sql.all<{ track_id: string; ignored: number }>(
				`SELECT track_id, ignored FROM plays ORDER BY played_at`,
			);
			const heard = owner === "hears it on";
			expect(rows.find((r) => r.track_id === y)?.ignored).toBe(heard ? 0 : 1);
			expect(rows.at(-1)?.ignored).toBe(0);
			const mem = h.sql.first<{ plays: number }>(`SELECT plays FROM memory WHERE id = ?`, y);
			expect(mem?.plays ?? 0).toBe(heard ? 1 : 0);
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
		await h.hub.setGuest(true, 1);
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
		await h.hub.setGuest(true, 6);
		await h.listen(20 * MINUTE_MS);
		const p = h.fake.user().player;
		const x = h.fake.current()!;
		while (h.fake.current() === x) await h.listen(1_000);
		await h.listen(60_000);
		const y = h.fake.current()!; // the guest's song, still running
		await h.hub.setGuest(false);
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
		await h.hub.setGuest(true, 1);
		const p = h.fake.user().player;
		await h.listen(58 * MINUTE_MS);
		let y = h.fake.current()!;
		// the song running when the hour is up, left within seconds
		while ((await h.hub.state()).guest.active) {
			await h.listen(1_000);
			y = h.fake.current()!;
		}
		await h.listen(3_000);
		if (h.fake.current() === y) h.fake.skip();
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
		await h.hub.setGuest(true, 6);
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

describe("the eleventh review's cases", () => {
	it("a guest who skips just before guest mode goes off: the song then playing stays the guest's when the owner leaves it", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(10 * MINUTE_MS);
		await h.hub.setGuest(true, 6);
		const u = h.fake.user();
		const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
		h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 7, u.player.deviceId!, false);
		await h.listen(35 * MINUTE_MS);
		await h.hub.state({ live: true }); // the app looked 20 s before
		await h.listen(10_000);
		h.fake.skip(); // the guest skips
		await h.listen(10_000);
		const running = h.fake.current()!;
		await h.hub.setGuest(false);
		await h.listen(25_000);
		h.fake.skip(); // the owner moves on: heard 35 s, 25 of them the owner's
		await h.listen(30 * MINUTE_MS);
		u.player.isPlaying = false;
		await h.listen(30 * MINUTE_MS);
		const row = h.sql.first<{ ignored: number }>(
			`SELECT ignored FROM plays WHERE track_id = ? ORDER BY played_at DESC`,
			running,
		);
		expect(row?.ignored).toBe(1);
		const mem = h.sql.first<{ plays: number }>(`SELECT plays FROM memory WHERE id = ?`, running);
		expect(mem?.plays ?? 0).toBe(0);
	});

	it("a guest's play of a song the owner left minutes before leaves the owner's skip and ban", async () => {
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
		h.fake.skip(); // the owner's early skip, seen playing
		await h.listen(10 * MINUTE_MS); // still waiting to be booked
		await h.hub.setGuest(true, 6);
		const live = stationDeck(h, sid).pl.items.slice();
		p.order = live;
		p.index = live.indexOf(x); // the guest taps it and hears it
		p.progressMs = 0;
		p.listenedMs = 0;
		p.currentFromQueue = null;
		p.isPlaying = true;
		await h.listen(40 * MINUTE_MS);
		const mem = h.sql.first<{ early_skips: number }>(
			`SELECT early_skips FROM memory WHERE id = ?`,
			x,
		);
		expect(mem?.early_skips).toBe(1);
		expect(h.sql.first(`SELECT 1 FROM bans WHERE track_id = ?`, x)).not.toBeNull();
	});
});

describe("the twelfth review's cases", () => {
	it("a song from further down the station, queued, books no skip for the songs in between", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(20 * MINUTE_MS);
		const p = h.fake.user().player;
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
		await h.listen(20_000);
		const items = stationDeck(h, sid).pl.items;
		const q = items[items.indexOf(h.fake.current()!) + 6]!;
		p.userQueue.push(q); // plays inside the playlist, then back in order
		while (h.fake.current() !== q) await h.listen(1_000);
		while (h.fake.current() === q) await h.listen(1_000);
		const after = h.fake.current();
		while (h.fake.current() === after) await h.listen(1_000);
		h.fake.pause();
		await h.listen(45 * MINUTE_MS);
		expect(falseSkips(h)).toBe(0);
	});

	it("a small station's continuation knows where every order has the same songs", async () => {
		const h = await onboarded({ tracks: 24 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		const p = h.fake.user().player;
		while (p.index < 8) await h.listen(5_000);
		await h.listen(60_000);
		h.fake.pause();
		const v1 = p.order.slice();
		await h.listen(40 * MINUTE_MS);
		const d = JSON.parse(
			h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!.deck,
		) as { items: { id: string }[]; sharedAt?: [number, number][] };
		const shared = (i: number) => (d.sharedAt ?? []).some(([a, b]) => i >= a && i < b);
		for (let i = 0; i + 1 < d.items.length; i++) {
			const j = v1.indexOf(d.items[i]!.id);
			expect(shared(i)).toBe(j >= 0 && v1[j + 1] === d.items[i + 1]!.id);
		}
		expect(d.sharedAt?.length).toBeGreaterThan(0);
	});

	it("a guest who skips just after the last look: the next song stays the guest's when the owner leaves it", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = h.fake.user();
		expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
		await h.listen(5 * MINUTE_MS);
		await h.hub.setGuest(true, 6);
		const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
		h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 7, u.player.deviceId!, false);
		await h.listen(12 * MINUTE_MS);
		while (u.player.progressMs < 60_000) await h.listen(1_000);
		(h.hub as unknown as { kvDel: (k: string) => void }).kvDel("player");
		await h.hub.state({ live: true }); // the app looks
		await h.listen(3_000);
		h.fake.skip(); // the guest skips
		await h.listen(3_000);
		const b = h.fake.current()!;
		await h.hub.setGuest(false);
		await h.listen(28_000);
		h.fake.skip(); // the owner moves on: heard 31 s, 28 of them the owner's
		await h.listen(15 * MINUTE_MS);
		u.player.isPlaying = false;
		await h.listen(30 * MINUTE_MS);
		const row = h.sql.first<{ ignored: number }>(
			`SELECT ignored FROM plays WHERE track_id = ? ORDER BY played_at DESC`,
			b,
		);
		expect(row?.ignored).toBe(1);
	});
});

describe("the thirteenth review's cases", () => {
	it("guest mode off after a look at a paused player: the owner's next song counts", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = h.fake.user();
		await h.hub.setGuest(true, 6);
		const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
		h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 5, u.player.deviceId!, false);
		await h.listen(20 * MINUTE_MS);
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
		while (u.player.listenedMs < 10_000) await h.listen(1_000);
		u.player.isPlaying = false; // the guest pauses early in a song
		await h.listen(2 * MINUTE_MS);
		await h.hub.state({ live: true }); // the owner opens the app
		await h.listen(20_000);
		await h.hub.setGuest(false);
		await h.listen(10_000);
		expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
		await h.listen(2_000);
		const first = h.fake.current()!;
		while (u.player.listenedMs < 45_000) await h.listen(1_000);
		h.fake.skip();
		await h.listen(20 * MINUTE_MS);
		u.player.isPlaying = false;
		await h.listen(30 * MINUTE_MS);
		const row = h.sql.first<{ ignored: number }>(
			`SELECT ignored FROM plays WHERE track_id = ? ORDER BY played_at DESC`,
			first,
		);
		expect(row?.ignored).toBe(0);
	});
});

describe("the fourteenth review's cases", () => {
	async function nextSong(h: H) {
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
	}

	it("two songs from further up, queued in order, book no skip for the songs between them", async () => {
		const h = await onboarded({ tracks: 150 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		const u = h.fake.user();
		const p = u.player;
		await nextSong(h);
		await nextSong(h);
		await h.listen(40_000);
		// The listener taps a song 25 further down; its play reaches Spotify's list.
		(
			h.fake as unknown as { recordIfHeard: (u: unknown, id: string, at: number) => void }
		).recordIfHeard(u, h.fake.current()!, h.clock.t);
		h.fake.startContext(u.id, p.contextUri!, p.index + 25, p.deviceId!, false);
		for (let i = 0; i < 4; i++) await nextSong(h);
		await h.listen(20_000);
		const items = stationDeck(h, sid).pl.items;
		p.userQueue.push(items[p.index - 20]!, items[p.index - 13]!); // both never reached
		await h.listen(60 * MINUTE_MS);
		h.fake.pause();
		await h.listen(45 * MINUTE_MS);
		expect(falseSkips(h)).toBe(0);
	});

	it("skips that end right as the song seen last would have: still booked", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(10 * MINUTE_MS);
		const items = stationDeck(h, sid).pl.items;
		const at = items.indexOf(h.fake.current()!);
		const [w, x, y] = [items[at + 1]!, items[at + 2]!, items[at + 3]!];
		h.fake.tracks.get(w)!.durationMs = 160_000;
		h.fake.tracks.get(x)!.durationMs = 200_000;
		h.fake.tracks.get(y)!.durationMs = 150_000; // 5 s + 5 s + 150 s: as long as w
		while (h.fake.current() !== w) await h.listen(1_000);
		await h.listen(4_000); // the hub has seen w in its first seconds
		h.fake.skip();
		await h.listen(5_000);
		h.fake.skip(); // x, unseen
		await h.listen(15 * MINUTE_MS);
		h.fake.pause();
		await h.listen(30 * MINUTE_MS);
		const early = (id: string) =>
			h.sql.first<{ n: number }>(`SELECT early_skips AS n FROM memory WHERE id = ?`, id)?.n ?? 0;
		expect([early(w), early(x), early(y)]).toEqual([1, 1, 0]);
	});

	it("the play of the song before shows up late, after a stop: the skips booked meanwhile go", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(10 * MINUTE_MS);
		await nextSong(h);
		await h.listen(20_000);
		const u = h.fake.user();
		const items = stationDeck(h, sid).pl.items;
		const a = h.fake.current()!;
		const q = items[items.indexOf(a) + 5]!;
		u.player.userQueue.push(q);
		while (h.fake.current() !== q) await h.listen(1_000);
		// Spotify lists a's play only 25 minutes late.
		const i = u.recent.findIndex((e) => e.trackId === a);
		const late = u.recent.splice(i, 1)[0]!;
		const release = h.clock.t + 25 * MINUTE_MS;
		await h.listen(60_000);
		h.fake.pause(); // and does not come back
		while (h.clock.t < release) await h.listen(30_000);
		u.recent.push(late);
		u.recent.sort((x, y) => y.playedAt - x.playedAt);
		await h.listen(2 * 60 * MINUTE_MS);
		expect(h.sql.first(`SELECT 1 FROM plays WHERE track_id = ?`, a)).not.toBeNull();
		expect(falseSkips(h)).toBe(0);
	});

	it("a song queued from a few places ahead, then the listener stops: no skip for the songs between", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(20 * MINUTE_MS);
		await nextSong(h);
		await h.listen(20_000);
		const items = stationDeck(h, sid).pl.items;
		const q = items[items.indexOf(h.fake.current()!) + 6]!;
		h.fake.user().player.userQueue.push(q);
		while (h.fake.current() !== q) await h.listen(1_000);
		await h.listen(60_000);
		h.fake.pause(); // and does not come back
		await h.listen(3 * 60 * MINUTE_MS);
		expect(falseSkips(h)).toBe(0);
	});
});

describe("the fifteenth review's cases", () => {
	it("a private session in Spotify books no skip, not even a ban", async () => {
		const h = await onboarded({ tracks: 600 });
		const sid = h.stationIds[0]!;
		await h.hub.updateStation(sid, { rules: { skipPolicy: "ban" } });
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(5 * MINUTE_MS);
		const u = h.fake.user();
		u.devices.find((d) => d.id === u.player.deviceId)!.privateSession = true;
		for (let i = 0; i < 6; i++) {
			const c0 = h.fake.current();
			while (h.fake.current() === c0) await h.listen(1_000);
			await h.listen(i % 2 === 0 ? 10_000 : 3 * MINUTE_MS); // some left early, some heard
			if (i % 2 === 0) h.fake.skip();
		}
		h.fake.pause();
		await h.listen(60 * MINUTE_MS);
		expect(falseSkips(h)).toBe(0);
		expect(h.sql.first<{ n: number }>(`SELECT COUNT(*) AS n FROM bans`)!.n).toBe(0);
		// Out of it, skips count again.
		u.devices.find((d) => d.id === u.player.deviceId)!.privateSession = false;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(2 * MINUTE_MS);
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
		await h.listen(10_000);
		h.fake.skip();
		await h.listen(40 * MINUTE_MS);
		expect(falseSkips(h)).toBe(1);
	});
});

describe("the sixteenth review's cases", () => {
	for (const mode of ["guest", "private"] as const)
		it(`a skip never booked (${mode}) takes no earlier skip back when the song plays later`, async () => {
			const h = await onboarded({ tracks: 300 });
			const sid = h.stationIds[0]!;
			const u = h.fake.user();
			expect((await h.hub.play(sid)).ok).toBe(true);
			await h.listen(8 * MINUTE_MS);
			const c0 = h.fake.current();
			while (h.fake.current() === c0) await h.listen(1_000);
			const x = h.fake.current()!;
			// The owner skipped it three days ago.
			const old = h.clock.t - 3 * 24 * 60 * MINUTE_MS;
			h.sql.run(
				`INSERT INTO memory (id, last_played_at, plays, early_skips, last_skipped_at, consumed_at, thumb) VALUES (?, NULL, 0, 1, ?, NULL, 0)
				 ON CONFLICT(id) DO UPDATE SET early_skips = 1, last_skipped_at = excluded.last_skipped_at`,
				x,
				old,
			);
			(h.hub as unknown as { liveLookups: Map<string, unknown> }).liveLookups.delete(x);
			const dev = u.devices.find((d) => d.id === u.player.deviceId)!;
			if (mode === "guest") await h.hub.setGuest(true, 6);
			else dev.privateSession = true;
			await h.listen(10_000);
			h.fake.skip(); // left after 10 s: not the owner's, or not to be told
			await h.listen(30 * MINUTE_MS);
			if (mode === "guest") await h.hub.setGuest(false);
			else dev.privateSession = false;
			await h.listen(5 * MINUTE_MS);
			h.fake.playSong(u.id, x); // the owner plays it from search, no context
			await h.listen(4 * MINUTE_MS);
			h.fake.pause();
			await h.listen(40 * MINUTE_MS);
			const row = h.sql.first<{ e: number; l: number | null }>(
				`SELECT early_skips AS e, last_skipped_at AS l FROM memory WHERE id = ?`,
				x,
			)!;
			expect([row.e, row.l]).toEqual([1, old]);
		});

	for (const listed of [false, true])
		it(`a private session${listed ? " Spotify lists after all" : ""}: what true-shuffle saw heard counts, once`, async () => {
			const h = await onboarded({ tracks: 100 });
			const sid = h.stationIds[0]!;
			const u = h.fake.user();
			u.listPrivatePlays = listed;
			expect((await h.hub.play(sid)).ok).toBe(true);
			const dev = u.devices.find((d) => d.id === u.player.deviceId)!;
			dev.privateSession = true;
			const heard = async (ms: number) => {
				const out = new Set<string>();
				for (let t = 0; t < ms; t += 5_000) {
					await h.listen(5_000);
					if (u.player.isPlaying && u.player.listenedMs >= 30_000) out.add(h.fake.current()!);
				}
				return out;
			};
			const first = await heard(60 * MINUTE_MS);
			h.fake.pause();
			await h.listen(2 * 60 * MINUTE_MS);
			dev.privateSession = false;
			expect((await h.hub.play(sid)).ok).toBe(true);
			const second = await heard(60 * MINUTE_MS);
			h.fake.pause();
			await h.listen(40 * MINUTE_MS);
			expect([...second].filter((id) => first.has(id))).toEqual([]);
			const counted = h.sql
				.all<{ track_id: string }>(`SELECT track_id FROM plays`)
				.map((r) => r.track_id);
			expect(counted.length).toBe(new Set(counted).size); // none twice
			expect([...first].filter((id) => !counted.includes(id))).toEqual([]);
			expect(falseSkips(h)).toBe(0);
		});
});

describe("the seventeenth review's cases", () => {
	type Hidden = {
		bookEarlySkip: (
			st: unknown,
			id: string,
			rules: unknown,
			at: number,
			seen: boolean,
			from?: number,
		) => boolean;
		stationRow: (id: number) => unknown;
		rulesOf: (st: unknown) => unknown;
		recordPlays: (items: unknown[], s: unknown) => unknown;
		syncState: () => unknown;
	};

	async function privately(h: H) {
		const u = h.fake.user();
		const dev = u.devices.find((d) => d.id === u.player.deviceId) ?? u.devices[0]!;
		dev.privateSession = true;
		return dev;
	}

	it("a private session in a playlist of one's own: every song heard is counted", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = h.fake.user();
		const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
		h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 0, u.devices[0]!.id, false);
		await privately(h);
		const heard = new Set<string>();
		for (let t = 0; t < 60 * MINUTE_MS; t += 5_000) {
			await h.listen(5_000);
			if (u.player.isPlaying && u.player.listenedMs >= 30_000) heard.add(h.fake.current()!);
		}
		const last = h.fake.current();
		h.fake.pause();
		await h.listen(30 * MINUTE_MS);
		const counted = new Set(
			h.sql.all<{ track_id: string }>(`SELECT track_id FROM plays`).map((r) => r.track_id),
		);
		expect([...heard].filter((id) => id !== last && !counted.has(id))).toEqual([]);
	});

	it("a private session in a playlist of one's own, paused and resumed: what plays after counts", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = h.fake.user();
		const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
		h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 0, u.devices[0]!.id, false);
		await privately(h);
		await h.listen(5 * MINUTE_MS);
		h.fake.pause();
		await h.listen(3 * MINUTE_MS);
		u.player.isPlaying = true;
		const heard = new Set<string>();
		for (let t = 0; t < 12 * MINUTE_MS; t += 5_000) {
			await h.listen(5_000);
			if (u.player.listenedMs >= 30_000) heard.add(h.fake.current()!);
			if (u.player.listenedMs >= 45_000) h.fake.skip(); // leaves each song after 45 s
		}
		const last = h.fake.current();
		h.fake.pause();
		await h.listen(30 * MINUTE_MS);
		const counted = new Set(
			h.sql.all<{ track_id: string }>(`SELECT track_id FROM plays`).map((r) => r.track_id),
		);
		expect(heard.size).toBeGreaterThan(10);
		expect([...heard].filter((id) => id !== last && !counted.has(id))).toEqual([]);
	});

	it("a private session: a song left before 30 s is not counted, even after a pause", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await privately(h);
		await h.listen(5 * MINUTE_MS);
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
		const x = h.fake.current()!;
		await h.listen(10_000);
		h.fake.pause();
		await h.listen(70_000);
		h.fake.user().player.isPlaying = true;
		await h.listen(5_000);
		h.fake.skip(); // heard 15 s, over 85 s
		await h.listen(5 * MINUTE_MS);
		h.fake.pause();
		await h.listen(30 * MINUTE_MS);
		expect(h.sql.first(`SELECT 1 FROM plays WHERE track_id = ?`, x)).toBeNull();
	});

	it("a private session that ends while a song heard past 30 s is paused: it still counts", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		const dev = await privately(h);
		await h.listen(5 * MINUTE_MS);
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
		const x = h.fake.current()!;
		await h.listen(100_000);
		h.fake.pause();
		await h.listen(2 * MINUTE_MS);
		dev.privateSession = false;
		await h.listen(20 * MINUTE_MS);
		h.fake.user().player.isPlaying = true;
		await h.listen(5_000);
		h.fake.skip();
		await h.listen(5 * MINUTE_MS);
		h.fake.pause();
		await h.listen(30 * MINUTE_MS);
		expect(h.sql.first(`SELECT 1 FROM plays WHERE track_id = ?`, x)).not.toBeNull();
	});

	it("a play arriving late takes back the skip it proves wrong, not the latest one", async () => {
		const h = await onboarded({ tracks: 300 });
		const hub = h.hub as unknown as Hidden;
		const a = h.stationIds[0]!;
		const all = h.allId;
		await h.hub.updateStation(a, { rules: { skipPolicy: "ban" } });
		await h.hub.updateStation(all, { rules: { skipPolicy: "ban" } });
		const x = stationDeck(h, a).pl.items[3]!;
		const t1 = h.clock.t;
		const t2 = t1 + 15 * MINUTE_MS;
		const book = (st: number, at: number) =>
			hub.bookEarlySkip(
				hub.stationRow(st),
				x,
				hub.rulesOf(hub.stationRow(st)),
				at,
				true,
				at - 200_000,
			);
		expect(book(a, t1)).toBe(true); // wrongly: its play was late
		expect(book(all, t2)).toBe(true); // really
		const track = h.fake.tracks.get(x)!;
		hub.recordPlays(
			[
				{
					track: {
						id: x,
						name: track.name,
						duration_ms: track.durationMs,
						artists: [],
						album: { name: "", images: [] },
					},
					played_at: new Date(t1 - 10_000).toISOString(),
					context: null,
				},
			],
			hub.syncState(),
		);
		const row = h.sql.first<{ e: number; l: number | null }>(
			`SELECT early_skips AS e, last_skipped_at AS l FROM memory WHERE id = ?`,
			x,
		)!;
		const bans = h.sql.all<{ station_id: number }>(
			`SELECT station_id FROM bans WHERE track_id = ?`,
			x,
		);
		expect([row.e, row.l, bans.map((b) => b.station_id)]).toEqual([1, t2, [all]]);
	});
});

describe("the eighteenth review's cases", () => {
	async function ownPlaylist(h: H) {
		const u = h.fake.user();
		const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
		h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 0, u.devices[0]!.id, false);
		return u;
	}
	async function heardFor(h: H, ms: number, leaveAt?: number) {
		const u = h.fake.user();
		const out = new Set<string>();
		for (let t = 0; t < ms; t += 5_000) {
			await h.listen(5_000);
			if (u.player.isPlaying && u.player.listenedMs >= 30_000) out.add(h.fake.current()!);
			if (leaveAt && u.player.listenedMs >= leaveAt) h.fake.skip();
		}
		return out;
	}
	const counted = (h: H) =>
		new Set(h.sql.all<{ track_id: string }>(`SELECT track_id FROM plays`).map((r) => r.track_id));

	it("a moment without a player does not end a private session", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = await ownPlaylist(h);
		u.devices[0]!.privateSession = true;
		await h.listen(5 * MINUTE_MS);
		const dev = u.player.deviceId;
		u.player.deviceId = null; // Spotify answers 204 for a moment
		await h.listen(35_000);
		u.player.deviceId = dev;
		const heard = await heardFor(h, 30 * MINUTE_MS, 50_000);
		const last = h.fake.current();
		h.fake.pause();
		await h.listen(30 * MINUTE_MS);
		const c = counted(h);
		expect([...heard].filter((id) => id !== last && !c.has(id))).toEqual([]);
	});

	it("a private session begun hours after the last one is seen within minutes", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = await ownPlaylist(h);
		u.devices[0]!.privateSession = true;
		await h.listen(10 * MINUTE_MS);
		h.fake.pause();
		await h.listen(8 * 60 * MINUTE_MS); // quiet
		await ownPlaylist(h); // started again directly in Spotify, still private
		const heard = await heardFor(h, 40 * MINUTE_MS, 50_000);
		const last = h.fake.current();
		h.fake.pause();
		await h.listen(30 * MINUTE_MS);
		const c = counted(h);
		// At most what played before the first look, 2 minutes at most.
		expect([...heard].filter((id) => id !== last && !c.has(id)).length).toBeLessThanOrEqual(2);
	});

	for (const priv of [false, true])
		it(`a song paused after a minute${priv ? " in a private session" : ""} does not come back when the station starts again`, async () => {
			const h = await onboarded({ tracks: 60 });
			const sid = h.stationIds[0]!;
			const u = h.fake.user();
			expect((await h.hub.play(sid)).ok).toBe(true);
			if (priv) u.devices.find((d) => d.id === u.player.deviceId)!.privateSession = true;
			await h.listen(10 * MINUTE_MS);
			const c0 = h.fake.current();
			while (h.fake.current() === c0) await h.listen(1_000);
			const x = h.fake.current()!;
			await h.listen(60_000);
			h.fake.pause();
			await h.listen(2 * 60 * MINUTE_MS);
			expect((await h.hub.play(sid)).ok).toBe(true);
			expect(stationDeck(h, sid).pl.items).not.toContain(x);
			let again = false;
			for (let t = 0; t < 120 * MINUTE_MS; t += 5_000) {
				await h.listen(5_000);
				if (h.fake.current() === x && u.player.listenedMs >= 30_000) again = true;
			}
			expect(again).toBe(false);
		});

	for (const listed of [false, true])
		it(`a private play paused for ten minutes counts once${listed ? " (Spotify lists it)" : ""}`, async () => {
			const h = await onboarded({ tracks: 300, playlists: [150, 150] });
			const u = await ownPlaylist(h);
			u.listPrivatePlays = listed;
			u.devices[0]!.privateSession = true;
			await h.listen(3 * MINUTE_MS);
			const c0 = h.fake.current();
			while (h.fake.current() === c0) await h.listen(1_000);
			const x = h.fake.current()!;
			await h.listen(60_000);
			h.fake.pause();
			await h.listen(10 * MINUTE_MS);
			u.player.isPlaying = true;
			while (h.fake.current() === x) await h.listen(1_000);
			await h.listen(5 * MINUTE_MS);
			h.fake.pause();
			await h.listen(40 * MINUTE_MS);
			expect(h.sql.all(`SELECT 1 FROM plays WHERE track_id = ?`, x).length).toBe(1);
		});

	it("a private session: a song seeked far and left after 20 s is not counted", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = await ownPlaylist(h);
		u.devices[0]!.privateSession = true;
		await h.listen(3 * MINUTE_MS);
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
		const x = h.fake.current()!;
		await h.listen(3_000);
		u.player.progressMs = 90_000; // seeks to 1:30
		await h.listen(5_000);
		(h.hub as unknown as { kvSet: (k: string, v: unknown) => void }).kvSet("player_stale", 1);
		await h.hub.state({ live: true }); // the app looks at 1:35
		await h.listen(15_000);
		h.fake.skip();
		await h.listen(5 * MINUTE_MS);
		h.fake.pause();
		await h.listen(30 * MINUTE_MS);
		expect(h.sql.first(`SELECT 1 FROM plays WHERE track_id = ?`, x)).toBeNull();
	});
});

describe("the nineteenth review's cases", () => {
	/** Songs that left the player after 30 s or more from now on. */
	function heardFrom(h: H) {
		const heard = new Set<string>();
		const f = h.fake as unknown as { moveNext: (u: unknown, at: number) => void };
		const orig = f.moveNext.bind(h.fake);
		f.moveNext = (user: unknown, at: number) => {
			const cur = h.fake.current();
			if (cur && h.fake.user().player.listenedMs >= 30_000) heard.add(cur);
			orig(user, at);
		};
		return heard;
	}
	const early = (h: H, id: string) =>
		h.sql.first<{ n: number }>(`SELECT early_skips AS n FROM memory WHERE id = ?`, id)?.n ?? 0;
	const bans = (h: H, id: string) =>
		h.sql.first<{ n: number }>(`SELECT COUNT(*) AS n FROM bans WHERE track_id = ?`, id)!.n;

	it("a station tapped again in the app: the song shown is not replayed, and never booked as a skip", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		await h.hub.updateStation(sid, { rules: { skipPolicy: "ban" } });
		expect((await h.hub.play(sid)).ok).toBe(true);
		const x = h.fake.current()!;
		await h.listen(60_000);
		expect((await h.hub.play(sid)).ok).toBe(true); // tapped again: starts over
		expect(stationDeck(h, sid).pl.items).not.toContain(x);
		const heard = heardFrom(h);
		await h.listen(40 * MINUTE_MS);
		h.fake.pause();
		await h.listen(40 * MINUTE_MS);
		expect(heard.has(x)).toBe(false);
		expect([early(h, x), bans(h, x)]).toEqual([0, 0]);
	});

	it("a start that fails leaves the song playing on untouched", async () => {
		const h = await onboarded({ tracks: 300 });
		const [a, b] = h.stationIds as [number, number];
		await h.hub.updateStation(a, { rules: { skipPolicy: "ban" } });
		const u = h.fake.user();
		u.devices[0]!.restricted = true; // a car: plays, takes no commands
		h.fake.startContext(
			u.id,
			`spotify:playlist:${stationDeck(h, a).pl.id}`,
			0,
			u.devices[0]!.id,
			false,
		);
		await h.listen(10 * MINUTE_MS);
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
		const x = h.fake.current()!;
		await h.listen(60_000);
		expect((await h.hub.play(b)).ok).toBe(false);
		while (h.fake.current() === x) await h.listen(1_000); // heard to its end
		await h.listen(30 * MINUTE_MS);
		h.fake.pause();
		await h.listen(40 * MINUTE_MS);
		expect([early(h, x), bans(h, x)]).toEqual([0, 0]);
		expect(h.sql.all(`SELECT 1 FROM plays WHERE track_id = ?`, x).length).toBe(1);
	});

	it("the guest's paused song stays out of memory when the owner starts a station later", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = h.fake.user();
		await h.hub.setGuest(true, 6);
		const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
		h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 3, u.devices[0]!.id, false);
		await h.listen(3 * MINUTE_MS);
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
		const x = h.fake.current()!;
		await h.listen(60_000);
		h.fake.pause();
		await h.hub.setGuest(false);
		await h.listen(10 * 60 * MINUTE_MS);
		expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
		await h.listen(10 * MINUTE_MS);
		expect(h.sql.all(`SELECT 1 FROM plays WHERE track_id = ? AND ignored = 0`, x).length).toBe(0);
	});

	for (const pos of [0, 25])
		it(`a song tapped at place ${pos + 1} in Spotify, then the station started from the app: it does not come back`, async () => {
			const h = await onboarded({ tracks: 300 });
			const sid = h.stationIds[0]!;
			const u = h.fake.user();
			expect((await h.hub.play(sid)).ok).toBe(true);
			h.fake.pause();
			await h.listen(2 * MINUTE_MS);
			const pl = stationDeck(h, sid).pl;
			h.fake.startContext(u.id, `spotify:playlist:${pl.id}`, pos, u.devices[0]!.id, false);
			const x = h.fake.current()!;
			await h.listen(60_000);
			expect((await h.hub.play(sid)).ok).toBe(true);
			const heard = heardFrom(h);
			await h.listen(4 * 60 * MINUTE_MS);
			expect(heard.has(x)).toBe(false);
		});

	it("a private song paused for hours and heard to its end is stamped at its end", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = h.fake.user();
		const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
		h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 0, u.devices[0]!.id, false);
		u.devices[0]!.privateSession = true;
		await h.listen(3 * MINUTE_MS);
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
		const x = h.fake.current()!;
		await h.listen(40_000);
		h.fake.pause();
		await h.listen(3 * 60 * MINUTE_MS);
		u.player.isPlaying = true;
		while (h.fake.current() === x) await h.listen(1_000);
		const end = h.clock.t;
		await h.listen(5 * MINUTE_MS);
		const row = h.sql.first<{ at: number }>(
			`SELECT played_at AS at FROM plays WHERE track_id = ?`,
			x,
		)!;
		expect(Math.abs(row.at - end)).toBeLessThan(2 * MINUTE_MS);
	});

	it("a private session whose player vanishes ends after six hours: no warning, no fast looks after a week", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = h.fake.user();
		const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
		h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 0, u.devices[0]!.id, false);
		u.devices[0]!.privateSession = true;
		await h.listen(10 * MINUTE_MS);
		h.fake.pause();
		u.player.deviceId = null; // Spotify closed: no player, never seen to end
		await h.listen(7 * 60 * MINUTE_MS);
		expect((await h.hub.state()).warnings.map((w) => w.code)).not.toContain("private_session");
		await h.listen(8 * 24 * 60 * MINUTE_MS);
		const n0 = h.fake.calls.length;
		await h.listen(24 * 60 * MINUTE_MS);
		const looks = h.fake.calls.slice(n0).filter((c) => c === "GET /v1/me/player").length;
		expect(looks).toBeLessThan(100);
	});
});

describe("the twentieth review's cases", () => {
	function heardFrom(h: H) {
		const heard = new Set<string>();
		const f = h.fake as unknown as { moveNext: (u: unknown, at: number) => void };
		const orig = f.moveNext.bind(h.fake);
		f.moveNext = (user: unknown, at: number) => {
			const cur = h.fake.current();
			if (cur && h.fake.user().player.listenedMs >= 30_000) heard.add(cur);
			orig(user, at);
		};
		return heard;
	}
	const rows = (h: H, id: string, ignored = 0) =>
		h.sql.all(`SELECT 1 FROM plays WHERE track_id = ? AND ignored = ?`, id, ignored).length;

	for (const listed of [false, true])
		it(`a song a start from the app replaced counts once and stays away${listed ? " (Spotify lists it)" : ""}`, async () => {
			const h = await onboarded({ tracks: 300 });
			const sid = h.stationIds[0]!;
			h.fake.user().listReplaced = listed;
			expect((await h.hub.play(sid)).ok).toBe(true);
			await h.listen(10 * MINUTE_MS);
			const c0 = h.fake.current();
			while (h.fake.current() === c0) await h.listen(1_000);
			const x = h.fake.current()!;
			await h.listen(60_000);
			expect((await h.hub.play(sid)).ok).toBe(true); // tapped again
			const heard = heardFrom(h);
			await h.listen(10 * 60 * MINUTE_MS);
			expect(rows(h, x)).toBe(1);
			expect(heard.has(x)).toBe(false);
		});

	for (const how of ["hand", "timer"] as const)
		it(`the guest's paused song stays the guest's, also when Spotify lists it at the owner's start (${how})`, async () => {
			const h = await onboarded({ tracks: 300, playlists: [150, 150] });
			const u = h.fake.user();
			u.listReplaced = true;
			await h.hub.setGuest(true, 1);
			const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
			h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 3, u.devices[0]!.id, false);
			await h.listen(3 * MINUTE_MS);
			const c0 = h.fake.current();
			while (h.fake.current() === c0) await h.listen(1_000);
			const x = h.fake.current()!;
			await h.listen(60_000);
			h.fake.pause();
			if (how === "hand") await h.hub.setGuest(false);
			await h.listen(90 * MINUTE_MS);
			expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
			await h.listen(40 * MINUTE_MS);
			expect(rows(h, x)).toBe(0);
		});

	it("the guest's paused song, resumed by the owner after the guest time, counts", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = h.fake.user();
		await h.hub.setGuest(true, 1);
		const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
		h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 3, u.devices[0]!.id, false);
		await h.listen(3 * MINUTE_MS);
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
		const x = h.fake.current()!;
		await h.listen(20_000);
		h.fake.pause();
		await h.hub.setGuest(false);
		await h.listen(30 * MINUTE_MS);
		u.player.isPlaying = true; // the owner plays it on
		while (h.fake.current() === x) await h.listen(1_000);
		h.fake.pause();
		await h.listen(40 * MINUTE_MS);
		expect(rows(h, x)).toBe(1);
	});

	it("a private song paused with seconds left is stamped when it really ended", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = h.fake.user();
		const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
		h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 0, u.devices[0]!.id, false);
		u.devices[0]!.privateSession = true;
		await h.listen(3 * MINUTE_MS);
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
		const x = h.fake.current()!;
		const d = h.fake.tracks.get(x)!.durationMs;
		while (u.player.progressMs < d - 20_000) await h.listen(1_000);
		h.fake.pause();
		await h.listen(90 * MINUTE_MS);
		u.player.isPlaying = true;
		while (h.fake.current() === x) await h.listen(1_000);
		const end = h.clock.t;
		await h.listen(5 * MINUTE_MS);
		const row = h.sql.first<{ at: number }>(
			`SELECT played_at AS at FROM plays WHERE track_id = ?`,
			x,
		)!;
		expect(Math.abs(row.at - end)).toBeLessThan(2 * MINUTE_MS);
	});

	it("a private player left paused in sight ends after six hours", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = h.fake.user();
		const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
		h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 0, u.devices[0]!.id, false);
		u.devices[0]!.privateSession = true;
		await h.listen(10 * MINUTE_MS);
		h.fake.pause(); // and stays in sight, still private
		await h.listen(7 * 60 * MINUTE_MS);
		expect((await h.hub.state()).warnings.map((w) => w.code)).not.toContain("private_session");
		await h.listen(8 * 24 * 60 * MINUTE_MS);
		const n0 = h.fake.calls.length;
		await h.listen(24 * 60 * MINUTE_MS);
		const looks = h.fake.calls.slice(n0).filter((c) => c === "GET /v1/me/player").length;
		expect(looks).toBeLessThan(100);
	});
});

describe("the twenty-first review's cases", () => {
	const rows = (h: H, id: string, ignored = 0) =>
		h.sql.all(`SELECT 1 FROM plays WHERE track_id = ? AND ignored = ?`, id, ignored).length;
	async function nextSong(h: H) {
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
	}

	for (const how of ["hand", "timer"] as const)
		it(`only the one play across the end of guest time is the guest's (${how})`, async () => {
			const h = await onboarded({ tracks: 300, playlists: [150, 150] });
			const u = h.fake.user();
			const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
			await h.hub.setGuest(true, 1);
			h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 3, u.devices[0]!.id, false);
			if (how === "hand") {
				await h.listen(20 * MINUTE_MS);
				await h.hub.setGuest(false);
			} else while ((await h.hub.state()).guest.active) await h.listen(5_000);
			const x = h.fake.current()!;
			await h.listen(3_000);
			if (h.fake.current() === x) h.fake.skip(); // the owner moves on
			await h.listen(3 * 60 * MINUTE_MS);
			h.fake.pause();
			await h.listen(60 * MINUTE_MS);
			// X comes again the next day: the owner hears it in full
			h.fake.startContext(
				u.id,
				`spotify:playlist:${own.id}`,
				own.items.indexOf(x),
				u.devices[0]!.id,
				false,
			);
			await nextSong(h);
			h.fake.pause();
			await h.listen(60 * MINUTE_MS);
			expect(rows(h, x, 0)).toBe(1);
		});

	for (const listed of [false, true])
		it(`two starts within minutes: both replaced songs count once${listed ? " (Spotify lists them)" : ""}`, async () => {
			const h = await onboarded({ tracks: 300, playlists: [150, 150] });
			const [a, b] = h.stationIds as [number, number];
			h.fake.user().listReplaced = listed;
			expect((await h.hub.play(a)).ok).toBe(true);
			await h.listen(10 * MINUTE_MS);
			await nextSong(h);
			await h.listen(60_000);
			const s1 = h.fake.current()!;
			expect((await h.hub.play(b)).ok).toBe(true);
			await h.listen(3 * MINUTE_MS);
			const s2 = h.fake.current()!;
			expect((await h.hub.play(a)).ok).toBe(true);
			await h.listen(2 * 60 * MINUTE_MS);
			h.fake.pause();
			await h.listen(60 * MINUTE_MS);
			expect(rows(h, s1)).toBe(1);
			expect(rows(h, s2)).toBe(1);
		});

	for (const paused of [false, true])
		it(`once Spotify is known to list replaced songs, a song sought past 30 s is not counted${paused ? " (paused)" : ""}`, async () => {
			const h = await onboarded({ tracks: 300, playlists: [150, 150] });
			const u = h.fake.user();
			u.listReplaced = true;
			// A start replaces a song heard a minute: Spotify lists it.
			expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
			await h.listen(10 * MINUTE_MS);
			await nextSong(h);
			await h.listen(60_000);
			expect((await h.hub.play(h.stationIds[1]!)).ok).toBe(true);
			await h.listen(30 * MINUTE_MS);
			h.fake.pause();
			await h.listen(60 * MINUTE_MS);
			expect(h.sql.first(`SELECT 1 FROM kv WHERE k = 'replaced_listed'`)).not.toBeNull();
			const own = [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
			h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 5, u.devices[0]!.id, false);
			await h.listen(5_000);
			const x = h.fake.current()!;
			u.player.progressMs = 60_000; // a seek: nothing more was heard
			await h.listen(4_000);
			if (paused) h.fake.pause();
			await h.listen(3_000);
			expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
			await h.listen(60 * MINUTE_MS);
			h.fake.pause();
			await h.listen(60 * MINUTE_MS);
			expect(rows(h, x)).toBe(0);
		});

	it("guest time and the two days after it write the guest record only when it changes", async () => {
		const h = await onboarded({ tracks: 300 });
		const hub = h.hub as unknown as { kvSet: (k: string, v: unknown) => void };
		const orig = hub.kvSet.bind(hub);
		let writes = 0;
		hub.kvSet = (k: string, v: unknown) => {
			if (k === "guest") writes++;
			orig(k, v);
		};
		await h.hub.setGuest(true, 2);
		expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
		await h.listen(3 * 60 * MINUTE_MS);
		h.fake.pause();
		await h.listen(48 * 60 * MINUTE_MS);
		expect(writes).toBeLessThan(10);
	});
});

describe("the twenty-second review's cases", () => {
	const rows = (h: H, id: string) =>
		h.sql
			.all<{ ignored: number }>(`SELECT ignored FROM plays WHERE track_id = ?`, id)
			.map((r) => r.ignored);
	const memPlays = (h: H, id: string) =>
		h.sql.first<{ plays: number }>(`SELECT plays FROM memory WHERE id = ?`, id)?.plays ?? 0;
	const own = (h: H) => [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!;
	async function nextSong(h: H) {
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
	}

	for (const listed of [false, true])
		for (const to of ["the same playlist", "another playlist"] as const)
			it(`a song heard a minute and replaced by a start in Spotify (${to}) counts once${listed ? " (Spotify lists it)" : ""}`, async () => {
				const h = await onboarded({ tracks: 300, playlists: [150, 150] });
				const u = h.fake.user();
				u.listReplaced = listed;
				const pl = own(h);
				h.fake.startContext(u.id, `spotify:playlist:${pl.id}`, 20, u.devices[0]!.id, false);
				await h.listen(3_000);
				await h.hub.state({ live: true }); // the app is open
				const x = h.fake.current()!;
				await h.listen(60_000);
				await h.hub.state({ live: true });
				const other = [...h.fake.playlists.values()].find((p) => p.name === "Playlist 1")!;
				const next = to === "the same playlist" ? pl : other;
				h.fake.startContext(u.id, `spotify:playlist:${next.id}`, 80, u.devices[0]!.id, false);
				await h.listen(60 * MINUTE_MS);
				h.fake.pause();
				await h.listen(60 * MINUTE_MS);
				expect(rows(h, x)).toEqual([0]);
				expect(memPlays(h, x)).toBe(1);
			});

	it("the guest's play across the end leaves the owner's earlier skip and ban", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		await h.hub.updateStation(sid, { rules: { skipPolicy: "ban" } });
		const u = h.fake.user();
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(8 * MINUTE_MS);
		await nextSong(h);
		const x = h.fake.current()!;
		await h.listen(10_000);
		h.fake.skip(); // the owner skips X after 10 s
		await h.listen(4 * MINUTE_MS);
		await h.hub.setGuest(true, 6);
		const pl = [...h.fake.playlists.values()].find(
			(p) => p.items.includes(x) && p.name !== "Playlist 1",
		)!;
		h.fake.startContext(
			u.id,
			`spotify:playlist:${pl.id}`,
			pl.items.indexOf(x),
			u.devices[0]!.id,
			false,
		);
		await h.listen(60_000);
		await h.hub.setGuest(false);
		await h.listen(5_000);
		h.fake.skip();
		await h.listen(60 * MINUTE_MS);
		h.fake.pause();
		await h.listen(60 * MINUTE_MS);
		expect(h.sql.first(`SELECT 1 FROM bans WHERE track_id = ?`, x)).not.toBeNull();
		expect(h.hub.memory(x).earlySkips).toBe(1);
	});

	for (const how of ["hand", "timer"] as const)
		it(`a seek after guest time does not hand the guest's play to the owner (${how})`, async () => {
			const h = await onboarded({ tracks: 300, playlists: [150, 150] });
			const u = h.fake.user();
			await h.hub.setGuest(true, 1);
			if (how === "timer") await h.listen(20_000);
			expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
			if (how === "hand") {
				await h.listen(20 * MINUTE_MS);
				await nextSong(h);
				await h.listen(90_000);
				await h.hub.setGuest(false);
			} else while ((await h.hub.state()).guest.active) await h.listen(1_000);
			const g = h.fake.current()!;
			await h.listen(8_000);
			h.fake.skip(); // the owner hears 8 s of it
			u.player.progressMs = 150_000; // and seeks the next song to 2:30
			await h.listen(30 * MINUTE_MS);
			h.fake.pause();
			await h.listen(60 * MINUTE_MS);
			expect(rows(h, g).every((i) => i === 1)).toBe(true);
			expect(memPlays(h, g)).toBe(0);
		});

	it("a second guest time closes the first one's last play", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = h.fake.user();
		const pl = own(h);
		await h.hub.setGuest(true, 1);
		h.fake.startContext(u.id, `spotify:playlist:${pl.id}`, 3, u.devices[0]!.id, false);
		await h.listen(3 * MINUTE_MS);
		await nextSong(h);
		const x = h.fake.current()!;
		await h.listen(20_000);
		h.fake.pause();
		await h.listen(70 * MINUTE_MS); // the timer ends, X stays paused
		await h.hub.setGuest(true, 1);
		h.fake.startContext(u.id, `spotify:playlist:${pl.id}`, 40, u.devices[0]!.id, false);
		await h.listen(70 * MINUTE_MS);
		h.fake.pause();
		await h.listen(10 * 60 * MINUTE_MS);
		h.fake.playSong(u.id, x); // the next morning the owner plays X in full
		await nextSong(h);
		h.fake.pause();
		await h.listen(60 * MINUTE_MS);
		expect(rows(h, x)).toContain(0);
		expect(memPlays(h, x)).toBe(1);
	});

	it("a late listing of the song's play before does not make Spotify's word decide", async () => {
		const h = await onboarded({ tracks: 300, playlists: [150, 150] });
		const u = h.fake.user();
		const pl = own(h);
		const fake = h.fake as unknown as { handle: (r: Request) => Promise<Response> };
		const orig = fake.handle.bind(h.fake);
		fake.handle = async (req: Request) => {
			if (!new URL(req.url).pathname.endsWith("/me/player/recently-played")) return orig(req);
			// Spotify lists plays three minutes late.
			const keep = u.recent;
			u.recent = keep.filter((e) => e.playedAt <= h.clock.t - 3 * MINUTE_MS);
			try {
				return await orig(req);
			} finally {
				u.recent = keep;
			}
		};
		const x = pl.items[10]!;
		h.fake.playSong(u.id, x);
		await nextSong(h);
		h.fake.playSong(u.id, x); // and at once again
		await h.listen(60_000);
		expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
		await h.listen(30 * MINUTE_MS);
		expect(h.sql.first(`SELECT 1 FROM kv WHERE k = 'replaced_listed'`)).toBeNull();
		h.fake.pause();
		await h.listen(2 * 60 * MINUTE_MS);
		h.fake.startContext(u.id, `spotify:playlist:${pl.id}`, 60, u.devices[0]!.id, false);
		await h.listen(3_000);
		const y = h.fake.current()!;
		await h.listen(2 * MINUTE_MS);
		expect((await h.hub.play(h.stationIds[1]!)).ok).toBe(true);
		await h.listen(60 * MINUTE_MS);
		h.fake.pause();
		await h.listen(60 * MINUTE_MS);
		expect(rows(h, y)).toEqual([0]);
		// (Seen by no look between them, the two plays of X are one to the looks.)
		expect(rows(h, x)).toContain(0);
	});

	for (const how of ["hand", "timer"] as const)
		it(`outside a station, the play across the end heard to its end counts for the owner (${how})`, async () => {
			const h = await onboarded({ tracks: 300, playlists: [150, 150] });
			const u = h.fake.user();
			const pl = own(h);
			await h.hub.setGuest(true, 1);
			h.fake.startContext(u.id, `spotify:playlist:${pl.id}`, 3, u.devices[0]!.id, false);
			if (how === "hand") {
				await h.listen(20 * MINUTE_MS);
				await nextSong(h);
				await h.listen(20_000);
				await h.hub.setGuest(false);
			} else {
				await h.listen(58 * MINUTE_MS);
				while ((await h.hub.state()).guest.active) await h.listen(1_000);
			}
			const x = h.fake.current()!;
			const left = h.fake.tracks.get(x)!.durationMs - u.player.progressMs;
			await nextSong(h);
			await h.listen(20 * MINUTE_MS);
			h.fake.pause();
			await h.listen(60 * MINUTE_MS);
			if (left >= 40_000) expect(rows(h, x)).toContain(0);
			else expect(memPlays(h, x)).toBe(0);
		});
});

describe("the twenty-third review's cases", () => {
	const memPlays = (h: H, id: string) =>
		h.sql.first<{ plays: number }>(`SELECT plays FROM memory WHERE id = ?`, id)?.plays ?? 0;
	const lists = (h: H) => ({
		own: [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 2")!,
		other: [...h.fake.playlists.values()].find((pl) => pl.name === "Playlist 1")!,
	});
	async function nextSong(h: H) {
		const c0 = h.fake.current();
		while (h.fake.current() === c0) await h.listen(1_000);
	}

	for (const how of ["app", "spotify"] as const)
		it(`the guest's song paused out of sight and left by the owner the next day stays the guest's (${how})`, async () => {
			const h = await onboarded({ tracks: 300, playlists: [150, 150] });
			const u = h.fake.user();
			const { own, other } = lists(h);
			await h.hub.setGuest(true, 1);
			const g0 = h.clock.t;
			h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 3, u.devices[0]!.id, false);
			await h.listen(20 * MINUTE_MS);
			await nextSong(h);
			const x = h.fake.current()!;
			await h.listen(45_000);
			await h.hub.state({ live: true }); // a look in guest time sees X playing
			h.fake.pause();
			const dev = u.player.deviceId;
			u.player.deviceId = null; // the device sleeps: no player in sight
			await h.listen(g0 + 60 * MINUTE_MS - h.clock.t + 12 * 60 * MINUTE_MS);
			u.player.deviceId = dev;
			u.player.isPlaying = true; // the owner plays on for a few seconds
			await h.listen(4_000);
			await h.hub.state({ live: true });
			await h.listen(6_000);
			if (how === "app") expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
			else h.fake.startContext(u.id, `spotify:playlist:${other.id}`, 40, u.devices[0]!.id, false);
			await h.listen(60 * MINUTE_MS);
			h.fake.pause();
			await h.listen(60 * MINUTE_MS);
			expect(memPlays(h, x)).toBe(0);
		});

	for (const how of ["app", "spotify"] as const)
		it(`a song seen playing a minute, paused, then out of sight counts when a start replaces it (${how})`, async () => {
			const h = await onboarded({ tracks: 300, playlists: [150, 150] });
			const u = h.fake.user();
			const { own, other } = lists(h);
			h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 7, u.devices[0]!.id, false);
			await h.listen(3_000);
			await h.hub.state({ live: true });
			const a = h.fake.current()!;
			await h.listen(60_000);
			await h.hub.state({ live: true }); // looks saw A play a minute
			h.fake.pause();
			const dev = u.player.deviceId;
			u.player.deviceId = null;
			await h.listen(90 * MINUTE_MS);
			if (how === "app") expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
			else {
				u.player.deviceId = dev;
				h.fake.startContext(u.id, `spotify:playlist:${other.id}`, 40, u.devices[0]!.id, false);
				await h.listen(3_000);
				await h.hub.state({ live: true });
			}
			await h.listen(60 * MINUTE_MS);
			h.fake.pause();
			await h.listen(60 * MINUTE_MS);
			expect(memPlays(h, a)).toBe(1);
		});

	for (const how of ["start", "resume-skip"] as const)
		it(`a guest's song no look saw, paused across the end, stays the guest's (${how})`, async () => {
			const h = await onboarded({ tracks: 300, playlists: [150, 150] });
			const u = h.fake.user();
			u.listReplaced = true;
			const { own, other } = lists(h);
			await h.hub.setGuest(true, 1);
			const g0 = h.clock.t;
			h.fake.startContext(u.id, `spotify:playlist:${own.id}`, 3, u.devices[0]!.id, false);
			await h.listen(30 * MINUTE_MS);
			await nextSong(h);
			const x = h.fake.current()!;
			await h.listen(90_000);
			h.fake.pause();
			const dev = u.player.deviceId;
			u.player.deviceId = null;
			await h.listen(g0 + 60 * MINUTE_MS - h.clock.t + 3 * 60 * MINUTE_MS);
			u.player.deviceId = dev;
			if (how === "start")
				h.fake.startContext(u.id, `spotify:playlist:${other.id}`, 40, u.devices[0]!.id, false);
			else {
				u.player.isPlaying = true;
				await h.listen(10_000);
				h.fake.skip();
			}
			await h.listen(60 * MINUTE_MS);
			h.fake.pause();
			await h.listen(60 * MINUTE_MS);
			expect(memPlays(h, x)).toBe(0);
		});
});

describe("hearts set in Spotify", () => {
	it("a heart set in Spotify (CarPlay, a watch) makes a favourite within minutes", async () => {
		const h = await onboarded({ tracks: 300 });
		expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
		await h.listen(3 * MINUTE_MS);
		const x = h.fake.current()!;
		expect(h.hub.memory(x).liked).toBe(false);
		h.fake.user().liked.unshift(x); // the heart, newest first as Spotify lists them
		await h.listen(12 * MINUTE_MS);
		expect(h.hub.memory(x).liked).toBe(true);
		const log = h.sql.all<{ message: string }>(`SELECT message FROM events WHERE kind = 'liked'`);
		expect(log.length).toBe(1);
	});

	it("an old heart Spotify greys out is no new heart, not even after a full import", async () => {
		const fake = new FakeSpotify();
		const add = fake.addTracks.bind(fake);
		let x = "";
		fake.addTracks = ((n: number, o: never) => {
			const ts = add(n, o);
			ts[5]!.playable = false;
			x = ts[5]!.id;
			return ts;
		}) as typeof fake.addTracks;
		const h = await onboarded({ tracks: 300, liked: 10, fake });
		expect(h.hub.memory(x).liked).toBe(false);
		expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
		for (let day = 0; day < 4; day++) {
			await h.listen(3 * 60 * MINUTE_MS);
			h.fake.pause();
			await h.listen(21 * 60 * MINUTE_MS);
			expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
		}
		await h.listen(15 * MINUTE_MS);
		const log = h.sql.all<{ message: string }>(`SELECT message FROM events WHERE kind = 'liked'`);
		expect(log).toEqual([]);
		expect(h.hub.memory(x).liked).toBe(false);
	});

	it("a heart seen while the full import runs survives its end", async () => {
		const h = await onboarded({ tracks: 300, liked: 120 });
		expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
		await h.listen(3 * MINUTE_MS);
		const hub = h.hub as unknown as {
			kvGet: (k: string) => unknown;
			kvSet: (k: string, v: unknown) => void;
		};
		// A heart the peek saw after the import had read its first page (stamped
		// later than any start the import will have), and a heart from before.
		const hearts = new Set(h.fake.user().liked);
		const [x, y] = [...h.fake.tracks.keys()].filter((id) => !hearts.has(id)).slice(-2) as [
			string,
			string,
		];
		hub.kvSet("liked_recent", [
			{ id: y, at: h.clock.t - MINUTE_MS },
			{ id: x, at: h.clock.t + 60 * MINUTE_MS },
		]);
		const before = (hub.kvGet("liked_import") as { at: number }).at;
		const st = hub.kvGet("sync") as { lastLikedAt: number };
		hub.kvSet("sync", { ...st, lastLikedAt: 0 });
		await h.listen(20 * MINUTE_MS);
		expect((hub.kvGet("liked_import") as { at: number }).at).toBeGreaterThan(before);
		// The one the import could not have seen stays; the one it did see is its word.
		expect(h.hub.memory(x).liked).toBe(true);
		expect(h.hub.memory(y).liked).toBe(false);
	});
});
