/**
 * Songs across the listener's own playlists: each own playlist counts a song
 * once; true-shuffle's playlists, playlists of others and of unclear origin
 * do not count; a playlist that could not be read makes the count visibly
 * incomplete. Fake Spotify only — no live requests.
 */

import { describe, expect, it } from "vitest";
import { HOUR_MS, MINUTE_MS } from "../../src/core/types";
import { FakeSpotify } from "../fakes/fake-spotify";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

/** Playlist 1 (the station's source) holds songs 0–99; X is song 200, outside it. */
async function setup() {
	const fake = new FakeSpotify();
	const h = await onboarded({ fake, tracks: 300, playlists: [100] });
	const t = [...fake.tracks.values()];
	const X = t[200]!.id;
	const fill = (from: number, n: number) => t.slice(from, from + n).map((x) => x.id);
	// X twice in A (the second time on its third page), once in B.
	const A = fake.addPlaylist("mika", "Sommer", [X, ...fill(210, 110), X]);
	const B = fake.addPlaylist("mika", "Auto", [...fill(150, 3), X]);
	// Made by true-shuffle (its known discoveries playlist): not counted.
	const ts = fake.addPlaylist("mika", "true-shuffle · Entdeckungen", [X]);
	h.sql.run(
		`INSERT INTO kv (k, v) VALUES ('discoveries_playlist', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
		JSON.stringify(ts.id),
	);
	// Named like true-shuffle, but none it knows: unclear, not counted.
	const unclear = fake.addPlaylist("mika", "true-shuffle · Alter Sender", [X]);
	// Someone else's, followed by the listener: not their own.
	fake.addUser("anna");
	const foreign = fake.addPlaylist("anna", "Annas Mix", [X, t[0]!.id]);
	foreign.followedBy.add("mika");
	return { h, fake, t, X, A, B, ts, unclear, foreign };
}

async function count(h: H) {
	h.clock.t += 11 * MINUTE_MS;
	await h.hub.requestPlaylistCounts();
	await h.listen(30 * MINUTE_MS);
	return h.hub.playlistCountsView();
}

const countOf = (h: H, id: string) =>
	h.hub.previewSelection({ enabled: true, rules: [], query: {} }) &&
	(h.hub as unknown as { playlistCountOf(): (id: string) => unknown }).playlistCountOf()(id);

describe("songs across own playlists", () => {
	it("counts each own playlist once, without true-shuffle's, others' or unclear ones", async () => {
		const { h, X, t, unclear } = await setup();
		expect(h.hub.playlistCountsView().state).toBe("never");
		const v = await count(h);
		expect(v).toMatchObject({
			state: "done",
			complete: true,
			playlists: { own: 3, read: 3, failed: [], foreign: 1 },
		});
		// The stations' own playlists and the discoveries playlist: all known as true-shuffle's.
		const stationLists = h.sql.all(`SELECT playlist_id FROM stations WHERE playlist_id IS NOT NULL`);
		expect(v.playlists.trueShuffle).toBe(stationLists.length + 1);
		expect(v.playlists.unclear).toEqual([{ id: unclear.id, name: unclear.name }]);
		expect(countOf(h, X)).toEqual({ count: 2, complete: true });
		// In Playlist 1 only; and one in none of them: a known zero, the count being complete.
		expect(countOf(h, t[5]!.id)).toEqual({ count: 1, complete: true });
		expect(countOf(h, t[190]!.id)).toEqual({ count: 0, complete: true });
		expect(v.top[0]).toMatchObject({ id: X, playlists: { count: 2 } });
	});

	it("the count reaches the queue's song facts, independent of the import selection", async () => {
		const { h, t } = await setup();
		await count(h);
		const sid = h.stationIds[0]!;
		expect(await h.hub.play(sid)).toMatchObject({ ok: true });
		const q = h.hub.sessionView(sid, 20)!.queue;
		expect(q.length).toBeGreaterThan(0);
		const inSource = new Set(t.slice(0, 100).map((x) => x.id));
		const fromSource = q.filter((e) => inSource.has(e.track.id));
		expect(fromSource.length).toBeGreaterThan(0);
		for (const e of fromSource) expect(e.facts?.playlists).toEqual({ count: 1, complete: true });
		// Recommendations from outside the library: in none of them, known so.
		for (const e of q.filter((e) => !inSource.has(e.track.id)))
			expect(e.facts?.playlists).toMatchObject({ complete: true });
	});

	it("unchanged playlists are not read again; a changed one is", async () => {
		const { h, fake, B, X } = await setup();
		await count(h);
		const reads = () => fake.calls.filter((c) => /\/playlists\/[^/]+\/items/.test(c) && c.startsWith("GET")).length;
		const first = reads();
		await count(h);
		expect(reads()).toBe(first);
		B.items = B.items.filter((id) => id !== X);
		B.snapshot++;
		await count(h);
		expect(reads()).toBe(first + 1);
		expect(countOf(h, X)).toEqual({ count: 1, complete: true });
	});

	it("a playlist it may not read leaves the count visibly incomplete: unknown is no zero", async () => {
		const { h, fake, B, X, t } = await setup();
		fake.failWhen = (m, path) =>
			m === "GET" && path === `/playlists/${B.id}/items` ? { status: 403 } : null;
		const v = await count(h);
		expect(v).toMatchObject({ state: "done", complete: false });
		expect(v.playlists.failed).toEqual([{ id: B.id, name: "Auto", reason: "kein Zugriff" }]);
		expect(countOf(h, X)).toEqual({ count: 1, complete: false });
		expect(countOf(h, t[190]!.id)).toEqual({ count: 0, complete: false });
		// Readable again: counted again in full.
		fake.failWhen = null;
		expect(await count(h)).toMatchObject({ complete: true, playlists: { failed: [] } });
		expect(countOf(h, X)).toEqual({ count: 2, complete: true });
	});

	it("waits out Spotify's Retry-After for the page asked, then goes on", async () => {
		const { h, fake, A, X } = await setup();
		let once = true;
		fake.failWhen = (m, path) => {
			if (m === "GET" && path === `/playlists/${A.id}/items` && once) {
				once = false;
				return { status: 429, headers: { "Retry-After": "1200" } };
			}
			return null;
		};
		h.clock.t += 11 * MINUTE_MS;
		await h.hub.requestPlaylistCounts();
		await h.listen(10 * MINUTE_MS);
		const at = fake.calls.filter((c) => c === `GET /v1/playlists/${A.id}/items`).length;
		expect(h.hub.playlistCountsView()).toMatchObject({ state: "running", complete: false });
		await h.listen(5 * MINUTE_MS);
		// Nothing asked of that page again inside the wait Spotify gave.
		expect(fake.calls.filter((c) => c === `GET /v1/playlists/${A.id}/items`).length).toBe(at);
		await h.listen(HOUR_MS);
		expect(h.hub.playlistCountsView()).toMatchObject({ state: "done", complete: true });
		expect(countOf(h, X)).toEqual({ count: 2, complete: true });
	});

	it("given up after repeated failures: stopped, incomplete, never a count of zero", async () => {
		const { h, fake, A, X } = await setup();
		fake.failWhen = (m, path) =>
			m === "GET" && path === `/playlists/${A.id}/items` ? { status: 500 } : null;
		h.clock.t += 11 * MINUTE_MS;
		await h.hub.requestPlaylistCounts();
		await h.listen(12 * HOUR_MS);
		const v = h.hub.playlistCountsView();
		expect(v).toMatchObject({ state: "stopped", complete: false });
		expect((countOf(h, X) as { complete: boolean }).complete).toBe(false);
	});
});
