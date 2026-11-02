import { chromium } from '/workspace/pr30-ui-a858/node_modules/@playwright/test/index.mjs';
import fs from 'node:fs';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
const out=[];process.on('exit',()=>fs.writeFileSync('/tmp/pr30-a858-ui-results.json',JSON.stringify(out,null,2)));const root='http://127.0.0.1:4204';
const counts={enabled:true,rows:20,neutralRows:0,plays:20,skips:0,songs:2,includedPlays:20,includedSkips:0,includedSongs:2,changedSongs:0,summarySongs:0,summaryPlays:0,includedSummarySongs:0,from:1700000000000,to:1750000000000,rules:[]};
const item=(id,name)=>({key:id,name,artist:'Ein langer Künstlername '.repeat(12),album:'Album',songs:1,plays:10,skips:0,includedPlays:10,includedSkips:0,rows:10,neutral:0,lastAt:1750000000000,summaryOnly:false,status:'included',rules:[]});
const items=[item('aaaaaaaaaaaaaaaaaaaaaa','Alpha '+ 'Langer Titel '.repeat(18)),item('bbbbbbbbbbbbbbbbbbbbbb','Beta '+ 'Noch ein Titel '.repeat(18))];
const initial=()=>({commit:0,revision:0,appliedAt:null,selection:{enabled:true,rules:[]},counts,effective:{state:'current',error:null,at:null},dataset:{key:'dataset-one',hasImport:true,importedAt:1750000000000,songs:2,rows:20,rowsFrom:1700000000000,rowsTo:1750000000000,summaryProfile:false,coverage:'events'},uploading:false,liveSince:null});
const pl={state:'never',startedAt:null,finishedAt:null,listAt:null,complete:false,listIncomplete:false,playlists:{own:0,read:0,failed:[],unclear:[],trueShuffle:0,foreign:0},songs:0,error:null,top:[]};
async function boot(width=390,theme='light'){
 const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,locale:'de-DE'}); const page=await context.newPage();let view=initial();let delayPreview=false,previewFail=false,delayApply=false,deleteFail=false,loadFail=false,applyFail=0;let applies=[],held=[],heldLoads=[],heldApplies=[],deletes=0,delayLoad=false;let errors=[];page.on('response',r=>{if(!r.url().includes('/api/'))console.log('RESP',r.url(),r.status(),r.headers()['content-type'])});page.on('console',m=>console.log('CONSOLE',m.text()));page.on('requestfailed',r=>console.log('REQFAIL',r.url(),r.failure()));page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message)});
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
   if(route.request().method()==='GET'){const snapshot=structuredClone(view);if(delayLoad)await new Promise(r=>heldLoads.push(r));return loadFail?json({error:{code:'failed',message:'Offline Laden'}},503):json(snapshot);}
   applies.push(body);if(delayApply)await new Promise(r=>heldApplies.push(r));if(applyFail)return json({error:{code:applyFail===409?'selection_changed':'failed',message:applyFail===409?'HTTP 409 selection changed':'Apply unavailable'}},applyFail);view={...view,commit:view.commit+1,revision:view.revision+1,selection:{enabled:body.enabled,rules:body.rules}};return json(view);
  }
  if(url.pathname==='/api/history/delete'){deletes++;if(deleteFail)return json({error:{code:'failed',message:'Löschen fehlgeschlagen'}},503);view={...view,commit:view.commit+1,counts:null,dataset:{...view.dataset,key:'none',hasImport:false,rows:0,songs:0,coverage:'none'}};return json({deleted:{songs:2,rows:20},commit:view.commit});}
  if(url.pathname.includes('playlist-counts')) return json(pl);
  return json({error:{code:'unauth',message:'Kein Konto'}},401);
 }
 if(url.pathname==='/auswahl'||url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div class="app-shell"><main id="app"></main></div><script type="module" src="/@fs/workspace/pr30-ui-a858/e2e/.artifacts/pr30-ui-harness.tsx"></script></body></html>`});
 return route.continue(); });
 await page.goto(root+'/auswahl');await page.waitForTimeout(2000);console.log('BODY',await page.locator('body').innerText());await page.getByRole('button',{name:/Ausschließen: Alpha/}).waitFor({timeout:5000});
 return {page,context,errors,applies,set(k,v){if(k==='preview')delayPreview=v;if(k==='previewFail')previewFail=v;if(k==='apply')delayApply=v;if(k==='deleteFail')deleteFail=v;if(k==='loadFail')loadFail=v;if(k==='applyFail')applyFail=v;if(k==='load')delayLoad=v;},release(){held.splice(0).forEach(r=>r());heldApplies.splice(0).forEach(r=>r());},releaseOne(index=0){held.splice(index,1).forEach(r=>r());},dataset(v,revision=view.revision){view={...view,commit:view.commit+1,dataset:{...view.dataset,key:v},revision};},releaseLoad(index=0){heldLoads.splice(index,1).forEach(r=>r());},deletes(){return deletes;}};
}
for(const width of [390,1440])for(const theme of ['light','dark']){let h=await boot(width,theme);let p=h.page;await p.screenshot({path:`/tmp/pr30-a858-selection-${width}-${theme}.png`,fullPage:true});const metrics=await p.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,controls:[...document.querySelectorAll('button,input,select')].map(x=>({label:x.getAttribute('aria-label')||x.textContent||x.type,h:x.getBoundingClientRect().height,w:x.getBoundingClientRect().width})),labels:[...document.querySelectorAll('input,select')].every(x=>!!x.closest('label'))}));out.push({case:'render',width,theme,metrics,errors:h.errors});await p.getByRole('button',{name:/Import löschen …/}).focus();await p.keyboard.press('Enter');await p.getByRole('button',{name:'Abbrechen'}).waitFor();await p.getByRole('button',{name:'Abbrechen'}).focus();await p.keyboard.press('Enter');out.push({case:'delete-keyboard-cancel',width,theme,confirmationRemoved:await p.getByRole('button',{name:'Endgültig löschen'}).count()===0});await h.context.close();}
{
 let h=await boot(),p=h.page;await p.getByLabel('Song, Künstler oder Album').fill('Alpha');await p.waitForTimeout(400);h.set('preview',true);await p.getByLabel('Song, Künstler oder Album').fill('Beta');await p.waitForTimeout(250);const staleBulk=await p.getByRole('button',{name:'Alle 1 Treffer ausschließen'}).count();const staleRows=await p.getByRole('button',{name:/Ausschließen: Alpha/}).isDisabled();const text=await p.locator('.selection__rules').count()?await p.locator('.selection__rules').innerText():'';const enabled=await p.getByRole('button',{name:'Auswahl übernehmen'}).isEnabled();out.push({case:'stale-search-bulk',staleBulk,staleRows,applyEnabled:enabled,search:await p.getByLabel('Song, Künstler oder Album').inputValue(),draftText:text,applied:h.applies});h.release();h.set('preview',false);await p.waitForTimeout(500);await p.getByRole('button',{name:'Alle 1 Treffer ausschließen'}).click();await p.waitForTimeout(400);out.push({case:'current-search-bulk',search:await p.getByLabel('Song, Künstler oder Album').inputValue(),draft:await p.locator('.selection__rules').innerText()});await h.context.close();
}
{
 let h=await boot(),p=h.page;h.set('previewFail',true);await p.getByRole('button',{name:/Ausschließen: Alpha/}).click();await p.getByRole('alert').filter({hasText:'Vorschau nicht möglich'}).waitFor();out.push({case:'failed-preview-apply',enabled:await p.getByRole('button',{name:'Auswahl übernehmen'}).isEnabled(),counts:await p.locator('.notice').filter({hasText:'Jetzt in Kraft:'}).last().innerText()});await h.context.close();
}
{
 let h=await boot(),p=h.page;await p.getByRole('button',{name:/Ausschließen: Alpha/}).click();await p.waitForTimeout(400);h.set('apply',true);await p.getByRole('button',{name:'Auswahl übernehmen'}).click();await p.getByRole('button',{name:/Ausschließen: Beta/}).click();await p.waitForTimeout(400);const before=await p.locator('.selection__rules').innerText();h.release();await p.waitForTimeout(150);const after=await p.locator('.selection__rules').innerText();out.push({case:'edit-during-apply',before,after,posted:h.applies});await h.context.close();
}

for (const status of [503,409]) {
 let h=await boot(),p=h.page;await p.getByRole('button',{name:/Ausschließen: Alpha/}).click();await p.waitForTimeout(400);h.set('apply',true);h.set('applyFail',status);await p.getByRole('button',{name:'Auswahl übernehmen'}).click();await p.getByRole('button',{name:/Ausschließen: Beta/}).click();await p.waitForTimeout(400);h.release();await p.waitForTimeout(500);out.push({case:'apply-error-retains-draft',status,draft:await p.locator('.selection__rules').innerText(),message:await p.locator('body').innerText()});await h.context.close();
}
{
 let h=await boot(),p=h.page;h.set('apply',true);await p.getByRole('button',{name:'Import ausschalten'}).click();await p.getByRole('button',{name:/Ausschließen: Beta/}).click();await p.waitForTimeout(400);h.release();await p.waitForTimeout(500);out.push({case:'toggle-retains-draft',draft:await p.locator('.selection__rules').innerText(),message:await p.locator('body').innerText(),posted:h.applies});await h.context.close();
}
{
 let h=await boot(),p=h.page;h.set('deleteFail',true);await p.getByRole('button',{name:/Import löschen …/}).click();await p.getByRole('button',{name:'Endgültig löschen'}).click();await p.waitForTimeout(400);out.push({case:'delete-error-honest',message:await p.locator('body').innerText()});await h.context.close();
}
fs.writeFileSync('/tmp/pr30-a858-ui-results.json',JSON.stringify(out,null,2));await browser.close();console.log(out.map(x=>({case:x.case,width:x.width,theme:x.theme,enabled:x.enabled,overflow:x.metrics?.scroll>x.metrics?.width,posted:x.applied||x.posted,errors:x.errors}))); 
