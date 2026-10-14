/**
 * The fallback surface over the current backend (docs/FALLBACK_8D_UI.md):
 * the 8d client's requests — with its compatibility changes — against the
 * real hub, across switches between the fallback and the current surface.
 *
 * The Worker of both deployments is the same build (byte-identical bundle,
 * see the fallback root's artifact evidence), so a switch of surface is a
 * restart of the same hub on the same storage (`h.restart()`); what differs
 * is only which client sends which requests. Synthetic data only.
 */

import { describe, expect, it } from "vitest";
import { aggregateHistory, emptyAggregate, toRows } from "../../src/core/history";
import type { SelectionRule } from "../../src/core/import-selection";
import { addListens, finishListens, LISTEN_PAGE, newListens } from "../../src/core/listens";
import { HubError } from "../../src/worker/hub/hub";
import { onboarded } from "../hub/harness";

type H = Awaited<ReturnType<typeof onboarded>>;

const liveSince = (h: H) =>
	Number(h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'live_since'`)!.v);
const thumb = (h: H, id: string) =>
	h.sql.first<{ thumb: number }>(`SELECT thumb FROM memory WHERE id = ?`, id)?.thumb ?? 0;
const rated = (h: H, id: string) => {
	const c = h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'rating_clock'`);
	if (!c) return 0;
	const clock = JSON.parse(c.v) as { floor: number; touched: Record<string, number> };
	return clock.touched[id] ?? clock.floor;
};
const nexts = (h: H) => h.fake.calls.filter((c) => c === "POST /v1/me/player/next").length;

/** Synthetic plays: songs 0–5 four times each in 2024; songs 0–2 by artist A, 3–5 by artist B. */
function plays(h: H, year = 2024) {
	const t = [...h.fake.tracks.values()];
	const out = [];
	for (let k = 0; k < 6; k++)
		for (let i = 0; i < 4; i++)
			out.push({
				ts: new Date(Date.UTC(year, 1 + k, 1 + i, 12)).toISOString(),
				ms_played: 200_000,
				spotify_track_uri: `spotify:track:${t[k]!.id}`,
				master_metadata_track_name: t[k]!.name,
				master_metadata_album_artist_name: k < 3 ? "Artist A" : "Artist B",
				master_metadata_album_album_name: t[k]!.albumName,
				reason_start: "trackdone",
				reason_end: "trackdone",
				skipped: false,
			});
	return out;
}

/**
 * The import as the fallback surface sends it (src/client-fallback-8d: api.ts
 * startImport/importHistory/importListens, ImportScreen.upload/saveProfile):
 * begun on purpose, totals in blocks of `size` naming the upload, then the
 * plays naming the totals they belong to.
 */
function importAsFallbackSurface(h: H, entries: ReturnType<typeof plays>, size = 4) {
	const rows = toRows(aggregateHistory(entries, emptyAggregate(), { before: liveSince(h) }));
	const parts = Math.max(1, Math.ceil(rows.length / size));
	const { start } = h.hub.startImport();
	let id: string | undefined;
	for (let i = 0; i < parts; i++)
		id = h.hub.importHistory(
			rows.slice(i * size, (i + 1) * size),
			i,
			parts,
			id,
			i === 0 ? start : undefined,
		).upload;
	const done = finishListens(addListens(entries, newListens()), liveSince(h));
	const pages = <T>(xs: T[]) =>
		Array.from({ length: Math.ceil(xs.length / LISTEN_PAGE) }, (_, i) =>
			xs.slice(i * LISTEN_PAGE, (i + 1) * LISTEN_PAGE),
		);
	const blocks = [
		...pages(done.tracks).map((data) => ({ kind: "tracks" as const, data })),
		...pages(done.rows).map((data) => ({ kind: "rows" as const, data })),
	];
	let upload: string | undefined;
	for (const [part, b] of blocks.entries())
		upload = h.hub.importListens({
			upload,
			importId: part === 0 ? id : undefined,
			part,
			parts: blocks.length,
			tracks: done.tracks.length,
			...b,
		}).upload;
	return { rows: rows.length, parts };
}

/** Takes a selection over, as the current surface's selection page does. */
function select(h: H, enabled: boolean, rules: SelectionRule[]) {
	const v = h.hub.selectionView();
	return h.hub.applySelection({
		baseRevision: v.revision,
		dataset: v.dataset.key,
		enabled,
		rules,
	});
}

const songIds = (h: H) => [...h.fake.tracks.keys()];
const effective = (h: H) =>
	songIds(h)
		.slice(0, 6)
		.map((id) => h.hub.memory(id).plays);

describe("the fallback surface's import against the current backend", () => {
	it("its compatible protocol stores totals and plays, in several blocks; the selection in force stays", async () => {
		const h = await onboarded({ tracks: 20 });
		importAsFallbackSurface(h, plays(h));
		const rules: SelectionRule[] = [{ type: "artist", kind: "exclude", name: "Artist A" }];
		select(h, true, rules);
		const before = h.hub.selectionView();
		expect(effective(h)).toEqual([0, 0, 0, 4, 4, 4]);
		// Fallback: a new import from the fallback surface (several blocks, the plays bound to it).
		h.restart();
		const r = importAsFallbackSurface(h, plays(h, 2023), 2);
		expect(r.parts).toBeGreaterThan(1);
		const after = h.hub.selectionView();
		expect(after.revision).toBe(before.revision);
		expect(after.selection).toEqual(before.selection);
		expect(after.dataset.key).not.toBe(before.dataset.key);
		expect(after.dataset.coverage).toBe("events");
		// The artist rule applies to the new import too.
		expect(effective(h)).toEqual([0, 0, 0, 4, 4, 4]);
		expect(h.hub.state).toBeTypeOf("function");
	});

	it("CONTROL — the unchanged 8d client protocol is refused by the current backend's fences (why the fallback surface carries the change)", async () => {
		const h = await onboarded({ tracks: 20 });
		importAsFallbackSurface(h, plays(h));
		const before = h.hub.selectionView().dataset.key;
		const rows = toRows(
			aggregateHistory(plays(h, 2023), emptyAggregate(), { before: liveSince(h) }),
		);
		// 8d: blocks without the upload's id — the second block is refused, nothing replaced.
		h.hub.importHistory(rows.slice(0, 2), 0, 2);
		expect(() => h.hub.importHistory(rows.slice(2), 1, 2)).toThrow(HubError);
		expect(h.hub.selectionView().dataset.key).toBe(before);
		// 8d: one block of totals is taken (nothing was ever deleted) …
		h.hub.importHistory(rows, 0, 1);
		// … but its plays name no import: refused, the stored plays no longer belong to the totals.
		const done = finishListens(addListens(plays(h, 2023), newListens()), liveSince(h));
		expect(() =>
			h.hub.importListens({
				part: 0,
				parts: 2,
				tracks: done.tracks.length,
				kind: "tracks",
				data: done.tracks,
			}),
		).toThrow(HubError);
		expect(h.hub.selectionView().dataset.coverage).toBe("summary");
	});
});

describe("the import selection through fallback and back (REL-RBK-IMPORT)", () => {
	const ruleSets: [string, (h: H) => SelectionRule[]][] = [
		["switched off", () => []],
		["a song left out", (h) => [{ type: "track", kind: "exclude", id: songIds(h)[4]! }]],
		["an artist left out", () => [{ type: "artist", kind: "exclude", name: "Artist B" }]],
		[
			"a period left out",
			() => [
				{ type: "period", kind: "exclude", from: "2024-02-01", to: "2024-03-31", zone: "UTC" },
			],
		],
	];
	for (const [name, rules] of ruleSets)
		it(`${name}: in force under the fallback, after a fallback-era import, and back on the current surface — nothing reset or deleted`, async () => {
			const h = await onboarded({ tracks: 20 });
			importAsFallbackSurface(h, plays(h));
			const off = name === "switched off";
			select(h, !off, rules(h));
			const view = h.hub.selectionView();
			const counts = effective(h);
			if (off) expect(counts).toEqual([0, 0, 0, 0, 0, 0]);
			else expect(counts.filter((n) => n === 0).length).toBeGreaterThan(0);
			// Fallback surface: the same backend, the selection read as it was.
			h.restart();
			expect(h.hub.selectionView()).toMatchObject({
				revision: view.revision,
				selection: view.selection,
			});
			expect(effective(h)).toEqual(counts);
			expect(h.hub.state).toBeTypeOf("function");
			// Back on the current surface: unchanged, and still changeable there.
			h.restart();
			expect(h.hub.selectionView()).toMatchObject({
				revision: view.revision,
				selection: view.selection,
				dataset: { key: view.dataset.key },
			});
			expect(effective(h)).toEqual(counts);
			select(h, true, []);
			expect(effective(h)).toEqual([4, 4, 4, 4, 4, 4]);
		});

	it("AppState tells the fallback surface what counts (effectiveTracks, enabled, rules)", async () => {
		const h = await onboarded({ tracks: 20 });
		importAsFallbackSurface(h, plays(h));
		select(h, false, [{ type: "artist", kind: "exclude", name: "Artist A" }]);
		h.restart();
		const st = await h.hub.state();
		expect(st.history).toMatchObject({
			importedTracks: 6,
			effectiveTracks: 0,
			enabled: false,
			rules: 1,
		});
	});
});

describe("later ratings through fallback and back (REL-RBK-RATING)", () => {
	async function ratedFromHistory(h: H, id: string, actionId: string) {
		const a = await h.hub.rateFromHistory({ actionId, trackId: id, value: 1, basis: rated(h, id) });
		expect(a.kind).toBe("done");
		return a.kind === "done" ? a.receipt : null!;
	}

	for (const later of [-1, 0, 1] as const)
		it(`+1 from the Verlauf, then ${later} from the fallback surface's rating sheet: back on the current surface the old receipt cannot take it back`, async () => {
			const h = await onboarded({ tracks: 20 });
			const id = songIds(h)[2]!;
			const r = await ratedFromHistory(h, id, `fb-${later + 1}-action-0001`);
			// Fallback surface: its rating sheet posts /api/tracks/:id/thumb.
			h.restart();
			await h.hub.thumb(id, later);
			const seq = rated(h, id);
			expect(seq).toBeGreaterThan(r.seq);
			expect(h.hub.historyRatingReceipt(r.id, id).receipt?.superseded).toBe(true);
			// Back on the current surface.
			h.restart();
			const u = await h.hub.undoHistoryRating(r.id);
			expect(u.receipt?.undo?.outcome).toBe("conflict");
			expect(thumb(h, id)).toBe(later);
			expect(rated(h, id)).toBe(seq);
			// Asked again (idempotent): the same answer, nothing changes.
			expect((await h.hub.undoHistoryRating(r.id)).receipt?.undo?.outcome).toBe("conflict");
			// The same decision sent again (a lost answer): answered from its receipt, nothing stored.
			const again = await h.hub.rateFromHistory({
				actionId: r.id,
				trackId: id,
				value: 1,
				basis: 0,
			});
			expect(again.kind).toBe("done");
			expect(thumb(h, id)).toBe(later);
			expect(rated(h, id)).toBe(seq);
			// A new decision on the number read before the fallback: refused as rated since.
			const stale = await h.hub.rateFromHistory({
				actionId: `fb-${later + 1}-stale-0001`,
				trackId: id,
				value: 1,
				basis: r.seq,
			});
			expect(stale).toEqual({ kind: "changed", current: { value: later, seq } });
		});

	it("CONTROL: with nothing rated since, the receipt still takes back after the switches", async () => {
		const h = await onboarded({ tracks: 20 });
		const id = songIds(h)[3]!;
		const r = await ratedFromHistory(h, id, "fb-control-action-01");
		h.restart();
		h.restart();
		expect((await h.hub.undoHistoryRating(r.id)).receipt?.undo?.outcome).toBe("undone");
		expect(thumb(h, id)).toBe(0);
	});

	it("a receipt pushed out by 100 later Verlauf ratings (some songs rated on the fallback sheet in between) is unknown: nothing taken back", async () => {
		const h = await onboarded({ tracks: 120 });
		const ids = songIds(h);
		const r = await ratedFromHistory(h, ids[0]!, "fb-pushed-out-0001");
		// Fallback surface: sheet ratings count in the clock, but keep no receipts.
		h.restart();
		for (const other of ids.slice(101, 111)) await h.hub.thumb(other, -1);
		// Current surface: only Verlauf ratings keep receipts (the newest 100).
		h.restart();
		for (const [i, other] of ids.slice(1, 101).entries())
			await ratedFromHistory(h, other, `fb-push-${String(i).padStart(3, "0")}-0001`);
		expect(h.hub.historyRatingReceipt(r.id).receipt).toBeNull();
		expect((await h.hub.undoHistoryRating(r.id)).receipt).toBeNull();
		expect(thumb(h, ids[0]!)).toBe(1);
		for (const other of ids.slice(101, 111)) expect(thumb(h, other)).toBe(-1);
	});

	it("Nie wieder on the song playing from the fallback sheet skips once; the old receipt, back on the current surface, moves no playback", async () => {
		const h = await onboarded();
		await h.hub.play(h.stationIds[0]!);
		await h.listen(60_000);
		await h.hub.state({ live: true });
		const cur = h.fake.current()!;
		const r = await ratedFromHistory(h, cur, "fb-playing-action-01");
		h.restart();
		const before = nexts(h);
		await h.hub.thumb(cur, -1);
		const skips = nexts(h) - before;
		expect(skips).toBeLessThanOrEqual(1);
		h.restart();
		const moves = h.fake.calls.length;
		expect((await h.hub.undoHistoryRating(r.id)).receipt?.undo?.outcome).toBe("conflict");
		expect(nexts(h) - before).toBe(skips);
		expect(
			h.fake.calls.slice(moves).filter((c) => /player\/(next|previous|play|pause)/.test(c)),
		).toEqual([]);
		expect(thumb(h, cur)).toBe(-1);
	});

	it("a second listener: nothing of the first one's selection, ratings or receipts", async () => {
		const a = await onboarded({ tracks: 20 });
		const b = await onboarded({ tracks: 20 });
		importAsFallbackSurface(a, plays(a));
		importAsFallbackSurface(b, plays(b));
		select(a, false, []);
		const id = songIds(a)[1]!;
		const r = await ratedFromHistory(a, id, "fb-listener-a-0001");
		a.restart();
		await a.hub.thumb(id, -1);
		b.restart();
		expect(b.hub.selectionView().selection).toEqual({ enabled: true, rules: [] });
		expect(effective(b)).toEqual([4, 4, 4, 4, 4, 4]);
		expect(b.hub.historyRatingReceipt(r.id).receipt).toBeNull();
		expect((await b.hub.undoHistoryRating(r.id)).receipt).toBeNull();
		expect(thumb(b, id)).toBe(0);
		expect(thumb(a, id)).toBe(-1);
	});
});
