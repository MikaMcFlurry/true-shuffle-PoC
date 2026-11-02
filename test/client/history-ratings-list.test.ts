/**
 * HUI-RT-001, list reads in the same millisecond: the real store and the real
 * Verlauf rating controller, the list read as the Verlauf reads it
 * (`startListRead` when asking, `takeListed` with the answer). Before the
 * repair the Verlauf told the two apart by the clock (strictly earlier), so a
 * +1 confirmed in the very millisecond the list was asked for still showed
 * over the list's newer -1, with the list's number (repair-root log
 * same-ms-list-phase1-before-fix.log).
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HistoryEntry, HistoryRatingReceipt } from "../../src/shared/api";

const calls = vi.hoisted(() => ({ rate: vi.fn(), receipt: vi.fn(), undo: vi.fn() }));
vi.mock("../../src/client/api", () => ({
	ApiError: class extends Error {},
	api: {
		state: vi.fn(),
		rateFromHistory: calls.rate,
		historyRatingReceipt: calls.receipt,
		undoHistoryRating: calls.undo,
	},
}));

const ID = "T000000000000000000001";
const row = (rated: number, thumb: -1 | 0 | 1): HistoryEntry =>
	({ id: ID, name: "Song", thumb, rated, playedAt: 1 }) as unknown as HistoryEntry;
const receipt = (over: Partial<HistoryRatingReceipt> = {}): HistoryRatingReceipt => ({
	id: "h1",
	trackId: ID,
	value: 1,
	prev: 0,
	at: 1,
	seq: 1,
	skip: "none",
	skipError: null,
	superseded: false,
	undo: null,
	lasting: [],
	...over,
});
const settle = () => new Promise((r) => setTimeout(r, 0));

let store: typeof import("../../src/client/store").store;
let m: typeof import("../../src/client/history-ratings");
let now = 5_000;

beforeEach(async () => {
	vi.resetModules();
	for (const c of Object.values(calls)) c.mockReset();
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
	vi.spyOn(Date, "now").mockImplementation(() => now);
	({ store } = await import("../../src/client/store"));
	m = await import("../../src/client/history-ratings");
	store.load = { kind: "ready", state: { profile: { id: "mika" } } } as never;
	store.emit();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** A Verlauf list read as HistoryScreen reads it: asked for now, answered later. */
function listRead(firstPage = true) {
	const read = m.startListRead();
	return (rows: HistoryEntry[]) => m.takeListed(rows, read, firstPage);
}

it("a +1 confirmed before the list was asked for (same millisecond) gives way to the list's newer -1", async () => {
	now = 5_000;
	const t = row(0, 0);
	calls.rate.mockResolvedValueOnce({ kind: "done", receipt: receipt() });
	m.rate(t, 1);
	await settle();
	expect(store.thumbOverride(ID)?.v).toBe(1);
	// Rated -1 elsewhere (seq 2); the Verlauf asks again in the same millisecond.
	const answer = listRead();
	expect(answer([row(2, -1)])).toBe(true);
	// The keys, the rest of the app and the number: all the list's.
	expect(m.shown(t)).toMatchObject({ value: -1, seq: 2 });
	expect(store.thumbOverride(ID)).toBeUndefined();
	expect(store.thumbOf(row(2, -1))).toBe(-1);
});

it("the same for an older page of the Verlauf (no app-wide settling there): the list's -1 shows", async () => {
	now = 5_500;
	const t = row(0, 0);
	calls.rate.mockResolvedValueOnce({ kind: "done", receipt: receipt() });
	m.rate(t, 1);
	await settle();
	listRead(false)([row(2, -1)]);
	expect(m.shown(t)).toMatchObject({ value: -1, seq: 2 });
});

it("a held list answer after a sheet rating in the same millisecond: the sheet's rating stays, also app-wide", async () => {
	now = 7_000;
	const t = row(0, 0);
	calls.rate.mockResolvedValueOnce({ kind: "done", receipt: receipt() });
	m.rate(t, 1);
	await settle();
	const answer = listRead(); // asked for after the +1
	store.setThumb(ID, -1); // the sheet confirms -1 while the list is on its way
	answer([row(1, 1)]); // the list knows the +1 only
	expect(m.shown(t).value).toBe(-1);
	expect(store.thumbOverride(ID)?.v).toBe(-1);
	// A Favorit tapped now starts from what is shown and is checked by the server.
	calls.rate.mockResolvedValueOnce({ kind: "changed", current: { value: -1, seq: 2 } });
	calls.receipt.mockResolvedValueOnce({
		receipt: null,
		stored: "unknown",
		current: { value: -1, seq: 2 },
	});
	m.rate(t, 1);
	await settle();
	await settle();
	expect(m.shown(t).value).toBe(-1);
});

it("a list of a session signed out since counts for nothing", async () => {
	now = 8_000;
	const t = row(0, 0);
	const answer = listRead();
	store.load = { kind: "signed-out" } as never;
	store.emit();
	store.load = { kind: "ready", state: { profile: { id: "mika" } } } as never;
	store.emit();
	expect(answer([row(4, -1)])).toBe(false);
	expect(m.shown(t)).toMatchObject({ value: 0, seq: 0 });
});

it("a list asked for before a sheet rating (same millisecond) keeps the sheet's rating", async () => {
	now = 6_000;
	const t = row(0, 0);
	const answer = listRead();
	store.setThumb(ID, -1); // the sheet's answer arrives after the list was asked for
	answer([row(1, 1)]); // the list does not know it
	expect(m.shown(t).value).toBe(-1);
	expect(store.thumbOf(row(1, 1))).toBe(-1);
	// The next list, asked for after it, knows it: its word wins again.
	listRead()([row(3, 0)]);
	expect(m.shown(t)).toMatchObject({ value: 0, seq: 3 });
	expect(store.thumbOverride(ID)).toBeUndefined();
});
