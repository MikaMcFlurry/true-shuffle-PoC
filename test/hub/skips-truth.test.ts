/**
 * Early skips judged against ground truth: the Spotify fake records what the
 * listener really did with every song, and each skip the hub books is checked
 * against it. A skip that never happened is the worst error True Shuffle can
 * make (a song never heard becomes "rarer", or is banned); a missed one only
 * lets a song come back a little sooner. (Red-team findings RT-1 / RT-1R.)
 */

import { describe, expect, it } from "vitest";
import { HOUR_MS, MINUTE_MS } from "../../src/core/types";
import type { FakeSpotify, FakeUser } from "../fakes/fake-spotify";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;
type Policy = "later_less" | "ban";

/** Every song end in the fake, with whether it was heard ≥ 30 s. */
function truth(fake: FakeSpotify) {
	const played = new Set<string>();
	const early = new Set<string>();
	const f = fake as unknown as { moveNext: (u: FakeUser, at: number) => void };
	const orig = f.moveNext.bind(fake);
	f.moveNext = (u: FakeUser, at: number) => {
		const cur = fake.current(u.id);
		if (cur) (u.player.listenedMs >= 30_000 ? played : early).add(cur);
		orig(u, at);
	};
	return { played, early };
}

/** Every early skip the hub books, judged against the truth at that moment. */
function bookings(h: H, t: ReturnType<typeof truth>) {
	const log: { id: string; legit: boolean }[] = [];
	const hub = h.hub as unknown as { bookEarlySkip: (...a: unknown[]) => void };
	const orig = hub.bookEarlySkip.bind(hub);
	hub.bookEarlySkip = (st: unknown, id: unknown, rules: unknown, at: unknown) => {
		log.push({ id: id as string, legit: t.early.has(id as string) });
		orig(st, id, rules, at);
	};
	return {
		invented: () => log.filter((b) => !b.legit).length,
		detected: () => new Set(log.filter((b) => b.legit).map((b) => b.id)).size,
	};
}

function prng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 4294967296;
	};
}

/** A listener who skips about a quarter of the songs after 5–20 s. */
async function listenAndSkip(h: H, ms: number, rnd: () => number) {
	const end = h.clock.t + ms;
	let decided: string | null = null;
	let skipAt = -1;
	while (h.clock.t < end) {
		await h.listen(5_000);
		const cur = h.fake.current();
		const p = h.fake.user().player;
		if (!p.isPlaying || !cur) continue;
		if (cur !== decided) {
			decided = cur;
			skipAt = rnd() < 0.25 ? 5_000 + Math.floor(rnd() * 4) * 5_000 : -1;
		}
		if (skipAt >= 0 && p.listenedMs >= skipAt && p.listenedMs < 30_000) {
			h.fake.skip();
			decided = null;
		}
	}
}

function bannedWithoutSkip(h: H, t: ReturnType<typeof truth>): number {
	return h.sql
		.all<{ track_id: string }>(`SELECT track_id FROM bans`)
		.filter((b) => !t.early.has(b.track_id)).length;
}

describe("early skips against ground truth", () => {
	it("normal listening: finds the real skips and invents none", async () => {
		let real = 0;
		let found = 0;
		for (const seed of [1, 2, 3]) {
			const h = await onboarded({ tracks: 300, seed });
			const t = truth(h.fake);
			const b = bookings(h, t);
			await h.hub.play(h.stationIds[0]!);
			await listenAndSkip(h, 60 * MINUTE_MS, prng(seed * 7 + 1));
			h.fake.pause();
			await h.listen(40 * MINUTE_MS);
			expect(b.invented()).toBe(0);
			real += t.early.size;
			found += b.detected();
		}
		expect(real).toBeGreaterThan(20);
		expect(found / real).toBeGreaterThanOrEqual(0.9);
	});

	it("car stop (the player holds the paused playlist while it is rewritten), then skips", async () => {
		let real = 0;
		let found = 0;
		for (const seed of [1, 2, 3]) {
			const h = await onboarded({ tracks: 300, seed });
			await h.hub.play(h.stationIds[0]!);
			await h.listen(25 * MINUTE_MS);
			h.fake.pause();
			await h.listen(25 * MINUTE_MS);
			const t = truth(h.fake);
			const b = bookings(h, t);
			// The phone resumes the order it had loaded.
			h.fake.user().player.isPlaying = true;
			await listenAndSkip(h, 120 * MINUTE_MS, prng(seed * 13 + 5));
			h.fake.pause();
			await h.listen(40 * MINUTE_MS);
			expect(b.invented()).toBe(0);
			real += t.early.size;
			found += b.detected();
		}
		expect(real).toBeGreaterThan(20);
		expect(found / real).toBeGreaterThanOrEqual(0.8);
	});

	for (const policy of ["later_less", "ban"] as Policy[]) {
		it(`long stop with no player visible, nobody skips: nothing booked (${policy})`, async () => {
			for (const size of [60, 150, 400]) {
				for (const seed of [1, 2]) {
					const h = await onboarded({ tracks: size, seed });
					const t = truth(h.fake);
					const b = bookings(h, t);
					const sid = h.stationIds[0]!;
					if (policy !== "later_less")
						await h.hub.updateStation(sid, { rules: { skipPolicy: policy } });
					await h.hub.play(sid);
					await h.listen(25 * MINUTE_MS);
					const p = h.fake.user().player;
					p.isPlaying = false;
					const device = p.deviceId;
					p.deviceId = null; // parked: the Web API reports no player
					await h.listen(8 * HOUR_MS);
					p.deviceId = device; // the phone resumes what it had loaded
					p.isPlaying = true;
					await h.listen(90 * MINUTE_MS);
					p.isPlaying = false;
					await h.listen(40 * MINUTE_MS);
					expect(b.invented(), `size ${size} seed ${seed}`).toBe(0);
					expect(bannedWithoutSkip(h, t), `size ${size} seed ${seed}`).toBe(0);
				}
			}
		});
	}
});

type Resume = "loaded order" | "new contents by position" | "by song" | "from the top";

/** How a phone may carry on after a stop — real Spotify behaviour is unknown. */
function resume(h: H, sid: number, how: Resume, device: string | null) {
	const p = h.fake.user().player;
	if (device) p.deviceId = device;
	const row = h.sql.first<{ playlist_id: string }>(
		`SELECT playlist_id FROM stations WHERE id = ?`,
		sid,
	)!;
	const pl = h.fake.playlists.get(row.playlist_id)!;
	if (how === "new contents by position") {
		p.order = pl.items.slice();
		p.index = Math.min(p.index, p.order.length - 1);
		p.currentFromQueue = null;
	} else if (how === "by song") {
		const cur = h.fake.current();
		p.order = pl.items.slice();
		const i = cur ? p.order.indexOf(cur) : -1;
		p.index = i >= 0 ? i : Math.min(p.index, p.order.length - 1);
		p.currentFromQueue = null;
	} else if (how === "from the top") {
		h.fake.skip();
		p.order = pl.items.slice();
		p.index = 0;
		p.progressMs = 0;
		p.listenedMs = 0;
		p.currentFromQueue = null;
		p.contextUri = `spotify:playlist:${pl.id}`;
	}
	p.isPlaying = true;
}

describe("early skips after a car stop, whatever Spotify does on resume", () => {
	const hows: Resume[] = ["loaded order", "new contents by position", "by song", "from the top"];
	for (const policy of ["later_less", "consume", "ban"] as const) {
		it(`never books a song that was not skipped early (${policy})`, async () => {
			for (const how of hows)
				for (const stop of ["paused 60 min", "no player 8 h"] as const)
					for (const size of [60, 300]) {
						const h = await onboarded({ tracks: size, seed: size + hows.indexOf(how) });
						const sid = h.stationIds[0]!;
						if (policy !== "later_less")
							await h.hub.updateStation(sid, { rules: { skipPolicy: policy } });
						const t = truth(h.fake);
						const b = bookings(h, t);
						const rnd = prng(size * 31 + hows.indexOf(how));
						await h.hub.play(sid);
						await listenAndSkip(h, 25 * MINUTE_MS, rnd);
						const p = h.fake.user().player;
						p.isPlaying = false;
						const device = p.deviceId;
						if (stop === "no player 8 h") p.deviceId = null;
						await h.listen(stop === "paused 60 min" ? 60 * MINUTE_MS : 8 * HOUR_MS);
						resume(h, sid, how, device);
						await listenAndSkip(h, 60 * MINUTE_MS, rnd);
						h.fake.pause();
						await h.listen(40 * MINUTE_MS);
						const where = `${how}, ${stop}, ${size} songs`;
						expect(b.invented(), where).toBe(0);
						expect(bannedWithoutSkip(h, t), where).toBe(0);
					}
		}, 300_000);
	}
});
