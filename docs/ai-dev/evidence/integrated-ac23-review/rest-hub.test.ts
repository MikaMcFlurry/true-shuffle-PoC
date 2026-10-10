import { expect, it } from 'vitest';
import { onboarded } from './harness';
import { DAY_MS } from '../../src/core/types';
import { coolingDown } from '../../src/core/memory';
it('real Hub new native queue keeps overplayed imported song out during 90-day rest',async()=>{
 const h=await onboarded({tracks:40});
 const station=h.sql.first<{id:number}>('SELECT id FROM stations ORDER BY id LIMIT 1')!;
 const page=h.sql.first<{data:string}>("SELECT data FROM pages WHERE data <> '[]' LIMIT 1")!;
 const song=(JSON.parse(page.data) as [string][])[0]![0];
 const now=h.clock.t;
 h.hub.importHistory([[song,8,4,now-400*DAY_MS,now-40*DAY_MS,8]],0,1);
 expect(coolingDown(h.hub.memory(song),now)).toBe(true);
 const session=h.hub.newNativeQueue(station.id);
 console.log('HUB_REST',JSON.stringify({station:station.id,song,currentIndex:session.currentIndex,entryCount:session.entryIds.length}));
 const row=h.sql.first<{deck:string}>('SELECT deck FROM stations WHERE id=?',station.id)!;
 const deck=JSON.parse(row.deck);
 expect(deck.items.some((x:any)=>x.id===song)).toBe(false);
});
