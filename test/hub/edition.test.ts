/**
 * The community edition (shared/edition): no Spotify Content reaches an AI
 * model, and the listening profile counts only the imported data export.
 * Unset, a deployment stays "private" and keeps every feature.
 */

import { describe, expect, it } from "vitest";
import { LISTEN_PAGE, type ListenRow, type ListenTrack } from "../../src/core/listens";
import { DAY_MS, HOUR_MS } from "../../src/core/types";
import { parseEdition } from "../../src/shared/edition";
import type { AiRunner } from "../../src/worker/hub/discovery";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

/** An AI that answers and remembers every call. */
function spyAi(): AiRunner & { calls: number } {
	const ai = {
		calls: 0,
		async run() {
			ai.calls++;
			return {
				response: JSON.stringify({ songs: [{ artist: "Artist 7", title: "Song 487" }] }),
			};
		},
	};
	return ai;
}

/** Imports `n` plays of distinct songs, an hour apart, from `start` on. */
function importPlays(h: H, start: number, n: number) {
	const tracks: ListenTrack[] = [];
	const rows: ListenRow[] = [];
	for (let i = 0; i < n; i++) {
		tracks.push([`imp${i}`.padEnd(22, "x"), `Imported ${i}`, "Old Artist", ""]);
		rows.push([Math.floor((start + i * HOUR_MS) / 1000), i, 200_000, 0, 0]);
	}
	const pages = <T>(xs: T[]) =>
		Array.from({ length: Math.ceil(xs.length / LISTEN_PAGE) }, (_, i) =>
			xs.slice(i * LISTEN_PAGE, (i + 1) * LISTEN_PAGE),
		);
	const blocks = [
		...pages(tracks).map((d) => ({ kind: "tracks", data: d })),
		...pages(rows).map((d) => ({ kind: "rows", data: d })),
	];
	let upload: string | undefined;
	blocks.forEach((b, part) => {
		upload = h.hub.importListens({
			upload,
			part,
			parts: blocks.length,
			tracks: tracks.length,
			...b,
		}).upload;
	});
}

/** Two plays true-shuffle counted itself, after its first sign-in. */
function livePlays(h: H) {
	const t = h.clock.t;
	h.sql.run(`UPDATE kv SET v = ? WHERE k = 'live_since'`, String(t - 10 * DAY_MS));
	for (const [at, id] of [
		[t - 3 * HOUR_MS, "live-a"],
		[t - 2 * HOUR_MS, "live-b"],
	] as const)
		h.sql.run(
			`INSERT INTO plays (played_at, track_id, context_uri, station_id, ignored, meta) VALUES (?, ?, NULL, NULL, 0, NULL)`,
			at,
			id,
		);
}

describe("parseEdition", () => {
	it("is community only when asked for, private otherwise", () => {
		expect(parseEdition("community")).toBe("community");
		expect(parseEdition(" Community ")).toBe("community");
		expect(parseEdition(undefined)).toBe("private");
		expect(parseEdition("")).toBe("private");
		expect(parseEdition("private")).toBe("private");
		expect(parseEdition("anything")).toBe("private");
	});
});

describe("community edition", () => {
	it("never calls an AI, even with a key and a runner configured", async () => {
		const ai = spyAi();
		const h = await onboarded({
			tracks: 600,
			playlists: [300],
			ai,
			env: { edition: "community", anthropicKey: "sk-test" },
		});
		await h.listen(3 * HOUR_MS);
		expect(ai.calls).toBe(0);
		const found = h.sql.all<{ source: string }>(`SELECT source FROM discoveries`);
		expect(found.some((d) => d.source === "ai")).toBe(false);

		const st = await h.hub.state();
		expect(st.aiSource).toBe("off");
		expect(st.edition).toBe("community");
		expect(() => h.hub.prepareGenres()).toThrow(/KI/);
		const p = h.hub.listeningProfile("UTC");
		expect(p.canEstimate).toBe(false);
		expect(p.genres).toBeNull();
		expect(ai.calls).toBe(0);
	});

	it("builds the listening profile from the imported export only", async () => {
		const h = await onboarded({ tracks: 40, env: { edition: "community" } });
		livePlays(h);
		let p = h.hub.listeningProfile("UTC");
		expect(p.plays).toBe(0);
		expect(p.coverage.importOnly).toBe(true);
		expect(p.edition).toBe("community");

		importPlays(h, h.clock.t - 400 * DAY_MS, 5);
		p = h.hub.listeningProfile("UTC");
		expect(p.plays).toBe(5);
		expect(p.topSongs.every((s) => s.name.startsWith("Imported"))).toBe(true);
	});
});

describe("private edition (unset)", () => {
	it("keeps AI and counts its own plays as before", async () => {
		const ai = spyAi();
		const h = await onboarded({ tracks: 600, playlists: [300], ai });
		await h.listen(3 * HOUR_MS);
		expect(ai.calls).toBeGreaterThan(0);
		const st = await h.hub.state();
		expect(st.aiSource).toBe("workers-ai");
		expect(st.edition).toBe("private");

		livePlays(h);
		importPlays(h, h.clock.t - 400 * DAY_MS, 5);
		const p = h.hub.listeningProfile("UTC");
		expect(p.coverage.importOnly).toBe(false);
		expect(p.edition).toBe("private");
		expect(p.plays).toBeGreaterThanOrEqual(7);
	});
});
