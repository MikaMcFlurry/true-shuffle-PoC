import {it,expect} from 'vitest';
import {onboarded} from '/workspace/ts-pr23-auth-baseline/test/hub/harness';
import {HubCore as OldHub} from '/workspace/ts-review-4b0a/src/worker/hub/hub';
import {HubCore as NewHub} from '/workspace/ts-pr23-auth-baseline/src/worker/hub/hub';
const good=()=>({at:0,from:1600000000000,to:1700000000000,plays:10,minutes:300,songs:5,artists:1,earlySkips:0,hourWeek:Array(168).fill(0),months:[],topArtists:[{name:'Glasfabrik',plays:10,minutes:300}],topSongs:[]});
it('old e348 HubCore opens populated bcb schema5 without migration downgrade, preserves additions and reopens forward',async()=>{
 const h=await onboarded({tracks:200,liked:10}); const newer=h.hub; const deps=(newer as any).d;
 newer.setGuestDevices([{id:'party-fixture',name:'Party'}]);newer.setImportedProfile(good());newer.prepareGenres();
 await newer.play(h.stationIds[0]!);await h.listen(240000);await newer.state({live:true,refresh:true});await newer.playerAction('pause');
 const queue=newer.savedSession()!;expect(queue.progressMs).toBeGreaterThan(0);
 // Preserve real lane rows already observed, plus additive metadata on an existing row.
 h.sql.run('UPDATE plays SET lane = ?', 'favorite');expect(h.sql.first<{n:number}>('SELECT count(*) n FROM plays')!.n).toBeGreaterThan(0);
 const watched=['schema_version','guest_devices','history_profile','genre_attempt','lane_notes'];
 const additions=()=>watched.map(k=>[k,h.sql.first<{v:string}>('SELECT v FROM kv WHERE k=?',k)?.v]);
 const before=additions();expect(before.find(([k])=>k==='schema_version')?.[1]).toBe('5');
 const plays=h.sql.all('SELECT * FROM plays ORDER BY played_at,track_id'); const sessions=h.sql.all('SELECT * FROM playback_sessions ORDER BY station_id');
 const old=new OldHub(deps);expect(additions()).toEqual(before);expect(h.sql.all('SELECT * FROM plays ORDER BY played_at,track_id')).toEqual(plays);expect(h.sql.all('SELECT * FROM playback_sessions ORDER BY station_id')).toEqual(sessions);
 expect(old.savedSession()).toEqual(queue);expect(old.history(1000).length).toBe(plays.length);
 const state=await old.state({live:false});expect(state.profile.id).toBe('mika');
 expect(old.savedSession()!.sessionId).toBe(queue.sessionId);expect(old.savedSession()!.entryIds).toEqual(queue.entryIds);expect(additions()).toEqual(before);
 const resumed=await old.play(h.stationIds[0]!);expect(resumed.ok).toBe(true);
 const after=old.savedSession()!;expect(after.sessionId).toBe(queue.sessionId);expect(after.entryIds).toEqual(queue.entryIds);expect(after.currentIndex).toBe(queue.currentIndex);expect(after.progressMs).toBe(queue.progressMs);
 expect(h.fake.user().player.progressMs).toBe(queue.progressMs);expect(h.sql.all('SELECT * FROM plays ORDER BY played_at,track_id')).toEqual(plays);expect(additions()).toEqual(before);
 await old.playerAction('pause');const paused=old.savedSession()!;
 const forward=new NewHub(deps);expect(forward.savedSession()).toEqual(paused);expect(forward.listeningProfile('UTC').imported?.plays).toBe(10);expect(additions()).toEqual(before);expect(h.sql.all('SELECT * FROM plays ORDER BY played_at,track_id')).toEqual(plays);
});
it('rolled back source can record additional real FakeSpotify plays in schema5 without dropping existing lanes or likes/bans',async()=>{
 const h=await onboarded({tracks:100,liked:10});const newer=h.hub;const deps=(newer as any).d;
 const sid=h.stationIds[0]!;await newer.play(sid);await h.listen(240000);
 const existing=h.sql.all('SELECT * FROM plays ORDER BY played_at,track_id');expect(existing.length).toBeGreaterThan(0);
 const favorite=h.hub.sessionView(sid)!.queue[4]!.track.id;await newer.thumb(favorite,1);
 const banned=h.hub.sessionView(sid)!.queue[5]!.track.id;await newer.thumb(banned,-1);
 const memories=h.sql.all('SELECT * FROM memory WHERE thumb<>0 ORDER BY id');
 const bans=h.sql.all('SELECT * FROM bans ORDER BY station_id,track_id');
 const old=new OldHub(deps);h.hub=old as any;await h.listen(240000);await old.state({live:true,refresh:true});
 const all=h.sql.all<{lane:string|null;played_at:number;track_id:string}>('SELECT * FROM plays ORDER BY played_at,track_id');expect(all.length).toBeGreaterThan(existing.length);
 for(const row of existing){expect(all.find(x=>x.played_at===(row as any).played_at&&x.track_id===(row as any).track_id)).toEqual(row);}
 for(const row of all.filter(x=>!existing.some(y=>(y as any).played_at===x.played_at&&(y as any).track_id===x.track_id)))expect(row.lane).toBeNull();
 expect(h.sql.all('SELECT * FROM memory WHERE thumb<>0 ORDER BY id').map((x:any)=>[x.id,x.thumb])).toEqual(memories.map((x:any)=>[x.id,x.thumb]));expect(h.sql.all('SELECT * FROM bans ORDER BY station_id,track_id')).toEqual(bans);
 expect(h.sql.first<{v:string}>('SELECT v FROM kv WHERE k=?','schema_version')!.v).toBe('5');
 const forward=new NewHub(deps);expect(forward.history(1000).length).toBe(all.length);
});
