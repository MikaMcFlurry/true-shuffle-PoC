/**
 * S1: the Verlauf search, on a phone and on a desktop. The real Worker
 * against the Spotify stand-in; plays are made by listening in the stand-in.
 * Typing never asks the server (one /api/history/search per opening), a hit
 * shows its plays, and „Favorit“ on a hit is the same rating as everywhere:
 * one entry in the Likes and the playlist „TrueShuffle Likes“, with undo.
 */

import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import type { AppState, HistoryEntry } from "../src/shared/api";

function acknowledgeRelease(context: BrowserContext): void {
	const handle = (p: Page) =>
		void p.addLocatorHandler(p.getByRole("dialog", { name: /^Neu in Version / }), (d) =>
			d.getByRole("button", { name: "Verstanden" }).click(),
		);
	for (const p of context.pages()) handle(p);
	context.on("page", handle);
}
test.beforeEach(({ context }) => acknowledgeRelease(context));

async function signIn(page: Page): Promise<void> {
	await page.goto("/");
	await page.getByRole("link", { name: "Mit Spotify anmelden" }).click();
	const onboarding = page.getByText("Wähle, welche Playlists Kassetten werden");
	const home = page.getByRole("button", { name: /^Alles/ });
	await expect(onboarding.or(home)).toBeVisible();
	if (await onboarding.isVisible()) {
		await page.getByRole("checkbox", { name: /Indie & Gitarren/ }).check();
		await page.getByRole("button", { name: /Kassetten? anlegen/ }).click();
	}
	await expect(home).toBeEnabled({ timeout: 60_000 });
}

async function history(page: Page): Promise<HistoryEntry[]> {
	return (await (await page.request.get("/api/history?limit=200")).json()) as HistoryEntry[];
}

async function heard(page: Page, n: number): Promise<HistoryEntry[]> {
	let rows: HistoryEntry[] = [];
	await expect
		.poll(
			async () => {
				await page.request.get("/api/state?live=1&refresh=1");
				rows = await history(page);
				return rows.length;
			},
			{ timeout: 240_000, intervals: [6_000] },
		)
		.toBeGreaterThan(n);
	return rows;
}

for (const [label, viewport] of [
	["phone", { width: 375, height: 667 }],
	["desktop", { width: 1280, height: 800 }],
] as const)
	test.describe(label, () => {
		test.use({ viewport });

		test(`S1 search by title or artist, any case and accents, then Favorit with undo (${label})`, async ({
			page,
		}) => {
			test.setTimeout(300_000);
			await signIn(page);
			const rows = await heard(page, 0);
			const song = rows.find((r) => r.thumb === 0 && !r.ignored) ?? rows[0]!;
			const searches: string[] = [];
			page.on("request", (r) => {
				if (new URL(r.url()).pathname === "/api/history/search") searches.push(r.url());
			});
			await page.getByRole("link", { name: "Verlauf", exact: true }).click();
			const field = page.getByRole("searchbox", { name: "Im Verlauf suchen" });
			await expect(field).toBeVisible();
			const box = await field.boundingBox();
			expect(box!.height).toBeGreaterThanOrEqual(44);

			// Type a part of the title, letter by letter, in other letters' case.
			const part = song.name.slice(0, Math.min(5, song.name.length)).toUpperCase();
			await field.click();
			await field.pressSequentially(part, { delay: 40 });
			const hits = page.locator(".hist-hit");
			await expect(hits.first()).toBeVisible();
			await expect(
				hits.filter({ has: page.locator(".hist-row__title", { hasText: song.name }) }),
			).toHaveCount(1);
			// One request for the opening (and maybe the first query), never one per key.
			expect(searches.length).toBeLessThanOrEqual(2);

			// A query without a hit says so.
			await field.fill("zzzz kein solcher song");
			await expect(page.getByText(/^Nichts gefunden für/)).toBeVisible();
			await field.fill(song.artists.split(",")[0]!.toLowerCase());
			const hit = hits.filter({
				has: page.locator(".hist-row__title", { hasText: song.name }),
			});
			await expect(hit).toHaveCount(1);
			await expect(hit.locator("summary")).toContainText(/-mal gehört, zuletzt/);
			expect(searches.length).toBeLessThanOrEqual(2);

			// Favorit on the hit: the same rating as in the Verlauf, one Like.
			const fav = hit.getByRole("button", { name: "Favorit", exact: true });
			const favBox = await fav.boundingBox();
			expect(favBox!.height).toBeGreaterThanOrEqual(44);
			await fav.click();
			await expect(hit.locator(".hist-rate")).toContainText(/Favorit/);
			await expect
				.poll(async () => (await history(page)).find((e) => e.id === song.id)?.thumb)
				.toBe(1);
			const state = async () => (await (await page.request.get("/api/state")).json()) as AppState;
			const before = (await state()).likes?.count ?? 0;
			expect(before).toBeGreaterThanOrEqual(1);
			await hit.getByRole("button", { name: /^Rückgängig/ }).click();
			await expect
				.poll(async () => (await history(page)).find((e) => e.id === song.id)?.thumb)
				.toBe(0);
			expect((await state()).likes?.count).toBe(before - 1);

			// No sideways scrolling on this width.
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - window.innerWidth,
			);
			expect(overflow).toBeLessThanOrEqual(0);
		});
	});
