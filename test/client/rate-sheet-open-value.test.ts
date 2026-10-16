/**
 * The open rating sheet hears what is stored (TS-RETRY-261016 R3): the real
 * store and the real Verlauf list intake, the snapshot read held and answered
 * by hand, Date frozen so every read begins in one millisecond. A read asked
 * for after the sheet opened tells it what is stored, at once and without
 * opening it again; an older read, one for another song or another account,
 * and a station page read (ordered only by its clock) tell it nothing; a thumb
 * given here since still shows above any read.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState, HistoryEntry, TrackView } from "../../src/shared/api";

const stateRequest = vi.hoisted(() => vi.fn());
vi.mock("../../src/client/api", () => ({
	ApiError: class extends Error {},
	api: { state: stateRequest },
}));

type Thumb = -1 | 0 | 1;
type Store = typeof import("../../src/client/store").store;
type Ratings = typeof import("../../src/client/history-ratings");

const track = (id: string, thumb: Thumb): TrackView => ({
	id,
	name: id,
	artists: "Test Artist",
	album: "Test Album",
	imageUrl: null,
	durationMs: 180_000,
	thumb,
});
let serverTime = 100;
/** A snapshot with these songs queued (Song A first), as the hub would answer it. */
const app = (songs: Record<string, Thumb>, profile = "listener-a"): AppState => ({
	profile: { id: profile, name: profile, imageUrl: null },
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
		queue: Object.entries(songs).map(([id, thumb], i) => ({
			entryId: `S:${i}`,
			track: track(id, thumb),
		})),
	},
	nowPlaying: null,
	guest: { active: false, until: null },
	warnings: [],
	jobs: [],
	history: { importedTracks: 0, importedAt: null, liveSince: null },
	aiSource: "off",
	serverTime: ++serverTime,
});
const row = (id: string, thumb: Thumb): HistoryEntry => ({
	...track(id, thumb),
	playedAt: 1,
	stationName: null,
	ignored: false,
});

let store: Store;
let ratings: Ratings;
let emits = 0;

/** A snapshot read the test answers by hand. */
function heldRead() {
	let answer!: (s: AppState) => void;
	stateRequest.mockImplementationOnce(
		() =>
			new Promise<AppState>((r) => {
				answer = r;
			}),
	);
	const done = store.refresh(true, false, true);
	return async (s: AppState) => {
		answer(s);
		await done;
	};
}
async function read(s: AppState) {
	stateRequest.mockResolvedValueOnce(s);
	await store.refresh(true, false, true);
}
/** What the open sheet shows as stored (its key state comes from exactly this). */
const shown = () => (store.rating ? store.thumbOf(store.rating) : null);

beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers({ now: Date.UTC(2026, 9, 1, 12) });
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
	({ store } = await import("../../src/client/store"));
	ratings = await import("../../src/client/history-ratings");
	await read(app({ "track-a": 0, "track-b": 1 }));
	store.subscribe(() => emits++);
	emits = 0;
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** Opens the sheet on Song B as the queue row shows it now. */
function openB() {
	const s = store.load.kind === "ready" ? store.load.state : null;
	const b = s!.session!.queue.find((e) => e.track.id === "track-b")!.track;
	store.rate(b);
	return { gen: store.ratingGen, account: store.accountGen };
}

it("an accepted snapshot asked after opening: the open sheet shows what is stored, at once, as the same opening", async () => {
	const opened = openB();
	expect(shown()).toBe(1);
	emits = 0;
	await read(app({ "track-a": 0, "track-b": 0 }));
	expect(shown()).toBe(0);
	expect(store.rating?.id).toBe("track-b");
	expect(store.ratingGen).toBe(opened.gen);
	expect(store.accountGen).toBe(opened.account);
	expect(emits).toBeGreaterThan(0);
});

it("a snapshot asked before the sheet opened, answered after, does not replace what it opened with", async () => {
	const answer = heldRead();
	openB();
	await answer(app({ "track-a": 0, "track-b": -1 }));
	expect(shown()).toBe(1);
	// The next read, asked after opening, is heard.
	await read(app({ "track-a": 0, "track-b": -1 }));
	expect(shown()).toBe(-1);
});

it("a snapshot the store refuses as older (its server time) tells the open sheet nothing", async () => {
	openB();
	stateRequest.mockResolvedValueOnce({ ...app({ "track-a": 0, "track-b": 0 }), serverTime: 1 });
	await store.refresh(true, false, true);
	expect(shown()).toBe(1);
});

it("a thumb given here after the read was asked, in the same millisecond, still shows above it", async () => {
	openB();
	const answer = heldRead();
	store.setThumb("track-b", -1);
	await answer(app({ "track-a": 0, "track-b": 0 }));
	expect(shown()).toBe(-1);
	expect(store.thumbOverride("track-b")?.v).toBe(-1);
});

it("a thumb given here before the read was asked gives way to what the read has stored", async () => {
	openB();
	store.setThumb("track-b", -1);
	vi.advanceTimersByTime(1);
	await read(app({ "track-a": 0, "track-b": 0 }));
	expect(store.thumbOverride("track-b")).toBeUndefined();
	expect(shown()).toBe(0);
});

it("a read without the open song, or with only other songs changed, leaves the sheet as it is", async () => {
	openB();
	emits = 0;
	await read(app({ "track-a": -1 }));
	expect(shown()).toBe(1);
	await read(app({ "track-a": 1, "track-c": -1 }));
	expect(shown()).toBe(1);
	expect(store.rating?.id).toBe("track-b");
});

it("another account's snapshot closes the sheet and tells it nothing", async () => {
	openB();
	await read(app({ "track-a": 0, "track-b": -1 }, "listener-b"));
	expect(store.rating).toBeNull();
	expect(store.thumbOverride("track-b")).toBeUndefined();
});

it("Verlauf: a list asked for after opening, taken, shows what it has stored at once", () => {
	openB();
	emits = 0;
	const asked = ratings.startListRead();
	expect(ratings.takeListed([row("track-b", -1)], asked, true)).toBe(true);
	expect(shown()).toBe(-1);
	expect(emits).toBeGreaterThan(0);
});

it("Verlauf: a list asked for before opening tells the open sheet nothing", () => {
	const asked = ratings.startListRead();
	openB();
	ratings.takeListed([row("track-b", -1)], asked, true);
	expect(shown()).toBe(1);
});

it("Verlauf: an older list answered after a newer snapshot, in one millisecond, does not replace it", async () => {
	openB();
	const older = ratings.startListRead();
	await read(app({ "track-a": 0, "track-b": 0 }));
	expect(shown()).toBe(0);
	ratings.takeListed([row("track-b", -1)], older, true);
	expect(shown()).toBe(0);
	// A list asked for after that snapshot is newer and is heard.
	const newer = ratings.startListRead();
	ratings.takeListed([row("track-b", -1)], newer, true);
	expect(shown()).toBe(-1);
});

it("Verlauf: a thumb the list knew gives way, and the open sheet keeps showing it, even from a list asked before opening", () => {
	store.setThumb("track-b", -1);
	const asked = ratings.startListRead();
	openB();
	expect(shown()).toBe(-1);
	ratings.takeListed([row("track-b", -1)], asked, true);
	expect(store.thumbOverride("track-b")).toBeUndefined();
	expect(shown()).toBe(-1);
});

it("Verlauf: a thumb given here after the list was asked stays and shows above the list", () => {
	openB();
	const asked = ratings.startListRead();
	store.setThumb("track-b", 0);
	ratings.takeListed([row("track-b", -1)], asked, true);
	expect(store.thumbOverride("track-b")?.v).toBe(0);
	expect(shown()).toBe(0);
});

it("Verlauf: a list from another account's generation is not taken and tells the sheet nothing", () => {
	openB();
	const asked = ratings.startListRead();
	ratings.ratingsFor("listener-b", true);
	expect(ratings.takeListed([row("track-b", -1)], asked, true)).toBe(false);
	expect(shown()).toBe(1);
});

it("station page reads (ordered only by their clock) tell the open sheet no value; a thumb they knew keeps showing", () => {
	openB();
	store.settleThumbs([track("track-b", -1)], Date.now());
	expect(shown()).toBe(1);
	store.setThumb("track-b", 0);
	vi.advanceTimersByTime(1);
	store.settleThumbs([track("track-b", -1)], Date.now());
	expect(store.thumbOverride("track-b")).toBeUndefined();
	expect(shown()).toBe(0);
});
