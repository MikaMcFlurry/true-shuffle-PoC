/**
 * One listener's story, start to finish, against the real Worker and the
 * Spotify stand-in (synthetic demo library, see e2e/fake-server.ts).
 */

import { expect, type Page, test } from "@playwright/test";

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

test.describe.configure({ mode: "serial" });

test.describe("a listener's day", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("signs in with Spotify and saves playlists as stations", async ({ page }) => {
		await signIn(page);
		await expect(page.getByText("Wähle, welche Sender werden")).toBeVisible();
		await checkPage(page, "Sendersuchlauf");
		// A playlist of someone else cannot be read (Spotify keeps its songs).
		await expect(page.getByRole("checkbox", { name: /Today's Top Hits/ })).toBeDisabled();
		await page.getByRole("checkbox", { name: /Indie & Gitarren/ }).check();
		await page.getByRole("checkbox", { name: /Lange Autofahrt/ }).check();
		await page.getByRole("button", { name: "2 Sender speichern" }).click();

		// Home: the automatic "Alles" plus the two stations, ready once imported.
		for (const name of ["Alles", "Indie & Gitarren", "Lange Autofahrt"]) {
			await expect(page.getByRole("button", { name: `${name} starten` })).toBeEnabled({
				timeout: 60_000,
			});
		}
		await checkPage(page, "home");
	});

	test("starts a station in Spotify, in true-shuffle's order", async ({ page }) => {
		await signIn(page);
		await page.getByRole("button", { name: "Indie & Gitarren starten" }).click();
		const display = page.getByRole("region", { name: "Anzeige" });
		await expect(display).toContainText("Indie & Gitarren");
		await expect(display).toContainText("Noch nicht gehört in Runde 1");
		await expect(display).toContainText("Mikas iPhone");

		const s = await fake("status");
		expect(s.playing).toBe(true);
		expect(s.shuffle).toBe(false);
		expect(s.context).toMatch(/^spotify:playlist:/);
		// Playing now: a tap opens the station instead of starting it over.
		const tile = page.getByRole("button", { name: "Indie & Gitarren öffnen (läuft gerade)" });
		await expect(tile).toBeVisible();
		await tile.click();
		await expect(page.getByRole("heading", { name: "Indie & Gitarren", level: 1 })).toBeVisible();
		await expect(page.getByText("Läuft gerade").first()).toBeVisible();
		expect((await fake("status")).playing).toBe(true);
	});

	test("skips and bans a song from the transport keys", async ({ page }) => {
		await signIn(page);
		const song = page.getByRole("region", { name: "Anzeige" }).locator(".card__song");
		await expect(song).not.toBeEmpty();
		const first = await song.textContent();

		await page.getByRole("button", { name: "Nächster Song" }).click();
		await expect(song).not.toHaveText(first ?? "", { timeout: 20_000 });

		const before = (await fake("status")).current;
		await page.getByRole("button", { name: "Daumen runter: diesen Song nie wieder" }).click();
		await expect(page.getByText("Kommt nie wieder")).toBeVisible();
		await expect.poll(async () => (await fake("status")).current).not.toBe(before);
	});

	test("shows the station with its round, mix and next songs", async ({ page }) => {
		await signIn(page);
		await page.getByRole("link", { name: "Indie & Gitarren einstellen" }).click();
		await expect(page.getByRole("heading", { name: "Indie & Gitarren", level: 1 })).toBeVisible();
		const panel = page.getByRole("complementary");
		await expect(panel.getByText(/von 400 gehört/)).toBeVisible();
		const next = page.getByRole("region", { name: "Als Nächstes" }).getByRole("listitem");
		await expect(next.first()).toBeVisible();
		await checkPage(page, "station");

		await page.getByRole("button", { name: "Vertraut" }).click();
		await expect(page.getByText(/≈ 50 % ungehört/)).toBeVisible();
		await page.getByRole("button", { name: "Entdecker" }).click();
		await expect(page.getByText(/≈ 60 % ungehört/)).toBeVisible();

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
		await page.getByRole("link", { name: "Menü" }).click();
		await checkPage(page, "menu");
		await page.getByRole("switch", { name: /Gast-Modus/ }).check();
		await expect(page.getByText(/Gast-Modus an/)).toBeVisible();
		await page.getByRole("button", { name: "Zurück" }).click();
		await expect(page.locator(".seg.on", { hasText: "GAST" })).toBeVisible();

		await page.getByRole("link", { name: "Menü" }).click();
		await page.getByRole("switch", { name: /Gast-Modus/ }).uncheck();
		await expect(page.getByText(/Gast-Modus aus/)).toBeVisible();
	});

	test("a personal key likes the playing song from Siri or a widget", async ({ page }) => {
		await signIn(page);
		await page.getByRole("link", { name: "Menü" }).click();
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
		await expect(page.getByRole("button", { name: /^Alles starten/ })).toBeVisible();
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
			await checkPage(page, path);
		}
		// The smallest phones reflow too (WCAG 1.4.10): home and a station page at 320 px.
		await page.setViewportSize({ width: 320, height: 700 });
		await page.goto("/");
		const station = await page
			.getByRole("link", { name: "Indie & Gitarren einstellen" })
			.getAttribute("href");
		await checkPage(page, "/ at 320 px");
		await page.goto(station ?? "/");
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		await checkPage(page, `${station} at 320 px`);
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
		await page.getByRole("button", { name: "Weiterspielen" }).click();
		await expect.poll(async () => (await fake("status")).playing).toBe(true);
		expect((await fake("status")).current).toBe(playing.current);
	});

	test("says clearly when Spotify refuses: no Premium, no device", async ({ page }) => {
		await signIn(page);
		await fake("pause");

		await fake("premium?on=0");
		await page.getByRole("button", { name: /^Lange Autofahrt starten/ }).click();
		await expect(page.getByText(/nur mit Premium/)).toBeVisible();
		await fake("premium?on=1");

		await fake("devices?none=1");
		await expect(page.getByRole("button", { name: /^Lange Autofahrt starten/ })).toBeEnabled();
		await page.getByRole("button", { name: /^Lange Autofahrt starten/ }).click();
		await expect(page.getByText(/Öffne Spotify|Kein Spotify-Gerät/)).toBeVisible();
		await fake("devices?none=0");
	});

	test("signs out and keeps the memory", async ({ page }) => {
		await signIn(page);
		const before = await page.context().cookies();
		await page.getByRole("link", { name: "Menü" }).click();
		await page.getByRole("button", { name: /Abmelden/ }).click();
		await expect(page.getByRole("link", { name: "Mit Spotify anmelden" })).toBeVisible();

		// A copy of the old session cookie no longer opens anything.
		await page.context().addCookies(before);
		const res = await page.request.get("/api/state");
		expect(res.status()).toBe(401);
		await page.context().clearCookies();
		await page.goto("/");

		await page.getByRole("link", { name: "Mit Spotify anmelden" }).click();
		await expect(
			page.getByRole("button", { name: /^Indie & Gitarren (starten|öffnen|weiterspielen)/ }),
		).toBeVisible();
	});
});

test.describe("desktop", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("keeps the radio and puts the station beside it", async ({ page }) => {
		await signIn(page);
		await expect(page.getByRole("button", { name: /^Alles starten/ })).toBeVisible();
		// The station that played last opens beside the radio.
		await expect(page.locator(".side").getByRole("heading", { level: 1 })).toBeVisible();
		await checkPage(page, "desktop home");
		await page.getByRole("link", { name: "Menü" }).click();
		await expect(page.locator(".side").getByRole("heading", { name: "Menü" })).toBeVisible();
		await expect(page.getByRole("region", { name: "Anzeige" })).toBeVisible();
		await checkPage(page, "desktop menu");
	});
});
