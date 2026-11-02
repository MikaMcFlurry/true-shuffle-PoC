import { chromium } from '/workspace/pr30-0071-ui/node_modules/@playwright/test/index.mjs';
import fs from 'node:fs';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
const out=[];process.on('exit',()=>fs.writeFileSync('/tmp/pr30-0071-ui-supplement.json',JSON.stringify(out,null,2)));const root='http://127.0.0.1:4201';
const counts={enabled:true,rows:20,neutralRows:0,plays:20,skips:0,songs:2,includedPlays:20,includedSkips:0,includedSongs:2,changedSongs:0,summarySongs:0,summaryPlays:0,includedSummarySongs:0,from:1700000000000,to:1750000000000,rules:[]};
const item=(id,name)=>({key:id,name,artist:'Ein langer Künstlername '.repeat(12),album:'Album',songs:1,plays:10,skips:0,includedPlays:10,includedSkips:0,rows:10,neutral:0,lastAt:1750000000000,summaryOnly:false,status:'included',rules:[]});
const items=[item('aaaaaaaaaaaaaaaaaaaaaa','Alpha '+ 'Langer Titel '.repeat(18)),item('bbbbbbbbbbbbbbbbbbbbbb','Beta '+ 'Noch ein Titel '.repeat(18))];
const initial=()=>({revision:0,appliedAt:null,selection:{enabled:true,rules:[]},counts,effective:{state:'current',error:null,at:null},dataset:{key:'dataset-one',hasImport:true,importedAt:1750000000000,songs:2,rows:20,rowsFrom:1700000000000,rowsTo:1750000000000,summaryProfile:false,coverage:'events'},uploading:false,liveSince:null});
const pl={state:'never',startedAt:null,finishedAt:null,listAt:null,complete:false,listIncomplete:false,playlists:{own:0,read:0,failed:[],unclear:[],trueShuffle:0,foreign:0},songs:0,error:null,top:[]};
async function boot(width=390,theme='light'){
 const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,locale:'de-DE'}); const page=await context.newPage();let view=initial();let delayPreview=false,previewFail=false,delayApply=false,deleteFail=false,loadFail=false,applyFail=0;let applies=[],held=[];let errors=[];page.on('response',r=>{if(!r.url().includes('/api/'))console.log('RESP',r.url(),r.status(),r.headers()['content-type'])});page.on('console',m=>console.log('CONSOLE',m.text()));page.on('requestfailed',r=>console.log('REQFAIL',r.url(),r.failure()));page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message)});
 await page.route(root+'/**', async route=>{const url=new URL(route.request().url()); if(url.pathname==='/api.ts'){const response=await route.fetch({url:root+'/@fs/workspace/pr30-0071-ui/src/client/api.ts'});return route.fulfill({response});} if(url.pathname.startsWith('/api/')){
  const body=route.request().postDataJSON();
  const json=(data,status=200)=>route.fulfill({status,json:data});
  if(url.pathname==='/api/history/selection/preview'){
   if(delayPreview) await new Promise(r=>held.push(r));
   if(previewFail)return json({error:{code:'failed',message:'Offline Vorschau'}},503);
   const chosen=body.query.q?items.filter(x=>x.name.toLowerCase().includes(body.query.q.toLowerCase())):items;
   return json({selection:body,counts:{...counts,includedPlays:body.rules.length?10:20,changedSongs:body.rules.length},applied:counts,revision:view.revision,dataset:view.dataset.key,page:{total:chosen.length,items:chosen,matchIds:chosen.map(x=>x.key),matchArtists:[]},query:body.query});
  }
  if(url.pathname==='/api/history/selection'){
   if(route.request().method()==='GET')return loadFail?json({error:{code:'failed',message:'Offline Laden'}},503):json(view);
   applies.push(body);if(delayApply)await new Promise(r=>held.push(r));if(applyFail)return json({error:{code:applyFail===409?'selection_changed':'failed',message:applyFail===409?'HTTP 409 selection changed':'Apply unavailable'}},applyFail);view={...view,revision:view.revision+1,selection:{enabled:body.enabled,rules:body.rules}};return json(view);
  }
  if(url.pathname==='/api/history/import')return deleteFail?json({error:{code:'failed',message:'Löschen fehlgeschlagen'}},503):json({deleted:{songs:2,rows:20}});
  if(url.pathname.includes('playlist-counts')) return json(pl);
  return json({error:{code:'unauth',message:'Kein Konto'}},401);
 }
 if(url.pathname==='/auswahl'||url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div class="app-shell"><main id="app"></main></div><script type="module" src="/@fs/workspace/pr30-0071-ui/e2e/.artifacts/pr30-ui-harness.tsx"></script></body></html>`});
 return route.continue(); });
 await page.goto(root+'/auswahl');await page.waitForTimeout(2000);console.log('BODY',await page.locator('body').innerText());await page.getByRole('button',{name:/Ausschließen: Alpha/}).waitFor({timeout:5000});
 return {page,context,errors,applies,set(k,v){if(k==='preview')delayPreview=v;if(k==='previewFail')previewFail=v;if(k==='apply')delayApply=v;if(k==='deleteFail')deleteFail=v;if(k==='loadFail')loadFail=v;if(k==='applyFail')applyFail=v;},release(){held.splice(0).forEach(r=>r());},releaseOne(index=0){held.splice(index,1).forEach(r=>r());},dataset(v){view={...view,dataset:{...view.dataset,key:v},revision:view.revision+1};}};
}

{
let h=await boot(),p=h.page;h.set('preview',true);await p.getByLabel('Song, Künstler oder Album').fill('Alpha');await p.waitForTimeout(300);await p.getByLabel('Song, Künstler oder Album').fill('Beta');await p.waitForTimeout(300);h.releaseOne(1);await p.waitForTimeout(150);h.releaseOne(0);h.set('preview',false);await p.waitForTimeout(200);await p.getByRole('button',{name:'Alle 1 Treffer ausschließen'}).click();await p.waitForTimeout(400);out.push({case:'reverse-query-current-bulk',query:await p.getByLabel('Song, Künstler oder Album').inputValue(),draft:await p.locator('.selection__rules').innerText()});await h.context.close();
}
{
let h=await boot(),p=h.page;h.set('preview',true);await p.getByLabel('Gruppieren').selectOption('artist');await p.waitForTimeout(300);out.push({case:'group-pending-row-lock',disabled:await p.getByRole('button',{name:/Ausschließen: Alpha/}).isDisabled(),bulkCount:await p.getByRole('button',{name:/Alle.*Treffer ausschließen/}).count()});h.release();await h.context.close();
}
{
let h=await boot(),p=h.page;h.dataset('dataset-two');await p.getByLabel('Song, Künstler oder Album').fill('Beta');await p.waitForTimeout(750);await p.getByRole('button',{name:/Ausschließen: Beta/}).click();await p.waitForTimeout(400);await p.getByRole('button',{name:'Auswahl übernehmen'}).click();await p.waitForTimeout(150);out.push({case:'dataset-reload-current-apply',posted:h.applies,message:await p.locator('body').innerText()});await h.context.close();
}
fs.writeFileSync('/tmp/pr30-0071-ui-supplement.json',JSON.stringify(out,null,2));await browser.close();console.log(out.map(x=>({case:x.case,width:x.width,theme:x.theme,enabled:x.enabled,overflow:x.metrics?.scroll>x.metrics?.width,posted:x.applied||x.posted,errors:x.errors}))); 
