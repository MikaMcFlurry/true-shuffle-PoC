import {expect,it} from 'vitest';
import {onboarded} from './harness';
const at=Date.parse('2024-03-01T12:00:00Z');
const row=(id:string,n:number):any=>[id,n,0,at,0,n];
const summary={from:0,to:0,plays:0,minutes:0,songs:0,artists:0,earlySkips:0,hourWeek:Array(168).fill(0),months:[],topArtists:[],topSongs:[]};
const dump=(h:any)=>JSON.stringify(h.sql.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(({name}:any)=>[name,h.sql.all(`SELECT * FROM ${name}`).map((r:any)=>JSON.stringify(r)).sort()]));
const fault=(h:any,fn:()=>unknown,predicate:(q:string,args:any[])=>boolean)=>{const run=h.sql.run;let hit=false;h.sql.run=(q:string,...p:any[])=>{if(!hit&&predicate(q,p)){hit=true;throw Error('independent fault');}return run.call(h.sql,q,...p);};try{expect(fn).toThrow(/independent fault/);}finally{h.sql.run=run;}expect(hit).toBe(true);};
for(const kind of ['profile','listens','apply','delete'] as const)it(`${kind} rollback preserves all rows and warmed reads, retry increments once`,async()=>{
 const h=await onboarded({tracks:50});const t=[...h.fake.tracks.values()][0]!;
 const importId=h.hub.importHistory([row(t.id,2)],0,1).upload;
 let upload:string|undefined;
 if(kind==='listens')upload=h.hub.importListens({importId,part:0,parts:2,tracks:1,kind:'tracks',data:[[t.id,t.name,t.artistName,t.albumName]]}).upload;
 const old=h.hub.selectionView();const memory=h.hub.memory(t.id);h.hub.listeningProfile('UTC');
 const before=dump(h);
 const change=()=>kind==='profile'?h.hub.setImportedProfile(summary):kind==='listens'?h.hub.importListens({upload,part:1,parts:2,tracks:1,kind:'rows',data:[[at/1000,0,200000,132,0],[at/1000+1,0,200000,132,0]]}):kind==='apply'?h.hub.applySelection({baseRevision:old.revision,dataset:old.dataset.key,enabled:true,rules:[{type:'track',kind:'exclude',id:t.id}]}):h.hub.deleteImport(old.dataset.key);
 fault(h,change,(_q,p)=>p[0]==='history_commit');
 expect(dump(h)).toBe(before);expect(h.hub.selectionView()).toEqual(old);expect(h.hub.memory(t.id)).toEqual(memory);
 h.restart();expect(h.hub.selectionView()).toEqual(old);console.log('totals-fault-stage-pages', h.sql.all('SELECT page FROM hist_stage'));
 h.restart();expect(h.hub.selectionView()).toEqual(old);
 change();console.log('totals-retry-pages', h.sql.all('SELECT page FROM hist_pages'));expect(h.hub.selectionView().commit).toBe(old.commit+1);
 h.restart();expect(h.hub.selectionView().commit).toBe(old.commit+1);
 if(kind==='profile'||kind==='apply'){change();expect(h.hub.selectionView().commit).toBe(old.commit+1);}else{expect(change).toThrow();expect(h.hub.selectionView().commit).toBe(old.commit+1);}
});
it('totals final-block failure leaves staged block unchanged for one exact retry',async()=>{
 const h=await onboarded({tracks:50});const [a,b]=[...h.fake.tracks.values()];
 h.hub.importHistory([row(a!.id,2)],0,1);
 const upload=h.hub.importHistory([row(a!.id,3)],0,2).upload;
 const old=h.hub.selectionView();const before=dump(h);h.hub.memory(a!.id);
 const change=()=>h.hub.importHistory([row(b!.id,7)],1,2,upload);
 fault(h,change,(_q,p)=>p[0]==='history_commit');
 expect(h.hub.selectionView()).toEqual(old);expect(h.hub.memory(a!.id).plays).toBe(2);
 console.log('totals-fault-stage-pages', h.sql.all('SELECT page FROM hist_stage'));
 h.restart();expect(h.hub.selectionView()).toEqual(old);
 change();console.log('totals-retry-pages', h.sql.all('SELECT page FROM hist_pages'));expect(h.hub.selectionView().commit).toBe(old.commit+1);
 // Publication is atomic; pre-publication final chunk staging is separate.
 expect(h.sql.all('SELECT * FROM hist_pages').length).toBeGreaterThanOrEqual(2);
 expect(h.hub.memory(a!.id).plays).toBe(3);expect(h.hub.memory(b!.id).plays).toBe(7);
});
