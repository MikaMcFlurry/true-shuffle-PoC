/**
 * The rating sheet's explicit retry keeps the value first chosen (TS-RETRY-261016):
 * three stored → chosen pairs (0 → −1, +1 → 0, −1 → 0), each with a refused first
 * request (503, nothing stored) and with a lost answer (stored, the answer never
 * arrives). After the failure the page reads its state once more; the retry still
 * sends the original choice, not a toggle of what the read now says; the open sheet must
 * say what is stored by then. After the confirmed retry the page's own follow-up read and
 * poll run on its clock, and still only two ratings were sent. Rendered client against
 * intercepted API snapshots; no provider, no playback, no other origin.
 */
import { expect, type Locator, type Page, type Route, test } from "@playwright/test";
import { DEFAULT_RULES } from "../src/core/types";
import type { AppState } from "../src/shared/api";

test.use({ viewport: { width: 390, height: 844 } });

type Thumb = -1 | 0 | 1;

const TIME = Date.UTC(2026, 9, 1, 12);
const song = (id: string, name: string) => ({
	id,
	name,
	artists: "Test Artist",
	album: "Test Album",
	imageUrl: null,
	durationMs: 180_000,
	thumb: 0 as Thumb,
});
const A = song("track-a", "Song A");
const B = song("track-b", "Song B");
const C = song("track-c", "Song C");

function snapshot(): AppState {
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

/**
 * The stand-in server: one stored rating for Song B, every request recorded.
 * `refused` answers 503 and stores nothing; `lost` stores the value and drops the
 * connection; `hold` stores the value and answers when the test says so.
 */
async function setup(page: Page, stored: Thumb) {
	// The page's own origin (the local harness); every other origin is refused and counted.
	const origin = new URL(test.info().project.use.baseURL!).origin;
	const model = {
		stored,
		mode: "hold" as "refused" | "lost" | "hold",
		writes: [] as { path: string; value: unknown; expected: unknown }[],
		mutations: [] as string[],
		unexpected: [] as string[],
		outside: [] as string[],
		/** Every request the page attempts, seen before any route answers it. */
		origins: new Set<string>(),
		/** State reads answered: the app's follow-up read and its poll show up here. */
		reads: 0,
		held: [] as (() => Promise<void>)[],
	};
	page.on("request", (r) => model.origins.add(new URL(r.url()).origin));
	// Registered first, so it only sees what the API handler below does not.
	await page.route("**/*", (route: Route) => {
		const url = new URL(route.request().url());
		if (url.origin === origin) return route.fallback();
		model.outside.push(url.origin);
		return route.abort("blockedbyclient");
	});
	await page.clock.install({ time: TIME });
	await page.clock.setFixedTime(TIME);
	await page.route("**/api/**", async (route: Route) => {
		const req = route.request();
		const url = new URL(req.url());
		// An API path on any other origin is never answered, only counted and refused.
		if (url.origin !== origin) {
			model.outside.push(url.origin);
			return route.abort("blockedbyclient");
		}
		const path = url.pathname;
		if (req.method() !== "GET") model.mutations.push(`${req.method()} ${path}`);
		if (path === "/api/state") {
			model.reads++;
			const s = snapshot();
			for (const e of s.session?.queue ?? []) if (e.track.id === B.id) e.track.thumb = model.stored;
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
		if (req.method() === "POST" && path === `/api/tracks/${B.id}/thumb`) {
			const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
			model.writes.push({ path, value: body.value, expected: body.expected });
			if (model.mode === "refused")
				return route.fulfill({
					status: 503,
					json: { error: { code: "unavailable", message: "Synthetic 503" } },
				});
			model.stored = body.value as Thumb;
			if (model.mode === "lost") return route.abort("connectionreset");
			model.held.push(() => route.fulfill({ json: { skipped: false } }));
			return;
		}
		model.unexpected.push(`${req.method()} ${path}`);
		return route.fulfill({
			status: 500,
			json: { error: { code: "unexpected", message: `Unexpected ${path}` } },
		});
	});
	await page.goto("/");
	await expect(page.locator(".now-copy h2")).toHaveText("Song A");
	return model;
}

const row = (page: Page) =>
	page.locator(".queue-row").filter({ has: page.locator("strong", { hasText: "Song B" }) });
const up = (sheet: Locator) => sheet.getByRole("button", { name: "Daumen hoch: Favorit" });
const down = (sheet: Locator) => sheet.getByRole("button", { name: "Daumen runter: nie wieder" });

/**
 * Song B's row, present once and visible, says exactly this rating: a favourite mark,
 * a never-again mark, or neither.
 */
async function expectRowShows(page: Page, value: Thumb) {
	await expect(row(page)).toHaveCount(1);
	await expect(row(page)).toBeVisible();
	await expect(row(page).getByRole("img", { name: "Favorit" })).toHaveCount(value === 1 ? 1 : 0);
	await expect(row(page).getByRole("img", { name: "Kommt nie wieder" })).toHaveCount(
		value === -1 ? 1 : 0,
	);
}

const STORED_SAYS = {
	1: "Ist Favorit. Noch einmal Daumen hoch nimmt das zurück.",
	"-1": "Kommt nie wieder. Noch einmal Daumen runter lässt ihn wieder zu.",
} as const;

/** The open sheet says this rating is stored: its pressed key and its line about it. */
async function expectSheetShows(sheet: Locator, value: Thumb, check = expect) {
	await check(up(sheet), `sheet shows stored ${value}: up key`).toHaveAttribute(
		"aria-pressed",
		String(value === 1),
	);
	await check(down(sheet), `sheet shows stored ${value}: down key`).toHaveAttribute(
		"aria-pressed",
		String(value === -1),
	);
	await check(
		sheet.getByText(STORED_SAYS[1]),
		`sheet shows stored ${value}: favourite line`,
	).toHaveCount(value === 1 ? 1 : 0);
	await check(
		sheet.getByText(STORED_SAYS["-1"]),
		`sheet shows stored ${value}: never line`,
	).toHaveCount(value === -1 ? 1 : 0);
}

/** One controlled state read, started by the page returning to focus; its answer for Song B. */
async function readState(page: Page): Promise<Thumb> {
	const read = page.waitForResponse(
		(r) => new URL(r.url()).pathname === "/api/state" && r.request().method() === "GET",
	);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	const s = (await (await read).json()) as AppState;
	return s.session!.queue.find((e) => e.track.id === B.id)!.track.thumb;
}

const PAIRS = [
	{ stored: 0, chosen: -1, key: down, choice: "nie wieder", said: "Kommt nie wieder" },
	{ stored: 1, chosen: 0, key: up, choice: "keine Bewertung", said: "Bewertung zurückgesetzt" },
	{ stored: -1, chosen: 0, key: down, choice: "keine Bewertung", said: "Bewertung zurückgesetzt" },
] as const;

for (const pair of PAIRS)
	for (const failure of ["refused", "lost"] as const)
		test(`RATE-SHEET-RETRY stored ${pair.stored} → chosen ${pair.chosen}, first request ${failure}: the retry sends ${pair.chosen} again and nothing else`, async ({
			page,
		}) => {
			const model = await setup(page, pair.stored);
			await expectRowShows(page, pair.stored);
			await page.getByRole("button", { name: "Song B — Test Artist bewerten" }).click();
			const sheet = page.getByRole("dialog");
			await expect(sheet.locator("#rate-title")).toHaveText("Song B");
			await expectSheetShows(sheet, pair.stored);

			// The first request fails: refused (nothing stored) or its answer lost (stored all the same).
			model.mode = failure;
			await pair.key(sheet).click();
			const alert = sheet.getByRole("alert");
			await expect(alert).toHaveText(
				failure === "refused"
					? /^Nicht gespeichert: Synthetic 503/
					: /^Speicherung nicht bestätigt: /,
			);
			await expect(alert).toContainText(`Gewählt war: ${pair.choice}.`);
			const afterFailure = failure === "refused" ? pair.stored : pair.chosen;
			expect(model.stored).toBe(afterFailure);
			expect(model.writes.map((w) => w.value)).toEqual([pair.chosen]);

			// A controlled read of the state: the API says what is stored now, the row shows it,
			// and the sheet still holds the same song and the same failed choice, with no success said.
			expect(await readState(page)).toBe(afterFailure);
			await expectRowShows(page, afterFailure);
			await expect(sheet).toBeVisible();
			await expect(sheet.locator("#rate-title")).toHaveText("Song B");
			await expect(alert).toContainText(`Gewählt war: ${pair.choice}.`);
			await expect(page.locator(".flash")).not.toHaveText(pair.said);
			expect(model.writes).toHaveLength(1);
			// The open sheet itself says what is stored now. Without this a retry that toggles its
			// key again from a stale sheet would send the same values as one keeping the choice.
			// Soft, so the request gates below still run when it fails.
			await expectSheetShows(sheet, afterFailure, expect.soft);

			// The explicit retry, its answer held: the original choice once more, while pending
			// repeated quick taps on both keys and the retry send nothing further.
			model.mode = "hold";
			const retry = sheet.getByRole("button", { name: "Nochmal speichern" });
			await retry.click();
			await expect.poll(() => model.writes.length).toBe(2);
			await up(sheet).dblclick({ force: true });
			await down(sheet).dblclick({ force: true });
			await pair.key(sheet).click({ force: true, clickCount: 3 });
			if (await retry.count()) await retry.dblclick({ force: true });
			// Past the taps: half a second on the page's clock, then a full state round trip.
			await page.clock.runFor(500);
			expect(await readState(page)).toBe(pair.chosen);
			expect(model.writes).toHaveLength(2);
			await expect(sheet).toBeVisible();
			await expect(sheet.locator("#rate-title")).toHaveText("Song B");
			await expect(page.locator(".flash")).not.toHaveText(pair.said);

			// Confirmed: the sheet closes and the success is the chosen value's.
			expect(model.held).toHaveLength(1);
			const before = model.reads;
			await model.held.pop()!();
			await expect(sheet).toBeHidden();
			await expect(page.locator(".flash")).toHaveText(pair.said);
			await expectRowShows(page, pair.chosen);

			// Then the page's own later work: its follow-up read after a stored rating (800 ms)
			// and its regular poll (15 s), each seen arriving. Nothing new is sent meanwhile.
			await page.clock.runFor(1_000);
			await expect.poll(() => model.reads).toBeGreaterThan(before);
			const followed = model.reads;
			await page.clock.runFor(15_000);
			await expect.poll(() => model.reads).toBeGreaterThan(followed);
			await expectRowShows(page, pair.chosen);
			expect(await readState(page)).toBe(pair.chosen);
			await expectRowShows(page, pair.chosen);

			expect(model.writes).toEqual([
				{ path: `/api/tracks/${B.id}/thumb`, value: pair.chosen, expected: undefined },
				{ path: `/api/tracks/${B.id}/thumb`, value: pair.chosen, expected: undefined },
			]);
			expect(model.stored).toBe(pair.chosen);
			// Nothing but the two ratings was sent: no playback, no next, nothing outside loopback.
			expect(model.mutations).toEqual([
				`POST /api/tracks/${B.id}/thumb`,
				`POST /api/tracks/${B.id}/thumb`,
			]);
			expect(model.unexpected).toEqual([]);
			expect(model.outside).toEqual([]);
			expect([...model.origins]).toEqual([new URL(test.info().project.use.baseURL!).origin]);
		});
