/**
 * One listener's story, start to finish, against the real Worker and the
 * Spotify stand-in (synthetic demo library, see e2e/fake-server.ts).
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

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
		// Every station is set up from the back panel (Menü).
		await page.getByRole("link", { name: "Menü" }).click();
		await page.getByRole("link", { name: "Indie & Gitarren einstellen" }).click();
		await expect(page.getByRole("heading", { name: "Indie & Gitarren", level: 1 })).toBeVisible();
		const panel = page.getByRole("complementary");
		await expect(panel.getByText(/von 400 gehört/)).toBeVisible();
		const next = page.getByRole("region", { name: "Als Nächstes" }).getByRole("listitem");
		await expect(next.first()).toBeVisible();
		await checkPage(page, "station");

		// On the sheet the mix is printed as the knob's three positions to choose from.
		await page.getByRole("radio", { name: "Vertraut" }).check();
		await expect(page.getByText(/≈ 50 % ungehört/)).toBeVisible();
		await page.getByRole("radio", { name: "Entdecker" }).check();
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
		await expect(
			page.getByRole("button", { name: /^Alles (starten|öffnen|weiterspielen)/ }),
		).toBeVisible();
		await checkPage(page, "/ at 320 px");
		await page.goto("/menu");
		const station = await page
			.getByRole("link", { name: "Indie & Gitarren einstellen" })
			.getAttribute("href");
		await checkPage(page, "/menu at 320 px");
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
			for (const path of ["/", "/menu", `/sender/${lange?.id}`]) {
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
		const rows = page.getByRole("region", { name: "Als Nächstes" }).getByRole("listitem");
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
					page.getByRole("region", { name: "Anzeige" }).getByText(device, { exact: true }),
				).toBeVisible({ timeout: 20_000 });
				await checkPage(page, `/ at ${w} px with a long device name`);
				await checkContained(page, `/ at ${w} px with a long device name`);
			}
		} finally {
			await fake("devices");
			await page.request.post("/api/sync", { headers: { "x-ts": "1" } });
		}
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

test.describe("on a touch screen", () => {
	test.use({ viewport: { width: 390, height: 700 }, hasTouch: true });

	test("a swipe across Klang never keeps it in hand", async ({ page }) => {
		// The dial's selection falls back after 20 s untouched: let the test say when.
		await page.clock.install();
		await signIn(page);
		const tune = page.getByRole("slider", { name: "Senderwahl" });
		const klang = page.getByRole("slider", { name: /^Klang für / });
		await expect(tune).toBeVisible();
		const stationOf = {
			tune: async () => (await tune.getAttribute("aria-valuetext"))?.replace(/^\d+ von \d+: /, ""),
			klang: async () =>
				(await klang.getAttribute("aria-label"))?.replace(
					/^Klang für (.*): Entdecken oder Vertraut$/,
					"$1",
				),
			dial: () =>
				page.evaluate(() => {
					const at = document.querySelector<HTMLElement>(".dial")?.dataset.pointer;
					return document.querySelector(`[data-at="${at}"] .station__name`)?.textContent?.trim();
				}),
		};
		const agree = async () => {
			const t = await stationOf.tune();
			expect(await stationOf.klang(), "Klang turns the station Senderwahl shows").toBe(t);
			expect(await stationOf.dial(), "the dial points where Senderwahl stands").toBe(t);
			return t;
		};
		const resting = await agree();
		const cdp = await page.context().newCDPSession(page);
		// A finger lands on the target and drags the page down: the browser takes
		// it as a scroll (pointerdown, pointercancel — no pointerup, no focus).
		const swipeFrom = async (target: Locator) => {
			await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
			const box = await target.boundingBox();
			expect(box).not.toBeNull();
			const x = Math.round(box!.x + box!.width / 2);
			const y = Math.round(box!.y + box!.height / 2);
			const before = await page.evaluate(() => window.scrollY);
			await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
			for (let i = 1; i <= 8; i++) {
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [{ x, y: y + i * 20 }],
				});
			}
			await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(before);
		};
		// Senderwahl turned to another station, then let go of.
		const turnAway = async () => {
			await tune.focus();
			await page.keyboard.press("End");
			if ((await stationOf.tune()) === resting) await page.keyboard.press("Home");
			await tune.blur();
			expect(await agree()).not.toBe(resting);
		};
		for (const [what, from] of [
			["a detent", page.getByRole("button", { name: "Vertraut", exact: true })],
			["the KLANG label", page.locator(".knob-unit--mix > .knob-unit__name")],
		] as const) {
			await turnAway();
			await swipeFrom(from);
			// Untouched for 20 s, the dial falls back to the station that plays (or played last).
			await page.clock.fastForward(21_000);
			await expect.poll(stationOf.tune, { message: `after a swipe from ${what}` }).toBe(resting);
			await agree();
		}
		// And Klang follows Senderwahl again at once.
		await turnAway();
	});
});
