/**
 * U1: every screen on every device of playwright.visual.config.ts. For each
 * one: a screenshot (synthetic data only), no sideways scrolling, touch
 * targets of at least 44 × 44 px, nothing hidden under the fixed bars.
 * Findings go to e2e/.artifacts/visual/<project>.json; the run fails only on
 * overflow (the hard U1 criterion at 320 px). Touch-target and cover
 * findings are listed for docs/qa/1.3.0-ui-bugs.md.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

function acknowledgeRelease(context: BrowserContext): void {
	const handle = (p: Page) =>
		void p.addLocatorHandler(p.getByRole("dialog", { name: /^Neu in Version / }), (d) =>
			d.getByRole("button", { name: "Verstanden" }).click(),
		);
	for (const p of context.pages()) handle(p);
	context.on("page", handle);
}

const OUT = "e2e/.artifacts/visual";

interface Finding {
	screen: string;
	kind: "overflow" | "touch" | "covered";
	detail: string;
}

async function audit(page: Page, screen: string, findings: Finding[], shot: string) {
	await page.waitForTimeout(400);
	const r = await page.evaluate(() => {
		const overflow = document.documentElement.scrollWidth - window.innerWidth;
		const small: string[] = [];
		for (const el of document.querySelectorAll<HTMLElement>(
			"button, a[href], input, select, summary, [role=switch], [role=button]",
		)) {
			const cs = getComputedStyle(el);
			if (cs.visibility === "hidden" || cs.display === "none") continue;
			const b = el.getBoundingClientRect();
			if (b.width === 0 || b.height === 0) continue;
			// Links inside running text are exempt (WCAG 2.5.8 inline exception).
			if (el.tagName === "A" && cs.display === "inline" && el.closest("p, li")) continue;
			if (el.classList.contains("skip-link")) continue;
			// Visually hidden inputs whose label is the target (file picker).
			if (b.width <= 1 && b.height <= 1) continue;
			if ((el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio") {
				const label = el.closest("label");
				const lb = label?.getBoundingClientRect();
				if (lb && lb.height >= 44) continue;
			}
			if (b.width < 44 || b.height < 44) {
				const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
				small.push(`${el.tagName.toLowerCase()}.${el.className || "-"} „${name}“ ${Math.round(b.width)}×${Math.round(b.height)}`);
			}
		}
		// The fixed tab bar must not cover the end of the page.
		const bar = document.querySelector<HTMLElement>(".tabbar");
		const main = document.querySelector<HTMLElement>("main");
		let covered = "";
		if (bar && main) {
			window.scrollTo(0, document.documentElement.scrollHeight);
			const last = [...main.querySelectorAll<HTMLElement>("*")]
				.filter((e) => e.getBoundingClientRect().height > 0 && e.children.length === 0)
				.at(-1);
			const lb = last?.getBoundingClientRect();
			const bb = bar.getBoundingClientRect();
			if (lb && getComputedStyle(bar).position === "fixed" && lb.bottom > bb.top + 1)
				covered = `${last!.tagName.toLowerCase()}.${last!.className} endet bei ${Math.round(lb.bottom)}, Leiste ab ${Math.round(bb.top)}`;
			window.scrollTo(0, 0);
		}
		return { overflow, small: [...new Set(small)], covered };
	});
	if (r.overflow > 0) findings.push({ screen, kind: "overflow", detail: `${r.overflow}px breiter als der Bildschirm` });
	for (const s of r.small) findings.push({ screen, kind: "touch", detail: s });
	if (r.covered) findings.push({ screen, kind: "covered", detail: r.covered });
	await page.screenshot({ path: shot, fullPage: true, type: "jpeg", quality: 60 });
	return r;
}

test("U1 every screen", async ({ page, context }, info) => {
	acknowledgeRelease(context);
	const project = info.project.name.replace(":", "_");
	const dir = join(OUT, project);
	mkdirSync(dir, { recursive: true });
	const findings: Finding[] = [];
	const shot = (s: string) => join(dir, `${s}.jpg`);

	// Signed out.
	await context.clearCookies();
	await page.goto("/");
	await expect(page.getByRole("link", { name: "Mit Spotify anmelden" })).toBeVisible();
	await audit(page, "start", findings, shot("01-start"));

	// Signed in (the stand-in signs in at once; first run onboards one Kassette).
	await page.getByRole("link", { name: "Mit Spotify anmelden" }).click();
	const onboarding = page.getByText("Wähle, welche Playlists Kassetten werden");
	const home = page.getByRole("button", { name: /^Alles/ });
	await expect(onboarding.or(home)).toBeVisible({ timeout: 60_000 });
	if (await onboarding.isVisible()) {
		await audit(page, "onboarding", findings, shot("02-onboarding"));
		await page.getByRole("checkbox", { name: /Indie & Gitarren/ }).check();
		await page.getByRole("button", { name: /Kassetten? anlegen/ }).click();
	}
	await expect(home).toBeEnabled({ timeout: 90_000 });
	await audit(page, "player", findings, shot("03-player"));

	// Playing, so the queue (and its rating buttons) is there.
	const start = page
		.getByRole("button", { name: /^(Wiedergabe starten|Fortsetzen|TrueShuffle fortsetzen)/ })
		.first();
	if ((await start.count()) > 0 && (await start.isEnabled({ timeout: 2_000 }).catch(() => false)))
		await start.click();
	await page.locator(".queue-row").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
	await audit(page, "player-spielt", findings, shot("03b-player-spielt"));
	// The rating sheet from the queue.
	const rate = page.getByRole("button", { name: /bewerten$/ }).first();
	if (await rate.isVisible().catch(() => false)) {
		await rate.click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await audit(page, "rating-sheet", findings, shot("04-bewertung"));
		await page.keyboard.press("Escape");
	}

	await page.goto("/verlauf");
	await expect(page.getByRole("searchbox", { name: "Im Verlauf suchen" })).toBeVisible();
	await audit(page, "verlauf", findings, shot("05-verlauf"));
	await page.getByRole("searchbox", { name: "Im Verlauf suchen" }).fill("a");
	await page.waitForTimeout(700);
	await audit(page, "verlauf-suche", findings, shot("06-verlauf-suche"));

	await page.goto("/import");
	await audit(page, "import", findings, shot("07-import"));

	await page.goto("/info");
	await expect(page.getByText(/Diese Seite läuft mit Version/)).toBeVisible();
	await audit(page, "ueber", findings, shot("08-ueber"));

	await page.goto("/mehr");
	const guest = page.getByRole("switch", { name: /Gast-Modus/ });
	await expect(guest).toBeVisible();
	await audit(page, "menu", findings, shot("09-menu"));
	// A run that stopped midway may have left it on: start from off.
	if (await guest.isChecked()) {
		await guest.click();
		await expect(guest).not.toBeChecked();
	}
	await guest.click();
	await expect(guest).toBeChecked();
	await page.goto("/");
	await audit(page, "gastmodus", findings, shot("10-gastmodus"));
	await page.goto("/mehr");
	const off = page.getByRole("switch", { name: /Gast-Modus/ });
	await off.click();
	await expect(off).not.toBeChecked();

	// Offline.
	await page.goto("/");
	await expect(home).toBeVisible();
	await context.setOffline(true);
	await page.evaluate(() => window.dispatchEvent(new Event("offline")));
	await expect(page.locator(".notice--offline")).toBeVisible();
	await audit(page, "offline", findings, shot("11-offline"));
	await context.setOffline(false);

	writeFileSync(join(OUT, `${project}.json`), JSON.stringify({ project: info.project.name, findings }, null, 2));
	const overflow = findings.filter((f) => f.kind === "overflow");
	expect(overflow, "horizontal overflow").toEqual([]);
});
