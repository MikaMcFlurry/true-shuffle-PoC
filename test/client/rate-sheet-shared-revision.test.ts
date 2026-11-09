/**
 * One newest stored rating, shared (TS-FIX-261016-R5): the real store and the
 * real Verlauf ratings, answers held and given by hand, Date frozen so every
 * read falls in one millisecond unless a case moves the clock. Snapshots carry
 * the server's write number (`rated`) next to the rating; Verlauf rows and
 * receipts carry it already. The open sheet, the lists and the Verlauf show
 * the rating with the highest number heard; a late confirmation or taking back
 * at a lower number changes nothing; a read without a number never replaces a
 * known one; thumbs given here keep their identity rule; another account or
 * signing out forgets everything.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
	AppState,
	HistoryEntry,
	HistoryRateAnswer,
	HistoryRatingReceipt,
	TrackView,
} from "../../src/shared/api";

const api = vi.hoisted(() => ({
	state: vi.fn(),
	rateFromHistory: vi.fn(),
	historyRatingReceipt: vi.fn(),
	undoHistoryRating: vi.fn(),
}));
vi.mock("../../src/client/api", () => ({
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			public code: string,
			message: string,
		) {
			super(message);
		}
	},
	api,
}));

type Thumb = -1 | 0 | 1;
type Store = typeof import("../../src/client/store").store;
type Ratings = typeof import("../../src/client/history-ratings");

const B = "track-b";
const track = (id: string, thumb: Thumb, rated?: number): TrackView => ({
	id,
	name: id,
	artists: "Test Artist",
	album: "Test Album",
	imageUrl: null,
	durationMs: 180_000,
	thumb,
	...(rated === undefined ? {} : { rated }),
});
let serverTime = 100;
/** A snapshot: Song A, then these songs, as the hub answers it (with or without numbers). */
const snap = (songs: TrackView[], profile = "listener-a"): AppState => ({
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
		queue: [track("track-a", 0, 1), ...songs].map((t, i) => ({ entryId: `S:${i}`, track: t })),
	},
	nowPlaying: null,
	guest: { active: false, until: null },
	warnings: [],
	jobs: [],
	history: { importedTracks: 0, importedAt: null, liveSince: null },
	aiSource: "off",
	serverTime: ++serverTime,
});
const row = (thumb: Thumb, rated: number, id = B): HistoryEntry => ({
	...track(id, thumb),
	playedAt: 1,
	stationName: null,
	ignored: false,
	rated,
});
const receipt = (
	value: Thumb,
	seq: number,
	undo?: { value: Thumb; seq: number },
): HistoryRatingReceipt => ({
	id: "h1",
	trackId: B,
	value,
	prev: 0,
	at: 1,
	seq,
	skip: "none",
	skipError: null,
	superseded: false,
	undo: undo ? { at: 2, outcome: "undone", notes: [], ...undo } : null,
	lasting: [],
});

let store: Store;
let ratings: Ratings;

async function read(s: AppState) {
	api.state.mockResolvedValueOnce(s);
	await store.refresh(true, false, true);
}
function held<T>(fn: typeof api.rateFromHistory) {
	let answer!: (v: T) => void;
	fn.mockImplementationOnce(
		() =>
			new Promise<T>((r) => {
				answer = r;
			}),
	);
	return async (v: T) => {
		answer(v);
		for (let i = 0; i < 10; i++) await Promise.resolve();
	};
}
const sheet = () => (store.rating ? store.thumbOf(store.rating) : null);
const verlauf = (id = B) => {
	const s = ratings.shown(row(0, 0, id));
	return { value: s.value, seq: s.seq };
};
function openB() {
	const s = store.load.kind === "ready" ? store.load.state : null;
	store.rate(s!.session!.queue.find((e) => e.track.id === B)!.track);
}
const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers({ now: Date.UTC(2026, 9, 1, 12) });
	for (const f of Object.values(api)) f.mockReset();
	api.historyRatingReceipt.mockResolvedValue({ receipt: null, stored: "unknown", current: null });
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
	await read(snap([track(B, 0, 3), track("track-c", 0, 2)]));
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("snapshot at write 4 (−1) answered before the list at write 5 (+1): sheet and Verlauf both +1 at 5", async () => {
	openB();
	const l = ratings.startListRead();
	await read(snap([track(B, -1, 4)]));
	expect(sheet()).toBe(-1);
	ratings.takeListed([row(1, 5)], l, true);
	expect({ sheet: sheet(), verlauf: verlauf() }).toEqual({
		sheet: 1,
		verlauf: { value: 1, seq: 5 },
	});
});

it("the other way: the list at write 5 (+1) first, then a newer snapshot at write 6 (0): both 0 at 6", async () => {
	openB();
	ratings.takeListed([row(1, 5)], ratings.startListRead(), true);
	expect(sheet()).toBe(1);
	await read(snap([track(B, 0, 6)]));
	expect({ sheet: sheet(), verlauf: verlauf() }).toEqual({
		sheet: 0,
		verlauf: { value: 0, seq: 6 },
	});
});

it("an older snapshot (write 4) answered after the list at write 5 changes nothing", async () => {
	openB();
	ratings.takeListed([row(1, 5)], ratings.startListRead(), true);
	await read(snap([track(B, -1, 4)]));
	expect({ sheet: sheet(), verlauf: verlauf() }).toEqual({
		sheet: 1,
		verlauf: { value: 1, seq: 5 },
	});
});

it("a snapshot without write numbers (an older answer) never replaces a known one", async () => {
	openB();
	ratings.takeListed([row(1, 5)], ratings.startListRead(), true);
	await read(snap([track(B, -1)]));
	expect({ sheet: sheet(), verlauf: verlauf() }).toEqual({
		sheet: 1,
		verlauf: { value: 1, seq: 5 },
	});
	// With nothing known for a song, an older answer still tells the open sheet (as before).
	store.rate(track("track-d", 0));
	await read(snap([track(B, -1), track("track-d", -1)]));
	expect(sheet()).toBe(-1);
});

it("a later Verlauf page counts with its numbers, and lets no thumb given here give way", async () => {
	openB();
	store.setThumb(B, 1);
	const own = store.thumbOverride(B);
	const later = ratings.startListRead();
	expect(ratings.takeListed([row(-1, 7)], later, false)).toBe(true);
	// The page knew this thumb: its newer stored −1 shows, the thumb itself stays where it was.
	expect(store.thumbOverride(B)).toBe(own);
	expect(store.storedOf(B)).toMatchObject({ v: -1, seq: 7 });
	expect({ sheet: sheet(), verlauf: verlauf() }).toEqual({
		sheet: -1,
		verlauf: { value: -1, seq: 7 },
	});
});

it("same millisecond: a thumb given after the list was asked shows above it; one given before is accounted for", async () => {
	openB();
	const before = ratings.startListRead();
	store.setThumb(B, 0);
	ratings.takeListed([row(-1, 8)], before, true);
	expect(store.thumbOverride(B)?.v).toBe(0);
	expect({ sheet: sheet(), verlauf: verlauf().value }).toEqual({ sheet: 0, verlauf: 0 });
	// A list asked now knows that very thumb: its number and value hold, the thumb gives way.
	const after = ratings.startListRead();
	ratings.takeListed([row(1, 9)], after, true);
	expect(store.thumbOverride(B)).toBeUndefined();
	expect({ sheet: sheet(), verlauf: verlauf() }).toEqual({
		sheet: 1,
		verlauf: { value: 1, seq: 9 },
	});
});

it("a confirmation answered late, at a lower number than a snapshot heard meanwhile, changes nothing", async () => {
	openB();
	const answer = held<HistoryRateAnswer>(api.rateFromHistory);
	ratings.rate(row(0, 3), 1);
	await read(snap([track(B, 0, 9)]));
	await answer({ kind: "done", receipt: receipt(1, 8) });
	await flush();
	expect(store.thumbOverride(B)).toBeUndefined();
	expect({ sheet: sheet(), verlauf: verlauf() }).toEqual({
		sheet: 0,
		verlauf: { value: 0, seq: 9 },
	});
});

it("a confirmation at the highest number is heard by the open sheet too", async () => {
	openB();
	const answer = held<HistoryRateAnswer>(api.rateFromHistory);
	ratings.rate(row(0, 3), 1);
	await answer({ kind: "done", receipt: receipt(1, 4) });
	await flush();
	expect(store.storedOf(B)).toMatchObject({ v: 1, seq: 4 });
	expect({ sheet: sheet(), verlauf: verlauf() }).toEqual({
		sheet: 1,
		verlauf: { value: 1, seq: 4 },
	});
});

it("taking back answered late, at a lower number than a snapshot heard meanwhile, changes nothing", async () => {
	openB();
	const confirmed = held<HistoryRateAnswer>(api.rateFromHistory);
	ratings.rate(row(0, 3), 1);
	await confirmed({ kind: "done", receipt: receipt(1, 5) });
	await flush();
	expect(verlauf()).toEqual({ value: 1, seq: 5 });
	const undone = held<{ receipt: HistoryRatingReceipt | null }>(api.undoHistoryRating);
	ratings.undo(row(0, 3));
	vi.advanceTimersByTime(1);
	await read(snap([track(B, -1, 7)]));
	await undone({ receipt: receipt(1, 5, { value: 0, seq: 6 }) });
	await flush();
	expect(ratings.shown(row(0, 3)).s?.phase).toBe("undone");
	expect({ sheet: sheet(), verlauf: verlauf() }).toEqual({
		sheet: -1,
		verlauf: { value: -1, seq: 7 },
	});
});

it("another account forgets every number heard; signing out does too; other songs are untouched", async () => {
	ratings.takeListed([row(1, 5), row(-1, 4, "track-c")], ratings.startListRead(), true);
	expect(store.storedOf(B)?.seq).toBe(5);
	expect(store.storedOf("track-c")).toMatchObject({ v: -1, seq: 4 });
	await read(snap([track(B, 0, 6)]));
	expect(store.storedOf(B)?.seq).toBe(6);
	expect(store.storedOf("track-c")).toMatchObject({ v: -1, seq: 4 });
	await read(snap([track(B, 0, 1)], "listener-b"));
	expect(store.storedOf(B)).toMatchObject({ v: 0, seq: 1 });
	expect(store.storedOf("track-c")).toBeUndefined();
	const { ApiError } = await import("../../src/client/api");
	api.state.mockRejectedValueOnce(new ApiError(401, "signed_out", "Nicht angemeldet"));
	await store.refresh(true, false, true);
	expect(store.load.kind).toBe("signed-out");
	expect(store.storedOf(B)).toBeUndefined();
});

it("the same number again keeps what is known (one write, one value)", async () => {
	ratings.takeListed([row(1, 5)], ratings.startListRead(), true);
	const first = store.storedOf(B);
	await read(snap([track(B, 1, 5)]));
	expect(store.storedOf(B)).toBe(first);
});
