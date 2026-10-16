/**
 * TS-FIX-261016-R6, two counter-cases to R5 (4cca91d), real store and real
 * Verlauf ratings, answers given by hand:
 * (1) A Verlauf list is asked; then a confirmation +1 at write 5 is taken
 *     here (thumb O, accounted for at 5). The list answers later −1 at write
 *     7 without knowing O. Write 7 is newer than O's write: sheet and Verlauf
 *     must show −1 — O must not come back. In one millisecond and across two.
 * (2) Known −1 at write 6; a late sheet answer leaves thumb O = +1; a later
 *     Verlauf page asked after O answers −1 at write 6 (it knew O). Sheet and
 *     Verlauf must agree on −1.
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
	ApiError: class ApiError extends Error {},
	api,
}));

type Thumb = -1 | 0 | 1;
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
		queue: [
			{ entryId: "S:0", track: track("track-a", 0, 1) },
			{ entryId: "S:1", track: b },
		],
	},
	nowPlaying: null,
	guest: { active: false, until: null },
	warnings: [],
	jobs: [],
	history: { importedTracks: 0, importedAt: null, liveSince: null },
	aiSource: "off",
	serverTime: ++serverTime,
});
const row = (thumb: Thumb, rated: number): HistoryEntry => ({
	...track(B, thumb),
	playedAt: 1,
	stationName: null,
	ignored: false,
	rated,
});
const receipt = (value: Thumb, seq: number): HistoryRatingReceipt => ({
	id: "h1",
	trackId: B,
	value,
	prev: 0,
	at: 1,
	seq,
	skip: "none",
	skipError: null,
	superseded: false,
	undo: null,
	lasting: [],
});

let store: typeof import("../../src/client/store").store;
let ratings: typeof import("../../src/client/history-ratings");
const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};
async function read(s: AppState) {
	api.state.mockResolvedValueOnce(s);
	await store.refresh(true, false, true);
}
const shownNow = () => ({
	sheet: store.rating ? store.thumbOf(store.rating) : null,
	verlauf: ratings.shown(row(0, 0)).value,
});

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
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

for (const clock of ["one millisecond", "ordered milliseconds"] as const)
	it(`(1) ${clock}: a list asked before a confirmation +1 at write 5 answers −1 at write 7: sheet and Verlauf −1, the old thumb does not come back`, async () => {
		await read(snap(track(B, 0, 3)));
		store.rate(track(B, 0, 3));
		const step = () => {
			if (clock === "ordered milliseconds") vi.advanceTimersByTime(1);
		};
		const list = ratings.startListRead();
		step();
		api.rateFromHistory.mockResolvedValueOnce({
			kind: "done",
			receipt: receipt(1, 5),
		} satisfies HistoryRateAnswer);
		ratings.rate(row(0, 3), 1);
		await flush();
		const o = store.thumbOverride(B);
		expect(o?.v).toBe(1);
		expect(shownNow()).toEqual({ sheet: 1, verlauf: 1 });
		step();
		expect(ratings.takeListed([row(-1, 7)], list, true)).toBe(true);
		// The list did not know O: O stays held here, but write 7 is newer than O's write 5.
		expect(store.thumbOverride(B)).toBe(o);
		expect(shownNow()).toEqual({ sheet: -1, verlauf: -1 });
	});

it("(2) known −1 at write 6, a late sheet answer O = +1, a later Verlauf page asked after O answers −1 at write 6: sheet and Verlauf agree on −1", async () => {
	await read(snap(track(B, -1, 6)));
	store.rate(track(B, -1, 6));
	expect(shownNow()).toEqual({ sheet: -1, verlauf: -1 });
	store.setThumb(B, 1);
	const o = store.thumbOverride(B);
	const page = ratings.startListRead();
	expect(page.known.get(B)).toBe(o);
	expect(ratings.takeListed([row(-1, 6)], page, false)).toBe(true);
	expect(store.thumbOverride(B)).toBe(o);
	expect(shownNow()).toEqual({ sheet: -1, verlauf: -1 });
});
