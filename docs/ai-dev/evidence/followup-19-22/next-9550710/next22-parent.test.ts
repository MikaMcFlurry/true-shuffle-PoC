import { describe, expect, it, vi } from '/workspace/ts-review-next1922/node_modules/vitest/dist/index.js';
import { onboarded } from '/workspace/ts-review-next1922/test/hub/harness.ts';
import { addToProfile, finishProfile, newProfile } from '/workspace/ts-review-next1922/src/client/history-profile';
import { requestGenres, parseGenres } from '/workspace/ts-review-next1922/src/worker/hub/genres';
import { UserHub } from '/workspace/ts-review-next1922/src/worker/userhub';
import worker from '/workspace/ts-review-next1922/src/worker/index';
import {Keys} from '/workspace/ts-review-next1922/src/worker/lib/crypto';

const good = () => ({ at:0,from:1600000000000,to:1700000000000,plays:10,minutes:300,songs:5,artists:1,earlySkips:0,hourWeek:Array(168).fill(0),months:[],topArtists:[{name:'Glasfabrik',plays:10,minutes:300}],topSongs:[] });

it('a stale signed session cannot piggyback the active valid AI flight', async()=>{
 let release!: (v:unknown)=>void;let entered!:()=>void;
 const ready=new Promise<void>(r=>entered=r);
 const h=await onboarded({tracks:40,ai:{run:()=>{entered();return new Promise(r=>release=r)}},env:{anthropicKey:null}});
 h.hub.setImportedProfile(good());
 const u=new UserHub({} as never,{} as never);Object.defineProperty(u,'core',{value:h.hub,writable:true});
 const current=u.estimateGenres(h.hub.sessionEpoch());await ready;
 const stale=u.estimateGenres(h.hub.sessionEpoch()-1);
 release({response:'{"genres":[{"name":"Pop","share":100}],"summary":"Sensitive taste"}'});
 await current;
 const result=await stale;
 expect(result).toMatchObject({ok:false,error:{code:'auth',status:401}});
});

it('Worker genre route rejects a signed stale cookie even during a current session flight',async()=>{
 let release!: (v:unknown)=>void;let entered!:()=>void;
 const ready=new Promise<void>(r=>entered=r);
 const h=await onboarded({tracks:40,ai:{run:()=>{entered();return new Promise(r=>release=r)}},env:{anthropicKey:null}});
 h.hub.setImportedProfile(good());
 const u=new UserHub({} as never,{} as never);Object.defineProperty(u,'core',{value:h.hub,writable:true});
 const secret='test-secret-test-secret-test-secret-42';
 const env={SPOTIFY_CLIENT_ID:'test',APP_SECRET:secret,ALLOWED_SPOTIFY_IDS:'mika',USER_HUB:{idFromName:(uid:string)=>uid,get:()=>u}};
 const call=async(epoch:number)=>{
  const cookie='ts_session='+await new Keys(secret).sign('mika|'+(Date.now()+60000)+'|'+epoch);
  return worker.fetch(new Request('https://app.invalid/api/profile/genres',{method:'POST',headers:{cookie,'x-ts':'1'}}),env as never,{} as never);
 };
 const valid=call(h.hub.sessionEpoch());await ready;
 const stale=call(h.hub.sessionEpoch()-1);
 // Let the cookie middleware reach UserHub before releasing its provider.
 await new Promise(r=>setTimeout(r,30));
 release({response:'{"genres":[{"name":"Pop","share":100}],"summary":"Sensitive taste"}'});
 expect((await valid).status).toBe(200);
 const result=await stale;
 const body=await result.json();
 console.log('STALE_SIGNED_COOKIE',result.status,JSON.stringify(body));
 expect(result.status).toBe(401);
});
