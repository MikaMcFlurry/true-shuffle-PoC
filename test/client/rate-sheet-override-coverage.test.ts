/**
 * TS-FIX-261016-R6: which thumbs given here a stored rating accounts for, by
 * identity and write number (real store and Verlauf ratings, Date frozen).
 * A thumb accounted for at write n stays accounted for by any rating at n or
 * later; a new thumb (a new object) is accounted for by nothing until a read
 * that had it says so; an equal write that had it counts like a newer one.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState, HistoryEntry, TrackView } from "../../src/shared/api";

const api = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock("../../src/client/api", () => ({ ApiError: class ApiError extends Error {}, api }));

type Thumb = -1 | 0 | 1;
const B = "track-b";
const track = (thumb: Thumb, rated: number): TrackView => ({
	id: B,
	name: B,
	artists: "Test Artist",
	album: "Test Album",
	imageUrl: null,
	durationMs: 180_000,
	thumb,
	rated,
});
const row = (thumb: Thumb, rated: number): HistoryEntry => ({
	...track(thumb, rated),
	playedAt: 1,
	stationName: null,
	ignored: false,
});
const snap = (b: TrackView): AppState => ({
	profile: { id: "listener-a", name: "listener-a", imageUrl: null },
	onboarded: true,
	stations: [],
	session: {
		sessionId: "S",
		stationId: 1,
		entryId: "S:0",
		orderRevision: 1,
		progressMs: 0,
		observedAt: 100,
		status: "active",
		pending: false,
		queue: [{ entryId: "S:0", track: b }],
	},
	nowPlaying: null,
	guest: { active: false, until: null },
	warnings: [],
	jobs: [],
	history: { importedTracks: 0, importedAt: null, liveSince: null },
	aiSource: "off",
	serverTime: 101,
});

let store: typeof import("../../src/client/store").store;
let ratings: typeof import("../../src/client/history-ratings");
const both = () => ({
	sheet: store.thumbOf(store.rating!),
	verlauf: ratings.shown(row(0, 0)).value,
});

beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers({ now: Date.UTC(2026, 9, 1, 12) });
	api.state.mockReset();
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
	({ store } = await import("../../src/client/store"));
	ratings = await import("../../src/client/history-ratings");
	api.state.mockResolvedValueOnce(snap(track(0, 3)));
	await store.refresh(true, false, true);
	store.rate(track(0, 3));
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("a new thumb given after one was accounted for shows, in the same millisecond, until a read had it", () => {
	store.setThumb(B, 1);
	ratings.takeListed([row(1, 5)], ratings.startListRead(), false);
	ratings.takeListed([row(-1, 7)], ratings.startListRead(), false);
	expect(both()).toEqual({ sheet: -1, verlauf: -1 });
	store.setThumb(B, 0);
	expect(both()).toEqual({ sheet: 0, verlauf: 0 });
	// A page that had this new thumb, at the same write 7, accounts for it.
	ratings.takeListed([row(-1, 7)], ratings.startListRead(), false);
	expect(both()).toEqual({ sheet: -1, verlauf: -1 });
});

it("a read that had the thumb at a lower number than one already known still accounts for it", () => {
	ratings.takeListed([row(-1, 9)], ratings.startListRead(), false);
	store.setThumb(B, 1);
	expect(both()).toEqual({ sheet: 1, verlauf: 1 });
	const o = store.thumbOverride(B)!;
	ratings.takeListed([row(1, 8)], ratings.startListRead(), false);
	expect(store.covers(o, 8)).toBe(true);
	expect(store.covers(o, 7)).toBe(false);
	expect(store.storedOf(B)).toMatchObject({ v: -1, seq: 9 });
	expect(both()).toEqual({ sheet: -1, verlauf: -1 });
	// A later read that had it too keeps the lowest number that did.
	ratings.takeListed([row(-1, 10)], ratings.startListRead(), false);
	expect(store.covers(o, 8)).toBe(true);
	expect(both()).toEqual({ sheet: -1, verlauf: -1 });
});

it("a thumb nothing had stays shown over every number", () => {
	store.setThumb(B, 1);
	const asked = ratings.startListRead();
	store.setThumb(B, 0);
	ratings.takeListed([row(-1, 9)], asked, false);
	expect(both()).toEqual({ sheet: 0, verlauf: 0 });
});
