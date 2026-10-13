import { expect, it } from 'vitest';
import { mergeMemory, coolingDown, isOverplayed } from '../../src/core/memory';
import { emptyMemory, DAY_MS, DEFAULT_RULES } from '../../src/core/types';
import { planQueue } from '../../src/core/planner';
import { seededRng } from '../../src/core/random';
const now=Date.UTC(2026,8,25), id='o'.repeat(22);
it('overplayed song must rest for 90 days even when a new deck has room',()=>{
 const m=mergeMemory(emptyMemory(id), {plays:8,earlySkips:4,lastPlayedAt:now-200*DAY_MS,lastSkippedAt:now-40*DAY_MS,playedBeforeSkips:8});
 expect(isOverplayed(m)).toBe(true); expect(coolingDown(m,now)).toBe(true);
 const result=planQueue({now,roundStartedAt:now-30*DAY_MS,rules:DEFAULT_RULES,pool:[{id,artistId:'o'},{id:'n'.repeat(22),artistId:'n'}],memory:(t)=>t===id?m:emptyMemory(t),banned:new Set(), discoveries:[],size:200,rng:seededRng(7)});
 console.log('OVERPLAYED_COOLING',JSON.stringify(result));
 expect(result.slots.some(s=>s.trackId===id)).toBe(false);
});
