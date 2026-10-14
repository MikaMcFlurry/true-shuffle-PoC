/**
 * HUI-RT-002, a refused retry after a timeout: the real store, the real Verlauf
 * rating controller and the real hub (HubCore + SQLite + FakeSpotify), the
 * network between them held and refused by hand. The original request runs out
 * of the page's time and is still on its way; „Nochmal speichern“ sends the
 * same decision, and only that attempt is refused (synthetic 429/400 at the
 * HTTP edge — not a Spotify quota). Its refusal says nothing about the
 * original: the row stays unclear, „Nachsehen“ stays, the same id is kept;
 * when the original arrives it is stored once and found by the next look.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MINUTE_MS } from "../../src/core/types";
import type { HistoryEntry, HistoryRateAnswer } from "../../src/shared/api";
import { onboarded } from "../hub/harness";

type H = Awaited<ReturnType<typeof onboarded>>;
type Api = typeof import("../../src/client/api");
type Body = Parameters<Api["api"]["rateFromHistory"]>[0];

// Loaded afresh for each test, the same modules the controller uses.
let api: Api["api"];
let ApiError: Api["ApiError"];
let store: typeof import("../../src/client/store").store;
let m: typeof import("../../src/client/history-ratings");
let h: H;
let posts: Body[];

const settle = () => new Promise((r) => setTimeout(r, 5));
const nexts = () => h.fake.calls.filter((c) => c === "POST /v1/me/player/next").length;
const rated = (id: string) => {
	const c = h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'rating_clock'`);
	const clock = c ? (JSON.parse(c.v) as { floor: number; touched: Record<string, number> }) : null;
	return clock ? (clock.touched[id] ?? clock.floor) : 0;
};
const receiptsOf = (actionId: string) => {
	const r = h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'rating_receipts'`);
	return r ? (JSON.parse(r.v) as { id: string }[]).filter((x) => x.id === actionId).length : 0;
};

/** The original request: it runs out of the page's time, and reaches the hub only when released. */
function heldOriginal() {
	let release!: () => Promise<HistoryRateAnswer>;
	vi.spyOn(api, "rateFromHistory").mockImplementationOnce((b) => {
		posts.push(b);
		release = () => h.hub.rateFromHistory(b);
		return Promise.reject(new ApiError(0, "timeout", "Keine rechtzeitige Antwort."));
	});
	return () => release();
}
/** The next attempt is refused at the HTTP edge; it never reaches the hub. */
function refuseNext(status: number, message: string) {
	vi.mocked(api.rateFromHistory).mockImplementationOnce((b) => {
		posts.push(b);
		return Promise.reject(new ApiError(status, status === 429 ? "rate_limited" : "bad", message));
	});
}

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
	({ api, ApiError } = await import("../../src/client/api"));
	({ store } = await import("../../src/client/store"));
	m = await import("../../src/client/history-ratings");
	h = await onboarded({ tracks: 60 });
	posts = [];
	store.load = { kind: "ready", state: await h.hub.state() };
	store.emit();
	vi.spyOn(api, "historyRatingReceipt").mockImplementation((id, track, basis) =>
		Promise.resolve(h.hub.historyRatingReceipt(id, track, basis)),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const entry = (id: string, thumb: -1 | 0 | 1 = 0): HistoryEntry =>
	({ id, name: "Song", thumb, rated: rated(id), playedAt: 1 }) as unknown as HistoryEntry;

it("timeout, then the same decision refused twice (429, 400), several looks: unclear throughout; the original arrives later — stored once, found", async () => {
	const t = entry([...h.fake.tracks.keys()][4]!);
	const before = rated(t.id);
	const release = heldOriginal();
	m.rate(t, 1);
	await settle();
	expect(m.shown(t).s).toMatchObject({ phase: "unclear", intent: { mayStillArrive: true } });

	for (const [status, message] of [
		[429, "Zu viele Anfragen."],
		[400, "Synthetic bad request."],
	] as const) {
		refuseNext(status, message);
		m.rate(t, 1, true); // „Nochmal speichern“
		await settle();
		const s = m.shown(t).s!;
		expect(s.phase).toBe("unclear");
		expect(s.intent?.mayStillArrive).toBe(true);
		expect(s.error).toContain(message);
		expect(s.error).toMatch(/der frühere kann aber noch ankommen/);
		expect(m.lastSaid()).toMatch(/unklar, ob gespeichert/);
		expect(m.lastSaid()).not.toMatch(/nicht gespeichert/);
		// Looking again while the original is still on its way: still unclear.
		m.recheck(t);
		await settle();
		expect(m.shown(t).s).toMatchObject({ phase: "unclear", intent: { mayStillArrive: true } });
		expect(m.lastSaid()).not.toMatch(/nicht gespeichert/);
	}
	expect(h.hub.memory(t.id).thumb).toBe(0);
	expect(rated(t.id)).toBe(before);
	expect(store.thumbOverride(t.id)).toBeUndefined();

	// Three attempts of one decision: the same id and basis each time.
	expect(posts).toHaveLength(3);
	for (const p of posts) expect(p).toEqual(posts[0]);

	// The original arrives: stored once.
	expect((await release()).kind).toBe("done");
	expect(h.hub.memory(t.id).thumb).toBe(1);
	expect(rated(t.id)).toBe(before + 1);
	expect(receiptsOf(posts[0]!.actionId)).toBe(1);

	// The next look finds it.
	m.recheck(t);
	await settle();
	expect(m.shown(t)).toMatchObject({ value: 1, seq: before + 1 });
	expect(m.shown(t).s?.phase).toBe("saved");
	expect(store.thumbOverride(t.id)?.v).toBe(1);
	expect(m.lastSaid()).toMatch(/gespeichert — Favorit/);
	expect(posts).toHaveLength(3);
});

it("„Nie wieder“ on the song playing, retry refused, original arrives: exactly one skip", async () => {
	await h.hub.play(h.stationIds[0]!);
	await h.listen(MINUTE_MS);
	await h.hub.state({ live: true });
	const t = entry(h.fake.current()!);
	const skips = nexts();
	const release = heldOriginal();
	m.rate(t, -1);
	await settle();
	refuseNext(429, "Zu viele Anfragen.");
	m.rate(t, -1, true);
	await settle();
	expect(m.shown(t).s).toMatchObject({ phase: "unclear", intent: { mayStillArrive: true } });
	expect(nexts()).toBe(skips);
	const r = await release();
	expect(r).toMatchObject({ kind: "done", receipt: { value: -1, skip: "skipped" } });
	expect(nexts()).toBe(skips + 1);
	m.recheck(t);
	await settle();
	expect(m.shown(t).s?.phase).toBe("saved");
	expect(nexts()).toBe(skips + 1);
	expect(posts).toHaveLength(2);
});

it("a first attempt refused outright (429, no earlier attempt open): not stored, said so, nothing looked up", async () => {
	const t = entry([...h.fake.tracks.keys()][6]!);
	vi.spyOn(api, "rateFromHistory").mockImplementationOnce((b) => {
		posts.push(b);
		return Promise.reject(new ApiError(429, "rate_limited", "Zu viele Anfragen."));
	});
	m.rate(t, 1);
	await settle();
	expect(m.shown(t).s).toMatchObject({
		phase: "failed",
		error: "Zu viele Anfragen.",
		intent: { mayStillArrive: false },
	});
	expect(m.lastSaid()).toMatch(/nicht gespeichert/);
	expect(api.historyRatingReceipt).not.toHaveBeenCalled();
	expect(h.hub.memory(t.id).thumb).toBe(0);
});

it("an answer lost without a timeout and proven not there, then a refused retry: not stored (nothing open)", async () => {
	const t = entry([...h.fake.tracks.keys()][7]!);
	vi.spyOn(api, "rateFromHistory").mockImplementationOnce((b) => {
		posts.push(b);
		return Promise.reject(new ApiError(0, "offline", "Keine Verbindung."));
	});
	m.rate(t, 1);
	await settle();
	expect(m.shown(t).s?.phase).toBe("failed");
	refuseNext(429, "Zu viele Anfragen.");
	m.rate(t, 1, true);
	await settle();
	expect(m.shown(t).s).toMatchObject({ phase: "failed", intent: { mayStillArrive: false } });
	expect(m.lastSaid()).toMatch(/nicht gespeichert/);
	expect(posts).toHaveLength(2);
	expect(posts[1]).toEqual(posts[0]);
});
