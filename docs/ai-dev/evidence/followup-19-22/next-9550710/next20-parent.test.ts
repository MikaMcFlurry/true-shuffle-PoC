import {it,expect} from '/workspace/ts-review-next1922/node_modules/vitest/dist/index.js';
import {onboarded} from '/workspace/ts-review-next1922/test/hub/harness.ts';
import {RequestBudget} from '/workspace/ts-review-next1922/src/worker/spotify/client.ts';
const sync=(h:any)=>h.hub.sync(new RequestBudget(30),{force:true});
const step=(h:any,ms:number)=>{h.clock.t+=ms;h.fake.advance(ms);};
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
