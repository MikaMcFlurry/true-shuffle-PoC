/**
 * TS-REPRO-261016-R4, a counter-case to the R3 fix (74fa617): two Verlauf lists
 * answered out of order. The real store and the real `takeListed`, no thumb
 * given here. Sheet B open; list L1 asked, then L2 asked; L1 answers +1 at
 * write number 5, L2 answers later −1 at write number 4. The newer stored
 * rating is +1 (write 5): the Verlauf shows +1, and the open sheet must too.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState, HistoryEntry, TrackView } from "../../src/shared/api";

const stateRequest = vi.hoisted(() => vi.fn());
vi.mock("../../src/client/api", () => ({
	ApiError: class extends Error {},
	api: { state: stateRequest },
}));

type Thumb = -1 | 0 | 1;
const track = (id: string, thumb: Thumb): TrackView => ({
	id,
	name: id,
	artists: "Test Artist",
	album: "Test Album",
	imageUrl: null,
	durationMs: 180_000,
	thumb,
});
const app = (): AppState => ({
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
		queue: [
			{ entryId: "S:0", track: track("track-a", 0) },
			{ entryId: "S:1", track: track("track-b", 0) },
		],
	},
	nowPlaying: null,
	guest: { active: false, until: null },
	warnings: [],
	jobs: [],
	history: { importedTracks: 0, importedAt: null, liveSince: null },
	aiSource: "off",
	serverTime: 101,
});
const row = (thumb: Thumb, rated: number): HistoryEntry => ({
	...track("track-b", thumb),
	playedAt: 1,
	stationName: null,
	ignored: false,
	rated,
});

beforeEach(() => {
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
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("L1 asked, L2 asked; L1 answers +1 (write 5), L2 later −1 (write 4): sheet and Verlauf both show +1", async () => {
	const { store } = await import("../../src/client/store");
	const ratings = await import("../../src/client/history-ratings");
	stateRequest.mockResolvedValueOnce(app());
	await store.refresh(true, false, true);
	const b = store.load.kind === "ready" ? store.load.state.session!.queue[1]!.track : null;
	store.rate(b);
	expect(store.thumbOverride("track-b")).toBeUndefined();

	const l1 = ratings.startListRead();
	const l2 = ratings.startListRead();
	expect(ratings.takeListed([row(1, 5)], l1, true)).toBe(true);
	expect(ratings.takeListed([row(-1, 4)], l2, true)).toBe(true);

	expect(store.thumbOverride("track-b")).toBeUndefined();
	const actual = {
		sheet: store.thumbOf(store.rating!),
		verlauf: ratings.shown(row(-1, 4)).value,
		verlaufSeq: ratings.shown(row(-1, 4)).seq,
	};
	expect(actual).toEqual({ sheet: 1, verlauf: 1, verlaufSeq: 5 });
});
