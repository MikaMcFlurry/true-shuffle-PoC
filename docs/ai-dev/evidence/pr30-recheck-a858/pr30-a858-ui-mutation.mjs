import { chromium } from '/workspace/pr30-ui-a858/node_modules/@playwright/test/index.mjs';
import fs from 'node:fs';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
const out=[];process.on('exit',()=>fs.writeFileSync('/tmp/pr30-a858-ui-mutation.json',JSON.stringify(out,null,2)));const root='http://127.0.0.1:4204';
const counts={enabled:true,rows:20,neutralRows:0,plays:20,skips:0,songs:2,includedPlays:20,includedSkips:0,includedSongs:2,changedSongs:0,summarySongs:0,summaryPlays:0,includedSummarySongs:0,from:1700000000000,to:1750000000000,rules:[]};
const item=(id,name)=>({key:id,name,artist:'Ein langer Künstlername '.repeat(12),album:'Album',songs:1,plays:10,skips:0,includedPlays:10,includedSkips:0,rows:10,neutral:0,lastAt:1750000000000,summaryOnly:false,status:'included',rules:[]});
const items=[item('aaaaaaaaaaaaaaaaaaaaaa','Alpha '+ 'Langer Titel '.repeat(18)),item('bbbbbbbbbbbbbbbbbbbbbb','Beta '+ 'Noch ein Titel '.repeat(18))];
const initial=()=>({commit:0,revision:0,appliedAt:null,selection:{enabled:true,rules:[]},counts,effective:{state:'current',error:null,at:null},dataset:{key:'dataset-one',hasImport:true,importedAt:1750000000000,songs:2,rows:20,rowsFrom:1700000000000,rowsTo:1750000000000,summaryProfile:false,coverage:'events'},uploading:false,liveSince:null});
const pl={state:'never',startedAt:null,finishedAt:null,listAt:null,complete:false,listIncomplete:false,playlists:{own:0,read:0,failed:[],unclear:[],trueShuffle:0,foreign:0},songs:0,error:null,top:[]};
async function boot(width=390,theme='light'){
 const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,locale:'de-DE'}); const page=await context.newPage();let view=initial();let delayPreview=false,previewFail=false,delayApply=false,deleteFail=false,loadFail=false,applyFail=0;let applies=[],held=[],heldLoads=[],heldApplies=[],deletes=0,delayLoad=false,delayDelete=false,heldDeletes=[];let errors=[];page.on('response',r=>{if(!r.url().includes('/api/'))console.log('RESP',r.url(),r.status(),r.headers()['content-type'])});page.on('console',m=>console.log('CONSOLE',m.text()));page.on('requestfailed',r=>console.log('REQFAIL',r.url(),r.failure()));page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message)});
 await page.route(root+'/**', async route=>{const url=new URL(route.request().url()); if(url.pathname==='/api.ts'){const response=await route.fetch({url:root+'/@fs/workspace/pr30-ui-a858/src/client/api.ts'});return route.fulfill({response});} if(url.pathname.startsWith('/api/')){
  const body=route.request().postDataJSON();
  const json=(data,status=200)=>route.fulfill({status,json:data});
  if(url.pathname==='/api/history/selection/preview'){
   if(delayPreview) await new Promise(r=>held.push(r));
   if(previewFail)return json({error:{code:'failed',message:'Offline Vorschau'}},503);
   const chosen=body.query.q?items.filter(x=>x.name.toLowerCase().includes(body.query.q.toLowerCase())):items;
   return json({selection:body,counts:{...counts,includedPlays:body.rules.length?10:20,changedSongs:body.rules.length},applied:counts,revision:view.revision,dataset:view.dataset.key,page:{total:chosen.length,items:chosen,matchIds:chosen.map(x=>x.key),matchArtists:[]},query:body.query});
  }
  if(url.pathname==='/api/history/selection'){
   if(route.request().method()==='GET'){const snapshot=structuredClone(view), fail=loadFail, errorMessage=typeof loadFail==='string'?loadFail:'Offline Laden';if(delayLoad)await new Promise(r=>heldLoads.push(r));return fail?json({error:{code:'failed',message:errorMessage}},503):json(snapshot);}
   applies.push(body);if(delayApply)await new Promise(r=>heldApplies.push(r));if(applyFail==='offline')return route.abort('failed');if(applyFail)return json({error:{code:applyFail===409?'selection_changed':'failed',message:applyFail===409?'HTTP 409 selection changed':'Apply unavailable'}},applyFail);view={...view,commit:view.commit+1,revision:view.revision+1,selection:{enabled:body.enabled,rules:body.rules}};return json(view);
  }
  if(url.pathname==='/api/history/delete'){deletes++;if(delayDelete)await new Promise(r=>heldDeletes.push(r));if(deleteFail==='offline')return route.abort('failed');if(deleteFail)return json({error:{code:'failed',message:'Löschen fehlgeschlagen'}},503);view={...view,commit:view.commit+1,counts:null,dataset:{...view.dataset,key:'none',hasImport:false,rows:0,songs:0,coverage:'none'}};return json({deleted:{songs:2,rows:20},commit:view.commit});}
  if(url.pathname.includes('playlist-counts')) return json(pl);
  return json({error:{code:'unauth',message:'Kein Konto'}},401);
 }
 if(url.pathname==='/auswahl'||url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div class="app-shell"><main id="app"></main></div><script type="module" src="/@fs/workspace/pr30-ui-a858/e2e/.artifacts/pr30-ui-harness.tsx"></script></body></html>`});
 return route.continue(); });
 await page.goto(root+'/auswahl');await page.waitForTimeout(2000);console.log('BODY',await page.locator('body').innerText());await page.getByRole('button',{name:/Ausschließen: Alpha/}).waitFor({timeout:5000});
 return {page,context,errors,applies,set(k,v){if(k==='preview')delayPreview=v;if(k==='previewFail')previewFail=v;if(k==='apply')delayApply=v;if(k==='deleteFail')deleteFail=v;if(k==='loadFail')loadFail=v;if(k==='applyFail')applyFail=v;if(k==='load')delayLoad=v;if(k==='delete')delayDelete=v;},release(){held.splice(0).forEach(r=>r());heldApplies.splice(0).forEach(r=>r());},releaseOne(index=0){held.splice(index,1).forEach(r=>r());},dataset(v,revision=view.revision){view={...view,commit:view.commit+1,dataset:{...view.dataset,key:v},revision};},releaseLoad(index=0){heldLoads.splice(index,1).forEach(r=>r());},deletes(){return deletes;},releaseDelete(){heldDeletes.splice(0).forEach(r=>r());}};
}


async function showLoadError(h){let p=h.page;h.set('deleteFail',true);h.set('loadFail',true);await p.getByRole('button',{name:/Import löschen …/}).click();await p.getByRole('button',{name:'Endgültig löschen'}).click();await p.getByRole('button',{name:'Neu laden'}).waitFor();await p.getByRole('button',{name:'Abbrechen'}).click();h.set('deleteFail',false);h.set('loadFail',false);}

for(const what of ['apply','toggle','delete'])for(const outcome of [503,'offline']){
 let h=await boot(),p=h.page;await showLoadError(h);if(what==='apply'){await p.getByRole('button',{name:/Ausschließen: Alpha/}).click();await p.waitForTimeout(400);}if(what==='delete'){await p.getByRole('button',{name:/Import löschen …/}).click();h.set('delete',true);h.set('deleteFail',outcome);}else{h.set('apply',true);h.set('applyFail',outcome);}await p.getByRole('button',{name:what==='apply'?'Auswahl übernehmen':what==='toggle'?'Import ausschalten':'Endgültig löschen'}).click();await p.getByRole('button',{name:'Neu laden'}).click();await p.waitForTimeout(150);if(what!=='delete'){await p.getByRole('button',{name:/Ausschließen: Beta/}).click();await p.waitForTimeout(400);}if(what==='delete')h.releaseDelete();else h.release();await p.waitForTimeout(250);const body=await p.locator('body').innerText();out.push({case:'own-failure-after-same-commit-get',what,outcome,body});if(what==='delete'){h.set('delete',false);h.set('deleteFail',false);}else {h.set('apply',false);h.set('applyFail',0);}await p.getByRole('button',{name:what==='apply'?'Auswahl übernehmen':what==='toggle'?'Import ausschalten':'Endgültig löschen'}).click();await p.waitForTimeout(250);out.push({case:'retry-after-own-failure',what,outcome,body:await p.locator('body').innerText(),posts:h.applies});await h.context.close();
}
for(const what of ['apply','toggle','delete']){
 let h=await boot(),p=h.page;await showLoadError(h);if(what==='apply'){await p.getByRole('button',{name:/Ausschließen: Alpha/}).click();await p.waitForTimeout(400);}if(what==='delete'){await p.getByRole('button',{name:/Import löschen …/}).click();h.set('delete',true);h.set('deleteFail',503);}else{h.set('apply',true);h.set('applyFail',503);}await p.getByRole('button',{name:what==='apply'?'Auswahl übernehmen':what==='toggle'?'Import ausschalten':'Endgültig löschen'}).click();h.dataset('dataset-replaced');await p.getByRole('button',{name:'Neu laden'}).click();await p.waitForTimeout(150);if(what==='delete')h.releaseDelete();else h.release();await p.waitForTimeout(250);out.push({case:'old-failure-after-newer-commit-get',what,body:await p.locator('body').innerText()});await h.context.close();
}
fs.writeFileSync('/tmp/pr30-a858-ui-mutation.json',JSON.stringify(out,null,2));await browser.close();
