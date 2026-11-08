/**
 * P4: the Kassette „TrueShuffle Likes“ and its private Spotify playlist.
 * Every thumb up, by any path, is one entry; taken back, it leaves; the
 * playlist is exactly the Likes, made once; a failed write is shown and can
 * be sent again.
 */

import { describe, expect, it, vi } from "vitest";
import { LIKES_NAME } from "../../src/worker/hub/hub";
import { SpotifyClient, SpotifyError } from "../../src/worker/spotify/client";
import { onboarded } from "./harness";

async function setup() {
	const h = await onboarded({ tracks: 60 });
	const ids = [...h.fake.tracks.keys()];
	const likesPlaylists = () =>
		[...h.fake.playlists.values()].filter((p) => p.name === LIKES_NAME && p.followedBy.has("mika"));
	return { h, ids, likesPlaylists };
}

describe("TrueShuffle Likes (P4)", () => {
	it("each thumb up is one entry in the Kassette and in exactly one private playlist", async () => {
		const { h, ids, likesPlaylists } = await setup();
		await h.hub.thumb(ids[3]!, 1);
		await h.hub.thumb(ids[7]!, 1);
		await h.hub.thumb(ids[3]!, 1); // again: still once
		await h.listen(60_000);
		await h.settle();
		const pls = likesPlaylists();
		expect(pls).toHaveLength(1);
		expect(pls[0]!.public).toBe(false);
		expect(pls[0]!.items).toEqual([ids[3], ids[7]]);
		const st = await h.hub.state();
		expect(st.likes).toMatchObject({ count: 2, sync: { pending: false, error: null, count: 2 } });
		const station = st.stations.find((s) => s.id === st.likes!.stationId);
		expect(station?.name).toBe(LIKES_NAME);
		expect(station?.sources).toEqual([{ type: "likes" }]);
	});

	it("a thumb taken back leaves; a second sync never duplicates", async () => {
		const { h, ids, likesPlaylists } = await setup();
		for (const i of [1, 2, 5]) await h.hub.thumb(ids[i]!, 1);
		await h.listen(60_000);
		await h.settle();
		await h.hub.thumb(ids[2]!, 0);
		await h.hub.thumb(ids[5]!, -1);
		await h.hub.thumb(ids[9]!, 1);
		await h.listen(60_000);
		await h.settle();
		await h.hub.retryLikesSync();
		await h.settle();
		expect(likesPlaylists()).toHaveLength(1);
		expect(likesPlaylists()[0]!.items).toEqual([ids[1], ids[9]]);
		expect((await h.hub.state()).likes?.count).toBe(2);
	});

	it("a like from Siri counts the same as one from Home", async () => {
		const { h, ids, likesPlaylists } = await setup();
		expect((await h.hub.play(h.allId)).ok).toBe(true);
		await h.listen(20_000);
		const kid = h.hub.newRemoteKey();
		const playing = h.fake.current()!;
		expect(await h.hub.remote(kid, "like")).toMatch(/ist jetzt Favorit\.$/);
		await h.listen(60_000);
		await h.settle();
		expect(likesPlaylists()[0]!.items).toContain(playing);
		expect(ids).toContain(playing);
	});

	it("a failed write is shown and can be sent again; the Kassette is there either way", async () => {
		const { h, ids, likesPlaylists } = await setup();
		await h.hub.thumb(ids[4]!, 1);
		h.fake.failWhen = (method, path) =>
			method === "POST" && path === "/me/playlists"
				? { status: 500, body: { error: { status: 500, message: "boom" } } }
				: null;
		await h.listen(60_000);
		await h.settle();
		let st = await h.hub.state();
		expect(st.likes?.sync.error).toBeTruthy();
		expect(st.likes?.sync.pending).toBe(true);
		expect(st.likes?.stationId).not.toBeNull();
		expect(likesPlaylists()).toHaveLength(0);
		h.fake.failWhen = null;
		await h.hub.retryLikesSync();
		await h.settle();
		st = await h.hub.state();
		expect(st.likes?.sync).toMatchObject({ error: null, pending: false, count: 1 });
		expect(likesPlaylists()).toHaveLength(1);
	});

	it("the Kassette plays the Likes, and only them", async () => {
		const { h, ids } = await setup();
		const liked = [ids[20]!, ids[21]!, ids[22]!];
		for (const id of liked) await h.hub.thumb(id, 1);
		await h.listen(60_000);
		await h.settle();
		const st = await h.hub.state();
		const sid = st.likes!.stationId!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(20_000);
		const now = h.fake.current();
		expect(liked).toContain(now);
		const view = await h.hub.state({ live: true });
		for (const e of view.session?.queue ?? []) expect(liked).toContain(e.track.id);
	});

	it("thumbs given before the update are taken over once, with Kassette and playlist (red-team M2)", async () => {
		const { h, ids, likesPlaylists } = await setup();
		await h.hub.thumb(ids[11]!, 1);
		await h.hub.thumb(ids[12]!, 1);
		await h.listen(60_000);
		await h.settle();
		// As if they were stored by 1.2.0: no Likes, no Kassette, no playlist yet.
		const st0 = await h.hub.state();
		await h.hub.deleteStation(st0.likes!.stationId!);
		for (const p of likesPlaylists()) h.fake.playlists.delete(p.id);
		h.sql.run(
			`DELETE FROM kv WHERE k IN ('likes', 'likes_station_made', 'likes_playlist', 'likes_sync')`,
		);
		h.restart();
		const st = await h.hub.state();
		expect(st.likes?.count).toBe(2);
		expect(st.likes?.stationId).not.toBeNull();
		await h.listen(60_000);
		await h.settle();
		expect(likesPlaylists()).toHaveLength(1);
		expect(new Set(likesPlaylists()[0]!.items)).toEqual(new Set([ids[11], ids[12]]));
	});

	it("a playlist Spotify refuses to change: one playlist, no new ones, the failure shown (red-team B1)", async () => {
		const { h, ids, likesPlaylists } = await setup();
		await h.hub.thumb(ids[2]!, 1);
		await h.listen(60_000);
		await h.settle();
		expect(likesPlaylists()).toHaveLength(1);
		h.fake.failWhen = (method, path) =>
			method === "PUT" && /^\/playlists\/[^/]+\/items$/.test(path)
				? { status: 403, body: { error: { status: 403, message: "Forbidden" } } }
				: null;
		await h.hub.thumb(ids[3]!, 1);
		await h.listen(10 * 60_000);
		await h.settle();
		expect(likesPlaylists()).toHaveLength(1);
		const st = await h.hub.state();
		expect(st.likes?.sync.error).toMatch(/nicht ändern/);
		expect(st.likes?.sync.pending).toBe(true);
		h.fake.failWhen = null;
		await h.hub.retryLikesSync();
		await h.settle();
		expect(likesPlaylists()).toHaveLength(1);
		expect(likesPlaylists()[0]!.items).toEqual([ids[2], ids[3]]);
	});

	it("a playlist that is really gone is made again once (red-team B1)", async () => {
		const { h, ids, likesPlaylists } = await setup();
		await h.hub.thumb(ids[2]!, 1);
		await h.listen(60_000);
		await h.settle();
		// Not right after making it (Spotify may not show a new playlist yet).
		await h.listen(11 * 60_000);
		h.fake.playlists.delete(likesPlaylists()[0]!.id);
		await h.hub.thumb(ids[4]!, 1);
		await h.listen(60_000);
		await h.settle();
		expect(likesPlaylists()).toHaveLength(1);
		expect(likesPlaylists()[0]!.items).toEqual([ids[2], ids[4]]);
	});

	it("4 500 likes: written over several steps, finished, exactly once each (red-team H1)", async () => {
		const h = await onboarded({ tracks: 4600 });
		const ids = [...h.fake.tracks.keys()].slice(0, 4500);
		for (const id of ids) await h.hub.thumb(id, 1);
		for (let i = 0; i < 40; i++) {
			await h.listen(60_000);
			await h.settle();
			if ((await h.hub.state()).likes?.sync.pending === false) break;
		}
		const pls = [...h.fake.playlists.values()].filter((p) => p.name === LIKES_NAME);
		expect(pls).toHaveLength(1);
		expect(pls[0]!.items).toHaveLength(4500);
		expect(new Set(pls[0]!.items).size).toBe(4500);
		expect((await h.hub.state()).likes?.sync).toMatchObject({ pending: false, count: 4500 });
	}, 300_000);
	describe("a write fails after others were confirmed: each Like stays exactly once (B9341-01)", () => {
		/** 1 700 Likes, so the write spans steps; the first step ends at 800. */
		async function many() {
			const h = await onboarded({ tracks: 1800 });
			const ids = [...h.fake.tracks.keys()].slice(0, 1700);
			h.sql.run(
				`INSERT INTO kv(k,v) VALUES('likes',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
				JSON.stringify({ v: 1, rev: 2, items: ids.map((id) => ({ id, at: h.clock.t })) }),
			);
			const playlist = () => [...h.fake.playlists.values()].find((p) => p.name === LIKES_NAME);
			const append = (method: string, path: string) => {
				const p = playlist();
				return p && method === "POST" && path === `/playlists/${p.id}/items` ? p : null;
			};
			const finish = async () => {
				for (let i = 0; i < 10; i++) {
					await h.listen(60_000);
					await h.settle();
				}
				return { items: playlist()!.items, sync: (await h.hub.state()).likes?.sync };
			};
			return { h, ids, playlist, append, finish };
		}

		for (const status of [500, 503, 429]) {
			it(`refused with ${status} after 100 were confirmed in the step: no Like twice`, async () => {
				const { h, ids, append, finish } = await many();
				let failed = 0;
				h.fake.failWhen = (m, path) => {
					if (failed || append(m, path)?.items.length !== 900) return null;
					failed++;
					return { status, headers: status === 429 ? { "retry-after": "60" } : undefined };
				};
				await h.hub.retryLikesSync();
				const { items, sync } = await finish();
				expect(failed).toBe(1);
				expect(items).toEqual(ids);
				expect(sync).toMatchObject({ pending: false, count: 1700, error: null });
			}, 120_000);
		}

		// A lost answer proves nothing about what arrived: written again from the
		// top (one replace, then the rest), never trusted by a count (PR36 review;
		// 1.3.1 asked the length and went on after it).
		it("written, but the answer is lost: started over with a replace, exactly the Likes", async () => {
			const { h, ids, append, finish } = await many();
			let lost = 0;
			h.fake.failWhen = (m, path) => {
				const p = append(m, path);
				if (lost || p?.items.length !== 900) return null;
				lost++;
				p.items.push(...ids.slice(900, 1000)); // arrived, but no answer came back
				return { status: 502 };
			};
			const calls = h.fake.calls.length;
			await h.hub.retryLikesSync();
			const { items, sync } = await finish();
			expect(lost).toBe(1);
			expect(items).toEqual(ids);
			expect(sync).toMatchObject({ pending: false, count: 1700, error: null });
			const after = h.fake.calls.slice(calls);
			const lostAt = after.findIndex(
				(c) => c.startsWith("POST /v1/playlists/") && c.includes("/items"),
			);
			expect(after.filter((c) => c.startsWith("PUT /v1/playlists/")).length).toBe(2);
			expect(after.some((c) => /^GET \/v1\/playlists\/[^/]+(\?|$)/.test(c))).toBe(false);
			expect(lostAt).toBeGreaterThanOrEqual(0);
		}, 120_000);

		for (const [name, change] of [
			[
				"one entry replaced (R131-LIKES)",
				(items: string[], ids: string[]) => {
					items[950] = ids[0]!;
				},
			],
			[
				"two entries swapped",
				(items: string[]) => {
					const x = items[910]!;
					items[910] = items[960]!;
					items[960] = x;
				},
			],
		] as const) {
			it(`lost answer plus a same-length change elsewhere (${name}): exactly the Likes, in order`, async () => {
				const { h, ids, append, finish } = await many();
				let lost = 0;
				h.fake.failWhen = (m, path) => {
					const p = append(m, path);
					if (lost || p?.items.length !== 900) return null;
					lost++;
					p.items.push(...ids.slice(900, 1000));
					change(p.items, ids);
					return { status: 502 };
				};
				await h.hub.retryLikesSync();
				const { items, sync } = await finish();
				expect(lost).toBe(1);
				expect(items).toEqual(ids);
				expect(sync).toMatchObject({ pending: false, count: 1700, error: null });
			}, 120_000);
		}

		it("a write that never gets an answer: a few starts from the top, then it stops and says so (PR36 re-review)", async () => {
			const { h, ids, playlist, append, finish } = await many();
			h.fake.failWhen = (m, path) => {
				const p = append(m, path);
				return p && p.items.length >= 1600 ? { status: 502 } : null;
			};
			const calls = h.fake.calls.length;
			await h.hub.retryLikesSync();
			for (let i = 0; i < 6 * 60; i++) await h.listen(60_000);
			await h.settle();
			const writes = h.fake.calls
				.slice(calls)
				.filter((c) => /^(PUT|POST) \/v1\/playlists\/[^/]+\/items/.test(c));
			// 1.3.2 before this fix: thousands of writes over 6 h, never ending.
			expect(writes.length).toBeLessThan(80);
			const sync = (await h.hub.state()).likes?.sync;
			expect(sync?.pending).toBe(true);
			expect(sync?.error).toMatch(/nicht bestätigt/);
			const quiet = h.fake.calls.length;
			await h.listen(60 * 60_000);
			expect(
				h.fake.calls.slice(quiet).filter((c) => /^(PUT|POST) \/v1\/playlists\//.test(c)),
			).toEqual([]);
			// Spotify answers again and the listener sends again: exactly the Likes.
			h.fake.failWhen = null;
			await h.hub.retryLikesSync();
			const { items, sync: after } = await finish();
			expect(items).toEqual(ids);
			expect(after).toMatchObject({ pending: false, count: 1700, error: null });
			expect(playlist()).toBeDefined();
		}, 300_000);

		it("a write that never arrived plus as many songs added by hand: exactly the Likes, in order", async () => {
			const { h, ids, append, finish } = await many();
			const others = [...h.fake.tracks.keys()].slice(1700, 1800);
			let lost = 0;
			h.fake.failWhen = (m, path) => {
				const p = append(m, path);
				if (lost || p?.items.length !== 900) return null;
				lost++;
				p.items.push(...others); // not ours: the same count, other songs
				return { status: 502 };
			};
			await h.hub.retryLikesSync();
			const { items } = await finish();
			expect(lost).toBe(1);
			expect(items).toEqual(ids);
		}, 120_000);

		it("lost answer and the playlist changed elsewhere meanwhile: written again from the top, exactly", async () => {
			const { h, ids, append, finish } = await many();
			let lost = 0;
			h.fake.failWhen = (m, path) => {
				const p = append(m, path);
				if (lost || p?.items.length !== 900) return null;
				lost++;
				p.items.push(...ids.slice(900, 1000), ids[0]!); // and someone added a song by hand
				return { status: 500 };
			};
			await h.hub.retryLikesSync();
			const { items, sync } = await finish();
			expect(items).toEqual(ids);
			expect(sync).toMatchObject({ pending: false, count: 1700 });
		}, 120_000);

		it("the invocation's budget runs out mid-step: the next goes on where Spotify confirmed", async () => {
			const { h, ids, playlist, finish } = await many();
			const add = SpotifyClient.prototype.addItems;
			let cut = 0;
			const spy = vi.spyOn(SpotifyClient.prototype, "addItems").mockImplementation(function (
				this: SpotifyClient,
				...args
			) {
				if (!cut && playlist()?.items.length === 900) {
					cut++;
					return Promise.reject(
						new SpotifyError("budget", "Anfragebudget dieses Aufrufs erschöpft"),
					);
				}
				return add.apply(this, args);
			});
			try {
				await h.hub.retryLikesSync();
				const { items } = await finish();
				expect(cut).toBe(1);
				expect(items).toEqual(ids);
			} finally {
				spy.mockRestore();
			}
		}, 120_000);

		it("lost answer, then the playlist is deleted in Spotify: made again once, exactly the Likes", async () => {
			const { h, ids, append, finish } = await many();
			let lost = 0;
			h.fake.failWhen = (m, path) => {
				const p = append(m, path);
				if (lost || p?.items.length !== 900) return null;
				lost++;
				p.items.push(...ids.slice(900, 1000));
				h.fake.playlists.delete(p.id); // gone before the next try
				// Made long ago: not the fresh one Spotify may not show yet (red-team B1).
				h.sql.run(
					`UPDATE kv SET v=? WHERE k='likes_playlist_made_at'`,
					JSON.stringify(h.clock.t - 60 * 60_000),
				);
				return { status: 502 };
			};
			await h.hub.retryLikesSync();
			const { items, sync } = await finish();
			const pls = [...h.fake.playlists.values()].filter((p) => p.name === LIKES_NAME);
			expect(lost).toBe(1);
			expect(pls).toHaveLength(1);
			expect(items).toEqual(ids);
			expect(sync).toMatchObject({ pending: false, count: 1700, error: null });
		}, 120_000);

		it("a Like changes before the failed write is sent again: the playlist is exactly the new Likes", async () => {
			const { h, ids, append, finish } = await many();
			let failed = 0;
			h.fake.failWhen = (m, path) => {
				if (failed || append(m, path)?.items.length !== 900) return null;
				failed++;
				return { status: 500 };
			};
			await h.hub.retryLikesSync();
			await h.listen(1_000);
			await h.settle();
			expect(failed).toBe(1);
			const extra = [...h.fake.tracks.keys()][1750]!;
			await h.hub.thumb(extra, 1);
			const { items, sync } = await finish();
			expect(items).toEqual([...ids, extra]);
			expect(sync).toMatchObject({ pending: false, count: 1701 });
		}, 120_000);
	});
});
