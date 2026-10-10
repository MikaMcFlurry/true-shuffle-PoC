import {expect,it} from '/workspace/ts-review-next1922/node_modules/vitest/dist/index.js';
import {onboarded} from '/workspace/ts-review-next1922/test/hub/harness.ts';
import {RequestBudget} from '/workspace/ts-review-next1922/src/worker/spotify/client.ts';
const observe=(h:any)=>h.hub.sync(new RequestBudget(25),{force:true});
const ids=(h:any,id:number)=>JSON.parse(h.sql.first('SELECT deck FROM stations WHERE id = ?',id).deck).items.map((x:any)=>x.id);
const save=(h:any,id:number,s:any)=>h.sql.run('UPDATE playback_sessions SET data = ? WHERE station_id = ?',JSON.stringify(s),id);
const history=(h:any,id:number,index:number)=>{const s=h.hub.savedSession(id);const t=ids(h,id)[index];h.sql.run('INSERT INTO plays (played_at,track_id,context_uri,station_id,ignored,meta) VALUES (?,?,?,?,0,NULL)',h.clock.t,t,s.contextUri,id);};
it.each([null,177000])('retains current unfinished occurrence with saved progress %s',async(progress)=>{
 const h=await onboarded({tracks:200,durationMs:180000});const id=h.stationIds[0]!;await h.hub.play(id);await h.hub.playerAction('pause');
 const s=h.hub.savedSession(id)!;save(h,id,{...s,progressMs:progress});history(h,id,0);h.fake.user().player.contextUri='spotify:playlist:other';
 expect(await h.hub.play(id)).toMatchObject({ok:true});
 console.log('REPRO progress',progress,'index',h.hub.savedSession(id)!.currentIndex,'actual',h.fake.current(),'expected',ids(h,id)[0]);
 expect(h.hub.savedSession(id)!.currentIndex).toBe(0);expect(h.fake.current()).toBe(ids(h,id)[0]);
});
it('refused resume retains candidate checkpoint when history suggests advance',async()=>{
 const h=await onboarded({tracks:200,durationMs:180000});const id=h.stationIds[0]!;await h.hub.play(id);await h.hub.playerAction('pause');const s=h.hub.savedSession(id)!;
 save(h,id,{...s,currentIndex:0,progressMs:23000});history(h,id,3);h.fake.user().player.contextUri='spotify:playlist:other';
 const handle=h.fake.handle.bind(h.fake);h.fake.handle=async req=>req.method==='PUT'&&new URL(req.url).pathname==='/v1/me/player/play'?new Response(JSON.stringify({error:{status:403,reason:'PREMIUM_REQUIRED',message:'premium'}}),{status:403}):handle(req);
 expect(await h.hub.play(id,'mika-phone')).toMatchObject({ok:false,error:{code:'premium'}});
 console.log('REPRO refused',h.hub.savedSession(id));expect(h.hub.savedSession(id)).toMatchObject({currentIndex:0,progressMs:23000});
});
it('a separate repeat within ten minutes is counted separately after seen first occurrence',async()=>{
 const h=await onboarded({tracks:200,durationMs:180000});const id=h.stationIds[0]!;await h.hub.play(id);await h.hub.playerAction('pause');const s=h.hub.savedSession(id)!;const t=ids(h,id)[120];
 // Use actual packed track metadata from source cache via lookupTracks.
 const hub:any=h.hub;const track=hub.lookupTracks([t],hub.usedSources()).get(t);const at=h.clock.t;
 expect(hub.recordSeenPlay({id:t,at,start:at-180000,end:at,contextUri:s.contextUri,track})).not.toBeNull();
 h.clock.t+=4*60000;h.fake.user().recent.unshift({trackId:t,playedAt:h.clock.t,contextUri:'spotify:playlist:different'});await observe(h);
 const n=h.sql.first('SELECT COUNT(*) AS n FROM plays WHERE track_id = ?',t).n;console.log('REPRO repeat',n);expect(n).toBe(2);
});

it('real paused 177s unfinished song is not skipped by recent partial listing',async()=>{
 const h=await onboarded({tracks:200,durationMs:180000});const id=h.stationIds[0]!;await h.hub.play(id);h.fake.user().player.progressMs=177000;await observe(h);await h.hub.playerAction('pause');const before=h.hub.savedSession(id)!;const t=ids(h,id)[before.currentIndex];
 h.fake.user().recent.unshift({trackId:t,playedAt:h.clock.t,contextUri:before.contextUri});await observe(h);
 expect(h.hub.savedSession(id)!.progressMs).toBe(177000);expect(await h.hub.play(id)).toMatchObject({ok:true});
 console.log('REPRO actual paused end',before.currentIndex,h.hub.savedSession(id)!.currentIndex,h.fake.current(),t);expect(h.fake.current()).toBe(t);expect(h.fake.user().player.progressMs).toBe(177000);
});
it('partial later track does not prove skipped intervening occurrences completed',async()=>{
 const h=await onboarded({tracks:200,durationMs:180000});const id=h.stationIds[0]!;await h.hub.play(id);h.fake.user().player.progressMs=42000;await observe(h);await h.hub.playerAction('pause');const before=h.hub.savedSession(id)!;const t=ids(h,id)[3];
 h.fake.user().recent.unshift({trackId:t,playedAt:h.clock.t,contextUri:before.contextUri});h.fake.user().player.contextUri='spotify:playlist:other';await observe(h);
 expect(await h.hub.play(id)).toMatchObject({ok:true});console.log('REPRO future partial',h.hub.savedSession(id)!.currentIndex);expect(h.hub.savedSession(id)!.currentIndex).toBe(before.currentIndex);
});
