import {chromium} from '/workspace/ts-review-4b0a/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
const old=await browser.newContext({storageState:'/tmp/pr19-browser-state.json'});
const state=await(await old.request.get('http://127.0.0.1:8797/api/state')).json();
await old.close();
const context=await browser.newContext({viewport:{width:390,height:844},locale:'de-DE'});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
let pending=false, fail=false;
const name='Ein sehr langer Partyraum-Gerätename für alle Gäste am Wochenende'.repeat(2);
state.guest={active:false,until:null,devices:[]};
const dev={id:'review-party',name,type:'Speaker',isActive:false,isRestricted:false};
await page.route('**/api/**',async route=>{
 const p=new URL(route.request().url()).pathname;
 if(p==='/api/guest/devices'){
  if(pending)await new Promise(r=>setTimeout(r,500));
  if(fail)return route.fulfill({status:503,json:{error:{message:'review unavailable'}}});
  state.guest.devices=route.request().postDataJSON().devices;
  return route.fulfill({json:state.guest.devices});
 }
 return route.fulfill({json:p==='/api/state'?state:p==='/api/devices'?[dev]:p==='/api/native/devices'?{configured:false,devices:[]}:p==='/api/health'?{ok:true,configured:true}:{}});
});
const evidence={subject:'44379ae75b6ac9bebf7d9e951b71273fce686035',environment:'Built combined client, mocked API; no backend/provider acceptance',renders:[],checks:[],errors};
for(const width of [390,1440])for(const scheme of ['light','dark']){
 await page.setViewportSize({width,height:width===390?844:1000});await page.emulateMedia({colorScheme:scheme});
 await page.goto('http://127.0.0.1:8841/geraete');await page.getByRole('switch',{name:name+': immer im Gast-Modus'}).waitFor();
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert.equal(overflow,0);
 await page.screenshot({path:`/tmp/pr19-21-guest-${width}-${scheme}.png`,fullPage:true});evidence.renders.push({width,scheme,overflow});
}
const sw=page.getByRole('switch',{name:name+': immer im Gast-Modus'});pending=true;
await sw.focus();await sw.press('Space');assert.equal(await sw.isDisabled(),true);assert.equal(await sw.isChecked(),true);
await page.waitForTimeout(800);assert.equal(await sw.isChecked(),true);evidence.checks.push('keyboard toggle/pending disabled/success confirmed');
fail=true;await sw.press('Space');await page.waitForTimeout(800);assert.equal(await sw.isChecked(),true);assert.match(await page.locator('body').innerText(),/Nicht gespeichert/);evidence.checks.push('503 error visible, confirmed selection restored');
await context.setOffline(true);await sw.press('Space');await page.waitForTimeout(800);await context.setOffline(false);assert.equal(await sw.isChecked(),true);evidence.checks.push('offline write preserves confirmed selection');
await page.getByRole('link',{name:'Mehr',exact:true}).click();await page.getByRole('link',{name:/Geräte/}).click();await sw.waitFor();assert.equal(await sw.isChecked(),true);evidence.checks.push('navigation retains saved devices');
fs.writeFileSync('/tmp/pr19-21-guest-ui.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));await browser.close();
