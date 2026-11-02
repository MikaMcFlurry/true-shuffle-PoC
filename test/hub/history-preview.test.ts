/**
 * The Verlauf's listening sample against the real HubCore (docs/HISTORY_PREVIEW.md):
 * only a stored Verlauf row can be looked up; looking it up and asking Deezer
 * writes nothing — Verlauf, ratings, memory, skips, queue — and sends Spotify
 * nothing at all, least of all a player command.
 */

import { describe, expect, it } from "vitest";
import { HubError } from "../../src/worker/hub/hub";
import { resolveDeezerPreview } from "../../src/worker/preview/deezer";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

/** Every table, every row: the hub's whole stored state. */
function dump(h: H): string {
	const tables = h.sql.all<{ name: string }>(
		`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
	);
	return JSON.stringify(
		tables.map((t) => [
			t.name,
			h.sql
				.all(`SELECT * FROM "${t.name}"`)
				.map((r) => JSON.stringify(r, (_, v) => (v instanceof Uint8Array ? [...v] : v)))
				.sort(),
		]),
	);
}

function player(h: H): string {
	const u = h.fake.user("mika");
	return JSON.stringify({ player: u.player, liked: u.liked, recent: u.recent });
}

async function withHistory(): Promise<H> {
	const h = await onboarded({ tracks: 40 });
	const st = h.stationIds[0]!;
	await h.hub.play(st);
	await h.listen(12 * 60_000);
	await h.settle();
	return h;
}

describe("history preview: the hub's part", () => {
	it("looks up only a stored Verlauf row, by song and time", async () => {
		const h = await withHistory();
		const rows = h.hub.history(10);
		expect(rows.length).toBeGreaterThan(1);
		const row = rows[0]!;
		const fake = h.fake.tracks.get(row.id)!;
		expect(h.hub.previewSubject(row.id, row.playedAt)).toEqual({
			name: fake.name,
			artists: [fake.artistName],
			album: fake.albumName,
			durationMs: fake.durationMs,
		});
		// Same song, another time; a song never heard; malformed input.
		const notFound = (id: unknown, at: unknown) => {
			try {
				h.hub.previewSubject(id, at);
				return null;
			} catch (e) {
				return e instanceof HubError ? [e.code, e.status] : e;
			}
		};
		expect(notFound(row.id, row.playedAt + 1)).toEqual(["not_in_history", 404]);
		const unheard = [...h.fake.tracks.keys()].find((id) => !rows.some((r) => r.id === id))!;
		expect(notFound(unheard, row.playedAt)).toEqual(["not_in_history", 404]);
		expect(notFound("https://evil.example/x", row.playedAt)).toEqual(["bad_request", 400]);
		expect(notFound(row.id, "1")).toEqual(["bad_request", 400]);
		expect(notFound(row.id, 1.5)).toEqual(["bad_request", 400]);
		expect(notFound(undefined, undefined)).toEqual(["bad_request", 400]);
	});

	it("a sample for every row writes nothing and sends Spotify nothing", async () => {
		const h = await withHistory();
		const rows = h.hub.history(50);
		const before = { db: dump(h), player: player(h), history: JSON.stringify(rows) };
		const calls = h.fake.calls.length;
		const answers = [];
		for (const row of rows) {
			const subject = h.hub.previewSubject(row.id, row.playedAt);
			answers.push(
				await resolveDeezerPreview(subject, {
					fetch: (req) => h.fake.handle(req),
					base: h.env.deezerBase,
				}),
			);
		}
		expect(answers.every((a) => a.status === "ready")).toBe(true);
		const sent = h.fake.calls.slice(calls);
		// One Deezer search per sample, and nothing else at all.
		expect(sent).toEqual(rows.map(() => "GET /deezer/search"));
		expect(sent.filter((c) => c.includes("/v1"))).toEqual([]);
		expect(dump(h)).toBe(before.db);
		expect(player(h)).toBe(before.player);
		expect(JSON.stringify(h.hub.history(50))).toBe(before.history);
	});

	it("a song Deezer has no sample for, or a failing Deezer, changes nothing either", async () => {
		const h = await withHistory();
		const row = h.hub.history(5)[0]!;
		const before = dump(h);
		const calls = h.fake.calls.length;
		const ask = () =>
			resolveDeezerPreview(h.hub.previewSubject(row.id, row.playedAt), {
				fetch: (req) => h.fake.handle(req),
				base: h.env.deezerBase,
			});
		h.fake.deezerNoPreview.add(row.id);
		expect(await ask()).toMatchObject({ status: "unavailable", reason: "no_preview" });
		h.fake.deezerFail = { status: 429 };
		expect(await ask()).toMatchObject({ status: "error", reason: "rate" });
		h.fake.deezerFail = { status: 403 };
		expect(await ask()).toMatchObject({ status: "error", reason: "denied" });
		expect(h.fake.calls.slice(calls)).toEqual([
			"GET /deezer/search",
			"GET /deezer/search",
			"GET /deezer/search",
		]);
		expect(dump(h)).toBe(before);
	});
});
