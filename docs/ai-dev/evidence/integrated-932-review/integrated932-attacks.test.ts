import { describe, expect, it } from '/workspace/ts-integrated932-backend/node_modules/vitest/dist/index.js';
import { onboarded } from '/workspace/ts-integrated932-backend/test/hub/harness';
import { DAY_MS } from '/workspace/ts-integrated932-backend/src/core/types';
import { localTimes, periodProfile, type ListenEvent } from '/workspace/ts-integrated932-backend/src/core/period-profile';
const id = (s:string) => s.padEnd(22,'x');
const track = (s:string) => [id(s),s,s,''];
describe('PR26 independent upload attacks',()=>{
 it('rejects a stale tab chunk instead of pairing it with a replacement dictionary',async()=>{
  const h=await onboarded({tracks:40});
  const at=Math.floor((h.clock.t-DAY_MS)/1000);
  let upload:string|undefined; const part=(kind:string,data:unknown[],part:number)=>({upload,part,parts:2,tracks:1,kind,data});
  upload=h.hub.importListens(part('tracks',[track('A')],0)).upload;
  h.hub.importListens(part('tracks',[track('B')],0));
  // Tab A resumes its in-flight rows after tab B started a new generation.
  const result=()=>h.hub.importListens(part('rows',[[at,0,120000,0,1]],1));
  expect(result).toThrow();
 });
 it('rejects a missing dictionary entry rather than silently discarding its play',async()=>{
  const h=await onboarded({tracks:40});
  const upload=h.hub.importListens({part:0,parts:2,tracks:2,kind:'tracks',data:[track('A')]}).upload;
  expect(()=>h.hub.importListens({upload,part:1,parts:2,tracks:2,kind:'rows',data:[[Math.floor((h.clock.t-DAY_MS)/1000),1,120000,0,1]]})).toThrow();
 });
 it('rejects unordered plays whose first live-era row hides later older imports',async()=>{
  const h=await onboarded({tracks:40});
  const upload=h.hub.importListens({part:0,parts:2,tracks:1,kind:'tracks',data:[track('A')]}).upload;
  expect(()=>h.hub.importListens({upload,part:1,parts:2,tracks:1,kind:'rows',data:[
   [Math.floor(h.clock.t/1000),0,120000,0,1],
   [Math.floor((h.clock.t-DAY_MS)/1000),0,120000,0,1],
  ]})).toThrow();
 });
 it('keeps all events of one local calendar week in the same Monday bucket across fall DST',()=>{
  const e=(at:string):ListenEvent=>({at:Date.parse(at),song:'a',name:'A',artist:'A',album:null,ms:120000,exact:true,play:true,earlySkip:false,platform:1,shuffle:false,offline:false,imageUrl:null});
  const result=periodProfile([e('2026-10-19T10:00:00Z'), e('2026-10-25T22:30:00Z')],{from:Date.parse('2026-08-01T00:00:00Z'),to:Date.parse('2026-11-01T00:00:00Z')},localTimes('Europe/Berlin'));
  expect(result.series.unit).toBe('week');
  expect(result.series.points).toHaveLength(1);
 });
});
