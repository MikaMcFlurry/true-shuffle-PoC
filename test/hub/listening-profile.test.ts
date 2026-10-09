import { describe, expect, it } from "vitest";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../src/core/types";
import { requestGenres } from "../../src/worker/hub/genres";
import { onboarded } from "./harness";

describe("listening profile", () => {
	it("counts owner plays only, buckets them in the listener's zone, and writes nothing", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(60 * MINUTE_MS);
		await h.hub.setGuest(true, 1);
		await h.listen(30 * MINUTE_MS);
		await h.hub.setGuest(false);
		const dump = () =>
			JSON.stringify(
				["plays", "memory", "stations", "discoveries", "kv"].map((t) =>
					h.sql.all(`SELECT * FROM ${t} ORDER BY 1`),
				),
			);
		const was = dump();
		const p = h.hub.listeningProfile("Europe/Berlin");
		expect(dump()).toBe(was);

		const owner = h.sql.all<{ played_at: number; meta: string | null }>(
			`SELECT played_at, meta FROM plays WHERE ignored = 0 ORDER BY played_at`,
		);
		expect(owner.length).toBeGreaterThan(5);
		expect(p.plays).toBe(owner.length);
		expect(p.hourWeek).toHaveLength(168);
		expect(p.hourWeek.reduce((a, b) => a + b, 0)).toBe(owner.length);
		expect(p.months.reduce((a, m) => a + m.plays, 0)).toBe(owner.length);
		expect(p.since).toBe(owner[0]!.played_at);
		// Every owner play's Berlin weekday and hour is where the grid counts it.
		const fmt = new Intl.DateTimeFormat("en-US", {
			timeZone: "Europe/Berlin",
			weekday: "short",
			hour: "2-digit",
			hourCycle: "h23",
		});
		const grid = new Array<number>(168).fill(0);
		for (const r of owner) {
			const x = Object.fromEntries(fmt.formatToParts(r.played_at).map((q) => [q.type, q.value]));
			grid[
				["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(x.weekday!) * 24 + Number(x.hour)
			]!++;
		}
		expect(p.hourWeek).toEqual(grid);
		expect(p.topSongs.length).toBeGreaterThan(0);
		expect(p.topArtists[0]!.plays).toBeGreaterThanOrEqual(p.topArtists.at(-1)!.plays);
		expect(p.onCassettes).toBeLessThanOrEqual(p.plays);
		expect(p.minutes).toBeGreaterThan(0);
	});

	it("an unknown zone falls back to UTC; plays older than 180 days are left out", async () => {
		const h = await onboarded({ tracks: 40 });
		const t = h.clock.t;
		h.sql.run(
			`INSERT INTO plays (played_at, track_id, context_uri, station_id, ignored, meta) VALUES (?, 'old', NULL, NULL, 0, NULL)`,
			t - 200 * DAY_MS,
		);
		h.sql.run(
			`INSERT INTO plays (played_at, track_id, context_uri, station_id, ignored, meta) VALUES (?, 'new', NULL, NULL, 0, NULL)`,
			t - 3 * HOUR_MS,
		);
		const p = h.hub.listeningProfile("Not/AZone");
		expect(p.plays).toBe(1);
		const utcHour = new Date(t - 3 * HOUR_MS).getUTCHours();
		const utcDay = (new Date(t - 3 * HOUR_MS).getUTCDay() + 6) % 7;
		expect(p.hourWeek[utcDay * 24 + utcHour]).toBe(1);
	});
});

describe("imported profile", () => {
	const good = () => ({
		at: 0,
		from: 1_600_000_000_000,
		to: 1_700_000_000_000,
		plays: 3,
		minutes: 9,
		songs: 2,
		artists: 1,
		earlySkips: 1,
		hourWeek: new Array<number>(168).fill(0).map((_, i) => (i === 42 ? 3 : 0)),
		months: [{ month: "2023-11", plays: 3, minutes: 9 }],
		topArtists: [{ name: "Glasfabrik", plays: 3, minutes: 9 }],
		topSongs: [{ id: "A".repeat(22), name: "Song", artist: "Glasfabrik", plays: 3 }],
	});

	it("is stored as sent, stamped now, and served with the live profile", async () => {
		const h = await onboarded({ tracks: 40 });
		expect(h.hub.listeningProfile("UTC").imported).toBeNull();
		h.hub.setImportedProfile(good());
		const i = h.hub.listeningProfile("UTC").imported!;
		expect(i).toMatchObject({ plays: 3, minutes: 9, at: h.clock.t });
		expect(i.topSongs[0]).toMatchObject({ name: "Song", imageUrl: null });
		expect(i.hourWeek[42]).toBe(3);
	});

	it("refuses what a browser could not have built", async () => {
		const h = await onboarded({ tracks: 40 });
		for (const bad of [
			null,
			{ ...good(), hourWeek: [1, 2, 3] },
			{ ...good(), from: 2, to: 1 },
			{ ...good(), plays: -1 },
			{ ...good(), months: [{ month: "nope", plays: 1, minutes: 1 }] },
			{
				...good(),
				topArtists: Array.from({ length: 51 }, () => ({ name: "x", plays: 1, minutes: 1 })),
			},
			{ ...good(), topSongs: [{ id: "short", name: "x", artist: "y", plays: 1 }] },
			{ ...good(), topArtists: [{ name: "x".repeat(201), plays: 1, minutes: 1 }] },
		])
			expect(() => h.hub.setImportedProfile(bad)).toThrow();
		expect(h.hub.listeningProfile("UTC").imported).toBeNull();
	});
});

type H = Awaited<ReturnType<typeof onboarded>>;

/** The account's lock, as UserHub keeps it: one operation after another. */
function lock() {
	let chain: Promise<unknown> = Promise.resolve();
	return <T>(fn: () => T | Promise<T>) => {
		const run = chain.then(async () => {
			try {
				return { ok: true as const, value: await fn() };
			} catch (error) {
				return { ok: false as const, error };
			}
		});
		chain = run.catch(() => undefined);
		return run;
	};
}

/** Asks for an estimate exactly as UserHub does. */
const ask = (h: H, locked = lock()) =>
	requestGenres<unknown>(
		locked,
		() => h.hub.prepareGenres(),
		(artists) => h.hub.runGenreEstimate(artists),
		(attempt, est) => h.hub.storeGenres(attempt, est),
	);

const summary = () => ({
	at: 0,
	from: 1_600_000_000_000,
	to: 1_700_000_000_000,
	plays: 10,
	minutes: 300,
	songs: 5,
	artists: 2,
	earlySkips: 0,
	hourWeek: new Array<number>(168).fill(0),
	months: [],
	topArtists: [
		{ name: "Glasfabrik", plays: 8, minutes: 240 },
		{ name: "Nachtbus", plays: 2, minutes: 60 },
	],
	topSongs: [],
});

const good = JSON.stringify({
	genres: [
		{ name: "Indie-Rock", share: 3 },
		{ name: "Elektro", share: 1 },
		{ name: "", share: 5 },
	],
	summary: "Du hörst vor allem Gitarren.",
});

describe("genre estimate", () => {
	it("weights artists by listening time, scales shares to 100 and stores it", async () => {
		let asked = "";
		const ai = {
			run: async (_m: string, input: { messages: { role: string; content: string }[] }) => {
				asked = input.messages.at(-1)!.content;
				return { response: good };
			},
		};
		const h = await onboarded({ tracks: 300, ai, env: { anthropicKey: null } });
		h.hub.setImportedProfile(summary());
		const r = await ask(h);
		expect(r.ok).toBe(true);
		const est = r.ok ? r.value.estimate : null;
		expect(asked).toContain("Glasfabrik: 80.0 %");
		expect(asked).toContain("Nachtbus: 20.0 %");
		expect(est).toMatchObject({
			source: "workers-ai",
			artists: 2,
			summary: "Du hörst vor allem Gitarren.",
		});
		expect(est!.genres).toEqual([
			{ name: "Indie-Rock", share: 75 },
			{ name: "Elektro", share: 25 },
		]);
		expect(h.hub.listeningProfile("UTC").genres).toEqual(est);
		expect(h.hub.listeningProfile("UTC").genresRetryAt).toBe(h.clock.t + 6 * HOUR_MS);
	});

	it("one attempt in six hours, failed ones too, across restarts; an old result stays", async () => {
		let calls = 0;
		let reply = good;
		const ai = {
			run: async () => {
				calls++;
				return { response: reply };
			},
		};
		const h = await onboarded({ tracks: 300, ai, env: { anthropicKey: null } });
		h.hub.setImportedProfile(summary());
		// First an unusable answer, then two more requests with a restart between.
		reply = "nothing usable";
		const first = await ask(h);
		expect(first).toMatchObject({ ok: true, value: { estimate: null, failed: true } });
		h.restart();
		await ask(h);
		h.restart();
		const third = await ask(h);
		expect(calls).toBe(1);
		expect(third).toMatchObject({
			ok: true,
			value: { failed: false, retryAt: expect.any(Number) },
		});
		// After six hours a good one; six more and a failure keeps it.
		h.clock.t += 6 * HOUR_MS;
		reply = good;
		await ask(h);
		expect(calls).toBe(2);
		const kept = h.hub.listeningProfile("UTC").genres;
		expect(kept).not.toBeNull();
		h.clock.t += 6 * HOUR_MS;
		reply = "nothing usable";
		const after = await ask(h);
		expect(calls).toBe(3);
		expect(after).toMatchObject({ ok: true, value: { failed: true, estimate: kept } });
		expect(h.hub.listeningProfile("UTC").genres).toEqual(kept);
		// Just under six hours later: still no new attempt.
		h.clock.t += 6 * HOUR_MS - 1;
		await ask(h);
		expect(calls).toBe(3);
	});

	it("playback never waits for the AI, and a late answer after a new import does not land", async () => {
		let release: (v: unknown) => void = () => {};
		const ai = {
			run: () =>
				new Promise((r) => {
					release = r;
				}),
		};
		const h = await onboarded({ tracks: 300, ai, env: { anthropicKey: null } });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		h.hub.setImportedProfile(summary());
		const locked = lock();
		const pending = ask(h, locked);
		await new Promise((r) => setTimeout(r, 10));
		const paused = await Promise.race([
			locked(() => h.hub.playerAction("pause")),
			new Promise((r) => setTimeout(() => r("blocked"), 2_000)),
		]);
		expect(paused).not.toBe("blocked");
		expect(h.fake.user().player.isPlaying).toBe(false);
		// A new import while the AI still thinks: its answer is for the old one.
		await locked(() => h.hub.setImportedProfile(summary()));
		release({ response: good });
		const r = await pending;
		expect(r.ok).toBe(true);
		expect(h.hub.listeningProfile("UTC").genres).toBeNull();
	});

	it("refuses with nothing heard; without any AI it says so", async () => {
		const h = await onboarded({
			tracks: 40,
			ai: { run: async () => ({ response: "{}" }) },
			env: { anthropicKey: null },
		});
		expect(() => h.hub.prepareGenres()).toThrow();
		const none = await onboarded({ tracks: 40, ai: null, env: { anthropicKey: null } });
		expect(none.hub.listeningProfile("UTC").canEstimate).toBe(false);
	});
});
