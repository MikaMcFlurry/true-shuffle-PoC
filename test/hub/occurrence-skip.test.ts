/**
 * "Nie wieder" / "Eher nicht" from Home skip only the occurrence they were
 * given on (CTO playback boundary, 2026-10-15). The real HubCore against the
 * Spotify stand-in. The scenario of the external regression (coordinator,
 * TRUE-SHUFFLE-CTO-LIBRARY-20261015/reproduction) is taken over with the
 * occurrence the page now sends (`bound`); the unbound HTTP form is covered in
 * test/worker/rating-userhub.test.ts and e2e/cto-history-import.spec.ts.
 * The decisive check runs inside the serialized command after the player
 * read; a player moved by someone else between that check and Spotify's
 * "next" is outside what a local check can exclude (Spotify's "next" names no
 * entry).
 */
import { expect, it, vi } from "vitest";
import type { Occurrence } from "../../src/worker/hub/hub";
import { RequestBudget } from "../../src/worker/spotify/client";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

const observe = async (h: H) => {
	h.clock.t += 1000;
	await h.hub.sync(new RequestBudget(25), { force: true });
};
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

/** B, then an explicitly new queue of station 1: A again, a new session and entry. */
async function newOccurrenceOfA(h: H, sid: number, a: string, first: Occurrence) {
	expect(await h.hub.play(h.stationIds[1]!)).toMatchObject({ ok: true });
	await observe(h);
	expect(h.fake.current()).not.toBe(a);
	expect(await h.hub.play(sid, null, { newQueue: true, sessionId: first.sessionId })).toMatchObject(
		{ ok: true },
	);
	await observe(h);
	expect(h.fake.current()).toBe(a);
	const now = occurrenceOf(h, sid);
	expect(now.sessionId).not.toBe(first.sessionId);
	expect(now.entryId).not.toBe(first.entryId);
	expect(h.hub.savedSession(sid)!.pending?.kind).not.toBe("next");
	return now;
}

it("control: bound to the occurrence playing now, Nie wieder stores and skips it once", async () => {
	const { h, a, first } = await aPlaying();
	const before = nexts(h);
	const answer = await h.hub.thumb(a, -1, undefined, first);
	expect(h.hub.memory(a).thumb).toBe(-1);
	expect(answer).toEqual({ skipped: true });
	expect(nexts(h) - before).toBe(1);
});

for (const kind of ["thumb", "retest"] as const)
	it(`a late ${kind} bound to the first A, delivered after B and a new A: stored, the new A not skipped`, async () => {
		const { h, sid, a, first } = await aPlaying();
		let deliver!: () => void;
		const gate = new Promise<void>((r) => {
			deliver = r;
		});
		const pending = gate.then(() =>
			kind === "thumb"
				? h.hub.thumb(a, -1, undefined, first)
				: h.hub.retestVerdict(a, false, undefined, first),
		);
		await newOccurrenceOfA(h, sid, a, first);
		const before = nexts(h);
		deliver();
		const answer = await pending;
		// Song-wide: the rating holds. Never: a move of the new occurrence.
		if (kind === "thumb") expect(h.hub.memory(a).thumb).toBe(-1);
		expect(answer).toEqual({ skipped: false });
		expect(nexts(h) - before).toBe(0);
		expect(h.fake.current()).toBe(a);
	});

it("the player moves on while the skip's fresh read is held: the next song is not skipped", async () => {
	const { h, a, first } = await aPlaying();
	const handle = h.fake.handle.bind(h.fake);
	let held!: () => void;
	const release = new Promise<void>((r) => {
		held = r;
	});
	let reads = 0;
	let movedTo: string | null = null;
	h.fake.handle = async (req: Request) => {
		if (req.method === "GET" && new URL(req.url).pathname === "/v1/me/player" && reads++ === 0) {
			await release;
			// Someone else moved Spotify on meanwhile; the read sees it.
			h.fake.skip();
			movedTo = h.fake.current();
		}
		return handle(req);
	};
	const before = nexts(h);
	const answer = h.hub.thumb(a, -1, undefined, first);
	await vi.waitFor(() => expect(reads).toBe(1), { timeout: 5_000, interval: 5 });
	held();
	const r = await answer;
	h.fake.handle = handle;
	expect(movedTo).not.toBe(a);
	expect(r.skipped).toBe(false);
	expect(nexts(h) - before).toBe(0);
	expect(h.fake.current()).toBe(movedTo);
	expect(h.hub.memory(a).thumb).toBe(-1);
});

it("waiting behind a command that starts a new A: the skip, checked when its turn comes, leaves the new A", async () => {
	const { h, sid, a, first } = await aPlaying();
	// B first, so the queued new start of station 1 brings A back as a new occurrence.
	expect(await h.hub.play(h.stationIds[1]!)).toMatchObject({ ok: true });
	await observe(h);
	expect(await h.hub.play(sid)).toMatchObject({ ok: true });
	await observe(h);
	expect(h.fake.current()).toBe(a);
	const shown = occurrenceOf(h, sid);
	// A new queue of station 1 is on its way and holds the command line.
	const handle = h.fake.handle.bind(h.fake);
	let open!: () => void;
	const gate = new Promise<void>((r) => {
		open = r;
	});
	let held = false;
	h.fake.handle = async (req: Request) => {
		if (!held && req.method === "PUT" && new URL(req.url).pathname === "/v1/me/player/play") {
			held = true;
			await gate;
		}
		return handle(req);
	};
	const restart = h.hub.play(sid, null, { newQueue: true, sessionId: shown.sessionId });
	// Wait until the restart really sits in the provider call (not a fixed time).
	await vi.waitFor(() => expect(held).toBe(true), { timeout: 5_000, interval: 5 });
	// "Nie wieder" on the A shown now: its skip waits behind the restart.
	const before = nexts(h);
	const answer = h.hub.thumb(a, -1, undefined, shown);
	open();
	expect(await restart).toMatchObject({ ok: true });
	const r = await answer;
	h.fake.handle = handle;
	expect(h.hub.savedSession(sid)!.sessionId).not.toBe(shown.sessionId);
	expect(r.skipped).toBe(false);
	expect(nexts(h) - before).toBe(0);
	expect(h.fake.current()).toBe(a);
	void first;
});

it("unbound (an answer naming no occurrence): rated, never skipped, nothing read", async () => {
	const { h, a } = await aPlaying();
	const before = nexts(h);
	const reads = h.fake.calls.filter((c) => c === "GET /v1/me/player").length;
	expect(await h.hub.thumb(a, -1, undefined, null)).toEqual({ skipped: false });
	expect(await h.hub.retestVerdict(a, false, undefined, null)).toEqual({ skipped: false });
	expect(h.hub.memory(a).thumb).toBe(-1);
	expect(nexts(h) - before).toBe(0);
	expect(h.fake.calls.filter((c) => c === "GET /v1/me/player").length).toBe(reads);
	expect(h.fake.current()).toBe(a);
});

it("bound to another song's entry, or to an entry not playing: rated, nothing skipped", async () => {
	const { h, sid, a, first } = await aPlaying();
	await newOccurrenceOfA(h, sid, a, first);
	const other = [...h.fake.tracks.keys()].find((t) => t !== a)!;
	const before = nexts(h);
	expect(await h.hub.thumb(other, -1, undefined, occurrenceOf(h, sid))).toEqual({
		skipped: false,
	});
	expect(await h.hub.thumb(a, -1, undefined, { ...first, entryId: "made-up" })).toEqual({
		skipped: false,
	});
	expect(nexts(h) - before).toBe(0);
	expect(h.fake.current()).toBe(a);
});
