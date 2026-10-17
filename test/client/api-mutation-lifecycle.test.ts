/**
 * The page's central request path counts its writes (TS-RELEASE-NOTICE-COR1-261017):
 * from before the request is sent until its answer is read, parsed and judged,
 * whatever the outcome; reads are not counted. The request, its answer and
 * its errors stay exactly what they were: no other request, no timeout of
 * its own, nothing cancelled.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, api } from "../../src/client/api";
import { pendingMutations } from "../../src/client/pending-mutations";

const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

interface Sent {
	path: string;
	init: RequestInit;
	/** Writes counted when the request went out. */
	counted: number;
	answer: (r: Response | Error) => void;
}

let sent: Sent[] = [];

beforeEach(async () => {
	sent = [];
	vi.stubGlobal(
		"fetch",
		vi.fn((path: string, init: RequestInit) => {
			const { promise, resolve, reject } = deferred<Response>();
			sent.push({
				path,
				init,
				counted: pendingMutations.count,
				answer: (r) => (r instanceof Error ? reject(r) : resolve(r)),
			});
			return promise;
		}),
	);
	await nextTask();
	expect(pendingMutations.busy(), "quiet before each case").toBe(false);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** A response whose body arrives only when the test says so (or never readable). */
function slowBody(status = 200) {
	const { promise, resolve, reject } = deferred<string>();
	const res = { ok: status >= 200 && status < 300, status, text: () => promise } as Response;
	return { res, resolve, reject };
}

async function quietAfter<T>(p: Promise<T>): Promise<PromiseSettledResult<T>> {
	const [r] = await Promise.allSettled([p]);
	await nextTask();
	expect(pendingMutations.count).toBe(0);
	expect(pendingMutations.busy()).toBe(false);
	return r!;
}

it("a write is counted before its request goes out, and the request is the one it always was", async () => {
	const p = api.thumb("track-1", 1);
	expect(sent).toHaveLength(1);
	expect(sent[0]!.counted).toBe(1);
	expect(sent[0]!.path).toBe("/api/tracks/track-1/thumb");
	expect(sent[0]!.init).toEqual({
		method: "POST",
		signal: undefined,
		credentials: "same-origin",
		headers: { "x-ts": "1", "content-type": "application/json" },
		body: JSON.stringify({ value: 1 }),
	});
	expect(pendingMutations.busy()).toBe(true);
	sent[0]!.answer(json({ skipped: false }));
	const r = await quietAfter(p);
	expect(r).toEqual({ status: "fulfilled", value: { skipped: false } });
});

it("still counted while the answer's body is on its way and being parsed", async () => {
	const p = api.updateStation(1, { name: "Neu" });
	const body = slowBody();
	sent[0]!.answer(body.res);
	await nextTask();
	await nextTask();
	expect(pendingMutations.count).toBe(1);
	expect(pendingMutations.busy()).toBe(true);
	body.resolve('{"ok":true}');
	const r = await quietAfter(p);
	expect(r).toEqual({ status: "fulfilled", value: { ok: true } });
});

it("reads are not counted", async () => {
	const p = api.state();
	expect(sent).toHaveLength(1);
	expect(sent[0]!.counted).toBe(0);
	expect(sent[0]!.init.method).toBe("GET");
	expect(pendingMutations.busy()).toBe(false);
	sent[0]!.answer(json({ onboarded: true }));
	expect(await quietAfter(p)).toEqual({ status: "fulfilled", value: { onboarded: true } });
});

it("every outcome ends exactly its own count, its result or error unchanged", async () => {
	const cases: Array<{
		name: string;
		answer: Response | Error | "body-fails";
		expect: (r: PromiseSettledResult<unknown>) => void;
	}> = [
		{
			name: "refused",
			answer: json({ error: { code: "conflict", message: "Schon anders bewertet." } }, 409),
			expect: (r) => {
				expect(r.status).toBe("rejected");
				const e = (r as PromiseRejectedResult).reason as ApiError;
				expect(e).toBeInstanceOf(ApiError);
				expect([e.status, e.code, e.message]).toEqual([409, "conflict", "Schon anders bewertet."]);
			},
		},
		{
			name: "refused without a reason",
			answer: new Response("", { status: 500 }),
			expect: (r) => {
				const e = (r as PromiseRejectedResult).reason as ApiError;
				expect([e.status, e.code, e.message]).toEqual([500, "error", "Das hat nicht geklappt."]);
			},
		},
		{
			name: "not JSON",
			answer: new Response("<html>", { status: 502 }),
			expect: (r) => {
				const e = (r as PromiseRejectedResult).reason as ApiError;
				expect([e.status, e.code, e.message]).toEqual([
					502,
					"invalid_response",
					"Der Server antwortet gerade nicht richtig. Bitte erneut verbinden.",
				]);
			},
		},
		{
			name: "offline",
			answer: new TypeError("Failed to fetch"),
			expect: (r) => {
				const e = (r as PromiseRejectedResult).reason as ApiError;
				expect([e.status, e.code, e.message]).toEqual([
					0,
					"offline",
					"Keine Verbindung — bist du online?",
				]);
			},
		},
		{
			name: "timeout",
			answer: new DOMException("late", "TimeoutError"),
			expect: (r) => {
				const e = (r as PromiseRejectedResult).reason as ApiError;
				expect([e.status, e.code, e.message]).toEqual([
					0,
					"timeout",
					"Keine rechtzeitige Antwort. Der Befehl könnte am Gerät angekommen sein.",
				]);
			},
		},
		{
			name: "the body cannot be read",
			answer: "body-fails",
			expect: () => {},
		},
	];
	for (const c of cases) {
		const p = api.thumb("track-1", -1);
		expect(pendingMutations.count, c.name).toBe(1);
		const s = sent.at(-1)!;
		if (c.answer === "body-fails") {
			const broken = new Error("stream broke");
			const body = slowBody();
			s.answer(body.res);
			await nextTask();
			expect(pendingMutations.count, c.name).toBe(1);
			body.reject(broken);
			const r = await quietAfter(p);
			// Not turned into anything else: the very error the body gave.
			expect(r).toEqual({ status: "rejected", reason: broken });
			expect((r as PromiseRejectedResult).reason).toBe(broken);
		} else {
			s.answer(c.answer);
			c.expect(await quietAfter(p));
		}
	}
});

it("a body that cannot be written: counted, not sent, the same error as before, and ended", async () => {
	const p = api.createStation({
		name: "x",
		sources: [],
		rules: { mix: BigInt(1) as unknown as number },
	});
	expect(sent).toHaveLength(0);
	const r = await quietAfter(p);
	const e = (r as PromiseRejectedResult).reason as ApiError;
	expect(e).toBeInstanceOf(ApiError);
	expect([e.status, e.code]).toEqual([0, "offline"]);
});

it("two writes at once: the first answer frees nothing; quiet only after the second", async () => {
	const told: boolean[] = [];
	const leave = pendingMutations.subscribe(() => told.push(pendingMutations.busy()));
	try {
		const a = api.thumb("track-1", 1);
		const b = api.retestVerdict("track-2", true);
		expect(pendingMutations.count).toBe(2);
		sent[0]!.answer(json({}));
		await a;
		await nextTask();
		expect(pendingMutations.count).toBe(1);
		expect(pendingMutations.busy()).toBe(true);
		sent[1]!.answer(json({}));
		await quietAfter(b);
		expect(told).toEqual([true, false]);
	} finally {
		leave();
	}
});

it("a write its answer starts (a waiting second one): no quiet moment in between, not even for a newcomer", async () => {
	const told: boolean[] = [];
	const leave = pendingMutations.subscribe(() => told.push(pendingMutations.busy()));
	const read: boolean[] = [];
	try {
		const chain = api.thumb("track-1", 1).then(() => {
			read.push(pendingMutations.busy());
			const late = pendingMutations.subscribe(() => {});
			read.push(pendingMutations.busy());
			late();
			return api.thumb("track-1", -1);
		});
		sent[0]!.answer(json({}));
		await vi.waitFor(() => expect(sent).toHaveLength(2));
		await nextTask();
		expect(read).toEqual([true, true]);
		expect(pendingMutations.count).toBe(1);
		expect(told).toEqual([true]);
		sent[1]!.answer(json({ skipped: true }));
		expect(await quietAfter(chain)).toEqual({ status: "fulfilled", value: { skipped: true } });
		expect(told).toEqual([true, false]);
	} finally {
		leave();
	}
});

it("a failing listener neither keeps the request from going out nor changes its answer or the count", async () => {
	const leave = pendingMutations.subscribe(() => {
		throw new Error("listener broke");
	});
	try {
		const p = api.player("pause");
		expect(sent).toHaveLength(1);
		expect(pendingMutations.count).toBe(1);
		sent[0]!.answer(json({ ok: true }));
		expect(await quietAfter(p)).toEqual({ status: "fulfilled", value: { ok: true } });
	} finally {
		leave();
	}
});

it("an answer that does not come: still counted, never cancelled, no other request", async () => {
	const p = api.play(1, "iphone");
	const q = api.thumb("track-1", 1);
	for (let i = 0; i < 5; i++) await nextTask();
	expect(pendingMutations.count).toBe(2);
	expect(sent).toHaveLength(2);
	const timed = sent[0]!.init.signal!;
	expect(timed).toBeInstanceOf(AbortSignal);
	expect(timed.aborted).toBe(false);
	expect(sent[1]!.init.signal).toBeUndefined();
	// Let both go, so that the next case starts quiet.
	sent[0]!.answer(json({ ok: true }));
	sent[1]!.answer(json({}));
	await quietAfter(Promise.all([p, q]));
});
