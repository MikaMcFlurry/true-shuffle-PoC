/**
 * Date ranges and help on narrow phones (owner, 2026-10-14: the date fields
 * overlapped on an iPhone): the period form of "Hörverlauf auswählen" and the
 * own period of the Hörprofil, both filled, at 320, 375 and 390 CSS px, with
 * normal and larger text. Every field, label and key stays inside its form and
 * the page, no field overlaps another, nothing scrolls sideways; and the rule
 * explanations stay on request without changing anything. The real Worker
 * against the Spotify stand-in; a synthetic two-song import, removed again.
 * Chromium measures here; Safari's own date-field width is not reproduced.
 */

import { expect, type Page, test } from "@playwright/test";

const post = (page: Page, url: string, data: unknown = {}) =>
	page.request.post(url, { headers: { "x-ts": "1" }, data });

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

type Selection = {
	revision: number;
	selection: { enabled: boolean; rules: unknown[] };
	dataset: { hasImport: boolean; key: string };
};
const selection = async (page: Page) =>
	(await (await page.request.get("/api/history/selection")).json()) as Selection;

/** A synthetic two-song import with a period and a long-named artist rule. */
async function importWithRules(page: Page) {
	const ids = ["T000000000000000000000", "T000000000000000000001"];
	const old = await selection(page);
	if (old.dataset.hasImport) await post(page, "/api/history/delete", { dataset: old.dataset.key });
	const at = Date.parse("2024-03-01T12:00:00Z");
	const start = ((await (await post(page, "/api/history/begin")).json()) as { start: number })
		.start;
	const totals = (await (
		await post(page, "/api/history/import", {
			start,
			rows: ids.map((id) => [id, 2, 0, at, 0, 2]),
			part: 0,
			parts: 1,
		})
	).json()) as { upload: string };
	const first = (await (
		await post(page, "/api/history/listens", {
			importId: totals.upload,
			part: 0,
			parts: 2,
			tracks: 2,
			kind: "tracks",
			data: ids.map((id, i) => [
				id,
				i ? "Beta" : "Alpha",
				`Artist ${i ? "Beta" : "Alpha"}`,
				"Synthetic",
			]),
		})
	).json()) as { upload: string };
	await post(page, "/api/history/listens", {
		upload: first.upload,
		part: 1,
		parts: 2,
		tracks: 2,
		kind: "rows",
		data: [at / 1000, at / 1000 + 1].flatMap((t) => ids.map((_, i) => [t, i, 200_000, 132, 0])),
	});
	const now = await selection(page);
	const applied = await post(page, "/api/history/selection", {
		baseRevision: now.revision,
		enabled: true,
		rules: [
			{
				type: "period",
				kind: "exclude",
				from: "2024-02-01",
				to: "2024-02-29",
				zone: "Europe/Berlin",
			},
			{
				type: "artist",
				kind: "exclude",
				name: "Das Orchester der ausgesprochen langen Künstlernamen und Freunde",
			},
		],
		dataset: now.dataset.key,
	});
	expect(applied.ok()).toBe(true);
}

/** The boxes of a form's date fields, labels and keys, against the form, the window and the page. */
async function measure(page: Page, form: string) {
	return page.evaluate((sel) => {
		const c = document.querySelector(sel)!;
		const r = (el: Element) => el.getBoundingClientRect();
		const box = r(c);
		const parts = [...c.querySelectorAll("input[type=date], label, button, legend")].map((el) => ({
			what: `${el.tagName.toLowerCase()} ${(el.textContent ?? "").trim().slice(0, 20)}`,
			left: r(el).left,
			right: r(el).right,
			top: r(el).top,
			bottom: r(el).bottom,
		}));
		const inputs = [...c.querySelectorAll("input[type=date]")].map(r);
		const overlap =
			inputs.length === 2 &&
			Math.min(inputs[0]!.right, inputs[1]!.right) - Math.max(inputs[0]!.left, inputs[1]!.left) >
				0.5 &&
			Math.min(inputs[0]!.bottom, inputs[1]!.bottom) - Math.max(inputs[0]!.top, inputs[1]!.top) >
				0.5;
		return {
			overlap,
			outside: parts
				.filter(
					(p) =>
						p.right > box.right + 0.5 ||
						p.left < box.left - 0.5 ||
						p.right > window.innerWidth + 0.5,
				)
				.map((p) => `${p.what} [${p.left.toFixed(1)}, ${p.right.toFixed(1)}]`),
			sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			heights: inputs.map((i) => Math.round(i.height)),
			values: [...c.querySelectorAll<HTMLInputElement>("input[type=date]")].map((i) => i.value),
		};
	}, form);
}

test.describe.configure({ mode: "serial" });

test.describe("date ranges and rule help on phones", () => {
	test("filled date ranges fit at 320, 375 and 390 px, with normal and larger text: no overlap, nothing outside, no sideways scroll", async ({
		page,
	}) => {
		await signIn(page);
		await importWithRules(page);
		for (const width of [320, 375, 390]) {
			for (const text of ["100%", "125%"]) {
				await page.setViewportSize({ width, height: 800 });
				const where = `${width} px, text ${text}`;
				// Hörverlauf auswählen: exclude a period.
				await page.goto("/auswahl");
				const dates = page.locator(".selection__period input[type=date]");
				await expect(dates.first()).toBeVisible();
				await page.addStyleTag({ content: `html { font-size: ${text}; }` });
				await dates.nth(0).fill("2024-12-31");
				await dates.nth(1).fill("2025-12-31");
				const sel = await measure(page, ".selection__period");
				expect(sel.values, where).toEqual(["2024-12-31", "2025-12-31"]);
				expect(sel.overlap, `${where}: Auswahl date fields overlap`).toBe(false);
				expect(sel.outside, `${where}: outside the Auswahl form`).toEqual([]);
				expect(sel.sideways, `${where}: Auswahl scrolls sideways`).toBeLessThanOrEqual(0);
				for (const h of sel.heights) expect(h, where).toBeGreaterThanOrEqual(44);
				await expect(page.getByRole("button", { name: "Zeitraum hinzufügen" })).toBeEnabled();
				// Hörprofil: an own period.
				await page.goto("/profil");
				await page.getByRole("radio", { name: "Eigener" }).check();
				const own = page.locator(".periods__custom input[type=date]");
				await expect(own.first()).toBeVisible();
				await page.addStyleTag({ content: `html { font-size: ${text}; }` });
				await own.nth(0).fill("2024-12-31");
				await own.nth(1).fill("2025-12-31");
				const prof = await measure(page, ".periods__custom");
				expect(prof.overlap, `${where}: Hörprofil date fields overlap`).toBe(false);
				expect(prof.outside, `${where}: outside the Hörprofil form`).toEqual([]);
				expect(prof.sideways, `${where}: Hörprofil scrolls sideways`).toBeLessThanOrEqual(0);
				for (const h of prof.heights) expect(h, where).toBeGreaterThanOrEqual(44);
			}
		}
	});

	test("the rule explanations open on request, by keyboard too; the rules and their state stay, nothing is saved", async ({
		page,
	}) => {
		await signIn(page);
		const before = await selection(page);
		const writes: string[] = [];
		page.on("request", (r) => {
			if (r.method() === "POST" && new URL(r.url()).pathname === "/api/history/selection")
				writes.push(r.url());
		});
		await page.goto("/auswahl");
		// The rules themselves, short and right there.
		await expect(
			page.getByText(/^Zeitraum 1\. Februar 2024 bis 29\. Februar 2024 ausgeschlossen$/),
		).toBeVisible();
		await expect(
			page.getByText(
				"Künstler „Das Orchester der ausgesprochen langen Künstlernamen und Freunde“ ausgeschlossen",
			),
		).toBeVisible();
		await expect(
			page.getByText("Ausschließen nimmt nur importierte Wiedergaben aus der Rechnung."),
		).toBeVisible();
		// The long explanation is closed until asked for.
		const help = page.locator("details.help", { has: page.getByText("So greifen die Regeln") });
		const precedence = help.getByText(
			/Die genaueste Regel entscheidet: ein Song vor einem Künstler/,
		);
		await expect(help).not.toHaveAttribute("open", "");
		await expect(precedence).toBeHidden();
		await help.getByText("So greifen die Regeln").focus();
		await page.keyboard.press("Enter");
		await expect(precedence).toBeVisible();
		await expect(help.getByText(/ganze Kalendertage in deiner Zeitzone/i)).toBeVisible();
		await page.keyboard.press("Enter");
		await expect(precedence).toBeHidden();
		// Opening and closing changed nothing: no draft, nothing taken over.
		await expect(page.getByRole("button", { name: "Auswahl übernehmen" })).toBeDisabled();
		await expect(page.getByText("Keine Änderungen.")).toBeVisible();
		expect(writes).toEqual([]);
		const after = await selection(page);
		expect(after.revision).toBe(before.revision);
		expect(after.selection).toEqual(before.selection);
		// Clean up for the specs after this one: the synthetic import goes again.
		if (after.dataset.hasImport)
			await post(page, "/api/history/delete", { dataset: after.dataset.key });
	});
});
