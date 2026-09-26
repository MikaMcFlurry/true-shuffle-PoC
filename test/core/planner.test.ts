import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RECENT_GUARD_MS } from "../../src/core/memory";
import { sharesForMix } from "../../src/core/mix";
import {
	type DiscoveryEntry,
	type PlanInput,
	type PoolEntry,
	planQueue,
} from "../../src/core/planner";
import { seededRng } from "../../src/core/random";
import {
	DAY_MS,
	DEFAULT_RULES,
	emptyMemory,
	HOUR_MS,
	type StationRules,
	type TrackMemory,
} from "../../src/core/types";

const NOW = Date.UTC(2026, 8, 25, 12);

function pool(n: number, artists = n): PoolEntry[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `t${String(i).padStart(21, "0")}`,
		artistId: `a${i % artists}`,
	}));
}

function input(over: Partial<PlanInput> & { mem?: Map<string, TrackMemory> } = {}): PlanInput {
	const mem = over.mem ?? new Map<string, TrackMemory>();
	return {
		now: NOW,
		roundStartedAt: NOW - 30 * DAY_MS,
		rules: DEFAULT_RULES,
		pool: pool(500),
		memory: (id) => mem.get(id) ?? emptyMemory(id),
		banned: new Set(),
		discoveries: [],
		size: 200,
		rng: seededRng(1),
		...over,
	};
}

describe("planQueue", () => {
	it("never repeats a song inside one queue", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 400 }),
				fc.integer({ min: 1, max: 300 }),
				fc.integer(),
				(n, size, seed) => {
					const p = pool(n, Math.max(1, Math.floor(n / 3)));
					const res = planQueue(input({ pool: [...p, ...p], size, rng: seededRng(seed) }));
					const ids = res.slots.map((s) => s.trackId);
					expect(new Set(ids).size).toBe(ids.length);
				},
			),
			{ numRuns: 150 },
		);
	});

	it("never places blocked songs (thumb down or station ban)", () => {
		const mem = new Map<string, TrackMemory>();
		const p = pool(100);
		for (const e of p.slice(0, 20)) mem.set(e.id, { ...emptyMemory(e.id), thumb: -1 });
		const banned = new Set(p.slice(20, 40).map((e) => e.id));
		const res = planQueue(input({ pool: p, mem, banned, size: 100 }));
		const placed = new Set(res.slots.map((s) => s.trackId));
		for (const e of p.slice(0, 40)) expect(placed.has(e.id)).toBe(false);
		expect(res.poolSize).toBe(60);
	});

	it("keeps songs heard or early-skipped in the last 24 h out, even in a new round", () => {
		const mem = new Map<string, TrackMemory>();
		const p = pool(300);
		for (const e of p.slice(0, 50)) {
			mem.set(e.id, { ...emptyMemory(e.id), plays: 1, lastPlayedAt: NOW - 2 * HOUR_MS });
		}
		for (const e of p.slice(50, 60)) {
			mem.set(e.id, { ...emptyMemory(e.id), earlySkips: 1, lastSkippedAt: NOW - HOUR_MS });
		}
		// Round started a minute ago: the songs above are technically "fresh".
		const res = planQueue(input({ pool: p, mem, roundStartedAt: NOW - 60_000, size: 200 }));
		const placed = new Set(res.slots.map((s) => s.trackId));
		for (const e of p.slice(0, 60)) expect(placed.has(e.id)).toBe(false);
	});

	it("places every unheard song of the round before any song of the next round", () => {
		fc.assert(
			fc.property(fc.integer({ min: 5, max: 120 }), fc.integer(), (n, seed) => {
				const mem = new Map<string, TrackMemory>();
				const p = pool(n);
				const round = NOW - 10 * DAY_MS;
				// Half of the pool was heard in this round (long enough ago to be allowed back).
				for (const e of p.slice(0, Math.floor(n / 2))) {
					mem.set(e.id, { ...emptyMemory(e.id), plays: 1, lastPlayedAt: round + DAY_MS });
				}
				const res = planQueue(
					input({
						pool: p,
						mem,
						roundStartedAt: round,
						size: n,
						rng: seededRng(seed),
						discoveries: [],
					}),
				);
				const heard = new Set(p.slice(0, Math.floor(n / 2)).map((e) => e.id));
				const firstOverflow = res.slots.findIndex((s) => heard.has(s.trackId));
				const lastFresh = res.slots.reduce((acc, s, i) => (heard.has(s.trackId) ? acc : i), -1);
				if (firstOverflow >= 0) expect(firstOverflow).toBeGreaterThan(lastFresh);
				expect(res.freshRemaining).toBe(n - Math.floor(n / 2));
			}),
			{ numRuns: 100 },
		);
	});

	it("holds favourites back until their cooldown is over", () => {
		const mem = new Map<string, TrackMemory>();
		const p = pool(200);
		const round = NOW - 60 * DAY_MS;
		// 40 liked songs heard this round: 20 three days ago (cooling), 20 ten days ago (ready).
		for (const e of p.slice(0, 20)) {
			mem.set(e.id, {
				...emptyMemory(e.id),
				liked: true,
				plays: 3,
				lastPlayedAt: NOW - 3 * DAY_MS,
			});
		}
		for (const e of p.slice(20, 40)) {
			mem.set(e.id, {
				...emptyMemory(e.id),
				liked: true,
				plays: 3,
				lastPlayedAt: NOW - 10 * DAY_MS,
			});
		}
		const res = planQueue(input({ pool: p, mem, roundStartedAt: round, size: 200 }));
		const placed = new Set(res.slots.map((s) => s.trackId));
		for (const e of p.slice(0, 20)) expect(placed.has(e.id)).toBe(false);
		const favs = res.slots.filter((s) => s.kind === "favorite").map((s) => s.trackId);
		expect(favs.length).toBeGreaterThan(0);
		for (const id of favs) expect(p.slice(20, 40).some((e) => e.id === id)).toBe(true);
	});

	it("follows the mix shares when every lane has enough songs", () => {
		const mem = new Map<string, TrackMemory>();
		const p = pool(2000, 400);
		const round = NOW - 90 * DAY_MS;
		for (const e of p.slice(0, 400)) {
			mem.set(e.id, { ...emptyMemory(e.id), thumb: 1, plays: 2, lastPlayedAt: round + DAY_MS });
		}
		const discoveries: DiscoveryEntry[] = Array.from({ length: 400 }, (_, i) => ({
			id: `d${String(i).padStart(21, "0")}`,
			artistId: `x${i % 200}`,
			score: 0.8,
		}));
		const size = 300;
		const res = planQueue(input({ pool: p, mem, roundStartedAt: round, discoveries, size }));
		const shares = sharesForMix(DEFAULT_RULES.mix);
		expect(res.slots.length).toBe(size);
		expect(Math.abs(res.counts.fresh - shares.fresh * size)).toBeLessThanOrEqual(2);
		expect(Math.abs(res.counts.favorite - shares.favorite * size)).toBeLessThanOrEqual(2);
		expect(Math.abs(res.counts.discovery - shares.discovery * size)).toBeLessThanOrEqual(2);
		// The spread is even: no 20-song window is without a discovery.
		for (let i = 0; i + 20 <= size; i++) {
			expect(res.slots.slice(i, i + 20).some((s) => s.kind === "discovery")).toBe(true);
		}
	});

	it("lets unused share flow to the lanes that still have songs", () => {
		const res = planQueue(input({ pool: pool(300), discoveries: [], size: 200 }));
		expect(res.slots.length).toBe(200);
		expect(res.counts.fresh).toBe(200);
	});

	it("respects discovery being switched off", () => {
		const discoveries: DiscoveryEntry[] = [{ id: "d".repeat(22), artistId: "x", score: 1 }];
		const rules: StationRules = { ...DEFAULT_RULES, discoveryEnabled: false };
		const res = planQueue(input({ rules, discoveries }));
		expect(res.counts.discovery).toBe(0);
	});

	it("spreads artists apart when the pool allows it", () => {
		const p = pool(400, 40); // 10 songs per artist
		const res = planQueue(input({ pool: p, size: 200 }));
		const artistOf = new Map(p.map((e) => [e.id, e.artistId]));
		const spacing = DEFAULT_RULES.artistSpacing;
		for (let i = 0; i < res.slots.length; i++) {
			const a = artistOf.get(res.slots[i]!.trackId);
			for (let j = Math.max(0, i - spacing); j < i; j++) {
				expect(artistOf.get(res.slots[j]!.trackId)).not.toBe(a);
			}
		}
	});

	it("never produces the same queue twice (fresh randomness each build)", () => {
		const a = planQueue(input({ rng: seededRng(11) })).slots.map((s) => s.trackId);
		const b = planQueue(input({ rng: seededRng(12) })).slots.map((s) => s.trackId);
		const same = a.filter((id, i) => b[i] === id).length;
		expect(same).toBeLessThan(10);
	});

	it("pulls long-unheard songs forward", () => {
		const mem = new Map<string, TrackMemory>();
		const p = pool(1000);
		// Round started long ago; 500 songs never heard, 500 heard 400 days ago (still fresh this round).
		const round = NOW - 1000 * DAY_MS;
		for (const e of p.slice(500)) {
			mem.set(e.id, { ...emptyMemory(e.id), plays: 1, lastPlayedAt: round + 500 * DAY_MS });
		}
		let neverFirst = 0;
		for (let seed = 0; seed < 20; seed++) {
			const res = planQueue(
				input({ pool: p, mem, roundStartedAt: round, size: 100, rng: seededRng(seed) }),
			);
			neverFirst += res.slots.filter((s) => !mem.has(s.trackId)).length;
		}
		// Never-heard songs are favoured (boost 1.6 vs ~1.6 cap; at least not starved).
		expect(neverFirst / (20 * 100)).toBeGreaterThan(0.45);
	});

	it("makes early-skipped songs rarer", () => {
		const mem = new Map<string, TrackMemory>();
		const p = pool(1000);
		for (const e of p.slice(0, 500)) {
			mem.set(e.id, { ...emptyMemory(e.id), earlySkips: 3, lastSkippedAt: NOW - 30 * DAY_MS });
		}
		const res = planQueue(input({ pool: p, mem, size: 200 }));
		const skippedPlaced = res.slots.filter((s) => mem.has(s.trackId)).length;
		expect(skippedPlaced).toBeLessThan(20);
	});

	it("returns a short queue rather than breaking on a tiny pool", () => {
		const res = planQueue(input({ pool: pool(3), size: 50 }));
		expect(res.slots.length).toBe(3);
	});

	it("uses recently heard songs of this round only as the very last resort", () => {
		const mem = new Map<string, TrackMemory>();
		const p = pool(10);
		// Five heard 12 h ago, before a round that started an hour ago.
		for (const e of p.slice(0, 5)) {
			mem.set(e.id, { ...emptyMemory(e.id), plays: 1, lastPlayedAt: NOW - RECENT_GUARD_MS / 2 });
		}
		const res = planQueue(input({ pool: p, mem, roundStartedAt: NOW - HOUR_MS, size: 10 }));
		expect(res.slots.length).toBe(10);
		const firstRecent = res.slots.findIndex((s) => mem.has(s.trackId));
		expect(firstRecent).toBe(5);
	});

	it("never brings back a song heard inside the current round within 24 h", () => {
		const mem = new Map<string, TrackMemory>();
		const p = pool(10);
		for (const e of p)
			mem.set(e.id, { ...emptyMemory(e.id), plays: 1, lastPlayedAt: NOW - HOUR_MS / 2 });
		const res = planQueue(input({ pool: p, mem, roundStartedAt: NOW - HOUR_MS, size: 10 }));
		expect(res.slots.length).toBe(0);
		expect(res.freshRemaining).toBe(0);
	});
});

describe("planQueue with songs placed elsewhere in the deck", () => {
	it("never picks an excluded song, but still counts it for the round", () => {
		const p = pool(500);
		const exclude = new Set(p.slice(0, 100).map((e) => e.id));
		const res = planQueue(input({ pool: p, exclude, size: 450 }));
		const ids = res.slots.map((s) => s.trackId);
		for (const id of ids) expect(exclude.has(id)).toBe(false);
		expect(res.freshRemaining).toBe(500);
		expect(res.poolSize).toBe(500);
	});
});

describe("planQueue shares when a lane is empty", () => {
	it("hands an empty lane's share to the others in proportion", () => {
		// "Vertraut" (mix 100) with no favourites ready: discoveries must stay rare.
		const discoveries: DiscoveryEntry[] = Array.from({ length: 300 }, (_, i) => ({
			id: `d${String(i).padStart(21, "0")}`,
			artistId: `x${i}`,
			score: 0.5,
		}));
		const res = planQueue(input({ rules: { ...DEFAULT_RULES, mix: 100 }, discoveries, size: 200 }));
		const share = res.counts.discovery / res.slots.length;
		expect(share).toBeLessThan(0.15);
		const mixed = planQueue(
			input({ rules: { ...DEFAULT_RULES, mix: 25 }, discoveries, size: 200 }),
		);
		expect(res.counts.discovery).toBeLessThan(mixed.counts.discovery);
	});
});
