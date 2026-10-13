import { test, expect } from '@playwright/test';
for (const width of [390,1440]) for (const scheme of ['light','dark'] as const) test(`PR27 opener profile ${width} ${scheme}`, async ({page}) => {
 const errors:string[]=[]; page.on('pageerror',e=>errors.push(String(e)));
 await page.setViewportSize({width,height:width===390?844:1000}); await page.emulateMedia({colorScheme:scheme});
 await page.goto('/'); await page.getByRole('link',{name:'Mit Spotify anmelden'}).click(); await expect(page.getByRole('checkbox',{name:/Indie & Gitarren/}).or(page.getByRole('button',{name:/^Alles/}))).toBeVisible(); if(await page.getByText('Wähle, welche Playlists Kassetten werden').isVisible()){await page.getByRole('checkbox',{name:/Indie & Gitarren/}).check(); await page.getByRole('button',{name:'1 Kassette anlegen',exact:true}).click();} await expect(page.getByRole('button',{name:/^Alles/})).toBeEnabled({timeout:60000}); await page.goto('/import');
 const id=(n:number)=>String(n).padStart(22,'Q'); const base=Date.UTC(2024,0,1,12);
 const plays=[{ts:new Date(base).toISOString(),ms_played:180000,spotify_track_uri:`spotify:track:${id(1)}`,master_metadata_track_name:'Ein gehörter Song',master_metadata_album_artist_name:'Hörerin'},
 {ts:new Date(base+10000).toISOString(),ms_played:10000,spotify_track_uri:`spotify:track:${id(2)}`,master_metadata_track_name:'LangerStartsong'.repeat(15),master_metadata_album_artist_name:'LangerKünstlername'.repeat(12),reason_start:'clickrow',reason_end:'fwdbtn'},
 {ts:new Date(base+20000).toISOString(),ms_played:10000,spotify_track_uri:`spotify:track:${id(3)}`,master_metadata_track_name:'Früh weg',master_metadata_album_artist_name:'Hörerin',reason_start:'fwdbtn',reason_end:'fwdbtn'}];
 await page.locator('input[type=file]').setInputFiles({name:'Streaming_History_Audio_2024.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(plays))});
 await expect(page.getByText(/Nicht mitgezählt sind 1 frühe Skips/)).toBeVisible();
 await page.getByRole('button',{name:'Übernehmen'}).click(); await page.getByRole('link',{name:'Dein Hörprofil ansehen'}).click(); await page.getByRole('radio',{name:'Alles',exact:true}).check();
 await expect(page.getByRole('region',{name:'Gleich zum Start weg'})).toContainText('1-mal'); await expect(page.getByRole('region',{name:'Früh übersprungen'})).toContainText('(1-mal)');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(0);
 await page.keyboard.press('Tab'); expect(await page.evaluate(()=>document.activeElement?.tagName)).not.toBe('BODY');
 await page.screenshot({path:`/tmp/pr27-profile-${width}-${scheme}.png`,fullPage:true}); expect(errors).toEqual([]);
});
