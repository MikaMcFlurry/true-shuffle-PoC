/**
 * The Verlauf's rating controller (src/client/history-ratings.ts) on its own:
 * answers held and released by hand, the store's sign-in state switched by
 * hand. Root review probes R-HUI-02/03/04.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry, HistoryRatingReceipt } from "../../src/shared/api";

class FakeApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

const calls = vi.hoisted(() => ({
	rate: vi.fn(),
	receipt: vi.fn(),
	undo: vi.fn(),
}));
vi.mock("../../src/client/api", () => ({
	ApiError: FakeApiError,
	api: {
		rateFromHistory: calls.rate,
		historyRatingReceipt: calls.receipt,
		undoHistoryRating: calls.undo,
	},
}));

type Load = { kind: "ready"; state: { profile: { id: string } } } | { kind: string };
const fakeStore = vi.hoisted(() => {
	const listeners = new Set<() => void>();
	const thumbs = new Map<string, { v: -1 | 0 | 1; at: number }>();
	return {
		load: { kind: "loading" } as Load,
		listeners,
		thumbs,
		subscribe(l: () => void) {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		emit() {
			for (const l of listeners) l();
		},
		setThumb: vi.fn((id: string, v: -1 | 0 | 1) => thumbs.set(id, { v, at: Date.now() })),
		thumbOf(t: { id: string; thumb: -1 | 0 | 1 }) {
			return thumbs.get(t.id)?.v ?? t.thumb;
		},
		thumbOverride(id: string) {
			return thumbs.get(id);
		},
	};
});
vi.mock("../../src/client/store", () => ({ store: fakeStore }));

const row = (id = "T000000000000000000001", rated = 3, thumb: -1 | 0 | 1 = 0): HistoryEntry =>
	({ id, name: `Song ${id.slice(-1)}`, thumb, rated, playedAt: 1 }) as unknown as HistoryEntry;

const receipt = (over: Partial<HistoryRatingReceipt> = {}): HistoryRatingReceipt => ({
	id: "h1",
	trackId: "T000000000000000000001",
	value: 1,
	prev: 0,
	at: 1,
	seq: 4,
	skip: "none",
	skipError: null,
	superseded: false,
	undo: null,
	lasting: [],
	...over,
});

/** A promise released by hand. */
function held<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const p = new Promise<T>((a, b) => {
		resolve = a;
		reject = b;
	});
	return { p, resolve, reject };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

let m: typeof import("../../src/client/history-ratings");

function signIn(id: string) {
	fakeStore.load = { kind: "ready", state: { profile: { id } } };
	fakeStore.emit();
}

beforeEach(async () => {
	vi.resetModules();
	calls.rate.mockReset();
	calls.receipt.mockReset();
	calls.undo.mockReset();
	fakeStore.listeners.clear();
	fakeStore.thumbs.clear();
	fakeStore.setThumb.mockClear();
	fakeStore.load = { kind: "loading" };
	m = await import("../../src/client/history-ratings");
	signIn("mika");
});

async function saved(t: HistoryEntry, r: HistoryRatingReceipt) {
	calls.rate.mockResolvedValueOnce({ kind: "done", receipt: r });
	m.rate(t, r.value);
	await settle();
	expect(m.shown(t).s?.phase).toBe("saved");
}

describe("R-HUI-04: signing out and in, wherever the page is", () => {
	it("an answer on its way when signing out (Verlauf closed) changes nothing — also after signing in as the same account", async () => {
		const t = row();
		const answer = held<unknown>();
		calls.rate.mockReturnValueOnce(answer.p);
		m.rate(t, 1);
		expect(m.shown(t).s?.phase).toBe("saving");
		fakeStore.load = { kind: "signed-out" };
		fakeStore.emit();
		signIn("mika");
		answer.resolve({ kind: "done", receipt: receipt() });
		await settle();
		expect(m.shown(t).s).toBeNull();
		expect(fakeStore.setThumb).not.toHaveBeenCalled();
	});

	it("loading, a failed refresh or being offline do not reset a session", async () => {
		const t = row();
		const answer = held<unknown>();
		calls.rate.mockReturnValueOnce(answer.p);
		m.rate(t, 1);
		for (const kind of ["loading", "error"]) {
			fakeStore.load = { kind };
			fakeStore.emit();
		}
		signIn("mika");
		answer.resolve({ kind: "done", receipt: receipt() });
		await settle();
		expect(m.shown(t).s?.phase).toBe("saved");
		expect(fakeStore.setThumb).toHaveBeenCalledWith(t.id, 1);
	});

	it("a list read before signing out and in is not taken", () => {
		const gen = m.ratingsGeneration();
		fakeStore.load = { kind: "signed-out" };
		fakeStore.emit();
		signIn("mika");
		m.noteListed([row("T000000000000000000001", 9, -1)], gen);
		expect(m.shown(row("T000000000000000000001", 3, 0))).toMatchObject({ value: 0, seq: 3 });
		m.noteListed([row("T000000000000000000001", 9, -1)], m.ratingsGeneration());
		expect(m.shown(row("T000000000000000000001", 3, 0))).toMatchObject({ value: -1, seq: 9 });
	});

	it("another account: nothing of the one before", async () => {
		const t = row();
		await saved(t, receipt());
		signIn("someone-else");
		expect(m.shown(t).s).toBeNull();
	});
});

describe("R-HUI-02: a rating given meanwhile in this app (sheet, player keys) shows", () => {
	it("a newer rating from the sheet wins over the one confirmed here before", async () => {
		const t = row();
		await saved(t, receipt({ value: 1 }));
		expect(m.shown(t).value).toBe(1);
		await new Promise((r) => setTimeout(r, 2));
		fakeStore.setThumb(t.id, -1); // the sheet on the start page
		expect(m.shown(t)).toMatchObject({ value: -1, seq: 4 });
		// A list read after both (the Verlauf opened again) wins over both.
		await new Promise((r) => setTimeout(r, 2));
		m.noteListed([row(t.id, 7, 0)], m.ratingsGeneration());
		expect(m.shown(t)).toMatchObject({ value: 0, seq: 7 });
	});
});

describe("R-HUI-03: taking back — refused, unknown and unclear kept apart", () => {
	it("answer lost, receipt unreadable: unclear (not 'nicht zurückgenommen'), also for the live region; looking again finds it", async () => {
		const t = row();
		await saved(t, receipt());
		calls.undo.mockRejectedValueOnce(new FakeApiError(0, "offline", "Keine Verbindung"));
		calls.receipt.mockRejectedValueOnce(new FakeApiError(0, "offline", "Keine Verbindung"));
		m.undo(t);
		await settle();
		await settle();
		expect(m.shown(t).s?.phase).toBe("undo-unclear");
		expect(m.lastSaid()).toMatch(/unklar, ob zurückgenommen/);
		expect(m.lastSaid()).not.toMatch(/nicht zurückgenommen/);
		expect(calls.undo).toHaveBeenCalledTimes(1);
		calls.receipt.mockResolvedValueOnce({
			receipt: receipt({ undo: { at: 2, outcome: "undone", notes: [], value: 0, seq: 5 } }),
			stored: "yes",
		});
		m.recheckUndo(t);
		await settle();
		expect(m.shown(t)).toMatchObject({ value: 0, seq: 5 });
		expect(m.shown(t).s?.phase).toBe("undone");
		expect(calls.undo).toHaveBeenCalledTimes(1);
	});

	it("answer lost, receipt no longer kept: unclear; receipt without undo: surely not taken back", async () => {
		const t = row();
		await saved(t, receipt());
		calls.undo.mockRejectedValueOnce(new FakeApiError(503, "busy", "Gerade nicht"));
		calls.receipt.mockResolvedValueOnce({ receipt: null, stored: "unknown" });
		m.undo(t);
		await settle();
		await settle();
		expect(m.shown(t).s?.phase).toBe("undo-unclear");
		expect(m.lastSaid()).toMatch(/unklar, ob zurückgenommen/);
		calls.receipt.mockResolvedValueOnce({ receipt: receipt(), stored: "yes" });
		m.recheckUndo(t);
		await settle();
		expect(m.shown(t).s?.phase).toBe("undo-failed");
		expect(m.lastSaid()).toMatch(/nicht zurückgenommen/);
		expect(calls.undo).toHaveBeenCalledTimes(1);
	});

	it("a refusal is said as one; the undo answer 'not known' is unclear", async () => {
		const t = row();
		await saved(t, receipt());
		calls.undo.mockRejectedValueOnce(new FakeApiError(409, "x", "Abgelehnt"));
		m.undo(t);
		await settle();
		expect(m.shown(t).s?.phase).toBe("undo-failed");
		expect(m.lastSaid()).toMatch(/nicht zurückgenommen/);
		calls.undo.mockResolvedValueOnce({ receipt: null });
		m.undo(t);
		await settle();
		expect(m.shown(t).s?.phase).toBe("undo-unclear");
	});
});

describe("lost rating answers", () => {
	it("no answer in time: a request that may still arrive is unclear, even when the receipt says 'not yet'", async () => {
		const t = row();
		calls.rate.mockRejectedValueOnce(new FakeApiError(0, "timeout", "Keine rechtzeitige Antwort"));
		calls.receipt.mockResolvedValueOnce({ receipt: null, stored: "no" });
		m.rate(t, 1);
		await settle();
		await settle();
		expect(m.shown(t).s?.phase).toBe("unclear");
		expect(m.lastSaid()).toMatch(/unklar, ob gespeichert/);
		// HUI-RT-002: looking again, any number of times, while it is still not
		// there: still unclear — it may still arrive. Never "not stored".
		for (let i = 0; i < 3; i++) {
			calls.receipt.mockResolvedValueOnce({ receipt: null, stored: "no" });
			m.recheck(t);
			await settle();
			expect(m.shown(t).s?.phase).toBe("unclear");
			expect(m.shown(t).s?.intent?.mayStillArrive).toBe(true);
			expect(m.lastSaid()).not.toMatch(/nicht gespeichert/);
		}
		// The original arrives after all: the next look finds it, stored once.
		calls.receipt.mockResolvedValueOnce({
			receipt: receipt({ id: calls.rate.mock.calls[0]![0].actionId }),
			stored: "yes",
			current: { value: 1, seq: 4 },
		});
		m.recheck(t);
		await settle();
		expect(m.shown(t)).toMatchObject({ value: 1, seq: 4 });
		expect(m.shown(t).s?.phase).toBe("saved");
		expect(calls.rate).toHaveBeenCalledTimes(1);
		expect(calls.undo).not.toHaveBeenCalled();
	});

	it("HUI-RT-002: after a timeout, sending again keeps the same decision and the uncertainty", async () => {
		const t = row();
		calls.rate.mockRejectedValueOnce(new FakeApiError(0, "timeout", "Keine rechtzeitige Antwort"));
		calls.receipt.mockResolvedValueOnce({ receipt: null, stored: "no" });
		m.rate(t, -1);
		await settle();
		await settle();
		expect(m.shown(t).s?.phase).toBe("unclear");
		// Sending again (offline this time): still the same id and basis, still unclear.
		calls.rate.mockRejectedValueOnce(new FakeApiError(0, "offline", "Keine Verbindung"));
		calls.receipt.mockResolvedValueOnce({ receipt: null, stored: "no" });
		m.rate(t, -1, true);
		await settle();
		await settle();
		expect(m.shown(t).s?.phase).toBe("unclear");
		expect(m.shown(t).s?.intent?.mayStillArrive).toBe(true);
		expect(calls.rate).toHaveBeenCalledTimes(2);
		expect(calls.rate.mock.calls[1]![0]).toEqual(calls.rate.mock.calls[0]![0]);
	});

	it("HUI-RT-002: a certain refusal (4xx) is not stored, and nothing is looked up", async () => {
		const t = row();
		calls.rate.mockRejectedValueOnce(new FakeApiError(400, "bad", "Ungültig"));
		m.rate(t, 1);
		await settle();
		expect(m.shown(t).s?.phase).toBe("failed");
		expect(m.shown(t).s?.intent?.mayStillArrive).toBe(false);
		expect(calls.receipt).not.toHaveBeenCalled();
		expect(fakeStore.setThumb).not.toHaveBeenCalled();
	});

	it("'not stored' only when the server proves it; otherwise unclear; never a second write by itself", async () => {
		const t = row();
		calls.rate.mockRejectedValueOnce(new FakeApiError(0, "offline", "Keine Verbindung"));
		calls.receipt.mockResolvedValueOnce({ receipt: null, stored: "no" });
		m.rate(t, 1);
		await settle();
		await settle();
		expect(m.shown(t).s?.phase).toBe("failed");
		calls.rate.mockRejectedValueOnce(new FakeApiError(0, "offline", "Keine Verbindung"));
		calls.receipt.mockResolvedValueOnce({ receipt: null, stored: "unknown" });
		m.rate(t, 1, true);
		await settle();
		await settle();
		expect(m.shown(t).s?.phase).toBe("unclear");
		expect(calls.rate).toHaveBeenCalledTimes(2);
		// The retry kept the decision's id and basis.
		expect(calls.rate.mock.calls[1]![0]).toEqual(calls.rate.mock.calls[0]![0]);
	});
});

describe("HUI-RT-001: a late or historical receipt never overrides a newer state", () => {
	const neverStale = () =>
		expect(fakeStore.setThumb.mock.calls.filter(([, v]) => v === 1)).toHaveLength(0);

	for (const clock of ["same millisecond", "ordered times"] as const) {
		it(`held answer after a newer list (${clock}): the list's value and number stay`, async () => {
			const spy =
				clock === "same millisecond" ? vi.spyOn(Date, "now").mockReturnValue(1_000) : null;
			try {
				const t = row();
				const answer = held<unknown>();
				calls.rate.mockReturnValueOnce(answer.p);
				m.rate(t, 1);
				// Rated -1 elsewhere since; the Verlauf read again shows it (seq 5).
				m.noteListed([row(t.id, 5, -1)], m.ratingsGeneration());
				calls.receipt.mockResolvedValueOnce({
					receipt: receipt(),
					stored: "yes",
					current: { value: -1, seq: 5 },
				});
				answer.resolve({ kind: "done", receipt: receipt({ value: 1, seq: 4 }) });
				await settle();
				await settle();
				expect(m.shown(t)).toMatchObject({ value: -1, seq: 5 });
				expect(m.shown(t).s).toMatchObject({ phase: "saved", overtaken: true });
				neverStale();
			} finally {
				spy?.mockRestore();
			}
		});

		it(`held answer after a rating from the sheet (${clock}): the sheet's rating stays`, async () => {
			const spy =
				clock === "same millisecond" ? vi.spyOn(Date, "now").mockReturnValue(2_000) : null;
			try {
				const t = row();
				const answer = held<unknown>();
				calls.rate.mockReturnValueOnce(answer.p);
				m.rate(t, 1);
				if (!spy) await new Promise((r) => setTimeout(r, 2));
				fakeStore.setThumb(t.id, -1); // the sheet, confirmed meanwhile
				fakeStore.setThumb.mockClear();
				calls.receipt.mockResolvedValueOnce({
					receipt: receipt(),
					stored: "yes",
					current: { value: -1, seq: 5 },
				});
				answer.resolve({ kind: "done", receipt: receipt({ value: 1, seq: 4 }) });
				await settle();
				await settle();
				expect(m.shown(t)).toMatchObject({ value: -1, seq: 5 });
				expect(m.shown(t).s?.overtaken).toBe(true);
				neverStale();
			} finally {
				spy?.mockRestore();
			}
		});
	}

	it("held answer after the sheet, and the rating now cannot be read: the sheet's rating stays shown", async () => {
		const t = row();
		const answer = held<unknown>();
		calls.rate.mockReturnValueOnce(answer.p);
		m.rate(t, 1);
		fakeStore.setThumb(t.id, -1);
		fakeStore.setThumb.mockClear();
		calls.receipt.mockRejectedValueOnce(new FakeApiError(0, "offline", "Keine Verbindung"));
		answer.resolve({ kind: "done", receipt: receipt({ value: 1, seq: 4 }) });
		await settle();
		await settle();
		expect(m.shown(t).value).toBe(-1);
		expect(m.shown(t).s?.error).toMatch(/ließ sich nicht lesen/);
		neverStale();
	});

	it("lost answer, receipt already taken back: shown as taken back, with the rating now", async () => {
		const t = row();
		calls.rate.mockRejectedValueOnce(new FakeApiError(0, "timeout", "Keine rechtzeitige Antwort"));
		calls.receipt.mockResolvedValueOnce({
			receipt: receipt({ undo: { at: 2, outcome: "undone", notes: [], value: 0, seq: 5 } }),
			stored: "yes",
			current: { value: 0, seq: 5 },
		});
		m.rate(t, 1);
		await settle();
		await settle();
		expect(m.shown(t)).toMatchObject({ value: 0, seq: 5 });
		expect(m.shown(t).s).toMatchObject({ phase: "undone", alreadyUndone: true });
		neverStale();
	});

	it("lost answer, receipt overtaken since: the newer rating with its number", async () => {
		const t = row();
		calls.rate.mockRejectedValueOnce(new FakeApiError(0, "offline", "Keine Verbindung"));
		calls.receipt.mockResolvedValueOnce({
			receipt: receipt({ superseded: true }),
			stored: "yes",
			current: { value: -1, seq: 6 },
		});
		m.rate(t, 1);
		await settle();
		await settle();
		expect(m.shown(t)).toMatchObject({ value: -1, seq: 6 });
		expect(m.shown(t).s).toMatchObject({ phase: "saved", overtaken: true });
		neverStale();
	});

	it("an old 'rated since' answer after a newer list: the list stays", async () => {
		const t = row();
		const answer = held<unknown>();
		calls.rate.mockReturnValueOnce(answer.p);
		m.rate(t, 1);
		m.noteListed([row(t.id, 8, -1)], m.ratingsGeneration());
		calls.receipt.mockResolvedValueOnce({
			receipt: null,
			stored: "unknown",
			current: { value: -1, seq: 8 },
		});
		answer.resolve({ kind: "changed", current: { value: 1, seq: 6 } });
		await settle();
		await settle();
		expect(m.shown(t)).toMatchObject({ value: -1, seq: 8 });
		expect(m.shown(t).s?.phase).toBe("changed");
		neverStale();
	});

	it("an old undo answer after a newer list: the list stays", async () => {
		const t = row();
		await saved(t, receipt({ value: -1, seq: 4 }));
		fakeStore.setThumb.mockClear();
		const answer = held<unknown>();
		calls.undo.mockReturnValueOnce(answer.p);
		m.undo(t);
		m.noteListed([row(t.id, 7, 1)], m.ratingsGeneration());
		calls.receipt.mockResolvedValueOnce({
			receipt: receipt(),
			stored: "yes",
			current: { value: 1, seq: 7 },
		});
		answer.resolve({
			receipt: receipt({
				value: -1,
				seq: 4,
				undo: { at: 2, outcome: "undone", notes: [], value: 0, seq: 5 },
			}),
		});
		await settle();
		await settle();
		expect(m.shown(t)).toMatchObject({ value: 1, seq: 7 });
		expect(fakeStore.setThumb.mock.calls.filter(([, v]) => v === 0)).toHaveLength(0);
	});

	it("a held answer after signing out and in: nothing told, nothing shown", async () => {
		const t = row();
		const answer = held<unknown>();
		calls.rate.mockReturnValueOnce(answer.p);
		m.rate(t, 1);
		fakeStore.load = { kind: "signed-out" };
		fakeStore.emit();
		signIn("mika");
		answer.resolve({ kind: "done", receipt: receipt({ superseded: true }) });
		await settle();
		await settle();
		expect(m.shown(t).s).toBeNull();
		expect(calls.receipt).not.toHaveBeenCalled();
		expect(fakeStore.setThumb).not.toHaveBeenCalled();
	});
});

describe("HUI-RT-003/004/005: what a row says, and the playback hint beside it", () => {
	let txt: typeof import("../../src/client/history-ratings-text");
	beforeEach(async () => {
		txt = await import("../../src/client/history-ratings-text");
	});
	const s = (over: Record<string, unknown>) =>
		({
			phase: "idle",
			value: 0,
			seq: 3,
			intent: null,
			receipt: null,
			error: null,
			overtaken: false,
			alreadyUndone: false,
			seen: undefined,
			op: 1,
			...over,
		}) as never;

	it("Spotify: a skip is said; a Home Assistant player: no skip is promised", () => {
		expect(txt.playbackHint(0, null, { native: false })).toMatch(
			/Spotify: „Nie wieder“ überspringt ihn/,
		);
		const native = txt.playbackHint(0, null, { native: true });
		expect(native).toMatch(/Home Assistant/);
		expect(native).toMatch(/nicht übersprungen/);
		expect(native).not.toMatch(/überspringt/);
		expect(txt.playbackHint(0, null, null)).toBe("");
		expect(txt.playbackHint(-1, null, { native: false })).toBe("");
	});

	it("the hint stays after a refusal, a 'rated since', a failed undo and an unclear answer; not while busy", () => {
		for (const phase of ["failed", "changed", "undo-failed", "unclear", "undo-unclear", "saved"])
			expect(
				txt.playbackHint(1, s({ phase, error: "Synthetic bad request" }), { native: false }),
			).toMatch(/überspringt ihn/);
		for (const phase of ["saving", "checking", "undoing"])
			expect(txt.playbackHint(1, s({ phase }), { native: false })).toBe("");
		// The status line itself carries no hint: the two are apart.
		expect(txt.ratingLine(1, s({ phase: "failed", error: "Synthetic bad request" }))).toBe(
			"Nicht gespeichert: Synthetic bad request",
		);
	});

	it("HUI-RT-003: a failed fresh read is said apart from the stored rating", () => {
		const line = txt.ratingLine(
			-1,
			s({
				phase: "saved",
				receipt: receipt({
					value: -1,
					skip: "failed",
					skipStage: "read",
					skipError: "Spotify 503",
				}),
			}),
		);
		expect(line).toMatch(/^Gespeichert: Nie wieder\./);
		expect(line).toMatch(/ließ sich nicht prüfen \(Spotify 503\)/);
		expect(line).toMatch(/Überspringen fehlgeschlagen/);
	});

	it("overtaken and already taken back say what held and what holds", () => {
		expect(
			txt.ratingLine(-1, s({ phase: "saved", overtaken: true, receipt: receipt({ value: 1 }) })),
		).toBe("Gespeichert war: Favorit — inzwischen anders bewertet (jetzt: Nie wieder).");
		expect(
			txt.ratingLine(
				0,
				s({
					phase: "undone",
					alreadyUndone: true,
					receipt: receipt({ undo: { at: 2, outcome: "undone", notes: [], value: 0, seq: 5 } }),
				}),
			),
		).toBe("Gespeichert, aber schon zurückgenommen: jetzt keine Bewertung.");
	});
});
