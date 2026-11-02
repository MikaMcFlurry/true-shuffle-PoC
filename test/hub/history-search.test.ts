/**
 * S1: what the Verlauf search costs on the Durable Object, measured with the
 * rows-read model. One load reads the Verlauf once; opening the search again
 * reads only what was played since; typing never asks (test/client).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HistorySearch, search } from "../../src/client/history-search";
import { onboarded } from "./harness";
import { countingSql } from "./rows-read";

it("20 searches: one load of the Verlauf, then only the plays after it", async () => {
	let meter: ReturnType<typeof countingSql>["meter"] | null = null;
	const h = await onboarded({
		tracks: 200,
		durationMs: 120_000,
		wrapSql: (sql) => {
			const c = countingSql(sql);
			meter = c.meter;
			return c;
		},
	});
	expect((await h.hub.play(h.allId)).ok).toBe(true);
	await h.listen(6 * 3600_000);
	const plays = h.sql.first<{ n: number }>("SELECT COUNT(*) AS n FROM plays")!.n;
	expect(plays).toBeGreaterThan(100);

	meter!.reset();
	h.hub.history(60);
	const onePage = meter!.total;

	meter!.reset();
	const hs = new HistorySearch(async (since) => h.hub.historySearch(since));
	const words = ["a", "tr", "track", "song", "1", "2", "x", "zz", "e", "o"];
	for (let i = 0; i < 20; i++) search(await hs.load("mika"), words[i % words.length]!);
	const firstLoad = meter!.total;
	expect(hs.requests).toBe(1);

	await h.listen(10 * 60_000);
	meter!.reset();
	await hs.load("mika", true);
	const again = meter!.total;

	const dir = process.env.TS_EVIDENCE_DIR;
	if (dir)
		writeFileSync(
			join(dir, "history-search-reads.json"),
			JSON.stringify(
				{ model: "rows-read model", plays, onePage, firstLoad, again, searches: 20 },
				null,
				2,
			),
		);
	console.info(JSON.stringify({ plays, onePage, firstLoad, again }));
	// The whole Verlauf once: about one row per play plus one per song.
	expect(firstLoad).toBeLessThanOrEqual(3 * plays + 50);
	expect(again).toBeLessThan(firstLoad / 4);
}, 300_000);
