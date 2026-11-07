/**
 * P5: „Nach diesem Song fortsetzen“. The song outside true-shuffle plays to
 * its end untouched; true-shuffle resumes its saved place only after a look
 * saw the song left; cancelling has no effect; nothing goes into Spotify's
 * queue.
 */

import { expect, it } from "vitest";
import { RequestBudget } from "../../src/worker/spotify/client";
import { onboarded } from "./harness";

const PLAY = "PUT /v1/me/player/play";
const QUEUE = "POST /v1/me/player/queue";

async function outsidePlaying() {
	const h = await onboarded({ tracks: 12, playlists: [6, 6] });
	const sid = h.stationIds[0]!;
	expect(await h.hub.play(sid)).toMatchObject({ ok: true });
	await h.listen(20_000);
	await h.hub.sync(new RequestBudget(8), { force: true });
	const s = h.hub.savedSession(sid)!;
	const saved = s.entryIds[s.currentIndex]!;
	const deck = h.fake.playlists.get(s.contextUri.split(":")[2]!)!;
	const b = [...h.fake.tracks.keys()].find((id) => !deck.items.includes(id))!;
	h.fake.playSong("mika", b);
	h.fake.user("mika").player.progressMs = 60_000;
	await h.hub.sync(new RequestBudget(8), { force: true });
	const st = await h.hub.state();
	expect(st.observed?.attribution).toBe("outside");
	return { h, sid, b, saved, s };
}

it("waits for the song to end, then resumes the saved place on the same device", async () => {
	const { h, sid, b, s } = await outsidePlaying();
	const view = await h.hub.continueAfter(b);
	expect(view).toMatchObject({ trackId: b, due: false });
	const calls = h.fake.calls.length;
	const duration = h.fake.tracks.get(b)!.durationMs;
	// Until just before the end: B plays on, nothing sent.
	await h.listen(duration - 60_000 - 5_000);
	expect(h.fake.current()).toBe(b);
	expect(h.fake.calls.slice(calls).filter((c) => c.startsWith(PLAY))).toEqual([]);
	// The song ends (the stand-in then stops): a look sees it, true-shuffle goes on.
	await h.listen(60_000);
	const after = h.fake.calls.slice(calls);
	expect(after.filter((c) => c.startsWith(PLAY))).toHaveLength(1);
	expect(after.some((c) => c.startsWith(QUEUE))).toBe(false);
	expect(h.fake.user("mika").player.contextUri).toBe(s.contextUri);
	expect(h.fake.user("mika").player.isPlaying).toBe(true);
	const st = await h.hub.state();
	expect(st.continueAfter).toMatchObject({ trackId: null, result: { ok: true } });
	expect(h.hub.savedSession(sid)!.sessionId).toBe(s.sessionId);
});

it("Abbrechen: the song and what follows play as Spotify likes, nothing is sent", async () => {
	const { h, b } = await outsidePlaying();
	await h.hub.continueAfter(b);
	const calls = h.fake.calls.length;
	await h.hub.cancelContinueAfter();
	await h.listen(h.fake.tracks.get(b)!.durationMs);
	const after = h.fake.calls.slice(calls);
	expect(after.filter((c) => c.startsWith(PLAY) || c.startsWith(QUEUE))).toEqual([]);
	expect((await h.hub.state()).continueAfter ?? null).toBeNull();
});

it("never for a song that no longer plays, nor for true-shuffle's own", async () => {
	const { h, b } = await outsidePlaying();
	const other = [...h.fake.tracks.keys()].find((id) => id !== b)!;
	await expect(h.hub.continueAfter(other)).rejects.toMatchObject({ status: 409 });
	await expect(h.hub.continueAfter("nope")).rejects.toMatchObject({ code: "bad_track" });
});

it("the listener goes back to true-shuffle by hand: done, nothing sent twice", async () => {
	const { h, sid, b } = await outsidePlaying();
	await h.hub.continueAfter(b);
	expect(await h.hub.play(sid)).toMatchObject({ ok: true });
	// An explicit start supersedes the wish: nothing left to resume.
	expect((await h.hub.state()).continueAfter ?? null).toBeNull();
	const calls = h.fake.calls.length;
	await h.listen(60_000);
	expect(h.fake.calls.slice(calls).filter((c) => c.startsWith(PLAY))).toEqual([]);
});

it("paused before the end, then no player: nothing is started (red-team H2)", async () => {
	const { h, b } = await outsidePlaying();
	await h.hub.continueAfter(b);
	const calls = h.fake.calls.length;
	h.fake.user("mika").player.isPlaying = false;
	await h.hub.sync(new RequestBudget(8), { force: true });
	// Spotify forgets the paused player: a look shows none.
	h.fake.user("mika").player.deviceId = null as never;
	await h.listen(10 * 60_000);
	expect(h.fake.calls.slice(calls).filter((c) => c.startsWith(PLAY))).toEqual([]);
	const st = await h.hub.state();
	expect(st.continueAfter?.result).toMatchObject({ ok: false });
});

it("a song the listener picks mid-song is never cut: cancelled instead (re-check)", async () => {
	const { h, b, s } = await outsidePlaying();
	await h.hub.continueAfter(b);
	await h.listen(30_000);
	const c = [...h.fake.tracks.keys()].find(
		(id) => id !== b && !h.fake.playlists.get(s.contextUri.split(":")[2]!)!.items.includes(id),
	)!;
	h.fake.playSong("mika", c);
	h.fake.user("mika").player.progressMs = 5_000;
	const calls = h.fake.calls.length;
	// Until C is over: whatever the hub looks at, C is never cut.
	await h.listen(h.fake.tracks.get(c)!.durationMs - 10_000);
	expect(h.fake.current()).toBe(c);
	expect(h.fake.calls.slice(calls).filter((x) => x.startsWith(PLAY))).toEqual([]);
	expect((await h.hub.state()).continueAfter?.result).toMatchObject({ ok: false });
});

it("played to its end, then stopped there (no autoplay): true-shuffle goes on (re-check)", async () => {
	const { h, b, s } = await outsidePlaying();
	await h.hub.continueAfter(b);
	const calls = h.fake.calls.length;
	const d = h.fake.tracks.get(b)!.durationMs;
	await h.listen(d - 60_000 - 3_000);
	// Spotify keeps the song loaded, paused at its end.
	const p = h.fake.user("mika").player;
	p.isPlaying = false;
	p.progressMs = d;
	await h.listen(60_000);
	expect(h.fake.calls.slice(calls).filter((x) => x.startsWith(PLAY))).toHaveLength(1);
	expect(h.fake.user("mika").player.contextUri).toBe(s.contextUri);
});

it("paused by hand five seconds before the end: nothing is started, it waits (B9341-02)", async () => {
	const { h, b, s } = await outsidePlaying();
	await h.hub.continueAfter(b);
	const calls = h.fake.calls.length;
	const d = h.fake.tracks.get(b)!.durationMs;
	await h.listen(d - 60_000 - 5_000);
	h.fake.pause("mika");
	await h.listen(10 * 60_000);
	expect(h.fake.calls.slice(calls).filter((x) => x.startsWith(PLAY))).toEqual([]);
	expect(h.fake.user("mika").player.progressMs).toBe(d - 5_000);
	expect(h.fake.current()).toBe(b);
	// Still waiting for the song's real end: the listener plays it on, it ends, true-shuffle goes on.
	expect((await h.hub.state()).continueAfter).toMatchObject({ trackId: b, due: false });
	h.fake.user("mika").player.isPlaying = true;
	await h.hub.sync(new RequestBudget(8), { force: true });
	await h.listen(10_000);
	await h.hub.sync(new RequestBudget(8), { force: true });
	await h.listen(3 * 60_000);
	expect(h.fake.calls.slice(calls).filter((x) => x.startsWith(PLAY))).toHaveLength(1);
	expect(h.fake.user("mika").player.contextUri).toBe(s.contextUri);
});

it("paused by hand just before the end, then no player: nothing is started (B9341-02)", async () => {
	const { h, b } = await outsidePlaying();
	await h.hub.continueAfter(b);
	const calls = h.fake.calls.length;
	const d = h.fake.tracks.get(b)!.durationMs;
	await h.listen(d - 60_000 - 5_000);
	// Paused, and Spotify drops the player before the hub looks again.
	h.fake.pause("mika");
	h.fake.user("mika").player.deviceId = null as never;
	await h.listen(10 * 60_000);
	expect(h.fake.calls.slice(calls).filter((x) => x.startsWith(PLAY))).toEqual([]);
	expect((await h.hub.state()).continueAfter?.result).toMatchObject({ ok: false });
});

it("a song picked by hand fifteen seconds before the end is never cut (B9341-02)", async () => {
	const { h, b, s } = await outsidePlaying();
	await h.hub.continueAfter(b);
	const d = h.fake.tracks.get(b)!.durationMs;
	await h.listen(d - 60_000 - 15_000);
	const c = [...h.fake.tracks.keys()].find(
		(id) => id !== b && !h.fake.playlists.get(s.contextUri.split(":")[2]!)!.items.includes(id),
	)!;
	h.fake.playSong("mika", c);
	const calls = h.fake.calls.length;
	await h.listen(h.fake.tracks.get(c)!.durationMs - 10_000);
	expect(h.fake.current()).toBe(c);
	expect(h.fake.calls.slice(calls).filter((x) => x.startsWith(PLAY))).toEqual([]);
	expect((await h.hub.state()).continueAfter?.result).toMatchObject({ ok: false });
});

it("ends on its own and Spotify's autoplay begins another: true-shuffle goes on once", async () => {
	const { h, b, s } = await outsidePlaying();
	h.fake.user("mika").player.autoplay = true;
	await h.hub.continueAfter(b);
	const calls = h.fake.calls.length;
	await h.listen(h.fake.tracks.get(b)!.durationMs);
	await h.listen(60_000);
	expect(h.fake.calls.slice(calls).filter((x) => x.startsWith(PLAY))).toHaveLength(1);
	expect(h.fake.user("mika").player.contextUri).toBe(s.contextUri);
});
