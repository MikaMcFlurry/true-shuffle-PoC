import { expect, it } from 'vitest';
import { aggregateHistory, emptyAggregate, toRows } from '../../src/core/history';
import { addListens, newListens, finishListens } from '../../src/core/listens';
import { mergeMemory, skipsWeigh, tasteWeight, withEarlySkip, withPlay, retestAfter, coolingDown, isBlocked } from '../../src/core/memory';
import { emptyMemory, DAY_MS } from '../../src/core/types';
import { onboarded } from './harness';

const p = 'p'.repeat(22), s = 's'.repeat(22);
const base = Date.parse('2026-09-25T01:59:54Z');
function play(at: number) { return { ts: new Date(at).toISOString(), ms_played: 180000, spotify_track_uri: `spotify:track:${p}` }; }
function skip(at: number) { return { ts: new Date(at).toISOString(), ms_played: 3000, spotify_track_uri: `spotify:track:${s}`, reason_start:'trackdone', reason_end:'fwdbtn' }; }
async function profile(entries: any[]) {
 const h = await onboarded({tracks:40});
 const aggregate = aggregateHistory(entries);
 h.hub.importHistory(toRows(aggregate),0,1);
 const data=finishListens(addListens(entries,newListens()));
 const u=h.hub.importListens({part:0,parts:2,tracks:data.tracks.length,kind:'tracks',data:data.tracks});
 h.hub.importListens({upload:u.upload,part:1,parts:2,tracks:data.tracks.length,kind:'rows',data:data.rows});
 return {aggregate, memory:h.hub.memory(s), now:h.clock.t, profile:h.hub.listeningProfile('UTC')};
}
it('podcast directly before skipped song must have same opener classification for memory and profile', async()=>{
 const entries=[play(base),{ts:new Date(base+3600000).toISOString(),ms_played:3500000,spotify_track_uri:null},skip(base+3603000)];
 const r=await profile(entries);
 expect(r.aggregate.skipped).toBe(1);
 expect(r.aggregate.openers).toBe(0);
 expect(skipsWeigh(r.memory,r.now)).toBe(true);
 expect(tasteWeight(r.memory,'later_less',r.now)).toBe(0.5);
 console.log('PODCAST_CLASSIFICATION',JSON.stringify({aggregate:{skipped:r.aggregate.skipped,openers:r.aggregate.openers},profile:r.profile.skips,weight:tasteWeight(r.memory,'later_less',r.now)}));
 expect(r.profile.skips?.early).toBe(r.aggregate.skipped);
 expect(r.profile.skips?.openers).toBe(r.aggregate.openers);
});
it('intentional first-file-unknown rule gives different multi-file stats; record but not defect', async()=>{
 const aggregate=emptyAggregate();
 aggregateHistory([play(base)],aggregate);
 aggregateHistory([skip(base+3000)],aggregate);
 const r=await profile([play(base),skip(base+3000)]);
 expect(aggregate.openers).toBe(1);
 expect(r.profile.skips?.openers).toBe(0);
 expect(r.profile.skips?.early).toBe(1);
});
it('dated skipped memory precedence, reset, cooldown, bans and old-row semantics',()=>{
 let m=withEarlySkip(emptyMemory(s),base);
 m=withPlay(m,base+1);
 expect(skipsWeigh(m,base+2)).toBe(false);
 expect(coolingDown(m,base+2)).toBe(true);
 m=mergeMemory(m,{plays:10,earlySkips:4,lastPlayedAt:base-100,lastSkippedAt:base-1000});
 expect(m.lastSkippedAt).toBe(base);
 expect(skipsWeigh(m,base+2)).toBe(false);
 m=withEarlySkip(m,base+DAY_MS);
 expect(skipsWeigh(m,base+DAY_MS+retestAfter(6)-1)).toBe(true);
 expect(skipsWeigh(m,base+DAY_MS+retestAfter(6))).toBe(false);
 expect(isBlocked(m,new Set([s]))).toBe(true);
 expect(tasteWeight(m,'consume',base+DAY_MS+1)).toBe(1);
 expect(skipsWeigh(mergeMemory(emptyMemory(s),{plays:0,earlySkips:5,lastPlayedAt:null}),base+9999*DAY_MS)).toBe(true);
});
