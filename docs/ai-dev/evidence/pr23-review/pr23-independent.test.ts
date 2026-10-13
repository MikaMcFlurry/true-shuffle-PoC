import { it, expect } from 'vitest';
import { onboarded } from './harness';
import { RequestBudget } from '../../src/worker/spotify/client';
const sync = (h:any) => h.hub.sync(new RequestBudget(30),{force:true});
const step = (h:any,ms:number) => {h.clock.t+=ms;h.fake.advance(ms);};
it('independent: returning to a retained old playlist occurrence must not borrow replacement-deck lane',async()=>{
 const h=await onboarded({tracks:200,durationMs:180000});const sid=h.stationIds[0]!;
 await h.hub.play(sid);step(h,10000);await sync(h);
 const id=h.fake.current()!;const u=h.fake.user();const retained={...u.player,order:[...u.player.order]};
 const deck=JSON.parse(h.sql.first<{deck:string}>('SELECT deck FROM stations WHERE id=?',sid)!.deck);
 const oldKind=deck.items.find((x:any)=>x.id===id).kind;const newKind=oldKind==='favorite'?'fresh':'favorite';
 // Controlled replacement fixture: published deck source differs, Spotify still retains old queue.
 h.clock.t+=60000;deck.writtenAt=h.clock.t;deck.items=deck.items.map((x:any)=>x.id===id?{...x,kind:newKind}:x);
 h.sql.run('UPDATE stations SET deck=? WHERE id=?',JSON.stringify(deck),sid);
 const external=[...h.fake.tracks.keys()].find(x=>x!==id)!;
 h.fake.playSong('mika',external);step(h,10000);await sync(h);
 Object.assign(u.player,retained);step(h,10000);await sync(h);
 step(h,160000);await sync(h);
 const row=h.hub.history(20).find((x:any)=>x.id===id)!;
 console.log(JSON.stringify({id,oldKind,newKind,actual:row?.facts?.kind,laneNotes:h.sql.first('SELECT v FROM kv WHERE k=?','lane_notes')}));
 expect(row).toBeDefined();expect([oldKind,null]).toContain(row.facts?.kind??null);
});
it('independent: unlisted short occurrence must not donate its lane to a later unobserved repeat',async()=>{
 const h=await onboarded({tracks:200,durationMs:180000});const sid=h.stationIds[0]!;
 await h.hub.play(sid);step(h,10000);await sync(h);h.fake.skip();step(h,1000);await sync(h);
 const id=h.fake.current()!;const u=h.fake.user();const context=u.player.contextUri;
 const deck=JSON.parse(h.sql.first<{deck:string}>('SELECT deck FROM stations WHERE id=?',sid)!.deck);
 const oldKind=deck.items.find((x:any)=>x.id===id).kind;const newKind=oldKind==='favorite'?'fresh':'favorite';
 step(h,5000);h.fake.skip();step(h,1000);await sync(h); // first noted play is under30s and unlisted.
 h.clock.t+=60000;deck.writtenAt=h.clock.t;deck.items=deck.items.map((x:any)=>x.id===id?{...x,kind:newKind}:x);
 h.sql.run('UPDATE stations SET deck=? WHERE id=?',JSON.stringify(deck),sid);
 // Spotify repeats the same id from the replacement playlist entirely between app looks.
 Object.assign(u.player,{contextUri:context,order:[id],index:0,progressMs:0,listenedMs:0,isPlaying:true,currentFromQueue:null});
 step(h,45000);h.fake.skip();await sync(h);
 const row=h.hub.history(20).find((x:any)=>x.id===id)!;
 console.log(JSON.stringify({id,oldKind,newKind,actual:row?.facts?.kind}));
 expect(row).toBeDefined();expect(row.facts?.kind??null).toBeNull();
});

it('unobserved departure closes no occurrence: a short unlisted play must not label later repeated id',async()=>{
 const h=await onboarded({tracks:200,durationMs:180000}); const sid=h.stationIds[0]!; await h.hub.play(sid);step(h,10000);await sync(h);h.fake.skip();step(h,1000);await sync(h);
 const id=h.fake.current()!; const u=h.fake.user();const context=u.player.contextUri;
 const deck=JSON.parse(h.sql.first<{deck:string}>('SELECT deck FROM stations WHERE id=?',sid)!.deck);
 const oldKind=deck.items.find((x:any)=>x.id===id).kind;const newKind=oldKind==='favorite'?'fresh':'favorite';
 step(h,5000);h.fake.skip();step(h,60000); // no player look witnessed the short occurrence disappear
 deck.writtenAt=h.clock.t;deck.items=deck.items.map((x:any)=>x.id===id?{...x,kind:newKind}:x);(h.hub as any).saveDeck(sid,deck);h.restart();
 Object.assign(u.player,{contextUri:context,order:[id],index:0,progressMs:0,listenedMs:0,isPlaying:true,currentFromQueue:null});
 step(h,45000);h.fake.skip();await sync(h);
 const rows=h.hub.history(100).filter((x:any)=>x.id===id);console.log(JSON.stringify({oldKind,newKind,rows,notes:h.sql.first('SELECT v FROM kv WHERE k=?','lane_notes')}));
 expect(rows).toHaveLength(1);expect(rows[0].facts?.kind??null).toBeNull();
});

it('independent: replay ending coincidentally at predicted old completion must not borrow old lane',async()=>{
 const h=await onboarded({tracks:200,durationMs:180000}); const sid=h.stationIds[0]!; await h.hub.play(sid);step(h,10000);await sync(h);h.fake.skip();step(h,1000);await sync(h);
 const id=h.fake.current()!; const u=h.fake.user();const context=u.player.contextUri;
 const deck=JSON.parse(h.sql.first<{deck:string}>('SELECT deck FROM stations WHERE id=?',sid)!.deck);
 const oldKind=deck.items.find((x:any)=>x.id===id).kind;const newKind=oldKind==='favorite'?'fresh':'favorite';
 step(h,5000);h.fake.skip();step(h,60000); // no player look witnessed the short occurrence disappear
 deck.writtenAt=h.clock.t;deck.items=deck.items.map((x:any)=>x.id===id?{...x,kind:newKind}:x);(h.hub as any).saveDeck(sid,deck);h.restart();
 u.player.order.splice(u.player.index + 1, 0, id); h.fake.skip(); expect(h.fake.current()).toBe(id);
 console.log(JSON.stringify({stage:'before-replay',time:h.clock.t,notes:h.sql.first('SELECT v FROM kv WHERE k=?','lane_notes')}));
 const laneFor=(h.hub as any).laneFor.bind(h.hub); (h.hub as any).laneFor=(...args:any[])=>{console.log(JSON.stringify({stage:'lane-consumption',args,notes:h.sql.first('SELECT v FROM kv WHERE k=?','lane_notes')}));return laneFor(...args);};
 step(h,114000);h.fake.skip(); console.log(JSON.stringify({stage:'after-replay',time:h.clock.t,current:h.fake.current(),player:u.player,recent:u.recent})); await sync(h);
 const rows=h.hub.history(100).filter((x:any)=>x.id===id);console.log(JSON.stringify({oldKind,newKind,rows,notes:h.sql.first('SELECT v FROM kv WHERE k=?','lane_notes')}));
 expect(rows).toHaveLength(1);expect(rows[0].facts?.kind??null).toBeNull();
});
