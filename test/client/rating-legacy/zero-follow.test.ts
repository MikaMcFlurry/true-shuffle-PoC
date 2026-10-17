/**
 * A confirmed `rated: 0`, then a separately asked Verlauf follow page without
 * `rated` (TS-HISTORY-ZERO-FOLLOW-TEST-261017): the real store and the real
 * Verlauf ratings, one account, two songs, every answer synthetic and handed
 * in by hand. The sheet is opened before any Verlauf read. Each step records
 * the sheet (`thumbOf`, with the store's write number), the Verlauf row
 * (`shown`, with its write number), the thumb given here (and whether it is
 * still the same object), `covers(o, 0)` and `storedOf`. The characterization
 * cases pin what the code does today; whether sheet and Verlauf then agree is
 * asked separately below. No product change, no new precedence rule. See
 * docs/testing/rating-zero-follow.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, HistoryEntry } from "../../../src/shared/api";
import { row, snap, type Thumb, track, X, Y } from "./fixtures";

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

/** One recorded step of a case. */
interface Step {
	step: string;
	sheet: { value: Thumb | null; seq: number | null };
	verlauf: { value: Thumb; seq: number };
	override: { v: Thumb; same: boolean } | null;
	covers0: boolean | null;
	storedOf: { v: Thumb; seq: number; seenIsO: boolean } | null;
}

declare module "vitest" {
	interface TaskMeta {
		zeroFollowTrace?: Step[];
	}
}

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
/** Everything the case records for song X, against the thumb `o` given here (if any). */
function record(step: string, o: ReturnType<typeof store.thumbOverride>): Step {
	const now = store.thumbOverride(X);
	const st = store.storedOf(X);
	const sh = ratings.shown(rendered.get(X)!);
	return {
		step,
		sheet: {
			value: store.rating?.id === X ? store.thumbOf(store.rating) : null,
			seq: st?.seq ?? null,
		},
		verlauf: { value: sh.value, seq: sh.seq },
		override: now ? { v: now.v, same: now === o } : null,
		covers0: o ? store.covers(o, 0) : null,
		storedOf: st ? { v: st.v, seq: st.seq, seenIsO: !!o && st.seen === o } : null,
	};
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
	// Signed in (a sheet opened before the first snapshot would be closed by the change of account).
	await read(snap([track(X, 0), track(Y, 0)]));
	// The sheet opens before any Verlauf read; then the first page, both songs unrated, no write numbers.
	open(X);
	expect(take([row(X, 0), row(Y, 0)], ratings.startListRead(), true)).toBe(true);
	vi.advanceTimersByTime(1);
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/**
 * The cases' steps: a thumb +1 given here (or none), a follow page X = −1 at
 * write number `zero` (0, or 1 as control), then a separately asked follow
 * page X = +1 without `rated`.
 */
function walk(withThumb: boolean, zero: number): Step[] {
	const trace: Step[] = [];
	trace.push(record("opened, first page", undefined));
	if (withThumb) store.setThumb(X, 1);
	const o = store.thumbOverride(X);
	trace.push(record(withThumb ? "thumb +1 given here" : "no thumb given here", o));
	const first = ratings.startListRead();
	expect(first.known.get(X)).toBe(o);
	expect(take([row(X, -1, zero)], first, false)).toBe(true);
	trace.push(record(`follow page X −1, rated ${zero}`, o));
	vi.advanceTimersByTime(1);
	const second = ratings.startListRead();
	expect(second.known.get(X)).toBe(o);
	expect(take([row(X, 1)], second, false)).toBe(true);
	trace.push(record("separate follow page X +1 without rated", o));
	return trace;
}

const opened: Step = {
	step: "opened, first page",
	sheet: { value: 0, seq: null },
	verlauf: { value: 0, seq: 0 },
	override: null,
	covers0: null,
	storedOf: null,
};

describe("a confirmed `rated: 0`, then a follow page without `rated` (characterization)", () => {
	it("Z1 with a thumb +1 given here: after the follow pages the sheet shows −1@0, the Verlauf +1@0", ({
		task,
	}) => {
		const trace = walk(true, 0);
		task.meta.zeroFollowTrace = trace;
		expect(trace).toEqual([
			opened,
			{
				step: "thumb +1 given here",
				sheet: { value: 1, seq: null },
				verlauf: { value: 1, seq: 0 },
				override: { v: 1, same: true },
				covers0: false,
				storedOf: null,
			},
			{
				step: "follow page X −1, rated 0",
				sheet: { value: -1, seq: 0 },
				verlauf: { value: -1, seq: 0 },
				override: { v: 1, same: true },
				covers0: true,
				storedOf: { v: -1, seq: 0, seenIsO: true },
			},
			{
				step: "separate follow page X +1 without rated",
				sheet: { value: -1, seq: 0 },
				verlauf: { value: 1, seq: 0 },
				override: { v: 1, same: true },
				covers0: true,
				storedOf: { v: -1, seq: 0, seenIsO: true },
			},
		]);
	});

	it("Z2 without a thumb given here: after the follow pages the sheet shows −1@0, the Verlauf +1@0", ({
		task,
	}) => {
		const trace = walk(false, 0);
		task.meta.zeroFollowTrace = trace;
		expect(trace).toEqual([
			opened,
			{ ...opened, step: "no thumb given here" },
			{
				step: "follow page X −1, rated 0",
				sheet: { value: -1, seq: 0 },
				verlauf: { value: -1, seq: 0 },
				override: null,
				covers0: null,
				storedOf: { v: -1, seq: 0, seenIsO: false },
			},
			{
				step: "separate follow page X +1 without rated",
				sheet: { value: -1, seq: 0 },
				verlauf: { value: 1, seq: 0 },
				override: null,
				covers0: null,
				storedOf: { v: -1, seq: 0, seenIsO: false },
			},
		]);
	});

	it("Z3 control `rated: 1` with a thumb +1 given here: the follow page without `rated` changes nothing, both −1@1", ({
		task,
	}) => {
		const trace = walk(true, 1);
		task.meta.zeroFollowTrace = trace;
		const numbered: Step = {
			step: "follow page X −1, rated 1",
			sheet: { value: -1, seq: 1 },
			verlauf: { value: -1, seq: 1 },
			override: { v: 1, same: true },
			covers0: false,
			storedOf: { v: -1, seq: 1, seenIsO: true },
		};
		expect(trace.slice(2)).toEqual([
			numbered,
			{ ...numbered, step: "separate follow page X +1 without rated" },
		]);
	});
});

describe("a confirmed `rated: 0`, then a follow page without `rated` (consistency)", () => {
	it.each([
		["with a thumb +1 given here", true],
		["without a thumb given here", false],
	] as const)("Z4 %s: the open sheet and the Verlauf row show the same rating", (_, withThumb) => {
		const last = walk(withThumb, 0).at(-1)!;
		expect(last.sheet.value, JSON.stringify(last)).toBe(last.verlauf.value);
	});
});
