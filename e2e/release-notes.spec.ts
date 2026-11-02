/**
 * The release notice and notes (TS-RELEASE-NOTICE-261017), rendered by the
 * built client against intercepted API snapshots; the version line is
 * compared with the built Worker's own /api/health. The notice opens once
 * per release after the first snapshot, never over the rating sheet, a field
 * in use or a change on its way; Verstanden or Escape closes and
 * acknowledges it under its one key; another tab's acknowledgement closes
 * it; a change of account does not bring it back. No request it makes, no
 * other key it touches.
 *
 * Headless Chrome keeps every page visible, so the cases that need the page
 * to come to the front later (a tab opened in the background) hide it from
 * the test's side, before the page's own script runs. Nothing in the
 * product reads a test flag.
 */
import { readFileSync } from "node:fs";
import { type BrowserContext, expect, type Page, type Route, test } from "@playwright/test";
import { DEFAULT_RULES } from "../src/core/types";
import type { AppState } from "../src/shared/api";
import { RELEASE } from "../src/shared/release";

const VERSION = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const KEY = "ts-release-seen";
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

function snapshot(profile = "listener-a"): AppState {
	return {
		profile: { id: profile, name: `Hörer ${profile}`, imageUrl: null },
		onboarded: true,
		stations: [
			{
				id: 1,
				name: "Test Sender",
				kind: "all",
				sources: [],
				rules: DEFAULT_RULES,
				roundNo: 1,
				poolSize: 2,
				freshRemaining: 2,
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

interface Model {
	profile: string;
	/** Every request the page sent that is not a read. */
	mutations: string[];
	/** The first snapshot waits for this while set. */
	firstHeld: Promise<void> | null;
	/** Thumb answers held until the test lets them go. */
	held: (() => Promise<void>)[];
}

async function mock(
	page: Page,
	opts: { holdFirst?: boolean } = {},
): Promise<{
	model: Model;
	releaseFirst: () => void;
}> {
	let releaseFirst = () => {};
	const model: Model = {
		profile: "listener-a",
		mutations: [],
		firstHeld: opts.holdFirst
			? new Promise<void>((r) => {
					releaseFirst = r;
				})
			: null,
		held: [],
	};
	page.on("request", (r) => {
		if (r.method() !== "GET") model.mutations.push(`${r.method()} ${new URL(r.url()).pathname}`);
	});
	await page.route("**/api/**", async (route: Route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		if (path === "/api/state") {
			const first = model.firstHeld;
			if (first) {
				model.firstHeld = null;
				await first;
			}
			return route.fulfill({ json: snapshot(model.profile) });
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
		if (/^\/api\/tracks\/[^/]+\/thumb$/.test(path)) {
			model.held.push(() => route.fulfill({ json: { skipped: false } }));
			return;
		}
		return route.fulfill({
			status: 500,
			json: { error: { code: "unexpected", message: `Unexpected ${path}` } },
		});
	});
	return { model, releaseFirst: () => releaseFirst() };
}

const notice = (page: Page) => page.getByRole("dialog", { name: `Neu in Version ${VERSION}` });
const understood = (page: Page) => notice(page).getByRole("button", { name: "Verstanden" });
const home = (page: Page) => expect(page.locator(".now-copy h2")).toHaveText("Song A");
const stored = (page: Page) => page.evaluate((k) => localStorage.getItem(k), KEY);
const keys = (page: Page) =>
	page.evaluate(() => Object.keys(localStorage).sort((a, b) => a.localeCompare(b)));
/** Long enough for a notice that would open by itself to have opened. */
const settle = (page: Page) => page.waitForTimeout(800);

/** Hides the page until `show()`, like a tab opened in the background (headless Chrome has none). */
async function background(target: Page | BrowserContext) {
	await target.addInitScript(() => {
		let hidden = true;
		Object.defineProperty(Document.prototype, "visibilityState", {
			configurable: true,
			get: () => (hidden ? "hidden" : "visible"),
		});
		Object.defineProperty(Document.prototype, "hidden", {
			configurable: true,
			get: () => hidden,
		});
		(window as unknown as { __front: () => void }).__front = () => {
			hidden = false;
			document.dispatchEvent(new Event("visibilitychange"));
		};
	});
}
const front = (page: Page) =>
	page.evaluate(() => (window as unknown as { __front: () => void }).__front());

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("RELEASE a first release: only after the first snapshot, focus on Verstanden, kept only once closed, not again for the same release", async ({
		page,
	}) => {
		const { model, releaseFirst } = await mock(page, { holdFirst: true });
		await page.goto("/");
		await expect(page.getByRole("heading", { name: "Deine Musik wird geladen" })).toBeVisible();
		await settle(page);
		await expect(notice(page)).toHaveCount(0);
		expect(await keys(page)).toEqual([]);

		releaseFirst();
		await home(page);
		await expect(notice(page)).toBeVisible();
		await expect(understood(page)).toBeFocused();
		// Open, not yet closed: nothing kept.
		expect(await stored(page)).toBeNull();
		const n = notice(page);
		await expect(n.locator(".release-notes li")).toHaveCount(RELEASE.changes.length);
		await expect(n).toContainText(`Diese Seite läuft mit Version ${VERSION} vom`);
		await expect(n).toContainText("Bekannte Grenze:");
		await expect(n).toContainText("von Hand");
		await expect(n).toContainText("Mehr → Über true-shuffle");
		// Nothing claims that a page opened earlier was updated.
		await expect(n).not.toContainText(/aktualisiert|neu geladen/i);
		// Small, inside the phone's width, its key big enough to tap.
		const box = (await n.boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		expect(box.height).toBeLessThan(844);
		expect((await understood(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
		expect(await n.evaluate((d) => d.scrollWidth <= d.clientWidth), "no sideways scrolling").toBe(
			true,
		);

		await understood(page).click();
		await expect(notice(page)).toBeHidden();
		await expect.poll(() => stored(page)).toBe(VERSION);
		expect(await keys(page)).toEqual([KEY]);
		await expect(page.locator("main h1")).toBeFocused();

		await page.reload();
		await home(page);
		await settle(page);
		await expect(notice(page)).toHaveCount(0);
		await expect.poll(() => stored(page)).toBe(VERSION);
		expect(model.mutations).toEqual([]);
	});

	test("RELEASE a newer release or an unreadable value asks again; a later acknowledgement does not", async ({
		page,
	}) => {
		const { model } = await mock(page);
		await page.goto("/");
		await home(page);
		await page.keyboard.press("Escape");
		await expect(notice(page)).toBeHidden();
		const others = { "ts-illumination": "night", "ts-history-ratings:listener-a": "on" };
		await page.evaluate((o) => {
			for (const [k, v] of Object.entries(o)) localStorage.setItem(k, v);
		}, others);
		for (const old of ["0.9.9", "garbage", "", `${VERSION}-beta`]) {
			await page.evaluate(([k, v]) => localStorage.setItem(k!, v!), [KEY, old]);
			await page.reload();
			await home(page);
			await expect(notice(page), `stored "${old}"`).toBeVisible();
			await understood(page).click();
			await expect(notice(page)).toBeHidden();
			await expect.poll(() => stored(page)).toBe(VERSION);
		}
		await page.evaluate(([k]) => localStorage.setItem(k!, "999.0.0"), [KEY]);
		await page.reload();
		await home(page);
		await settle(page);
		await expect(notice(page)).toHaveCount(0);
		expect(await stored(page)).toBe("999.0.0");
		// The other keys are as they were.
		for (const [k, v] of Object.entries(others))
			expect(await page.evaluate((key) => localStorage.getItem(key), k)).toBe(v);
		expect(await keys(page)).toEqual(
			[KEY, ...Object.keys(others)].sort((a, b) => a.localeCompare(b)),
		);
		expect(model.mutations).toEqual([]);
	});

	test("RELEASE storage that fails: the notice closes, the app goes on, this page does not ask again; the next page load may", async ({
		page,
	}) => {
		await page.addInitScript(() => {
			const fail = () => {
				throw new DOMException("blocked", "SecurityError");
			};
			Storage.prototype.getItem = fail;
			Storage.prototype.setItem = fail;
			Storage.prototype.removeItem = fail;
		});
		const { model } = await mock(page);
		await page.goto("/");
		await home(page);
		await expect(notice(page)).toBeVisible();
		await understood(page).click();
		await expect(notice(page)).toBeHidden();
		// Within this page: other screens and back, no notice.
		await page
			.getByRole("navigation", { name: "Hauptnavigation" })
			.getByRole("link", { name: "Mehr" })
			.click();
		await expect(page.getByRole("heading", { name: "Mehr", level: 1 })).toBeVisible();
		await page
			.getByRole("navigation", { name: "Hauptnavigation" })
			.getByRole("link", { name: "Jetzt" })
			.click();
		await home(page);
		await settle(page);
		await expect(notice(page)).toHaveCount(0);
		// Asked again on request.
		await page.goto("/info");
		await expect(notice(page)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(notice(page)).toBeHidden();
		await page.getByRole("button", { name: "Was ist neu?" }).click();
		await expect(notice(page)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(notice(page)).toBeHidden();
		await expect(page.getByRole("button", { name: "Was ist neu?" })).toBeFocused();
		expect(model.mutations).toEqual([]);
	});

	test("RELEASE a change of account does not bring the notice back, on the page or after a reload", async ({
		page,
	}) => {
		const { model } = await mock(page);
		await page.goto("/");
		await home(page);
		await understood(page).click();
		await expect(notice(page)).toBeHidden();
		model.profile = "listener-b";
		// The page reads again when it gets the focus back.
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await page.goto("/mehr");
		await expect(page.getByText("Hörer listener-b")).toBeVisible();
		await settle(page);
		await expect(notice(page)).toHaveCount(0);
		await page.reload();
		await expect(page.getByText("Hörer listener-b")).toBeVisible();
		await settle(page);
		await expect(notice(page)).toHaveCount(0);
		expect(await keys(page)).toEqual([KEY]);
		await expect.poll(() => stored(page)).toBe(VERSION);
		expect(model.mutations).toEqual([]);
	});

	test("RELEASE never over the real rating sheet: a delayed answer goes through untouched, then the notice, with no further request", async ({
		page,
	}) => {
		await background(page);
		const { model } = await mock(page);
		await page.goto("/");
		await home(page);
		await settle(page);
		// In the background: not yet.
		await expect(notice(page)).toHaveCount(0);
		await page.getByRole("button", { name: "Song B — Test Artist bewerten" }).click();
		const sheet = page.getByRole("dialog", { name: "Song B" });
		await expect(sheet).toBeVisible();
		await sheet.getByRole("button", { name: "Daumen hoch: Favorit" }).click();
		await expect.poll(() => model.held.length).toBe(1);
		await expect(sheet.getByRole("button", { name: "Daumen hoch: Favorit" })).toBeDisabled();
		// In front now, the rating still on its way: the sheet stays alone.
		await front(page);
		await settle(page);
		await expect(notice(page)).toHaveCount(0);
		await expect(sheet).toBeVisible();
		await expect(sheet.getByRole("button", { name: "Abbrechen" })).toBeEnabled();
		expect(await stored(page)).toBeNull();
		// The answer: the sheet closes as it always does, then the notice.
		await model.held[0]!();
		await expect(sheet).toBeHidden();
		await expect(notice(page)).toBeVisible();
		await expect(understood(page)).toBeFocused();
		expect(model.mutations).toEqual(["POST /api/tracks/track-b/thumb"]);
		await understood(page).click();
		await expect(notice(page)).toBeHidden();
		// Focus back where the rating left it.
		await expect(page.getByRole("button", { name: "Song B — Test Artist bewerten" })).toBeFocused();
		await settle(page);
		expect(model.mutations).toEqual(["POST /api/tracks/track-b/thumb"]);
		expect(await keys(page)).toEqual([KEY]);
	});

	test("RELEASE not while a field is in use: the device choice keeps its focus until let go", async ({
		page,
	}) => {
		await background(page);
		const { model } = await mock(page);
		await page.goto("/");
		await home(page);
		const choice = page.getByLabel("Wiedergabegerät", { exact: true });
		await choice.focus();
		await front(page);
		await settle(page);
		await expect(notice(page)).toHaveCount(0);
		await expect(choice).toBeFocused();
		await choice.blur();
		await expect(notice(page)).toBeVisible();
		await understood(page).click();
		await expect(notice(page)).toBeHidden();
		expect(model.mutations).toEqual([]);
	});

	test("RELEASE two tabs: one acknowledges, the other closes by itself and writes nothing; a third never asks", async ({
		context,
	}) => {
		await context.addInitScript(() => {
			const set = Storage.prototype.setItem;
			const w = window as unknown as { __writes: string[] };
			w.__writes = [];
			Storage.prototype.setItem = function (k: string, v: string) {
				w.__writes.push(`${k}=${v}`);
				return set.call(this, k, v);
			};
		});
		const one = await context.newPage();
		const two = await context.newPage();
		const m1 = await mock(one);
		const m2 = await mock(two);
		await one.goto("/");
		await two.goto("/");
		await home(one);
		await home(two);
		await expect(notice(one)).toBeVisible();
		await expect(notice(two)).toBeVisible();
		await understood(one).click();
		await expect(notice(one)).toBeHidden();
		await expect(notice(two)).toBeHidden();
		const writes = (p: Page) =>
			p.evaluate(() => (window as unknown as { __writes: string[] }).__writes);
		expect(await writes(one)).toEqual([`${KEY}=${VERSION}`]);
		expect(await writes(two)).toEqual([]);
		const three = await context.newPage();
		const m3 = await mock(three);
		await three.goto("/");
		await home(three);
		await settle(three);
		await expect(notice(three)).toHaveCount(0);
		expect([...m1.model.mutations, ...m2.model.mutations, ...m3.model.mutations]).toEqual([]);
	});
});

test.describe("desktop", () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test("RELEASE Escape closes and acknowledges; a small dialog in the middle", async ({ page }) => {
		const { model } = await mock(page);
		await page.goto("/");
		await home(page);
		await expect(notice(page)).toBeVisible();
		const box = (await notice(page).boundingBox())!;
		expect(box.width).toBeLessThanOrEqual(460);
		expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(4);
		await expect(understood(page)).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(notice(page)).toBeHidden();
		await expect.poll(() => stored(page)).toBe(VERSION);
		await expect(page.locator("main h1")).toBeFocused();
		expect(model.mutations).toEqual([]);
	});

	test("RELEASE Mehr → Über keeps version, notes, the known limit and Was ist neu?; the loaded page and the built Worker name one release", async ({
		page,
	}) => {
		const { model } = await mock(page);
		await page.goto("/");
		await home(page);
		await understood(page).click();
		await page
			.getByRole("navigation", { name: "Hauptnavigation" })
			.getByRole("link", { name: "Mehr" })
			.click();
		await page.getByRole("link", { name: /Über true-shuffle/ }).click();
		const section = page.getByRole("region", { name: "Version" });
		await expect(section).toBeVisible();
		const line = (await section.locator("p").first().textContent()) ?? "";
		const m = /^Diese Seite läuft mit Version (\S+) vom (.+)\.$/.exec(line);
		expect(m, line).not.toBeNull();
		await expect(section.locator(".release-notes li")).toHaveCount(RELEASE.changes.length);
		await expect(section).toContainText("Bekannte Grenze:");

		// The built Worker's own answer (not intercepted: the page's routes do not reach it).
		const health = (await (await page.request.get("/api/health")).json()) as {
			version: string;
			released: string;
		};
		expect(health.version).toBe(VERSION);
		expect(m![1]).toBe(health.version);
		const [y, mo, d] = health.released.split("-").map(Number);
		expect(m![2]).toBe(
			new Intl.DateTimeFormat("de-DE", {
				day: "numeric",
				month: "long",
				year: "numeric",
				timeZone: "UTC",
			}).format(Date.UTC(y!, mo! - 1, d!)),
		);

		// Again on request, and the focus back on the key that asked.
		const again = section.getByRole("button", { name: "Was ist neu?" });
		await again.click();
		await expect(notice(page)).toBeVisible();
		await expect(notice(page).locator(".release-notes li")).toHaveText(
			await section.locator(".release-notes li").allTextContents(),
		);
		await understood(page).click();
		await expect(notice(page)).toBeHidden();
		await expect(again).toBeFocused();
		await page.reload();
		await expect(section).toBeVisible();
		await settle(page);
		await expect(notice(page)).toHaveCount(0);
		expect(model.mutations).toEqual([]);
	});
});

/**
 * TS-RELEASE-NOTICE-COR1-261017: a write still on its way holds the notice
 * back wherever it was started — a rating sheet closed before its answer, a
 * thumb or a rename sent straight from the page, a second answer that waited
 * for the first. Every write is held here until the test answers it (stored,
 * refused, or lost on the way); the notice comes once that answer has gone
 * through as it always does, and only into a page that is quiet otherwise.
 */
interface Held {
	path: string;
	answer: (how?: "stored" | "refused" | "lost") => Promise<void>;
}

async function mockWrites(page: Page): Promise<{ mutations: string[]; held: Held[] }> {
	const writes = { mutations: [] as string[], held: [] as Held[] };
	page.on("request", (r) => {
		if (r.method() !== "GET") writes.mutations.push(`${r.method()} ${new URL(r.url()).pathname}`);
	});
	const station = snapshot().stations[0]!;
	await page.route("**/api/**", async (route: Route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		if (req.method() !== "GET") {
			writes.held.push({
				path: `${req.method()} ${path}`,
				answer: (how = "stored") =>
					how === "lost"
						? route.abort("failed")
						: how === "refused"
							? route.fulfill({
									status: 409,
									json: { error: { code: "refused", message: "Im Test abgelehnt." } },
								})
							: route.fulfill({ json: path.endsWith("/thumb") ? { skipped: false } : {} }),
			});
			return;
		}
		if (path === "/api/state") return route.fulfill({ json: snapshot() });
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
		if (path === "/api/stations/1")
			return route.fulfill({
				json: {
					...station,
					upcoming: [],
					recent: [],
					counts: null,
					discoveries: { pending: 0, kept: 0, rejected: 0 },
				},
			});
		return route.fulfill({
			status: 500,
			json: { error: { code: "unexpected", message: `Unexpected ${path}` } },
		});
	});
	return writes;
}

const player = (page: Page) => page.locator("section.player");
const flash = (page: Page) => page.locator(".flash");

test.describe("phone, a write on its way", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	for (const how of ["Abbrechen", "Escape"] as const) {
		test(`RELEASE COR1 the rating sheet closed by ${how} before its answer: no notice until the answer has gone through, then once`, async ({
			page,
		}) => {
			await background(page);
			const writes = await mockWrites(page);
			await page.goto("/");
			await home(page);
			await page.getByRole("button", { name: "Song B — Test Artist bewerten" }).click();
			const sheet = page.getByRole("dialog", { name: "Song B" });
			await sheet.getByRole("button", { name: "Daumen hoch: Favorit" }).click();
			await expect.poll(() => writes.held.length).toBe(1);
			await front(page);
			await settle(page);
			await expect(notice(page)).toHaveCount(0);
			// Closed, the thumb still on its way.
			if (how === "Abbrechen") await sheet.getByRole("button", { name: "Abbrechen" }).click();
			else await page.keyboard.press("Escape");
			await expect(sheet).toBeHidden();
			await settle(page);
			await expect(notice(page), "not while the thumb is on its way").toHaveCount(0);
			expect(await stored(page)).toBeNull();
			if (how === "Abbrechen") {
				await writes.held[0]!.answer("stored");
			} else {
				// Lost on the way back: said as it always is, then the notice.
				await writes.held[0]!.answer("lost");
				await expect(flash(page)).toContainText("„Song B“ Speicherung nicht bestätigt");
			}
			await expect(notice(page)).toBeVisible();
			await expect(understood(page)).toBeFocused();
			await understood(page).click();
			await expect(notice(page)).toBeHidden();
			await expect(
				page.getByRole("button", { name: "Song B — Test Artist bewerten" }),
			).toBeFocused();
			await settle(page);
			await expect(notice(page)).toHaveCount(0);
			expect(writes.mutations).toEqual(["POST /api/tracks/track-b/thumb"]);
			expect(writes.held).toHaveLength(1);
			await expect.poll(() => stored(page)).toBe(VERSION);
			expect(await keys(page)).toEqual([KEY]);
		});
	}

	test("RELEASE COR1 a thumb sent straight from Home: no notice while it is on its way; said as always, then the notice", async ({
		page,
	}) => {
		await background(page);
		const writes = await mockWrites(page);
		await page.goto("/");
		await home(page);
		await player(page).getByRole("button", { name: "Daumen hoch: Favorit" }).click();
		await expect.poll(() => writes.held.length).toBe(1);
		await expect(player(page)).toContainText("Wird gespeichert …");
		await front(page);
		await settle(page);
		await expect(notice(page), "not while the thumb is on its way").toHaveCount(0);
		expect(await stored(page)).toBeNull();
		await writes.held[0]!.answer("stored");
		await expect(flash(page)).toContainText("Als Favorit gemerkt");
		await expect(notice(page)).toBeVisible();
		await understood(page).click();
		await expect(notice(page)).toBeHidden();
		await settle(page);
		expect(writes.mutations).toEqual(["POST /api/tracks/track-a/thumb"]);
		expect(await keys(page)).toEqual([KEY]);
	});

	test("RELEASE COR1 a second answer that waited for the first: held back throughout, a refusal included, then once", async ({
		page,
	}) => {
		await background(page);
		const writes = await mockWrites(page);
		await page.goto("/");
		await home(page);
		await player(page).getByRole("button", { name: "Daumen hoch: Favorit" }).click();
		await expect.poll(() => writes.held.length).toBe(1);
		// A newer answer waits for the first one.
		await player(page)
			.getByRole("button", { name: "Daumen runter: diesen Song nie wieder" })
			.click();
		await front(page);
		await settle(page);
		await expect(notice(page)).toHaveCount(0);
		// The first one stored: the waiting one goes at once, and the page is not quiet in between.
		await writes.held[0]!.answer("stored");
		await expect.poll(() => writes.held.length).toBe(2);
		await settle(page);
		await expect(notice(page), "not between the first answer and the second write").toHaveCount(0);
		expect(await stored(page)).toBeNull();
		// The second one refused: shown as always, then the notice.
		await writes.held[1]!.answer("refused");
		await expect(player(page)).toContainText("Nicht gespeichert: Im Test abgelehnt.");
		await expect(notice(page)).toBeVisible();
		await understood(page).click();
		await expect(notice(page)).toBeHidden();
		await settle(page);
		expect(writes.mutations).toEqual([
			"POST /api/tracks/track-a/thumb",
			"POST /api/tracks/track-a/thumb",
		]);
		expect(await keys(page)).toEqual([KEY]);
	});

	test("RELEASE COR1 a rename on its way (no busy mark on the page): no notice until its answer has gone through", async ({
		page,
	}) => {
		await background(page);
		const writes = await mockWrites(page);
		await page.goto("/sender/1");
		const field = page.getByLabel("Name der Kassette");
		await expect(field).toHaveValue("Test Sender");
		await field.fill("Neuer Name");
		const rename = page.getByRole("button", { name: "Umbenennen" });
		await rename.click();
		await expect.poll(() => writes.held.length).toBe(1);
		await expect(rename).toBeFocused();
		await front(page);
		await settle(page);
		await expect(notice(page), "not while the rename is on its way").toHaveCount(0);
		await writes.held[0]!.answer("stored");
		await expect(flash(page)).toContainText("Heißt jetzt „Neuer Name“");
		await expect(notice(page)).toBeVisible();
		await understood(page).click();
		await expect(notice(page)).toBeHidden();
		await expect(rename).toBeFocused();
		await settle(page);
		expect(writes.mutations).toEqual(["PATCH /api/stations/1"]);
		expect(await keys(page)).toEqual([KEY]);
	});

	test("RELEASE COR1 control: an answer that has gone through does not open the notice over a field in use", async ({
		page,
	}) => {
		await background(page);
		const writes = await mockWrites(page);
		await page.goto("/");
		await home(page);
		await player(page).getByRole("button", { name: "Daumen hoch: Favorit" }).click();
		await expect.poll(() => writes.held.length).toBe(1);
		const choice = page.getByLabel("Wiedergabegerät", { exact: true });
		await choice.focus();
		await front(page);
		await writes.held[0]!.answer("stored");
		await expect(flash(page)).toContainText("Als Favorit gemerkt");
		await settle(page);
		await expect(notice(page)).toHaveCount(0);
		await expect(choice).toBeFocused();
		await choice.blur();
		await expect(notice(page)).toBeVisible();
		await understood(page).click();
		await expect(notice(page)).toBeHidden();
		expect(writes.mutations).toEqual(["POST /api/tracks/track-a/thumb"]);
	});
});
