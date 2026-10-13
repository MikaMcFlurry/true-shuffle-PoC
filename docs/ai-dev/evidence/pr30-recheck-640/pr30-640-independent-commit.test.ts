import { expect,it } from 'vitest';
import { onboarded } from './harness';
const at=Date.parse('2025-04-01T12:00:00Z');
const row=(id:string,n:number):any=>[id,n,0,at,0,n];
const profile={from:0,to:0,plays:0,minutes:0,songs:0,artists:0,earlySkips:0,hourWeek:Array(168).fill(0),months:[],topArtists:[],topSongs:[]};
it('one frozen-clock listener orders stored changes, while staging/noops/errors cannot create commits',async()=>{
 const h=await onboarded({tracks:50});const t=[...h.fake.tracks.values()][0]!;
 const v=()=>h.hub.selectionView();expect(v().commit).toBe(0);
 const u=h.hub.importHistory([row(t.id,2)],0,2);expect(v().commit).toBe(0);
 expect(()=>h.hub.importHistory([],1,2,'other')).toThrow();expect(v().commit).toBe(0);
 h.hub.importHistory([],1,2,u.upload);expect(v().commit).toBe(1);
 const p=h.hub.previewSelection({enabled:true,rules:[{type:'track',kind:'exclude',id:t.id}],query:{}});
 const current=h.hub.applySelection({baseRevision:p.revision,...p.selection,dataset:p.dataset});expect(current.commit).toBe(2);
 expect(h.hub.applySelection({baseRevision:0,...p.selection,dataset:p.dataset}).commit).toBe(2);
 expect(()=>h.hub.applySelection({baseRevision:0,enabled:false,rules:[],dataset:p.dataset})).toThrow();expect(v().commit).toBe(2);
 const deleted=h.hub.deleteImport(v().dataset.key);expect(deleted.commit).toBe(3);expect(v().commit).toBe(3);
 h.restart();expect(v().commit).toBe(3);expect(v().revision).toBe(1);
 h.hub.importHistory([row(t.id,5)],0,1,undefined,h.hub.startImport().start);expect(v().commit).toBe(4);expect(v().revision).toBe(1);
});
it('individual listen publication is one later commit, never a staged block; restart retains it',async()=>{
 const h=await onboarded({tracks:50});const t=[...h.fake.tracks.values()][0]!;
 const id=h.hub.importHistory([row(t.id,1)],0,1).upload;const v=h.hub.selectionView();
 const first=h.hub.importListens({importId:id,part:0,parts:2,tracks:1,kind:'tracks',data:[[t.id,t.name,t.artistName,t.albumName]]});
 expect(h.hub.selectionView().commit).toBe(v.commit);h.restart();
 h.hub.importListens({upload:first.upload,part:1,parts:2,tracks:1,kind:'rows',data:[[at/1000,0,200000,0,0]]});
 expect(h.hub.selectionView().commit).toBe(v.commit+1);h.restart();expect(h.hub.selectionView().commit).toBe(v.commit+1);
});
it('a rolled-back totals promotion cannot advance commit or replace stored data',async()=>{
 const h=await onboarded({tracks:50});const t=[...h.fake.tracks.values()][0]!;
 h.hub.importHistory([row(t.id,2)],0,1);const before=h.hub.selectionView();
 const run=h.sql.run.bind(h.sql);h.sql.run=(q,...args)=>{if(q.startsWith('UPDATE stations SET deck_dirty'))throw Error('injected write failure');return run(q,...args);};
 expect(()=>h.hub.importHistory([row(t.id,99)],0,1)).toThrow(/injected/);h.sql.run=run;h.restart();
 expect(h.hub.selectionView()).toMatchObject({commit:before.commit,dataset:{key:before.dataset.key}});expect(h.hub.memory(t.id).plays).toBe(2);
});
it('first summary advances only its own listener and deletion removes it with a later commit',async()=>{
 const a=await onboarded({tracks:50});const b=await onboarded({tracks:50});const id=[...a.fake.tracks.keys()][0]!;
 a.hub.importHistory([row(id,1)],0,1);b.hub.importHistory([row(id,1)],0,1);
 const old=a.hub.selectionView();const other=b.hub.selectionView();a.hub.setImportedProfile(profile);
 expect(a.hub.selectionView().commit).toBe(old.commit+1);expect(b.hub.selectionView()).toEqual(other);
 a.hub.setImportedProfile({...profile,plays:5});expect(a.hub.selectionView().commit).toBe(old.commit+1);
 a.restart();expect(a.hub.selectionView().commit).toBe(old.commit+1);
 expect(a.hub.deleteImport(a.hub.selectionView().dataset.key).commit).toBe(old.commit+2);
 expect(()=>a.hub.setImportedProfile(profile)).toThrow();expect(a.hub.selectionView().commit).toBe(old.commit+2);
});
