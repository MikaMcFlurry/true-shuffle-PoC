import { expect,it } from 'vitest';
import { onboarded } from './harness';
const at=Date.parse('2025-04-01T12:00:00Z');
const row=(id:string,n:number):any=>[id,n,0,at,0,n];
it('CAS detects added individual listens, not just replacement totals, after restart',async()=>{
 const h=await onboarded({tracks:50});const t=[...h.fake.tracks.values()][0]!;
 const id=h.hub.importHistory([row(t.id,1)],0,1).upload;
 const before=h.hub.previewSelection({enabled:true,rules:[{type:'track',kind:'exclude',id:t.id}],query:{}});
 const first=h.hub.importListens({importId:id,part:0,parts:2,tracks:1,kind:'tracks',data:[[t.id,t.name,t.artistName,t.albumName]]});
 h.hub.importListens({upload:first.upload,part:1,parts:2,tracks:1,kind:'rows',data:[[at/1000,0,200000,0,0]]});
 h.restart();
 expect(h.hub.selectionView().dataset.key).not.toBe(before.dataset);
 expect(()=>h.hub.applySelection({baseRevision:before.revision,...before.selection,dataset:before.dataset})).toThrow(/seit der Vorschau geändert/);
 expect(h.hub.memory(t.id).plays).toBe(1);
 const fresh=h.hub.previewSelection({enabled:true,rules:before.selection.rules,query:{}});
 h.hub.applySelection({baseRevision:fresh.revision,...fresh.selection,dataset:fresh.dataset});
 expect(h.hub.memory(t.id).plays).toBe(0);
});
it('a foreign id with exactly the expected block position is refused without corrupting staging',async()=>{
 const h=await onboarded({tracks:50});const [a,b]=[...h.fake.tracks.values()];
 const old=h.hub.importHistory([row(a!.id,9)],0,2).upload;
 const current=h.hub.importHistory([row(b!.id,2)],0,2).upload;
 h.restart();
 const staged=JSON.stringify(h.sql.all('SELECT * FROM hist_stage ORDER BY page'));
 for(const upload of [undefined,old,'',current+'x']){
  expect(()=>h.hub.importHistory([row(a!.id,99)],1,2,upload)).toThrow(/abgelöst/);
  expect(JSON.stringify(h.sql.all('SELECT * FROM hist_stage ORDER BY page'))).toBe(staged);
 }
 h.hub.importHistory([],1,2,current);h.restart();
 expect(h.hub.memory(a!.id).plays).toBe(0);expect(h.hub.memory(b!.id).plays).toBe(2);
 expect(()=>h.hub.importHistory([row(a!.id,99)],1,2,current)).toThrow(/abgelöst/);
});
it('another listener dataset is refused; applying own data leaves that listener untouched',async()=>{
 const a=await onboarded({tracks:50});const b=await onboarded({tracks:50});const id=[...a.fake.tracks.keys()][0]!;
 a.hub.importHistory([row(id,2)],0,1);b.hub.importHistory([row(id,7)],0,1);
 const pa=a.hub.previewSelection({enabled:true,rules:[{type:'track',kind:'exclude',id}],query:{}});
 const pb=b.hub.previewSelection({enabled:true,rules:[{type:'track',kind:'exclude',id}],query:{}});
 expect(()=>b.hub.applySelection({baseRevision:0,...pb.selection,dataset:pa.dataset})).toThrow(/seit der Vorschau geändert/);
 a.hub.applySelection({baseRevision:0,...pa.selection,dataset:pa.dataset});
 expect(a.hub.memory(id).plays).toBe(0);expect(b.hub.memory(id).plays).toBe(7);
 expect(b.hub.selectionView().revision).toBe(0);
});
