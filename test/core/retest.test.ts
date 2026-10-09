import { describe, expect, it } from "vitest";
import {
	coolingDown,
	PROBE_GAP_MS,
	probeDue,
	retestAfter,
	skipsWeigh,
	tasteWeight,
	VERDICT_SLACK_MS,
	withEarlySkip,
	withPlay,
} from "../../src/core/memory";
import { type PoolEntry, PROBE_AT, PROBE_EVERY, planQueue } from "../../src/core/planner";
import { seededRng } from "../../src/core/random";
import {
	DAY_MS,
	DEFAULT_RULES,
	emptyMemory,
	type StationRules,
	type TrackMemory,
} from "../../src/core/types";

const NOW = Date.UTC(2026, 9, 9, 12);
const id = (i: number) => `t${String(i).padStart(21, "0")}`;

/** Heard often, then skipped three times; the last skip `ago` before now. */
function shunned(i: number, ago: number, plays = 0): TrackMemory {
	let m = emptyMemory(id(i));
	for (let p = 0; p < plays; p++) m = withPlay(m, NOW - 400 * DAY_MS);
	for (let s = 0; s < 3; s++) m = withEarlySkip(m, NOW - ago);
	return m;
}

describe("the answer to a retest", () => {
	const m = shunned(1, 40 * DAY_MS);

	it("'Gern wieder' ends what the skips say, also for skips of unknown date", () => {
		expect(skipsWeigh(m, NOW)).toBe(true);
		const kept = { ...m, verdict: 1 as const, verdictAt: NOW };
		expect(skipsWeigh(kept, NOW + 1)).toBe(false);
		expect(tasteWeight(kept, "later_less", NOW + 1)).toBe(1);
		const undated = { ...m, lastSkippedAt: null };
		expect(skipsWeigh(undated, NOW)).toBe(true);
		expect(skipsWeigh({ ...undated, verdict: 1, verdictAt: NOW }, NOW)).toBe(false);
		// Skipped again later: the skips count again.
		expect(skipsWeigh(withEarlySkip(kept, NOW + DAY_MS), NOW + 2 * DAY_MS)).toBe(true);
	});

	it("'Eher nicht' counts as one more skip: not now, and the next check further off", () => {
		const no = { ...m, verdict: -1 as const, verdictAt: NOW };
		expect(coolingDown(no, NOW + DAY_MS - 1)).toBe(true);
		expect(skipsWeigh(no, NOW + retestAfter(4) - 1)).toBe(true);
		expect(skipsWeigh(no, NOW + retestAfter(4))).toBe(false);
		// The play that ends when "Eher nicht" skips it is not a yes; a later one is.
		expect(skipsWeigh(withPlay(no, NOW + VERDICT_SLACK_MS), NOW + DAY_MS)).toBe(true);
		expect(skipsWeigh(withPlay(no, NOW + VERDICT_SLACK_MS + 1), NOW + DAY_MS)).toBe(false);
	});
});

describe("when a song is retested", () => {
	it("only while its skips keep it rare, and at least 30 days after the last word against it", () => {
		expect(probeDue(shunned(1, PROBE_GAP_MS - 1), NOW)).toBe(false);
		expect(probeDue(shunned(1, PROBE_GAP_MS), NOW)).toBe(true);
		// Its own check is due: it plays like any other song, no retest needed.
		expect(probeDue(shunned(1, retestAfter(3)), NOW)).toBe(false);
		// Heard since the skips: nothing to check.
		expect(probeDue(withPlay(shunned(1, 40 * DAY_MS), NOW - DAY_MS), NOW)).toBe(false);
		expect(probeDue(emptyMemory(id(1)), NOW)).toBe(false);
		const no = { ...shunned(1, 100 * DAY_MS), verdict: -1 as const, verdictAt: NOW - DAY_MS };
		expect(probeDue(no, NOW)).toBe(false);
	});
});

describe("retests in the planner", () => {
	const pool: PoolEntry[] = Array.from({ length: 300 }, (_, i) => ({
		id: id(i),
		artistId: `a${i}`,
	}));
	const plan = (mem: Map<string, TrackMemory>, rules: Partial<StationRules> = {}, size = 100) =>
		planQueue({
			now: NOW,
			roundStartedAt: NOW - 60 * DAY_MS,
			rules: { ...DEFAULT_RULES, ...rules },
			pool,
			memory: (x) => mem.get(x) ?? emptyMemory(x),
			banned: new Set(),
			discoveries: [],
			size,
			rng: seededRng(7),
		});
	const mem = new Map<string, TrackMemory>();
	for (let i = 0; i < 10; i++) mem.set(id(i), shunned(i, 40 * DAY_MS, i));

	it("places one every 30 songs, on purpose and outside the mix, those heard often first", () => {
		const res = plan(mem);
		const probes = res.slots.flatMap((s, i) => (s.kind === "probe" ? [i] : []));
		expect(probes).toEqual(
			Array.from(
				{ length: Math.ceil((100 - PROBE_AT) / PROBE_EVERY) },
				(_, k) => PROBE_AT + k * PROBE_EVERY,
			),
		);
		expect(res.counts.probe).toBe(probes.length);
		for (const i of probes) expect(mem.has(res.slots[i]!.trackId)).toBe(true);
		expect(res.slots.length).toBe(100);
		expect(new Set(res.slots.map((s) => s.trackId)).size).toBe(100);
	});

	it("none when switched off, under 'Zählt als gehört', or while nothing is due", () => {
		expect(plan(mem, { retestEnabled: false }).counts.probe).toBe(0);
		expect(plan(mem, { skipPolicy: "consume" }).counts.probe).toBe(0);
		const recent = new Map([[id(1), shunned(1, 10 * DAY_MS, 9)]]);
		expect(plan(recent).counts.probe).toBe(0);
		// Thumb down never comes back, retest or not.
		const down = new Map([[id(1), { ...shunned(1, 40 * DAY_MS, 9), thumb: -1 as const }]]);
		expect(plan(down).slots.some((s) => s.trackId === id(1))).toBe(false);
	});

	it("a short deck ends before its first retest place", () => {
		expect(plan(mem, {}, PROBE_AT).counts.probe).toBe(0);
		expect(plan(mem, {}, PROBE_AT + 1).slots[PROBE_AT]!.kind).toBe("probe");
	});
});
