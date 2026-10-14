/** Isolated compatibility verification only; no product changes or live I/O. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { onboarded } from '__FALLBACK_ROOT__/original-b201-source/test/hub/harness';
import { HubCore as NewHub } from '__FALLBACK_ROOT__/original-b201-source/src/worker/hub/hub';
import { HubCore as OldHub } from '__FALLBACK_ROOT__/legacy-production-8d/src/worker/hub/hub';
import { aggregateHistory, emptyAggregate, toRows } from '__FALLBACK_ROOT__/original-b201-source/src/core/history';

type H = Awaited<ReturnType<typeof onboarded>>;
beforeEach(() => vi.stubGlobal('fetch', async () => { throw new Error('External network forbidden in this synthetic probe'); }));
afterEach(() => vi.unstubAllGlobals());
const dependencies = (h: H) => (h.hub as unknown as { d: ConstructorParameters<typeof NewHub>[0] }).d;
const schema = (h: H) => h.sql.first<{v: string}>("SELECT v FROM kv WHERE k='schema_version'")?.v;
const storedThumb = (h: H, id: string) => h.sql.first<{thumb: number}>('SELECT thumb FROM memory WHERE id=?', id)?.thumb ?? 0;
function snapshot(h: H) {
  const tables = h.sql.all<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return JSON.stringify(tables.map(({name}) => ({name, rows: h.sql.all(`SELECT * FROM "${name}"`).map(r => JSON.stringify(r)).sort()})));
}
async function importedAndDisabled() {
  const h = await onboarded({tracks: 10});
  const track = [...h.fake.tracks.values()][0]!;
  const events = Array.from({length: 4}, (_, i) => ({ts: `2024-01-0${i+1}T12:00:00Z`, ms_played: 200000,
    spotify_track_uri: `spotify:track:${track.id}`, master_metadata_track_name: track.name,
    master_metadata_album_artist_name: track.artistName, master_metadata_album_album_name: track.albumName,
    reason_start: 'trackdone', reason_end: 'trackdone', skipped: false}));
  const rows = toRows(aggregateHistory(events, emptyAggregate()));
  const {start} = h.hub.startImport();
  h.hub.importHistory(rows, 0, 1, undefined, start);
  expect(h.hub.memory(track.id).plays).toBe(4);
  const view = h.hub.selectionView();
  h.hub.applySelection({baseRevision: view.revision, dataset: view.dataset.key, enabled: false, rules: []});
  return {h, track};
}
async function ratedFixture() {
  const h = await onboarded({tracks: 10});
  const id = [...h.fake.tracks.keys()][0]!;
  const actionId = 'rollback-probe-action-0001';
  const result = await h.hub.rateFromHistory({actionId, trackId: id, value: 1, basis: 0});
  expect(result.kind).toBe('done');
  expect(storedThumb(h, id)).toBe(1);
  return {h, id, actionId};
}

it('STORAGE: opening the schema-8 synthetic store with 8d code does not delete rows or lower schema version', async () => {
  const {h, track} = await importedAndDisabled();
  const before = snapshot(h);
  expect(schema(h)).toBe('8');
  const old = new OldHub(dependencies(h) as never);
  console.log('old-open', JSON.stringify({schema: schema(h), oldEffectivePlays: old.memory(track.id).plays}));
  expect(snapshot(h)).toBe(before);
  expect(schema(h)).toBe('8');
});

it('CONTROL: current code preserves disabled imported influence after reopening', async () => {
  const {h, track} = await importedAndDisabled();
  const current = new NewHub(dependencies(h));
  expect(current.memory(track.id).plays).toBe(0);
  expect(current.selectionView().selection.enabled).toBe(false);
});

it('ROLLBACK REQUIREMENT: old 8d code must preserve the disabled import influence (expected to expose unsupported semantics)', async () => {
  const {h, track} = await importedAndDisabled();
  const old = new OldHub(dependencies(h) as never);
  const actual = old.memory(track.id).plays;
  console.log('rollback-import-influence', JSON.stringify({expected: 0, actual, storedSelection: h.sql.first("SELECT v FROM kv WHERE k='history_selection'")}));
  expect(actual).toBe(0);
});

it('CONTROL: current legacy-thumb path fences an earlier history receipt and preserves the later rating', async () => {
  const {h, id, actionId} = await ratedFixture();
  await h.hub.thumb(id, -1);
  const current = new NewHub(dependencies(h));
  const undo = await current.undoHistoryRating(actionId);
  expect(undo.receipt?.undo?.outcome).toBe('conflict');
  expect(storedThumb(h, id)).toBe(-1);
});

it('ROLLBACK-THEN-FORWARD REQUIREMENT: a later 8d thumb must not be overwritten by an old receipt after returning to current code', async () => {
  const {h, id, actionId} = await ratedFixture();
  const old = new OldHub(dependencies(h) as never);
  await old.thumb(id, -1);
  expect(storedThumb(h, id)).toBe(-1);
  const current = new NewHub(dependencies(h));
  const undo = await current.undoHistoryRating(actionId);
  const after = storedThumb(h, id);
  console.log('rollback-forward-rating', JSON.stringify({expected: -1, actual: after, undo: undo.receipt?.undo}));
  expect(after).toBe(-1);
  expect(undo.receipt?.undo?.outcome).toBe('conflict');
});
