/**
 * Product conformance: the actual store and Verlauf ratings (fresh modules per
 * replay, `api` answered by the synthetic server, Date frozen and moved only
 * by `tick`) against the model, 100 fixed seeds of at most 25 commands. A
 * failing seed is shrunk and its minimal trace is part of the failure. No
 * skips, no expected failures: a red product finding stays red.
 *
 * Beside the seeds, named deterministic traces (TS-RATING-UNDO-EVIDENCE-R2):
 * one per contract C1–C8 (the same commands as the named contract cases of
 * model.test.ts, where a test-local fault turns each red under its contract),
 * and a Verlauf undo carried to its end: request and answer applied, then the
 * final Verlauf value and write number, store value and open sheet checked
 * against fixed values as well as against the model. A test-local
 * counter-probe withholds the undo answer from the product and must turn the
 * undo traces red.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Port, realAdapter } from "./adapter";
import { type Command, commandsArb, SEEDS, show } from "./commands";
import type { ContractId } from "./model";
import { type Env, replay } from "./replay";

const OUT = process.env.RATING_MODEL_EVIDENCE;

let port: Port | null = null;
/** Counter-probe only: the product never hears the answer to its undo request. */
let withholdUndoAnswer = false;
const api = vi.hoisted(() => ({
	state: vi.fn(),
	history: vi.fn(),
	rateFromHistory: vi.fn(),
	historyRatingReceipt: vi.fn(),
	undoHistoryRating: vi.fn(),
}));
vi.mock("../../../src/client/api", () => ({
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			public code: string,
			message: string,
		) {
			super(message);
		}
	},
	api,
}));

beforeEach(() => {
	api.state.mockImplementation(() => port!.state());
	api.history.mockImplementation(() => port!.history());
	api.rateFromHistory.mockImplementation((r) => port!.rateFromHistory(r));
	api.historyRatingReceipt.mockImplementation((id, t, b) => port!.historyRatingReceipt(id, t, b));
	api.undoHistoryRating.mockImplementation((id) =>
		withholdUndoAnswer
			? port!.undoHistoryRating(id).then(() => new Promise<never>(() => {}))
			: port!.undoHistoryRating(id),
	);
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
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	port = null;
	withholdUndoAnswer = false;
});

const env: Env = {
	async flush() {
		for (let i = 0; i < 30; i++) await Promise.resolve();
	},
	tick() {
		vi.setSystemTime(Date.now() + 1);
	},
	now: () => Date.now(),
};

async function run(cmds: Command[]) {
	vi.resetModules();
	vi.useFakeTimers({ now: Date.UTC(2026, 9, 1, 12) });
	return replay(
		cmds,
		async (p) => {
			port = p;
			const { store } = await import("../../../src/client/store");
			const ratings = await import("../../../src/client/history-ratings");
			return realAdapter(store, ratings, p);
		},
		env,
	);
}

const sampleOf = (seed: number) => fc.sample(commandsArb, { seed, numRuns: 1 })[0]!;

it.each(SEEDS)("seed %i: store + Verlauf follow the model (trace repeatable)", async (seed) => {
	const cmds = sampleOf(seed);
	const a = await run(cmds);
	const b = await run(cmds);
	expect(b.sha256).toBe(a.sha256);
	let shrunk: { commands: string[]; violations: unknown; sha256: string } | null = null;
	if (a.violations.length) {
		const res = await fc.check(
			fc.asyncProperty(commandsArb, async (c) => (await run(c)).violations.length === 0),
			{ seed, numRuns: 1 },
		);
		const c = (res.counterexample?.[0] ?? cmds) as Command[];
		const r = await run(c);
		shrunk = { commands: c.map(show), violations: r.violations, sha256: r.sha256 };
	}
	if (OUT) {
		mkdirSync(join(OUT, "conformance"), { recursive: true });
		writeFileSync(
			join(OUT, "conformance", `seed-${seed}.json`),
			JSON.stringify(
				{ seed, sha256: a.sha256, trace: JSON.parse(a.trace), ops: a.ops, shrunk },
				null,
				1,
			),
		);
	}
	expect(a.violations, JSON.stringify({ seed, shrunk }, null, 1)).toEqual([]);
});

/** "A=v@rev/store … sheet:X=v" as in the trace's `observed`. */
const ABC = "B=1@3/1 C=-1@2/-1";

interface Named {
	name: string;
	cmds: Command[];
	/** The trace's last `observed`: Verlauf value@write/store value, open sheet. */
	final: string;
	/** The server's ratings at the end. */
	server: string;
}

/**
 * One named trace per contract; the same commands as in model.test.ts, where
 * a test-local fault turns each red under exactly this contract.
 */
const CONTRACT_CASES: Record<ContractId, Named> = {
	C1: {
		name: "newer writes heard by a snapshot, then a first page: the shown number only rises",
		cmds: [
			{ k: "ext", s: 0, v: 1 },
			{ k: "snapAsk" },
			{ k: "snapAnswer" },
			{ k: "ext", s: 0, v: -1 },
			{ k: "listAsk", songs: [true, true, true] },
			{ k: "listAnswer" },
		],
		final: `A=-1@3/-1 ${ABC}`,
		server: "A=-1@3 B=1@3 C=-1@2",
	},
	C2: {
		name: "a newer write heard by a snapshot is shown with its value",
		cmds: [{ k: "ext", s: 2, v: 1 }, { k: "snapAsk" }, { k: "snapAnswer" }],
		final: "A=0@1/0 B=1@3/1 C=1@3/1",
		server: "A=0@1 B=1@3 C=1@3",
	},
	C3: {
		name: "a rating given here shows at once, also past a same-millisecond snapshot",
		cmds: [{ k: "thumb", s: 1, v: -1 }, { k: "snapAsk" }, { k: "snapAnswer" }],
		final: "A=0@1/0 B=-1@4/-1 C=-1@2/-1",
		server: "A=0@1 B=-1@4 C=-1@2",
	},
	C4: {
		name: "a decision a later page accounted for gives way to a newer write heard without it",
		cmds: [
			{ k: "listAsk", songs: [true, true, true] },
			{ k: "listAnswer" },
			{ k: "thumb", s: 0, v: 1 },
			{ k: "listAsk", songs: [true, false, false] },
			{ k: "ext", s: 0, v: -1 },
			{ k: "listAnswer" },
			{ k: "snapAsk" },
			{ k: "snapAnswer" },
		],
		final: `A=-1@3/-1 ${ABC}`,
		server: "A=-1@3 B=1@3 C=-1@2",
	},
	C5: {
		name: "the open sheet shows what store and Verlauf show, through a decision and a later snapshot",
		cmds: [
			{ k: "open", s: 0 },
			{ k: "thumb", s: 0, v: 1 },
			{ k: "tick" },
			{ k: "snapAsk" },
			{ k: "snapAnswer" },
		],
		final: `A=1@2/1 ${ABC} sheet:A=1`,
		server: "A=1@2 B=1@3 C=-1@2",
	},
	C6: {
		name: "a later Verlauf page counts its write numbers",
		cmds: [
			{ k: "listAsk", songs: [true, true, true] },
			{ k: "listAnswer" },
			{ k: "ext", s: 1, v: -1 },
			{ k: "listAsk", songs: [false, true, false] },
			{ k: "listAnswer" },
		],
		final: "A=0@1/0 B=-1@4/-1 C=-1@2/-1",
		server: "A=0@1 B=-1@4 C=-1@2",
	},
	C7: {
		name: "a snapshot answered after a page heard a newer write changes nothing",
		cmds: [
			{ k: "snapAsk" },
			{ k: "ext", s: 2, v: 1 },
			{ k: "listAsk", songs: [true, true, true] },
			{ k: "listAnswer" },
			{ k: "snapAnswer" },
		],
		final: "A=0@1/0 B=1@3/1 C=1@3/1",
		server: "A=0@1 B=1@3 C=1@3",
	},
	C8: {
		name: "a page at the number already known accounts for the decision it saw",
		cmds: [
			{ k: "listAsk", songs: [true, true, true] },
			{ k: "listAnswer" },
			{ k: "thumb", s: 0, v: 1 },
			{ k: "ext", s: 0, v: -1 },
			{ k: "snapAsk" },
			{ k: "snapAnswer" },
			{ k: "listAsk", songs: [true, false, false] },
			{ k: "listAnswer" },
		],
		final: `A=-1@3/-1 ${ABC}`,
		server: "A=-1@3 B=1@3 C=-1@2",
	},
};

/** A Verlauf rating on A (1 at write 2), confirmed, sheet open on A. */
const RATED: Command[] = [
	{ k: "listAsk", songs: [true, true, true] },
	{ k: "listAnswer" },
	{ k: "open", s: 0 },
	{ k: "rate", s: 0, v: 1 },
	{ k: "opAnswer", s: 0 },
];
const READ: Command[] = [{ k: "tick" }, { k: "snapAsk" }, { k: "snapAnswer" }];

interface UndoCase extends Named {
	/** The undo answer: its outcome, whether it is below the newest known, what shows right after it. */
	outcome: "undone" | "conflict";
	late: boolean;
	afterAnswer: string;
	/** Whether withholding the answer from the product must be seen (false: inert by C7). */
	probeRed: boolean;
}

const UNDO_CASES: Record<string, UndoCase> = {
	U1_undone: {
		name: "undo answered: the earlier value at the undo's write number, kept by a later read",
		cmds: [...RATED, { k: "undo", s: 0 }, { k: "opAnswer", s: 0 }, ...READ],
		outcome: "undone",
		late: false,
		afterAnswer: `A=0@3/0 ${ABC} sheet:A=0`,
		final: `A=0@3/0 ${ABC} sheet:A=0`,
		server: "A=0@3 B=1@3 C=-1@2",
		probeRed: true,
	},
	U2_conflict: {
		name: "undo after a newer write elsewhere: conflict, the newer write shows",
		cmds: [
			...RATED,
			{ k: "ext", s: 0, v: -1 },
			{ k: "undo", s: 0 },
			{ k: "opAnswer", s: 0 },
			...READ,
		],
		outcome: "conflict",
		late: false,
		afterAnswer: `A=-1@3/-1 ${ABC} sheet:A=-1`,
		final: `A=-1@3/-1 ${ABC} sheet:A=-1`,
		server: "A=-1@3 B=1@3 C=-1@2",
		probeRed: true,
	},
	U3_late: {
		name: "undo answered after a snapshot heard a newer write: inert, then a read",
		cmds: [
			...RATED,
			{ k: "undo", s: 0 },
			{ k: "ext", s: 0, v: -1 },
			{ k: "snapAsk" },
			{ k: "snapAnswer" },
			{ k: "opAnswer", s: 0 },
			...READ,
		],
		outcome: "undone",
		late: true,
		afterAnswer: `A=-1@4/-1 ${ABC} sheet:A=-1`,
		final: `A=-1@4/-1 ${ABC} sheet:A=-1`,
		server: "A=-1@4 B=1@3 C=-1@2",
		probeRed: false,
	},
	U4_answerBeforeRead: {
		name: "undo answered after a newer write not yet heard: taken, then a read brings the newer write",
		cmds: [
			...RATED,
			{ k: "undo", s: 0 },
			{ k: "ext", s: 0, v: -1 },
			{ k: "opAnswer", s: 0 },
			...READ,
		],
		outcome: "undone",
		late: false,
		afterAnswer: `A=0@3/0 ${ABC} sheet:A=0`,
		final: `A=-1@4/-1 ${ABC} sheet:A=-1`,
		server: "A=-1@4 B=1@3 C=-1@2",
		probeRed: true,
	},
	U5_ratedMeanwhile: {
		name: "a rating given here while the undo is on its way: the rating now is taken",
		cmds: [
			...RATED,
			{ k: "undo", s: 0 },
			{ k: "thumb", s: 0, v: -1 },
			{ k: "opAnswer", s: 0 },
			...READ,
		],
		outcome: "undone",
		late: false,
		afterAnswer: `A=-1@4/-1 ${ABC} sheet:A=-1`,
		final: `A=-1@4/-1 ${ABC} sheet:A=-1`,
		server: "A=-1@4 B=1@3 C=-1@2",
		probeRed: true,
	},
};

const dump = (file: string, data: unknown) => {
	if (!OUT) return;
	mkdirSync(join(OUT, "named"), { recursive: true });
	writeFileSync(join(OUT, "named", file), JSON.stringify(data, null, 1));
};

describe("named contract cases on the product", () => {
	it.each(Object.keys(CONTRACT_CASES) as ContractId[])("%s", async (id) => {
		const c = CONTRACT_CASES[id];
		const r = await run(c.cmds);
		dump(`contract-${id}.json`, {
			id,
			name: c.name,
			commands: c.cmds.map(show),
			sha256: r.sha256,
			trace: JSON.parse(r.trace),
		});
		expect(r.violations, r.trace).toEqual([]);
		expect(
			r.steps.every((s) => s.applied),
			r.trace,
		).toBe(true);
		const last = r.steps.at(-1)!;
		expect(last.observed).toBe(c.final);
		expect(last.server).toBe(c.server);
		expect((await run(c.cmds)).sha256).toBe(r.sha256);
	});
});

describe("Verlauf undo carried to its end on the product", () => {
	it.each(Object.keys(UNDO_CASES))("%s", async (id) => {
		const c = UNDO_CASES[id]!;
		const r = await run(c.cmds);
		dump(`undo-${id}.json`, {
			id,
			name: c.name,
			commands: c.cmds.map(show),
			sha256: r.sha256,
			ops: r.ops,
			trace: JSON.parse(r.trace),
		});
		expect(r.violations, r.trace).toEqual([]);
		expect(
			r.steps.every((s) => s.applied),
			r.trace,
		).toBe(true);
		// The rating, then the undo: each request sent and its answer given.
		expect(r.ops.map((o) => `${o.kind}:${o.phase}`)).toEqual([
			"rate:asked",
			"rate:answered",
			"undo:asked",
			"undo:answered",
		]);
		const u = r.ops[3]!;
		expect(u).toMatchObject({ song: "track-a", outcome: c.outcome, late: c.late });
		expect(r.steps[u.step]!.cmd).toBe("opAnswer(A)");
		expect(r.steps[u.step]!.observed).toBe(c.afterAnswer);
		const last = r.steps.at(-1)!;
		expect(last.cmd).toBe("snapAnswer");
		expect(last.observed).toBe(c.final);
		expect(last.server).toBe(c.server);
		expect((await run(c.cmds)).sha256).toBe(r.sha256);
	});

	it("counter-probe: with the undo answer withheld from the product the undo traces turn red", async () => {
		const seen: Record<string, { violations: number; contracts: string[]; undoAsked: boolean }> =
			{};
		withholdUndoAnswer = true;
		for (const [id, c] of Object.entries(UNDO_CASES)) {
			const r = await run(c.cmds);
			seen[id] = {
				violations: r.violations.length,
				contracts: [...new Set(r.violations.map((v) => v.contract))],
				undoAsked: r.ops.some((o) => o.kind === "undo" && o.phase === "asked"),
			};
			dump(`undo-counterprobe-${id}.json`, {
				id,
				withholdUndoAnswer: true,
				expectRed: c.probeRed,
				...seen[id],
				trace: JSON.parse(r.trace),
			});
		}
		withholdUndoAnswer = false;
		for (const [id, c] of Object.entries(UNDO_CASES)) {
			expect(seen[id]!.undoAsked, id).toBe(true);
			expect(seen[id]!.violations > 0, `${id}: ${JSON.stringify(seen[id])}`).toBe(c.probeRed);
		}
		// The same traces with the answer delivered are green again.
		for (const c of Object.values(UNDO_CASES)) expect((await run(c.cmds)).violations).toEqual([]);
	});
});
