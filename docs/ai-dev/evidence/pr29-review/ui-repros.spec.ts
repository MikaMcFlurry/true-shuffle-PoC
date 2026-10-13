/** Rendered client races use intercepted API snapshots; no provider or history writes. */
import { expect, type Page, type Route, test } from "@playwright/test";
import { DEFAULT_RULES } from "../src/core/types";
import type { AppState, DeviceView } from "../src/shared/api";

test.use({ viewport: { width: 390, height: 844 } });

const TIME = Date.UTC(2026, 9, 1, 12);
const tracks = ["Erster Song", "Zweiter Song", "Dritter Song"].map((name, index) => ({
	id: `track-${index}`,
	name,
	artists: "Test Artist",
	album: "Test Album",
	imageUrl: null,
	durationMs: 60_000,
	thumb: 0 as const,
}));
function snapshot(playing = true): AppState {
	return {
		profile: { id: "listener-a", name: "Test Listener", imageUrl: null },
		onboarded: true,
		stations: [
			{
				id: 1,
				name: "Test Sender",
				kind: "all",
				sources: [],
				rules: { ...DEFAULT_RULES },
				roundNo: 1,
				poolSize: 3,
				freshRemaining: 3,
				progress: 0,
				playlistId: null,
				ready: true,
				importing: false,
				lastPlayedAt: TIME,
				playing,
				imageUrl: null,
			},
		],
		session: {
			sessionId: "session-a",
			stationId: 1,
			entryId: "entry-0",
			orderRevision: 1,
			progressMs: 12_000,
			observedAt: TIME,
			status: playing ? "active" : "paused",
			pending: false,
			// Copies: a test that changes a song must not change it for the next one.
			queue: tracks.map((track, index) => ({ entryId: `entry-${index}`, track: { ...track } })),
		},
		nowPlaying: {
			...tracks[0]!,
			isPlaying: playing,
			progressMs: 12_000,
			stationId: 1,
			kind: "fresh",
			deviceName: "Test iPhone",
			orderBroken: false,
			smartShuffle: false,
			observedAt: TIME,
		},
		guest: { active: false, until: null },
		warnings: [],
		jobs: [],
		history: { importedTracks: 0, importedAt: null, liveSince: TIME },
		aiSource: "off",
		serverTime: TIME,
	};
}
function deferred() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
async function setup(page: Page, initial = snapshot()) {
	const model = {
		state: initial,
		stateCalls: 0,
		stateQueries: [] as string[],
		requests: [] as string[],
		devices: [
			{ id: "iphone", name: "Test iPhone", active: true, restricted: false, type: "Smartphone" },
		] as DeviceView[],
		stateHandler: null as ((route: Route) => Promise<void>) | null,
	};
	await page.clock.install({ time: TIME });
	await page.clock.setFixedTime(TIME);
	await page.route("**/api/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		model.requests.push(path);
		if (path === "/api/state") {
			model.stateCalls++;
			model.stateQueries.push(new URL(route.request().url()).search);
			if (model.stateHandler) return model.stateHandler(route);
			return route.fulfill({ json: model.state });
		}
		if (path === "/api/devices") return route.fulfill({ json: model.devices });
		if (path === "/api/native/devices")
			return route.fulfill({ json: { configured: false, devices: [] } });
		return route.fulfill({
			status: 500,
			json: { error: { code: "unexpected", message: `Unexpected ${path}` } },
		});
	});
	await page.goto("/");
	await expect(page.locator(".now-copy h2")).toHaveText("Erster Song");
	await expect(
		page.locator(".device-select select option", { hasText: "Test iPhone" }),
	).toHaveCount(1);
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
	).toBeLessThanOrEqual(0);
	return model;
}
async function advance(page: Page, milliseconds: number) {
	const now = await page.evaluate(() => Date.now());
	await page.clock.setFixedTime(now + milliseconds);
	await page.clock.runFor(milliseconds);
}
async function refresh(page: Page) {
	const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/state");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await response;
}
function observe(
	model: { state: AppState },
	patch: Partial<NonNullable<AppState["session"]>>,
	at: number,
) {
	Object.assign(model.state.session!, patch, { observedAt: at });
	model.state.serverTime = at;
	if (model.state.nowPlaying)
		Object.assign(model.state.nowPlaying, {
			observedAt: at,
			progressMs: patch.progressMs ?? model.state.nowPlaying.progressMs,
		});
}


for (const width of [390,1440]) for (const theme of ["light","dark"] as const) {
 test(`probe render keyboard and settings ${width} ${theme}`, async ({ page }) => {
  await page.setViewportSize({width,height:900}); await page.emulateMedia({colorScheme:theme});
  const initial=snapshot(); initial.nowPlaying!.kind="probe";
  initial.nowPlaying!.name="SehrLangerSongtitel".repeat(9); initial.session!.queue[0]!.track.name=initial.nowPlaying!.name;
  initial.nowPlaying!.artists="SehrLangerKünstlername".repeat(7);initial.session!.queue[0]!.track.artists=initial.nowPlaying!.artists;
  const model=await setupLong(page,initial);
  const box=page.getByRole("group",{name:"Nachprüfung"}); await expect(box).toBeVisible();
  const yes=box.getByRole("button",{name:"Gern wieder"});await yes.focus(); await expect(yes).toBeFocused();
  const dims=await yes.boundingBox(); expect(dims!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({path:`/tmp/pr29-ui-home-${width}-${theme}.png`,fullPage:true});
  await page.route("**/api/tracks/*/retest",r=>r.fulfill({status:503,json:{error:{code:"unavailable",message:"Gerät ist nicht erreichbar."}}}));
  await yes.press("Enter");await expect(page.getByText("Gerät ist nicht erreichbar.",{exact:true})).toBeVisible();
  await expect(yes).toBeEnabled();await expect(box.getByRole("status")).toHaveCount(0);
  await page.route("**/api/tracks/*/retest",r=>r.abort("internetdisconnected"));
  await yes.click(); await expect(page.getByText("Keine Verbindung — bist du online?",{exact:true})).toBeVisible();
  await expect(yes).toBeEnabled();
 });
}
async function setupLong(page:Page,initial:AppState){
 const model={state:initial,requests:[] as string[]};await page.clock.install({time:TIME});await page.clock.setFixedTime(TIME);
 await page.route("**/api/**", async route=>{const path=new URL(route.request().url()).pathname;model.requests.push(path);
 if(path==="/api/state")return route.fulfill({json:model.state});
 if(path==="/api/devices")return route.fulfill({json:[{id:"iphone",name:"Test iPhone",active:true,restricted:false,type:"Smartphone"}]});
 if(path==="/api/native/devices")return route.fulfill({json:{configured:false,devices:[]}});
 return route.fulfill({status:500,json:{error:{code:"unexpected",message:`Unexpected ${path}`}}});});
 await page.goto("/");await expect(page.locator(".now-copy h2")).toHaveText(initial.nowPlaying!.name);return model;
}
test("two opposite pending answers can overwrite the last choice",async({page})=>{
 const initial=snapshot();initial.nowPlaying!.kind="probe";await setup(page,initial);
 const yesGate=deferred();const answers:boolean[]=[];let saved:boolean|null=null;
 await page.route("**/api/tracks/*/retest",async route=>{const keep=route.request().postDataJSON().keep;answers.push(keep);saved=keep;if(keep)await yesGate.promise;await route.fulfill({json:{skipped:false}})});
 const box=page.getByRole("group",{name:"Nachprüfung"});await box.getByRole("button",{name:"Gern wieder"}).click();await expect.poll(()=>answers.length).toBe(1);
 await box.getByRole("button",{name:"Eher nicht"}).click();await expect.poll(()=>answers.length).toBe(2);
 await expect(box.getByRole("status")).toContainText("Er kommt seltener");expect(saved).toBe(false);
 yesGate.release();await expect(box.getByRole("status")).toContainText("kommt wieder wie jeder andere");expect(saved).toBe(false);await expect(box.getByRole("status")).toContainText("kommt wieder wie jeder andere");
 console.log("PR29 pending repro",JSON.stringify({answers,saved,lastIntent:false,status:await box.getByRole("status").textContent()}));
 await expect(box.getByRole("status"),"late acknowledgement must not contradict the last saved answer").toContainText("Er kommt seltener",{timeout:1000});
});
test("old account answer does not answer new account same song",async({page})=>{
 const initial=snapshot();initial.nowPlaying!.kind="probe";const model=await setup(page,initial);const gate=deferred();let asked=false;
 await page.route("**/api/tracks/*/retest",async route=>{asked=true;await gate.promise;await route.fulfill({json:{skipped:false}})});
 await page.getByRole("button",{name:"Gern wieder"}).click();await expect.poll(()=>asked).toBe(true);
 model.state.profile.id="listener-b";model.state.session!.sessionId="session-b";model.state.session!.entryId="entry-b";model.state.session!.queue[0]!.entryId="entry-b";
 await refresh(page);gate.release();await page.waitForResponse(r=>r.url().endsWith("/retest"));
 await expect(page.getByRole("button",{name:"Gern wieder"})).toBeVisible({timeout:1000});
});
test("negative native verdict preserves honest transport result",async({page})=>{
 const initial=snapshot();initial.nowPlaying!.kind="probe";initial.session!.controller={kind:"home-assistant",deviceId:"living-room",deviceName:"Wohnzimmer"};
 const model=await setup(page,initial);let asked=false;
 await page.route("**/api/tracks/*/retest",async route=>{asked=true;await route.fulfill({json:{skipped:false,skipError:"Gerät ist nicht erreichbar."}})});
 await page.getByRole("button",{name:"Eher nicht"}).click();await expect.poll(()=>asked).toBe(true);
 await expect(page.getByText("Gerät ist nicht erreichbar.",{exact:true})).toBeVisible({timeout:1000});
});

test("same song new observed occurrence must ask again",async({page})=>{
 const initial=snapshot();initial.nowPlaying!.kind="probe";const model=await setup(page,initial);
 await page.route("**/api/tracks/*/retest",route=>route.fulfill({json:{skipped:false}}));
 await page.getByRole("button",{name:"Eher nicht"}).click();await expect(page.getByRole("group",{name:"Nachprüfung"}).getByRole("status")).toBeVisible();
 model.state.nowPlaying={...model.state.nowPlaying!,...tracks[1]!,kind:"fresh"};model.state.session!.entryId="entry-1";await refresh(page);
 await expect(page.locator(".now-copy h2")).toHaveText("Zweiter Song");
 model.state.nowPlaying={...model.state.nowPlaying!,...tracks[0]!,kind:"probe"};model.state.session!.queue.push({entryId:"entry-retest-new",track:{...tracks[0]!}});model.state.session!.entryId="entry-retest-new";
 await refresh(page);await expect(page.locator(".now-copy h2")).toHaveText("Erster Song");
 await expect(page.getByRole("button",{name:"Gern wieder"})).toBeVisible({timeout:1000});
});
for (const width of [390,1440]) for (const theme of ["light","dark"] as const) test(`station switch ${width} ${theme}`,async({page})=>{
 await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});const initial=snapshot();const model=await setup(page,initial);
 const detail={...initial.stations[0]!,upcoming:[],recent:[],counts:null,discoveries:{pending:0,kept:0,rejected:0}};
 await page.route("**/api/stations/1",async r=>{if(r.request().method()==="PATCH"){Object.assign(detail.rules,r.request().postDataJSON().rules);await r.fulfill({json:{ok:true}});}else await r.fulfill({json:detail});});
 await page.evaluate(()=>{history.pushState({},"","/sender/1");window.dispatchEvent(new PopStateEvent("popstate"));});
 await page.getByText("Erweitert",{exact:true}).click();const sw=page.getByRole("switch",{name:"Nachprüfung"});await expect(sw).toBeChecked();await sw.focus();await sw.press("Space");await expect(sw).not.toBeChecked();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(0);await page.screenshot({path:`/tmp/pr29-ui-station-${width}-${theme}.png`,fullPage:true});
 await page.evaluate(()=>{history.pushState({},"","/");window.dispatchEvent(new PopStateEvent("popstate"));});await expect(page.locator(".now-copy h2")).toHaveText("Erster Song");
});
