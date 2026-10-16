/**
 * TS-REPRO-261016-R4, browser counter-case to the R3 fix (74fa617), the form the
 * UI can reach: the rating sheet stays open across a browser "forward" into the
 * Verlauf. The Verlauf asks its list L (held); then the page asks a snapshot R,
 * which answers at once with the older stored −1 (R was served before write 5);
 * L answers last with +1 at write number 5. The newer stored rating is +1: the
 * Verlauf row shows it, and the still open sheet must show it too.
 * Rendered client against intercepted API answers; no provider, no other origin.
 */
import { expect, type Route, test } from "@playwright/test";
import { DEFAULT_RULES } from "../src/core/types";
import type { AppState, HistoryEntry } from "../src/shared/api";

test.use({ viewport: { width: 390, height: 844 } });

type Thumb = -1 | 0 | 1;
const TIME = Date.UTC(2026, 9, 1, 12);
const song = (id: string, name: string, thumb: Thumb = 0) => ({
	id,
	name,
	artists: "Test Artist",
	album: "Test Album",
	imageUrl: null,
	durationMs: 180_000,
	thumb,
});

function snapshot(b: Thumb, serverTime: number): AppState {
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
				{ entryId: "entry-0", track: song("track-a", "Song A") },
				{ entryId: "entry-1", track: song("track-b", "Song B", b) },
				{ entryId: "entry-2", track: song("track-c", "Song C") },
			],
		},
		nowPlaying: {
			...song("track-a", "Song A"),
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
const listed = (thumb: Thumb, rated: number): HistoryEntry[] => [
	{
		...song("track-b", "Song B", thumb),
		playedAt: TIME - 60_000,
		stationName: null,
		ignored: false,
		rated,
	},
];

test("RATE-SHEET-FRESHNESS browser: Verlauf list (+1, write 5) answered after an older snapshot (−1): Verlauf and the open sheet both show +1", async ({
	page,
}) => {
	const origin = new URL(test.info().project.use.baseURL!).origin;
	const m = {
		state: { b: 0 as Thumb, time: TIME },
		lists: [] as { answer: (rows: HistoryEntry[]) => Promise<void> }[],
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
		if (req.method() !== "GET") m.mutations.push(`${req.method()} ${url.pathname}`);
		if (url.pathname === "/api/state")
			return route.fulfill({ json: snapshot(m.state.b, m.state.time) });
		if (url.pathname === "/api/devices") return route.fulfill({ json: [] });
		if (url.pathname === "/api/native/devices")
			return route.fulfill({ json: { configured: false, devices: [] } });
		if (url.pathname === "/api/history") {
			m.lists.push({ answer: (rows) => route.fulfill({ json: rows }) });
			return;
		}
		m.unexpected.push(`${req.method()} ${url.pathname}`);
		return route.fulfill({ status: 500, json: { error: { code: "x", message: url.pathname } } });
	});

	await page.goto("/");
	await expect(page.locator(".now-copy h2")).toHaveText("Song A");
	// First visit to the Verlauf: its list agrees with the snapshot (0, write 3).
	await page.getByRole("link", { name: "Verlauf", exact: true }).click();
	await expect.poll(() => m.lists.length).toBe(1);
	await m.lists[0]!.answer(listed(0, 3));
	const verlaufRow = page.locator(".hist-row").filter({ hasText: "Song B" });
	await expect(verlaufRow).toHaveCount(1);
	await expect(verlaufRow.getByRole("button", { name: "Favorit" })).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	// Back home; the sheet opens on Song B (0).
	await page.goBack();
	await expect(page.locator(".now-copy h2")).toHaveText("Song A");
	await page.getByRole("button", { name: "Song B — Test Artist bewerten" }).click();
	const sheet = page.getByRole("dialog");
	await expect(sheet.locator("#rate-title")).toHaveText("Song B");
	await expect(sheet.getByRole("button", { name: "Daumen hoch: Favorit" })).toHaveAttribute(
		"aria-pressed",
		"false",
	);

	// Forward into the Verlauf with the sheet still open: L is asked and held.
	await page.goForward();
	await expect.poll(() => m.lists.length).toBe(2);
	await expect(sheet).toBeVisible();
	// Then a snapshot R is asked, served before write 5: it answers −1 at once.
	m.state = { b: -1, time: TIME + 1 };
	const r = page.waitForResponse((x) => new URL(x.url()).pathname === "/api/state");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await r;
	// L answers last: +1 at write 5, the newer stored rating.
	await m.lists[1]!.answer(listed(1, 5));

	// The Verlauf repaints to +1 (visible), and the open sheet shows the same +1.
	await expect(verlaufRow).toHaveCount(1);
	await expect(verlaufRow.getByRole("button", { name: "Favorit" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(verlaufRow.getByRole("button", { name: "Nie wieder" })).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(sheet).toBeVisible();
	await expect(sheet.locator("#rate-title")).toHaveText("Song B");
	const actual = {
		sheetUp: await sheet
			.getByRole("button", { name: "Daumen hoch: Favorit" })
			.getAttribute("aria-pressed"),
		sheetDown: await sheet
			.getByRole("button", { name: "Daumen runter: nie wieder" })
			.getAttribute("aria-pressed"),
		verlaufFavorit: await verlaufRow
			.getByRole("button", { name: "Favorit" })
			.getAttribute("aria-pressed"),
	};
	expect(actual).toEqual({ sheetUp: "true", sheetDown: "false", verlaufFavorit: "true" });
	expect(m.mutations).toEqual([]);
	expect(m.unexpected).toEqual([]);
	expect(m.outside).toEqual([]);
	expect([...m.origins]).toEqual([origin]);
});
