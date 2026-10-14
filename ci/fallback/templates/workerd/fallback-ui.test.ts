/**
 * The built fallback surface in a real local workerd (wrangler dev), against
 * the Spotify stand-in (source/e2e/fake-server.ts): one persisted state, three
 * phases with the same Worker source and different built assets —
 *   1. current surface (artifacts/b201/client): synthetic import, selection
 *      (switched off + an artist rule), +1 from the Verlauf with its receipt;
 *   2. fallback surface (artifacts/fallback/client): served bytes = artifact,
 *      selection said honestly and in force, no selection controls, a new
 *      synthetic import through its import page, -1 from its rating sheet;
 *   3. current surface again: the old receipt cannot take the -1 back, the
 *      same decision sent again stores nothing, selection and rules intact.
 * Synthetic data only; no production, no live Spotify, no audio.
 */
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { type BrowserContext, chromium, expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, it } from "vitest";

const FB = "__FALLBACK_ROOT__";
const SRC = `${FB}/source`;
const ORIGIN = "http://127.0.0.1:20987";
const FAKE_PORT = "20988";
const STATE = `${FB}/tests/workerd/state`;
const SHOTS = `${FB}/tests/workerd/shots`;
mkdirSync(SHOTS, { recursive: true });

const env = {
	...process.env,
	WRANGLER_CACHE_DIR: `${FB}/cache/wrangler`,
	WRANGLER_LOG_PATH: `${FB}/wrangler-logs`,
	XDG_CONFIG_HOME: `${FB}/wrangler-home`,
	WRANGLER_SEND_METRICS: "false",
	FAKE_PORT,
};
const log = (what: string, data: unknown) => console.log(`${what} ${JSON.stringify(data)}`);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

let fake: ChildProcess | null = null;
let worker: ChildProcess | null = null;
let context: BrowserContext;
let page: Page;

/** Ends a process this test started, with its children (wrangler → workerd); nothing else. */
function stop(p: ChildProcess | null) {
	if (p?.pid) execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: "ignore" });
}
async function waitFor(url: string, ok: (r: Response) => boolean) {
	for (let i = 0; i < 240; i++) {
		try {
			if (ok(await fetch(url))) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`fixture: ${url} did not come up`);
}
async function startWorker(surface: "b201" | "fallback") {
	stop(worker);
	await new Promise((r) => setTimeout(r, 1500));
	worker = spawn(
		"npx",
		[
			"wrangler",
			"dev",
			"-c",
			`${FB}/tests/workerd/wrangler.${surface}.jsonc`,
			"--port",
			"20987",
			"--ip",
			"127.0.0.1",
			"--persist-to",
			STATE,
			"--show-interactive-dev-session=false",
		],
		{ cwd: SRC, env, shell: true, stdio: ["ignore", "inherit", "inherit"] },
	);
	await waitFor(`${ORIGIN}/api/health`, (r) => r.ok);
	log("worker-up", { surface, pid: worker.pid });
}

const post = (url: string, data: unknown = {}) =>
	page.request.post(`${ORIGIN}${url}`, { headers: { "x-ts": "1" }, data });
const get = async <T>(url: string) => (await (await page.request.get(`${ORIGIN}${url}`)).json()) as T;

interface Sel {
	revision: number;
	selection: { enabled: boolean; rules: unknown[] };
	dataset: { key: string; hasImport: boolean; coverage: string };
}
interface St {
	stations: { id: number }[];
	history: { importedTracks: number; effectiveTracks?: number; enabled?: boolean; rules?: number };
}
interface Lookup {
	receipt: { id: string; value: number; superseded: boolean } | null;
	current?: { value: number; seq: number };
}

/** The served page and its script are the declared artifact's bytes. */
async function servedIs(surface: "b201" | "fallback") {
	const html = await (await page.request.get(`${ORIGIN}/`)).text();
	const want = readFileSync(`${FB}/artifacts/${surface}/client/index.html`, "utf8");
	expect(html).toBe(want);
	const js = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)![1]!;
	const served = await (await page.request.get(`${ORIGIN}${js}`)).body();
	expect(sha(served)).toBe(sha(readFileSync(`${FB}/artifacts/${surface}/client${js}`)));
	log("served", { surface, js, sha256: sha(served) });
	return js;
}

async function shot(name: string) {
	await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/** Synthetic plays for the import page: four plays each of six library songs. */
function playsFile(songs: { id: string; name: string; artists: string }[], year: number) {
	return songs.flatMap((s, k) =>
		Array.from({ length: 4 }, (_, i) => ({
			ts: new Date(Date.UTC(year, 1 + k, 1 + i, 12)).toISOString(),
			ms_played: 200_000,
			spotify_track_uri: `spotify:track:${s.id}`,
			master_metadata_track_name: s.name,
			master_metadata_album_artist_name: s.artists,
			reason_start: "trackdone",
			reason_end: "trackdone",
			skipped: false,
		})),
	);
}

beforeAll(async () => {
	fake = spawn("node", ["e2e/fake-server.ts"], { cwd: SRC, env, shell: true, stdio: "ignore" });
	await waitFor(`http://127.0.0.1:${FAKE_PORT}/__control/status`, (r) => r.ok);
	const browser = await chromium.launch();
	context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "de-DE" });
	page = await context.newPage();
	page.on("pageerror", (e) => log("PAGE ERROR", e.message));
}, 300_000);

afterAll(async () => {
	await context?.browser()?.close();
	stop(worker);
	stop(fake);
});

it("b201 → fallback surface → b201: selection and later ratings kept, the served surface is the artifact", async () => {
	// ---- Phase 1: the current surface.
	await startWorker("b201");
	const b201Js = await servedIs("b201");
	await page.goto(`${ORIGIN}/`);
	await expect(page.locator('meta[name="ts-surface"]')).toHaveCount(0);
	await page.getByRole("link", { name: "Mit Spotify anmelden" }).click();
	const onboarding = page.getByText("Wähle, welche Playlists Kassetten werden");
	const home = page.getByRole("button", { name: /^Alles/ });
	await expect(onboarding.or(home)).toBeVisible({ timeout: 60_000 });
	if (await onboarding.isVisible()) {
		await page.getByRole("checkbox", { name: /Indie & Gitarren/ }).check();
		await page.getByRole("button", { name: /Kassetten? anlegen/ }).click();
	}
	await expect(home).toBeEnabled({ timeout: 120_000 });
	const st0 = await get<St>("/api/state");
	const stationId = st0.stations[0]!.id;
	let detail: { upcoming: { id: string; name: string; artists: string }[] } = { upcoming: [] };
	await expect
		.poll(
			async () => {
				detail = await get(`/api/stations/${stationId}`);
				return detail.upcoming?.length ?? 0;
			},
			{ timeout: 120_000, intervals: [2_000] },
		)
		.toBeGreaterThanOrEqual(6);
	log("phase1-upcoming", detail.upcoming.slice(0, 6).map((s) => [s.id, s.artists]));
	const six = detail.upcoming.slice(0, 6);
	const status = async () =>
		(await (await fetch(`http://127.0.0.1:${FAKE_PORT}/__control/status`)).json()) as {
			current: string | null;
			playing: boolean;
		};
	const nowPlaying = async () =>
		(
			await get<{ nowPlaying: { id: string; name: string; artists: string; isPlaying: boolean } | null }>(
				"/api/state?live=1&refresh=1",
			)
		).nowPlaying;
	// The deck plays (stand-in phone); the song playing is the one rated in every phase.
	expect((await post(`/api/stations/${stationId}/play`, { deviceId: "mika-phone" })).ok()).toBe(true);
	let playingNow: Awaited<ReturnType<typeof nowPlaying>> = null;
	await expect
		.poll(
			async () => {
				playingNow = await nowPlaying();
				return !!playingNow?.isPlaying;
			},
			{ timeout: 60_000, intervals: [1_000, 3_000] },
		)
		.toBe(true);
	const target = { id: playingNow!.id, name: playingNow!.name, artists: playingNow!.artists };
	const excluded = six.find((x) => x.artists !== target.artists)!.artists;
	// Synthetic import with the current protocol, then the selection: switched off, one artist rule.
	const start = (await (await post("/api/history/begin")).json()) as { start: number };
	const at = Date.parse("2024-03-01T12:00:00Z");
	const totals = (await (
		await post("/api/history/import", {
			start: start.start,
			rows: six.map((s) => [s.id, 4, 0, at, at, 4]),
			part: 0,
			parts: 1,
		})
	).json()) as { upload: string };
	expect(totals.upload).toBeTruthy();
	let sel = await get<Sel>("/api/history/selection");
	const applied = await post("/api/history/selection", {
		baseRevision: sel.revision,
		enabled: false,
		rules: [{ type: "artist", kind: "exclude", name: excluded }],
		dataset: sel.dataset.key,
	});
	expect(applied.ok()).toBe(true);
	sel = await get<Sel>("/api/history/selection");
	log("phase1-selection", sel);
	// +1 from the Verlauf with its receipt (as the current surface's Verlauf sends it).
	const actionId = "hfallbackbrowser0001";
	const before = await get<Lookup>(`/api/history/ratings/${actionId}?track=${target.id}`);
	const rated = (await (
		await post("/api/history/ratings", {
			actionId,
			trackId: target.id,
			value: 1,
			basis: before.current!.seq,
		})
	).json()) as { kind: string; receipt: { seq: number } };
	expect(rated.kind).toBe("done");
	log("phase1-target", { target, stand_in: await status() });
	await page.goto(`${ORIGIN}/mehr`);
	await expect(page.getByText(/Import ausgeschaltet: er zählt gerade nicht/)).toBeVisible();
	await shot("phase1-b201-mehr");

	// ---- Phase 2: the fallback surface on the same Worker source and state.
	await startWorker("fallback");
	const fallbackJs = await servedIs("fallback");
	expect(fallbackJs).not.toBe(b201Js);
	await page.goto(`${ORIGIN}/mehr`);
	await expect(page.locator('meta[name="ts-surface"]')).toHaveAttribute("content", "fallback-8d");
	// Said honestly: switched off, the rule kept, not changeable here; no selection controls.
	await expect(page.getByText(/Import ausgeschaltet: er zählt gerade nicht\./)).toBeVisible();
	await expect(
		page.getByText(/Die Auswahl lässt sich in dieser Ausgabe von true-shuffle nicht ändern; sie gilt weiter\./),
	).toBeVisible();
	await expect(page.getByRole("link", { name: /Hörverlauf auswählen/ })).toHaveCount(0);
	await shot("phase2-fallback-mehr");
	await page.goto(`${ORIGIN}/auswahl`);
	await expect(page.getByRole("button", { name: "Import ausschalten" })).toHaveCount(0);
	await expect(page.getByRole("heading", { name: /Hörverlauf auswählen/ })).toHaveCount(0);
	const sel2 = await get<Sel>("/api/history/selection");
	expect(sel2).toMatchObject({ revision: sel.revision, selection: sel.selection });
	expect((await get<St>("/api/state")).history).toMatchObject({ effectiveTracks: 0, enabled: false, rules: 1 });
	// -1 from the fallback surface's rating sheet (POST /api/tracks/:id/thumb).
	const thumbs: string[] = [];
	page.on("request", (r) => {
		const p = new URL(r.url()).pathname;
		if (r.method() === "POST" && (/\/thumb$/.test(p) || p.startsWith("/api/history/ratings")))
			thumbs.push(p);
	});
	// Still the same song playing in the deck; the fallback surface's „Jetzt“ rates it with its old keys.
	expect((await nowPlaying())?.id).toBe(target.id);
	await page.goto(`${ORIGIN}/`);
	await page.getByRole("button", { name: "Daumen runter: diesen Song nie wieder" }).click();
	await expect
		.poll(async () => (await get<Lookup>(`/api/history/ratings/${actionId}?track=${target.id}`)).current?.value)
		.toBe(-1);
	expect(thumbs).toEqual([`/api/tracks/${target.id}/thumb`]);
	// „Nie wieder“ on the song playing: skipped once, as the 8d keys always did.
	await expect.poll(async () => (await status()).current).not.toBe(target.id);
	const playingAfter = await status();
	log("phase2-skip", playingAfter);
	const afterFallback = await get<Lookup>(`/api/history/ratings/${actionId}?track=${target.id}`);
	log("phase2-after-sheet", afterFallback);
	expect(afterFallback.receipt?.superseded).toBe(true);
	expect(afterFallback.current!.seq).toBeGreaterThan(rated.receipt.seq);
	await shot("phase2-fallback-rated");

	// A new synthetic import through the fallback surface's own import page.
	const sent: string[] = [];
	const answers: { url: string; status: number }[] = [];
	page.on("request", (r) => {
		if (r.method() === "POST" && /\/api\/history\/(begin|import|listens)$/.test(new URL(r.url()).pathname))
			sent.push(new URL(r.url()).pathname);
	});
	page.on("response", (r) => {
		if (/\/api\/history\/(begin|import|listens)$/.test(new URL(r.url()).pathname))
			answers.push({ url: new URL(r.url()).pathname, status: r.status() });
	});
	await page.goto(`${ORIGIN}/import`);
	await expect(page.getByText(/Dein Import ist ausgeschaltet; ein neuer bleibt es auch\./)).toBeVisible();
	await page.locator('input[type="file"]').setInputFiles({
		name: "Streaming_History_Audio_2023.json",
		mimeType: "application/json",
		buffer: Buffer.from(JSON.stringify(playsFile(six, 2023))),
	});
	await page.getByRole("button", { name: "Übernehmen" }).click();
	await expect(page.getByRole("heading", { name: "Übernommen. Das ist jetzt anders:" })).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.getByText(/Das Hörprofil wurde nicht gespeichert/)).toHaveCount(0);
	log("phase2-import-requests", { sent, answers });
	expect(sent[0]).toBe("/api/history/begin");
	expect(sent).toContain("/api/history/import");
	expect(sent).toContain("/api/history/listens");
	expect(answers.every((a) => a.status === 200)).toBe(true);
	await shot("phase2-fallback-import-done");
	const sel3 = await get<Sel>("/api/history/selection");
	log("phase2-selection-after-import", sel3);
	expect(sel3.revision).toBe(sel.revision);
	expect(sel3.selection).toEqual(sel.selection);
	expect(sel3.dataset.key).not.toBe(sel.dataset.key);
	expect(sel3.dataset.coverage).toBe("events");
	expect((await get<St>("/api/state")).history).toMatchObject({ effectiveTracks: 0, enabled: false, rules: 1 });
	// ---- Phase 3: the current surface again.
	await startWorker("b201");
	await servedIs("b201");
	await page.goto(`${ORIGIN}/mehr`);
	await expect(page.locator('meta[name="ts-surface"]')).toHaveCount(0);
	await expect(page.getByText(/Import ausgeschaltet: er zählt gerade nicht/)).toBeVisible();
	const undo = (await (await post(`/api/history/ratings/${actionId}/undo`)).json()) as {
		receipt: { undo: { outcome: string } } | null;
	};
	log("phase3-undo", undo);
	expect(undo.receipt?.undo.outcome).toBe("conflict");
	// Taking back moves no playback.
	const later = await status();
	expect({ current: later.current, playing: later.playing }).toEqual({
		current: playingAfter.current,
		playing: playingAfter.playing,
	});
	const again = (await (
		await post("/api/history/ratings", { actionId, trackId: target.id, value: 1, basis: before.current!.seq })
	).json()) as { kind: string };
	expect(again.kind).toBe("done");
	const now = await get<Lookup>(`/api/history/ratings/${actionId}?track=${target.id}`);
	expect(now.current).toEqual(afterFallback.current);
	expect((await get<Sel>("/api/history/selection")).selection).toEqual(sel.selection);
	await page.goto(`${ORIGIN}/`);
	await shot("phase3-b201-jetzt");
	// Switched on again here (the current surface edits the selection): the kept rule applies.
	const cur = await get<Sel>("/api/history/selection");
	expect(
		(
			await post("/api/history/selection", {
				baseRevision: cur.revision,
				enabled: true,
				rules: cur.selection.rules,
				dataset: cur.dataset.key,
			})
		).ok(),
	).toBe(true);
	const hist = (await get<St>("/api/state")).history;
	log("phase3-enabled", hist);
	const kept = six.filter((s) => s.artists !== excluded).length;
	expect(hist).toMatchObject({ enabled: true, rules: 1, effectiveTracks: kept });
}, 900_000);
