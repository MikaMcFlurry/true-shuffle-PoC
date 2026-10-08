/**
 * One listener's story, start to finish, against the real Worker and the
 * Spotify stand-in (synthetic demo library, see e2e/fake-server.ts).
 */

import { expect, type Page, test } from "@playwright/test";
import type { SpotifyUsageReport, SpotifyUsageTotals } from "../src/shared/spotify-usage";

const FAKE = "http://127.0.0.1:8788/__control";

interface FakeStatus {
	current: string | null;
	context: string | null;
	playing: boolean;
	shuffle: boolean;
}

async function fake(action: string): Promise<FakeStatus> {
	const res = await fetch(`${FAKE}/${action}`);
	return (await res.json()) as FakeStatus;
}

async function signIn(page: Page): Promise<void> {
	await page.goto("/");
	await page.getByRole("link", { name: "Mit Spotify anmelden" }).click();
}

/** No sideways scrolling, and every control says what it does. */
async function checkPage(page: Page, where: string): Promise<void> {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow, `${where}: horizontal overflow`).toBeLessThanOrEqual(0);
	const unnamed = await page.evaluate(() =>
		[...document.querySelectorAll("button, a[href], input, select")]
			.filter((el) => {
				const h = el as HTMLElement;
				if (h.offsetParent === null && getComputedStyle(h).position !== "fixed") return false;
				const label =
					h.getAttribute("aria-label") ??
					(h.id ? document.querySelector(`label[for="${h.id}"]`)?.textContent : null) ??
					h.closest("label")?.textContent ??
					h.textContent;
				return !label?.trim();
			})
			.map((el) => el.outerHTML.slice(0, 120)),
	);
	expect(unnamed, `${where}: controls without a name`).toEqual([]);
}

/** Nothing sticks out of the box it sits in, where a clipping box would cut it off. */
async function checkContained(page: Page, where: string): Promise<void> {
	const out = await page.evaluate(() =>
		[...document.querySelectorAll("body *")]
			.filter((el) => {
				const p = el.parentElement;
				if (!p || el.closest("svg")) return false;
				const cs = getComputedStyle(el);
				// Placed or turned on purpose (lamps, needles, knob caps): not flow content.
				if (cs.position === "absolute" || cs.position === "fixed" || cs.transform !== "none")
					return false;
				const r = el.getBoundingClientRect();
				const pr = p.getBoundingClientRect();
				if (r.width === 0 || pr.width === 0) return false;
				return r.right > pr.right + 1 || r.left < pr.left - 1;
			})
			.map((el) => `${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""}`),
	);
	expect(out, `${where}: wider than its box`).toEqual([]);
}

/** No words cut off: text that does not fit wraps; it is never clipped or ended with "…". */
async function checkText(page: Page, where: string): Promise<void> {
	const cut = await page.evaluate(() =>
		[...document.querySelectorAll("body *")]
			.filter((el) => {
				const h = el as HTMLElement;
				if (![...h.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim())) return false;
				const cs = getComputedStyle(h);
				if (h.offsetParent === null && cs.position !== "fixed") return false;
				// Visually hidden text for screen readers is 1 px on purpose.
				if (h.clientWidth <= 2) return false;
				if (cs.overflowX === "visible" && cs.overflowY === "visible") return false;
				return h.scrollWidth > h.clientWidth + 1 || h.scrollHeight > h.clientHeight + 2;
			})
			.map((el) => `${el.getAttribute("class") ?? el.tagName}: ${el.textContent?.trim()}`),
	);
	expect(cut, `${where}: text cut off`).toEqual([]);
}

/** Pages whose explanations arrive after the heading: wait for them. */
const EXPLAINED: Record<string, RegExp> = {
	"/suchlauf": /Spotify gibt die Songs nicht heraus/,
	"/sender/neu": /Spotify gibt die Songs nicht heraus/,
	"/geraete": /Das gerade aktive Gerät, sonst dein Handy/,
};

test.describe.configure({ mode: "serial" });

test.describe("a listener's day", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("shows signed-out users as online after a normal authentication response", async ({
		page,
	}) => {
		const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/state");
		await page.goto("/");
		expect((await response).status()).toBe(401);
		await expect(page.getByRole("link", { name: "Mit Spotify anmelden" })).toBeVisible();
		await expect(page.getByText("Offline oder nicht erreichbar.", { exact: false })).toBeHidden();
	});

	test("signs in with Spotify and saves playlists as stations", async ({ page }) => {
		await signIn(page);
		await expect(page.getByText("Wähle, welche Playlists Kassetten werden")).toBeVisible();
		await checkPage(page, "Sendersuchlauf");
		// A playlist of someone else cannot be read (Spotify keeps its songs).
		await expect(page.getByRole("checkbox", { name: /Today's Top Hits/ })).toBeDisabled();
		await page.getByRole("checkbox", { name: /Indie & Gitarren/ }).check();
		await page.getByRole("checkbox", { name: /Lange Autofahrt/ }).check();
		await page.getByRole("button", { name: "2 Kassetten anlegen" }).click();

		// Home: the automatic "Alles" plus the two stations, ready once imported.
		for (const name of ["Alles", "Indie & Gitarren", "Lange Autofahrt"]) {
			await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toBeEnabled({
				timeout: 60_000,
			});
		}
		await checkPage(page, "home");
	});

	test("starts a station in Spotify, in true-shuffle's order", async ({ page }) => {
		await signIn(page);
		await page.getByRole("button", { name: /^Indie & Gitarren/ }).click();
		await page.getByRole("button", { name: "Wiedergabe starten" }).click();
		const display = page.locator(".player");
		await expect(page.locator(".station-actions")).toContainText("Indie & Gitarren");
		await expect(page.locator(".promise")).toContainText("Deine Stelle bleibt");
		await expect(display).toContainText("Läuft auf Mikas iPhone");
		await expect(page.locator(".session-status")).toHaveText("Spielt");

		const s = await fake("status");
		expect(s.playing).toBe(true);
		expect(s.shuffle).toBe(false);
		expect(s.context).toMatch(/^spotify:playlist:/);
		// Playing now: a tap opens the station instead of starting it over.
		const tile = page.getByRole("link", { name: "Indie & Gitarren: Mix und Regeln" });
		await expect(tile).toBeVisible();
		await tile.click();
		await expect(page.getByRole("heading", { name: "Indie & Gitarren", level: 1 })).toBeVisible();
		await expect(page.getByText("Läuft gerade").first()).toBeVisible();
		expect((await fake("status")).playing).toBe(true);
	});

	test("counts song time locally without additional API requests", async ({ page }) => {
		await signIn(page);
		const progress = page.getByRole("progressbar", { name: "Geschätzte Songposition" });
		await expect(progress).toBeVisible();
		const before = await progress.evaluate((el) => (el as HTMLProgressElement).value);
		let calls = 0;
		page.on("request", (request) => {
			if (new URL(request.url()).pathname.startsWith("/api/")) calls++;
		});
		await expect
			.poll(
				async () => (await progress.evaluate((el) => (el as HTMLProgressElement).value)) - before,
			)
			.toBeGreaterThanOrEqual(1000);
		expect(calls).toBe(0);
		await expect(page.locator(".progress-labels")).not.toContainText("gespeichert");
	});

	test("skips and bans a song from the transport keys", async ({ page }) => {
		await signIn(page);
		const song = page.locator(".now-copy h2");
		await expect(song).not.toBeEmpty();
		const first = (await fake("status")).current;
		expect(first).not.toBeNull();

		await page.getByRole("button", { name: "Weiter: Nächster Song" }).click();
		await expect(page.getByRole("button", { name: "Weiter: Nächster Song" })).toBeEnabled();
		// Synthetic tracks reuse titles; Spotify track identity must change.
		await expect.poll(async () => (await fake("status")).current).not.toBe(first);

		const before = (await fake("status")).current;
		await page.getByRole("button", { name: "Daumen runter: diesen Song nie wieder" }).click();
		await expect(page.getByText("Kommt nie wieder")).toBeVisible();
		await expect.poll(async () => (await fake("status")).current).not.toBe(before);
	});

	test("shows the station with its round, mix and next songs", async ({ page }) => {
		await signIn(page);
		// Every cassette is set up from the shelf (Kassetten).
		await page.getByRole("link", { name: "Kassetten" }).click();
		await page.getByRole("link", { name: "Indie & Gitarren einstellen" }).click();
		await expect(page.getByRole("heading", { name: "Indie & Gitarren", level: 1 })).toBeVisible();
		const panel = page.locator(".page");
		await expect(panel.getByText(/von 400 Songs gehört/).first()).toBeVisible();
		// Song rows only: each row also holds its own list of tags.
		const next = page
			.getByRole("region", { name: "Als Nächstes" })
			.getByRole("listitem")
			.filter({ has: page.getByRole("button", { name: / bewerten$/ }) });
		await expect(next.first()).toBeVisible();
		await checkPage(page, "station");

		// On the sheet the mix is printed as the knob's three positions to choose from.
		await page.getByRole("radio", { name: "Vertraut" }).check();
		await expect(page.getByText(/50 % ungehört/)).toBeVisible();
		await page.getByRole("radio", { name: "Entdecker" }).check();
		await expect(page.getByText(/60 % ungehört/)).toBeVisible();

		// Rated afterwards, not only while it plays: a song further down the list.
		const third = next.nth(2);
		await third.getByRole("button", { name: / bewerten$/ }).click();
		const sheet = page.getByRole("dialog");
		await expect(sheet).toBeVisible();
		await sheet.getByRole("button", { name: "Daumen runter: nie wieder" }).click();
		await expect(sheet).toBeHidden();
		await expect(third.getByRole("img", { name: "Kommt nie wieder" })).toBeVisible();
	});

	test("guest mode keeps someone else's music out of the memory", async ({ page }) => {
		await signIn(page);
		await page.getByRole("link", { name: "Mehr" }).click();
		await checkPage(page, "menu");
		await page.getByRole("switch", { name: /Gast-Modus/ }).check();
		await expect(page.getByText(/Gast-Modus an/)).toBeVisible();
		await page.getByRole("link", { name: "Jetzt" }).click();
		await expect(page.locator(".player-heading").getByText(/Gast-Modus/)).toBeVisible();

		await page.getByRole("link", { name: "Mehr" }).click();
		await page.getByRole("switch", { name: /Gast-Modus/ }).uncheck();
		await expect(page.getByText(/Gast-Modus aus/)).toBeVisible();
	});

	test("a personal key likes the playing song from Siri or a widget", async ({ page }) => {
		await signIn(page);
		await page.getByRole("link", { name: "Mehr" }).click();
		await page.getByRole("link", { name: /Fernbedienung/ }).click();
		await expect(page.getByRole("heading", { name: "Fernbedienung", level: 1 })).toBeVisible();
		await page.getByRole("button", { name: "Schlüssel erstellen" }).click();
		const field = page.getByRole("textbox", { name: "Dein Schlüssel" });
		await expect(field).toHaveValue(/^Bearer tsr_/);
		await checkPage(page, "/fernbedienung");
		const key = (await field.inputValue()).replace(/^Bearer /, "");

		// A Shortcut sends a POST with the key; nothing else gets in.
		const bad = await page.request.post("/remote/like", {
			headers: { authorization: "Bearer tsr_made-up" },
		});
		expect(bad.status()).toBe(401);
		expect(await bad.text()).toMatch(/Kein gültiger Schlüssel/);
		const res = await page.request.post("/remote/like", {
			headers: { authorization: `Bearer ${key}` },
		});
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toMatch(/^text\/plain/);
		expect(await res.text()).toMatch(/ist jetzt Favorit\.$/);

		// A new key ends the old one.
		await page.getByRole("button", { name: "Neuer Schlüssel" }).click();
		await page.getByRole("button", { name: "Neu erstellen" }).click();
		await expect(field).not.toHaveValue(key);
		const old = await page.request.post("/remote/skip", {
			headers: { authorization: `Bearer ${key}` },
		});
		expect(old.status()).toBe(401);
	});

	test("every page reads well on a phone", async ({ page }) => {
		await signIn(page);
		await expect(page.getByRole("button", { name: /^Alles/ })).toBeVisible();
		for (const path of [
			"/verlauf",
			"/import",
			"/geraete",
			"/fernbedienung",
			"/info",
			"/sender/neu",
			"/suchlauf",
		]) {
			await page.goto(path);
			await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
			const why = EXPLAINED[path];
			if (why) await expect(page.getByText(why).first()).toBeVisible();
			await checkPage(page, path);
			await checkText(page, path);
		}
		// The reason a playlist cannot be chosen, or what a device setting means,
		// is read in full on small phones too.
		for (const w of [320, 360, 390]) {
			await page.setViewportSize({ width: w, height: 700 });
			for (const [path, why] of Object.entries(EXPLAINED)) {
				await page.goto(path);
				await expect(page.getByText(why).first()).toBeVisible();
				await checkPage(page, `${path} at ${w} px`);
				await checkText(page, `${path} at ${w} px`);
			}
		}
		// The smallest phones reflow too (WCAG 1.4.10): home and a station page at 320 px.
		await page.setViewportSize({ width: 320, height: 700 });
		await page.goto("/");
		await expect(page.getByRole("button", { name: /^Alles/ })).toBeVisible();
		await checkPage(page, "/ at 320 px");
		await page.goto("/sender");
		const station = await page
			.getByRole("link", { name: "Indie & Gitarren einstellen" })
			.getAttribute("href");
		await checkPage(page, "/sender at 320 px");
		await page.goto(station ?? "/");
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		await checkPage(page, `${station} at 320 px`);

		// A long name with no break in it still reflows: on the dial, the back panel, its page.
		const long = "Donaudampfschifffahrtsgesellschaftskapitänsmützenhalterungen";
		expect(long).toHaveLength(60);
		const st = (await (await page.request.get("/api/state")).json()) as {
			stations: { id: number; name: string }[];
		};
		const lange = st.stations.find((x) => x.name === "Lange Autofahrt");
		expect(lange).toBeDefined();
		const rename = (name: string) =>
			page.request.patch(`/api/stations/${lange?.id}`, {
				headers: { "x-ts": "1", "content-type": "application/json" },
				data: { name },
			});
		expect((await rename(long)).ok()).toBe(true);
		try {
			for (const path of ["/", "/sender", `/sender/${lange?.id}`]) {
				await page.goto(path);
				await expect(page.getByText(long).first()).toBeVisible();
				await checkPage(page, `${path} at 320 px with a 60-character name`);
			}
		} finally {
			expect((await rename("Lange Autofahrt")).ok()).toBe(true);
		}

		// Opened up — the station's advanced settings, and any folds on the menu
		// and the remote page — every page still fits at 320 and 360 px.
		for (const w of [320, 360]) {
			await page.setViewportSize({ width: w, height: 700 });
			for (const path of [`/sender/${lange?.id}`, "/menu", "/fernbedienung"]) {
				await page.goto(path);
				await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
				if (path.startsWith("/sender/"))
					await expect(page.getByText("Erweitert", { exact: true })).toBeVisible();
				const folds = await page.evaluate(() => {
					const all = [...document.querySelectorAll("details")];
					for (const d of all) d.open = true;
					return all.length;
				});
				if (path.startsWith("/sender/")) expect(folds).toBeGreaterThan(0);
				await checkPage(page, `${path} at ${w} px, opened up`);
				await checkContained(page, `${path} at ${w} px, opened up`);
			}
		}

		// The song about to be rated shows its whole title, however long: here the
		// next song on the station page is given a 159-character one.
		const title =
			"Leuchtturm im Nebel über dem alten Hafen (Live aus der Waldbühne Berlin, 14. Juli 1987, mit dem Rundfunk-Sinfonieorchester und Gästen) – 2024 Remaster (Deluxe)";
		expect(title.length).toBeGreaterThan(150);
		await page.route(`**/api/stations/${lange?.id}`, async (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			const response = await route.fetch();
			const json = (await response.json()) as { upcoming: { name: string }[] };
			if (json.upcoming[0]) json.upcoming[0].name = title;
			await route.fulfill({ response, json });
		});
		await page.setViewportSize({ width: 320, height: 700 });
		await page.goto(`/sender/${lange?.id}`);
		const rows = page
			.getByRole("region", { name: "Als Nächstes" })
			.getByRole("listitem")
			.filter({ has: page.getByRole("button", { name: / bewerten$/ }) });
		await expect(rows.first()).toContainText(title);
		await checkText(page, "a 159-character title in the running order");
		await rows
			.first()
			.getByRole("button", { name: / bewerten$/ })
			.click();
		const sheet = page.getByRole("dialog");
		await expect(sheet).toBeVisible();
		await expect(sheet.locator("#rate-title")).toHaveText(title);
		await checkText(page, "rating sheet at 320 px with a 159-character title");
		await checkContained(page, "rating sheet at 320 px");
		await sheet.getByRole("button", { name: "Abbrechen" }).click();
		await expect(sheet).toBeHidden();
		await page.unroute(`**/api/stations/${lange?.id}`);

		// A device with a long name wraps inside the card.
		const device = "Wohnzimmerlautsprecheranlagenverstärkerfernbedienungsempfänger";
		await fake(`devices?name=${encodeURIComponent(device)}`);
		try {
			await page.request.post("/api/sync", { headers: { "x-ts": "1" } });
			for (const w of [320, 390]) {
				await page.setViewportSize({ width: w, height: 700 });
				await page.goto("/");
				await expect(
					page.locator(".device-note").getByText(`Zuletzt auf ${device}`, { exact: true }),
				).toBeVisible({ timeout: 20_000 });
				await checkPage(page, `/ at ${w} px with a long device name`);
				await checkContained(page, `/ at ${w} px with a long device name`);
			}
		} finally {
			await fake("devices");
			await page.request.post("/api/sync", { headers: { "x-ts": "1" } });
		}
	});

	test("every cassette name stays on its label, whatever script or font draws it", async ({
		page,
	}) => {
		await signIn(page);
		const NAMES = [
			"東京東京東京東京東",
			"Sommer 🌞🎸 Roadtrip ☀️ mit Freunden",
			"Ελληνικά Лето مرحبا",
			"WWWWWWWWWWWWWWWWWWWWWWWWWWWW",
			"Wohnzimmer Wochenende Mitternachtsmix für lange Abende",
		];
		// The app asks for /api/state with a query string, so a plain glob would miss it.
		const STATE = /\/api\/state(\?|$)/;
		await page.route(STATE, async (route) => {
			const response = await route.fetch();
			const json = (await response.json()) as { stations: { name: string }[] };
			json.stations.forEach((s, i) => {
				s.name = NAMES[i % NAMES.length]!;
			});
			await route.fulfill({ response, json });
		});
		for (const [width, scheme] of [
			[390, "light"],
			[390, "dark"],
			[1440, "light"],
			[1440, "dark"],
		] as const) {
			await page.setViewportSize({ width, height: 900 });
			await page.emulateMedia({ colorScheme: scheme });
			for (const path of ["/sender", "/"]) {
				await page.goto(path);
				await expect(page.locator(".cassette__name").getByText(NAMES[0]!).first()).toBeAttached();
				await page.evaluate(() => document.fonts.ready);
				// The label is the rect x 22..298 in the cassette's own units.
				const out = await page.locator(".cassette__name tspan").evaluateAll((spans) =>
					spans
						.map((el) => {
							const b = (el as SVGGraphicsElement).getBBox();
							return { text: el.textContent, left: b.x, right: b.x + b.width };
						})
						.filter((b) => b.left < 21.5 || b.right > 298.5),
				);
				expect(out, `${path} at ${width} px, ${scheme}`).toEqual([]);
			}
		}
		await page.unroute(STATE);
	});

	test("a station held paused plays on from its page, never starts over", async ({ page }) => {
		await signIn(page);
		const playing = await fake("status");
		expect(playing.playing).toBe(true);
		await fake("pause");
		// Let the hub look at the player now instead of at its next regular look.
		await page.request.post("/api/sync", { headers: { "x-ts": "1" } });
		await expect
			.poll(
				async () => {
					const st = (await (await page.request.get("/api/state?live=1")).json()) as {
						nowPlaying: { isPlaying: boolean; stationId: number | null } | null;
					};
					return st.nowPlaying && !st.nowPlaying.isPlaying ? st.nowPlaying.stationId : null;
				},
				{ timeout: 30_000 },
			)
			.not.toBeNull();
		const st = (await (await page.request.get("/api/state")).json()) as {
			nowPlaying: { stationId: number };
		};
		await page.goto(`/sender/${st.nowPlaying.stationId}`);
		await expect(page.getByRole("heading", { name: "Pausiert" })).toBeVisible();
		await page.getByRole("button", { name: "Fortsetzen" }).click();
		await expect.poll(async () => (await fake("status")).playing).toBe(true);
		expect((await fake("status")).current).toBe(playing.current);
	});

	test("says clearly when Spotify refuses: no Premium, no device", async ({ page }) => {
		await signIn(page);
		await fake("pause");

		await fake("premium?on=0");
		try {
			await page.getByRole("button", { name: /^Lange Autofahrt/ }).click();
			await page.locator(".transport-main").click();
			await expect(page.getByText(/nur mit Premium/)).toBeVisible();
		} finally {
			await fake("premium?on=1");
		}
		await fake("devices?none=1");
		try {
			await page.getByRole("button", { name: /^Lange Autofahrt/ }).click();
			await expect(page.locator(".transport-main")).toBeEnabled();
			await page.locator(".transport-main").click();
			await expect(page.getByText(/Öffne Spotify|Kein Spotify-Gerät/)).toBeVisible();
		} finally {
			await fake("devices?none=0");
		}
	});

	test("signs out and keeps the memory", async ({ page }) => {
		await signIn(page);
		const before = await page.context().cookies();
		await page.getByRole("link", { name: "Mehr" }).click();
		await page.getByRole("button", { name: /Abmelden/ }).click();
		await expect(page.getByRole("link", { name: "Mit Spotify anmelden" })).toBeVisible();

		// A copy of the old session cookie no longer opens anything.
		await page.context().addCookies(before);
		const res = await page.request.get("/api/state");
		expect(res.status()).toBe(401);
		await page.context().clearCookies();
		await page.goto("/");

		await page.getByRole("link", { name: "Mit Spotify anmelden" }).click();
		await expect(page.getByRole("button", { name: /^Indie & Gitarren/ })).toBeVisible();
	});
});

test.describe("calm player", () => {
	test.use({ viewport: { width: 1440, height: 900 } });
	test("shows current music and ordered queue beside the library", async ({ page }) => {
		await signIn(page);
		await expect(page.locator(".player")).toBeVisible();
		await expect(page.getByRole("region", { name: "Andere Kassette einlegen" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Als Nächstes" })).toBeVisible();
		await checkPage(page, "desktop player");
		await page.screenshot({ path: ".impeccable/review/desktop.png", fullPage: true });
		await page.getByRole("link", { name: "Mehr", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Mehr", level: 1 })).toBeVisible();
		await checkPage(page, "desktop settings");
	});
	test("keeps saved song, progress and queue across reload and another browser", async ({
		page,
		browser,
	}) => {
		await signIn(page);
		await page.getByRole("button", { name: /^Indie & Gitarren/ }).click();
		await page.getByRole("button", { name: /Fortsetzen|Wiedergabe starten/ }).click();
		await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
		await expect.poll(async () => (await fake("status")).playing).toBe(true);
		await fake("position?ms=97000&paused=1");
		await page.request.post("/api/sync", { headers: { "x-ts": "1" } });
		await page.reload();
		await expect(page.getByText("1:37 gespeichert")).toBeVisible();
		const before = await (await page.request.get("/api/state")).json();
		await page.reload();
		await expect(page.getByText("1:37 gespeichert")).toBeVisible();
		const context = await browser.newContext({
			baseURL: new URL(page.url()).origin,
			locale: "de-DE",
			timezoneId: "Europe/Berlin",
		});
		try {
			const other = await context.newPage();
			await signIn(other);
			await expect(other.getByText("1:37 gespeichert")).toBeVisible();
			await other.getByRole("button", { name: "Fortsetzen" }).click();
			await expect.poll(async () => (await fake("status")).playing).toBe(true);
			const after = await (await other.request.get("/api/state")).json();
			expect(after.session.sessionId).toBe(before.session.sessionId);
			expect(after.session.entryId).toBe(before.session.entryId);
			expect(after.session.queue.map((e: { entryId: string }) => e.entryId)).toEqual(
				before.session.queue.map((e: { entryId: string }) => e.entryId),
			);
		} finally {
			await context.close();
		}
	});
	test("handles offline state, light and dark mobile, keyboard and deliberate new queue", async ({
		page,
	}) => {
		await signIn(page);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
		await checkPage(page, "dark mobile");
		await page.screenshot({
			path: ".impeccable/review/mobile.png",
			fullPage: true,
		});
		await page.emulateMedia({ colorScheme: "light" });
		await page.screenshot({
			path: ".impeccable/review/mobile-light.png",
			fullPage: true,
		});
		await page.getByRole("button", { name: /neu mischen …$/ }).click();
		await expect(page.getByRole("button", { name: "Ja, neu mischen" })).toBeVisible();
		await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
		await page.context().setOffline(true);
		await page.getByRole("button", { name: "Geräte aktualisieren" }).click();
		await expect(page.getByText(/Geräte nicht geladen/)).toBeVisible();
		await page.screenshot({ path: ".impeccable/review/mobile-offline.png", fullPage: true });
		await page.context().setOffline(false);
		await page.keyboard.press("Tab");
		const focused = await page.evaluate(() => document.activeElement?.tagName);
		expect(["BUTTON", "A", "SELECT"]).toContain(focused);
	});
});

test.describe("confirmed Spotify operations and shared usage", () => {
	test.use({ viewport: { width: 390, height: 844 }, timezoneId: "Europe/Berlin" });
	async function openDiagnostics(page: Page): Promise<void> {
		await signIn(page);
		await page.goto("/mehr");
		const onboarding = page.getByText("Wähle, welche Playlists Kassetten werden", { exact: true });
		const details = page.getByText("Spotify-Freigabe & Anfragestatus", { exact: true });
		await expect(onboarding.or(details)).toBeVisible();
		if (await onboarding.isVisible()) {
			await page.getByRole("button", { name: "Nur mit „Alles“ starten" }).click();
			await expect(page.getByRole("button", { name: /^Alles/ })).toBeEnabled({ timeout: 60000 });
			await page.goto("/mehr");
		}
		await details.click();
	}
	function usage(now: number): SpotifyUsageReport {
		const day: SpotifyUsageTotals = {
			sent: 5,
			read: 3,
			write: 1,
			refresh: 1,
			blocked: 9,
			quota: 1,
			rate: 0,
			network: 0,
		};
		const older: SpotifyUsageTotals = {
			sent: 10,
			read: 7,
			write: 2,
			refresh: 1,
			blocked: 0,
			quota: 0,
			rate: 0,
			network: 0,
		};
		const totals: SpotifyUsageTotals = {
			sent: 15,
			read: 10,
			write: 3,
			refresh: 2,
			blocked: 9,
			quota: 1,
			rate: 0,
			network: 0,
		};
		return {
			policy: "confirmed-operation-v1",
			generatedAt: now,
			startedAt: now - 40 * 3600_000,
			retentionHours: 720,
			listenerCapacity: 5,
			registeredListeners: 5,
			observedListeners: 2,
			overflowObserved: false,
			totals,
			listeners: [
				{ listener: "Nutzer 1", totals: day },
				{ listener: "Nutzer 2", totals: older },
			],
			operations: [
				{
					operation: "GET /artists/:id/albums",
					totals: day,
					responses: { "429:quota": 1, "200:none": 2 },
				},
				{ operation: "PUT /me/player/play", totals: older, responses: { "204:none": 2 } },
			],
			hours: [
				{ hour: Math.floor(now / 3600_000), totals: day },
				{ hour: Math.floor(now / 3600_000) - 40, totals: older },
			],
			episodes: [
				{
					id: 1,
					listener: "Nutzer 1",
					operation: "GET /artists/:id/albums",
					firstFailureAt: now - 60_000,
					lastFailureAt: now - 50_000,
					reason: "QUOTA_EXCEEDED",
					retryAfter: "49",
					earliestRetryAt: now - 1000,
					attempts: 3,
					lastAttemptAt: now,
					lastStatus: 200,
					firstSuccessAt: now,
				},
			],
		};
	}
	test("shows app-wide observations without exposing identities or inventing remaining capacity", async ({
		page,
	}) => {
		const now = Date.now();
		const report = usage(now);
		let reads = 0;
		await page.route("**/api/spotify/usage", (route) => {
			reads++;
			return route.fulfill({ json: report });
		});
		await page.route("**/api/spotify/diagnostics", (route) =>
			route.fulfill({
				json: { policyVersion: 2, cooldown: null, operationCooldowns: [], requests: null },
			}),
		);
		await openDiagnostics(page);
		const tracker = page.getByRole("region", { name: "Gemeinsame Spotify-Nutzung" });
		await expect(tracker).toContainText("2 Konten mit beobachteten Anfragen");
		await expect(tracker).toContainText("5 angemeldete Konten");
		await expect(tracker).toContainText("Bis zu 5 Konten");
		await expect(tracker).toContainText(
			"3 Leseversuche · 1 Schreibversuch · 1 Token-Erneuerung · 9 lokal zurückgehalten · 1 echte 429-Antwort",
		);
		await expect(tracker).toContainText(
			"10 Leseversuche · 3 Schreibversuche · 2 Token-Erneuerungen",
		);
		await expect(tracker).toContainText("720 Stundenblöcke");
		await expect(tracker).toContainText("Andere Apps und deren Anfragen sind hier nicht sichtbar");
		await tracker.getByText("Operationen und anonyme Konten", { exact: true }).click();
		await expect(tracker.getByText("Nutzer 1", { exact: true })).toBeVisible();
		await expect(tracker.getByText("Nutzer 2", { exact: true })).toBeVisible();
		await tracker.getByText("Bestätigte 429 und beobachtete Erholung", { exact: true }).click();
		await tracker
			.getByText(/Nutzer 1 · GET \/artists\/:id\/albums · Erfolg danach beobachtet/)
			.click();
		await expect(tracker.getByText("Erster anschließender Erfolg", { exact: true })).toBeVisible();
		await expect(tracker).toContainText("nicht den genauen Reset-Zeitpunkt");
		await expect(tracker).toContainText("HTTP 200 · 3 Versuche");
		expect(await tracker.textContent()).not.toMatch(
			/spotify:user:|Bearer|access_token|mika@|remainingcapacity|übrige Anfragen/,
		);
		expect(reads).toBeGreaterThan(0);
		await checkPage(page, "shared usage mobile");
		await checkText(page, "shared usage mobile");
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
			await page.evaluate(async () => {
				(document.activeElement as HTMLElement)?.blur();
				window.scrollTo(0, 0);
				await new Promise(requestAnimationFrame);
				await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
			});
			await page.screenshot({
				path: `.impeccable/review/spotify-usage-${theme}.png`,
				fullPage: true,
			});
		}
	});
	test("holds only confirmed operations and never revives a legacy inferred global gate", async ({
		page,
	}) => {
		let until: number | null = Date.now() + 30363_000;
		const legacy = {
			until: Date.now() + 300_000,
			kind: "quota",
			reason: "LEGACY_INFERRED",
			retryAfter: "300",
			observedAt: Date.now(),
		};
		await page.route("**/api/spotify/usage", (route) => route.fulfill({ json: usage(Date.now()) }));
		await page.route("**/api/spotify/diagnostics", (route) =>
			route.fulfill({
				json: {
					policyVersion: 2,
					cooldown: legacy,
					catalogQuarantine: legacy,
					operationCooldowns: [
						{
							operation: "GET /me/player/devices",
							until,
							kind: "quota",
							reason: "QUOTA_EXCEEDED",
							retryAfter: until === null ? null : "30363",
							observedAt: Date.now(),
						},
					],
					availability: {
						testedAt: Date.now(),
						outcomes: {
							devices: { state: "held", status: 429, reason: "QUOTA_EXCEEDED" },
							player: { state: "available", status: 204 },
							history: { state: "available", status: 200 },
						},
						catalog: "untested",
						controls: "untested",
						stopped: false,
					},
					requests: null,
				},
			}),
		);
		await openDiagnostics(page);
		await expect(page.getByText("Abfrage erfolgreich · 204", { exact: true })).toBeVisible();
		await expect(page.getByText("Abfrage erfolgreich · 200", { exact: true })).toBeVisible();
		await expect(page.getByText(/Bestätigte 429 · diese Abfrage wartet/)).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Geräte-Freigabe prüfen", exact: true }),
		).toBeDisabled();
		await expect(
			page.getByText("8 Stunden, 26 Minuten, 3 Sekunden (30.363 Sekunden)", { exact: true }),
		).toBeVisible();
		await expect(page.getByText(/Europe\/Berlin/).first()).toBeVisible();
		expect(await page.locator(".more__body").first().textContent()).not.toContain(
			"LEGACY_INFERRED",
		);
		await expect(
			page.getByText(/Starten, Pausieren und Übertragen wurden nicht geprüft/),
		).toBeVisible();
		until = Date.now() - 1;
		await page.getByRole("button", { name: "Status aktualisieren", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Geräte-Freigabe prüfen", exact: true }),
		).toBeEnabled();
		until = null;
		await page.getByRole("button", { name: "Status aktualisieren", exact: true }).click();
		await expect(page.getByText("Nicht von Spotify angegeben", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Geräte-Freigabe prüfen", exact: true }),
		).toBeEnabled();
		await checkPage(page, "confirmed operation gates");
		await checkText(page, "confirmed operation gates");
	});
	test("shows tracking failure with a retry and does not turn it into a Spotify block", async ({
		page,
	}) => {
		let fail = true;
		await page.route("**/api/spotify/usage", (route) =>
			route.fulfill(
				fail
					? {
							status: 503,
							json: {
								error: { code: "tracking_unavailable", message: "Messdaten nicht erreichbar" },
							},
						}
					: { json: usage(Date.now()) },
			),
		);
		await page.route("**/api/spotify/diagnostics", (route) =>
			route.fulfill({
				json: { policyVersion: 2, cooldown: null, operationCooldowns: [], requests: null },
			}),
		);
		await openDiagnostics(page);
		await expect(page.getByRole("alert")).toContainText("Messdaten nicht erreichbar");
		await expect(
			page.getByRole("button", { name: "Funktionen gezielt testen", exact: true }),
		).toBeEnabled();
		fail = false;
		await page.getByRole("button", { name: "Status aktualisieren", exact: true }).click();
		await expect(page.getByRole("region", { name: "Gemeinsame Spotify-Nutzung" })).toBeVisible();
	});
	test("requires authentication and request protection for the availability trial", async ({
		request,
	}) => {
		expect((await request.post("/api/spotify/availability-test")).status()).toBe(403);
		expect(
			(await request.post("/api/spotify/availability-test", { headers: { "x-ts": "1" } })).status(),
		).toBe(401);
		expect((await request.get("/api/spotify/usage")).status()).toBe(401);
	});
});
