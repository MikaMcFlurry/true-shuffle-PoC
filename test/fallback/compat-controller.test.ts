/**
 * The current surface's Verlauf controller (src/client/history-ratings.ts)
 * across a period on the fallback surface (docs/FALLBACK_8D_UI.md): the real
 * store, the real controller and the real hub; the fallback surface's rating
 * sheet is its request (POST /api/tracks/:id/thumb → hub.thumb). A page of the
 * current surface left open, or opened again after the fallback, holds an old
 * receipt: taking it back must not undo what was rated since.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../../src/shared/api";
import { onboarded } from "../hub/harness";

type H = Awaited<ReturnType<typeof onboarded>>;
type Api = typeof import("../../src/client/api");

let api: Api["api"];
let store: typeof import("../../src/client/store").store;
let m: typeof import("../../src/client/history-ratings");
let h: H;

const settle = () => new Promise((r) => setTimeout(r, 5));
const rated = (id: string) => {
	const c = h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'rating_clock'`);
	const clock = c ? (JSON.parse(c.v) as { floor: number; touched: Record<string, number> }) : null;
	return clock ? (clock.touched[id] ?? clock.floor) : 0;
};
const entry = (id: string): HistoryEntry =>
	({ id, name: "Song", thumb: 0, rated: rated(id), playedAt: 1 }) as unknown as HistoryEntry;

beforeEach(async () => {
	vi.resetModules();
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
	({ api } = await import("../../src/client/api"));
	({ store } = await import("../../src/client/store"));
	m = await import("../../src/client/history-ratings");
	h = await onboarded({ tracks: 20 });
	store.load = { kind: "ready", state: await h.hub.state() };
	store.emit();
	vi.spyOn(api, "rateFromHistory").mockImplementation((b) => h.hub.rateFromHistory(b));
	vi.spyOn(api, "historyRatingReceipt").mockImplementation((id, track, basis) =>
		Promise.resolve(h.hub.historyRatingReceipt(id, track, basis)),
	);
	vi.spyOn(api, "undoHistoryRating").mockImplementation((id) => h.hub.undoHistoryRating(id));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("+1 saved on the current surface, -1 on the fallback sheet, „Rückgängig“ on the page left open: a conflict; -1 shown and kept", async () => {
	const t = entry([...h.fake.tracks.keys()][3]!);
	m.rate(t, 1);
	await settle();
	expect(m.shown(t).s?.phase).toBe("saved");
	// The fallback surface (another deployment of the same Worker): its rating sheet.
	h.restart();
	await h.hub.thumb(t.id, -1);
	const seq = rated(t.id);
	// Back on the current surface; the old page still holds its receipt.
	h.restart();
	const told = vi.spyOn(store, "setThumb");
	m.undo(t);
	await settle();
	await settle();
	expect(h.hub.memory(t.id).thumb).toBe(-1);
	expect(rated(t.id)).toBe(seq);
	expect(m.shown(t).s?.receipt?.undo?.outcome).toBe("conflict");
	expect(m.shown(t)).toMatchObject({ value: -1, seq });
	expect(told.mock.calls.filter(([, v]) => v !== -1)).toEqual([]);
	// Asked again: the same conflict, nothing changes.
	m.undo(t);
	await settle();
	await settle();
	expect(h.hub.memory(t.id).thumb).toBe(-1);
	expect(vi.mocked(api.rateFromHistory)).toHaveBeenCalledTimes(1);
});

it("an undo answer on its way when signing out (fallback period in between) counts for nothing after signing in again", async () => {
	const t = entry([...h.fake.tracks.keys()][4]!);
	m.rate(t, 1);
	await settle();
	h.restart();
	await h.hub.thumb(t.id, -1);
	h.restart();
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	vi.mocked(api.undoHistoryRating).mockImplementationOnce(async (id) => {
		await gate;
		return h.hub.undoHistoryRating(id);
	});
	m.undo(t);
	store.load = { kind: "signed-out" };
	store.emit();
	store.load = { kind: "ready", state: await h.hub.state() };
	store.emit();
	const told = vi.spyOn(store, "setThumb");
	release();
	await settle();
	await settle();
	expect(m.shown(t).s).toBeNull();
	expect(told).not.toHaveBeenCalled();
	expect(h.hub.memory(t.id).thumb).toBe(-1);
});
