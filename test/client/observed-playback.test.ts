/**
 * What Home shows while Spotify plays something outside true-shuffle's
 * confirmed order (NP06, 2026-10-17), and how the store holds a "next" given
 * on it: the observed song as the main title with its own progress (the hub's
 * position already holds the time up to serverTime: added once), the saved
 * true-shuffle place apart; nothing current when no fresh look shows a song;
 * an observed command confirmed only by a later look, fenced by account.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { playbackView } from "../../src/client/playback-view";
import type {
	AppState,
	ObservedPlayer,
	ObservedTarget,
	SessionView,
	TrackView,
} from "../../src/shared/api";

const stateRequest = vi.hoisted(() => vi.fn());
vi.mock("../../src/client/api", () => ({
	ApiError: class extends Error {},
	api: { state: stateRequest },
}));

const T = 1_790_000_000_000;
const song = (id: string, name: string): TrackView => ({
	id,
	name,
	artists: "Artist",
	album: "Album",
	imageUrl: `https://img/${id}`,
	durationMs: 200_000,
	thumb: 0,
});
const A = song("AAAAAAAAAAAAAAAAAAAAAA", "Song A");
const A2 = song("AAAAAAAAAAAAAAAAAAAAA2", "Song A2");
const B = song("BBBBBBBBBBBBBBBBBBBBBB", "Song B");
const C = song("CCCCCCCCCCCCCCCCCCCCCC", "Song C");

const session = (status: SessionView["status"] = "external"): SessionView => ({
	sessionId: "s1",
	stationId: 1,
	entryId: "e0",
	orderRevision: 1,
	progressMs: 61_000,
	observedAt: T - 600_000,
	status,
	pending: false,
	queue: [
		{ entryId: "e0", track: A },
		{ entryId: "e1", track: A2 },
	],
});
const target = (t: TrackView, play = "1", account = "mika"): ObservedTarget => ({
	kind: "observed",
	account,
	trackId: t.id,
	deviceId: "phone",
	observationId: String(T),
	playId: `${t.id}:${play}`,
});
const observed = (o: Partial<ObservedPlayer> = {}): ObservedPlayer => ({
	state: "playing",
	checkedAt: T - 2_000,
	track: B,
	progressMs: 40_000,
	device: { id: "phone", name: "iPhone" },
	attribution: "outside",
	stationId: null,
	target: target(B),
	...o,
});
const app = (
	o?: ObservedPlayer,
	s: SessionView | null = session(),
	profile = "mika",
): AppState => ({
	session: s,
	profile: { id: profile, name: profile, imageUrl: null },
	onboarded: true,
	stations: [],
	nowPlaying: null,
	...(o ? { observed: o } : {}),
	guest: { active: false, until: null },
	warnings: [],
	jobs: [],
	history: { importedTracks: 0, importedAt: null, liveSince: null },
	aiSource: "off",
	serverTime: T,
});

it("external B: B is the main title, progress added once, A the separate saved place", () => {
	const v = playbackView(app(observed()), 1000, 1000 + 5_000, false);
	expect(v.source).toBe("observed");
	expect(v.track?.id).toBe(B.id);
	expect(v.track?.imageUrl).toBe(B.imageUrl);
	expect(v.entryId).toBeNull();
	// 40 s at serverTime + 5 s since the answer — not + (serverTime - checkedAt) again.
	expect(v.position).toBe(45_000);
	expect(v.estimating).toBe(true);
	expect(v.observed).toMatchObject({ attribution: "outside", deviceName: "iPhone" });
	expect(v.observed?.target).toEqual(target(B));
	expect(v.checkpoint).toEqual({ track: A, entryId: "e0", position: 61_000 });
});

it("B in the station's context, not confirmed: unconfirmed, never A as current", () => {
	const v = playbackView(
		app(observed({ attribution: "unconfirmed", stationId: 1 }), session("ambiguous")),
		0,
		0,
		false,
	);
	expect(v.source).toBe("observed");
	expect(v.observed?.attribution).toBe("unconfirmed");
	expect(v.track?.id).toBe(B.id);
	expect(v.checkpoint?.track.id).toBe(A.id);
});

it("confirmed by the station's reconciliation: true-shuffle's own view, as before", () => {
	const st = app(
		observed({ track: A, attribution: "station", stationId: 1, target: null }),
		session("active"),
	);
	const v = playbackView(st, 0, 0, false);
	expect(v.source).toBe("station");
	expect(v.track?.id).toBe(A.id);
	expect(v.entryId).toBe("e0");
	expect(v.checkpoint).toBeNull();
});

it("an older answer without an observation behaves exactly as before", () => {
	const v = playbackView(app(undefined, session("active")), 0, 0, false);
	expect(v).toMatchObject({
		source: "station",
		observed: null,
		checkpoint: null,
		unavailable: null,
	});
	expect(v.track?.id).toBe(A.id);
});

for (const state of ["none", "unknown", "unsupported"] as const)
	it(`${state}: nothing shown as current, A only as the saved place`, () => {
		const v = playbackView(
			app(observed({ state, track: null, progressMs: null, target: null, attribution: null })),
			0,
			0,
			false,
		);
		expect(v.source).toBe("unavailable");
		expect(v.unavailable).toBe(state);
		expect(v.track).toBeNull();
		expect(v.checkpoint?.track.id).toBe(A.id);
	});

it("paused B: no local counting; an old look is waited on, not estimated", () => {
	const paused = playbackView(app(observed({ state: "paused" })), 0, 30_000, false);
	expect(paused).toMatchObject({ playing: false, estimating: false, position: 40_000 });
	const old = playbackView(app(observed({ checkedAt: T - 200_000 })), 0, 0, false);
	expect(old).toMatchObject({ estimating: false, awaitingObservation: true });
	// The page lost its connection: B stays shown, held, never replaced by A.
	const offline = playbackView(app(observed()), 0, 10_000, true);
	expect(offline).toMatchObject({ source: "observed", estimating: false, position: 40_000 });
	expect(offline.track?.id).toBe(B.id);
});

it("a command on B holds B; a true-shuffle command holds the saved place", () => {
	const ob = { attribution: "outside" as const, deviceName: "iPhone", target: target(B) };
	const held = playbackView(app(observed({ track: C, target: target(C) })), 0, 0, false, {
		entryId: null,
		position: 41_000,
		track: B,
		projected: false,
		observed: ob,
	});
	expect(held).toMatchObject({ source: "observed", position: 41_000, estimating: false });
	expect(held.track?.id).toBe(B.id);
	const ts = playbackView(app(observed()), 0, 0, false, {
		entryId: "e0",
		position: 61_000,
		track: A,
		projected: false,
	});
	expect(ts.source).toBe("station");
	expect(ts.track?.id).toBe(A.id);
	expect(ts.position).toBe(61_000);
});

it("a Home Assistant session keeps its own view", () => {
	const s = {
		...session("active"),
		controller: { kind: "home-assistant" as const, deviceId: "ha" },
	};
	const v = playbackView(app(observed(), s), 0, 0, false);
	expect(v.source).toBe("station");
	expect(v.track?.id).toBe(A.id);
});

// ---------------------------------------------------------------------------
// The store's command slot for an observed "next".

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers();
	stateRequest.mockReset();
	vi.stubGlobal("window", {
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		addEventListener() {},
		removeEventListener() {},
	});
	vi.stubGlobal("document", {
		visibilityState: "visible",
		addEventListener() {},
		removeEventListener() {},
	});
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const frozenB = {
	entryId: null,
	position: 40_000,
	track: B,
	projected: false,
	observed: { attribution: "outside" as const, deviceName: "iPhone", target: target(B) },
};
const later = (o: Partial<ObservedPlayer>, profile = "mika", t = T + 5_000): AppState => ({
	...app(observed({ checkedAt: t, ...o }), session(), profile),
	serverTime: t,
});

it("Spotify's acknowledgement is not the confirmation: only a later look showing another play is", async () => {
	const { store } = await import("../../src/client/store");
	store.load = { kind: "ready", state: app(observed()) };
	const id = store.beginObserved(target(B), frozenB)!;
	expect(store.command).toMatchObject({ phase: "sending", observed: { trackId: B.id } });
	// One command at a time: a double tap starts nothing.
	expect(store.beginObserved(target(B), frozenB)).toBeNull();
	store.acceptCommand(id, { ok: true, acceptedAt: T + 1_000 });
	expect(store.command?.phase).toBe("accepted");
	// A look from before the answer, and the same play after it: still waiting.
	stateRequest.mockResolvedValueOnce(later({}, "mika", T + 500));
	await store.refresh(false, true);
	expect(store.command?.phase).toBe("accepted");
	stateRequest.mockResolvedValueOnce(later({}, "mika", T + 2_000));
	await store.refresh(false, true);
	expect(store.command?.phase).toBe("accepted");
	// C seen after the answer: confirmed.
	stateRequest.mockResolvedValueOnce(later({ track: C, target: target(C) }, "mika", T + 3_000));
	await store.refresh(false, true);
	expect(store.command).toBeNull();
});

it("an unclear answer is never repeated: the next look decides, the same play frees the key", async () => {
	const { store } = await import("../../src/client/store");
	store.load = { kind: "ready", state: app(observed()) };
	const id = store.beginObserved(target(B), frozenB)!;
	store.failCommand(id, "Spotify hat den Befehl noch nicht bestätigt.", true);
	expect(store.command?.phase).toBe("unconfirmed");
	stateRequest.mockResolvedValueOnce(later({ state: "unknown", track: null, target: null }));
	await store.refresh(true, false, true);
	expect(store.command?.phase).toBe("unconfirmed");
	stateRequest.mockResolvedValueOnce(later({}));
	await store.refresh(true, false, true);
	expect(store.command).toBeNull();
});

it("a refused (changed) target stays said until replaced; the key is not blocked", async () => {
	const { store } = await import("../../src/client/store");
	store.load = { kind: "ready", state: app(observed()) };
	const id = store.beginObserved(target(B), frozenB)!;
	store.acceptCommand(id, {
		ok: false,
		observedChanged: true,
		error: { code: "unknown", message: "Der angezeigte Song läuft so nicht mehr." },
	});
	expect(store.command).toMatchObject({
		phase: "failed",
		error: "Der angezeigte Song läuft so nicht mehr.",
	});
	stateRequest.mockResolvedValueOnce(later({ track: C, target: target(C) }));
	await store.refresh(false, true);
	expect(store.command?.phase).toBe("failed");
	expect(store.beginObserved(target(C), frozenB)).not.toBeNull();
});

it("account fences: another account's target never starts; a change of account clears the command", async () => {
	const { store } = await import("../../src/client/store");
	store.load = { kind: "ready", state: app(observed()) };
	expect(store.beginObserved(target(B, "1", "other"), frozenB)).toBeNull();
	const id = store.beginObserved(target(B), frozenB)!;
	store.acceptCommand(id, { ok: true, acceptedAt: T + 1_000 });
	stateRequest.mockResolvedValueOnce(later({ track: C, target: target(C, "1", "other") }, "other"));
	await store.refresh(false, true);
	expect(store.command).toBeNull();
	// Offline: nothing starts.
	store.stale = true;
	expect(store.beginObserved(target(C, "1", "other"), frozenB)).toBeNull();
});

it("a late state answer from before the command never confirms it", async () => {
	const { store } = await import("../../src/client/store");
	store.load = { kind: "ready", state: app(observed()) };
	let answer!: (s: AppState) => void;
	stateRequest.mockReturnValueOnce(new Promise<AppState>((r) => (answer = r)));
	const poll = store.refresh(true);
	const id = store.beginObserved(target(B), frozenB)!;
	store.acceptCommand(id, { ok: true, acceptedAt: T + 1_000 });
	// The poll began before the command; its answer (showing C) counts for nothing.
	answer(later({ track: C, target: target(C) }));
	await poll;
	expect(store.command?.phase).toBe("accepted");
});

// One shared command status per unconfirmed observed play (TS-NP-OBSERVED-COR1-261017).

it("COR1: while the hub still holds that play's next, an unclear answer keeps the key closed", async () => {
	const { store } = await import("../../src/client/store");
	store.load = { kind: "ready", state: app(observed()) };
	const id = store.beginObserved(target(B), frozenB)!;
	store.failCommand(id, "Spotify hat den Befehl noch nicht bestätigt.", true);
	// A later successful look still shows the same play of B, the hub's next unconfirmed.
	stateRequest.mockResolvedValueOnce(later({ nextPending: true }));
	await store.refresh(true, false, true);
	expect(store.command?.phase).toBe("unconfirmed");
	expect(store.beginObserved(target(B), frozenB)).toBeNull();
	// Another play seen: done, the key is free.
	stateRequest.mockResolvedValueOnce(later({ track: C, target: target(C) }, "mika", T + 9_000));
	await store.refresh(true, false, true);
	expect(store.command).toBeNull();
});

it("COR1: an acknowledged next still shown later stays waiting while the hub holds it", async () => {
	const { store } = await import("../../src/client/store");
	store.load = { kind: "ready", state: app(observed()) };
	const id = store.beginObserved(target(B), frozenB)!;
	store.acceptCommand(id, { ok: true, acceptedAt: T + 1_000 });
	vi.advanceTimersByTime(21_000);
	expect(store.command?.phase).toBe("unconfirmed");
	stateRequest.mockResolvedValueOnce(later({ nextPending: true }, "mika", T + 25_000));
	await store.refresh(true, false, true);
	expect(store.command?.phase).toBe("unconfirmed");
});

it("COR1: the hub's 'already sent' answer is the unconfirmed state, never a failure to retry", async () => {
	const { store } = await import("../../src/client/store");
	store.load = { kind: "ready", state: app(observed()) };
	const id = store.beginObserved(target(B), frozenB)!;
	store.acceptCommand(id, {
		ok: false,
		observedPending: true,
		error: { code: "unknown", message: "Weiter ist für diesen Song schon an Spotify gesendet." },
	});
	expect(store.command).toMatchObject({
		phase: "unconfirmed",
		error: "Weiter ist für diesen Song schon an Spotify gesendet.",
	});
});
