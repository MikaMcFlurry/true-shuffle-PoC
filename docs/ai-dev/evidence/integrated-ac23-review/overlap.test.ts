import { expect, it } from 'vitest';
import { aggregateHistory,emptyAggregate,toRows } from '../../src/core/history';
import { addListens,newListens,finishListens } from '../../src/core/listens';
import { onboarded } from './harness';
const song='s'.repeat(22), other='o'.repeat(22), base=Date.parse('2026-09-24T06:00:00Z');
const prior={ts:new Date(base).toISOString(),ms_played:180000,spotify_track_uri:`spotify:track:${other}`};
const skip={ts:new Date(base+3000).toISOString(),ms_played:3000,spotify_track_uri:`spotify:track:${song}`,reason_start:'trackdone',reason_end:'fwdbtn',master_metadata_track_name:'Skipped'};
it('overlapping exports: same skip at shorter-file start and within full-file must give one mix/profile verdict',async()=>{
 const agg=emptyAggregate(), listens=newListens();
 for(const file of [[skip],[prior,skip]]) {aggregateHistory(file,agg);addListens(file,listens);}
 const h=await onboarded({tracks:40});h.hub.importHistory(toRows(agg),0,1);
 const data=finishListens(listens), u=h.hub.importListens({part:0,parts:2,tracks:data.tracks.length,kind:'tracks',data:data.tracks});
 h.hub.importListens({upload:u.upload,part:1,parts:2,tracks:data.tracks.length,kind:'rows',data:data.rows});
 const profile=h.hub.listeningProfile('UTC');
 console.log('OVERLAP',JSON.stringify({aggregate:{skipped:agg.skipped,openers:agg.openers,rows:toRows(agg)},profile:profile.skips}));
 expect(profile.skips?.early).toBe(agg.skipped);
});
