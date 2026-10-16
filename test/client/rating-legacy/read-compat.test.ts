/**
 * Older answers without a write number (`rated` absent) next to thumbs given
 * here (TS-RATING-LEGACY-261017): the real store and the real Verlauf ratings,
 * one account, two songs, every snapshot and Verlauf answer synthetic and
 * handed in by hand. The oracle is the one the store states for itself: a
 * song's rating is shown alike everywhere — the open sheet (`thumbOf`) and its
 * Verlauf row (`shown`) agree. Starting point is reviewer case A6 (R6 review):
 * setThumb(X, +1), startListRead(), then a follow page listing −1 without
 * `rated`. See docs/testing/rating-legacy.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, HistoryEntry } from "../../../src/shared/api";
import { row, snap, track, X, Y } from "./fixtures";

const api = vi.hoisted(() => ({
	state: vi.fn(),
	rateFromHistory: vi.fn(),
	historyRatingReceipt: vi.fn(),
	undoHistoryRating: vi.fn(),
}));
vi.mock("../../../src/client/api", () => ({
	ApiError: class ApiError extends Error {},
	api,
}));

let store: typeof import("../../../src/client/store").store;
let ratings: typeof import("../../../src/client/history-ratings");
/** The row the Verlauf renders per song: the one it was last listed with. */
const rendered = new Map<string, HistoryEntry>();

async function read(s: AppState) {
	api.state.mockResolvedValueOnce(s);
	await store.refresh(true, false, true);
}
/** Hands an answered Verlauf page in, as menu.tsx does; returns whether it was taken. */
function take(
	rows: HistoryEntry[],
	asked: ReturnType<typeof ratings.startListRead>,
	first: boolean,
) {
	const taken = ratings.takeListed(rows, asked, first);
	if (taken) for (const r of rows) rendered.set(r.id, r);
	return taken;
}
/** Opens the sheet on a song as the newest snapshot's queue row shows it. */
function open(id: string) {
	const s = store.load.kind === "ready" ? store.load.state : null;
	store.rate(s!.session!.queue.find((e) => e.track.id === id)!.track);
}
/** What the open sheet and the song's Verlauf row show now. */
const view = (id: string) => ({
	sheet: store.rating?.id === id ? store.thumbOf(store.rating) : null,
	verlauf: ratings.shown(rendered.get(id)!).value,
});
function expectAgree(id: string) {
	const v = view(id);
	expect(v.sheet, `sheet and Verlauf for ${id}: ${JSON.stringify(v)}`).toBe(v.verlauf);
	return v;
}

beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers({ now: Date.UTC(2026, 9, 17, 1) });
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
	({ store } = await import("../../../src/client/store"));
	ratings = await import("../../../src/client/history-ratings");
	rendered.clear();
	// Signed in, both songs unrated, all from older answers (no write numbers).
	await read(snap([track(X, 0), track(Y, 0)]));
	expect(take([row(X, 0), row(Y, 0)], ratings.startListRead(), true)).toBe(true);
	vi.advanceTimersByTime(1);
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("legacy reads without a write number", () => {
	it("L1 (A6) a thumb +1 given here, then a follow page asked after it lists −1 without `rated`: sheet and Verlauf agree", () => {
		open(X);
		store.setThumb(X, 1);
		const asked = ratings.startListRead();
		expect(asked.known.get(X)?.v).toBe(1);
		expect(take([row(X, -1)], asked, false)).toBe(true);
		expectAgree(X);
	});

	it.each(["before the list is asked", "between ask and answer", "after the answer"] as const)(
		"L2 first page −1 without `rated` after a thumb +1 here, sheet opened %s: sheet and Verlauf agree",
		(when) => {
			if (when === "before the list is asked") open(X);
			store.setThumb(X, 1);
			const asked = ratings.startListRead();
			if (when === "between ask and answer") open(X);
			expect(take([row(X, -1)], asked, true)).toBe(true);
			if (when === "after the answer") open(X);
			// The list knew the thumb: it gave way.
			expect(store.thumbOverride(X)).toBeUndefined();
			expectAgree(X);
		},
	);

	it("L3 a known higher write number outranks a later snapshot and later Verlauf pages without one (control)", async () => {
		await read(snap([track(X, -1, 6), track(Y, 0)]));
		open(X);
		expect(view(X)).toEqual({ sheet: -1, verlauf: -1 });
		await read(snap([track(X, 1), track(Y, 0)]));
		expect(view(X)).toEqual({ sheet: -1, verlauf: -1 });
		expect(take([row(X, 1)], ratings.startListRead(), false)).toBe(true);
		expect(view(X)).toEqual({ sheet: -1, verlauf: -1 });
		expect(take([row(X, 1)], ratings.startListRead(), true)).toBe(true);
		expect(view(X)).toEqual({ sheet: -1, verlauf: -1 });
		expect(store.storedOf(X)).toMatchObject({ v: -1, seq: 6 });
	});

	it("L4 known write 6 (−1) and a thumb +1 given here: a follow page −1 without `rated` leaves both on +1 (control)", async () => {
		await read(snap([track(X, -1, 6), track(Y, 0)]));
		open(X);
		store.setThumb(X, 1);
		const asked = ratings.startListRead();
		expect(take([row(X, -1)], asked, false)).toBe(true);
		expect(view(X)).toEqual({ sheet: 1, verlauf: 1 });
	});

	it("L5 `rated: 0` is a write number, unlike a missing one: the A6 follow page with rated 0 agrees on −1 (control)", () => {
		open(X);
		store.setThumb(X, 1);
		const asked = ratings.startListRead();
		expect(take([row(X, -1, 0)], asked, false)).toBe(true);
		expect(store.storedOf(X)).toMatchObject({ v: -1, seq: 0 });
		expect(view(X)).toEqual({ sheet: -1, verlauf: -1 });
	});

	it.each([
		["one millisecond", false],
		["one millisecond", true],
		["ordered milliseconds", false],
		["ordered milliseconds", true],
	] as const)(
		"L6 %s, first page %s: a thumb +1 given after the list was asked stays above its −1 without `rated` (control)",
		(clock, first) => {
			open(X);
			const asked = ratings.startListRead();
			if (clock === "ordered milliseconds") vi.advanceTimersByTime(1);
			store.setThumb(X, 1);
			const o = store.thumbOverride(X);
			expect(asked.known.get(X)).toBeUndefined();
			expect(take([row(X, -1)], asked, first)).toBe(true);
			expect(store.thumbOverride(X)).toBe(o);
			expect(view(X)).toEqual({ sheet: 1, verlauf: 1 });
		},
	);

	it.each(["one millisecond", "ordered milliseconds"] as const)(
		"L7 snapshot −1 without `rated` after a thumb +1 here (%s), sheet open: sheet and Verlauf agree",
		async (clock) => {
			open(X);
			store.setThumb(X, 1);
			if (clock === "ordered milliseconds") vi.advanceTimersByTime(1);
			await read(snap([track(X, -1), track(Y, 0)]));
			expectAgree(X);
		},
	);

	it.each(["a numbered first page", "a numbered snapshot"] as const)(
		"L8 after the A6 state, a younger read with a write number (%s) brings sheet and Verlauf together on it (control)",
		async (by) => {
			open(X);
			store.setThumb(X, 1);
			expect(take([row(X, -1)], ratings.startListRead(), false)).toBe(true);
			vi.advanceTimersByTime(1);
			if (by === "a numbered first page") {
				expect(take([row(X, -1, 8)], ratings.startListRead(), true)).toBe(true);
			} else {
				await read(snap([track(X, -1, 8), track(Y, 0)]));
			}
			expect(store.thumbOverride(X)).toBeUndefined();
			expect(store.storedOf(X)).toMatchObject({ v: -1, seq: 8 });
			expect(view(X)).toEqual({ sheet: -1, verlauf: -1 });
		},
	);

	it("L9 two songs: a follow page without `rated` listing only Y tells X nothing (control)", () => {
		open(X);
		store.setThumb(X, 1);
		const o = store.thumbOverride(X);
		expect(take([row(Y, -1)], ratings.startListRead(), false)).toBe(true);
		expect(store.thumbOverride(X)).toBe(o);
		expect(store.storedOf(X)).toBeUndefined();
		expect(store.storedOf(Y)).toBeUndefined();
		expect(view(X)).toEqual({ sheet: 1, verlauf: 1 });
		expect(ratings.shown(rendered.get(Y)!).value).toBe(-1);
	});
});
