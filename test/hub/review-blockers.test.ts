/**
 * Regressions for the independent review of PR #30 (frozen head ddecae2):
 * P1 mixed import generations, P1 deleted history revived by late legacy
 * blocks, P2 playlist counts claiming completeness. Synthetic data only.
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
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../src/core/types";
import type { HubError } from "../../src/worker/hub/hub";
import { FakeSpotify } from "../fakes/fake-spotify";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;
type Entry = ExtendedEntry & ListenEntry;

const songOf = (h: H, k: number) => [...h.fake.tracks.values()][k]!;

function entry(h: H, k: number, iso: string): Entry {
	const t = songOf(h, k);
	return {
		ts: iso,
		ms_played: 200_000,
		spotify_track_uri: `spotify:track:${t.id}`,
		master_metadata_track_name: t.name,
		master_metadata_album_artist_name: t.artistName,
		master_metadata_album_album_name: t.albumName,
		reason_start: "trackdone",
		reason_end: "trackdone",
	};
}

const liveSince = (h: H) =>
	Number(h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'live_since'`)!.v);

function totals(h: H, entries: Entry[]): string {
	const rows = toRows(aggregateHistory(entries, emptyAggregate(), { before: liveSince(h) }));
	return h.hub.importHistory(rows, 0, 1).upload;
}

/** Single plays; `importId` undefined: an app from before that does not name its import. */
function plays(h: H, entries: Entry[], importId: string | undefined) {
	const done = finishListens(addListens(entries, newListens()), liveSince(h));
	expect(done.tracks.length).toBeLessThanOrEqual(LISTEN_PAGE);
	const first = h.hub.importListens({
		importId,
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
}

const Y2024 = {
	type: "period",
	kind: "exclude",
	from: "2024-01-01",
	to: "2024-12-31",
	zone: "UTC",
};

describe("review P1: import generations", () => {
	it("a newer import of totals is not judged by the older import's single plays", async () => {
		const h = await onboarded({ tracks: 100 });
		const id = songOf(h, 4).id;
		const old = [entry(h, 4, "2024-03-01T10:00:00Z")];
		plays(h, old, totals(h, old));
		// A newer import arrives as totals only (its single plays never came).
		totals(h, [entry(h, 4, "2025-03-01T10:00:00Z")]);
		h.hub.applySelection({
			dataset: h.hub.selectionView().dataset.key,
			baseRevision: 0,
			enabled: true,
			rules: [Y2024],
		});
		// The 2025 play is not touched by a 2024 rule: its one play stays.
		expect(h.hub.memory(id).plays).toBe(1);
		// The old import's plays are not shown as this import's either.
		expect(h.hub.selectionView().dataset).toMatchObject({ coverage: "summary", rows: 0 });
		expect(h.hub.listeningProfile("UTC").coverage.importedPlays).toBe(0);
	});

	it("single plays uploaded for the stored totals are used", async () => {
		const h = await onboarded({ tracks: 100 });
		const id = songOf(h, 4).id;
		const e = [entry(h, 4, "2024-03-01T10:00:00Z"), entry(h, 4, "2025-03-01T10:00:00Z")];
		plays(h, e, totals(h, e));
		h.hub.applySelection({
			dataset: h.hub.selectionView().dataset.key,
			baseRevision: 0,
			enabled: true,
			rules: [Y2024],
		});
		expect(h.hub.memory(id).plays).toBe(1);
		expect(h.hub.selectionView().dataset).toMatchObject({ coverage: "events", rows: 2 });
	});
});

describe("review P1: deleted history stays deleted", () => {
	it("late single plays from an app that does not name its import are refused after a deletion", async () => {
		const h = await onboarded({ tracks: 100 });
		const e = [entry(h, 6, "2024-05-01T10:00:00Z")];
		plays(h, e, totals(h, e));
		h.hub.deleteImport(h.hub.selectionView().dataset.key);
		expect(() => plays(h, e, undefined)).toThrow(/gelöscht oder ersetzt/);
		expect(h.hub.selectionView().dataset).toMatchObject({ hasImport: false });
		expect(h.hub.listeningProfile("UTC").plays).toBe(0);
	});

	it("nor can they attach to a newer import they do not belong to", async () => {
		const h = await onboarded({ tracks: 100 });
		const e = [entry(h, 6, "2024-05-01T10:00:00Z")];
		totals(h, e);
		expect(() => plays(h, e, undefined)).toThrow(/gelöscht oder ersetzt/);
		expect(() => plays(h, e, "not-this-import")).toThrow(/gelöscht oder ersetzt/);
	});
});

describe("review P2: playlist counts never claim more than was read", () => {
	async function setup() {
		const fake = new FakeSpotify();
		const h = await onboarded({ fake, tracks: 300, playlists: [100] });
		const t = [...fake.tracks.values()];
		const X = t[200]!.id;
		const A = fake.addPlaylist("mika", "Sommer", [X, ...t.slice(210, 320).map((x) => x.id), X]);
		return { h, fake, X, A };
	}
	const countOf = (h: H, id: string) =>
		(h.hub as unknown as { playlistCountOf(): (id: string) => unknown }).playlistCountOf()(id);

	it("a failed refresh of the playlist list leaves the count incomplete", async () => {
		const { h, fake, X } = await setup();
		fake.failWhen = (m, path) => (m === "GET" && path === "/me/playlists" ? { status: 500 } : null);
		h.clock.t += 11 * MINUTE_MS;
		await h.hub.requestPlaylistCounts();
		await h.listen(3 * HOUR_MS);
		const v = h.hub.playlistCountsView();
		expect(v.complete).toBe(false);
		expect((countOf(h, X) as { complete: boolean }).complete).toBe(false);
	});

	it("an empty page before the last is a missing page", async () => {
		const { h, fake, A, X } = await setup();
		fake.failWhen = (m, path) =>
			m === "GET" && path === `/playlists/${A.id}/items`
				? { status: 200, body: { items: [], next: "https://fake/v1/next", total: 112 } }
				: null;
		h.clock.t += 11 * MINUTE_MS;
		await h.hub.requestPlaylistCounts();
		await h.listen(DAY_MS / 24);
		expect(h.hub.playlistCountsView().complete).toBe(false);
		expect((countOf(h, X) as { complete: boolean }).complete).toBe(false);
	});

	it("a last page that ends before the announced total is a missing page too", async () => {
		const { h, fake, A, X } = await setup();
		fake.failWhen = (m, path) =>
			m === "GET" && path === `/playlists/${A.id}/items`
				? { status: 200, body: { items: [], next: null, total: 112 } }
				: null;
		h.clock.t += 11 * MINUTE_MS;
		await h.hub.requestPlaylistCounts();
		await h.listen(DAY_MS / 24);
		expect(h.hub.playlistCountsView().complete).toBe(false);
		expect((countOf(h, X) as { complete: boolean }).complete).toBe(false);
	});
});

describe("review R1: an event upload belongs to the totals it began with", () => {
	it("single plays still on their way when newer totals arrive are refused", async () => {
		const h = await onboarded({ tracks: 100 });
		const a = [entry(h, 1, "2024-03-01T10:00:00Z")];
		const done = finishListens(addListens(a, newListens()), liveSince(h));
		const first = h.hub.importListens({
			importId: totals(h, a),
			part: 0,
			parts: 2,
			tracks: done.tracks.length,
			kind: "tracks",
			data: done.tracks,
		});
		totals(h, [entry(h, 2, "2025-03-01T10:00:00Z")]);
		expect(() =>
			h.hub.importListens({
				upload: first.upload,
				part: 1,
				parts: 2,
				tracks: done.tracks.length,
				kind: "rows",
				data: done.rows,
			}),
		).toThrow(/abgelöst/);
		h.restart();
		expect(h.hub.listeningProfile("UTC").topSongs.map((x) => x.id)).not.toContain(songOf(h, 1).id);
		expect(h.hub.memory(songOf(h, 1).id).plays).toBe(0);
		expect(h.hub.memory(songOf(h, 2).id).plays).toBe(1);
	});
});

describe("review R2: a deletion is not undone by anything begun before it", () => {
	it("a first totals block begun before the deletion is refused; a new import begun after works", async () => {
		const h = await onboarded({ tracks: 100 });
		const e = [entry(h, 3, "2024-05-01T10:00:00Z")];
		const rows = toRows(aggregateHistory(e, emptyAggregate(), { before: liveSince(h) }));
		const { start } = h.hub.startImport();
		h.hub.importHistory(rows, 0, 1, undefined, start);
		const stale = h.hub.startImport().start;
		h.hub.deleteImport(h.hub.selectionView().dataset.key);
		// Sent before the deletion, arriving after: refused, with or without the old epoch.
		expect(() => h.hub.importHistory(rows, 0, 1, undefined, stale)).toThrow(/neu laden/);
		expect(() => h.hub.importHistory(rows, 0, 1)).toThrow(/neu laden/);
		h.restart();
		expect(h.hub.memory(songOf(h, 3).id).plays).toBe(0);
		expect(h.hub.selectionView().dataset.hasImport).toBe(false);
		// Begun on purpose after the deletion: a new import, taken.
		const fresh = h.hub.startImport().start;
		expect(fresh).toBe(stale + 1);
		const id = h.hub.importHistory(rows, 0, 1, undefined, fresh).upload;
		plays(h, e, id);
		expect(h.hub.memory(songOf(h, 3).id).plays).toBe(1);
	});
});

describe("review R4: songs whose single plays do not cover their totals", () => {
	async function partialImport() {
		const h = await onboarded({ tracks: 100 });
		const t = songOf(h, 0);
		const id = h.hub.importHistory(
			[[t.id, 10, 0, Date.parse("2025-03-01T12:00:00Z"), 0, 10]],
			0,
			1,
		).upload;
		plays(h, [entry(h, 0, "2024-03-01T12:00:00Z"), entry(h, 0, "2025-03-01T12:00:00Z")], id);
		return { h, t };
	}

	it("are said to be partly covered and decided only as a whole; nothing is invented", async () => {
		const { h, t } = await partialImport();
		const preview = h.hub.previewSelection({ enabled: true, rules: [Y2024], query: {} });
		expect(preview.counts).toMatchObject({
			partialSongs: 1,
			partialPlays: 10,
			plays: 10,
			includedPlays: 10,
			changedSongs: 0,
		});
		expect(preview.page.items[0]).toMatchObject({ partial: true, rows: 2, plays: 10 });
		h.hub.applySelection({
			dataset: h.hub.selectionView().dataset.key,
			baseRevision: 0,
			enabled: true,
			rules: [Y2024],
		});
		// The 2024 rule cannot reach the eight plays that were never stored one by one:
		// the song keeps its totals (not 1, and no guessed 9), as the preview said.
		expect(h.hub.memory(t.id).plays).toBe(10);
		expect(h.hub.selectionView().dataset.coverage).toBe("mixed");
		// The Hörprofil decides it the same way: both stored plays stay.
		expect(h.hub.listeningProfile("UTC").plays).toBe(2);
	});

	it("the totals rule takes it out whole, everywhere; a song rule brings it back", async () => {
		const { h, t } = await partialImport();
		h.hub.applySelection({
			dataset: h.hub.selectionView().dataset.key,
			baseRevision: 0,
			enabled: true,
			rules: [Y2024, { type: "summary", kind: "exclude" }],
		});
		expect(h.hub.memory(t.id).plays).toBe(0);
		expect(h.hub.listeningProfile("UTC").plays).toBe(0);
		h.hub.applySelection({
			dataset: h.hub.selectionView().dataset.key,
			baseRevision: 1,
			enabled: true,
			rules: [
				Y2024,
				{ type: "summary", kind: "exclude" },
				{ type: "track", kind: "include", id: t.id },
			],
		});
		expect(h.hub.memory(t.id).plays).toBe(10);
		expect(h.hub.listeningProfile("UTC").plays).toBe(2);
	});
});

describe("review R2 (held): every later totals block names its upload", () => {
	it("an unnamed or foreign continuation never joins a new upload; the new upload completes intact", async () => {
		const h = await onboarded({ tracks: 100 });
		const [a, b, c] = [songOf(h, 10).id, songOf(h, 11).id, songOf(h, 12).id];
		const at = Date.parse("2024-03-01T12:00:00Z");
		// Import A, deleted; restart; a new two-block import B begun on purpose.
		h.hub.importHistory([[a, 1, 0, at, 0, 1]], 0, 1, undefined, h.hub.startImport().start);
		h.hub.deleteImport(h.hub.selectionView().dataset.key);
		h.restart();
		const fresh = h.hub.importHistory(
			[[b, 1, 0, at, 0, 1]],
			0,
			2,
			undefined,
			h.hub.startImport().start,
		);
		// A's late second block, without an id or with another: refused, nothing staged.
		expect(() => h.hub.importHistory([[a, 99, 0, at, 0, 99]], 1, 2)).toThrow(/abgelöst/);
		expect(() => h.hub.importHistory([[a, 99, 0, at, 0, 99]], 1, 2, "old-upload")).toThrow(
			/abgelöst/,
		);
		h.restart();
		expect(() => h.hub.importHistory([[a, 99, 0, at, 0, 99]], 1, 2)).toThrow(/abgelöst/);
		// B's own second block completes B.
		h.hub.importHistory([[c, 2, 0, at, 0, 2]], 1, 2, fresh.upload);
		expect(h.hub.memory(a).plays).toBe(0);
		expect(h.hub.memory(b).plays).toBe(1);
		expect(h.hub.memory(c).plays).toBe(2);
		expect(h.hub.selectionView().dataset).toMatchObject({ songs: 2, hasImport: true });
		// The completed upload is closed: even its own id cannot append to it again.
		expect(() => h.hub.importHistory([[a, 99, 0, at, 0, 99]], 1, 2, fresh.upload)).toThrow(
			/abgelöst/,
		);
		expect(h.hub.memory(a).plays).toBe(0);
	});

	it("a one-block upload replaces an unfinished one, whose late blocks are then refused", async () => {
		const h = await onboarded({ tracks: 100 });
		const [a, b] = [songOf(h, 20).id, songOf(h, 21).id];
		const at = Date.parse("2024-03-01T12:00:00Z");
		const start = h.hub.startImport().start;
		const first = h.hub.importHistory([[a, 3, 0, at, 0, 3]], 0, 2, undefined, start);
		h.hub.importHistory([[b, 1, 0, at, 0, 1]], 0, 1, undefined, start);
		expect(() => h.hub.importHistory([[a, 3, 0, at, 0, 3]], 1, 2, first.upload)).toThrow(
			/abgelöst/,
		);
		expect(h.hub.memory(a).plays).toBe(0);
		expect(h.hub.memory(b).plays).toBe(1);
	});
});

describe("review R10 (held): taking over names the import its preview counted", () => {
	async function twoSongs() {
		const h = await onboarded({ tracks: 100 });
		const [a, b] = [songOf(h, 30).id, songOf(h, 31).id];
		const at = Date.parse("2024-03-01T12:00:00Z");
		h.hub.importHistory(
			[
				[a, 2, 0, at, 0, 2],
				[b, 2, 0, at, 0, 2],
			],
			0,
			1,
			undefined,
			h.hub.startImport().start,
		);
		return { h, a, b, at };
	}
	const exclude = (id: string) => [{ type: "track", kind: "exclude", id }];

	it("a replacement between preview and taking over is refused at the same revision", async () => {
		const { h, a, b, at } = await twoSongs();
		const preview = h.hub.previewSelection({ enabled: true, rules: exclude(a), query: {} });
		expect(preview.counts).toMatchObject({ plays: 4, includedPlays: 2 });
		// Another tab replaces the import; the selection revision stays 0.
		h.hub.importHistory([[b, 20, 0, at, 0, 20]], 0, 1, undefined, h.hub.startImport().start);
		expect(h.hub.selectionView().revision).toBe(0);
		expect(() =>
			h.hub.applySelection({
				baseRevision: 0,
				enabled: true,
				rules: exclude(a),
				dataset: preview.dataset,
			}),
		).toThrow(/seit der Vorschau geändert/);
		expect(h.hub.selectionView()).toMatchObject({ revision: 0, selection: { rules: [] } });
		expect(h.hub.memory(b).plays).toBe(20);
		// A fresh preview of the new data can be taken over.
		const again = h.hub.previewSelection({ enabled: true, rules: exclude(a), query: {} });
		expect(again.dataset).not.toBe(preview.dataset);
		expect(again.counts).toMatchObject({ plays: 20, includedPlays: 20 });
		const v = h.hub.applySelection({
			baseRevision: 0,
			enabled: true,
			rules: exclude(a),
			dataset: again.dataset,
		});
		expect(v.revision).toBe(1);
	});

	it("a deletion or a new upload between preview and taking over is refused too", async () => {
		const { h, a } = await twoSongs();
		const preview = h.hub.previewSelection({ enabled: true, rules: exclude(a), query: {} });
		h.hub.deleteImport(h.hub.selectionView().dataset.key);
		h.restart();
		expect(() =>
			h.hub.applySelection({
				baseRevision: 0,
				enabled: true,
				rules: exclude(a),
				dataset: preview.dataset,
			}),
		).toThrow(/seit der Vorschau geändert/);
		expect(h.hub.selectionView().revision).toBe(0);
	});
});

describe("review R10 (held): the dataset identity is required", () => {
	it("missing, null, empty or wrong identity changes nothing, also for an unchanged selection", async () => {
		const h = await onboarded({ tracks: 100 });
		const a = songOf(h, 40).id;
		const at = Date.parse("2024-03-01T12:00:00Z");
		h.hub.importHistory([[a, 2, 0, at, 0, 2]], 0, 1, undefined, h.hub.startImport().start);
		const kv = () =>
			JSON.stringify(h.sql.all(`SELECT k, v FROM kv WHERE k LIKE 'history%' ORDER BY k`));
		const before = kv();
		const rules = [{ type: "track", kind: "exclude", id: a }];
		const status = (fn: () => unknown) => {
			try {
				fn();
				return 200;
			} catch (e) {
				return (e as HubError).status;
			}
		};
		for (const dataset of [undefined, null, "", 0, {}])
			expect(
				status(() =>
					h.hub.applySelection({ baseRevision: 0, enabled: true, rules, dataset } as never),
				),
			).toBe(400);
		expect(
			status(() => h.hub.applySelection({ baseRevision: 0, enabled: true, rules, dataset: "x|y" })),
		).toBe(409);
		// Checked before an unchanged selection is answered as such.
		expect(status(() => h.hub.applySelection({ baseRevision: 0, enabled: true, rules: [] }))).toBe(
			400,
		);
		expect(
			status(() =>
				h.hub.applySelection({ baseRevision: 0, enabled: false, rules: [], dataset: "x|y" }),
			),
		).toBe(409);
		expect(kv()).toBe(before);
		expect(h.hub.memory(a).plays).toBe(2);
		const ok = h.hub.applySelection({
			baseRevision: 0,
			enabled: true,
			rules,
			dataset: h.hub.selectionView().dataset.key,
		});
		expect(ok.revision).toBe(1);
		expect(h.hub.memory(a).plays).toBe(0);
	});
});
