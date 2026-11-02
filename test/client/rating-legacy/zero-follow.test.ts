/**
 * A confirmed `rated: 0`, then a separately asked Verlauf follow page without
 * `rated` (TS-HISTORY-ZERO-FOLLOW-TEST-261017): the real store and the real
 * Verlauf ratings, one account, two songs, every answer synthetic and handed
 * in by hand. The sheet is opened before any Verlauf read. Each step records
 * the sheet (`thumbOf`, with the store's write number), the Verlauf row
 * (`shown`, with its write number), the thumb given here (and whether it is
 * still the same object), `covers(o, 0)` and `storedOf`. Z1–Z3 were written as
 * characterization (sheet −1@0, Verlauf +1@0); TS-HISTORY-ZERO-FOLLOW-COR1-261017
 * turns Z1/Z2 to the released contract — both stay −1@0: a row without a write
 * number never replaces a confirmed 0 — and leaves Z3 as it was. Z4 asks the
 * concrete value, number and source; Z5–Z11 add the neighbouring cases and the
 * unchanged controls. See docs/testing/rating-zero-follow.md.
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

describe("a confirmed `rated: 0`, then a follow page without `rated` (contract)", () => {
	it("Z1 with a thumb +1 given here: after the follow pages the sheet and the Verlauf both show −1@0", ({
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
				verlauf: { value: -1, seq: 0 },
				override: { v: 1, same: true },
				covers0: true,
				storedOf: { v: -1, seq: 0, seenIsO: true },
			},
		]);
	});

	it("Z2 without a thumb given here: after the follow pages the sheet and the Verlauf both show −1@0", ({
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
				verlauf: { value: -1, seq: 0 },
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
	] as const)(
		"Z4 %s: the open sheet and the Verlauf row show −1@0, from the confirmed write",
		(_, withThumb) => {
			const last = walk(withThumb, 0).at(-1)!;
			const why = JSON.stringify(last);
			// Value, number and source: the confirmed write 0 — not the row the Verlauf
			// renders now (+1 without a number), not the thumb given here (+1).
			expect(rendered.get(X)!.thumb, why).toBe(1);
			expect(rendered.get(X)!.rated, why).toBeUndefined();
			expect(last.sheet, why).toEqual({ value: -1, seq: 0 });
			expect(last.verlauf, why).toEqual({ value: -1, seq: 0 });
			expect(last.storedOf, why).toEqual({ v: -1, seq: 0, seenIsO: withThumb });
			expect(last.override, why).toEqual(withThumb ? { v: 1, same: true } : null);
		},
	);
});

/** What the open sheet and a song's Verlauf row show now, with the store's newest stored rating. */
function view(id: string) {
	const st = store.storedOf(id);
	const sh = ratings.shown(rendered.get(id)!);
	return {
		sheet: store.rating?.id === id ? store.thumbOf(store.rating) : null,
		verlauf: { value: sh.value, seq: sh.seq },
		storedOf: st ? { v: st.v, seq: st.seq } : null,
	};
}
/** A follow page asked now and answered at once. */
const follow = (rows: HistoryEntry[]) => take(rows, ratings.startListRead(), false);
/** The confirmed −1@0 of Z1/Z2 (with or without a thumb +1 given here); returns that thumb. */
function confirmedZero(withThumb: boolean) {
	if (withThumb) store.setThumb(X, 1);
	const o = store.thumbOverride(X);
	expect(follow([row(X, -1, 0)])).toBe(true);
	vi.advanceTimersByTime(1);
	return o;
}
const minusOneAtZero = { sheet: -1, verlauf: { value: -1, seq: 0 }, storedOf: { v: -1, seq: 0 } };

describe("a confirmed `rated: 0` next to rows without `rated` (contract)", () => {
	it.for([
		["without a thumb given here", false],
		["after a thumb +1 given here that the snapshot settles", true],
	] as const)(
		"Z5 the confirmed 0 comes from a snapshot (%s): it shows, and a later follow page X +1 without `rated` leaves sheet and Verlauf on −1@0",
		async ([, withThumb], { task }) => {
			if (withThumb) {
				store.setThumb(X, 1);
				vi.advanceTimersByTime(1);
			}
			await read(snap([track(X, -1, 0), track(Y, 0)]));
			const trace: unknown[] = [{ step: "snapshot X −1 rated 0", ...view(X) }];
			task.meta.zeroFollowTrace = trace as never;
			expect(store.thumbOverride(X)).toBeUndefined();
			expect(view(X)).toEqual(minusOneAtZero);
			vi.advanceTimersByTime(1);
			expect(follow([row(X, 1)])).toBe(true);
			trace.push({ step: "follow page X +1 without rated", ...view(X) });
			expect(view(X)).toEqual(minusOneAtZero);
		},
	);

	it("Z6 rows without `rated` only are no confirmed 0: a Verlauf rating begun on one and refused does not outrank a later explicit 0", async ({
		task,
	}) => {
		expect(follow([row(X, -1)])).toBe(true);
		vi.advanceTimersByTime(1);
		expect(follow([row(X, 1)])).toBe(true);
		const trace: unknown[] = [{ step: "follow pages X −1, then X +1, without rated", ...view(X) }];
		task.meta.zeroFollowTrace = trace as never;
		// Nothing stored; the Verlauf shows the newer row (rows without a number among themselves).
		expect(view(X)).toMatchObject({ verlauf: { value: 1, seq: 0 }, storedOf: null });
		// A rating asked in the Verlauf on that row is refused: the song keeps what it began from.
		const { ApiError } = await import("../../../src/client/api");
		api.rateFromHistory.mockRejectedValueOnce(
			Object.assign(new ApiError(409, "refused", "Abgelehnt"), { status: 409 }),
		);
		ratings.rate(rendered.get(X)!, -1);
		await vi.waitFor(() => expect(ratings.shown(rendered.get(X)!).s?.phase).toBe("failed"));
		expect(api.rateFromHistory.mock.calls[0]![0]).toMatchObject({
			trackId: X,
			value: -1,
			basis: 0,
		});
		trace.push({ step: "Verlauf rating −1 refused", ...view(X) });
		expect(view(X)).toMatchObject({ verlauf: { value: 1, seq: 0 }, storedOf: null });
		// An explicit 0 (−1@0) then outranks the 0 that only stood for a missing number.
		vi.advanceTimersByTime(1);
		expect(follow([row(X, -1, 0)])).toBe(true);
		trace.push({ step: "follow page X −1 rated 0", ...view(X) });
		expect(view(X)).toEqual(minusOneAtZero);
	});

	it("Z9 another song: a page without `rated` listing Y −1 and X +1 updates Y and leaves X on −1@0", ({
		task,
	}) => {
		confirmedZero(false);
		expect(follow([row(Y, -1), row(X, 1)])).toBe(true);
		task.meta.zeroFollowTrace = [
			{ step: "follow page Y −1, X +1 without rated", x: view(X), y: view(Y) },
		] as never;
		expect(view(X)).toEqual(minusOneAtZero);
		expect(view(Y)).toEqual({ sheet: null, verlauf: { value: -1, seq: 0 }, storedOf: null });
	});
});

describe("next to the confirmed `rated: 0` (unchanged controls)", () => {
	it.for([
		["in the same millisecond", 0],
		["one millisecond later", 1],
	] as const)(
		"Z7 a thumb 0 given here after the follow page was asked (%s): it shows in sheet and Verlauf; the confirmed −1@0 stays stored",
		([, ms], { task }) => {
			const o = confirmedZero(true);
			const asked = ratings.startListRead();
			vi.advanceTimersByTime(ms);
			store.setThumb(X, 0);
			const o2 = store.thumbOverride(X)!;
			expect(o2).not.toBe(o);
			expect(take([row(X, 1)], asked, false)).toBe(true);
			const after = {
				...view(X),
				same: store.thumbOverride(X) === o2,
				covers0: store.covers(o2, 0),
				seenIsO: store.storedOf(X)!.seen === o,
			};
			task.meta.zeroFollowTrace = [
				{ step: "follow page X +1 without rated, asked before the thumb 0", ...after },
			] as never;
			expect(after).toEqual({
				sheet: 0,
				verlauf: { value: 0, seq: 0 },
				storedOf: { v: -1, seq: 0 },
				same: true,
				covers0: false,
				seenIsO: true,
			});
		},
	);

	it.for([
		["with a thumb +1 given here", true],
		["without a thumb given here", false],
	] as const)(
		"Z8 %s: a higher numbered follow page X +1 rated 1 after the page without `rated` brings both to +1@1",
		([, withThumb], { task }) => {
			confirmedZero(withThumb);
			expect(follow([row(X, 1)])).toBe(true);
			vi.advanceTimersByTime(1);
			expect(follow([row(X, 1, 1)])).toBe(true);
			task.meta.zeroFollowTrace = [{ step: "follow page X +1 rated 1", ...view(X) }] as never;
			expect(view(X)).toEqual({
				sheet: 1,
				verlauf: { value: 1, seq: 1 },
				storedOf: { v: 1, seq: 1 },
			});
		},
	);

	it("Z10 another account signs in while a page without `rated` is on its way: the late page is not taken, the new account starts from nothing", async ({
		task,
	}) => {
		confirmedZero(true);
		const asked = ratings.startListRead();
		const other = snap([track(X, 0), track(Y, 0)]);
		await read({ ...other, profile: { ...other.profile, id: "listener-b" } });
		expect(store.rating).toBeNull();
		expect(store.thumbOverride(X)).toBeUndefined();
		expect(store.storedOf(X)).toBeUndefined();
		// The late answer asked for the account before.
		expect(take([row(X, 1)], asked, false)).toBe(false);
		// The new account's own first page without `rated`: what it says, nothing of the account before.
		expect(take([row(X, 1)], ratings.startListRead(), true)).toBe(true);
		task.meta.zeroFollowTrace = [
			{ step: "late page not taken; new account's first page X +1 without rated", ...view(X) },
		] as never;
		expect(view(X)).toEqual({ sheet: null, verlauf: { value: 1, seq: 0 }, storedOf: null });
	});

	it.for([
		["explicit 0", 0],
		["positive 3", 3],
	] as const)(
		"Z11 tie at write %s: the same write read again after a thumb +1 given here accounts for it in sheet and Verlauf",
		([, seq], { task }) => {
			expect(follow([row(X, -1, seq)])).toBe(true);
			vi.advanceTimersByTime(1);
			store.setThumb(X, 1);
			const o = store.thumbOverride(X)!;
			const trace: unknown[] = [{ step: `thumb +1 given here after −1@${seq}`, ...view(X) }];
			task.meta.zeroFollowTrace = trace as never;
			expect(view(X)).toEqual({ sheet: 1, verlauf: { value: 1, seq }, storedOf: { v: -1, seq } });
			vi.advanceTimersByTime(1);
			expect(follow([row(X, -1, seq)])).toBe(true);
			trace.push({ step: `the same write −1@${seq} read again`, ...view(X) });
			expect(store.thumbOverride(X)).toBe(o);
			expect(store.covers(o, seq)).toBe(true);
			expect(view(X)).toEqual({ sheet: -1, verlauf: { value: -1, seq }, storedOf: { v: -1, seq } });
		},
	);
});
