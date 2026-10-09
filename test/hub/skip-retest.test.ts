import { expect, it } from "vitest";
import { DAY_MS } from "../../src/core/types";
import { onboarded } from "./harness";

it("an imported skip is dated: the song is asked about again once its check is due", async () => {
	const h = await onboarded({ tracks: 40 });
	const id = h.sql.first<{ data: string }>(`SELECT data FROM pages WHERE data <> '[]' LIMIT 1`)!;
	const song = (JSON.parse(id.data) as [string][])[0]![0];
	const now = h.clock.t;
	// 34 early skips, the last 400 days ago; another 10 days ago; and one with undated skips.
	h.hub.importHistory(
		[
			[song, 0, 34, 0, now - 400 * DAY_MS],
			["b".repeat(22), 0, 3, 0, now - 10 * DAY_MS],
			["c".repeat(22), 0, 3, 0],
		],
		0,
		1,
	);
	expect(h.hub.memory(song).lastSkippedAt).toBe(now - 400 * DAY_MS);
	expect(h.hub.memory("c".repeat(22)).lastSkippedAt).toBeNull();
	expect(() => h.hub.importHistory([[song, 0, 1, 0, now + 2 * DAY_MS]], 0, 1)).toThrow();
});
