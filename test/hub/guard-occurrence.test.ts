/**
 * An old rating never moves a newer play already running — not at once and
 * not at a later look of the station guard (CTO, 2026-10-15: "Bei nicht
 * sicher zuordenbarer Wiedergabe kein automatisches Next aus alter
 * Bewertung"). The rating itself stays song-wide: the next play of the song
 * that begins after it is moved on as before (robustness.test.ts). The real
 * HubCore against the Spotify stand-in; synthetic data only.
 *
 * Takes over the evidence probe TRUE-SHUFFLE-CTO-RATE-SERVER-20261015/probes/
 * later-guard-boundary.test.ts (which expected the later "next") as a
 * regression expecting none.
 */
import { expect, it } from "vitest";
import { MINUTE_MS } from "../../src/core/types";
import type { Occurrence } from "../../src/worker/hub/hub";
import { RequestBudget } from "../../src/worker/spotify/client";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

const observe = async (h: H) => {
	h.clock.t += 1000;
	await h.hub.sync(new RequestBudget(25), { force: true });
};
/**
 * A minute of real playback later (the stand-in moves on, the hub's own looks
 * fire), then one more look: past the guard's own one-minute pause for a song.
 */
const laterLook = async (h: H) => {
	await h.listen(61_000);
	await observe(h);
};
/** How long each song was heard every time it left the player, from the stand-in's side. */
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
const nexts = (h: H) => h.fake.calls.filter((c) => c === "POST /v1/me/player/next").length;
const occurrenceOf = (h: H, sid: number): Occurrence => {
	const s = h.hub.savedSession(sid)!;
	return { sessionId: s.sessionId, entryId: s.entryIds[s.currentIndex]! };
};

/** Station 1 holds only A, station 2 seven other songs; A plays, confirmed. */
async function aPlaying() {
	const h = await onboarded({ tracks: 8, playlists: [1, 7] });
	const sid = h.stationIds[0]!;
	expect(await h.hub.play(sid)).toMatchObject({ ok: true });
	await observe(h);
	return { h, sid, a: h.fake.current()!, first: occurrenceOf(h, sid) };
}

/** B, then an explicitly new queue of station 1: A again, a new play. */
async function newPlayOfA(h: H, sid: number, a: string) {
	const before = h.hub.savedSession(sid)!.sessionId;
	expect(await h.hub.play(h.stationIds[1]!)).toMatchObject({ ok: true });
	await observe(h);
	expect(h.fake.current()).not.toBe(a);
	expect(await h.hub.play(sid, null, { newQueue: true, sessionId: before })).toMatchObject({
		ok: true,
	});
	await observe(h);
	expect(h.fake.current()).toBe(a);
	expect(h.hub.savedSession(sid)!.sessionId).not.toBe(before);
	expect(h.hub.savedSession(sid)!.pending?.kind).not.toBe("next");
}

const late = {
	"thumb bound to the first play": (h: H, a: string, first: Occurrence) =>
		h.hub.thumb(a, -1, undefined, first),
	"thumb naming no play (the rating sheet)": (h: H, a: string) =>
		h.hub.thumb(a, -1, undefined, null),
	"thumb by the old direct call (no binding argument)": (h: H, a: string) => h.hub.thumb(a, -1),
	"retest bound to the first play": (h: H, a: string, first: Occurrence) =>
		h.hub.retestVerdict(a, false, undefined, first),
	"retest by the old direct call (no binding argument)": (h: H, a: string) =>
		h.hub.retestVerdict(a, false),
};

for (const [name, answer] of Object.entries(late))
	it(`a late ${name}, arriving while a newer play of A runs: stored, and A is moved on neither at once nor at a later look`, async () => {
		const { h, sid, a, first } = await aPlaying();
		await newPlayOfA(h, sid, a);
		const before = nexts(h);
		const r = await answer(h, a, first);
		expect(r).toMatchObject({ skipped: false });
		if (name.startsWith("thumb")) expect(h.hub.memory(a).thumb).toBe(-1);
		expect(nexts(h) - before).toBe(0);
		await laterLook(h);
		await laterLook(h);
		expect(nexts(h) - before).toBe(0);
		expect(h.fake.current()).toBe(a);
	});

it("the play spared runs out, also over a restart; the same song coming up again after the rating is moved on", async () => {
	const h = await onboarded({ tracks: 600 });
	const sid = h.stationIds[0]!;
	expect((await h.hub.play(sid)).ok).toBe(true);
	await h.listen(5 * MINUTE_MS);
	const p = h.fake.user().player;
	const order = p.order.slice();
	const at = p.index;
	const x = h.fake.current()!;
	const heard = earsOn(h);
	const before = nexts(h);
	// Rated while this play of X runs, naming no play (the rating sheet): stored, the play spared.
	expect(await h.hub.thumb(x, -1, undefined, null)).toEqual({ skipped: false });
	expect(h.hub.memory(x).thumb).toBe(-1);
	h.restart();
	await observe(h);
	// A minute of real playback with looks: X plays on.
	await laterLook(h);
	expect(h.fake.current()).toBe(x);
	expect(nexts(h) - before).toBe(0);
	// X runs out by itself: it leaves the player once, heard to its end, never skipped.
	await h.listen(5 * MINUTE_MS);
	await observe(h);
	expect(h.fake.current()).not.toBe(x);
	expect(heard.get(x)?.length).toBe(1);
	expect(heard.get(x)![0]).toBeGreaterThan(30_000);
	expect(nexts(h) - before).toBe(0);
	// Later the same loaded order again, from the song before X (X itself when it is first):
	// X begins anew after the rating — a future play, moved on as every song turned down
	// (robustness.test.ts).
	expect(order[at]).toBe(x);
	Object.assign(p, {
		order: order.slice(),
		index: Math.max(0, at - 1),
		progressMs: 0,
		listenedMs: 0,
	});
	await h.listen(20 * MINUTE_MS);
	expect(heard.get(x)?.length).toBe(2);
	expect(heard.get(x)![1]).toBeLessThan(30_000);
	expect(nexts(h) - before).toBeGreaterThanOrEqual(1);
	void sid;
});

// Coordinator reproduction (TRUE-SHUFFLE-GUARD-FIX-20261015/coordinator-probes/
// unobserved-new-play.test.ts, red on the first fix 4a6ce…): the newer play of A has
// begun, but the hub has not seen it yet when the old answer arrives.
it("a late answer while a newer play of A runs that the hub has not observed yet: the later guard spares it too", async () => {
	const h = await onboarded({ tracks: 8, playlists: [1, 7] });
	const sid = h.stationIds[0]!;
	expect(await h.hub.play(sid)).toMatchObject({ ok: true });
	await observe(h);
	const a = h.fake.current()!;
	const bound = occurrenceOf(h, sid);
	expect(await h.hub.play(h.stationIds[1]!)).toMatchObject({ ok: true });
	await observe(h);
	const b = h.fake.current()!;
	expect(b).not.toBe(a);
	expect(await h.hub.play(sid, null, { newQueue: true, sessionId: bound.sessionId })).toMatchObject(
		{ ok: true },
	);
	// The new play of A runs; the hub's next look at the player is still due.
	expect(h.fake.current()).toBe(a);
	expect(h.hub.savedSession(sid)!.sessionId).not.toBe(bound.sessionId);
	const heard = JSON.parse(
		h.sql.first<{ v: string }>("SELECT v FROM kv WHERE k = 'heard_song'")!.v,
	);
	expect(heard.id).toBe(b);
	const before = nexts(h);
	expect(await h.hub.thumb(a, -1, undefined, bound)).toEqual({ skipped: false });
	expect(h.hub.memory(a).thumb).toBe(-1);
	expect(nexts(h)).toBe(before);
	h.clock.t += 61_000;
	await observe(h);
	expect(nexts(h) - before, "late guard must spare the already-running unobserved newer play").toBe(
		0,
	);
	expect(h.fake.current(), "new A must remain").toBe(a);
	// And with real playback a minute on, still the same.
	await laterLook(h);
	expect(nexts(h) - before).toBe(0);
	expect(h.fake.current()).toBe(a);
});

// Coordinator reproductions (coordinator-probes/spare-lifetime.test.ts, red on the second
// fix 50ed3e…): the spared play keeps its protection for as long as it runs.
async function sparedNewA() {
	const h = await onboarded({ tracks: 100, playlists: [1, 99] });
	const sid = h.stationIds[0]!;
	expect(await h.hub.play(sid)).toMatchObject({ ok: true });
	await observe(h);
	const a = h.fake.current()!;
	const bound = occurrenceOf(h, sid);
	expect(await h.hub.play(h.stationIds[1]!)).toMatchObject({ ok: true });
	await observe(h);
	expect(await h.hub.play(sid, null, { newQueue: true, sessionId: bound.sessionId })).toMatchObject(
		{ ok: true },
	);
	await observe(h);
	expect(h.fake.current()).toBe(a);
	expect(h.hub.savedSession(sid)!.sessionId).not.toBe(bound.sessionId);
	const before = nexts(h);
	expect(await h.hub.thumb(a, -1, undefined, bound)).toEqual({ skipped: false });
	return { h, a, before };
}

it("the spared newer play stays protected across a two-day pause and a restart", async () => {
	const { h, a, before } = await sparedNewA();
	h.fake.pause();
	await observe(h);
	const atPause = h.hub.savedSession()!;
	h.clock.t += 2 * 24 * 60 * 60 * 1000;
	h.restart();
	h.fake.user().player.isPlaying = true;
	await observe(h);
	expect(h.hub.savedSession()!.sessionId).toBe(atPause.sessionId);
	expect(
		nexts(h) - before,
		"age alone must not turn an old rating into a next of the spared play",
	).toBe(0);
	expect(h.fake.current()).toBe(a);
});

it("unrelated later ratings cannot take the protection from the spared play", async () => {
	const { h, a, before } = await sparedNewA();
	for (const other of [...h.fake.tracks.keys()].filter((x) => x !== a).slice(0, 55))
		await h.hub.thumb(other, -1);
	expect(h.fake.current()).toBe(a);
	expect(nexts(h)).toBe(before);
	h.clock.t += 61_000;
	await observe(h);
	expect(nexts(h) - before, "bookkeeping must keep the spared play protected").toBe(0);
	expect(h.fake.current()).toBe(a);
});

// Coordinator reproduction (coordinator-probes/history-late-rating.test.ts, red on 50ed3e…):
// the Verlauf rates only (CTO-04), also after the station guard's later look.
it("a late Nie wieder from the Verlauf on a newer play of A: stored with its receipt, A runs on; sent again or taken back, nothing moves", async () => {
	const h = await onboarded({ tracks: 8, playlists: [1, 7] });
	const sid = h.stationIds[0]!;
	expect(await h.hub.play(sid)).toMatchObject({ ok: true });
	await observe(h);
	const a = h.fake.current()!;
	const first = h.hub.savedSession(sid)!;
	// Prepared on the first play of A; nothing rates A in between (basis 0).
	const input = { actionId: "history_late_a_01", trackId: a, value: -1, basis: 0 };
	expect(await h.hub.play(h.stationIds[1]!)).toMatchObject({ ok: true });
	await observe(h);
	expect(await h.hub.play(sid, null, { newQueue: true, sessionId: first.sessionId })).toMatchObject(
		{ ok: true },
	);
	await observe(h);
	expect(h.fake.current()).toBe(a);
	expect(h.hub.savedSession(sid)!.sessionId).not.toBe(first.sessionId);
	const before = nexts(h);
	const r = await h.hub.rateFromHistory(input);
	expect(r).toMatchObject({ kind: "done", receipt: { value: -1, skip: "none" } });
	expect(h.hub.memory(a).thumb).toBe(-1);
	expect(nexts(h)).toBe(before);
	h.clock.t += 61_000;
	await observe(h);
	expect(nexts(h) - before, "history rate-only must remain no-next after a later look").toBe(0);
	expect(h.fake.current()).toBe(a);
	// Sent again (a lost answer): answered from the receipt, the note not renewed, nothing moves.
	const note = () => h.sql.first<{ v: string }>("SELECT v FROM kv WHERE k = 'guard_spare'")?.v;
	const noted = note();
	expect(await h.hub.rateFromHistory(input)).toEqual(r);
	expect(note()).toBe(noted);
	await laterLook(h);
	expect(nexts(h) - before).toBe(0);
	expect(h.fake.current()).toBe(a);
	// Taken back: the rating before comes back; playback untouched.
	const u = (await h.hub.undoHistoryRating(input.actionId)).receipt!;
	expect(u.undo?.outcome).toBe("undone");
	expect(h.hub.memory(a).thumb).toBe(0);
	await laterLook(h);
	expect(nexts(h) - before).toBe(0);
	expect(h.fake.current()).toBe(a);
});

// Coordinator reproduction (coordinator-probes/rating-fence-atomicity.test.ts, red on 92961032…):
// the rating, its receipt and the note sparing the running play commit together, before any wait.
for (const path of ["thumb", "history"] as const)
	it(`a ${path} "Nie wieder" whose spare note cannot be stored stores nothing: no rating, no receipt, no later next`, async () => {
		const h = await onboarded({ tracks: 8, playlists: [1, 7] });
		const sid = h.stationIds[0]!;
		expect(await h.hub.play(sid)).toMatchObject({ ok: true });
		await observe(h);
		const a = h.fake.current()!;
		const bound = occurrenceOf(h, sid);
		expect(await h.hub.play(h.stationIds[1]!)).toMatchObject({ ok: true });
		await observe(h);
		expect(
			await h.hub.play(sid, null, { newQueue: true, sessionId: bound.sessionId }),
		).toMatchObject({ ok: true });
		await observe(h);
		const before = nexts(h);
		const old = h.hub.memory(a).thumb;
		const seq = h.hub.history(200).find((e) => e.id === a)?.rated ?? 0;
		const run = h.sql.run.bind(h.sql);
		let injected = 0;
		h.sql.run = (sql: string, ...args: unknown[]) => {
			if (args[0] === "guard_spare") {
				injected++;
				throw new Error("injected safety-note storage failure");
			}
			return run(sql, ...(args as never[]));
		};
		const actionId = "atomic_history_a_01";
		await expect(
			path === "thumb"
				? h.hub.thumb(a, -1, undefined, bound)
				: h.hub.rateFromHistory({ actionId, trackId: a, value: -1, basis: 0 }),
		).rejects.toThrow("injected safety-note storage failure");
		h.sql.run = run;
		expect(injected).toBeGreaterThan(0);
		expect(h.hub.memory(a).thumb, "rating and its spare note commit together").toBe(old);
		expect(h.hub.history(200).find((e) => e.id === a)?.rated ?? 0).toBe(seq);
		if (path === "history") expect(h.hub.historyRatingReceipt(actionId).receipt).toBeNull();
		h.restart();
		expect(h.hub.memory(a).thumb).toBe(old);
		h.clock.t += 61_000;
		await observe(h);
		expect(nexts(h) - before, "a failed rating never turns into a later next").toBe(0);
		expect(h.fake.current()).toBe(a);
		// Sent again with storage working: stored once, with its note; still no next.
		const again =
			path === "thumb"
				? await h.hub.thumb(a, -1, undefined, bound)
				: await h.hub.rateFromHistory({
						actionId,
						trackId: a,
						value: -1,
						basis: h.hub.history(200).find((e) => e.id === a)?.rated ?? 0,
					});
		expect(again).toMatchObject(path === "thumb" ? { skipped: false } : { kind: "done" });
		expect(h.hub.memory(a).thumb).toBe(-1);
		await laterLook(h);
		expect(nexts(h) - before).toBe(0);
		expect(h.fake.current()).toBe(a);
	});

it("bound to the play running now: skipped once, and nothing more", async () => {
	const { h, a, first } = await aPlaying();
	const before = nexts(h);
	expect(await h.hub.thumb(a, -1, undefined, first)).toEqual({ skipped: true });
	expect(nexts(h) - before).toBe(1);
	await laterLook(h);
	expect(nexts(h) - before).toBe(1);
});
