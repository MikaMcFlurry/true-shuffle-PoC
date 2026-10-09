import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "../../src/core/types";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

/** Time passes with no look at the player at all. */
const quiet = (h: H, ms: number) => {
	h.clock.t += ms;
	h.fake.advance(ms, h.fake.user().id);
};

/** Into the run, then a look that sees a new song begin. */
async function seenBeginning(h: H) {
	const sid = h.stationIds[0]!;
	expect((await h.hub.play(sid)).ok).toBe(true);
	await h.listen(10 * MINUTE_MS);
	const x = h.fake.current()!;
	while (h.fake.current() === x) await h.listen(1_000);
	await h.hub.state({ live: true, refresh: true });
	const saved = h.hub.savedSession(sid)!;
	const t = h.fake.current()!;
	return { sid, t, index: saved.currentIndex, progress: saved.progressMs! };
}

/** The phone is gone: no player to see any more. */
function gone(h: H) {
	const p = h.fake.user().player;
	p.isPlaying = false;
	p.deviceId = "gone";
}

describe("Fortsetzen after a song Spotify listed as heard to its end", () => {
	it("a song seen at 0:01 and then played out unseen: Fortsetzen goes on with the next song", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const { sid, t, index, progress } = await seenBeginning(h);
		expect(progress).toBeLessThan(5_000);
		const next = h.hub.savedSession(sid)!;
		const nextEntry = next.entryIds[index + 1];
		// It plays to its end, the next one begins, and the phone goes away.
		quiet(h, 180_000 - progress + 1_000);
		expect(h.fake.current()).not.toBe(t);
		gone(h);
		await h.hub.state({ live: true, refresh: true });
		await h.listen(5 * MINUTE_MS);
		const after = h.hub.savedSession(sid)!;
		expect(after.currentIndex).toBe(index + 1);
		expect(after.entryIds[after.currentIndex]).toBe(nextEntry);
		expect(after.progressMs).toBe(0);
		expect(h.hub.history(20).filter((e) => e.id === t).length).toBe(1);
	});

	it("several songs played out unseen move the place along with them", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const { sid, index, progress } = await seenBeginning(h);
		// This one and the next two run out; the fourth plays 10 s, then nothing.
		quiet(h, 180_000 - progress + 2 * 180_000 + 10_000);
		gone(h);
		await h.hub.state({ live: true, refresh: true });
		await h.listen(5 * MINUTE_MS);
		const after = h.hub.savedSession(sid)!;
		expect(after.currentIndex).toBe(index + 3);
		expect(after.progressMs).toBe(0);
	});

	it("a song skipped after 40 s, unseen, stays the place: the listing does not prove its end", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const { sid, t, index, progress } = await seenBeginning(h);
		quiet(h, 40_000 - progress);
		h.fake.skip();
		quiet(h, 5_000);
		gone(h);
		await h.hub.state({ live: true, refresh: true });
		await h.listen(5 * MINUTE_MS);
		// Listed (40 s heard), but before its end: unknown progress keeps the same song.
		expect(h.hub.history(20).filter((e) => e.id === t).length).toBe(1);
		const after = h.hub.savedSession(sid)!;
		expect(after.currentIndex).toBe(index);
		expect(after.progressMs).toBe(progress);
	});

	it("the same song listed from outside the playlist moves nothing", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const { sid, t, index, progress } = await seenBeginning(h);
		gone(h);
		await h.hub.state({ live: true, refresh: true });
		// Played on its own in Spotify, to its end, later.
		const u = h.fake.user();
		u.player.deviceId = u.devices[0]!.id;
		h.fake.playSong(u.id, t);
		quiet(h, 181_000);
		gone(h);
		await h.hub.state({ live: true, refresh: true });
		await h.listen(5 * MINUTE_MS);
		const after = h.hub.savedSession(sid)!;
		expect(after.currentIndex).toBe(index);
		expect(after.progressMs).toBe(progress);
	});

	it("a look at the playlist right now decides, not the listing", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const { sid, index, progress } = await seenBeginning(h);
		// It runs out and the next one plays on, seen by the next look.
		quiet(h, 180_000 - progress + 20_000);
		await h.hub.state({ live: true, refresh: true });
		const after = h.hub.savedSession(sid)!;
		expect(after.currentIndex).toBe(index + 1);
		// The look's own position, not the start the listing would give.
		expect(after.progressMs).toBeGreaterThan(10_000);
	});

	it("Fortsetzen then starts the next song from its beginning", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const { sid, t, progress } = await seenBeginning(h);
		quiet(h, 180_000 - progress + 1_000);
		const u = h.fake.user();
		gone(h);
		await h.hub.state({ live: true, refresh: true });
		await h.listen(5 * MINUTE_MS);
		const after = h.hub.savedSession(sid)!;
		u.player.deviceId = u.devices[0]!.id;
		expect((await h.hub.play(sid)).ok).toBe(true);
		expect(h.fake.current()).not.toBe(t);
		expect(h.hub.savedSession(sid)!.currentIndex).toBe(after.currentIndex);
		expect(u.player.progressMs).toBeLessThan(2_000);
	});
});
