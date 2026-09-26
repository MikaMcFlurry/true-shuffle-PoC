/**
 * Free-plan row budget (found by the red-team review, RT-4): one listener-day
 * at a 10 000-song library with a year of history must leave room for five
 * listeners in the account's 5 000 000 rows read / 100 000 rows written.
 * "Rows read" is approximated as rows scanned: a statement whose plan SCANs a
 * table costs that table's row count, otherwise the rows it returns.
 */
import { describe, expect, it } from "vitest";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../src/core/types";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

function instrument(h: H) {
	const db = h.sql.db;
	const planCache = new Map<string, string[]>();
	const c = { read: 0, written: 0, stmts: 0, byQuery: new Map<string, number>() };
	const scanned = (q: string, params: unknown[]): number => {
		let tables = planCache.get(q);
		if (!tables) {
			tables = [];
			try {
				const plan = db.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...(params as never[])) as {
					detail: string;
				}[];
				for (const p of plan) {
					const m = /^SCAN (\w+)(?! USING (COVERING )?INDEX)/.exec(p.detail);
					if (m && !/USING (COVERING )?INDEX|CONSTANT ROW/.test(p.detail)) tables.push(m[1]!);
				}
			} catch {
				/* not explainable */
			}
			planCache.set(q, tables);
		}
		let n = 0;
		for (const t of tables) {
			try {
				n += (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
			} catch {
				/* subquery alias */
			}
		}
		return n;
	};
	const key = (q: string) => q.replace(/\s+/g, " ").slice(0, 90);
	const addRead = (q: string, n: number) => {
		c.read += n;
		c.byQuery.set(key(q), (c.byQuery.get(key(q)) ?? 0) + n);
	};
	const norm = (p: unknown[]) => p as never[];
	h.sql.all = (<T>(q: string, ...p: unknown[]): T[] => {
		c.stmts++;
		const rows = db.prepare(q).all(...norm(p)) as T[];
		addRead(q, Math.max(rows.length, scanned(q, p)));
		return rows;
	}) as never;
	h.sql.first = (<T>(q: string, ...p: unknown[]): T | null => {
		c.stmts++;
		const row = (db.prepare(q).get(...norm(p)) as T | undefined) ?? null;
		addRead(q, Math.max(row ? 1 : 0, scanned(q, p)));
		return row;
	}) as never;
	h.sql.run = ((q: string, ...p: unknown[]): void => {
		c.stmts++;
		const r = db.prepare(q).run(...norm(p));
		c.written += Number(r.changes);
		if (/^\s*(UPDATE|DELETE)/i.test(q)) addRead(q, scanned(q, p));
	}) as never;
	return c;
}

describe("free-plan row budget, 10 000 songs, steady state", () => {
	it("one listener-day stays well inside a fifth of the account budget", async () => {
		const sizes = Array.from({ length: 8 }, () => 1250);
		const h = await onboarded({ tracks: 10_000, playlists: sizes, liked: 2000 });
		await h.listen(3 * HOUR_MS);
		// Months of use: 15 000 songs in live memory, a year of plays, discoveries.
		const lib = [...h.fake.tracks.keys()];
		const t0 = h.clock.t;
		h.sql.transaction(() => {
			for (let i = 0; i < 15_000; i++) {
				const id = i < lib.length ? lib[i]! : `X${String(i).padStart(21, "0")}`;
				h.sql.run(
					`INSERT OR IGNORE INTO memory (id, last_played_at, plays, early_skips, last_skipped_at, thumb) VALUES (?, ?, 1, 0, NULL, 0)`,
					id,
					t0 - (2 + (i % 300)) * DAY_MS,
				);
			}
			for (let i = 0; i < 50_000; i++) {
				h.sql.run(
					`INSERT OR IGNORE INTO plays (played_at, track_id, context_uri, station_id, ignored, meta) VALUES (?, ?, NULL, ?, 0, NULL)`,
					t0 - 2 * DAY_MS - i * 10 * MINUTE_MS,
					lib[i % lib.length]!,
					i % 9 === 0 ? 1 : null,
				);
			}
			for (let i = 0; i < 1500; i++) {
				h.sql.run(
					`INSERT OR IGNORE INTO discoveries (station_id, id, source, score, status, meta, heard, created_at, updated_at) VALUES (?, ?, 'genre', 0.5, ?, ?, 0, ?, ?)`,
					1 + (i % 9),
					`D${String(i).padStart(21, "0")}`,
					i % 3 === 0 ? "rejected" : "candidate",
					JSON.stringify([
						`D${String(i).padStart(21, "0")}`,
						"x",
						[["A0", "a"]],
						"al",
						null,
						200000,
					]),
					t0,
					t0,
				);
			}
		});
		h.restart(); // fresh isolate, as after DO eviction
		const c = instrument(h);
		const ids = [h.allId, ...h.stationIds];
		const session = async (sid: number, minutes: number, ui = false) => {
			await h.hub.play(sid);
			if (!ui) {
				await h.listen(minutes * MINUTE_MS);
			} else {
				for (let t = 0; t < minutes * 6; t++) {
					await h.listen(10_000);
					await h.hub.state({ live: true });
					if (t % 3 === 0) h.hub.stationDetail(ids[3]!);
				}
			}
			h.fake.pause();
		};
		// A day: commute, lunch, commute, evening with the app open for an hour.
		await h.listen(90 * MINUTE_MS);
		await session(h.allId, 60);
		await h.listen(4 * HOUR_MS);
		await session(h.stationIds[0]!, 60);
		await h.listen(4 * HOUR_MS);
		await session(h.allId, 60);
		await h.listen(60 * MINUTE_MS);
		await session(h.stationIds[1]!, 60, true);
		await session(h.stationIds[2]!, 120);
		const rest = DAY_MS - (h.clock.t - t0) + 3 * HOUR_MS;
		await h.listen(Math.max(0, rest));
		// 5 listeners share 5 000 000 reads and 100 000 writes per day; keep one
		// listener far below a fifth, so a regression shows long before it bites.
		expect(c.read).toBeLessThan(250_000);
		expect(c.written).toBeLessThan(10_000);
	}, 600_000);
});
