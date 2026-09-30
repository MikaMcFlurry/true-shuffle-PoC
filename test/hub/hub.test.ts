import { describe, expect, it } from "vitest";
import { newDeck, observePlayer } from "../../src/core/deck";
import { cryptoRng } from "../../src/core/random";
import { HOUR_MS, MINUTE_MS } from "../../src/core/types";
import { DECK_SIZE, HubCore, sameDeck } from "../../src/worker/hub/hub";
import { Keys } from "../../src/worker/lib/crypto";
import { FakeSpotify } from "../fakes/fake-spotify";

import { nodeSql, onboarded, T0 } from "./harness";

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
			expect(pl.name).toBe(`true-shuffle · ${s.name}`);
			expect(new Set(pl.items).size).toBe(pl.items.length);
		}
		expect(deckPlaylist(h, st.stations[1]!.id).items.length).toBe(Math.min(DECK_SIZE, 400));
		expect(st.jobs).toEqual([]);
	});

	it("renames playlists made under the old spelling once, and still knows them as its own", async () => {
		const h = await onboarded({ tracks: 300, playlists: [300] });
		const hub = h.hub as unknown as { kvDel: (k: string) => void };
		const st = await h.hub.state();
		// An account from before: its decks carry the old name, the rename never ran.
		for (const s of st.stations) {
			const pl = h.fake.playlists.get(s.playlistId!)!;
			pl.name = pl.name.replace("true-shuffle · ", "True Shuffle · ");
		}
		hub.kvDel("names_v2");
		await h.listen(10 * MINUTE_MS);
		for (const s of st.stations)
			expect(h.fake.playlists.get(s.playlistId!)!.name).toBe(`true-shuffle · ${s.name}`);
		// A deck under the old name is never offered as a source.
		const offered = h.hub.listPlaylists().map((p) => p.name);
		expect(offered.some((n) => /shuffle ·/i.test(n))).toBe(false);
		// Once is enough: no rename on later syncs.
		const renames = () => h.fake.calls.filter((c) => /^PUT \/v1\/playlists\/[^/]+$/.test(c)).length;
		const calls = renames();
		expect(calls).toBeGreaterThan(0);
		await h.listen(HOUR_MS);
		expect(renames()).toBe(calls);
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
		// The display shows the song right away, not the snapshot from before the start.
		h.clock.t += 1000;
		const st = await h.hub.state({ live: true });
		expect(st.nowPlaying?.stationId).toBe(h.stationIds[0]);
		expect(st.nowPlaying?.isPlaying).toBe(true);
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

	it("retains the saved order and heard memory after the listener stopped", async () => {
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
		expect(deck.some((id) => heard.has(id))).toBe(true);
		const saved = h.hub.savedSession(sid)!;
		expect(saved.entryIds.length).toBe(deck.length);
		expect(saved.status).toBe("paused");
	});

	it("ordinary Play retains the same queue", async () => {
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
		expect(overlap).toBe(50);
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
		await h.hub.play(sid, null, { newQueue: true });
		const deck = deckPlaylist(h, sid).items;
		for (const id of skipped) expect(deck.includes(id)).toBe(false);
	});

	it("counts music heard outside true-shuffle and leaves the deck alone meanwhile", async () => {
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

describe("stored decks", () => {
	it("a later look at the same song writes nothing, unless a pause or a seek moved its end", () => {
		const uri = "spotify:playlist:x";
		const at = T0 + 60_000;
		const look = (dt: number, progress: number) => ({
			at: at + dt,
			contextUri: uri,
			trackId: "s1",
			isPlaying: true,
			progressMs: progress,
			durationMs: 200_000,
			shuffle: false,
			smartShuffle: false,
		});
		const ids = ["s0", "s1", "s2"].map((trackId) => ({ trackId, kind: "fresh" as const }));
		const first = observePlayer({ ...newDeck(ids, 1, T0), ours: true }, look(0, 10_000), uri).deck;
		// A minute later, the look's own delay puts the end 180 ms off.
		const later = observePlayer(first, look(60_000, 69_820), uri).deck;
		expect(sameDeck(first, later)).toBe(true);
		// Paused for half a minute in between: the song ends later.
		const paused = observePlayer(first, look(60_000, 40_000), uri).deck;
		expect(sameDeck(first, paused)).toBe(false);
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
		expect(new Set(heard.slice(0, 40).map((r) => r.track_id)).size).toBe(40);
		expect(heard.length).toBeGreaterThanOrEqual(38);
		const st = (await h.hub.state()).stations.find((s) => s.id === sid)!;
		expect(st.roundNo).toBeGreaterThanOrEqual(2);
	});
});

describe("guest mode", () => {
	it("ignores everything played while it is on", async () => {
		const h = await onboarded();
		const sid = h.stationIds[0]!;
		await h.hub.setGuest(true, 1);
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

	it("keeps an unknown Spotify quota reset blocked until an explicit recheck", async () => {
		const h = await onboarded();
		h.sql.run(
			"INSERT INTO kv(k,v) VALUES('spotify_cooldown',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
			JSON.stringify({
				kind: "quota",
				reason: "QUOTA_EXCEEDED",
				until: null,
				retryAfter: null,
				observedAt: h.clock.t,
				endpoint: "/me",
			}),
		);
		h.sql.run(
			"INSERT INTO kv(k,v) VALUES('backoff',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
			JSON.stringify({ kind: "quota", until: Number.MAX_SAFE_INTEGER }),
		);
		await h.listen(25 * MINUTE_MS);
		const st = await h.hub.state();
		expect(st.warnings.some((w) => w.code === "quota")).toBe(true);
		const calls = h.fake.calls.length;
		// Without Retry-After, elapsed wall time cannot establish a reset.
		await h.listen(30 * MINUTE_MS);
		expect(h.fake.calls.length).toBe(calls);
		// Waiting another hour preserves the gate and the saved queue.
		await h.listen(HOUR_MS);
		expect(h.fake.calls.length).toBe(calls);
		await h.hub.retryQuota();
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
		expect(deckPlaylist(h, h.allId).items.includes(cur)).toBe(false);
		expect(h.hub.savedSession(sid)!.entryIds.length).toBeGreaterThan(0);
		expect(h.fake.current()).not.toBe(cur);
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

describe("remote key (Siri, CarPlay, a watch, a widget)", () => {
	const nexts = (h: Awaited<ReturnType<typeof onboarded>>) =>
		h.fake.calls.filter((c) => c.startsWith("POST /v1/me/player/next")).length;

	it("likes, bans and skips the song playing now, and only with the current key", async () => {
		const h = await onboarded();
		await h.hub.play(h.stationIds[0]!);
		await h.listen(MINUTE_MS);
		await expect(h.hub.remote("nope", "like")).rejects.toMatchObject({ status: 401 });
		const kid = h.hub.newRemoteKey();
		expect(h.hub.remoteKey()?.kid).toBe(kid);

		const liked = h.fake.current()!;
		expect(await h.hub.remote(kid, "like")).toMatch(/ist jetzt Favorit\.$/);
		expect(h.hub.memory(liked).thumb).toBe(1);
		expect(h.fake.current()).toBe(liked);

		const banned = h.fake.current()!;
		const before = nexts(h);
		expect(await h.hub.remote(kid, "dislike")).toMatch(/kommt nie wieder\. Nächster Song\.$/);
		expect(h.hub.memory(banned).thumb).toBe(-1);
		// Skipped exactly once, not by both the command and the thumb.
		expect(nexts(h)).toBe(before + 1);
		expect(h.fake.current()).not.toBe(banned);

		const skipped = h.fake.current()!;
		expect(await h.hub.remote(kid, "skip")).toBe("Nächster Song.");
		expect(h.fake.current()).not.toBe(skipped);
		expect(h.hub.memory(skipped).thumb).toBe(0);
		expect(h.hub.remoteKey()?.usedAt).toBe(h.clock.t);

		// A new key ends the old one; deleting ends the new one.
		const next = h.hub.newRemoteKey();
		await expect(h.hub.remote(kid, "skip")).rejects.toMatchObject({ status: 401 });
		h.hub.dropRemoteKey();
		await expect(h.hub.remote(next, "skip")).rejects.toMatchObject({ status: 401 });
	});

	it("says so when nothing plays, and a paused song is banned without a skip", async () => {
		const h = await onboarded();
		const kid = h.hub.newRemoteKey();
		await expect(h.hub.remote(kid, "like")).rejects.toMatchObject({
			status: 409,
			message: "In Spotify läuft gerade kein Song.",
		});
		await h.hub.play(h.stationIds[0]!);
		await h.listen(MINUTE_MS);
		h.fake.pause();
		const cur = h.fake.current()!;
		const before = nexts(h);
		expect(await h.hub.remote(kid, "dislike")).toMatch(/kommt nie wieder\.$/);
		expect(nexts(h)).toBe(before);
		expect(h.hub.memory(cur).thumb).toBe(-1);
	});

	/** Spotify's player lags behind a command: it shows the old song for `lagMs` after /next. */
	function lagAfterNext(h: Awaited<ReturnType<typeof onboarded>>, lagMs: number) {
		const orig = h.fake.handle.bind(h.fake);
		let frozen: { body: string; until: number } | null = null;
		h.fake.handle = async (req: Request) => {
			const u = new URL(req.url);
			if (req.method === "POST" && u.pathname.endsWith("/me/player/next")) {
				const before = await orig(
					new Request(`${u.origin}/v1/me/player`, { headers: req.headers }),
				);
				const body = before.status === 200 ? await before.text() : "";
				const res = await orig(req);
				if (body) frozen = { body, until: h.clock.t + lagMs };
				return res;
			}
			if (
				req.method === "GET" &&
				u.pathname.endsWith("/me/player") &&
				frozen &&
				h.clock.t < frozen.until
			)
				return new Response(frozen.body, {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			return orig(req);
		};
	}

	for (const via of ["remote", "app key", "rating sheet"] as const)
		it(`a dislike (${via}) skips once, even while Spotify still shows the old song`, async () => {
			const h = await onboarded();
			await h.hub.play(h.stationIds[0]!);
			await h.listen(MINUTE_MS);
			await h.hub.state({ live: true });
			const kid = h.hub.newRemoteKey();
			lagAfterNext(h, 5000);
			const p = h.fake.user().player;
			const banned = h.fake.current()!;
			const innocent = p.order[p.index + 1]!;
			const before = nexts(h);
			if (via === "remote") expect(await h.hub.remote(kid, "dislike")).toMatch(/Nächster Song\.$/);
			else await h.hub.thumb(banned, -1);
			if (via === "rating sheet") {
				h.clock.t += 800;
				await h.hub.state({ live: true });
			}
			await h.listen(30 * MINUTE_MS);
			expect(nexts(h) - before).toBe(1);
			expect(h.hub.memory(banned).thumb).toBe(-1);
			expect(h.hub.memory(innocent).earlySkips).toBe(0);
			expect(h.hub.memory(innocent).plays).toBe(1);
		});

	it("a thumb down from a list skips nothing when the listener already moved on", async () => {
		const h = await onboarded();
		await h.hub.play(h.stationIds[0]!);
		await h.listen(MINUTE_MS);
		await h.hub.state({ live: true });
		const a = h.fake.current()!;
		h.fake.skip(); // skipped in Spotify; the hub's picture still shows A
		const b = h.fake.current()!;
		const before = nexts(h);
		const r = await h.hub.thumb(a, -1);
		expect(r.skipped).toBe(false);
		expect(nexts(h)).toBe(before);
		expect(h.fake.current()).toBe(b);
		await h.listen(30 * MINUTE_MS);
		expect(h.hub.memory(b).earlySkips).toBe(0);
		expect(h.hub.memory(a).thumb).toBe(-1);
	});

	it("says so when Spotify refuses to skip, and signing out ends the key", async () => {
		const h = await onboarded();
		await h.hub.play(h.stationIds[0]!);
		await h.listen(MINUTE_MS);
		const kid = h.hub.newRemoteKey();
		const cur = h.fake.current()!;
		h.fake.user().premium = false;
		const said = await h.hub.remote(kid, "dislike");
		expect(said).not.toMatch(/Nächster Song/);
		expect(said).toMatch(/kommt nie wieder\. Weiterspringen ging nicht: .*Premium/);
		expect(h.fake.current()).toBe(cur);
		h.fake.user().premium = true;
		h.hub.endSessions();
		expect(h.hub.remoteKey()).toBeNull();
		await expect(h.hub.remote(kid, "skip")).rejects.toMatchObject({ status: 401 });
	});

	it("answers at most 20 commands in ten minutes", async () => {
		const h = await onboarded();
		await h.hub.play(h.stationIds[0]!);
		await h.listen(MINUTE_MS);
		const kid = h.hub.newRemoteKey();
		for (let i = 0; i < 20; i++) await h.hub.remote(kid, "like");
		await expect(h.hub.remote(kid, "like")).rejects.toMatchObject({ status: 429 });
		await h.listen(10 * MINUTE_MS);
		await expect(h.hub.remote(kid, "like")).resolves.toMatch(/Favorit/);
	});
});

describe("sessions", () => {
	it("signing out ends every session issued so far, and a new sign-in works again", async () => {
		const h = await onboarded();
		const first = h.hub.sessionEpoch();
		expect(() => h.hub.checkSession(first)).not.toThrow();
		h.hub.endSessions();
		expect(() => h.hub.checkSession(first)).toThrow(/anmelden/);
		const tokens = {
			accessToken: h.fake.issueToken("mika"),
			refreshToken: "rt-again",
			expiresAt: h.clock.t + 3_600_000,
			scope: "all",
		};
		h.fake.refreshTokens.set("rt-again", "mika");
		const next = await h.hub.connect({ id: "mika", name: "Mika", imageUrl: null }, tokens);
		expect(next).not.toBe(first);
		expect(() => h.hub.checkSession(next)).not.toThrow();
	});
});

describe("taken off the allowlist", () => {
	it("the hub rests until its listener is allowed again", async () => {
		const h = await onboarded();
		const cookie = h.hub.sessionEpoch();
		h.hub.suspend();
		expect(() => h.hub.checkSession(cookie)).toThrow(); // signed out for good
		await h.listen(60 * 60_000);
		expect(h.alarmAt()).toBeNull();
		await h.hub.ensureAlarm(); // the cron's safety net does not wake it either
		expect(h.alarmAt()).toBeNull();
		await h.hub.allow(); // back on the list: the cron wakes it
		expect(h.alarmAt()).not.toBeNull();
		h.hub.suspend(); // taken off once more
		h.fake.refreshTokens.set("rt-back", "mika");
		await h.hub.connect(
			{ id: "mika", name: "Mika", imageUrl: null },
			{
				accessToken: h.fake.issueToken("mika"),
				refreshToken: "rt-back",
				expiresAt: h.clock.t + 3_600_000,
				scope: "all",
			},
		);
		expect(h.alarmAt()).not.toBeNull();
	});
});

describe("sessions after deleting the account", () => {
	it("a cookie revoked before stays invalid after the account is deleted and made again", async () => {
		const fake = new FakeSpotify();
		fake.addTracks(10);
		fake.addUser("mika");
		let sql = nodeSql();
		const clock = { t: T0 };
		fake.now = () => clock.t;
		let hub!: HubCore;
		const make = () =>
			new HubCore({
				sql,
				fetch: (r) => fake.handle(r),
				now: () => clock.t,
				rng: cryptoRng(), // as in production
				keys: new Keys("test-secret-test-secret-test-secret-42"),
				env: {
					endpoints: {
						accountsBase: "https://fake/accounts",
						apiBase: "https://fake/v1",
						clientId: "cid",
					},
					lastfmBase: "https://fake/lastfm",
					lastfmKey: null,
					deezerBase: "https://fake/deezer",
					anthropicKey: null,
					anthropicModel: "x",
				},
				alarms: { set: async () => {}, get: async () => null },
				ai: null,
				wipe: async () => {
					sql = nodeSql(); // storage.deleteAll()
					hub = make();
				},
			});
		hub = make();
		const tokens = () => {
			fake.refreshTokens.set("r", "mika");
			return {
				accessToken: fake.issueToken("mika"),
				refreshToken: "r",
				expiresAt: clock.t + 3_600_000,
				scope: "all",
			};
		};
		const copied = await hub.connect({ id: "mika", name: "Mika", imageUrl: null }, tokens());
		hub.endSessions();
		await hub.deleteAccount();
		await hub.connect({ id: "mika", name: "Mika", imageUrl: null }, tokens());
		expect(() => hub.checkSession(copied)).toThrow(/anmelden/);
	});
});
