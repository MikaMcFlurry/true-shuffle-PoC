/**
 * P4: the Kassette „TrueShuffle Likes“ and its private Spotify playlist.
 * Every thumb up, by any path, is one entry; taken back, it leaves; the
 * playlist is exactly the Likes, made once; a failed write is shown and can
 * be sent again.
 */

import { describe, expect, it } from "vitest";
import { LIKES_NAME } from "../../src/worker/hub/hub";
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

	it("thumbs given before the update are taken over once", async () => {
		const { h, ids } = await setup();
		await h.hub.thumb(ids[11]!, 1);
		await h.hub.thumb(ids[12]!, 1);
		// As if they were stored by 1.2.0: no Likes list yet.
		h.sql.run(`DELETE FROM kv WHERE k IN ('likes', 'likes_station_made')`);
		h.restart();
		expect((await h.hub.state()).likes?.count).toBe(2);
	});
});
