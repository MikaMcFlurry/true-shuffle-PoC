/**
 * CTO acceptance (2026-10-15) against the real Worker and the Spotify stand-in:
 * the Verlauf rates only and never moves playback (CTO-04); taking back works
 * from any row of the song, once, and a rating changed elsewhere since (another
 * tab, Siri's route) is never overwritten (CTO-05); "Hörverlauf auswählen"
 * shows a rule's effect only when counted for exactly the draft shown, through
 * held and reordered preview answers, and switching the import off, reloading
 * and on again keeps its data and rules (CTO-06). The stand-in's control port
 * is FAKE_PORT (8788 by default, like the other specs).
 */

import {
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	type Route,
	test,
} from "@playwright/test";
import type { HistoryEntry } from "../src/shared/api";

/** The release notice (e2e/release-notes.spec.ts) is closed the normal way, by its own key, wherever it opens. */
function acknowledgeRelease(context: BrowserContext): void {
	const handle = (p: Page) =>
		void p.addLocatorHandler(p.getByRole("dialog", { name: /^Neu in Version / }), (d) =>
			d.getByRole("button", { name: "Verstanden" }).click(),
		);
	for (const p of context.pages()) handle(p);
	context.on("page", handle);
}
test.beforeEach(({ context }) => acknowledgeRelease(context));

const FAKE = `http://127.0.0.1:${process.env.FAKE_PORT ?? 8788}/__control`;

async function fake(action: string): Promise<{ current: string | null; playing: boolean }> {
	return (await (await fetch(`${FAKE}/${action}`)).json()) as {
		current: string | null;
		playing: boolean;
	};
}

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

const history = async (page: Page) =>
	(await (await page.request.get("/api/history?limit=200")).json()) as HistoryEntry[];

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

async function playing(page: Page, id: string, context?: string): Promise<void> {
	await fake(`play-song?id=${id}${context ? `&context=${encodeURIComponent(context)}` : ""}`);
	await expect
		.poll(
			async () => {
				const st = (await (await page.request.get("/api/state?live=1&refresh=1")).json()) as {
					nowPlaying: { id: string; isPlaying: boolean } | null;
				};
				return st.nowPlaying?.isPlaying ? st.nowPlaying.id : null;
			},
			{ timeout: 30_000, intervals: [1_000, 3_000, 6_000] },
		)
		.toBe(id);
}

const thumbOf = async (page: Page, id: string) =>
	(await history(page)).find((e) => e.id === id)?.thumb;
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rowsOf = (page: Page, name: string) =>
	page.locator(".hist-row").filter({
		has: page.locator(".hist-row__title", { hasText: new RegExp(`^${literal(name)}$`) }),
	});
const fav = (row: Locator) => row.getByRole("button", { name: "Favorit", exact: true });
const never = (row: Locator) => row.getByRole("button", { name: "Nie wieder", exact: true });
const undo = (row: Locator) => row.getByRole("button", { name: /^Rückgängig/ });
const line = (row: Locator) => row.locator(".hist-rate__state");

const songs = { twice: { id: "", name: "" }, plain: [] as { id: string; name: string }[] };
/** Every Verlauf song's rating right after the seed: put back by the last test of this story. */
const baseline = new Map<string, -1 | 0 | 1>();

test.describe.configure({ mode: "serial" });

test.describe("CTO acceptance, real Worker", () => {
	test("seed: plays heard in the stand-in fill the Verlauf; one song twice", async ({ page }) => {
		test.setTimeout(600_000);
		await signIn(page);
		type Stations = { stations: { id: number; name: string; ready: boolean }[] };
		let station: Stations["stations"][number] | undefined;
		await expect
			.poll(
				async () => {
					const st = (await (await page.request.get("/api/state")).json()) as Stations;
					station = st.stations.find((s) => s.name !== "Alles" && s.ready);
					return !!station;
				},
				{ timeout: 60_000 },
			)
			.toBe(true);
		expect((await post(page, `/api/stations/${station!.id}/play`)).ok()).toBe(true);
		let all = await history(page);
		await fake("advance?ms=3600000");
		all = await heard(page, all.length + 8);
		const counts = new Map<string, number>();
		for (const e of all) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
		const unique = all.filter((e) => counts.get(e.name) === 1 && e.stationName);
		const twice = unique[0]!;
		await playing(page, twice.id, "spotify:album:E2EOUTSIDEALBUM0000000");
		await fake("finish");
		all = await heard(page, all.length);
		expect(all.filter((e) => e.id === twice.id)).toHaveLength(2);
		songs.twice = { id: twice.id, name: twice.name };
		songs.plain = unique.slice(1, 6).map((e) => ({ id: e.id, name: e.name }));
		for (const e of all) baseline.set(e.id, (e.thumb ?? 0) as -1 | 0 | 1);
		await fake("pause");
	});

	test("HTTP boundary: a payload without an occurrence only rates; the current one skips once; an old one never; a bad one is refused", async ({
		page,
	}) => {
		await signIn(page);
		type St = {
			stations: { id: number; name: string; ready: boolean }[];
			session: { sessionId: string; entryId: string; status: string } | null;
			nowPlaying: { id: string; isPlaying: boolean; thumb: -1 | 0 | 1 } | null;
		};
		type Snap = St & {
			session: (St["session"] & { queue: { track: { id: string; thumb: -1 | 0 | 1 } }[] }) | null;
		};
		const state = async () =>
			(await (await page.request.get("/api/state?live=1&refresh=1")).json()) as St;
		const station = (await state()).stations.find((s) => s.name !== "Alles" && s.ready)!;
		expect((await post(page, `/api/stations/${station.id}/play`)).ok()).toBe(true);
		// The station plays, confirmed: the session's current entry is the song playing.
		let st: St = await state();
		await expect
			.poll(
				async () => {
					st = await state();
					return st.session?.status === "active" && st.nowPlaying?.isPlaying === true;
				},
				{ timeout: 30_000, intervals: [1_000, 3_000] },
			)
			.toBe(true);
		const a = st.nowPlaying!.id;
		const shown = { sessionId: st.session!.sessionId, entryId: st.session!.entryId };
		expect((await fake("status")).current).toBe(a);
		// Every rating this probe changes is read first and put back at the end, whatever happens:
		// the specs after this one share the listener and pick their songs from the same station.
		const was = new Map<string, -1 | 0 | 1>();
		const remember = async (id: string) => {
			if (was.has(id)) return;
			const snap = (await state()) as Snap;
			const t = [snap.nowPlaying, ...(snap.session?.queue ?? []).map((e) => e.track)].find(
				(x) => x?.id === id,
			);
			expect(t, `rating of ${id} readable before the probe changes it`).toBeTruthy();
			was.set(id, t!.thumb);
		};
		await remember(a);
		try {
			// The old payload, no occurrence ("Eher nicht"): stored, not skipped, still playing.
			const legacyRetest = await post(page, `/api/tracks/${a}/retest`, { keep: false });
			expect(legacyRetest.ok()).toBe(true);
			expect(await legacyRetest.json()).toEqual({ skipped: false });
			await page.waitForTimeout(1500);
			expect((await fake("status")).current).toBe(a);
			// A malformed occurrence is refused, nothing stored or skipped.
			const bad = await post(page, `/api/tracks/${a}/thumb`, {
				value: 1,
				expected: { sessionId: 7 },
			});
			expect(bad.status()).toBe(400);
			expect((await fake("status")).current).toBe(a);
			// Bound to the occurrence playing: skipped once.
			const bound = await post(page, `/api/tracks/${a}/thumb`, { value: -1, expected: shown });
			expect(await bound.json()).toEqual({ skipped: true });
			await expect.poll(async () => (await fake("status")).current).not.toBe(a);
			const after = (await fake("status")).current;
			await remember(after!);
			// The same occurrence again, after it moved on: never a second skip.
			await page.request.get("/api/state?live=1&refresh=1");
			const old = await post(page, `/api/tracks/${a}/retest`, { keep: false, expected: shown });
			expect(((await old.json()) as { skipped: boolean }).skipped).toBe(false);
			await page.waitForTimeout(1500);
			expect((await fake("status")).current).toBe(after);
			// The old payload "Nie wieder" on the song playing now: stored, answered as not skipped.
			// (Song-wide; the play running now is spared by the station guard as well — covered
			// with the guard's later looks in test/hub/guard-occurrence.test.ts.)
			const legacy = await post(page, `/api/tracks/${after}/thumb`, { value: -1 });
			expect(legacy.ok()).toBe(true);
			expect(await legacy.json()).toEqual({ skipped: false });
		} finally {
			// Put back what was there (an unbound thumb never skips). The retest answers
			// ("Eher nicht") have no undo route; they leave no rating, only a retest verdict.
			for (const [id, value] of was)
				expect((await post(page, `/api/tracks/${id}/thumb`, { value })).ok()).toBe(true);
			await fake("pause");
		}
		for (const [id, value] of was) {
			const snap = (await state()) as Snap;
			const t = [snap.nowPlaying, ...(snap.session?.queue ?? []).map((e) => e.track)].find(
				(x) => x?.id === id,
			);
			if (t) expect(t.thumb).toBe(value);
		}
	});

	test("CTO-04 Nie wieder from the Verlauf on the song playing rates only: playback stays", async ({
		page,
	}) => {
		await signIn(page);
		const song = songs.plain[0]!;
		await playing(page, song.id);
		const nexts: string[] = [];
		page.on("request", (r) => {
			if (/\/api\/player\//.test(r.url())) nexts.push(r.url());
		});
		await page.goto("/verlauf");
		const row = rowsOf(page, song.name).first();
		await expect(row.locator(".hist-rate__hint")).not.toHaveText(/überspringt/);
		await never(row).click();
		await expect(line(row)).toHaveText(/^Gespeichert: Nie wieder\./);
		await expect(line(row)).not.toHaveText(/übersprungen|Überspringen/);
		expect(await thumbOf(page, song.id)).toBe(-1);
		// Still the same song, still playing: the Verlauf never moved playback.
		await page.waitForTimeout(1500);
		const now = await fake("status");
		expect(now.current).toBe(song.id);
		expect(now.playing).toBe(true);
		expect(nexts).toEqual([]);
		// Taking back is a rating change only, too.
		await expect(undo(row)).toHaveText("Rückgängig");
		await undo(row).click();
		await expect(line(row)).toHaveText(/^Zurückgenommen: wieder keine Bewertung\./);
		expect((await fake("status")).current).toBe(song.id);
		await fake("pause");
	});

	test("CTO-05 taking back from the song's other row, once; a reload never revives an old undo", async ({
		page,
	}) => {
		await signIn(page);
		const undos: string[] = [];
		page.on("request", (r) => {
			if (r.method() === "POST" && /\/api\/history\/ratings\/[^/]+\/undo$/.test(r.url()))
				undos.push(r.url());
		});
		await page.goto("/verlauf");
		const both = rowsOf(page, songs.twice.name);
		await expect(both).toHaveCount(2);
		await fav(both.nth(0)).click();
		await expect(line(both.nth(0))).toHaveText(/^Gespeichert: Favorit\./);
		await expect(line(both.nth(1))).toHaveText(/^Gespeichert: Favorit\./);
		// Taken back from the other row of the same song: done once, shown in both.
		await undo(both.nth(1)).click();
		await expect(line(both.nth(1))).toHaveText(/^Zurückgenommen: wieder keine Bewertung\./);
		await expect(line(both.nth(0))).toHaveText(/^Zurückgenommen: wieder keine Bewertung\./);
		await expect(undo(both.nth(0))).toHaveCount(0);
		await expect(undo(both.nth(1))).toHaveCount(0);
		expect(undos.length).toBe(1);
		expect(await thumbOf(page, songs.twice.id)).toBe(0);
		// Rated again, reloaded: the stored rating shows; no undo of an action this page did not make.
		await never(both.nth(0)).click();
		await expect(line(both.nth(0))).toHaveText(/^Gespeichert: Nie wieder\./);
		await page.reload();
		const again = rowsOf(page, songs.twice.name);
		await expect(never(again.nth(0))).toHaveAttribute("aria-pressed", "true");
		await expect(undo(again.nth(0))).toHaveCount(0);
		await expect(undo(again.nth(1))).toHaveCount(0);
		expect(undos.length).toBe(1);
		expect(await thumbOf(page, songs.twice.id)).toBe(-1);
	});

	test("CTO-05 delayed answer, another tab and Siri's route: the newer rating is never overwritten", async ({
		page,
		context,
	}) => {
		await signIn(page);
		await page.goto("/verlauf");
		const song = songs.plain[1]!;
		const row = rowsOf(page, song.name).first();
		await expect(fav(row)).toHaveAttribute("aria-pressed", "false");
		// A slow answer: one write, then the stored state.
		let release = () => {};
		const held = new Promise<void>((r) => {
			release = r;
		});
		const slow = async (route: Route) => {
			if (route.request().method() !== "POST") return route.fallback();
			const res = await route.fetch();
			await held;
			await route.fulfill({ response: res });
		};
		await page.route("**/api/history/ratings", slow);
		await fav(row).click();
		await expect(line(row)).toHaveText(/^Wird gespeichert: Favorit/);
		// A real double tap on the greyed key while it saves (forced, as in history-ratings.spec.ts).
		await fav(row).dblclick({ force: true });
		await page.waitForTimeout(500);
		release();
		await expect(line(row)).toHaveText(/^Gespeichert: Favorit\./);
		await page.unroute("**/api/history/ratings", slow);
		expect(await thumbOf(page, song.id)).toBe(1);
		// Another tab rates since: this tab's next tap is told so, nothing stored over it.
		const tab = await context.newPage();
		await tab.goto("/verlauf");
		const there = rowsOf(tab, song.name).first();
		await never(there).click();
		await expect(line(there)).toHaveText(/^Gespeichert: Nie wieder\./);
		await fav(row).click();
		await expect(line(row)).toHaveText(/^Inzwischen anders bewertet \(jetzt: Nie wieder\)/);
		expect(await thumbOf(page, song.id)).toBe(-1);
		await tab.close();
		// Siri's route (the thumb endpoint) since this page's own rating: taking back is refused.
		const other = songs.plain[2]!;
		const r2 = rowsOf(page, other.name).first();
		await never(r2).click();
		await expect(line(r2)).toHaveText(/^Gespeichert: Nie wieder\./);
		expect((await post(page, `/api/tracks/${other.id}/thumb`, { value: 1 })).ok()).toBe(true);
		await undo(r2).click();
		await expect(line(r2)).toHaveText(
			/^Nicht zurückgenommen: Der Song wurde inzwischen anders bewertet/,
		);
		expect(await thumbOf(page, other.id)).toBe(1);
	});

	test("CTO-06 a rule's effect is shown only when counted for the draft shown, through held and reordered previews", async ({
		page,
	}) => {
		await signIn(page);
		await importAlphaBeta(page);
		const held: { route: Route; draft: unknown }[] = [];
		const hold = (route: Route) => {
			held.push({ route, draft: route.request().postDataJSON() });
		};
		const answer = async (i: number) => {
			const [h] = held.splice(i, 1);
			const res = await h!.route.fetch();
			await h!.route.fulfill({ response: res });
		};
		await page.goto("/auswahl");
		const rules = page.locator(".selection__rules");
		const rule = (name: string) => rules.locator(".row").filter({ hasText: name });
		await expect(
			page.getByRole("button", { name: "Ausschließen: Alpha", exact: true }),
		).toBeEnabled();
		await page.route("**/api/history/selection/preview", hold);
		await page.getByRole("button", { name: "Ausschließen: Alpha", exact: true }).click();
		await expect.poll(() => held.length).toBe(1);
		// Not counted yet: no claim about what the new rule does.
		await expect(rule("Alpha")).not.toContainText("Betrifft derzeit nichts");
		await expect(rule("Alpha")).toContainText("Wird gezählt");
		await answer(0);
		await expect(rule("Alpha")).toContainText("Nimmt: 2 Wiedergaben");
		// Alpha, then Beta: while Beta's count is on its way, neither rule shows a count of another draft.
		await page.getByRole("button", { name: "Ausschließen: Beta", exact: true }).click();
		await expect.poll(() => held.length).toBe(1);
		await expect(rule("Beta")).not.toContainText("Betrifft derzeit nichts");
		await expect(rule("Beta")).toContainText("Wird gezählt");
		await expect(rule("Alpha")).toContainText("Wird gezählt");
		// Then Alpha taken out again: two counts on their way, answered newest first.
		await rule("Alpha")
			.getByRole("button", { name: /^Regel entfernen/ })
			.click();
		await expect.poll(() => held.length).toBe(2);
		await answer(1);
		await answer(0);
		await expect(rule("Beta")).toContainText("Nimmt: 2 Wiedergaben");
		await expect(rule("Alpha")).toHaveCount(0);
		await expect(
			page.locator(".notice[role=status]").filter({ hasText: "Jetzt in Kraft" }),
		).toContainText("Mit deinem Entwurf: 2 von 4 Wiedergaben zählen");
		await page.unroute("**/api/history/selection/preview", hold);
	});

	test("CTO-06 switching the import off, reloading and on again keeps its data and rules", async ({
		page,
	}) => {
		await signIn(page);
		await importAlphaBeta(page);
		await page.goto("/auswahl");
		await page.getByRole("button", { name: "Ausschließen: Beta", exact: true }).click();
		await page.getByRole("button", { name: "Auswahl übernehmen" }).click();
		await expect(page.getByText(/^Übernommen \(Stand/)).toBeVisible();
		const before = (await (await page.request.get("/api/history/selection")).json()) as {
			selection: { enabled: boolean; rules: unknown[] };
			dataset: { key: string; rows: number; songs: number };
		};
		expect(before.selection.rules).toHaveLength(1);
		await page.getByRole("button", { name: "Import ausschalten" }).click();
		await expect(page.getByText(/^Import ausgeschaltet\./)).toBeVisible();
		await page.reload();
		await expect(page.getByRole("button", { name: "Import wieder einschalten" })).toBeVisible();
		await expect(page.locator(".selection__rules")).toContainText("Beta");
		await page.getByRole("button", { name: "Import wieder einschalten" }).click();
		await expect(page.getByRole("button", { name: "Import ausschalten" })).toBeVisible();
		const after = (await (
			await page.request.get("/api/history/selection")
		).json()) as typeof before;
		expect(after.selection.enabled).toBe(true);
		expect(after.selection.rules).toEqual(before.selection.rules);
		expect(after.dataset).toMatchObject({
			key: before.dataset.key,
			rows: before.dataset.rows,
			songs: before.dataset.songs,
		});
		const inForce = page.locator(".notice[role=status]").filter({ hasText: "Jetzt in Kraft" });
		await expect(inForce).toContainText("Jetzt in Kraft: 2 von 4 Wiedergaben zählen");
		await expect(page.locator(".selection__rules")).toContainText("Beta");
		await expect(page.locator(".selection__rules")).toContainText("Nimmt: 2 Wiedergaben");
	});

	// The specs after this one share the listener and pick their songs from the same
	// Verlauf: every rating this story changed is put back (an unbound thumb never skips).
	test("restore: the ratings this story changed are put back as the seed found them", async ({
		page,
	}) => {
		await signIn(page);
		expect(baseline.size).toBeGreaterThan(0);
		for (const e of await history(page)) {
			const was = baseline.get(e.id);
			if (was === undefined || (e.thumb ?? 0) === was) continue;
			expect((await post(page, `/api/tracks/${e.id}/thumb`, { value: was })).ok()).toBe(true);
		}
		for (const e of await history(page))
			if (baseline.has(e.id)) expect(e.thumb ?? 0, e.name).toBe(baseline.get(e.id));
	});
});

/** A synthetic two-song import (Alpha, Beta), two plays each, no rules. */
async function importAlphaBeta(page: Page) {
	type Selection = { revision: number; dataset: { hasImport: boolean; key: string } };
	const selection = async () =>
		(await (await page.request.get("/api/history/selection")).json()) as Selection;
	const ids = ["T000000000000000000000", "T000000000000000000001"];
	const old = await selection();
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
	const now = await selection();
	expect(now.dataset.hasImport).toBe(true);
}
