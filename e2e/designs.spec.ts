/**
 * Every design keeps the same working player: switch it in the menu, then
 * check that the saved song, its position, the transport keys and the queue
 * are all there, that nothing scrolls sideways, and capture each design in
 * both themes on desktop and phone for the design review.
 */

import { expect, type Page, test } from "@playwright/test";

const DESIGNS = [
	["kontakt", "Kontaktbogen"],
	["linie", "Linienplan"],
	["strich", "Strichliste"],
	["klassik", "Klassisch"],
] as const;

const OUT = ".impeccable/review/designs";

async function settle(page: Page): Promise<void> {
	await page.evaluate(async () => {
		await document.fonts.ready;
		await new Promise(requestAnimationFrame);
		await Promise.all(
			document.getAnimations().map((animation) => animation.finished.catch(() => {})),
		);
	});
}

async function noSidewaysScroll(page: Page, where: string): Promise<void> {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow, `${where}: horizontal overflow`).toBeLessThanOrEqual(0);
}

test("each design draws the signed-out welcome", async ({ browser }) => {
	for (const [id] of DESIGNS) {
		const context = await browser.newContext({
			viewport: { width: 390, height: 844 },
			reducedMotion: "reduce",
		});
		const page = await context.newPage();
		await page.goto(`/?design=${id}`);
		await expect(page.getByRole("link", { name: "Mit Spotify anmelden" })).toBeVisible();
		await expect(page.locator("html")).toHaveAttribute("data-design", id);
		await noSidewaysScroll(page, `${id} welcome`);
		await settle(page);
		await page.screenshot({ path: `${OUT}/${id}-welcome.png`, fullPage: true });
		await page.setViewportSize({ width: 1440, height: 900 });
		await settle(page);
		await page.screenshot({ path: `${OUT}/${id}-welcome-desktop.png` });
		await context.close();
	}
});

test("each design switches in the menu and keeps the saved player working", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("link", { name: "Mit Spotify anmelden" }).click();
	const initial = await (await page.request.get("/api/state")).json();
	if (!initial.onboarded) {
		await page.getByRole("checkbox", { name: /Indie & Gitarren/ }).check();
		await page.getByRole("checkbox", { name: /Lange Autofahrt/ }).check();
		await page.getByRole("button", { name: "2 Sender speichern" }).click();
	}
	await page.getByRole("button", { name: /^Indie & Gitarren/ }).click();
	await expect(page.locator(".transport-main")).toBeEnabled({ timeout: 60000 });
	if ((await page.locator(".transport-main").textContent()) !== "Pause")
		await page.locator(".transport-main").click();
	await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
	await fetch("http://127.0.0.1:8788/__control/position?ms=97000&paused=1");
	await expect
		.poll(async () => {
			await page.request.post("/api/sync", { headers: { "x-ts": "1" } });
			const snapshot = await (await page.request.get("/api/state")).json();
			return snapshot.session?.progressMs;
		})
		.toBe(97000);
	await page.emulateMedia({ reducedMotion: "reduce" });

	for (const [id, name] of DESIGNS) {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.emulateMedia({ colorScheme: "light" });
		await page.goto("/menu");
		const choice = page.getByRole("radio", { name: new RegExp(`^${name}`) });
		await choice.check();
		await expect(choice).toBeChecked();
		await expect(page.locator("html")).toHaveAttribute("data-design", id);
		await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", `/brand/${id}/icon.svg`);
		await settle(page);
		await page.screenshot({ path: `${OUT}/${id}-menu.png`, fullPage: true });

		await page.goto("/");
		await expect(page.locator("html")).toHaveAttribute("data-design", id);
		await expect(page.getByText("1:37 gespeichert")).toBeVisible();
		await expect(page.getByRole("button", { name: "Fortsetzen", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Weiter: Nächster Song" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Daumen hoch: Favorit" })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Daumen runter: diesen Song nie wieder" }),
		).toBeVisible();
		await expect(page.getByRole("progressbar")).toBeVisible();
		await expect(page.getByLabel("Wiedergabegerät", { exact: true })).toBeVisible();
		await expect(page.getByRole("region", { name: "Als Nächstes" })).toBeVisible();
		await expect(page.locator(".queue-list > li")).toHaveCount(12);
		await expect(page.locator(".session-status")).not.toBeEmpty();
		await noSidewaysScroll(page, `${id} desktop`);
		await settle(page);
		await page.screenshot({ path: `${OUT}/${id}-desktop.png`, fullPage: true });
		await page.emulateMedia({ colorScheme: "dark" });
		await settle(page);
		await page.screenshot({ path: `${OUT}/${id}-desktop-dark.png`, fullPage: true });

		await page.setViewportSize({ width: 390, height: 844 });
		await settle(page);
		await noSidewaysScroll(page, `${id} phone`);
		await page.screenshot({ path: `${OUT}/${id}-mobile-dark.png`, fullPage: true });
		await page.emulateMedia({ colorScheme: "light" });
		await settle(page);
		await page.screenshot({ path: `${OUT}/${id}-mobile.png`, fullPage: true });

		await page.getByRole("link", { name: "Indie & Gitarren: Mix und Regeln" }).click();
		await expect(page.getByRole("heading", { name: "Indie & Gitarren", level: 1 })).toBeVisible();
		await noSidewaysScroll(page, `${id} station page`);
		await settle(page);
		await page.screenshot({ path: `${OUT}/${id}-station-mobile.png`, fullPage: true });
	}

	// The choice survives a reload and can be opened by link.
	await page.goto("/?design=linie");
	await expect(page.locator("html")).toHaveAttribute("data-design", "linie");
	await expect(page).toHaveURL(/\/$/);
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("data-design", "linie");
	await page.goto("/?design=kontakt");
	await expect(page.locator("html")).toHaveAttribute("data-design", "kontakt");
});
