import { it, expect } from 'vitest';
import { MINUTE_MS, type SlotKind } from '../../src/core/types';
import { onboarded } from './harness';

it.each(['playing-playing','paused-paused','paused-playing','playing-paused'])('unseen repeat plus seek spoofs lane continuity: %s', async (mode) => {
 const h = await onboarded({tracks:300,durationMs:180_000});
 const sid = h.stationIds[0]!;
 expect((await h.hub.play(sid)).ok).toBe(true);
 const p = h.fake.user().player;
 const quiet = (ms:number) => { h.clock.t += ms; h.fake.advance(ms,h.fake.user().id); };
 await h.listen(10 * MINUTE_MS);
 const x = h.fake.current()!;
 while(h.fake.current() === x) await h.listen(1_000);
 await h.hub.state({live:true,refresh:true});
 const t = h.fake.current()!;
 const notes = () => JSON.parse(h.sql.first<{v:string}>(`SELECT v FROM kv WHERE k = 'lane_notes'`)!.v) as {id:string;kind:SlotKind|null;lastAt:number;progress:number;start:number;goneAt?:number}[];
 quiet(6_000-p.progressMs); await h.hub.state({live:true,refresh:true});
 if(mode.startsWith('paused')) { quiet(1_000); p.isPlaying=false; await h.hub.state({live:true,refresh:true}); }
 const original = notes().find(n=>n.id===t)!;
 expect(original.kind).toBeTruthy();
 h.fake.skip(); p.isPlaying=true; quiet(60_000);
 const deck = JSON.parse(h.sql.first<{deck:string}>(`SELECT deck FROM stations WHERE id = ?`,sid)!.deck) as {writtenAt:number;items:{id:string;kind:SlotKind}[]};
 const other:SlotKind = original.kind === 'favorite' ? 'fresh' : 'favorite';
 deck.items = deck.items.map(it=>it.id===t?{...it,kind:other}:it); deck.writtenAt=h.clock.t;
 (h.hub as unknown as {saveDeck(id:number,d:unknown):void}).saveDeck(sid,deck);
 h.restart();
 p.order.splice(p.index+1,0,t); h.fake.skip(); quiet(40_000);
 // An ordinary unseen forward seek makes time less position identical to the old occurrence.
 p.progressMs = mode.startsWith('paused') ? original.progress : h.clock.t-original.start;
 if(mode.endsWith('paused')) p.isPlaying=false;
 await h.hub.state({live:true,refresh:true});
 console.log('spoofed old/repeat',original,notes().find(n=>n.id===t));
 quiet(1_000); h.fake.skip(); p.isPlaying=true; quiet(1_000);
 await h.hub.state({live:true,refresh:true});
 await h.listen(2*MINUTE_MS); await h.hub.state({live:true,refresh:true});
 const later=h.hub.history(200).filter(e=>e.id===t);
 expect(later.length).toBe(1);
 expect(later[0]!.facts?.kind ?? null).toBeNull();
});
