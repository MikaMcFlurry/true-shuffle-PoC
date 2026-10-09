import { describe, expect, it } from "vitest";
import { LISTEN_FLAG, LISTEN_PAGE, type ListenRow, type ListenTrack } from "../../src/core/listens";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../src/core/types";
import { requestGenres } from "../../src/worker/hub/genres";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

/** A 22-character track id from a short name. */
const tid = (s: string) => s.padEnd(22, "x").slice(0, 22);

interface Heard {
	at: number;
	song: string;
	artist: string;
	album?: string;
	ms: number;
	flags?: number;
	platform?: number;
}

/** The browser's song list and rows for some plays (see core/listens). */
function build(plays: Heard[]): { tracks: ListenTrack[]; rows: ListenRow[] } {
	const tracks: ListenTrack[] = [];
	const index = new Map<string, number>();
	const rows: ListenRow[] = [];
	for (const p of plays.slice().sort((a, b) => a.at - b.at)) {
		let i = index.get(p.song);
		if (i === undefined) {
			i = tracks.length;
			index.set(p.song, i);
			tracks.push([tid(p.song), p.song, p.artist, p.album ?? ""]);
		}
		rows.push([Math.floor(p.at / 1000), i, p.ms, p.flags ?? 0, p.platform ?? 0]);
	}
	return { tracks, rows };
}

/** Uploads them block by block, as the import page does. */
function upload(h: H, data: { tracks: ListenTrack[]; rows: ListenRow[] }, stopAfter?: number) {
	const pages = <T>(xs: T[]) =>
		Array.from({ length: Math.ceil(xs.length / LISTEN_PAGE) }, (_, i) =>
			xs.slice(i * LISTEN_PAGE, (i + 1) * LISTEN_PAGE),
		);
	const blocks = [
		...pages(data.tracks).map((d) => ({ kind: "tracks", data: d })),
		...pages(data.rows).map((d) => ({ kind: "rows", data: d })),
	];
	blocks.forEach((b, part) => {
		if (stopAfter !== undefined && part >= stopAfter) return;
		h.hub.importListens({ part, parts: blocks.length, tracks: data.tracks.length, ...b });
	});
}

/** Plays every half hour from a start, before the first sign-in. */
const spread = (start: number, n: number, song: (i: number) => Omit<Heard, "at">) =>
	Array.from({ length: n }, (_, i) => ({ at: start + i * 30 * MINUTE_MS, ...song(i) }));

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
		expect(p.series.points.reduce((a, m) => a + m.plays, 0)).toBe(owner.length);
		expect(p.first).toBe(owner[0]!.played_at);
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
		expect(p.topArtists[0]!.minutes).toBeGreaterThanOrEqual(p.topArtists.at(-1)!.minutes);
		expect(p.minutes).toBeGreaterThan(0);
		expect(p.minutesExact).toBe(false);
		expect(p.coverage).toMatchObject({ importedPlays: 0, summaryOnly: false });
	});

	it("an unknown zone falls back to UTC; plays stay beyond half a year (owner decision)", async () => {
		const h = await onboarded({ tracks: 40 });
		const t = h.clock.t;
		for (const [at, id] of [
			[t - 400 * DAY_MS, "old"],
			[t - 3 * HOUR_MS, "new"],
		] as const)
			h.sql.run(
				`INSERT INTO plays (played_at, track_id, context_uri, station_id, ignored, meta) VALUES (?, ?, NULL, NULL, 0, NULL)`,
				at,
				id,
			);
		h.sql.run(`UPDATE kv SET v = ? WHERE k = 'live_since'`, String(t - 500 * DAY_MS));
		// A day of syncing (the old daily prune ran here) keeps both.
		await h.listen(DAY_MS + HOUR_MS);
		const all = h.hub.listeningProfile("Not/AZone");
		expect(all.plays).toBe(2);
		const week = h.hub.listeningProfile("Not/AZone", { from: t - 7 * DAY_MS, to: t });
		expect(week.plays).toBe(1);
		const utcHour = new Date(t - 3 * HOUR_MS).getUTCHours();
		const utcDay = (new Date(t - 3 * HOUR_MS).getUTCDay() + 6) % 7;
		expect(week.hourWeek[utcDay * 24 + utcHour]).toBe(1);
		expect(week.previous).toEqual({ plays: 0, minutes: 0 });
		expect(all.years).toEqual([
			...new Set(
				[new Date(t - 400 * DAY_MS), new Date(t - 3 * HOUR_MS)].map((d) => d.getUTCFullYear()),
			),
		]);
	});
});

describe("imported plays", () => {
	it("are stored in packed pages and switch over only when the last block arrived", async () => {
		const h = await onboarded({ tracks: 40 });
		const start = h.clock.t - 400 * DAY_MS;
		const first = build(
			spread(start, 2500, (i) => ({ song: `s${i % 1200}`, artist: `A${i % 37}`, ms: 200_000 })),
		);
		upload(h, first);
		const pages = h.sql.first<{ n: number }>(`SELECT COUNT(*) AS n FROM listen_pages`)!.n;
		// 1200 songs and 2500 plays: 2 + 3 pages, not thousands of rows.
		expect(pages).toBe(5);
		let p = h.hub.listeningProfile("UTC");
		expect(p.plays).toBe(2500);
		expect(p.minutesExact).toBe(true);
		expect(p.minutes).toBe(Math.round((2500 * 200_000) / 60_000));
		expect(p.coverage).toMatchObject({
			importedPlays: 2500,
			importedFrom: Math.floor(start / 1000) * 1000,
		});
		// A second upload that breaks off leaves the first in place, also after a restart.
		const second = build(spread(start, 1500, (i) => ({ song: `t${i}`, artist: "B", ms: 100_000 })));
		upload(h, second, 2);
		h.restart();
		p = h.hub.listeningProfile("UTC");
		expect(p.plays).toBe(2500);
		// Uploaded again in full, it replaces the first and leaves no old pages behind.
		upload(h, second);
		p = h.hub.listeningProfile("UTC");
		expect(p.plays).toBe(1500);
		expect(h.sql.first<{ n: number }>(`SELECT COUNT(*) AS n FROM listen_pages`)!.n).toBe(4);
	});

	it("refuse blocks a browser could not have built, out of order or before the song list", async () => {
		const h = await onboarded({ tracks: 40 });
		const ok = build([{ at: h.clock.t - DAY_MS, song: "a", artist: "A", ms: 60_000 }]);
		const block = (over: Record<string, unknown>) => () =>
			h.hub.importListens({
				part: 0,
				parts: 2,
				tracks: 1,
				kind: "tracks",
				data: ok.tracks,
				...over,
			});
		expect(block({ data: [["short", "a", "A", ""]] })).toThrow();
		expect(block({ kind: "other" })).toThrow();
		expect(block({ data: new Array(LISTEN_PAGE + 1).fill(ok.tracks[0]) })).toThrow();
		expect(block({ kind: "rows", data: ok.rows })).toThrow();
		block({})();
		// A row pointing past the song list, then out of order.
		expect(() =>
			h.hub.importListens({
				part: 1,
				parts: 2,
				tracks: 1,
				kind: "rows",
				data: [[1, 5, 60_000, 0, 0]],
			}),
		).toThrow();
		expect(() =>
			h.hub.importListens({ part: 3, parts: 2, tracks: 1, kind: "rows", data: ok.rows }),
		).toThrow();
		expect(() =>
			h.hub.importListens({
				part: 1,
				parts: 2,
				tracks: 1,
				kind: "rows",
				data: [[Math.floor((h.clock.t + 3 * DAY_MS) / 1000), 0, 60_000, 0, 0]],
			}),
		).toThrow();
		expect(h.hub.listeningProfile("UTC").coverage.importedPlays).toBe(0);
		h.hub.importListens({ part: 1, parts: 2, tracks: 1, kind: "rows", data: ok.rows });
		expect(h.hub.listeningProfile("UTC").coverage.importedPlays).toBe(1);
	});

	it("count up to the first sign-in; from then on true-shuffle's own count, nothing twice", async () => {
		const h = await onboarded({ tracks: 300 });
		const liveSince = Number(
			h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'live_since'`)!.v,
		);
		// Imported: 10 plays before the sign-in, 4 after (Spotify listed those too).
		upload(
			h,
			build([
				...spread(liveSince - 10 * HOUR_MS, 10, () => ({
					song: "before",
					artist: "Alt",
					ms: 180_000,
				})),
				...spread(liveSince + MINUTE_MS, 4, () => ({ song: "after", artist: "Neu", ms: 180_000 })),
			]),
		);
		expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
		await h.listen(60 * MINUTE_MS);
		const live = h.sql.first<{ n: number }>(`SELECT COUNT(*) AS n FROM plays WHERE ignored = 0`)!.n;
		const p = h.hub.listeningProfile("UTC");
		expect(p.plays).toBe(10 + live);
		expect(p.topArtists.find((a) => a.name === "Neu")).toBeUndefined();
		expect(p.minutesExact).toBe(false);
		const before = h.hub.listeningProfile("UTC", { from: null, to: liveSince });
		expect(before).toMatchObject({ plays: 10, minutesExact: true, minutes: 30 });
	});

	it("tell skips, devices, shuffle and offline, and covers from the library", async () => {
		const h = await onboarded({ tracks: 40 });
		const known = h.sql.first<{ data: string }>(
			`SELECT data FROM pages WHERE data <> '[]' LIMIT 1`,
		)!;
		const libraryTrack = (
			JSON.parse(known.data) as [string, string, unknown, string, string | null][]
		)[0]!;
		const t0 = h.clock.t - 30 * DAY_MS;
		const data = build([
			...spread(t0, 6, () => ({
				song: "fav",
				artist: "A",
				ms: 200_000,
				platform: 1,
				flags: LISTEN_FLAG.shuffle,
			})),
			...spread(t0 + DAY_MS, 3, () => ({
				song: "meh",
				artist: "B",
				ms: 5_000,
				flags: LISTEN_FLAG.forward,
			})),
			...spread(t0 + 2 * DAY_MS, 2, () => ({
				song: "car",
				artist: "C",
				ms: 100_000,
				platform: 8,
				flags: LISTEN_FLAG.offline,
			})),
			// Under 30 s, not skipped by choice: neither a play nor a skip.
			{ at: t0 + 3 * DAY_MS, song: "cut", artist: "D", ms: 3_000 },
		]);
		data.tracks[0]![0] = libraryTrack[0];
		upload(h, data);
		const p = h.hub.listeningProfile("UTC");
		expect(p.plays).toBe(8);
		expect(p.skips).toMatchObject({ early: 3, share: 3 / 11 });
		expect(p.skips!.top[0]).toMatchObject({ name: "meh", plays: 3 });
		expect(p.platforms).toEqual([
			{ name: "iPhone/iPad", plays: 6 },
			{ name: "Auto", plays: 2 },
		]);
		expect(p.shuffleShare).toBeCloseTo(6 / 8);
		expect(p.offlineShare).toBeCloseTo(2 / 8);
		expect(p.topSongs[0]).toMatchObject({ name: "fav", imageUrl: libraryTrack[4] });
	});
});

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

/** An imported history: Glasfabrik four hours, Nachtbus one. */
const history = (h: H) =>
	upload(
		h,
		build([
			...spread(h.clock.t - 300 * DAY_MS, 8, () => ({
				song: "g",
				artist: "Glasfabrik",
				ms: 1_800_000,
			})),
			...spread(h.clock.t - 200 * DAY_MS, 2, () => ({
				song: "n",
				artist: "Nachtbus",
				ms: 1_800_000,
			})),
		]),
	);

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
		history(h);
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
		history(h);
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
		history(h);
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
		await locked(() => history(h));
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
