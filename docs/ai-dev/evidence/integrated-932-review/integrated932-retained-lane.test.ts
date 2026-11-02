import { it, expect } from '/workspace/ts-integrated932-lane/node_modules/vitest/dist/index.js';
import { onboarded } from '/workspace/ts-integrated932-lane/test/hub/harness.ts';
import { RequestBudget } from '/workspace/ts-integrated932-lane/src/worker/spotify/client';
const sync = (h:any) => h.hub.sync(new RequestBudget(30),{force:true});
const step = (h:any,ms:number) => {h.clock.t+=ms;h.fake.advance(ms);};
it.each(['changed','absent','multiple'])('LANE-07: returning to retained queue after %s replacement must not borrow new deck reason',async(mode)=>{
 const h=await onboarded({tracks:200,durationMs:180000});const sid=h.stationIds[0]!;
 await h.hub.play(sid);step(h,10000);await sync(h);
 const id=h.fake.current()!;const u=h.fake.user();const retained={...u.player,order:[...u.player.order]};
 const deck=JSON.parse(h.sql.first<{deck:string}>('SELECT deck FROM stations WHERE id=?',sid)!.deck);
 const oldKind=deck.items.find((x:any)=>x.id===id).kind;const newKind=oldKind==='favorite'?'fresh':'favorite';
 // Controlled replacement fixture: published deck source differs, Spotify still retains old queue.
 h.clock.t+=60000;deck.writtenAt=h.clock.t;deck.items=deck.items.map((x:any)=>x.id===id?{...x,kind:newKind}:x); if(mode==='absent') deck.items=deck.items.filter((x:any)=>x.id!==id); if(mode==='multiple') deck.items.push({id,kind:oldKind});
 (h.hub as any).saveDeck(sid,deck);
 const external=[...h.fake.tracks.keys()].find(x=>x!==id)!;
 h.fake.playSong('mika',external);step(h,10000);await sync(h);
 Object.assign(u.player,retained);step(h,10000);await sync(h);
 step(h,160000);await sync(h);
 const row=h.hub.history(20).find((x:any)=>x.id===id)!;
 console.log(JSON.stringify({id,oldKind,newKind,actual:row?.facts?.kind,laneNotes:h.sql.first('SELECT v FROM kv WHERE k=?','lane_notes')}));
 expect(row).toBeDefined();expect([oldKind,null]).toContain(row.facts?.kind??null);
});
