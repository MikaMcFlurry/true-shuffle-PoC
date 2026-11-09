/**
 * Answers on Home (CTO-01..04): one request per song at a time, the newest
 * answer wins whatever order the answers arrive in, a repeated tap changes
 * nothing, a refusal is said with its own retry, and an answer about one
 * occurrence of a song never reaches another.
 */
import { describe, expect, it } from "vitest";
import { Answers, NOT_SENT_MOVED_ON } from "../../src/client/home-answers";

type Sent = {
	trackId: string;
	value: number;
	resolve: (r: string) => void;
	reject: (e: Error) => void;
};

function harness(current = "s:e0") {
	const sent: Sent[] = [];
	const stored: {
		trackId: string;
		value: number;
		occurrence: string;
		result: string | null;
		final: boolean;
	}[] = [];
	let now = current;
	let changes = 0;
	const a = new Answers<number, string>(
		(trackId, value) =>
			new Promise<string>((resolve, reject) => sent.push({ trackId, value, resolve, reject })),
		() => now,
		() => {
			changes++;
		},
		(x, final) =>
			stored.push({
				trackId: x.trackId,
				value: x.value,
				occurrence: x.occurrence,
				result: x.result,
				final,
			}),
	);
	return {
		a,
		sent,
		stored,
		move: (o: string) => {
			now = o;
		},
		changes: () => changes,
	};
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Home answers", () => {
	it("a newer answer waits for the one on its way; each stored answer is reported, only the newest as final", async () => {
		const { a, sent, stored } = harness();
		a.give("A", "s:e0", 1);
		a.give("A", "s:e0", -1);
		// One request at a time: the server sees the answers in the order given.
		expect(sent.map((x) => x.value)).toEqual([1]);
		expect(a.pending("A", "s:e0")).toBe(-1);
		sent[0]!.resolve("ok-1");
		await tick();
		expect(sent.map((x) => x.value)).toEqual([1, -1]);
		// Stored meanwhile: it holds until the newer one is stored too.
		expect(stored).toEqual([
			{ trackId: "A", value: 1, occurrence: "s:e0", result: "ok-1", final: false },
		]);
		sent[1]!.resolve("ok-2");
		await tick();
		expect(stored).toEqual([
			{ trackId: "A", value: 1, occurrence: "s:e0", result: "ok-1", final: false },
			{ trackId: "A", value: -1, occurrence: "s:e0", result: "ok-2", final: true },
		]);
		expect(a.of("A")).toMatchObject({ phase: "saved", value: -1 });
	});

	it("a repeated tap of the answer on its way sends nothing more", async () => {
		const { a, sent } = harness();
		expect(a.give("A", "s:e0", 1)).toBe(true);
		expect(a.give("A", "s:e0", 1)).toBe(false);
		a.give("A", "s:e0", -1);
		expect(a.give("A", "s:e0", -1)).toBe(false);
		sent[0]!.resolve("x");
		await tick();
		expect(sent.map((x) => x.value)).toEqual([1, -1]);
	});

	it("an answer given back to the one on its way ends with it: no second write", async () => {
		const { a, sent, stored } = harness();
		a.give("A", "s:e0", 1);
		a.give("A", "s:e0", -1);
		a.give("A", "s:e0", 1);
		sent[0]!.resolve("x");
		await tick();
		expect(sent.map((x) => x.value)).toEqual([1]);
		expect(stored.map((x) => x.value)).toEqual([1]);
	});

	it("a refusal is said, nothing is stored, and the retry sends the same answer once", async () => {
		const { a, sent, stored } = harness();
		a.give("A", "s:e0", 1);
		sent[0]!.reject(new Error("Synthetic 503"));
		await tick();
		expect(a.of("A")).toMatchObject({ phase: "failed", value: 1, error: "Synthetic 503" });
		expect(stored).toEqual([]);
		expect(a.retry("A")).toBe(true);
		expect(a.retry("A")).toBe(false);
		sent[1]!.resolve("ok");
		await tick();
		expect(sent.map((x) => x.value)).toEqual([1, 1]);
		expect(stored.map((x) => x.value)).toEqual([1]);
	});

	it("a newer answer still goes when the older one is refused", async () => {
		const { a, sent, stored } = harness();
		a.give("A", "s:e0", 1);
		a.give("A", "s:e0", -1);
		sent[0]!.reject(new Error("Synthetic 503"));
		await tick();
		expect(sent.map((x) => x.value)).toEqual([1, -1]);
		sent[1]!.resolve("ok");
		await tick();
		expect(stored.map((x) => x.value)).toEqual([-1]);
	});

	it("an answer waiting when its occurrence is over is not sent; a retry there is refused", async () => {
		const h = harness();
		h.a.give("A", "s:e0", 1);
		h.a.give("A", "s:e0", -1);
		h.move("s:e1");
		h.sent[0]!.resolve("x");
		await tick();
		expect(h.sent.map((x) => x.value)).toEqual([1]);
		expect(h.a.of("A")).toMatchObject({
			phase: "failed",
			occurrence: "s:e0",
			error: NOT_SENT_MOVED_ON,
		});
		expect(h.a.retry("A")).toBe(false);
		// The first answer was stored all the same, and is reported (not as final).
		expect(h.stored).toEqual([
			{ trackId: "A", value: 1, occurrence: "s:e0", result: "x", final: false },
		]);
	});

	it("A, B, A again: the late answer about the first A belongs to it, the new A starts afresh", async () => {
		const h = harness();
		h.a.give("A", "s:e0", 1);
		h.move("s:e1");
		h.move("s:e2");
		// Given on the new occurrence while the first answer is still on its way: it waits, then goes.
		h.a.give("A", "s:e2", -1);
		expect(h.a.pending("A", "s:e2")).toBe(-1);
		expect(h.a.pending("A", "s:e0")).toBeUndefined();
		h.sent[0]!.resolve("first");
		await tick();
		expect(h.sent.map((x) => x.value)).toEqual([1, -1]);
		h.sent[1]!.resolve("second");
		await tick();
		expect(h.stored).toEqual([
			{ trackId: "A", value: 1, occurrence: "s:e0", result: "first", final: false },
			{ trackId: "A", value: -1, occurrence: "s:e2", result: "second", final: true },
		]);
	});

	it("Favorit stored, the newer Nie wieder refused: the stored Favorit is reported, the refusal kept with its retry", async () => {
		const { a, sent, stored } = harness();
		a.give("A", "s:e0", 1);
		a.give("A", "s:e0", -1);
		sent[0]!.resolve("ok-1");
		await tick();
		sent[1]!.reject(new Error("Synthetic 503"));
		await tick();
		expect(stored).toEqual([
			{ trackId: "A", value: 1, occurrence: "s:e0", result: "ok-1", final: false },
		]);
		expect(a.of("A")).toMatchObject({ phase: "failed", value: -1, error: "Synthetic 503" });
		expect(a.retry("A")).toBe(true);
		sent[2]!.resolve("ok-3");
		await tick();
		expect(sent.map((x) => x.value)).toEqual([1, -1, -1]);
		expect(stored.at(-1)).toEqual({
			trackId: "A",
			value: -1,
			occurrence: "s:e0",
			result: "ok-3",
			final: true,
		});
	});

	it("after close, answers still arriving change nothing", async () => {
		const h = harness();
		h.a.give("A", "s:e0", 1);
		const before = h.changes();
		h.a.close();
		h.sent[0]!.resolve("late");
		await tick();
		expect(h.stored).toEqual([]);
		expect(h.changes()).toBe(before);
	});
});
