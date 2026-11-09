/**
 * Harness self-tests (no product code involved): the model's own rules, a
 * correct pure adapter passing all 100 fixed seeds, four deliberately faulty
 * pure adapters each found (by the seeds, shrunk, and by a fixed trace),
 * exactly repeatable normalised traces and the command bounds.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Adapter, type Faults, type Observation, PureAdapter } from "./adapter";
import { type Command, commandsArb, MAX_COMMANDS, SEEDS, show } from "./commands";
import { CONTRACTS, type ContractId, RatingModel } from "./model";
import { type Env, INITIAL, replay } from "./replay";

const OUT = process.env.RATING_MODEL_EVIDENCE;

function pureEnv(): Env & { clock: number } {
	const env = {
		clock: 1_000,
		async flush() {
			for (let i = 0; i < 30; i++) await Promise.resolve();
		},
		tick() {
			env.clock++;
		},
		now: () => env.clock,
	};
	return env;
}

const run = (cmds: Command[], faults: Faults = {}) => {
	const env = pureEnv();
	return replay(cmds, (port) => new PureAdapter(port, env.now, faults), env);
};

const sampleOf = (seed: number) => fc.sample(commandsArb, { seed, numRuns: 1 })[0]!;

describe("model rules", () => {
	it("keeps the highest write number; lower and equal ones change nothing", () => {
		const m = new RatingModel(INITIAL);
		m.snapshotAsked(1, 10, [
			{ v: 1, rev: 5 },
			{ v: 1, rev: 3 },
			{ v: -1, rev: 2 },
		]);
		m.snapshotAnswered(1);
		m.listAsked(2, [{ v: -1, rev: 4 }, null, null]);
		m.listAnswered(2);
		expect(m.expected(0)).toMatchObject({ v: 1, rev: 5 });
	});

	it("a decision given while a page was on its way stays; one standing when asked gives way", () => {
		const m = new RatingModel(INITIAL);
		m.listAsked(1, [{ v: 0, rev: 1 }, null, null]);
		m.localDecision(0, 1, 10);
		m.listAnswered(1);
		expect(m.expected(0)).toMatchObject({ v: 1, byDecision: true });
		m.listAsked(2, [{ v: 1, rev: 2 }, null, null]);
		m.listAnswered(2);
		expect(m.expected(0)).toMatchObject({ v: 1, rev: 2, byDecision: false });
	});

	it("a snapshot accounts for a decision only from a strictly later millisecond", () => {
		const m = new RatingModel(INITIAL);
		m.localDecision(1, -1, 10);
		m.snapshotAsked(1, 10, [
			{ v: 0, rev: 1 },
			{ v: 0, rev: 9 },
			{ v: -1, rev: 2 },
		]);
		m.snapshotAnswered(1);
		expect(m.expected(1)).toMatchObject({ v: -1, rev: 9, byDecision: true });
		m.snapshotAsked(2, 11, [
			{ v: 0, rev: 1 },
			{ v: 0, rev: 9 },
			{ v: -1, rev: 2 },
		]);
		m.snapshotAnswered(2);
		expect(m.expected(1)).toMatchObject({ v: 0, rev: 9, byDecision: false });
	});

	it("an accounted decision keeps giving way to later writes heard without it", () => {
		const m = new RatingModel(INITIAL);
		m.opAsked(2);
		m.opAnswered(2, { v: 1, rev: 5 }, { v: 1, rev: 5 }, 10);
		m.snapshotAsked(1, 10, [
			{ v: 0, rev: 1 },
			{ v: 1, rev: 3 },
			{ v: 0, rev: 7 },
		]);
		m.snapshotAnswered(1);
		expect(m.expected(2)).toMatchObject({ v: 0, rev: 7, byDecision: false });
	});

	it("a confirmation after a decision given meanwhile is not taken; the rating now is", () => {
		const m = new RatingModel(INITIAL);
		m.opAsked(0);
		m.localDecision(0, -1, 10);
		m.opAnswered(0, { v: 1, rev: 2 }, { v: -1, rev: 3 }, 10);
		expect(m.expected(0)).toMatchObject({ v: -1, rev: 3, byDecision: false });
	});
});

describe("harness", () => {
	it("100 fixed distinct seeds, each at most 25 commands, sampled identically twice", () => {
		expect(SEEDS).toHaveLength(100);
		expect(new Set(SEEDS).size).toBe(100);
		for (const seed of SEEDS) {
			const a = sampleOf(seed);
			expect(a.length).toBeGreaterThan(0);
			expect(a.length).toBeLessThanOrEqual(MAX_COMMANDS);
			expect(JSON.stringify(sampleOf(seed))).toBe(JSON.stringify(a));
		}
	});

	it("the correct pure adapter passes all 100 seeds with exactly repeatable traces", async () => {
		const hashes: Record<number, string> = {};
		for (const seed of SEEDS) {
			const cmds = sampleOf(seed);
			const a = await run(cmds);
			const b = await run(cmds);
			expect(b.sha256, `seed ${seed}`).toBe(a.sha256);
			expect(a.violations, `seed ${seed}\n${a.trace}`).toEqual([]);
			hashes[seed] = a.sha256;
		}
		if (OUT) {
			mkdirSync(OUT, { recursive: true });
			writeFileSync(
				join(OUT, "selftest-pure-correct-trace-hashes.json"),
				JSON.stringify(hashes, null, 1),
			);
		}
	});
});

/** Fixed traces that must expose each fault. */
const DIRECTED: Record<keyof Faults, { cmds: Command[]; contract: ContractId }> = {
	// Rated here, then a later page asked while it stood; another write after it
	// (same millisecond) must not bring the decision back.
	lostSeen: {
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
		contract: "C4",
	},
	ignoreFollowPage: {
		cmds: [
			{ k: "listAsk", songs: [true, true, true] },
			{ k: "listAnswer" },
			{ k: "ext", s: 1, v: -1 },
			{ k: "listAsk", songs: [false, true, false] },
			{ k: "listAnswer" },
		],
		contract: "C6",
	},
	lowerRevision: {
		cmds: [
			{ k: "snapAsk" },
			{ k: "ext", s: 2, v: 1 },
			{ k: "listAsk", songs: [true, true, true] },
			{ k: "listAnswer" },
			{ k: "snapAnswer" },
		],
		contract: "C7",
	},
	// Rated here; a same-millisecond snapshot hears a newer write without it;
	// a page asked while it stood answers at that same number and accounts for it.
	wrongTie: {
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
		contract: "C8",
	},
};

describe.each(Object.keys(DIRECTED) as (keyof Faults)[])("faulty pure adapter %s", (fault) => {
	const faults = { [fault]: true } as Faults;

	it("fails its fixed trace under the expected contract (red), the correct adapter passes it (green)", async () => {
		const { cmds, contract } = DIRECTED[fault];
		const red = await run(cmds, faults);
		expect(
			red.violations.map((v) => v.contract),
			red.trace,
		).toContain(contract);
		const green = await run(cmds);
		expect(green.violations, green.trace).toEqual([]);
	});

	it("is found by the 100 fixed seeds, and shrunk to a short counterexample", async () => {
		const found: { seed: number; contracts: ContractId[] }[] = [];
		for (const seed of SEEDS) {
			const r = await run(sampleOf(seed), faults);
			if (r.violations.length)
				found.push({ seed, contracts: [...new Set(r.violations.map((v) => v.contract))] });
		}
		expect(found.length, `${fault} not found by any seed`).toBeGreaterThan(0);
		const seed = found[0]!.seed;
		const res = await fc.check(
			fc.asyncProperty(
				commandsArb,
				async (cmds) => (await run(cmds, faults)).violations.length === 0,
			),
			{ seed, numRuns: 1 },
		);
		expect(res.failed).toBe(true);
		const shrunk = res.counterexample![0] as Command[];
		expect(shrunk.length).toBeLessThanOrEqual(sampleOf(seed).length);
		const again = await run(shrunk, faults);
		expect(again.violations.length).toBeGreaterThan(0);
		expect((await run(shrunk, faults)).sha256).toBe(again.sha256);
		if (OUT) {
			mkdirSync(OUT, { recursive: true });
			writeFileSync(
				join(OUT, `selftest-mutant-${fault}.json`),
				JSON.stringify(
					{
						fault,
						seedsFound: found.length,
						found,
						firstSeed: seed,
						shrunk: shrunk.map(show),
						shrunkSha256: again.sha256,
						shrunkViolations: again.violations,
					},
					null,
					1,
				),
			);
		}
	});
});

/**
 * Test-local faults for the contracts no pure-adapter fault covers: each wraps
 * the correct pure adapter and spoils one thing (adapter.ts unchanged).
 */
type Probe = "frozenRevision" | "staleValue" | "dropThumb" | "staleSheet";

function probed(inner: Adapter, probe: Probe): Adapter {
	let first: Observation | null = null;
	return {
		snapshotAsk: () => inner.snapshotAsk(),
		listAsk: (f) => inner.listAsk(f),
		thumb: (s, v) => {
			if (probe !== "dropThumb") inner.thumb(s, v);
		},
		rate: (s, v) => inner.rate(s, v),
		undo: (s) => inner.undo(s),
		open: (s) => inner.open(s),
		close: () => inner.close(),
		observe() {
			const o = inner.observe();
			first ??= o;
			const was = first.songs;
			if (probe === "frozenRevision")
				return {
					...o,
					songs: o.songs.map((x, i) => ({
						...x,
						verlauf: { ...x.verlauf, rev: was[i]!.verlauf.rev },
					})),
				};
			if (probe === "staleValue")
				return {
					...o,
					songs: o.songs.map((x, i) => ({
						verlauf: { ...x.verlauf, v: was[i]!.verlauf.v },
						store: was[i]!.store,
					})),
				};
			if (probe === "staleSheet" && o.sheet)
				return { ...o, sheet: { s: o.sheet.s, v: was[o.sheet.s]!.store } };
			return o;
		},
	};
}

/**
 * The eight named contract cases (the same commands as in conformance.test.ts):
 * each trace is green with the correct pure adapter and red, under exactly its
 * contract, with the fault that breaks that contract.
 */
const CONTRACT_CASES: Record<ContractId, { cmds: Command[]; fault: keyof Faults | Probe }> = {
	C1: {
		cmds: [
			{ k: "ext", s: 0, v: 1 },
			{ k: "snapAsk" },
			{ k: "snapAnswer" },
			{ k: "ext", s: 0, v: -1 },
			{ k: "listAsk", songs: [true, true, true] },
			{ k: "listAnswer" },
		],
		fault: "frozenRevision",
	},
	C2: {
		cmds: [{ k: "ext", s: 2, v: 1 }, { k: "snapAsk" }, { k: "snapAnswer" }],
		fault: "staleValue",
	},
	C3: {
		cmds: [{ k: "thumb", s: 1, v: -1 }, { k: "snapAsk" }, { k: "snapAnswer" }],
		fault: "dropThumb",
	},
	C4: { cmds: DIRECTED.lostSeen.cmds, fault: "lostSeen" },
	C5: {
		cmds: [
			{ k: "open", s: 0 },
			{ k: "thumb", s: 0, v: 1 },
			{ k: "tick" },
			{ k: "snapAsk" },
			{ k: "snapAnswer" },
		],
		fault: "staleSheet",
	},
	C6: { cmds: DIRECTED.ignoreFollowPage.cmds, fault: "ignoreFollowPage" },
	C7: { cmds: DIRECTED.lowerRevision.cmds, fault: "lowerRevision" },
	C8: { cmds: DIRECTED.wrongTie.cmds, fault: "wrongTie" },
};

const PROBES: readonly string[] = ["frozenRevision", "staleValue", "dropThumb", "staleSheet"];

function runFault(cmds: Command[], fault: keyof Faults | Probe) {
	const env = pureEnv();
	return replay(
		cmds,
		(port) =>
			PROBES.includes(fault)
				? probed(new PureAdapter(port, env.now), fault as Probe)
				: new PureAdapter(port, env.now, { [fault]: true } as Faults),
		env,
	);
}

describe("named contract cases", () => {
	it.each(Object.keys(CONTRACT_CASES) as ContractId[])(
		"%s: green with the correct adapter, red under exactly this contract with its fault",
		async (id) => {
			const { cmds, fault } = CONTRACT_CASES[id];
			const green = await run(cmds);
			expect(green.violations, green.trace).toEqual([]);
			expect(
				green.steps.every((s) => s.applied),
				green.trace,
			).toBe(true);
			const red = await runFault(cmds, fault);
			const contracts = [...new Set(red.violations.map((v) => v.contract))];
			expect(contracts, red.trace).toContain(id);
			if (OUT) {
				mkdirSync(join(OUT, "named"), { recursive: true });
				writeFileSync(
					join(OUT, "named", `selftest-contract-${id}.json`),
					JSON.stringify(
						{
							id,
							contract: CONTRACTS[id],
							commands: cmds.map(show),
							fault,
							greenSha256: green.sha256,
							redContracts: contracts,
							redViolations: red.violations,
						},
						null,
						1,
					),
				);
			}
		},
	);
});

/**
 * The undo traces of conformance.test.ts on the correct pure adapter: the
 * model's expectations, independent of the product, reach the same fixed
 * values after the undo answer and after the final read.
 */
const RATED: Command[] = [
	{ k: "listAsk", songs: [true, true, true] },
	{ k: "listAnswer" },
	{ k: "open", s: 0 },
	{ k: "rate", s: 0, v: 1 },
	{ k: "opAnswer", s: 0 },
];
const READ: Command[] = [{ k: "tick" }, { k: "snapAsk" }, { k: "snapAnswer" }];
const BC = "B=1@3 C=-1@2";

const UNDO_CASES: Record<
	string,
	{ cmds: Command[]; afterAnswer: string; final: string; late: boolean }
> = {
	U1_undone: {
		cmds: [...RATED, { k: "undo", s: 0 }, { k: "opAnswer", s: 0 }, ...READ],
		afterAnswer: `A=0@3 ${BC}`,
		final: `A=0@3 ${BC}`,
		late: false,
	},
	U2_conflict: {
		cmds: [
			...RATED,
			{ k: "ext", s: 0, v: -1 },
			{ k: "undo", s: 0 },
			{ k: "opAnswer", s: 0 },
			...READ,
		],
		afterAnswer: `A=-1@3 ${BC}`,
		final: `A=-1@3 ${BC}`,
		late: false,
	},
	U3_late: {
		cmds: [
			...RATED,
			{ k: "undo", s: 0 },
			{ k: "ext", s: 0, v: -1 },
			{ k: "snapAsk" },
			{ k: "snapAnswer" },
			{ k: "opAnswer", s: 0 },
			...READ,
		],
		afterAnswer: `A=-1@4 ${BC}`,
		final: `A=-1@4 ${BC}`,
		late: true,
	},
	U4_answerBeforeRead: {
		cmds: [
			...RATED,
			{ k: "undo", s: 0 },
			{ k: "ext", s: 0, v: -1 },
			{ k: "opAnswer", s: 0 },
			...READ,
		],
		afterAnswer: `A=0@3 ${BC}`,
		final: `A=-1@4 ${BC}`,
		late: false,
	},
	U5_ratedMeanwhile: {
		cmds: [
			...RATED,
			{ k: "undo", s: 0 },
			{ k: "thumb", s: 0, v: -1 },
			{ k: "opAnswer", s: 0 },
			...READ,
		],
		afterAnswer: `A=-1@4 ${BC}`,
		final: `A=-1@4 ${BC}`,
		late: false,
	},
};

describe("undo traces on the correct pure adapter", () => {
	it.each(Object.keys(UNDO_CASES))("%s", async (id) => {
		const c = UNDO_CASES[id]!;
		const r = await run(c.cmds);
		expect(r.violations, r.trace).toEqual([]);
		expect(
			r.steps.every((s) => s.applied),
			r.trace,
		).toBe(true);
		const u = r.ops.find((o) => o.kind === "undo" && o.phase === "answered")!;
		expect(u, r.trace).toMatchObject({ song: "track-a", late: c.late });
		expect(r.steps[u.step]!.expected).toBe(c.afterAnswer);
		expect(r.steps.at(-1)!.expected).toBe(c.final);
		if (OUT) {
			mkdirSync(join(OUT, "named"), { recursive: true });
			writeFileSync(
				join(OUT, "named", `selftest-undo-${id}.json`),
				JSON.stringify(
					{
						id,
						commands: c.cmds.map(show),
						sha256: r.sha256,
						ops: r.ops,
						trace: JSON.parse(r.trace),
					},
					null,
					1,
				),
			);
		}
	});
});
