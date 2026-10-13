import { describe, expect, it, vi } from 'vitest';
import { onboarded } from './harness';
import { addToProfile, finishProfile, newProfile } from '../../src/client/history-profile';
import { requestGenres, parseGenres } from '../../src/worker/hub/genres';
import { UserHub } from '../../src/worker/userhub';
import worker from '../../src/worker/index';
import {Keys} from '../../src/worker/lib/crypto';

const good = () => ({ at:0,from:1600000000000,to:1700000000000,plays:10,minutes:300,songs:5,artists:1,earlySkips:0,hourWeek:Array(168).fill(0),months:[],topArtists:[{name:'Glasfabrik',plays:10,minutes:300}],topSongs:[] });

describe('PR22 independent backend attacks', () => {
 it('failed estimates are bounded by six-hour attempt gate',async()=>{
  let calls=0;
  const h=await onboarded({tracks:40,ai:{run:async()=>{calls++;return {response:'refused'};}},env:{anthropicKey:null}});
  h.hub.setImportedProfile(good());
  for(let i=0;i<3;i++) {await requestGenres(fn=>Promise.resolve().then(fn).then(value=>({ok:true as const,value})),()=>h.hub.prepareGenres(),artists=>h.hub.runGenreEstimate(artists),(id,est)=>h.hub.storeGenres(id,est));h.restart();}
  expect(calls).toBe(1);
 });
 it('slow optional AI does not block owner transport through actual UserHub session queue',async()=>{
  let resolve!: (v:unknown)=>void;
  let entered!:()=>void;
  const enteredP=new Promise<void>(r=>entered=r);
  const h=await onboarded({tracks:40,ai:{run:()=>{entered();return new Promise(r=>resolve=r);}},env:{anthropicKey:null}});
  h.hub.setImportedProfile(good());
  await h.hub.play(h.stationIds[0]!);
  const u=new UserHub({} as never,{} as never);
  Object.defineProperty(u,'core',{value:h.hub,writable:true});
  const estimate=u.estimateGenres(h.hub.sessionEpoch());
  await enteredP;
  let completed=false;
  const pause=u.playerAction(h.hub.sessionEpoch(),'pause').then(x=>{completed=true;return x;});
  await new Promise(r=>setTimeout(r,100));
  const blocked=!completed;
  resolve({response:JSON.stringify({genres:[{name:'Pop',share:100}],summary:'Du hörst Pop.'})});
  await estimate;
  const p=await pause;
  expect(p.ok).toBe(true);
  expect(blocked).toBe(false);
 });
 it.skip('rejects non-string months before persisting data that crashes profile rendering',async()=>{
  const h=await onboarded({tracks:40});
  const p={...good(),months:[{month:['2023-11'],plays:10,minutes:300}]};
  expect(()=>h.hub.setImportedProfile(p)).toThrow();
 });
 it('normal imported profile remains isolated across two accounts',async()=>{
  const a=await onboarded({tracks:40});const b=await onboarded({tracks:40});
  a.hub.setImportedProfile(good());
  expect(b.hub.listeningProfile('UTC').imported).toBeNull();
  expect(a.hub.listeningProfile('UTC').imported?.plays).toBe(10);
 });
 it('successful concurrent RPC estimates share one provider result and retain it on later failure',async()=>{
  let calls=0;let usable=true;
  const h=await onboarded({tracks:40,ai:{run:async()=>{calls++;return {response:usable?' {"genres":[{"name":"Pop","share":100}],"summary":"Du hörst Pop."}':'refused'};}},env:{anthropicKey:null}});
  h.hub.setImportedProfile(good());const u=new UserHub({} as never,{} as never);Object.defineProperty(u,'core',{value:h.hub,writable:true});
  const values=await Promise.all([u.estimateGenres(h.hub.sessionEpoch()),u.estimateGenres(h.hub.sessionEpoch())]);
  expect(calls).toBe(1);expect(values[0]).toEqual(values[1]);
  const old=h.hub.listeningProfile('UTC').genres;h.clock.t+=7*3600000;usable=false;
  await requestGenres(fn=>Promise.resolve().then(fn).then(value=>({ok:true as const,value})),()=>h.hub.prepareGenres(),artists=>h.hub.runGenreEstimate(artists),(id,est)=>h.hub.storeGenres(id,est));
  expect(h.hub.listeningProfile('UTC').genres).toEqual(old);
 });
 it('all three new API routes enforce CSRF, signed-cookie account identity and session epoch',async()=>{
  const h=await onboarded({tracks:40});const u=new UserHub({} as never,{} as never);Object.defineProperty(u,'core',{value:h.hub,writable:true});
  const secret='test-secret-test-secret-test-secret-42';let selected='';
  const env={SPOTIFY_CLIENT_ID:'test',APP_SECRET:secret,ALLOWED_SPOTIFY_IDS:'mika',USER_HUB:{idFromName:(uid:string)=>uid,get:(uid:string)=>{selected=uid;return u;}}};
  const cookie='ts_session='+await new Keys(secret).sign('mika|'+(Date.now()+60000)+'|'+h.hub.sessionEpoch());
  const req=async(path:string,method='GET',headers:Record<string,string>={},body?:string)=>worker.fetch(new Request('https://app.invalid'+path,{method,headers,body}),env as never,{} as never);
  for(const path of ['/api/profile','/api/history/profile','/api/profile/genres']){
   const method=path==='/api/profile'?'GET':'POST';
   expect((await req(path,method,method==='GET'?{}:{'x-ts':'1'})).status).toBe(401);
   if(method==='POST')expect((await req(path,method,{cookie})).status).toBe(403);
  }
  const read=await req('/api/profile?uid=other','GET',{cookie});expect(read.status).toBe(200);expect(selected).toBe('mika');
  const save=await req('/api/history/profile','POST',{cookie,'x-ts':'1','content-type':'application/json'},JSON.stringify({profile:good()}));expect(save.status).toBe(200);
  h.hub.endSessions();expect((await req('/api/profile','GET',{cookie})).status).toBe(401);
 });
 it('DST month boundary and native observed history are read without changing continuity',async()=>{
  const h=await onboarded({tracks:40});
  const at=Date.UTC(2026,2,31,22,30);h.clock.t=Date.UTC(2026,3,1,6);
  const t=['A'.repeat(22),'Native observed song',[['native','Native']], 'album',null,180000];
  h.sql.run('INSERT INTO plays (played_at,track_id,context_uri,station_id,ignored,meta) VALUES (?,?,NULL,NULL,0,?)',at,t[0] as string,JSON.stringify(t));
  h.sql.run('INSERT INTO plays (played_at,track_id,context_uri,station_id,ignored,meta) VALUES (?,?,NULL,NULL,1,?)',at+1000,'B'.repeat(22),JSON.stringify(t));
  const before=JSON.stringify(h.sql.all('SELECT * FROM kv'));
  const p=h.hub.listeningProfile('Europe/Berlin');expect(p.plays).toBe(1);expect(p.months[0]?.month).toBe('2026-04');expect(p.hourWeek[2*24]).toBe(1);expect(p.onCassettes).toBe(0);
  expect(JSON.stringify(h.sql.all('SELECT * FROM kv'))).toBe(before);
 });
 it('empty and malformed genre model output remains unusable' ,()=>{
  for(const x of ['no json','{"genres":[null]}','{"genres":[{}]}','{"genres":[]}'])expect(parseGenres(x)).toBeNull();
 });
 it.skip('rejects infinite played milliseconds rather than producing non-JSON import summary',()=>{
  const p=newProfile();addToProfile([{ts:'2023-01-01T00:00:00Z',spotify_track_uri:'spotify:track:'+'A'.repeat(22),ms_played:Infinity}],p);
  expect(finishProfile(p,Date.now())).toBeNull();
 });
});

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
it('20-second optional AI timeout releases flight and durable attempt prevents retry',async()=>{
 let calls=0;let release!: (v:unknown)=>void;
 const h=await onboarded({tracks:40,ai:{run:()=>{calls++;return new Promise(r=>release=r)}},env:{anthropicKey:null}});
 h.hub.setImportedProfile(good());
 const u=new UserHub({} as never,{} as never);Object.defineProperty(u,'core',{value:h.hub,writable:true});
 vi.useFakeTimers();
 try {
  const first=u.estimateGenres(h.hub.sessionEpoch());
  await vi.advanceTimersByTimeAsync(20000);
  expect(await first).toMatchObject({ok:true,value:{failed:true,estimate:null}});
  expect(await u.estimateGenres(h.hub.sessionEpoch())).toMatchObject({ok:true,value:{failed:false}});
  expect(calls).toBe(1);
  release({response:'{"genres":[{"name":"Pop","share":100}],"summary":"Late"}'});
  await vi.advanceTimersByTimeAsync(1);
  expect(h.hub.listeningProfile('UTC').genres).toBeNull();
  h.restart();
  const restarted=new UserHub({} as never,{} as never);Object.defineProperty(restarted,'core',{value:h.hub,writable:true});
  await restarted.estimateGenres(h.hub.sessionEpoch());expect(calls).toBe(1);
 }finally {vi.useRealTimers()}
});
it('logout fences late AI store without harming account transport',async()=>{
 let release!: (v:unknown)=>void;let entered!:()=>void;
 const ready=new Promise<void>(r=>entered=r);
 const h=await onboarded({tracks:40,ai:{run:()=>{entered();return new Promise(r=>release=r)}},env:{anthropicKey:null}});
 h.hub.setImportedProfile(good());
 const u=new UserHub({} as never,{} as never);Object.defineProperty(u,'core',{value:h.hub,writable:true});
 const first=u.estimateGenres(h.hub.sessionEpoch());await ready;
 await u.logout(h.hub.sessionEpoch());
 release({response:'{"genres":[{"name":"Pop","share":100}],"summary":"Revoked"}'});
 expect(await first).toMatchObject({ok:false,error:{status:401}});
 expect(h.hub.listeningProfile('UTC').genres).toBeNull();
});

it('signed Worker callers queued before logout all fail after reattach and old flight cannot publish',async()=>{
 let release!: (v:unknown)=>void;let entered!:()=>void;
 const ready=new Promise<void>(r=>entered=r);
 const h=await onboarded({tracks:40,ai:{run:()=>{entered();return new Promise(r=>release=r)}},env:{anthropicKey:null}});
 h.hub.setImportedProfile(good());const u=new UserHub({} as never,{} as never);Object.defineProperty(u,'core',{value:h.hub,writable:true});
 const secret='test-secret-test-secret-test-secret-42';
 const env={SPOTIFY_CLIENT_ID:'test',APP_SECRET:secret,ALLOWED_SPOTIFY_IDS:'mika',USER_HUB:{idFromName:(uid:string)=>uid,get:()=>u}};
 const epoch=h.hub.sessionEpoch();const cookie='ts_session='+await new Keys(secret).sign('mika|'+(Date.now()+60000)+'|'+epoch);
 const call=()=>worker.fetch(new Request('https://app.invalid/api/profile/genres',{method:'POST',headers:{cookie,'x-ts':'1'}}),env as never,{} as never);
 const first=call();await ready;const same=Array.from({length:8},()=>call());await new Promise(r=>setTimeout(r,30));
 expect(await u.logout(epoch)).toMatchObject({ok:true});
 const refresh='pr23-relogin';h.fake.refreshTokens.set(refresh,'mika');
 expect(await u.attach({id:'mika',name:'Mika',imageUrl:null},{accessToken:h.fake.issueToken('mika'),refreshToken:refresh,expiresAt:h.clock.t+3600000,scope:'all'})).toMatchObject({ok:true});
 const fresh=h.hub.sessionEpoch();expect(fresh).not.toBe(epoch);
 expect(await u.estimateGenres(fresh)).toMatchObject({ok:true,value:{estimate:null}});
 release({response:'{"genres":[{"name":"Pop","share":100}],"summary":"Revoked private profile"}'});
 for(const response of await Promise.all([first,...same])) {expect(response.status).toBe(401);expect(JSON.stringify(await response.json())).not.toContain('Revoked private profile');}
 expect(h.hub.listeningProfile('UTC').genres).toBeNull();
});

it('fresh-epoch failure cannot clear an older flight or bypass six-hour durable gate after restart',async()=>{
 let release!: (v:unknown)=>void;let entered!:()=>void;let calls=0;
 const ready=new Promise<void>(r=>entered=r);
 const h=await onboarded({tracks:40,ai:{run:()=>{calls++;entered();return new Promise(r=>release=r)}},env:{anthropicKey:null}});
 h.hub.setImportedProfile(good());const u=new UserHub({} as never,{} as never);Object.defineProperty(u,'core',{value:h.hub,writable:true});
 const first=u.estimateGenres(h.hub.sessionEpoch());await ready;await u.logout(h.hub.sessionEpoch());
 const fresh=h.hub.sessionEpoch();expect(await u.estimateGenres(fresh)).toMatchObject({ok:true,value:{estimate:null}});
 release({response:'{"genres":[{"name":"Pop","share":100}],"summary":"Old"}'});expect(await first).toMatchObject({ok:false,error:{status:401}});
 h.restart();const newer=new UserHub({} as never,{} as never);Object.defineProperty(newer,'core',{value:h.hub,writable:true});
 h.clock.t+=6*3600000-1;await newer.estimateGenres(fresh);expect(calls).toBe(1);
 h.clock.t+=1;const next=newer.estimateGenres(fresh);await new Promise(r=>setTimeout(r,10));expect(calls).toBe(2);
 release({response:'{"genres":[{"name":"Jazz","share":100}],"summary":"Fresh"}'});expect(await next).toMatchObject({ok:true,value:{estimate:{summary:'Fresh'}}});
});

it('two real UserHub instances never share flights or results',async()=>{
 let release!: (v:unknown)=>void;let entered!:()=>void;let bCalls=0;
 const ready=new Promise<void>(r=>entered=r);
 const a=await onboarded({tracks:40,ai:{run:()=>{entered();return new Promise(r=>release=r)}},env:{anthropicKey:null}});
 const b=await onboarded({tracks:40,ai:{run:async()=>{bCalls++;return {response:'{"genres":[{"name":"Jazz","share":100}],"summary":"Account B"}'}}},env:{anthropicKey:null}});
 a.hub.setImportedProfile(good());b.hub.setImportedProfile({...good(),topArtists:[{name:'Other artist',plays:10,minutes:300}]});
 const wrap=(h:typeof a)=>{const u=new UserHub({} as never,{} as never);Object.defineProperty(u,'core',{value:h.hub,writable:true});return u};
 const ua=wrap(a),ub=wrap(b);const first=ua.estimateGenres(a.hub.sessionEpoch());await ready;
 const result=await ub.estimateGenres(b.hub.sessionEpoch());expect(result).toMatchObject({ok:true,value:{estimate:{summary:'Account B'}}});expect(bCalls).toBe(1);expect(a.hub.listeningProfile('UTC').genres).toBeNull();
 release({response:'{"genres":[{"name":"Pop","share":100}],"summary":"Account A"}'});await first;
 expect(a.hub.listeningProfile('UTC').genres?.summary).toBe('Account A');expect(b.hub.listeningProfile('UTC').genres?.summary).toBe('Account B');
});
