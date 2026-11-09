/**
 * The rating sheet (RateHit → RateSheet) through refusals, a lost connection,
 * a pending double tap, a late answer after the sheet moved on to another song
 * or another account, and a stored rating whose skip failed (CTO RATE-SHEET,
 * 2026-10-15). Rendered client against intercepted API snapshots: the stand-in
 * stores a rating per account when the request arrives, answers when the test
 * lets it. No provider, no history writes, no audio.
 */
import { type BrowserContext, expect, type Page, type Route, test } from "@playwright/test";
import { DEFAULT_RULES } from "../src/core/types";
import type { AppState } from "../src/shared/api";

/** The release notice (e2e/release-notes.spec.ts) is closed the normal way, by its own key, wherever it opens. */
function acknowledgeRelease(context: BrowserContext): void {
	const handle = (p: Page) =>
		void p.addLocatorHandler(p.getByRole("dialog", { name: /^Neu in Version / }), (d) =>
			d.getByRole("button", { name: "Verstanden" }).click(),
		);
	for (const p of context.pages()) handle(p);
	context.on("page", handle);
}
test.beforeEach(({ context }) => acknowledgeRelease(context));

test.use({ viewport: { width: 390, height: 844 } });

const TIME = Date.UTC(2026, 9, 1, 12);
const song = (id: string, name: string) => ({
	id,
	name,
	artists: "Test Artist",
	album: "Test Album",
	imageUrl: null,
	durationMs: 180_000,
	thumb: 0 as -1 | 0 | 1,
});
const A = song("track-a", "Song A");
const B = song("track-b", "Song B");
const C = song("track-c", "Song C");

function snapshot(profile = "listener-a"): AppState {
	return {
		profile: { id: profile, name: "Test Listener", imageUrl: null },
		onboarded: true,
		stations: [
			{
				id: 1,
				name: "Test Sender",
				kind: "all",
				sources: [],
				rules: DEFAULT_RULES,
				roundNo: 1,
				poolSize: 3,
				freshRemaining: 3,
				progress: 0,
				playlistId: null,
				ready: true,
				importing: false,
				lastPlayedAt: TIME,
				playing: true,
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
			status: "active",
			pending: false,
			queue: [
				{ entryId: "entry-0", track: { ...A } },
				{ entryId: "entry-1", track: { ...B } },
				{ entryId: "entry-2", track: { ...C } },
			],
		},
		nowPlaying: {
			...A,
			isPlaying: true,
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

interface Held {
	body: Record<string, unknown>;
	answer: () => Promise<void>;
	/** The answer is lost on its way back (the rating is stored already). */
	lose?: () => Promise<void>;
}

async function setup(page: Page) {
	const model = {
		state: snapshot(),
		/** Ratings stored per account: `${profile}:${track}`. */
		thumbs: new Map<string, -1 | 0 | 1>(),
		writes: [] as { profile: string; track: string; value: unknown; expected: unknown }[],
		held: [] as Held[],
		mode: "hold" as "hold" | "now" | "503" | "offline",
		skipError: null as string | null,
		/** Answer snapshot reads with 401 (signed out) while set. */
		signedOut: false,
		/** How the held answers end: stored, or refused (503, nothing stored). */
		heldOutcome: "stored" as "stored" | "503",
	};
	await page.clock.install({ time: TIME });
	await page.clock.setFixedTime(TIME);
	await page.route("**/api/**", async (route: Route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const profile = model.state.profile.id;
		if (path === "/api/state" && model.signedOut)
			return route.fulfill({
				status: 401,
				json: { error: { code: "signed_out", message: "Nicht angemeldet" } },
			});
		if (path === "/api/state") {
			const s = structuredClone(model.state);
			for (const e of s.session?.queue ?? [])
				e.track.thumb = model.thumbs.get(`${profile}:${e.track.id}`) ?? 0;
			if (s.nowPlaying) s.nowPlaying.thumb = model.thumbs.get(`${profile}:${s.nowPlaying.id}`) ?? 0;
			return route.fulfill({ json: s });
		}
		if (path === "/api/devices")
			return route.fulfill({
				json: [
					{
						id: "iphone",
						name: "Test iPhone",
						active: true,
						restricted: false,
						type: "Smartphone",
					},
				],
			});
		if (path === "/api/native/devices")
			return route.fulfill({ json: { configured: false, devices: [] } });
		const thumb = /^\/api\/tracks\/([^/]+)\/thumb$/.exec(path);
		if (thumb) {
			const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
			model.writes.push({ profile, track: thumb[1]!, value: body.value, expected: body.expected });
			if (model.mode === "offline") return route.abort("internetdisconnected");
			if (model.mode === "503")
				return route.fulfill({
					status: 503,
					json: { error: { code: "unavailable", message: "Synthetic 503" } },
				});
			if (model.mode === "hold" && model.heldOutcome === "503") {
				model.held.push({
					body,
					answer: () =>
						route.fulfill({
							status: 503,
							json: { error: { code: "unavailable", message: "Synthetic 503" } },
						}),
				});
				return;
			}
			model.thumbs.set(`${profile}:${thumb[1]}`, body.value as -1 | 0 | 1);
			const json =
				body.value === -1 && model.skipError
					? { skipped: false, skipError: model.skipError }
					: { skipped: false };
			const answer = () => route.fulfill({ json });
			if (model.mode === "now") return answer();
			model.held.push({ body, answer, lose: () => route.abort("connectionreset") });
			return;
		}
		return route.fulfill({
			status: 500,
			json: { error: { code: "unexpected", message: `Unexpected ${path}` } },
		});
	});
	await page.goto("/");
	await expect(page.locator(".now-copy h2")).toHaveText("Song A");
	return model;
}

const row = (page: Page, name: string) =>
	page.locator(".queue-row").filter({ has: page.locator("strong", { hasText: name }) });
const openSheet = async (page: Page, name: string) => {
	await page.getByRole("button", { name: `${name} — Test Artist bewerten` }).click();
	const sheet = page.getByRole("dialog");
	await expect(sheet).toBeVisible();
	await expect(sheet.locator("#rate-title")).toHaveText(name);
	return sheet;
};
const up = (sheet: ReturnType<Page["getByRole"]>) =>
	sheet.getByRole("button", { name: "Daumen hoch: Favorit" });
const down = (sheet: ReturnType<Page["getByRole"]>) =>
	sheet.getByRole("button", { name: "Daumen runter: nie wieder" });
const favMark = (page: Page, name: string) => row(page, name).getByRole("img", { name: "Favorit" });

for (const failure of ["503", "offline"] as const)
	test(`RATE-SHEET a ${failure} failure keeps the sheet, the song and the choice, says so, and retries on request`, async ({
		page,
	}) => {
		const model = await setup(page);
		const sheet = await openSheet(page, "Song B");
		model.mode = failure;
		await up(sheet).click();
		// Not stored: the sheet stays on Song B and says why; no success is claimed.
		await expect(sheet).toBeVisible();
		await expect(sheet.locator("#rate-title")).toHaveText("Song B");
		await expect(sheet.getByRole("alert")).toHaveText(
			failure === "503"
				? /^Nicht gespeichert: Synthetic 503/
				: /^Speicherung nicht bestätigt: Keine Verbindung/,
		);
		await expect(page.locator(".flash")).not.toHaveText("Als Favorit gemerkt");
		await expect(favMark(page, "Song B")).toHaveCount(0);
		expect(model.writes.length).toBe(1);
		// The explicit retry sends the same choice once more; stored, the sheet closes.
		model.mode = "now";
		await sheet.getByRole("button", { name: "Nochmal speichern" }).click();
		await expect(sheet).toBeHidden();
		await expect(favMark(page, "Song B")).toBeVisible();
		expect(model.writes.map((w) => [w.track, w.value])).toEqual([
			["track-b", 1],
			["track-b", 1],
		]);
		// The sheet names no occurrence: the server only rates (never skips) for it.
		expect(model.writes.every((w) => w.expected === undefined)).toBe(true);
	});

test("RATE-SHEET pending: a double tap writes once; the sheet stays until the rating is stored", async ({
	page,
}) => {
	const model = await setup(page);
	const sheet = await openSheet(page, "Song B");
	await up(sheet).click();
	await up(sheet).dblclick({ force: true });
	await page.waitForTimeout(300);
	expect(model.writes.length).toBe(1);
	await expect(sheet).toBeVisible();
	await expect(page.locator(".flash")).not.toHaveText("Als Favorit gemerkt");
	await model.held.pop()!.answer();
	await expect(sheet).toBeHidden();
	await expect(favMark(page, "Song B")).toBeVisible();
	expect(model.writes.length).toBe(1);
});

test("RATE-SHEET a late answer after the sheet moved on to another song neither closes nor changes the newer sheet", async ({
	page,
}) => {
	const model = await setup(page);
	const first = await openSheet(page, "Song B");
	await up(first).click();
	// Cancelled while on its way (allowed), then the sheet is opened for Song C.
	await first.getByRole("button", { name: "Abbrechen" }).click();
	await expect(first).toBeHidden();
	const second = await openSheet(page, "Song C");
	await model.held.pop()!.answer();
	await page.waitForTimeout(300);
	// The newer sheet stays open on Song C, untouched; Song B's stored rating shows in its row.
	await expect(second).toBeVisible();
	await expect(second.locator("#rate-title")).toHaveText("Song C");
	await expect(up(second)).toHaveAttribute("aria-pressed", "false");
	await expect(up(second)).toBeEnabled();
	await expect(favMark(page, "Song B")).toBeVisible();
	await expect(favMark(page, "Song C")).toHaveCount(0);
});

test("RATE-SHEET a late answer for the account before a switch changes nothing for the new account", async ({
	page,
}) => {
	const model = await setup(page);
	const sheet = await openSheet(page, "Song B");
	await up(sheet).click();
	// Another account signs in on this device: same songs, nothing rated there.
	model.state = snapshot("listener-b");
	const read = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/state");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await read;
	await expect(sheet).toBeHidden();
	await model.held.pop()!.answer();
	await page.waitForTimeout(300);
	await expect(favMark(page, "Song B")).toHaveCount(0);
	await expect(page.locator(".flash")).not.toHaveText("Als Favorit gemerkt");
	expect(model.thumbs.get("listener-b:track-b")).toBeUndefined();
	expect(model.thumbs.get("listener-a:track-b")).toBe(1);
});

test("RATE-SHEET a stored rating whose skip failed is said apart from a storage failure", async ({
	page,
}) => {
	const model = await setup(page);
	model.mode = "now";
	model.skipError = "Synthetic: Spotify hat abgelehnt";
	const sheet = await openSheet(page, "Song B");
	await down(sheet).click();
	await expect(sheet).toBeHidden();
	await expect(row(page, "Song B").getByRole("img", { name: "Kommt nie wieder" })).toBeVisible();
	await expect(page.locator(".flash")).toHaveText(
		/^Kommt nie wieder — gespeichert\. Überspringen fehlgeschlagen: Synthetic: Spotify hat abgelehnt/,
	);
	await expect(page.locator(".flash")).not.toHaveText(/Nicht gespeichert/);
});

for (const outcome of ["stored", "503"] as const)
	test(`RATE-SHEET cancelled while on its way, the same song reopened: the late ${outcome} answer neither closes nor fills the new sheet`, async ({
		page,
	}) => {
		const model = await setup(page);
		model.heldOutcome = outcome;
		const first = await openSheet(page, "Song B");
		await up(first).click();
		await first.getByRole("button", { name: "Abbrechen" }).click();
		await expect(first).toBeHidden();
		// The same song again, nothing sent from this sheet yet.
		const again = await openSheet(page, "Song B");
		await model.held.pop()!.answer();
		await page.waitForTimeout(300);
		await expect(again).toBeVisible();
		await expect(again.locator("#rate-title")).toHaveText("Song B");
		await expect(again.getByRole("alert")).toHaveCount(0);
		if (outcome === "stored") {
			// What is stored now shows in the open sheet; nothing was claimed for it.
			await expect(up(again)).toHaveAttribute("aria-pressed", "true");
			await expect(page.locator(".flash")).not.toHaveText("Als Favorit gemerkt");
		} else {
			await expect(up(again)).toHaveAttribute("aria-pressed", "false");
			await expect(page.locator(".flash")).toHaveText(/„Song B“ nicht gespeichert: Synthetic 503/);
		}
		expect(model.writes.length).toBe(1);
	});

test("RATE-SHEET signed out and back in as the same account: a late answer from before neither closes nor fills the new sheet", async ({
	page,
}) => {
	const model = await setup(page);
	const sheet = await openSheet(page, "Song B");
	await up(sheet).click();
	const focus = async () => {
		const read = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/state");
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await read;
	};
	model.signedOut = true;
	await focus();
	await expect(sheet).toBeHidden();
	model.signedOut = false;
	await focus();
	await expect(page.locator(".now-copy h2")).toHaveText("Song A");
	const again = await openSheet(page, "Song B");
	await model.held.pop()!.answer();
	await page.waitForTimeout(300);
	await expect(again).toBeVisible();
	await expect(again.getByRole("alert")).toHaveCount(0);
	await expect(page.locator(".flash")).not.toHaveText("Als Favorit gemerkt");
	expect(model.writes.length).toBe(1);
});

test("RATE-SHEET stored, but the answer is lost on its way back: not said as failed, not as stored; the retry confirms it", async ({
	page,
}) => {
	const model = await setup(page);
	const sheet = await openSheet(page, "Song B");
	await up(sheet).click();
	expect(model.thumbs.get("listener-a:track-b")).toBe(1);
	await model.held.pop()!.lose!();
	// Stored by the stand-in, but the page cannot know: no "Nicht gespeichert", no success.
	await expect(sheet).toBeVisible();
	await expect(sheet.getByRole("alert")).toHaveText(/^Speicherung nicht bestätigt: /);
	await expect(sheet.getByRole("alert")).toContainText("Gewählt war: Favorit.");
	await expect(page.locator(".flash")).not.toHaveText("Als Favorit gemerkt");
	model.mode = "now";
	await sheet.getByRole("button", { name: "Nochmal speichern" }).click();
	await expect(sheet).toBeHidden();
	await expect(favMark(page, "Song B")).toBeVisible();
	expect(model.writes.map((w) => w.value)).toEqual([1, 1]);
});

test("RATE-SHEET another account opens the same song while the previous account's rating is on its way: usable at once, its own pending kept", async ({
	page,
}) => {
	const model = await setup(page);
	const first = await openSheet(page, "Song B");
	await up(first).click();
	// Another account signs in on this device before the first answer arrives.
	model.state = snapshot("listener-b");
	const read = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/state");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await read;
	await expect(first).toBeHidden();
	const mine = await openSheet(page, "Song B");
	// Not held up by the previous account's request.
	await expect(down(mine)).toBeEnabled();
	await down(mine).click();
	expect(model.writes.map((w) => [w.profile, w.value])).toEqual([
		["listener-a", 1],
		["listener-b", -1],
	]);
	// The previous account's answer arrives first: it neither clears nor changes this one.
	const [old, own] = model.held;
	await old!.answer();
	await page.waitForTimeout(300);
	await expect(mine).toBeVisible();
	await expect(down(mine)).toBeDisabled();
	await expect(up(mine)).toHaveAttribute("aria-pressed", "false");
	await own!.answer();
	await expect(mine).toBeHidden();
	await expect(row(page, "Song B").getByRole("img", { name: "Kommt nie wieder" })).toBeVisible();
	await expect(favMark(page, "Song B")).toHaveCount(0);
	expect(model.thumbs.get("listener-b:track-b")).toBe(-1);
});
