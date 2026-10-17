/**
 * TS-HISTORY-ZERO-FOLLOW-COR1-261017 in the browser: a Verlauf page confirms
 * Song B at −1 with write number 0 (`rated: 0`); a separately asked older page
 * (the real "Ältere laden", 60 rows a page) lists Song B again at +1 without
 * `rated`. Every visible Song B row and the open sheet stay at −1. Three
 * rendered traces: S with the sheet open while the pages arrive, V with the
 * sheet closed and real clicks, O with a thumb given here first (and kept: the
 * page clock stands still, so no later snapshot settles it). Rendered
 * client against intercepted API answers; no provider, no other origin. See
 * docs/testing/rating-zero-follow.md.
 */
import { expect, type Locator, type Page, type Route, test } from "@playwright/test";
import { DEFAULT_RULES } from "../src/core/types";
import type { AppState, HistoryEntry } from "../src/shared/api";

test.use({ viewport: { width: 390, height: 844 } });

type Thumb = -1 | 0 | 1;
const TIME = Date.UTC(2026, 9, 1, 12);
/** One Verlauf page holds 60 rows (menu.tsx): a full page offers "Ältere laden". */
const PAGE = 60;
const song = (id: string, name: string, thumb: Thumb, rated?: number) => ({
	id,
	name,
	artists: "Test Artist",
	album: "Test Album",
	imageUrl: null,
	durationMs: 180_000,
	thumb,
	...(rated === undefined ? {} : { rated }),
});

/** The snapshot: Song A playing, Song B queued at 0 without a write number. */
function snapshot(serverTime: number): AppState {
	return {
		profile: { id: "listener-a", name: "Test Listener", imageUrl: null },
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
				{ entryId: "entry-0", track: song("track-a", "Song A", 0, 1) },
				{ entryId: "entry-1", track: song("track-b", "Song B", 0) },
			],
		},
		nowPlaying: {
			...song("track-a", "Song A", 0, 1),
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
		serverTime,
	};
}

/**
 * Verlauf page `n` (0 = the first): `size` rows, one minute apart, other songs
 * except Song B where given (thumb, and write number or none).
 */
function listPage(n: number, size: number, b?: { thumb: Thumb; rated?: number }): HistoryEntry[] {
	return Array.from({ length: size }, (_, i) => {
		const playedAt = TIME - (n * PAGE + i + 1) * 60_000;
		const t =
			b && i === 3
				? song("track-b", "Song B", b.thumb, b.rated)
				: song(`fill-${n}-${i}`, `Füller ${n}-${i}`, 0, 1);
		return { ...t, playedAt, stationName: null, ignored: false };
	});
}

async function setup(page: Page) {
	const origin = new URL(test.info().project.use.baseURL!).origin;
	const m = {
		origin,
		lists: [] as { url: string; answer: (rows: HistoryEntry[]) => Promise<void> }[],
		thumbs: [] as string[],
		mutations: [] as string[],
		unexpected: [] as string[],
		outside: [] as string[],
		origins: new Set<string>(),
	};
	page.on("request", (r) => m.origins.add(new URL(r.url()).origin));
	await page.route("**/*", (route: Route) => {
		const url = new URL(route.request().url());
		if (url.origin === origin) return route.fallback();
		m.outside.push(url.origin);
		return route.abort("blockedbyclient");
	});
	await page.clock.install({ time: TIME });
	await page.clock.setFixedTime(TIME);
	await page.route("**/api/**", async (route: Route) => {
		const req = route.request();
		const url = new URL(req.url());
		if (url.origin !== origin) {
			m.outside.push(url.origin);
			return route.abort("blockedbyclient");
		}
		if (url.pathname === "/api/tracks/track-b/thumb" && req.method() !== "GET") {
			m.thumbs.push(`${req.method()} ${url.pathname} ${req.postData()}`);
			return route.fulfill({ json: {} });
		}
		if (req.method() !== "GET") m.mutations.push(`${req.method()} ${url.pathname}`);
		if (url.pathname === "/api/state") return route.fulfill({ json: snapshot(TIME) });
		if (url.pathname === "/api/devices") return route.fulfill({ json: [] });
		if (url.pathname === "/api/native/devices")
			return route.fulfill({ json: { configured: false, devices: [] } });
		if (url.pathname === "/api/history") {
			m.lists.push({ url: url.search, answer: (rows) => route.fulfill({ json: rows }) });
			return;
		}
		m.unexpected.push(`${req.method()} ${url.pathname}`);
		return route.fulfill({ status: 500, json: { error: { code: "x", message: url.pathname } } });
	});
	await page.goto("/");
	await expect(page.locator(".now-copy h2")).toHaveText("Song A");
	return m;
}

const rowsOfB = (page: Page) => page.locator(".hist-row").filter({ hasText: "Song B" });
/** Exactly `count` Song B rows are in the Verlauf, each on screen and each saying exactly this rating. */
async function expectVerlauf(page: Page, value: Thumb, count: number) {
	const rows = rowsOfB(page);
	await expect(rows).toHaveCount(count);
	for (let i = 0; i < count; i++) {
		const r = rows.nth(i);
		await r.scrollIntoViewIfNeeded();
		await expect(r).toBeVisible();
		await expect(r.getByRole("button", { name: "Favorit" })).toHaveAttribute(
			"aria-pressed",
			String(value === 1),
		);
		await expect(r.getByRole("button", { name: "Nie wieder" })).toHaveAttribute(
			"aria-pressed",
			String(value === -1),
		);
	}
}
/** The open sheet says exactly this rating is stored. */
async function expectSheet(sheet: Locator, value: Thumb) {
	await expect(sheet).toBeVisible();
	await expect(sheet.getByRole("button", { name: "Daumen hoch: Favorit" })).toHaveAttribute(
		"aria-pressed",
		String(value === 1),
	);
	await expect(sheet.getByRole("button", { name: "Daumen runter: nie wieder" })).toHaveAttribute(
		"aria-pressed",
		String(value === -1),
	);
}
async function openSheetOnB(page: Page) {
	await page.getByRole("button", { name: "Song B — Test Artist bewerten" }).click();
	const sheet = page.getByRole("dialog");
	await expect(sheet.locator("#rate-title")).toHaveText("Song B");
	return sheet;
}
const older = (page: Page) => page.getByRole("button", { name: "Ältere laden" });
async function finalGates(m: Awaited<ReturnType<typeof setup>>) {
	expect(m.mutations).toEqual([]);
	expect(m.unexpected).toEqual([]);
	expect(m.outside).toEqual([]);
	expect([...m.origins]).toEqual([m.origin]);
}

test("HISTORY-ZERO-FOLLOW S sheet open: the confirmed −1 (rated 0) on the first page, then the separately asked older page +1 without rated: sheet and every Song B row stay −1", async ({
	page,
}) => {
	const m = await setup(page);
	// First visit to the Verlauf: a first page without write numbers, Song B at 0.
	await page.getByRole("link", { name: "Verlauf", exact: true }).click();
	await expect.poll(() => m.lists.length).toBe(1);
	await m.lists[0]!.answer(listPage(0, PAGE, { thumb: 0 }));
	await expectVerlauf(page, 0, 1);
	// Home; the sheet opens on Song B (0) and stays open going forward into the Verlauf.
	await page.goBack();
	const sheet = await openSheetOnB(page);
	await expectSheet(sheet, 0);
	await page.goForward();
	await expect.poll(() => m.lists.length).toBe(2);
	await expect(page).toHaveURL(/\/verlauf$/);
	// The first page confirms Song B at −1, write number 0.
	await m.lists[1]!.answer(listPage(0, PAGE, { thumb: -1, rated: 0 }));
	await expectSheet(sheet, -1);
	await expectVerlauf(page, -1, 1);
	// "Ältere laden": the modal sheet makes the page behind it inert, so the click is
	// dispatched to the button itself (its own handler, the real follow-page request).
	await expect(older(page)).toBeEnabled();
	await older(page).dispatchEvent("click");
	await expect.poll(() => m.lists.length).toBe(3);
	expect(m.lists[2]!.url).not.toBe(m.lists[1]!.url);
	await m.lists[2]!.answer(listPage(1, 10, { thumb: 1 }));
	await expect(rowsOfB(page)).toHaveCount(2);
	await expectSheet(sheet, -1);
	await expectVerlauf(page, -1, 2);
	// The sheet closed: the Verlauf repainted under it still says −1 in both rows.
	await sheet.getByRole("button", { name: "Abbrechen" }).click();
	await expect(sheet).toBeHidden();
	await expectVerlauf(page, -1, 2);
	expect(m.thumbs).toEqual([]);
	await finalGates(m);
});

test("HISTORY-ZERO-FOLLOW V sheet closed, real clicks: rated 0 on the first page, the older page +1 without rated: both Song B rows −1, and the sheet opened afterwards −1", async ({
	page,
}) => {
	const m = await setup(page);
	await page.getByRole("link", { name: "Verlauf", exact: true }).click();
	await expect.poll(() => m.lists.length).toBe(1);
	await m.lists[0]!.answer(listPage(0, PAGE, { thumb: -1, rated: 0 }));
	await expectVerlauf(page, -1, 1);
	await older(page).click();
	await expect.poll(() => m.lists.length).toBe(2);
	expect(m.lists[1]!.url).not.toBe(m.lists[0]!.url);
	await m.lists[1]!.answer(listPage(1, 10, { thumb: 1 }));
	await expect(older(page)).toHaveCount(0);
	await expectVerlauf(page, -1, 2);
	// Home: the sheet on Song B says what the Verlauf said.
	await page.goBack();
	const sheet = await openSheetOnB(page);
	await expectSheet(sheet, -1);
	expect(m.thumbs).toEqual([]);
	await finalGates(m);
});

test("HISTORY-ZERO-FOLLOW O a thumb +1 given here first: the older page confirms −1 (rated 0) after it, the oldest page +1 without rated: both Song B rows −1, the sheet −1", async ({
	page,
}) => {
	const m = await setup(page);
	// A thumb +1 on Song B from the sheet (stored, answered).
	let sheet = await openSheetOnB(page);
	await expectSheet(sheet, 0);
	await sheet.getByRole("button", { name: "Daumen hoch: Favorit" }).click();
	await expect(sheet).toBeHidden();
	expect(m.thumbs).toHaveLength(1);
	// The queue row shows the thumb given here.
	const queueB = page.locator(".queue-row").filter({ hasText: "Song B" });
	await expect(queueB.getByRole("img", { name: "Favorit" })).toHaveCount(1);
	// The Verlauf: a first page without Song B, then two older pages asked one after the
	// other. The page clock stands still, so the notice "Als Favorit gemerkt" stays up and
	// covers "Ältere laden": the click is dispatched to the button itself (its own handler).
	await page.getByRole("link", { name: "Verlauf", exact: true }).click();
	await expect.poll(() => m.lists.length).toBe(1);
	await m.lists[0]!.answer(listPage(0, PAGE));
	await expect(rowsOfB(page)).toHaveCount(0);
	await older(page).dispatchEvent("click");
	await expect.poll(() => m.lists.length).toBe(2);
	await m.lists[1]!.answer(listPage(1, PAGE, { thumb: -1, rated: 0 }));
	await expectVerlauf(page, -1, 1);
	await older(page).dispatchEvent("click");
	await expect.poll(() => m.lists.length).toBe(3);
	expect(new Set(m.lists.map((l) => l.url)).size).toBe(3);
	await m.lists[2]!.answer(listPage(2, 10, { thumb: 1 }));
	await expectVerlauf(page, -1, 2);
	await page.goBack();
	await expect(queueB.getByRole("img", { name: "Kommt nie wieder" })).toHaveCount(1);
	sheet = await openSheetOnB(page);
	await expectSheet(sheet, -1);
	expect(m.thumbs).toHaveLength(1);
	await finalGates(m);
});
