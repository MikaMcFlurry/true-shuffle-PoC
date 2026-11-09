/**
 * P5: „Nach diesem Song fortsetzen“. The song outside true-shuffle plays to
 * its end untouched; true-shuffle resumes its saved place only when Spotify
 * shows the song stopped at its very end. Anything the listener could have
 * done too (another song, however close to the end; a song paused at its
 * start; no player) cancels and says so, nothing is started (PR39 re-review).
 * Cancelling has no effect; nothing goes into Spotify's queue.
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
	const device = h.fake.user("mika").player.deviceId;
	const view = await h.hub.continueAfter(b);
	expect(view).toMatchObject({ trackId: b, due: false });
	const calls = h.fake.calls.length;
	const duration = h.fake.tracks.get(b)!.durationMs;
	// Until just before the end: B plays on, nothing sent.
	await h.listen(duration - 60_000 - 5_000);
	expect(h.fake.current()).toBe(b);
	expect(h.fake.calls.slice(calls).filter((c) => c.startsWith(PLAY))).toEqual([]);
	// The song ends and Spotify keeps it there, stopped at its end: a look sees
	// that, true-shuffle goes on.
	await h.listen(4_000);
	const p = h.fake.user("mika").player;
	p.isPlaying = false;
	p.progressMs = duration;
	await h.listen(60_000);
	const after = h.fake.calls.slice(calls);
	expect(after.filter((c) => c.startsWith(PLAY))).toHaveLength(1);
	expect(after.some((c) => c.startsWith(QUEUE))).toBe(false);
	expect(h.fake.user("mika").player.contextUri).toBe(s.contextUri);
	expect(h.fake.user("mika").player.isPlaying).toBe(true);
	expect(h.fake.user("mika").player.deviceId).toBe(device);
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
	// Still waiting for the song's real end: the listener plays it on, Spotify
	// shows it stopped at its end, true-shuffle goes on.
	expect((await h.hub.state()).continueAfter).toMatchObject({ trackId: b, due: false });
	const p = h.fake.user("mika").player;
	p.isPlaying = true;
	await h.hub.sync(new RequestBudget(8), { force: true });
	await h.listen(4_000);
	p.isPlaying = false;
	p.progressMs = d;
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

type Run = Awaited<ReturnType<typeof outsidePlaying>>;

/** Another outside song (not in the saved deck). */
function other(h: Run["h"], b: string, deckUri: string): string {
	return [...h.fake.tracks.keys()].find(
		(id) => id !== b && !h.fake.playlists.get(deckUri.split(":")[2]!)!.items.includes(id),
	)!;
}

/** Nothing started, the saved place kept, and the listener told how to go on. */
async function cancelled(h: Run["h"], calls: number, s: Run["s"], sid: number) {
	expect(h.fake.calls.slice(calls).filter((x) => x.startsWith(PLAY))).toEqual([]);
	const r = (await h.hub.state()).continueAfter?.result;
	expect(r).toMatchObject({ ok: false });
	expect(r?.message).toMatch(/startet nichts von selbst/);
	expect(r?.message).toMatch(/TrueShuffle fortsetzen/);
	expect(r?.message).not.toMatch(/Du hast selbst/);
	expect(h.hub.savedSession(sid)!.sessionId).toBe(s.sessionId);
}

// Spotify's autoplay, a crossfade and a song the listener picks right at the
// end look the same from here: none of them proves the song ran out, so none
// is cut (PR39 re-review). Before 1.3.2 autoplay went on; 1.3.2 cancels.
it("ends on its own and Spotify's autoplay begins another: nothing is cut, it says so", async () => {
	const { h, b, s, sid } = await outsidePlaying();
	h.fake.user("mika").player.autoplay = true;
	await h.hub.continueAfter(b);
	const calls = h.fake.calls.length;
	await h.listen(h.fake.tracks.get(b)!.durationMs);
	await h.listen(60_000);
	expect(h.fake.current()).not.toBe(b);
	await cancelled(h, calls, s, sid);
	expect((await h.hub.state()).continueAfter?.result?.message).toMatch(/Der Song ist vorbei/);
});

for (const early of [12_000, 8_000, 500]) {
	it(`a next song that begins ${early} ms before the end (crossfade or picked): nothing is cut, it says so`, async () => {
		const { h, b, s, sid } = await outsidePlaying();
		await h.hub.continueAfter(b);
		const calls = h.fake.calls.length;
		const d = h.fake.tracks.get(b)!.durationMs;
		await h.listen(d - 60_000 - early);
		const next = other(h, b, s.contextUri);
		h.fake.playSong("mika", next);
		await h.listen(60_000);
		expect(h.fake.current()).toBe(next);
		await h.listen(2 * 60_000);
		await cancelled(h, calls, s, sid);
	});
}

for (const before of [1_001, 1_000, 999, 500, 1]) {
	it(`a song picked by hand ${before} ms before the end is never cut (PR39 re-review R132-PICK)`, async () => {
		const { h, b, s, sid } = await outsidePlaying();
		await h.hub.continueAfter(b);
		const d = h.fake.tracks.get(b)!.durationMs;
		await h.listen(d - 60_000 - before);
		const chosen = other(h, b, s.contextUri);
		h.fake.playSong("mika", chosen);
		const calls = h.fake.calls.length;
		await h.listen(60_000);
		expect(h.fake.current()).toBe(chosen);
		await cancelled(h, calls, s, sid);
	});
}

// The song ends on its own and Spotify leaves it paused at its start (no
// autoplay): nothing is started, and the listener is told at once, not after
// a 45-minute wait with a wrong reason (PR39 re-review F1).
it("ends on its own, Spotify leaves it paused at its start: cancelled at once, honestly", async () => {
	const { h, b, s, sid } = await outsidePlaying();
	h.fake.user("mika").player.autoplay = false;
	await h.hub.continueAfter(b);
	const calls = h.fake.calls.length;
	await h.listen(h.fake.tracks.get(b)!.durationMs - 60_000 + 5_000);
	expect(h.fake.current()).toBe(b);
	expect(h.fake.user("mika").player.isPlaying).toBe(false);
	await h.listen(3 * 60_000);
	await cancelled(h, calls, s, sid);
	expect((await h.hub.state()).continueAfter?.result?.message).toMatch(/Die Wiedergabe steht/);
});

it("paused by hand 200 ms before the end and left: after the wait it says it stands, not that it ran long", async () => {
	const { h, b, s, sid } = await outsidePlaying();
	await h.hub.continueAfter(b);
	const d = h.fake.tracks.get(b)!.durationMs;
	await h.listen(d - 60_000 - 200);
	h.fake.pause("mika");
	const calls = h.fake.calls.length;
	await h.listen(50 * 60_000);
	await cancelled(h, calls, s, sid);
	const message = (await h.hub.state()).continueAfter?.result?.message;
	expect(message).toMatch(/Die Wiedergabe steht/);
	expect(message).not.toMatch(/länger als erwartet/);
});

for (const which of ["same", "other"] as const) {
	for (const looked of [false, true]) {
		it(`paused by hand, then the ${which} song paused at its start (${looked ? "seen in between" : "unseen"}): nothing is started (PR39 re-review R132-PAUSED-REWIND)`, async () => {
			const { h, b, s, sid } = await outsidePlaying();
			await h.hub.continueAfter(b);
			const d = h.fake.tracks.get(b)!.durationMs;
			await h.listen(d - 60_000 - 5_000);
			const p = h.fake.user("mika").player;
			h.fake.pause("mika");
			if (looked) await h.hub.sync(new RequestBudget(8), { force: true });
			if (which === "other") {
				h.fake.playSong("mika", other(h, b, s.contextUri));
				h.fake.pause("mika");
			}
			p.progressMs = 0;
			const calls = h.fake.calls.length;
			await h.listen(10 * 60_000);
			expect(h.fake.calls.slice(calls).filter((x) => x.startsWith(PLAY))).toEqual([]);
			expect(p.isPlaying).toBe(false);
			if (which === "other") await cancelled(h, calls, s, sid);
		});
	}
}

for (const before of [2_001, 2_000, 1_999, 1_000]) {
	it(`paused by hand ${before} ms before the end: nothing is started (PR36 review R131-PAUSE)`, async () => {
		const { h, b } = await outsidePlaying();
		await h.hub.continueAfter(b);
		const d = h.fake.tracks.get(b)!.durationMs;
		await h.listen(d - 60_000 - before);
		h.fake.pause("mika");
		const calls = h.fake.calls.length;
		await h.listen(60_000);
		expect(h.fake.calls.slice(calls).filter((x) => x.startsWith(PLAY))).toEqual([]);
		expect(h.fake.user("mika").player.progressMs).toBe(d - before);
	});
}

for (const before of [5_000, 12_000]) {
	it(`a song picked by hand ${before / 1000} s before the end is never cut (PR36 review R131-PICK)`, async () => {
		const { h, b, s } = await outsidePlaying();
		await h.hub.continueAfter(b);
		const d = h.fake.tracks.get(b)!.durationMs;
		await h.listen(d - 60_000 - before);
		const chosen = [...h.fake.tracks.keys()].find(
			(id) => id !== b && !h.fake.playlists.get(s.contextUri.split(":")[2]!)!.items.includes(id),
		)!;
		h.fake.playSong("mika", chosen);
		const calls = h.fake.calls.length;
		await h.listen(60_000);
		expect(h.fake.calls.slice(calls).filter((x) => x.startsWith(PLAY))).toEqual([]);
		expect(h.fake.current()).toBe(chosen);
	});
}

for (const before of [15_000, 20_000]) {
	it(`a song picked ${before / 1000} s before the end and seen 3 s later is never cut (red-team T3)`, async () => {
		const { h, b, s } = await outsidePlaying();
		await h.hub.continueAfter(b);
		const d = h.fake.tracks.get(b)!.durationMs;
		await h.listen(d - 60_000 - before);
		const c = [...h.fake.tracks.keys()].find(
			(id) => id !== b && !h.fake.playlists.get(s.contextUri.split(":")[2]!)!.items.includes(id),
		)!;
		h.fake.playSong("mika", c);
		await h.listen(3_000);
		const calls = h.fake.calls.length;
		// The app is open: a look sees C three seconds in, well before B's end.
		await h.hub.sync(new RequestBudget(8), { force: true });
		await h.listen(60_000);
		expect(h.fake.current()).toBe(c);
		await h.listen(3 * 60_000);
		expect(h.fake.calls.slice(calls).filter((x) => x.startsWith(PLAY))).toEqual([]);
		expect((await h.hub.state()).continueAfter?.result).toMatchObject({ ok: false });
	});
}
