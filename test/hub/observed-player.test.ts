/**
 * The song Spotify actually plays, outside true-shuffle's order (NP06,
 * 2026-10-17): shown, rated and moved on by its own observed target, while
 * the saved true-shuffle place stays. The real HubCore against the Spotify
 * stand-in. Only the existing reconciliation (checkpoint/advanceListed) and
 * explicit rating effects may change the saved session; an observed action
 * never journals a true-shuffle "next" and never writes playlists or starts
 * true-shuffle playback.
 *
 * Open boundary (NP-OB-01): a future true-shuffle song queued by hand in
 * Spotify plays with the same id and context as the real continuation; the
 * provider reports nothing that tells them apart, and the existing
 * reconciliation moves the saved place onto it. The fixture below records
 * that baseline behaviour; keeping the place would need a reconciliation
 * change that is not part of this task (see evidence REVIEW.md).
 */
import { expect, it, vi } from "vitest";
import type { ObservedTarget } from "../../src/shared/api";
import type { Occurrence } from "../../src/worker/hub/hub";
import { RequestBudget } from "../../src/worker/spotify/client";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

const look = async (h: H, ms = 1000) => {
	h.clock.t += ms;
	await h.hub.sync(new RequestBudget(25), { force: true, observationOnly: true, playerOnly: true });
};
const count = (h: H, call: string) => h.fake.calls.filter((c) => c === call).length;
const NEXT = "POST /v1/me/player/next";
const PLAY = "PUT /v1/me/player/play";
const writes = (h: H) =>
	h.fake.calls.filter((c) => /^(PUT|POST|DELETE) \/v1\/(playlists|me\/playlists)/.test(c)).length;

/** What only the existing reconciliation and explicit ratings may change. */
function tsState(h: H, sid: number) {
	const s = h.hub.savedSession(sid)!;
	return {
		sessionId: s.sessionId,
		entryIds: s.entryIds.join(),
		currentIndex: s.currentIndex,
		progressMs: s.progressMs,
		observedAt: s.observedAt,
		pending: s.pending,
		orderRevision: s.orderRevision,
		playbackEpoch: s.playbackEpoch,
	};
}

/** Station 1 holds 6 songs, station 2 the other 6; A (station 1, first entry) plays, confirmed. */
async function aPlaying() {
	const h = await onboarded({ tracks: 12, playlists: [6, 6] });
	const sid = h.stationIds[0]!;
	expect(await h.hub.play(sid)).toMatchObject({ ok: true });
	await look(h);
	const a = h.fake.current()!;
	const s = h.hub.savedSession(sid)!;
	const occurrence: Occurrence = { sessionId: s.sessionId, entryId: s.entryIds[s.currentIndex]! };
	const outside = [...h.fake.tracks.keys()].filter(
		(id) => !h.fake.playlists.get(s.contextUri.split(":")[2]!)?.items.includes(id),
	);
	return { h, sid, a, occurrence, outside };
}

const observedOf = async (h: H) => (await h.hub.state()).observed!;

it("A confirmed by the existing reconciliation: shown as the station's own, no observed target", async () => {
	const { h, a } = await aPlaying();
	const o = await observedOf(h);
	expect(o).toMatchObject({ state: "playing", attribution: "station", target: null });
	expect(o.track?.id).toBe(a);
});

it("external B in another context: B shown with device, progress once, target; A stays saved", async () => {
	const { h, sid, outside } = await aPlaying();
	const before = tsState(h, sid);
	const b = outside[0]!;
	h.fake.playSong("mika", b);
	h.fake.user("mika").player.progressMs = 40_000;
	await look(h);
	h.clock.t += 7_000;
	h.fake.advance(7_000);
	const st = await h.hub.state();
	const o = st.observed!;
	expect(o.state).toBe("playing");
	expect(o.attribution).toBe("outside");
	expect(o.track?.id).toBe(b);
	expect(o.track?.imageUrl).toMatch(/^https:\/\/img\.example\//);
	expect(o.device).toEqual({ id: "mika-phone", name: "iPhone", volume: 50, volumeControl: true });
	// The hub's position already holds the time since the look: 40 s seen + 7 s since,
	// once (added twice it would read 54 s).
	expect(o.progressMs).toBe(47_000);
	expect(o.target).toMatchObject({ kind: "observed", account: "mika", trackId: b });
	expect(o.target!.deviceId).toBe("mika-phone");
	// The saved place: untouched apart from the existing status bookkeeping.
	expect(tsState(h, sid)).toEqual(before);
	expect(st.session?.status).toBe("external");
});

it("B queued by hand inside the station's own context: unconfirmed, never the station's", async () => {
	const { h, sid, outside } = await aPlaying();
	const b = outside[0]!;
	h.fake.user("mika").player.userQueue.push(b);
	const a = h.fake.current()!;
	h.fake.advance(h.fake.tracks.get(a)!.durationMs - h.fake.user("mika").player.progressMs);
	h.clock.t += 0;
	expect(h.fake.current()).toBe(b);
	expect(h.fake.user("mika").player.contextUri).toBe(h.hub.savedSession(sid)!.contextUri);
	await look(h);
	const o = await observedOf(h);
	expect(o.track?.id).toBe(b);
	expect(o.attribution).toBe("unconfirmed");
	expect(o.target?.trackId).toBe(b);
});

it("observed next of B in the station's context: device-bound next, no TS journal, no writes, no TS play", async () => {
	const { h, sid, outside } = await aPlaying();
	const b = outside[0]!;
	h.fake.user("mika").player.userQueue.push(b);
	const a = h.fake.current()!;
	h.fake.advance(h.fake.tracks.get(a)!.durationMs - h.fake.user("mika").player.progressMs);
	await look(h);
	const target = (await observedOf(h)).target!;
	const before = tsState(h, sid);
	const w = writes(h);
	const plays = count(h, PLAY);
	const nexts = count(h, NEXT);
	const reads = count(h, "GET /v1/me/player");
	const r = await h.hub.observedNext(target);
	expect(r).toMatchObject({ ok: true });
	expect(count(h, NEXT) - nexts).toBe(1);
	expect(count(h, "GET /v1/me/player") - reads).toBe(1);
	expect(h.fake.calls).toContain(NEXT);
	expect(writes(h)).toBe(w);
	expect(count(h, PLAY)).toBe(plays);
	// No pending true-shuffle "next" journal, no epoch, nothing in the saved place.
	const after = tsState(h, sid);
	expect(after.pending).toBeNull();
	expect(after).toEqual(before);
	expect(h.fake.current()).not.toBe(b);
});

it("baseline defect, fixed: an unfenced next on a foreign B in the station's context journals no TS next", async () => {
	const { h, sid, outside } = await aPlaying();
	const b = outside[0]!;
	h.fake.user("mika").player.userQueue.push(b);
	const a = h.fake.current()!;
	h.fake.advance(h.fake.tracks.get(a)!.durationMs - h.fake.user("mika").player.progressMs);
	await look(h);
	const handle = h.fake.handle.bind(h.fake);
	let journal: unknown = "unread";
	h.fake.handle = async (req: Request) => {
		if (req.method === "POST" && new URL(req.url).pathname === "/v1/me/player/next")
			journal = h.hub.savedSession(sid)!.pending;
		return handle(req);
	};
	expect(await h.hub.playerAction("next")).toMatchObject({ ok: true });
	h.fake.handle = handle;
	expect(journal).toBeNull();
	expect(h.hub.savedSession(sid)!.pending).toBeNull();
});

it("a stale B target after C: refused before any next; a fresh look shows C", async () => {
	const { h, outside } = await aPlaying();
	const [b, c] = outside;
	h.fake.playSong("mika", b!);
	await look(h);
	const target = (await observedOf(h)).target!;
	h.fake.playSong("mika", c!);
	const nexts = count(h, NEXT);
	const r = await h.hub.observedNext(target);
	expect(r.ok).toBe(false);
	expect(r.observedChanged).toBe(true);
	expect(count(h, NEXT)).toBe(nexts);
	expect((await observedOf(h)).track?.id).toBe(c);
});

it("device change between view and click: refused, nothing skipped", async () => {
	const { h, outside } = await aPlaying();
	h.fake.user("mika").devices.push({
		id: "mika-desk",
		name: "Desk",
		type: "Computer",
		restricted: false,
	});
	h.fake.playSong("mika", outside[0]!);
	await look(h);
	const target = (await observedOf(h)).target!;
	h.fake.user("mika").player.deviceId = "mika-desk";
	const nexts = count(h, NEXT);
	const r = await h.hub.observedNext(target);
	expect(r).toMatchObject({ ok: false, observedChanged: true });
	expect(count(h, NEXT)).toBe(nexts);
});

it("A -> B -> A again and a backwards seek: the earlier play's target no longer moves anything", async () => {
	const { h, outside } = await aPlaying();
	const b = outside[0]!;
	h.fake.playSong("mika", b);
	h.fake.user("mika").player.progressMs = 90_000;
	await look(h);
	const first = (await observedOf(h)).target!;
	// The same song begun again (seek to its start): another play.
	h.fake.user("mika").player.progressMs = 2_000;
	await look(h, 5_000);
	const second = (await observedOf(h)).target!;
	expect(second.trackId).toBe(b);
	expect(second.playId).not.toBe(first.playId);
	const nexts = count(h, NEXT);
	expect(await h.hub.observedNext(first)).toMatchObject({ ok: false, observedChanged: true });
	expect(count(h, NEXT)).toBe(nexts);
	expect(await h.hub.observedNext(second)).toMatchObject({ ok: true });
	expect(count(h, NEXT) - nexts).toBe(1);
});

it("double next on one target: the second is checked by a fresh look and refused", async () => {
	const { h, outside } = await aPlaying();
	h.fake.playSong("mika", outside[0]!);
	h.fake.user("mika").player.autoplay = true;
	await look(h);
	const target = (await observedOf(h)).target!;
	const nexts = count(h, NEXT);
	const [one, two] = await Promise.all([h.hub.observedNext(target), h.hub.observedNext(target)]);
	expect(one).toMatchObject({ ok: true });
	expect(two).toMatchObject({ ok: false, observedChanged: true });
	expect(count(h, NEXT) - nexts).toBe(1);
});

it("an unclear provider answer to next is reported uncertain and never repeated", async () => {
	const { h, outside } = await aPlaying();
	h.fake.playSong("mika", outside[0]!);
	await look(h);
	const target = (await observedOf(h)).target!;
	h.fake.failWhen = (m, p) =>
		m === "POST" && p === "/me/player/next" ? { status: 503, body: undefined } : null;
	const nexts = count(h, NEXT);
	const r = await h.hub.observedNext(target);
	h.fake.failWhen = null;
	expect(r).toMatchObject({ ok: false, uncertain: true });
	expect(count(h, NEXT) - nexts).toBe(1);
});

for (const [name, status, retry] of [
	["forbidden skip", 403, false],
	["rate limited", 429, true],
	["missing permission", 403, false],
] as const)
	it(`${name} on the observed next: not skipped, said why, the saved place unchanged`, async () => {
		const { h, sid, outside } = await aPlaying();
		h.fake.playSong("mika", outside[0]!);
		await look(h);
		const target = (await observedOf(h)).target!;
		const before = tsState(h, sid);
		h.fake.failWhen = (m, p) =>
			m === "POST" && p === "/me/player/next"
				? {
						status,
						headers: retry ? { "retry-after": "30" } : undefined,
						body: {
							error: {
								status,
								message:
									name === "missing permission"
										? "Insufficient client scope"
										: "Player command failed: Restriction violated",
							},
						},
					}
				: null;
		const r = await h.hub.observedNext(target);
		h.fake.failWhen = null;
		expect(r.ok).toBe(false);
		expect(r.uncertain).toBeFalsy();
		expect(r.error?.message).toBeTruthy();
		expect(tsState(h, sid)).toEqual(before);
	});

it("offline: the fresh look fails, nothing is skipped", async () => {
	const { h, outside } = await aPlaying();
	h.fake.playSong("mika", outside[0]!);
	await look(h);
	const target = (await observedOf(h)).target!;
	h.fake.failWhen = (m, p) => (m === "GET" && p === "/me/player" ? { status: 503 } : null);
	const nexts = count(h, NEXT);
	const r = await h.hub.observedNext(target);
	h.fake.failWhen = null;
	expect(r.ok).toBe(false);
	expect(count(h, NEXT)).toBe(nexts);
});

it("paused, no device and unreadable items: never a target, never A as current", async () => {
	const { h, outside } = await aPlaying();
	h.fake.playSong("mika", outside[0]!);
	h.fake.pause();
	await look(h);
	let o = await observedOf(h);
	expect(o.state).toBe("paused");
	expect(o.track?.id).toBe(outside[0]);
	// No device: Spotify answers 204.
	h.fake.user("mika").player.deviceId = null;
	await look(h);
	o = await observedOf(h);
	expect(o).toMatchObject({ state: "none", track: null, target: null });
	// An episode, an ad, a local file, nothing: read as such, not shown as a song.
	for (const item of [
		{ type: "episode", id: "6rqhFgbbKwnb9MLmUQDhG6", name: "Pod", duration_ms: 1000 },
		{ type: "track", id: null, is_local: true, name: "Local", duration_ms: 1000 },
		null,
	]) {
		h.fake.failWhen = (m, p) =>
			m === "GET" && p === "/me/player"
				? {
						status: 200,
						body: {
							device: {
								id: "mika-phone",
								is_active: true,
								is_restricted: false,
								name: "iPhone",
								type: "Smartphone",
							},
							is_playing: true,
							progress_ms: 10,
							context: null,
							item,
							currently_playing_type: item ? item.type : "ad",
						},
					}
				: null;
		await look(h);
		h.fake.failWhen = null;
		o = await observedOf(h);
		expect(o).toMatchObject({ state: "unsupported", track: null, target: null });
	}
});

it("a failed read after B: the observation is unknown, not B and not A", async () => {
	const { h, outside } = await aPlaying();
	h.fake.playSong("mika", outside[0]!);
	await look(h);
	h.fake.failWhen = (m, p) => (m === "GET" && p === "/me/player" ? { status: 503 } : null);
	await look(h, 5_000);
	h.fake.failWhen = null;
	const o = await observedOf(h);
	expect(o).toMatchObject({ state: "unknown", track: null, target: null });
});

it("Nie wieder on the observed B: stored song-wide, B skipped once, the saved place kept", async () => {
	const { h, sid, outside } = await aPlaying();
	const b = outside[0]!;
	h.fake.playSong("mika", b);
	await look(h);
	const target = (await observedOf(h)).target!;
	const before = tsState(h, sid);
	const nexts = count(h, NEXT);
	const r = await h.hub.thumb(b, -1, undefined, target);
	expect(h.hub.memory(b).thumb).toBe(-1);
	expect(r).toMatchObject({ skipped: true, observedSkip: "skipped" });
	expect(count(h, NEXT) - nexts).toBe(1);
	expect(tsState(h, sid)).toEqual(before);
	// Taken back with the same target: the rating only.
	expect(await h.hub.thumb(b, 0, undefined, target)).toEqual({ skipped: false });
	expect(h.hub.memory(b).thumb).toBe(0);
});

it("Nie wieder on B after B is over: stored, the skip reported as no longer applicable, C untouched", async () => {
	const { h, outside } = await aPlaying();
	const [b, c] = outside;
	h.fake.playSong("mika", b!);
	await look(h);
	const target = (await observedOf(h)).target!;
	h.fake.playSong("mika", c!);
	const nexts = count(h, NEXT);
	const r = await h.hub.thumb(b!, -1, undefined, target);
	expect(h.hub.memory(b!).thumb).toBe(-1);
	expect(h.hub.memory(c!).thumb).toBe(0);
	expect(r).toMatchObject({ skipped: false, observedSkip: "over" });
	expect(count(h, NEXT)).toBe(nexts);
	expect(h.fake.current()).toBe(c);
});

it("Favorit on B outside every station and library: stored song-wide, no Spotify library write", async () => {
	const { h, outside } = await aPlaying();
	const b = outside[0]!;
	h.fake.playSong("mika", b);
	await look(h);
	const target = (await observedOf(h)).target!;
	const calls = h.fake.calls.length;
	expect(await h.hub.thumb(b, 1, undefined, target)).toEqual({ skipped: false });
	expect(h.hub.memory(b).thumb).toBe(1);
	expect(h.fake.calls.slice(calls).filter((x) => /\/me\/(tracks|library)/.test(x))).toEqual([]);
	expect(h.fake.user("mika").liked).not.toContain(b);
	// The rating reaches the observed song as the page reads it.
	expect((await observedOf(h)).track?.thumb).toBe(1);
});

it("a target naming another song than the one rated is refused before anything is stored", async () => {
	const { h, outside } = await aPlaying();
	h.fake.playSong("mika", outside[0]!);
	await look(h);
	const target = (await observedOf(h)).target!;
	await expect(h.hub.thumb(outside[1]!, -1, undefined, target)).rejects.toThrow();
	expect(h.hub.memory(outside[1]!).thumb).toBe(0);
});

it("another account's target is refused", async () => {
	const { h, outside } = await aPlaying();
	h.fake.playSong("mika", outside[0]!);
	await look(h);
	const target: ObservedTarget = { ...(await observedOf(h)).target!, account: "someone-else" };
	const nexts = count(h, NEXT);
	expect(await h.hub.observedNext(target)).toMatchObject({ ok: false, observedChanged: true });
	expect(count(h, NEXT)).toBe(nexts);
});

it("A -> external B -> C -> back to the station: only the existing reconciliation returns, no extra writes", async () => {
	const { h, sid, a, outside } = await aPlaying();
	const before = tsState(h, sid);
	const w = writes(h);
	const plays = count(h, PLAY);
	const [b, c] = outside;
	h.fake.playSong("mika", b!);
	await look(h);
	expect((await observedOf(h)).track?.id).toBe(b);
	const r = await h.hub.observedNext((await observedOf(h)).target!);
	expect(r.ok).toBe(true);
	h.fake.playSong("mika", c!);
	await look(h, 2_000);
	expect((await observedOf(h)).track?.id).toBe(c);
	expect(tsState(h, sid)).toEqual(before);
	expect(writes(h)).toBe(w);
	expect(count(h, PLAY)).toBe(plays);
	// The listener resumes true-shuffle in Spotify itself (no command from here).
	const s = h.hub.savedSession(sid)!;
	h.fake.startContext("mika", s.contextUri, s.currentIndex, "mika-phone", false);
	await look(h);
	const o = await observedOf(h);
	expect(o).toMatchObject({ attribution: "station", target: null });
	expect(o.track?.id).toBe(a);
	expect(tsState(h, sid).currentIndex).toBe(before.currentIndex);
});

it("observed display adds no Spotify request of its own", async () => {
	const { h, outside } = await aPlaying();
	h.fake.playSong("mika", outside[0]!);
	await look(h);
	const calls = h.fake.calls.length;
	await h.hub.state();
	await h.hub.state();
	expect(h.fake.calls.length).toBe(calls);
});

it("OPEN BOUNDARY NP-OB-01: a future TS song queued by hand plays like the continuation; baseline moves the saved place", async () => {
	const { h, sid } = await aPlaying();
	const s = h.hub.savedSession(sid)!;
	const row = h.hub.sessionView(sid)!;
	const future = row.queue[3]!.track.id;
	const before = s.currentIndex;
	h.fake.user("mika").player.userQueue.push(future);
	const a = h.fake.current()!;
	h.fake.advance(h.fake.tracks.get(a)!.durationMs - h.fake.user("mika").player.progressMs);
	expect(h.fake.current()).toBe(future);
	await look(h);
	// Indistinguishable for the hub: same id, same context, no offset.
	const o = await observedOf(h);
	expect(o.track?.id).toBe(future);
	// Recorded baseline: the existing reconciliation moves the saved place 3 ahead.
	expect(h.hub.savedSession(sid)!.currentIndex).toBe(before + 3);
	// The page is never told it was queued by hand (no such attribution exists).
	expect(["station", "unconfirmed"]).toContain(o.attribution);
});

it("the observed target is exactly the discriminated shape", async () => {
	const { h, outside } = await aPlaying();
	h.fake.playSong("mika", outside[0]!);
	await look(h);
	const t = (await observedOf(h)).target!;
	expect(Object.keys(t).sort()).toEqual(
		["account", "deviceId", "kind", "observationId", "playId", "trackId"].sort(),
	);
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// One transport per unconfirmed observed play (TS-NP-OBSERVED-COR1-261017).
// Spotify accepted the first "next" (or its answer was unclear or lost after
// it may have acted), yet the following successful looks still show the same
// play of B on the same device: no further "next" — explicit or from
// "Nie wieder" — may reach Spotify for it, also after a reload or from a
// second tab (a hub restarted from its stored state). A new, confirmed play
// stays operable; a clear provider refusal frees the play again.
// Fault injection is local to these tests: the shared stand-in is unchanged.

type FirstAnswer = "accepted" | "server error" | "lost answer";

/** Spotify's answer to the next "next": accepted without moving yet, a 5xx, or lost after it arrived. */
function firstNextAnswers(h: H, mode: FirstAnswer) {
	const fake = h.fake;
	const original = fake.handle.bind(fake);
	let left = 1;
	fake.failWhen = (m, p) => {
		if (m !== "POST" || p !== "/me/player/next" || left <= 0) return null;
		left--;
		return mode === "server error" ? { status: 503 } : { status: 200, body: {} };
	};
	let lose = mode === "lost answer";
	fake.handle = async (req: Request) => {
		const isNext = req.method === "POST" && new URL(req.url).pathname === "/v1/me/player/next";
		const res = await original(req);
		if (isNext && lose) {
			lose = false;
			throw new TypeError("fetch failed: connection reset after the request was sent");
		}
		return res;
	};
	return () => {
		fake.failWhen = null;
		fake.handle = original;
	};
}

async function bObserved() {
	const base = await aPlaying();
	const [b, c] = base.outside;
	base.h.fake.playSong("mika", b!);
	await look(base.h);
	const target = (await observedOf(base.h)).target!;
	expect(target.trackId).toBe(b);
	return { ...base, b: b!, c: c!, target };
}

/** A later successful look still showing the same play of B on the same device. */
async function stillB(h: H, b: string, target: ObservedTarget) {
	h.clock.t += 2_000;
	h.fake.advance(2_000);
	await look(h, 0);
	const o = await observedOf(h);
	expect(o.track?.id).toBe(b);
	expect(o.device?.id).toBe(target.deviceId);
	expect(o.target?.playId).toBe(target.playId);
	return o.target!;
}

const sequences: Record<string, (h: H, b: string, t: ObservedTarget) => Promise<unknown[]>> = {
	"Next -> Next": async (h, b, t) => {
		const first = await h.hub.observedNext(t);
		return [first, await h.hub.observedNext(await stillB(h, b, t))];
	},
	"Nie wieder -> Next": async (h, b, t) => {
		const first = await h.hub.thumb(b, -1, undefined, t);
		return [first, await h.hub.observedNext(await stillB(h, b, t))];
	},
	"Next -> Nie wieder": async (h, b, t) => {
		const first = await h.hub.observedNext(t);
		return [first, await h.hub.thumb(b, -1, undefined, await stillB(h, b, t))];
	},
	"Nie wieder, answer lost -> Nie wieder again -> Next": async (h, b, t) => {
		const first = await h.hub.thumb(b, -1, undefined, t);
		const again = await h.hub.thumb(b, -1, undefined, await stillB(h, b, t));
		return [first, again, await h.hub.observedNext(await stillB(h, b, t))];
	},
};

for (const mode of ["accepted", "server error", "lost answer"] as const)
	for (const [name, run] of Object.entries(sequences))
		it(`COR1 fence, first next ${mode}, ${name}: at most one transport for B; reload/second tab; new C operable`, async () => {
			const { h, sid, b, c, target } = await bObserved();
			const before = tsState(h, sid);
			const nexts = count(h, NEXT);
			const restore = firstNextAnswers(h, mode);
			const results = await run(h, b, target);
			restore();
			expect(count(h, NEXT) - nexts).toBe(1);
			// Spotify never moved: B is still what every look shows.
			expect(h.fake.current()).toBe(b);
			// What came after the first transport sent nothing and says so.
			for (const r of results.slice(1))
				if (r && typeof r === "object" && "skipped" in r)
					expect(r).toMatchObject({ skipped: false, observedSkip: "pending" });
				else expect(r).toMatchObject({ ok: false, observedPending: true });
			// A second tab / a reload: the hub (restarted from its stored state) still knows.
			h.restart();
			const tab2 = await stillB(h, b, target);
			expect((await observedOf(h)).nextPending).toBe(true);
			expect(await h.hub.observedNext(tab2)).toMatchObject({ ok: false, observedPending: true });
			expect(await h.hub.thumb(b, -1, undefined, tab2)).toMatchObject({
				skipped: false,
				observedSkip: "pending",
			});
			expect(count(h, NEXT) - nexts).toBe(1);
			// The rating holds song-wide; the saved true-shuffle place is untouched.
			expect(h.hub.memory(b).thumb).toBe(-1);
			expect(tsState(h, sid)).toEqual(before);
			// A new, confirmed play (C): operable at once, exactly one transport.
			h.fake.playSong("mika", c);
			await look(h);
			const oc = await observedOf(h);
			expect(oc.track?.id).toBe(c);
			expect(oc.nextPending).toBeUndefined();
			expect(await h.hub.observedNext(oc.target!)).toMatchObject({ ok: true });
			expect(count(h, NEXT) - nexts).toBe(2);
		});

it("COR1 fence: a running first next — a second and a Nie wieder given meanwhile send nothing", async () => {
	const { h, b, target } = await bObserved();
	const nexts = count(h, NEXT);
	const restore = firstNextAnswers(h, "accepted");
	const [one, two, three] = await Promise.all([
		h.hub.observedNext(target),
		h.hub.observedNext(target),
		h.hub.thumb(b, -1, undefined, target),
	]);
	restore();
	expect(count(h, NEXT) - nexts).toBe(1);
	expect(h.fake.current()).toBe(b);
	expect(one).toMatchObject({ ok: true });
	expect(two).toMatchObject({ ok: false, observedPending: true });
	expect(three).toMatchObject({ skipped: false, observedSkip: "pending" });
});

it("COR1 fence: a clear provider refusal acted on nothing — the same play may be tried again", async () => {
	const { h, b, target } = await bObserved();
	const nexts = count(h, NEXT);
	h.fake.failWhen = (m, p) =>
		m === "POST" && p === "/me/player/next"
			? {
					status: 403,
					body: { error: { status: 403, message: "Player command failed: Restriction violated" } },
				}
			: null;
	const refused = await h.hub.observedNext(target);
	h.fake.failWhen = null;
	expect(refused.ok).toBe(false);
	expect(refused.error?.message).toBeTruthy();
	expect(refused.uncertain).toBeFalsy();
	expect(refused.observedPending).toBeUndefined();
	expect((await observedOf(h)).nextPending).toBeUndefined();
	const again = await h.hub.observedNext(await stillB(h, b, target));
	expect(again).toMatchObject({ ok: true });
	expect(count(h, NEXT) - nexts).toBe(2);
});

it("COR1 fence: B played again later (a new play of the same song) is operable again", async () => {
	const { h, b, c, target } = await bObserved();
	const nexts = count(h, NEXT);
	const restore = firstNextAnswers(h, "accepted");
	expect(await h.hub.observedNext(target)).toMatchObject({ ok: true });
	restore();
	h.fake.playSong("mika", c);
	await look(h);
	h.fake.playSong("mika", b);
	await look(h);
	const o = await observedOf(h);
	expect(o.track?.id).toBe(b);
	expect(o.target!.playId).not.toBe(target.playId);
	expect(o.nextPending).toBeUndefined();
	expect(await h.hub.observedNext(o.target!)).toMatchObject({ ok: true });
	expect(count(h, NEXT) - nexts).toBe(2);
});

it("COR1 late B answer: B's held Nie wieder after C was confirmed as Favorit leaves C's rating and play alone", async () => {
	const { h, b, c, target } = await bObserved();
	h.fake.playSong("mika", c);
	await look(h);
	const oc = await observedOf(h);
	expect(oc.track?.id).toBe(c);
	await h.hub.thumb(c, 1, undefined, oc.target!);
	const nexts = count(h, NEXT);
	expect(await h.hub.thumb(b, -1, undefined, target)).toMatchObject({
		skipped: false,
		observedSkip: "over",
	});
	expect(h.hub.memory(b).thumb).toBe(-1);
	expect(h.hub.memory(c).thumb).toBe(1);
	expect(count(h, NEXT)).toBe(nexts);
	expect(h.fake.current()).toBe(c);
});

// ---------------------------------------------------------------------------
// The open "next" outlives a look it does not apply to (TS-NP-OBSERVED-COR2-261017).
// A look showing no player (204) or the same play on another device says
// nothing about whether the "next" sent for B on D acted: back on the same
// unconfirmed play of B on D, it stays held — after a reload and a restarted
// hub alike. The same play on D2 is its own target: a "next" sent there is
// held for D2 and leaves D's open one in place. A clear refusal, and a really
// new play (C, or B begun again), stay operable. Every "next" request is
// recorded with the device it names (local to these tests).

const DESK = "mika-desk";

/** The device every "next" request names, in order (device_id or "active"). */
function nextDevices(h: H) {
	const fake = h.fake;
	const original = fake.handle.bind(fake);
	const seen: string[] = [];
	fake.handle = async (req: Request) => {
		const url = new URL(req.url);
		if (req.method === "POST" && url.pathname.endsWith("/v1/me/player/next"))
			seen.push(url.searchParams.get("device_id") ?? "active");
		return original(req);
	};
	return seen;
}

/** A look while Spotify knows no player (204), then the same play on D again. */
async function viaNoPlayer(h: H) {
	const p = h.fake.user("mika").player;
	const device = p.deviceId;
	p.deviceId = null;
	await look(h, 2_000);
	expect((await observedOf(h)).state).toBe("none");
	p.deviceId = device;
}

/** A look showing the same play of B on another device (D2), then D again. */
async function viaDesk(h: H, b: string) {
	const u = h.fake.user("mika");
	if (!u.devices.some((d) => d.id === DESK))
		u.devices.push({ id: DESK, name: "Desk", type: "Computer", restricted: false });
	const device = u.player.deviceId;
	u.player.deviceId = DESK;
	await look(h, 2_000);
	const o = await observedOf(h);
	expect(o.track?.id).toBe(b);
	expect(o.device?.id).toBe(DESK);
	u.player.deviceId = device;
	return o;
}

const excursions = {
	"B/D -> no player (204) -> B/D": (h: H, _b: string) => viaNoPlayer(h),
	"B/D -> D2 -> B/D": (h: H, b: string) => viaDesk(h, b),
} as const;

const firsts = {
	Next: (h: H, _b: string, t: ObservedTarget) => h.hub.observedNext(t),
	"Nie wieder": (h: H, b: string, t: ObservedTarget) => h.hub.thumb(b, -1, undefined, t),
} as const;

for (const mode of ["accepted", "server error", "lost answer"] as const)
	for (const [path, away] of Object.entries(excursions))
		for (const [firstName, first] of Object.entries(firsts))
			it(`COR2 return, first ${firstName} ${mode}, ${path}: still held — Next, Nie wieder, reload, second tab send nothing`, async () => {
				const { h, sid, b, c, target } = await bObserved();
				const before = tsState(h, sid);
				const devices = nextDevices(h);
				const restore = firstNextAnswers(h, mode);
				await first(h, b, target);
				restore();
				expect(devices).toEqual(["mika-phone"]);
				expect(h.fake.current()).toBe(b);
				await away(h, b);
				// Back on D: the same unconfirmed play of B.
				const back = await stillB(h, b, target);
				expect((await observedOf(h)).nextPending).toBe(true);
				expect(await h.hub.observedNext(back)).toMatchObject({ ok: false, observedPending: true });
				expect(await h.hub.thumb(b, -1, undefined, back)).toMatchObject({
					skipped: false,
					observedSkip: "pending",
				});
				// Twice away and back, then a reload / second tab on a restarted hub.
				await away(h, b);
				h.restart();
				const tab2 = await stillB(h, b, target);
				expect((await observedOf(h)).nextPending).toBe(true);
				expect(await h.hub.observedNext(tab2)).toMatchObject({ ok: false, observedPending: true });
				expect(await h.hub.thumb(b, -1, undefined, tab2)).toMatchObject({
					skipped: false,
					observedSkip: "pending",
				});
				// At most one transport for the original target, ever.
				expect(devices).toEqual(["mika-phone"]);
				expect(h.fake.current()).toBe(b);
				expect(h.hub.memory(b).thumb).toBe(-1);
				expect(tsState(h, sid)).toEqual(before);
				// A really new play (C): operable at once.
				h.fake.playSong("mika", c);
				await look(h);
				const oc = await observedOf(h);
				expect(oc.track?.id).toBe(c);
				expect(oc.nextPending).toBeUndefined();
				expect(await h.hub.observedNext(oc.target!)).toMatchObject({ ok: true });
				expect(devices).toEqual(["mika-phone", "mika-phone"]);
			});

it("COR2 D2 is its own target: its next is held for D2 and leaves D's open one; back on either sends nothing", async () => {
	const { h, b, target } = await bObserved();
	const devices = nextDevices(h);
	let restore = firstNextAnswers(h, "accepted");
	expect(await h.hub.observedNext(target)).toMatchObject({ ok: true });
	restore();
	// The same play on D2: not held there, operable once, by D2's own target.
	const onDesk = await viaDesk(h, b);
	expect(onDesk.nextPending).toBeUndefined();
	expect(onDesk.target).toMatchObject({ trackId: b, deviceId: DESK, playId: target.playId });
	h.fake.user("mika").player.deviceId = DESK;
	restore = firstNextAnswers(h, "lost answer");
	expect((await h.hub.observedNext(onDesk.target!)).ok).toBe(false);
	restore();
	expect(devices).toEqual(["mika-phone", DESK]);
	await look(h, 2_000);
	expect((await observedOf(h)).nextPending).toBe(true);
	expect(await h.hub.observedNext((await observedOf(h)).target!)).toMatchObject({
		observedPending: true,
	});
	// Back on D: D's open next was not overwritten by D2's.
	h.fake.user("mika").player.deviceId = "mika-phone";
	const back = await stillB(h, b, target);
	expect((await observedOf(h)).nextPending).toBe(true);
	expect(await h.hub.observedNext(back)).toMatchObject({ ok: false, observedPending: true });
	expect(await h.hub.thumb(b, -1, undefined, back)).toMatchObject({ observedSkip: "pending" });
	// Via no player, a restarted hub, then D2 and D again: both still held.
	await viaNoPlayer(h);
	h.restart();
	await viaDesk(h, b);
	h.fake.user("mika").player.deviceId = DESK;
	await look(h, 2_000);
	expect((await observedOf(h)).nextPending).toBe(true);
	expect(await h.hub.thumb(b, -1, undefined, (await observedOf(h)).target!)).toMatchObject({
		observedSkip: "pending",
	});
	h.fake.user("mika").player.deviceId = "mika-phone";
	expect(await h.hub.observedNext(await stillB(h, b, target))).toMatchObject({
		observedPending: true,
	});
	expect(devices).toEqual(["mika-phone", DESK]);
	expect(h.fake.current()).toBe(b);
});

it("COR2 a clear refusal of D2's next frees D2 only; D's open next stays held", async () => {
	const { h, b, target } = await bObserved();
	const devices = nextDevices(h);
	const restore = firstNextAnswers(h, "accepted");
	expect(await h.hub.observedNext(target)).toMatchObject({ ok: true });
	restore();
	const onDesk = await viaDesk(h, b);
	h.fake.user("mika").player.deviceId = DESK;
	h.fake.failWhen = (m, p) =>
		m === "POST" && p === "/me/player/next"
			? {
					status: 403,
					body: { error: { status: 403, message: "Player command failed: Restriction violated" } },
				}
			: null;
	const refused = await h.hub.observedNext(onDesk.target!);
	h.fake.failWhen = null;
	expect(refused.ok).toBe(false);
	expect(refused.uncertain).toBeFalsy();
	await look(h, 2_000);
	expect((await observedOf(h)).nextPending).toBeUndefined();
	h.fake.user("mika").player.deviceId = "mika-phone";
	const back = await stillB(h, b, target);
	expect((await observedOf(h)).nextPending).toBe(true);
	expect(await h.hub.observedNext(back)).toMatchObject({ observedPending: true });
	expect(devices).toEqual(["mika-phone", DESK]);
});

it("COR2 a clear refusal on D, then no player and back: the same play may be tried again", async () => {
	const { h, b, target } = await bObserved();
	const devices = nextDevices(h);
	h.fake.failWhen = (m, p) =>
		m === "POST" && p === "/me/player/next"
			? {
					status: 403,
					body: { error: { status: 403, message: "Player command failed: Restriction violated" } },
				}
			: null;
	const refused = await h.hub.observedNext(target);
	h.fake.failWhen = null;
	expect(refused).toMatchObject({ ok: false });
	expect(refused.uncertain).toBeFalsy();
	await viaNoPlayer(h);
	const back = await stillB(h, b, target);
	expect((await observedOf(h)).nextPending).toBeUndefined();
	expect(await h.hub.observedNext(back)).toMatchObject({ ok: true });
	expect(devices).toEqual(["mika-phone", "mika-phone"]);
});

it("COR2 after no player and D2, B begun again is a new play: operable, D's old hold gone", async () => {
	const { h, b, c, target } = await bObserved();
	const devices = nextDevices(h);
	const restore = firstNextAnswers(h, "accepted");
	expect(await h.hub.observedNext(target)).toMatchObject({ ok: true });
	restore();
	await viaNoPlayer(h);
	await viaDesk(h, b);
	h.fake.playSong("mika", c);
	await look(h);
	h.fake.playSong("mika", b);
	await look(h);
	const o = await observedOf(h);
	expect(o.track?.id).toBe(b);
	expect(o.device?.id).toBe("mika-phone");
	expect(o.target!.playId).not.toBe(target.playId);
	expect(o.nextPending).toBeUndefined();
	expect(await h.hub.observedNext(o.target!)).toMatchObject({ ok: true });
	expect(devices).toEqual(["mika-phone", "mika-phone"]);
});
