/**
 * The listener's selection of an imported history, end to end on the real
 * hub: the same browser code builds the upload, the hub stores and selects,
 * and the memory the planner reads (`hub.memory`, handed to planQueue as is)
 * is checked against a reference counted independently from the kept plays.
 * Only isolated test data; nothing here touches a real history.
 */

import { describe, expect, it } from "vitest";
import {
	aggregateHistory,
	type ExtendedEntry,
	emptyAggregate,
	toRows,
} from "../../src/core/history";
import {
	addListens,
	finishListens,
	LISTEN_PAGE,
	type ListenEntry,
	newListens,
} from "../../src/core/listens";
import { isFavorite } from "../../src/core/memory";
import { DAY_MS, MINUTE_MS, type SlotKind } from "../../src/core/types";
import { HubError } from "../../src/worker/hub/hub";
import { migrate } from "../../src/worker/hub/schema";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;
type Entry = ExtendedEntry & ListenEntry;

const D = (iso: string) => Date.parse(iso);

function songs(h: H) {
	return [...h.fake.tracks.values()];
}

/** One export entry: a play of `ms`, or an early skip (forward button). */
function entry(h: H, k: number, iso: string, ms = 200_000): Entry {
	const t = songs(h)[k]!;
	return {
		ts: iso,
		ms_played: ms,
		spotify_track_uri: `spotify:track:${t.id}`,
		master_metadata_track_name: t.name,
		master_metadata_album_artist_name: t.artistName,
		master_metadata_album_album_name: t.albumName,
		reason_start: "trackdone",
		reason_end: ms >= 30_000 ? "trackdone" : "fwdbtn",
		skipped: ms < 30_000,
		platform: "iOS",
	};
}

/**
 * The test history: songs 0–19 six times in 2024 (favourites by behaviour),
 * songs 20–29 three times in 2025 and skipped once, song 0 twice in 2025.
 */
function history(h: H): Entry[] {
	const out: Entry[] = [];
	for (let k = 0; k < 20; k++)
		for (let i = 0; i < 6; i++)
			out.push(
				entry(h, k, new Date(D("2024-02-01T12:00:00Z") + (k * 6 + i) * DAY_MS).toISOString()),
			);
	for (let k = 20; k < 30; k++) {
		for (let i = 0; i < 3; i++)
			out.push(
				entry(h, k, new Date(D("2025-03-01T12:00:00Z") + (k * 4 + i) * DAY_MS).toISOString()),
			);
		out.push(
			entry(h, k, new Date(D("2025-03-01T12:00:00Z") + (k * 4 + 3) * DAY_MS).toISOString(), 4000),
		);
	}
	out.push(entry(h, 0, "2025-06-01T08:00:00Z"), entry(h, 0, "2025-06-02T08:00:00Z"));
	return out.sort((a, b) => Date.parse(a.ts!) - Date.parse(b.ts!));
}

const liveSince = (h: H) =>
	Number(h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'live_since'`)!.v);

/** What the import page does: totals block by block, then every play, bound to that import. */
function importFiles(h: H, entries: Entry[], opts: { stopAfterTotals?: boolean } = {}) {
	const before = liveSince(h);
	const rows = toRows(aggregateHistory(entries, emptyAggregate(), { before }));
	const size = 20;
	const parts = Math.max(1, Math.ceil(rows.length / size));
	let upload: string | undefined;
	// Begun on purpose, as the import page does (see startImport).
	const { start } = h.hub.startImport();
	for (let i = 0; i < parts; i++)
		upload = h.hub.importHistory(
			rows.slice(i * size, (i + 1) * size),
			i,
			parts,
			upload,
			i === 0 ? start : undefined,
		).upload;
	if (opts.stopAfterTotals) return upload!;
	uploadListens(h, entries, upload!);
	return upload!;
}

function uploadListens(h: H, entries: Entry[], importId: string, stopAfter?: number) {
	const done = finishListens(addListens(entries, newListens()), liveSince(h));
	const pages = <T>(xs: T[]) =>
		Array.from({ length: Math.ceil(xs.length / LISTEN_PAGE) }, (_, i) =>
			xs.slice(i * LISTEN_PAGE, (i + 1) * LISTEN_PAGE),
		);
	const blocks = [
		...pages(done.tracks).map((d) => ({ kind: "tracks", data: d })),
		...pages(done.rows).map((d) => ({ kind: "rows", data: d })),
	];
	let upload: string | undefined;
	blocks.forEach((b, part) => {
		if (stopAfter !== undefined && part >= stopAfter) return;
		upload = h.hub.importListens({
			upload,
			importId: part === 0 ? importId : undefined,
			part,
			parts: blocks.length,
			tracks: done.tracks.length,
			...b,
		}).upload;
	});
}

/** The reference: totals the browser would make from the kept entries alone. */
function reference(h: H, entries: Entry[], keep: (e: Entry) => boolean) {
	const agg = aggregateHistory(entries.filter(keep), emptyAggregate(), { before: liveSince(h) });
	const out = new Map<string, { plays: number; earlySkips: number; lastPlayedAt: number | null }>();
	for (const [id, s] of agg.stats)
		out.set(id, { plays: s.plays, earlySkips: s.earlySkips, lastPlayedAt: s.lastPlayedAt });
	return out;
}

const imported = (h: H, id: string) => {
	const m = h.hub.memory(id);
	return { plays: m.plays, earlySkips: m.earlySkips, lastPlayedAt: m.lastPlayedAt };
};

const apply = (h: H, rules: unknown[], enabled = true) =>
	h.hub.applySelection({ baseRevision: h.hub.selectionView().revision, enabled, rules });

const Y2024 = {
	type: "period",
	kind: "exclude",
	from: "2024-01-01",
	to: "2024-12-31",
	zone: "UTC",
};

/** Everything an import or its selection must never touch. */
function untouchable(h: H) {
	return JSON.stringify([
		h.sql.all(`SELECT * FROM plays ORDER BY played_at, track_id`),
		h.sql.all(`SELECT * FROM memory ORDER BY id`),
		h.sql.all(`SELECT * FROM bans ORDER BY station_id, track_id`),
		h.sql.all(`SELECT id, name, kind, sources, rules, playlist_id FROM stations ORDER BY id`),
		h.sql.all(`SELECT * FROM playback_sessions ORDER BY station_id`),
		h.sql.all(`SELECT * FROM discoveries ORDER BY station_id, id`),
		h.sql.all(`SELECT k, v FROM kv WHERE k IN ('liked_recent', 'guest') ORDER BY k`),
	]);
}

function deckKinds(h: H, stationId: number): { id: string; kind: SlotKind }[] {
	const row = h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, stationId)!;
	return (JSON.parse(row.deck) as { items: { id: string; kind: SlotKind }[] }).items;
}

async function setup() {
	const h = await onboarded({ tracks: 300 });
	const entries = history(h);
	importFiles(h, entries);
	const ids = songs(h).map((t) => t.id);
	return { h, entries, ids };
}

describe("selecting the imported history", () => {
	it("a left-out period leaves the raw plays findable and takes exactly their influence away", async () => {
		const { h, entries, ids } = await setup();
		const all = reference(h, entries, () => true);
		expect(imported(h, ids[5]!)).toEqual(all.get(ids[5]!));
		expect(isFavorite(h.hub.memory(ids[5]!))).toBe(true);
		// A live play of song 0 and a favourite thumb on song 1: their own signals.
		h.sql.run(
			`INSERT INTO plays (played_at, track_id, context_uri, station_id, ignored, meta) VALUES (?, ?, NULL, NULL, 0, NULL)`,
			h.clock.t - 30 * MINUTE_MS,
			ids[0]!,
		);
		h.sql.run(
			`INSERT INTO memory (id, last_played_at, plays, early_skips, last_skipped_at, thumb) VALUES (?, ?, 1, 0, NULL, 0)`,
			ids[0]!,
			h.clock.t - 30 * MINUTE_MS,
		);
		await h.hub.thumb(ids[1]!, 1);
		h.restart();
		const kept = untouchable(h);

		// A preview changes nothing at all.
		const raw = JSON.stringify(h.sql.all(`SELECT k, v FROM kv WHERE k LIKE 'history%' ORDER BY k`));
		const preview = h.hub.previewSelection({
			enabled: true,
			rules: [Y2024],
			query: { q: "Song 5" },
		});
		expect(preview.counts).toMatchObject({ plays: 152, includedPlays: 32 });
		expect(
			JSON.stringify(h.sql.all(`SELECT k, v FROM kv WHERE k LIKE 'history%' ORDER BY k`)),
		).toBe(raw);
		expect(imported(h, ids[5]!)).toEqual(all.get(ids[5]!));

		const view = apply(h, [Y2024]);
		expect(view).toMatchObject({ revision: 1, effective: { state: "current" } });
		const ref = reference(h, entries, (e) => !e.ts!.startsWith("2024"));
		for (let k = 0; k < 30; k++) {
			const live = k === 0 ? 1 : 0;
			const r = ref.get(ids[k]!);
			expect({ ...imported(h, ids[k]!), plays: imported(h, ids[k]!).plays - live }).toEqual({
				plays: r?.plays ?? 0,
				earlySkips: r?.earlySkips ?? 0,
				lastPlayedAt: k === 0 ? h.clock.t - 30 * MINUTE_MS : (r?.lastPlayedAt ?? null),
			});
		}
		// The ranking input: favourites by behaviour gone, the thumb stays a favourite.
		expect(isFavorite(h.hub.memory(ids[5]!))).toBe(false);
		expect(isFavorite(h.hub.memory(ids[1]!))).toBe(true);
		// Song 0: its live play plus its two 2025 plays.
		expect(h.hub.memory(ids[0]!).plays).toBe(3);
		// Still findable, with the rule that left it out.
		const look = h.hub.previewSelection({
			enabled: true,
			rules: view.selection.rules,
			query: { q: "Song 5", status: "excluded" },
		});
		expect(look.page.items.find((x) => x.key === ids[5])).toMatchObject({
			status: "excluded",
			plays: 6,
			includedPlays: 0,
			rules: ["period:2024-01-01:2024-12-31:UTC"],
		});
		expect(untouchable(h)).toBe(kept);
	});

	it("a saved queue keeps its order; a new queue asked for on purpose is planned anew", async () => {
		const { h } = await setup();
		const sid = h.stationIds[0]!;
		expect(await h.hub.play(sid, undefined, { newQueue: true })).toMatchObject({ ok: true });
		const session = h.hub.savedSession(sid)!;
		const deck = JSON.stringify(deckKinds(h, sid));
		apply(h, [Y2024]);
		await h.listen(2 * MINUTE_MS);
		// The queue that is there stays as it is.
		expect(h.hub.savedSession(sid)!.entryIds).toEqual(session.entryIds);
		expect(JSON.stringify(deckKinds(h, sid).slice(0, 5))).toBe(
			JSON.stringify(JSON.parse(deck).slice(0, 5)),
		);
		expect(await h.hub.play(sid, undefined, { newQueue: true })).toMatchObject({ ok: true });
		expect(h.hub.savedSession(sid)!.sessionId).not.toBe(session.sessionId);
	});

	it("bringing it back returns exactly the same; the same selection twice changes nothing", async () => {
		const { h, ids } = await setup();
		const before = ids.slice(0, 30).map((id) => h.hub.memory(id));
		const v1 = apply(h, [
			Y2024,
			{ type: "artist", kind: "exclude", name: songs(h)[22]!.artistName },
		]);
		const mid = ids.slice(0, 30).map((id) => h.hub.memory(id));
		// Again, in another order and with a duplicate: no new revision, nothing written.
		const kv = JSON.stringify(h.sql.all(`SELECT * FROM kv WHERE k LIKE 'history%'`));
		const v2 = h.hub.applySelection({
			baseRevision: 0,
			enabled: true,
			rules: [{ type: "artist", kind: "exclude", name: songs(h)[22]!.artistName }, Y2024, Y2024],
		});
		expect(v2.revision).toBe(v1.revision);
		expect(JSON.stringify(h.sql.all(`SELECT * FROM kv WHERE k LIKE 'history%'`))).toBe(kv);
		expect(ids.slice(0, 30).map((id) => h.hub.memory(id))).toEqual(mid);
		apply(h, []);
		expect(ids.slice(0, 30).map((id) => h.hub.memory(id))).toEqual(before);
		// A song brought back inside a left-out period: exactly its own plays.
		apply(h, [Y2024, { type: "track", kind: "include", id: ids[3]! }]);
		expect(h.hub.memory(ids[3]!)).toEqual(before[3]);
		expect(h.hub.memory(ids[4]!).plays).toBe(0);
	});

	it("switching off and on keeps the data and the rules; live signals stay", async () => {
		const { h, ids } = await setup();
		await h.hub.thumb(ids[2]!, -1);
		apply(h, [Y2024]);
		const ruled = ids.slice(0, 30).map((id) => h.hub.memory(id));
		const kept = untouchable(h);
		const off = h.hub.applySelection({ baseRevision: 1, enabled: false, rules: [Y2024] });
		expect(off.selection.enabled).toBe(false);
		for (const id of ids.slice(3, 30)) expect(h.hub.memory(id).plays).toBe(0);
		expect(h.hub.memory(ids[2]!).thumb).toBe(-1);
		expect((await h.hub.state()).history).toMatchObject({
			effectiveTracks: 0,
			enabled: false,
			importedTracks: 30,
		});
		expect(h.hub.listeningProfile("UTC").coverage).toMatchObject({
			importedPlays: 152,
			selection: { enabled: false, excludedPlays: 152 },
		});
		expect(h.hub.listeningProfile("UTC").plays).toBe(0);
		h.restart();
		const on = h.hub.applySelection({ baseRevision: 2, enabled: true, rules: [Y2024] });
		expect(on.selection.rules).toHaveLength(1);
		expect(ids.slice(0, 30).map((id) => h.hub.memory(id))).toEqual(ruled);
		expect(untouchable(h)).toBe(kept);
	});

	it("the Hörprofil and the genre request see the same selection", async () => {
		const { h, ids } = await setup();
		const all = h.hub.listeningProfile("UTC");
		expect(all.plays).toBe(152);
		apply(h, [{ type: "artist", kind: "exclude", name: songs(h)[0]!.artistName }]);
		const p = h.hub.listeningProfile("UTC");
		expect(p.plays).toBe(144);
		expect(p.topSongs.some((x) => x.id === ids[0])).toBe(false);
		expect(p.coverage.selection).toEqual({ enabled: true, rules: 1, excludedPlays: 8 });
		// The genre request is built from the same timeline.
		const g = h.hub.prepareGenres();
		expect(g.request!.artists.some((a) => a.name === songs(h)[0]!.artistName)).toBe(false);
	});

	it("keeps the decision across reload, restart and a re-read of the storage", async () => {
		const { h, ids } = await setup();
		apply(h, [Y2024]);
		const mem = ids.slice(0, 30).map((id) => h.hub.memory(id));
		const view = h.hub.selectionView();
		h.restart();
		expect(h.hub.selectionView()).toEqual(view);
		expect(ids.slice(0, 30).map((id) => h.hub.memory(id))).toEqual(mem);
		// Computed again from the stored data alone, it is the same.
		h.sql.run(`DELETE FROM hist_effective`);
		h.sql.run(`DELETE FROM kv WHERE k = 'history_effective'`);
		h.restart();
		expect(ids.slice(0, 30).map((id) => h.hub.memory(id))).toEqual(mem);
		expect(h.hub.selectionView().counts).toEqual(view.counts);
	});
});

describe("racing changes, uploads and old states", () => {
	it("an older tab cannot take over a selection made on an older revision", async () => {
		const { h, ids } = await setup();
		apply(h, [Y2024]);
		const mem = ids.map((id) => h.hub.memory(id));
		// Two changes sent quickly from two places on revision 1: only the first lands.
		h.hub.applySelection({
			baseRevision: 1,
			enabled: true,
			rules: [Y2024, { type: "summary", kind: "exclude" }],
		});
		const stale = () => h.hub.applySelection({ baseRevision: 1, enabled: true, rules: [] });
		expect(stale).toThrow(HubError);
		try {
			stale();
		} catch (e) {
			expect((e as HubError).status).toBe(409);
		}
		expect(h.hub.selectionView().revision).toBe(2);
		expect(ids.map((id) => h.hub.memory(id))).toEqual(mem);
	});

	it("a deletion while the totals are uploading refuses the rest of that upload", async () => {
		const { h, entries } = await setup();
		const before = liveSince(h);
		const rows = toRows(aggregateHistory(entries, emptyAggregate(), { before }));
		const first = h.hub.importHistory(rows.slice(0, 10), 0, 3);
		// Nothing of the new upload counts yet: the stored totals stand until the last block.
		expect(h.hub.selectionView().dataset.songs).toBe(30);
		expect(h.hub.selectionView().uploading).toBe(true);
		h.hub.deleteImport(h.hub.selectionView().dataset.key);
		expect(() => h.hub.importHistory(rows.slice(10, 20), 1, 3, first.upload)).toThrow(/abgelöst/);
		// An old page without its id (an app from before) is refused the same way.
		expect(() => h.hub.importHistory(rows.slice(10, 20), 1, 3)).toThrow(/abgelöst/);
		expect(h.sql.first<{ n: number }>(`SELECT COUNT(*) AS n FROM hist_pages`)!.n).toBe(0);
		expect(h.sql.first<{ n: number }>(`SELECT COUNT(*) AS n FROM hist_stage`)!.n).toBe(0);
	});

	it("plays uploaded late for a deleted import are refused; a deletion mid-upload stops it", async () => {
		const { h, entries } = await setup();
		const id = h.hub.selectionView().dataset.key.split("|")[0]!;
		h.hub.deleteImport(h.hub.selectionView().dataset.key);
		expect(() => uploadListens(h, entries, id)).toThrow(/gelöscht oder ersetzt/);
		// Started for a current import, then deleted before its last block.
		const again = importFiles(h, entries, { stopAfterTotals: true });
		const many = [
			...entries,
			...Array.from({ length: 1200 }, (_, i) =>
				entry(h, 40 + (i % 50), new Date(D("2023-01-01T00:00:00Z") + i * 3_600_000).toISOString()),
			),
		];
		uploadListens(h, many, again, 1);
		h.hub.deleteImport(h.hub.selectionView().dataset.key);
		expect(() =>
			h.hub.importListens({
				upload: "x",
				part: 1,
				parts: 3,
				tracks: 1,
				kind: "rows",
				data: [[1, 0, 1, 0, 0]],
			}),
		).toThrow(/abgelöst/);
		expect(h.hub.listeningProfile("UTC").coverage.importedPlays).toBe(0);
		expect(h.hub.memory(songs(h)[0]!.id).plays).toBe(0);
	});

	it("a genre estimate asked for under the old selection does not land", async () => {
		const { h } = await setup();
		h.clock.t += 7 * 3_600_000;
		const asked = h.hub.prepareGenres();
		expect(asked.request).not.toBeNull();
		apply(h, [Y2024]);
		const answer = h.hub.storeGenres(asked.request!.attempt, {
			at: h.clock.t,
			summary: "alt",
			genres: [{ name: "Pop", share: 100 }],
		} as never);
		expect(answer.estimate).toBeNull();
	});

	it("a selection that cannot be computed is not taken over; a broken one counts for nothing", async () => {
		const { h, ids } = await setup();
		const before = ids.map((id) => h.hub.memory(id));
		h.sql.run(`UPDATE listen_pages SET data = 'kaputt' WHERE kind = 'rows'`);
		h.restart();
		expect(() => apply(h, [Y2024])).toThrow(/nicht berechnet/);
		expect(h.hub.selectionView().revision).toBe(0);
		expect(ids.map((id) => h.hub.memory(id))).toEqual(before);
		// Taken over earlier, broken since: the import counts for nothing, never for all.
		const { h: h2, ids: ids2 } = await setup();
		apply(h2, [Y2024]);
		h2.sql.run(`UPDATE listen_pages SET data = 'kaputt' WHERE kind = 'rows'`);
		h2.sql.run(`DELETE FROM kv WHERE k = 'history_effective'`);
		h2.restart();
		for (const id of ids2.slice(0, 30)) expect(h2.hub.memory(id).plays).toBe(0);
		expect(h2.hub.selectionView().effective).toMatchObject({ state: "failed" });
	});
});

describe("deleting an import", () => {
	it("names its scope; cancelling or a stale scope changes nothing; deleting removes exactly it", async () => {
		const { h, ids } = await setup();
		const sid = h.stationIds[0]!;
		expect(await h.hub.play(sid)).toMatchObject({ ok: true });
		await h.listen(10 * MINUTE_MS);
		await h.hub.thumb(ids[7]!, 1);
		apply(h, [Y2024]);
		const view = h.hub.selectionView();
		expect(view.dataset).toMatchObject({ songs: 30, coverage: "events", hasImport: true });
		const kept = untouchable(h);
		const all = JSON.stringify(h.sql.all(`SELECT * FROM kv ORDER BY k`));
		// Cancelled: nothing is sent. A scope that is not the stored one: refused.
		expect(() => h.hub.deleteImport("other|g1")).toThrow(/geändert/);
		expect(JSON.stringify(h.sql.all(`SELECT * FROM kv ORDER BY k`))).toBe(all);
		const r = h.hub.deleteImport(view.dataset.key);
		expect(r.deleted).toMatchObject({ songs: 30 });
		for (const t of ["hist_pages", "hist_stage", "hist_effective", "listen_pages"])
			expect(h.sql.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n).toBe(0);
		expect(untouchable(h)).toBe(kept);
		h.restart();
		const after = h.hub.selectionView();
		expect(after.dataset).toMatchObject({ hasImport: false, coverage: "none" });
		// The rules stay for a later import, said so in the interface.
		expect(after.selection.rules).toHaveLength(1);
		expect(h.hub.memory(ids[7]!)).toMatchObject({ thumb: 1, plays: 0 });
		expect(() => h.hub.deleteImport(after.dataset.key)).toThrow(/kein Import/);
	});
});

describe("a new import, the old kind and edge cases", () => {
	it("the same files again: the same result, the saved rules and switch apply to them", async () => {
		const { h, entries, ids } = await setup();
		apply(h, [Y2024]);
		const mem = ids.map((id) => h.hub.memory(id));
		importFiles(h, entries);
		expect(ids.map((id) => h.hub.memory(id))).toEqual(mem);
		h.hub.applySelection({ baseRevision: 1, enabled: false, rules: [Y2024] });
		importFiles(h, entries);
		// A new import does not switch it back on by itself.
		expect(h.hub.selectionView().selection.enabled).toBe(false);
		for (const id of ids.slice(0, 30)) expect(h.hub.memory(id).plays).toBe(0);
	});

	it("an old import of totals only: covered as such, never split, deleted as a whole", async () => {
		const h = await onboarded({ tracks: 300 });
		importFiles(h, history(h), { stopAfterTotals: true });
		const ids = songs(h).map((t) => t.id);
		const view = h.hub.selectionView();
		expect(view.dataset).toMatchObject({ coverage: "summary", rows: 0, songs: 30 });
		expect(view.counts).toMatchObject({ summarySongs: 30, rows: 0 });
		// A period cannot reach songs without single plays; no plays are invented.
		apply(h, [Y2024]);
		expect(h.hub.memory(ids[5]!).plays).toBe(6);
		apply(h, [Y2024, { type: "summary", kind: "exclude" }]);
		expect(h.hub.memory(ids[5]!).plays).toBe(0);
		apply(h, [
			{ type: "summary", kind: "exclude" },
			{ type: "track", kind: "include", id: ids[5]! },
		]);
		expect(h.hub.memory(ids[5]!).plays).toBe(6);
		h.hub.deleteImport(h.hub.selectionView().dataset.key);
		expect(h.hub.memory(ids[5]!).plays).toBe(0);
	});

	it("everything left out, empty imports and unknown fields stay honest", async () => {
		const { h, ids } = await setup();
		const v = apply(h, [
			{ type: "period", kind: "exclude", from: "2000-01-01", to: "2030-12-31", zone: "UTC" },
		]);
		expect(v.counts).toMatchObject({ includedPlays: 0, includedSongs: 0 });
		for (const id of ids.slice(0, 30)) expect(h.hub.memory(id).plays).toBe(0);
		// Overlapping periods: one decision per play, nothing counted twice.
		const o = apply(h, [
			Y2024,
			{ type: "period", kind: "exclude", from: "2024-06-01", to: "2025-12-31", zone: "UTC" },
		]);
		expect(o.counts!.rules.reduce((a, r) => a + r.plays, 0)).toBe(
			o.counts!.plays - o.counts!.includedPlays,
		);
		expect(() =>
			apply(h, [{ type: "period", kind: "exclude", from: "2024-1-1", to: "x", zone: "UTC" }]),
		).toThrow(/Ungültige Auswahl/);
		const empty = await onboarded({ tracks: 50 });
		expect(empty.hub.selectionView()).toMatchObject({
			counts: null,
			dataset: { coverage: "none" },
		});
		expect(empty.hub.previewSelection({ enabled: true, rules: [], query: {} }).page.total).toBe(0);
	});
});

describe("stored plays from live time", () => {
	it("are listed with no import influence; live plays of the same song are not counted twice", async () => {
		const h = await onboarded({ tracks: 300 });
		const live = liveSince(h);
		const before = [0, 1, 2].map((i) =>
			entry(h, 9, new Date(D("2025-05-01T10:00:00Z") + i * DAY_MS).toISOString()),
		);
		// An export that runs past the first sign-in (as an older app could store it).
		const after = entry(h, 9, new Date(live + 30 * MINUTE_MS).toISOString());
		const rows = toRows(aggregateHistory(before, emptyAggregate(), { before: live }));
		const { upload } = h.hub.importHistory(rows, 0, 1);
		const done = finishListens(addListens([...before, after], newListens()), null);
		const first = h.hub.importListens({
			importId: upload,
			part: 0,
			parts: 2,
			tracks: done.tracks.length,
			kind: "tracks",
			data: done.tracks,
		});
		h.hub.importListens({
			upload: first.upload,
			part: 1,
			parts: 2,
			tracks: done.tracks.length,
			kind: "rows",
			data: done.rows,
		});
		// The same song counted live after the sign-in.
		const id = songs(h)[9]!.id;
		h.sql.run(
			`INSERT INTO memory (id, last_played_at, plays, early_skips, last_skipped_at, thumb) VALUES (?, ?, 1, 0, NULL, 0)`,
			id,
			live + 30 * MINUTE_MS,
		);
		h.restart();
		expect(h.hub.memory(id).plays).toBe(4);
		const look = h.hub.previewSelection({
			enabled: true,
			rules: [],
			query: { q: songs(h)[9]!.name },
		});
		expect(look.page.items[0]).toMatchObject({ rows: 4, afterLive: 1, plays: 3, includedPlays: 3 });
		expect(look.counts).toMatchObject({ rows: 4, afterLiveRows: 1, plays: 3 });
		// A rule on that song changes only the import's three plays; the live one stays.
		apply(h, [{ type: "track", kind: "exclude", id }]);
		expect(h.hub.memory(id).plays).toBe(1);
		expect(h.hub.listeningProfile("UTC").coverage.selection).toMatchObject({ excludedPlays: 3 });
	});
});

describe("storage and accounts", () => {
	it("the additive migration keeps every stored import and adds its tables", async () => {
		const { h, ids } = await setup();
		const mem = ids.map((id) => h.hub.memory(id));
		const kept = JSON.stringify(h.sql.all(`SELECT * FROM hist_pages ORDER BY page`));
		for (const t of ["hist_stage", "hist_effective", "playlist_scan", "playlist_member_pages"])
			h.sql.run(`DROP TABLE ${t}`);
		h.sql.run(`UPDATE kv SET v = '7' WHERE k = 'schema_version'`);
		migrate(h.sql);
		expect(h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'schema_version'`)!.v).toBe("8");
		expect(JSON.stringify(h.sql.all(`SELECT * FROM hist_pages ORDER BY page`))).toBe(kept);
		h.restart();
		// No selection was ever made: everything counts, exactly as before.
		expect(ids.map((id) => h.hub.memory(id))).toEqual(mem);
		expect(h.hub.selectionView()).toMatchObject({
			revision: 0,
			selection: { enabled: true, rules: [] },
		});
	});

	it("two listeners: one's selection or deletion never reaches the other", async () => {
		const a = await setup();
		const b = await setup();
		const bMem = b.ids.map((id) => b.h.hub.memory(id));
		apply(a.h, [Y2024]);
		a.h.hub.deleteImport(a.h.hub.selectionView().dataset.key);
		expect(b.ids.map((id) => b.h.hub.memory(id))).toEqual(bMem);
		expect(b.h.hub.selectionView()).toMatchObject({ revision: 0, dataset: { songs: 30 } });
	});
});
