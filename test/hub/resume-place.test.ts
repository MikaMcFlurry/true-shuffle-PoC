/**
 * The saved place of a station only moves forward.
 *
 * Field report (2026-10-04 → 10-07): after a night, a second device resumed
 * the station's playlist at a place it had loaded hours earlier; the saved
 * place followed it back, and every later start replayed the same songs in
 * the same order for two days.
 */

import { describe, expect, it } from "vitest";
import { RequestBudget } from "../../src/worker/spotify/client";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

const observe = (h: H) => h.hub.sync(new RequestBudget(25), { force: true });

const deckIds = (h: H, id: number): string[] =>
	JSON.parse(
		h.sql.first<{ deck: string }>("SELECT deck FROM stations WHERE id = ?", id)!.deck,
	).items.map((it: { id: string }) => it.id);

/** Put the saved place of a station at `index`/`progressMs` (a lagging checkpoint). */
const lag = (h: H, id: number, index: number, progressMs: number | null) => {
	const s = h.hub.savedSession(id)!;
	h.sql.run(
		"UPDATE playback_sessions SET data = ? WHERE station_id = ?",
		JSON.stringify({ ...s, currentIndex: index, progressMs }),
		id,
	);
};

/** Spotify lists `trackId` as played (default: now) in `contextUri`. */
const listed = (h: H, trackId: string, contextUri: string | null, playedAt = h.clock.t) =>
	h.fake.user().recent.unshift({ trackId, playedAt, contextUri });

/** Play the station from true-shuffle and let a few songs run to their end. */
async function listenSome(h: H, id: number, songs: number, songMs = 180_000) {
	expect(await h.hub.play(id)).toMatchObject({ ok: true });
	await h.listen(songs * songMs + 30_000);
	await observe(h);
	const s = h.hub.savedSession(id)!;
	expect(s.currentIndex).toBeGreaterThanOrEqual(songs);
	return s;
}

describe("the saved place never moves back", () => {
	it("a second device resuming an old place does not move it", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 180_000 });
		const id = h.stationIds[0]!;
		const before = await listenSome(h, id, 5);
		await h.hub.playerAction("pause");
		await h.listen(60_000);
		const saved = h.hub.savedSession(id)!.currentIndex;
		expect(saved).toBe(before.currentIndex);

		// The laptop wakes up the next morning in the same playlist, two songs in.
		const u = h.fake.user();
		u.devices.push({ id: "mika-laptop", name: "Laptop", type: "Computer", restricted: false });
		h.clock.t += 10 * 60 * 60 * 1000;
		h.fake.startContext(u.id, before.contextUri, 1, "mika-laptop", false);
		await observe(h);
		expect(h.hub.savedSession(id)!.currentIndex).toBe(saved);
		expect(h.hub.savedSession(id)!.status).toBe("external");

		// Back in true-shuffle: it continues where its order got to.
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.fake.current()).toBe(deckIds(h, id)[saved]);
	});

	it("a lagging saved place resumes that same occurrence, not one past the heard songs (NN-04)", async () => {
		// Replaces PR #15's "a start continues after the furthest song heard":
		// history membership never proves the saved occurrence was finished.
		const h = await onboarded({ tracks: 200, durationMs: 180_000 });
		const id = h.stationIds[0]!;
		await listenSome(h, id, 6);
		await h.hub.playerAction("pause");
		await h.listen(60_000);
		const ids = deckIds(h, id);
		const heard = h.sql
			.all<{ track_id: string }>("SELECT track_id FROM plays WHERE station_id = ?", id)
			.map((r) => ids.indexOf(r.track_id));
		expect(Math.max(...heard)).toBeGreaterThanOrEqual(5);
		h.fake.user().player.contextUri = "spotify:playlist:unrelated";
		await observe(h);
		lag(h, id, 0, 23_000);
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.fake.current()).toBe(ids[0]);
		expect(h.fake.user().player.index).toBe(0);
		expect(h.fake.user().player.progressMs).toBe(23_000);
		expect(h.hub.savedSession(id)).toMatchObject({ currentIndex: 0, progressMs: 23_000 });
	});

	it("a song paused in its middle still resumes where it stopped", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 180_000 });
		const id = h.stationIds[0]!;
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		await h.listen(2 * 180_000 + 90_000);
		await observe(h);
		await h.hub.playerAction("pause");
		await h.listen(60_000);
		const s = h.hub.savedSession(id)!;
		expect(s.progressMs).toBeGreaterThan(30_000);
		// Spotify already lists the paused song (heard 30 s).
		h.fake.user().recent.unshift({
			trackId: deckIds(h, id)[s.currentIndex]!,
			playedAt: h.clock.t,
			contextUri: s.contextUri,
		});
		await observe(h);
		const progress = h.hub.savedSession(id)!.progressMs;
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.fake.current()).toBe(deckIds(h, id)[s.currentIndex]);
		expect(h.fake.user().player.progressMs).toBe(progress);
	});

	it("an unconfirmed command stops freezing the saved place after a while", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 180_000 });
		const id = h.stationIds[0]!;
		const s = await listenSome(h, id, 2);
		h.sql.run(
			"UPDATE playback_sessions SET data = ? WHERE station_id = ?",
			JSON.stringify({
				...h.hub.savedSession(id)!,
				pending: { operationId: "lost", kind: "resume", phase: "submitted", startedAt: h.clock.t },
			}),
			id,
		);
		await h.listen(10 * 60_000);
		await observe(h);
		const after = h.hub.savedSession(id)!;
		expect(after.pending).toBeNull();
		expect(after.currentIndex).toBeGreaterThan(s.currentIndex + 1);
	});
});

describe("one play is counted once", () => {
	it("Spotify listing a play minutes after the looks counted it does not make it two", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 247_000 });
		const id = h.stationIds[0]!;
		await listenSome(h, id, 1, 247_000);
		const row = h.sql.first<{ track_id: string; meta: string }>(
			"SELECT track_id, meta FROM plays WHERE station_id = ? ORDER BY played_at LIMIT 1",
			id,
		)!;
		// A later song of the deck, counted from the looks (a private session, a
		// start that replaced it) before Spotify lists it.
		const later = deckIds(h, id)[150]!;
		const track = JSON.parse(row.meta);
		track[0] = later;
		const count = () =>
			h.sql.first<{ n: number }>("SELECT COUNT(*) AS n FROM plays WHERE track_id = ?", later)!.n;
		const at = h.clock.t;
		const hub = h.hub as unknown as {
			recordSeenPlay(e: {
				id: string;
				at: number;
				start: number;
				end: number;
				contextUri: string | null;
				track: unknown;
			}): unknown;
		};
		expect(
			hub.recordSeenPlay({
				id: later,
				at,
				start: at - 200_000,
				end: at,
				contextUri: h.hub.savedSession(id)!.contextUri,
				track,
			}),
		).not.toBeNull();
		expect(count()).toBe(1);
		// Spotify lists the same play six minutes later.
		h.clock.t += 6 * 60_000;
		h.fake.user().recent.unshift({
			trackId: later,
			playedAt: h.clock.t,
			contextUri: h.hub.savedSession(id)!.contextUri,
		});
		await observe(h);
		expect(count()).toBe(1);
	});
});

/**
 * RESUME-01 (review of PR #15): a listing of a song does not prove that the
 * saved occurrence of it was finished. Normal Play resumes that occurrence at
 * its saved position, or from its beginning when the position is unknown.
 */
describe("a start resumes the unfinished occurrence (RESUME-01)", () => {
	async function pausedAt(h: H, id: number, progressMs: number) {
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		h.fake.user().player.progressMs = progressMs;
		await observe(h);
		await h.hub.playerAction("pause");
		const s = h.hub.savedSession(id)!;
		expect(s).toMatchObject({ currentIndex: 0, progressMs });
		return s;
	}

	it("a near-end pause with a partial listing of the same song resumes it there", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 180_000 });
		const id = h.stationIds[0]!;
		const s = await pausedAt(h, id, 177_000);
		listed(h, deckIds(h, id)[0]!, s.contextUri);
		await observe(h);
		expect(h.hub.savedSession(id)).toMatchObject({ currentIndex: 0, progressMs: 177_000 });
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.fake.current()).toBe(deckIds(h, id)[0]);
		expect(h.fake.user().player.index).toBe(0);
		expect(h.fake.user().player.progressMs).toBe(177_000);
	});

	it("unknown saved progress replays the same listed song from its beginning", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 180_000 });
		const id = h.stationIds[0]!;
		const s = await pausedAt(h, id, 50_000);
		listed(h, deckIds(h, id)[0]!, s.contextUri);
		// The player went on elsewhere: nothing tells where in the song it was.
		h.fake.user().player.contextUri = "spotify:playlist:unrelated";
		await observe(h);
		lag(h, id, 0, null);
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.fake.current()).toBe(deckIds(h, id)[0]);
		expect(h.fake.user().player.index).toBe(0);
		expect(h.fake.user().player.progressMs).toBe(0);
		expect(h.hub.savedSession(id)!.currentIndex).toBe(0);
	});

	it("a listing of a later song of the order does not skip the unfinished one", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 180_000 });
		const id = h.stationIds[0]!;
		const s = await pausedAt(h, id, 42_000);
		listed(h, deckIds(h, id)[3]!, s.contextUri);
		await observe(h);
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.fake.current()).toBe(deckIds(h, id)[0]);
		expect(h.fake.user().player.index).toBe(0);
		expect(h.fake.user().player.progressMs).toBe(42_000);
	});

	it("a song held twice in the order: each unfinished instance resumes as itself", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 180_000 });
		const id = h.stationIds[0]!;
		const s = await pausedAt(h, id, 10_000);
		// The order holds song X at places 0 and 2 (playlist and deck alike).
		const st = h.sql.first<{ deck: string; playlist_id: string }>(
			"SELECT deck, playlist_id FROM stations WHERE id = ?",
			id,
		)!;
		const deck = JSON.parse(st.deck);
		const x = deck.items[0].id as string;
		deck.items[2].id = x;
		h.sql.run("UPDATE stations SET deck = ? WHERE id = ?", JSON.stringify(deck), id);
		h.fake.playlists.get(st.playlist_id)!.items[2] = x;
		// Spotify lists X in this playlist (heard before, at either place).
		listed(h, x, s.contextUri);
		await observe(h);
		lag(h, id, 0, null);
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.fake.user().player.index).toBe(0);
		expect(h.fake.current()).toBe(x);
		expect(h.fake.user().player.progressMs).toBe(0);
		await h.hub.playerAction("pause");
		// Saved at the second instance: it resumes there, not after it.
		lag(h, id, 2, 61_000);
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.fake.user().player.index).toBe(2);
		expect(h.fake.current()).toBe(x);
		expect(h.fake.user().player.progressMs).toBe(61_000);
	});
});

/**
 * RESUME-02 (review of PR #15): requested, accepted and observed playback
 * stay apart. A refused start or a failed preflight keeps the previous
 * occurrence, its position and when it was observed — also after a restart —
 * even when history holds later songs of the order.
 */
describe("a refused start keeps the saved occurrence (RESUME-02)", () => {
	const reply = (status: number, reason: string) =>
		new Response(JSON.stringify({ error: { status, reason, message: reason } }), {
			status,
			...(status === 429 ? { headers: { "Retry-After": "60" } } : {}),
		});

	async function historyBacked() {
		const h = await onboarded({ tracks: 200, durationMs: 180_000 });
		const id = h.stationIds[0]!;
		await listenSome(h, id, 6);
		await h.hub.playerAction("pause");
		await h.listen(60_000);
		const ids = deckIds(h, id);
		const s0 = h.hub.savedSession(id)!;
		const heard = h.sql
			.all<{ track_id: string }>(
				"SELECT track_id FROM plays WHERE station_id = ? AND context_uri = ?",
				id,
				s0.contextUri,
			)
			.map((r) => r.track_id);
		expect(heard).toContain(ids[3]);
		// The player went on in another context.
		h.fake.user().player.contextUri = "spotify:playlist:unrelated";
		await observe(h);
		lag(h, id, 0, 23_000);
		const before = h.hub.savedSession(id)!;
		expect(before).toMatchObject({ currentIndex: 0, progressMs: 23_000, pending: null });
		return { h, id, ids, before };
	}

	const keeps = (h: H, id: number, before: NonNullable<ReturnType<H["hub"]["savedSession"]>>) =>
		expect(h.hub.savedSession(id)).toMatchObject({
			sessionId: before.sessionId,
			entryIds: before.entryIds,
			currentIndex: before.currentIndex,
			progressMs: before.progressMs,
			observedAt: before.observedAt,
			pending: before.pending,
		});

	it.each([
		[403, "PREMIUM_REQUIRED", "premium"],
		[403, "RESTRICTION_VIOLATED", "restricted"],
		[404, "NO_ACTIVE_DEVICE", "no_device"],
		[429, "QUOTA_EXCEEDED", "quota"],
	] as const)("a definitive %s/%s play refusal", async (status, reason, code) => {
		const { h, id, ids, before } = await historyBacked();
		const handle = h.fake.handle.bind(h.fake);
		h.fake.handle = async (req) =>
			req.method === "PUT" && new URL(req.url).pathname === "/v1/me/player/play"
				? reply(status, reason)
				: handle(req);
		const result = await h.hub.play(id, "mika-phone");
		expect(result).toMatchObject({ ok: false, error: { code } });
		expect(result.uncertain).toBeUndefined();
		keeps(h, id, before);
		h.restart();
		keeps(h, id, before);
		h.fake.handle = handle;
		h.clock.t += 2 * 60_000;
		expect(await h.hub.play(id, "mika-phone")).toMatchObject({ ok: true });
		expect(h.fake.current()).toBe(ids[0]);
		expect(h.fake.user().player.index).toBe(0);
		expect(h.fake.user().player.progressMs).toBe(23_000);
	});

	it("a rejected 401 whose token refresh fails (auth)", async () => {
		const { h, id, ids, before } = await historyBacked();
		const handle = h.fake.handle.bind(h.fake);
		h.fake.handle = async (req) => {
			const path = new URL(req.url).pathname;
			if (req.method === "PUT" && path === "/v1/me/player/play")
				return reply(401, "fixture expired access token");
			if (path === "/accounts/api/token") throw new Error("fixture refresh connection lost");
			return handle(req);
		};
		const result = await h.hub.play(id, "mika-phone");
		expect(result.ok).toBe(false);
		expect(result.uncertain).toBeUndefined();
		keeps(h, id, before);
		h.restart();
		keeps(h, id, before);
		h.fake.handle = handle;
		expect(await h.hub.play(id, "mika-phone")).toMatchObject({ ok: true });
		expect(h.fake.current()).toBe(ids[0]);
		expect(h.fake.user().player.progressMs).toBe(23_000);
	});

	it("a preflight without any device", async () => {
		const { h, id, before } = await historyBacked();
		const devices = h.fake.user().devices;
		h.fake.user().devices = [];
		expect(await h.hub.play(id)).toMatchObject({ ok: false, error: { code: "no_device" } });
		keeps(h, id, before);
		h.restart();
		keeps(h, id, before);
		h.fake.user().devices = devices;
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.fake.user().player.index).toBe(0);
		expect(h.fake.user().player.progressMs).toBe(23_000);
	});
});

/**
 * RESUME-03 (review of PR #15): the same play, listed late, counts once; a new
 * play of the same song — in the same or another context — counts again.
 */
describe("a new play of the same song counts again (RESUME-03)", () => {
	type Seen = {
		recordSeenPlay(e: {
			id: string;
			at: number;
			start: number;
			end: number;
			contextUri: string | null;
			track: unknown;
		}): unknown;
	};

	async function counted(h: H, open: boolean) {
		const id = h.stationIds[0]!;
		await listenSome(h, id, 1, 247_000);
		const row = h.sql.first<{ meta: string }>(
			"SELECT meta FROM plays WHERE station_id = ? ORDER BY played_at LIMIT 1",
			id,
		)!;
		const song = deckIds(h, id)[150]!;
		const track = JSON.parse(row.meta);
		track[0] = song;
		const ctx = h.hub.savedSession(id)!.contextUri;
		const at = h.clock.t;
		// Counted from the looks: still on (200 s of 247 s), or played through.
		expect(
			(h.hub as unknown as Seen).recordSeenPlay({
				id: song,
				at,
				start: at - (open ? 200_000 : 247_000),
				end: at,
				contextUri: ctx,
				track,
			}),
		).not.toBeNull();
		const count = () =>
			h.sql.first<{ n: number }>("SELECT COUNT(*) AS n FROM plays WHERE track_id = ?", song)!.n;
		expect(count()).toBe(1);
		return { song, ctx, at, count, ids: deckIds(h, id) };
	}

	it("the delayed listing of the same occurrence counts once, a further listing again", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 247_000 });
		const { song, ctx, at, count } = await counted(h, true);
		h.clock.t = at + 6 * 60_000;
		listed(h, song, ctx);
		await observe(h);
		expect(count()).toBe(1);
		h.clock.t = at + 9 * 60_000;
		listed(h, song, ctx);
		await observe(h);
		expect(count()).toBe(2);
	});

	it("a distinct repeat in the same context counts (played through when counted)", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 247_000 });
		const { song, ctx, at, count } = await counted(h, false);
		h.clock.t = at + 4 * 60_000 + 7_000;
		listed(h, song, ctx);
		await observe(h);
		expect(count()).toBe(2);
	});

	it("a distinct repeat in the same context counts after another song was heard", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 247_000 });
		const { song, ctx, at, count, ids } = await counted(h, true);
		h.clock.t = at + 3 * 60_000;
		listed(h, ids[170]!, ctx);
		await observe(h);
		h.clock.t = at + 5 * 60_000;
		listed(h, song, ctx);
		await observe(h);
		expect(count()).toBe(2);
	});

	it("a distinct repeat in a different context counts (review case)", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 247_000 });
		const { song, at, count } = await counted(h, true);
		h.clock.t = at + 4 * 60_000;
		listed(h, song, "spotify:playlist:elsewhere");
		await observe(h);
		expect(count()).toBe(2);
	});

	it("a play counted in a private session, then played again normally, counts twice", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 180_000 });
		const id = h.stationIds[0]!;
		const u = h.fake.user();
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		const dev = u.devices.find((d) => d.id === u.player.deviceId)!;
		dev.privateSession = true;
		const x = h.fake.current()!;
		const ctx = u.player.contextUri!;
		const count = () =>
			h.sql.first<{ n: number }>("SELECT COUNT(*) AS n FROM plays WHERE track_id = ?", x)!.n;
		// Heard through in the private session; the looks count it.
		await h.listen(180_000 + 60_000);
		await observe(h);
		expect(h.fake.current()).not.toBe(x);
		expect(count()).toBe(1);
		expect(u.recent.some((r) => r.trackId === x)).toBe(false);
		// Out of it, the listener plays it again from the playlist.
		dev.privateSession = false;
		h.fake.startContext(u.id, ctx, 0, dev.id, false);
		expect(h.fake.current()).toBe(x);
		await h.listen(180_000 + 30_000);
		expect(u.recent.some((r) => r.trackId === x)).toBe(true);
		await observe(h);
		await h.listen(5 * 60_000);
		expect(count()).toBe(2);
	});
});
