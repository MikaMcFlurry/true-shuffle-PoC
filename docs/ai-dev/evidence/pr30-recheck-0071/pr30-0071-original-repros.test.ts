import { expect,it } from 'vitest';
import { onboarded } from './harness';
const row = (id:string,n:number): any => [id,n,0,Date.parse('2025-04-01T12:00:00Z'),0,n];
const oldRows:any[] = [[Date.parse('2024-03-01T12:00:00Z')/1000,0,200000,0,0],[Date.parse('2025-03-01T12:00:00Z')/1000,0,200000,0,0]];
const rule:any = {type:'period',kind:'exclude',from:'2024-01-01',to:'2024-12-31',zone:'UTC'};
it('new totals must not use old listens as their own selection evidence',async()=>{
 const h=await onboarded({tracks:50}); const t=[...h.fake.tracks.values()][0]!;
 const old=h.hub.importHistory([row(t.id,2)],0,1).upload;
 const u=h.hub.importListens({importId:old,part:0,parts:2,tracks:1,kind:'tracks',data:[[t.id,t.name,t.artistName,t.albumName]]}).upload;
 h.hub.importListens({upload:u,part:1,parts:2,tracks:1,kind:'rows',data:oldRows});
 h.hub.importHistory([row(t.id,10)],0,1);
 h.hub.applySelection({baseRevision:0,enabled:true,rules:[rule],dataset:h.hub.selectionView().dataset.key});
 console.log('OLD_EVENTS_NEW_TOTALS',h.hub.memory(t.id).plays,h.hub.selectionView().dataset);
 expect(h.hub.memory(t.id).plays).toBe(10);
});
it('new totals supersede the older in-flight event upload',async()=>{
 const h=await onboarded({tracks:50}); const t=[...h.fake.tracks.values()][0]!;
 const old=h.hub.importHistory([row(t.id,2)],0,1).upload;
 const u=h.hub.importListens({importId:old,part:0,parts:2,tracks:1,kind:'tracks',data:[[t.id,t.name,t.artistName,t.albumName]]}).upload;
 const newer=h.hub.importHistory([row(t.id,10)],0,1).upload;
 console.log('UPLOAD_IDENTITIES_DIFFER',old!==newer);
 expect(()=>h.hub.importListens({upload:u,importId:old,part:1,parts:2,tracks:1,kind:'rows',data:oldRows})).toThrow();
});
it('legacy first listens block cannot recreate a deleted import',async()=>{
 const h=await onboarded({tracks:50}); const t=[...h.fake.tracks.values()][0]!;
 h.hub.importHistory([row(t.id,2)],0,1);
 h.hub.deleteImport(h.hub.selectionView().dataset.key);
 expect(()=>h.hub.importListens({part:0,parts:2,tracks:1,kind:'tracks',data:[[t.id,t.name,t.artistName,t.albumName]]})).toThrow();
 console.log('RESURRECTED',h.hub.selectionView().dataset);
 expect(h.hub.selectionView().dataset.hasImport).toBe(false);
});
