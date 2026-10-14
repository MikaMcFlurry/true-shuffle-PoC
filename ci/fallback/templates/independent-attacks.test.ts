import { expect, it } from 'vitest';
import { onboarded } from '__FALLBACK_ROOT__/source/test/hub/harness';
import { aggregateHistory, emptyAggregate, toRows } from '__FALLBACK_ROOT__/source/src/core/history';
import { addListens, finishListens, newListens } from '__FALLBACK_ROOT__/source/src/core/listens';
type H = Awaited<ReturnType<typeof onboarded>>;
function entries(h:H, year:number) {
 return [...h.fake.tracks.values()].slice(0,2).flatMap((t,k)=>[1,2].map(day=>({
  ts:`${year}-02-0${day}T12:00:00Z`,ms_played:200000,spotify_track_uri:`spotify:track:${t.id}`,
  master_metadata_track_name:t.name,master_metadata_album_artist_name:k?'Beta':'Alpha',
  reason_start:'trackdone',reason_end:'trackdone',skipped:false
 })));
}
function upload(h:H,year:number){
 const e=entries(h,year),rows=toRows(aggregateHistory(e,emptyAggregate()));
 const {start}=h.hub.startImport();
 const first=h.hub.importHistory(rows.slice(0,1),0,2,undefined,start);
 const last=h.hub.importHistory(rows.slice(1),1,2,first.upload);
 const listens=finishListens(addListens(e,newListens()),null);
 const p=h.hub.importListens({importId:last.upload,part:0,parts:2,tracks:2,kind:'tracks',data:listens.tracks});
 h.hub.importListens({upload:p.upload,part:1,parts:2,tracks:2,kind:'rows',data:listens.rows});
 return {rows,last,listens};
}
const ids=(h:H)=>[...h.fake.tracks.keys()].slice(0,2);
const plays=(h:H)=>ids(h).map(id=>h.hub.memory(id).plays);
it('reviewer: a saved period rule is recomputed for a new fallback-era dataset and remains through forward reopen',async()=>{
 const h=await onboarded({tracks:10}); upload(h,2024);
 const view=h.hub.selectionView();
 const rules=[{type:'period' as const,kind:'exclude' as const,from:'2024-02-01',to:'2024-02-02',zone:'UTC'}];
 h.hub.applySelection({baseRevision:view.revision,dataset:view.dataset.key,enabled:true,rules});
 expect(plays(h)).toEqual([0,0]); const sel=h.hub.selectionView();h.restart();
 upload(h,2023); expect(plays(h)).toEqual([2,2]);
 expect(h.hub.selectionView()).toMatchObject({revision:sel.revision,selection:sel.selection});
 h.restart();expect(plays(h)).toEqual([2,2]);expect(h.hub.selectionView().selection.rules).toEqual(rules);
});
it('reviewer: deletion fences delayed begin/totals/plays, while a deliberate new fallback import keeps the switch and explicit rating',async()=>{
 const h=await onboarded({tracks:10});const old=upload(h,2024);const v=h.hub.selectionView();
 h.hub.applySelection({baseRevision:v.revision,dataset:v.dataset.key,enabled:false,rules:[]});
 await h.hub.thumb(ids(h)[0]!,1);const {start}=h.hub.startImport();
 const partial=h.hub.importHistory(old.rows.slice(0,1),0,2,undefined,start);
 h.hub.deleteImport(h.hub.selectionView().dataset.key);h.restart();
 expect(()=>h.hub.importHistory(old.rows,0,1,undefined,start)).toThrow();
 expect(()=>h.hub.importHistory(old.rows.slice(1),1,2,partial.upload)).toThrow();
 expect(()=>h.hub.importListens({importId:old.last.upload,part:0,parts:2,tracks:2,kind:'tracks',data:old.listens.tracks})).toThrow();
 expect(h.hub.selectionView().dataset.hasImport).toBe(false);
 upload(h,2023);h.restart();expect(plays(h)).toEqual([0,0]);
 expect(h.hub.selectionView().selection.enabled).toBe(false);
 expect(h.hub.memory(ids(h)[0]!).thumb).toBe(1);
});
it('reviewer: upload tokens, dataset keys and rating receipts cannot cross a second listener store',async()=>{
 const a=await onboarded({tracks:10}),b=await onboarded({tracks:10});const first=upload(a,2024);upload(b,2023);
 const bv=b.hub.selectionView(),before=plays(b),id=ids(a)[0]!,actionId='reviewer-shared-action-0001';
 const rated=await a.hub.rateFromHistory({actionId,trackId:id,value:1,basis:0});expect(rated.kind).toBe('done');
 expect(b.hub.historyRatingReceipt(actionId,id).receipt).toBeNull();expect((await b.hub.undoHistoryRating(actionId)).receipt).toBeNull();
 expect(()=>b.hub.deleteImport(a.hub.selectionView().dataset.key)).toThrow();
 expect(()=>b.hub.importListens({importId:first.last.upload,part:0,parts:2,tracks:2,kind:'tracks',data:first.listens.tracks})).toThrow();
 const ar=a.hub.importHistory(first.rows.slice(0,1),0,2,undefined,a.hub.startImport().start);
 expect(()=>b.hub.importHistory(first.rows.slice(1),1,2,ar.upload)).toThrow();
 await a.hub.thumb(id,-1);a.restart();b.restart();expect((await a.hub.undoHistoryRating(actionId)).receipt?.undo?.outcome).toBe('conflict');
 expect(b.hub.memory(id).thumb).toBe(0);expect(plays(b)).toEqual(before);expect(b.hub.selectionView()).toMatchObject({revision:bv.revision,dataset:bv.dataset});
});
