/**
 * Randomness for the planner.
 *
 * Production uses crypto-quality randomness so a rebuilt deck is never "the
 * same queue again" — the exact failure listeners know from Spotify's shuffle.
 * Tests pass a seeded generator so every property is reproducible.
 */

export type Rng = () => number;

/** Uniform [0, 1) from the platform CSPRNG. */
export function cryptoRng(): Rng {
	const buf = new Uint32Array(256);
	let i = buf.length;
	return () => {
		if (i >= buf.length) {
			crypto.getRandomValues(buf);
			i = 0;
		}
		// 32 bits of entropy mapped to [0, 1).
		return buf[i++]! / 4294967296;
	};
}

/** Small, fast, seeded PRNG (mulberry32) for deterministic tests. */
export function seededRng(seed: number): Rng {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Weighted random permutation (Efraimidis–Spirakis).
 *
 * Each item gets the key `u^(1/w)`; sorting by key descending yields an
 * unbiased weighted sample without replacement. Weight 1 everywhere is an
 * ordinary uniform shuffle. Items with weight <= 0 are dropped.
 */
export function weightedShuffle<T>(items: readonly T[], weight: (item: T) => number, rng: Rng): T[] {
	const keyed: { item: T; key: number }[] = [];
	for (const item of items) {
		const w = weight(item);
		if (!(w > 0) || !Number.isFinite(w)) continue;
		// log-space key avoids underflow for tiny weights: log(u)/w, larger is better.
		let u = rng();
		if (u <= 0) u = Number.MIN_VALUE;
		keyed.push({ item, key: Math.log(u) / w });
	}
	keyed.sort((a, b) => b.key - a.key);
	return keyed.map((k) => k.item);
}

/** Unbiased Fisher–Yates shuffle (copy). */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = out[i]!;
		out[i] = out[j]!;
		out[j] = tmp;
	}
	return out;
}
