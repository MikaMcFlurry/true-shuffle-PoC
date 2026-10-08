import { expect, test } from "@playwright/test";

test("captures the real Worker player and saved occurrence in both themes", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("link", { name: "Mit Spotify anmelden" }).click();
	const initial = await (await page.request.get("/api/state")).json();
	if (!initial.onboarded) {
		await page.getByRole("checkbox", { name: /Indie & Gitarren/ }).check();
		await page.getByRole("checkbox", { name: /Lange Autofahrt/ }).check();
		await page.getByRole("button", { name: "2 Kassetten anlegen" }).click();
	}
	await page.getByRole("button", { name: /^Indie & Gitarren/ }).click();
	await expect(page.locator(".transport-main")).toBeEnabled({ timeout: 60000 });
	if ((await page.locator(".transport-main").textContent()) !== "Pause")
		await page.locator(".transport-main").click();
	await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
	await expect
		.poll(async () => {
			const response = await fetch("http://127.0.0.1:8788/__control/status");
			return (await response.json()).playing;
		})
		.toBe(true);
	await fetch("http://127.0.0.1:8788/__control/position?ms=97000&paused=1");
	await page.request.post("/api/sync", { headers: { "x-ts": "1" } });
	await expect
		.poll(async () => {
			await page.request.post("/api/sync", { headers: { "x-ts": "1" } });
			const snapshot = await (await page.request.get("/api/state")).json();
			return snapshot.session?.progressMs;
		})
		.toBe(97000);
	await page.reload();
	await expect(page.getByText("1:37 gespeichert")).toBeVisible();
	await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.evaluate(async () => {
		await new Promise(requestAnimationFrame);
		await Promise.all(
			document.getAnimations().map((animation) => animation.finished.catch(() => {})),
		);
	});
	await page.screenshot({ path: ".impeccable/review/desktop.png", fullPage: true });
	await page.emulateMedia({ colorScheme: "dark" });
	await page.evaluate(async () => {
		await new Promise(requestAnimationFrame);
		await Promise.all(
			document.getAnimations().map((animation) => animation.finished.catch(() => {})),
		);
	});
	await page.screenshot({ path: ".impeccable/review/desktop-dark.png", fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.evaluate(async () => {
		await new Promise(requestAnimationFrame);
		await Promise.all(
			document.getAnimations().map((animation) => animation.finished.catch(() => {})),
		);
	});
	await page.screenshot({ path: ".impeccable/review/mobile.png", fullPage: true });
	await page.emulateMedia({ colorScheme: "light" });
	await page.evaluate(async () => {
		await new Promise(requestAnimationFrame);
		await Promise.all(
			document.getAnimations().map((animation) => animation.finished.catch(() => {})),
		);
	});
	await page.screenshot({ path: ".impeccable/review/mobile-light.png", fullPage: true });
	await page.context().setOffline(true);
	await page.getByRole("button", { name: "Geräte aktualisieren" }).click();
	await expect(page.getByText(/Geräte nicht geladen/)).toBeVisible();
	await page.evaluate(async () => {
		await new Promise(requestAnimationFrame);
		await Promise.all(
			document.getAnimations().map((animation) => animation.finished.catch(() => {})),
		);
	});
	await page.screenshot({ path: ".impeccable/review/mobile-offline.png", fullPage: true });
	await page.context().setOffline(false);
});
