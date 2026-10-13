import {it,expect} from 'vitest';
import {onboarded} from './harness';
import {RequestBudget} from '../../src/worker/spotify/client';
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
it('null guest hold survives restart but never extends from unidentified successful looks',async()=>{
 const h=await onboarded({tracks:100,durationMs:180000});const u=h.fake.user();u.devices.push({id:'party',name:'Party',type:'Speaker',restricted:false});h.hub.setGuestDevices([{id:'party',name:'Party'}]);await h.hub.play(h.stationIds[0]!);u.player.deviceId='party';step(h,10000);await sync(h);
 const until=(await h.hub.state()).guest.until;u.devices.find((x:any)=>x.id==='party')!.noId=true;h.restart();
 for(let i=0;i<3;i++){step(h,60000);await sync(h);expect((await h.hub.state()).guest.until).toBe(until);expect((await h.hub.state()).guest.active).toBe(true);}
 step(h,16*60000);await sync(h);expect((await h.hub.state()).guest.active).toBe(false);
});
it('429 player failure does not prove guest exit or extend hold; known phone afterwards ends it',async()=>{
 const h=await onboarded({tracks:100,durationMs:180000});const u=h.fake.user();const phone=u.devices[0]!.id;u.devices.push({id:'party',name:'Party',type:'Speaker',restricted:false});h.hub.setGuestDevices([{id:'party',name:'Party'}]);await h.hub.play(h.stationIds[0]!);u.player.deviceId='party';step(h,10000);await sync(h);
 const until=(await h.hub.state()).guest.until;const handle=h.fake.handle.bind(h.fake);let blocked=true;h.fake.handle=async req=>req.method==='GET'&&new URL(req.url).pathname.endsWith('/me/player')&&blocked?Response.json({error:{status:429,message:'Too many requests'}},{status:429,headers:{'Retry-After':'30'}}):handle(req);
 step(h,10000);await sync(h);expect((await h.hub.state()).guest.active).toBe(true);expect((await h.hub.state()).guest.until).toBe(until);
 blocked=false;step(h,40000);u.player.deviceId=phone;await sync(h);expect((await h.hub.state()).guest.active).toBe(false);
});
