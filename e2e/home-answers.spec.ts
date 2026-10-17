/**
 * Answers given on Home — "Favorit" / "Nie wieder" and the retest's
 * "Gern wieder" / "Eher nicht" — through answers that arrive late, in the
 * wrong order, refused, or after the song moved on (CTO-01..04, 2026-10-15).
 * Rendered client against intercepted API snapshots: the stand-in server here
 * stores a rating when the request arrives and answers when the test lets it,
 * like a slow network. No provider, no history writes, no audio.
 */
import { type BrowserContext, expect, type Page, type Route, test } from "@playwright/test";
import { DEFAULT_RULES } from "../src/core/types";
import type { AppState } from "../src/shared/api";

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

test.use({ viewport: { width: 390, height: 844 } });

const TIME = Date.UTC(2026, 9, 1, 12);
const song = (id: string, name: string) => ({
	id,
	name,
	artists: "Test Artist",
	album: "Test Album",
	imageUrl: null,
	durationMs: 180_000,
	thumb: 0 as -1 | 0 | 1,
});
const A = song("track-a", "Song A");
const B = song("track-b", "Song B");

/** A queue of A, B and A again: two occurrences of one song. */
function snapshot(): AppState {
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
				{ entryId: "entry-0", track: { ...A } },
				{ entryId: "entry-1", track: { ...B } },
				{ entryId: "entry-2", track: { ...A } },
			],
		},
		nowPlaying: {
			...A,
			isPlaying: true,
			progressMs: 12_000,
			stationId: 1,
			kind: "probe",
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
		serverTime: TIME,
	};
}

interface Held {
	path: string;
	body: Record<string, unknown>;
	answer: () => Promise<void>;
}

/** The stand-in: what is stored, what was asked, and the answers still on their way. */
async function setup(page: Page) {
	const model = {
		state: snapshot(),
		thumbs: new Map<string, -1 | 0 | 1>(),
		verdicts: [] as { id: string; keep: boolean }[],
		writes: [] as { path: string; body: Record<string, unknown> }[],
		nexts: [] as Record<string, unknown>[],
		held: [] as Held[],
		/** How a rating/retest request is answered: held for the test, at once, or refused. */
		mode: "hold" as "hold" | "now" | "503" | "hold503",
		skipError: null as string | null,
		/** While set, snapshot reads wait: the page can learn nothing from a fresh read meanwhile. */
		stateGate: null as Promise<void> | null,
		stateReads: 0,
	};
	await page.clock.install({ time: TIME });
	await page.clock.setFixedTime(TIME);
	await page.route("**/api/**", async (route: Route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		if (path === "/api/state") {
			model.stateReads++;
			if (model.stateGate) await model.stateGate;
			const s = structuredClone(model.state);
			for (const e of s.session?.queue ?? []) e.track.thumb = model.thumbs.get(e.track.id) ?? 0;
			if (s.nowPlaying) s.nowPlaying.thumb = model.thumbs.get(s.nowPlaying.id) ?? 0;
			return route.fulfill({ json: s });
		}
		if (path === "/api/devices")
			return route.fulfill({
				json: [
					{
						id: "iphone",
						name: "Test iPhone",
						active: true,
						restricted: false,
						type: "Smartphone",
					},
				],
			});
		if (path === "/api/native/devices")
			return route.fulfill({ json: { configured: false, devices: [] } });
		const thumb = /^\/api\/tracks\/([^/]+)\/thumb$/.exec(path);
		const retest = /^\/api\/tracks\/([^/]+)\/retest$/.exec(path);
		if (thumb || retest) {
			const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
			model.writes.push({ path, body });
			const refuse = () =>
				route.fulfill({
					status: 503,
					json: { error: { code: "unavailable", message: "Synthetic 503" } },
				});
			if (model.mode === "503") return refuse();
			if (model.mode === "hold503") {
				model.held.push({ path, body, answer: refuse });
				return;
			}
			// Stored on arrival, like the Worker; only the answer travels slowly.
			if (thumb) model.thumbs.set(thumb[1]!, body.value as -1 | 0 | 1);
			else model.verdicts.push({ id: retest![1]!, keep: body.keep === true });
			const skipping = (thumb && body.value === -1) || (retest && body.keep === false);
			const json =
				skipping && model.skipError
					? { skipped: false, skipError: model.skipError }
					: { skipped: false };
			const answer = () => route.fulfill({ json });
			if (model.mode === "now") return answer();
			model.held.push({ path, body, answer });
			return;
		}
		if (path === "/api/player/next") {
			model.nexts.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
			return route.fulfill({ json: { ok: true, acceptedAt: TIME + 60_000 } });
		}
		return route.fulfill({
			status: 500,
			json: { error: { code: "unexpected", message: `Unexpected ${path}` } },
		});
	});
	await page.goto("/");
	await expect(page.locator(".now-copy h2")).toHaveText("Song A");
	return model;
}

/** Lets every held answer arrive, the newest first (the wrong order), until none is left. */
async function answerNewestFirst(page: Page, model: { held: Held[] }) {
	for (let quiet = 0; quiet < 3; ) {
		await page.waitForTimeout(250);
		const next = model.held.pop();
		if (!next) {
			quiet++;
			continue;
		}
		quiet = 0;
		await next.answer();
	}
}

/** The listener moves on: the session plays `entryId` now (a later observation). */
async function moveTo(page: Page, model: { state: AppState }, entryId: string, at: number) {
	const s = model.state;
	const entry = s.session!.queue.find((e) => e.entryId === entryId)!;
	Object.assign(s.session!, { entryId, observedAt: at, progressMs: 1_000 });
	s.nowPlaying = { ...s.nowPlaying!, ...entry.track, observedAt: at, progressMs: 1_000 };
	s.serverTime = at;
	const read = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/state");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await read;
	await expect(page.locator(".now-copy h2")).toHaveText(entry.track.name);
}

const favKey = (page: Page) => page.getByRole("button", { name: "Daumen hoch: Favorit" });
const neverKey = (page: Page) =>
	page.getByRole("button", { name: "Daumen runter: diesen Song nie wieder" });
const retestBox = (page: Page) => page.getByRole("group", { name: "Nachprüfung" });
const answerLine = (page: Page) => page.locator(".answer-note");

test("CTO-01 Favorit then Nie wieder, answered in reverse: the newer choice stays, sent in order", async ({
	page,
}) => {
	const model = await setup(page);
	await favKey(page).click();
	await neverKey(page).click();
	await answerNewestFirst(page, model);
	// What is stored is the newer choice, and the page shows it.
	expect(model.thumbs.get(A.id)).toBe(-1);
	await expect(neverKey(page)).toHaveAttribute("aria-pressed", "true");
	await expect(favKey(page)).toHaveAttribute("aria-pressed", "false");
	await expect(page.locator(".flash")).not.toHaveText("Als Favorit gemerkt");
	// Never two answers about one song at once on their way: the server sees them in order.
	expect(model.writes.map((w) => w.body.value).at(-1)).toBe(-1);
	// Each names the occurrence it was given on, so only that one can be skipped.
	for (const w of model.writes)
		expect(w.body.expected).toEqual({ sessionId: "session-a", entryId: "entry-0" });
	expect(model.writes.length).toBeLessThanOrEqual(2);
	expect(model.nexts).toEqual([]);
});

test("CTO-01 Ja then Nein on a retest, answered in reverse: the newer answer stays", async ({
	page,
}) => {
	const model = await setup(page);
	await retestBox(page).getByRole("button", { name: "Gern wieder" }).click();
	await retestBox(page).getByRole("button", { name: "Eher nicht" }).click();
	await answerNewestFirst(page, model);
	expect(model.verdicts.at(-1)).toEqual({ id: A.id, keep: false });
	await expect(retestBox(page).getByRole("status")).toHaveText(
		"Danke. Er kommt seltener, und true-shuffle fragt später noch einmal.",
	);
});

test("CTO-01/02 Favorit stored, the newer Nie wieder refused: the stored Favorit shows, the refusal is said", async ({
	page,
}) => {
	const model = await setup(page);
	await favKey(page).click();
	await neverKey(page).click();
	// Favorit reaches the stand-in and is stored; the newer "Nie wieder" will be refused (503).
	expect(model.writes.map((w) => w.body.value)).toEqual([1]);
	model.mode = "hold503";
	await answerNewestFirst(page, model);
	expect(model.writes.map((w) => w.body.value)).toEqual([1, -1]);
	expect(model.thumbs.get(A.id)).toBe(1);
	// What was actually stored shows — not the rating from before both taps — and the newer refusal is said.
	await expect(favKey(page)).toHaveAttribute("aria-pressed", "true");
	await expect(neverKey(page)).toHaveAttribute("aria-pressed", "false");
	await expect(answerLine(page)).toHaveText(/^Nicht gespeichert: Synthetic 503/);
	// The explicit retry sends the newer choice once more; then it holds.
	model.mode = "now";
	await page.getByRole("button", { name: "Nochmal speichern" }).click();
	await expect(neverKey(page)).toHaveAttribute("aria-pressed", "true");
	await expect(answerLine(page)).toHaveCount(0);
	expect(model.writes.map((w) => w.body.value)).toEqual([1, -1, -1]);
	expect(model.thumbs.get(A.id)).toBe(-1);
	expect(model.nexts).toEqual([]);
});

test("CTO-01/02 Favorit stored, the newer Nie wieder refused, no fresh read meanwhile: the stored Favorit still shows", async ({
	page,
}) => {
	const model = await setup(page);
	let open = () => {};
	model.stateGate = new Promise<void>((r) => {
		open = r;
	});
	await favKey(page).click();
	await neverKey(page).click();
	model.mode = "hold503";
	await answerNewestFirst(page, model);
	expect(model.writes.map((w) => w.body.value)).toEqual([1, -1]);
	expect(model.thumbs.get(A.id)).toBe(1);
	// Only what the page itself was told: Favorit stored, Nie wieder refused.
	await expect(favKey(page)).toHaveAttribute("aria-pressed", "true");
	await expect(neverKey(page)).toHaveAttribute("aria-pressed", "false");
	await expect(answerLine(page)).toHaveText(/^Nicht gespeichert: Synthetic 503/);
	open();
	await expect(favKey(page)).toHaveAttribute("aria-pressed", "true");
});

test("CTO-02 a double tap, a 503 and an explicit retry: one write each, no false success", async ({
	page,
}) => {
	const model = await setup(page);
	// Refused on its way back; the double tap happens while it is still on its way.
	model.mode = "hold503";
	await favKey(page).dblclick();
	await page.waitForTimeout(300);
	expect(model.writes.length).toBe(1);
	await answerNewestFirst(page, model);
	await expect(answerLine(page)).toHaveText(/^Nicht gespeichert: Synthetic 503/);
	expect(model.writes.length).toBe(1);
	await expect(favKey(page)).toHaveAttribute("aria-pressed", "false");
	await expect(page.locator(".flash")).not.toHaveText("Als Favorit gemerkt");
	// The retry sends the same choice once more; then it holds.
	model.mode = "now";
	await page.getByRole("button", { name: "Nochmal speichern" }).click();
	await expect(favKey(page)).toHaveAttribute("aria-pressed", "true");
	await expect(answerLine(page)).toHaveCount(0);
	expect(model.writes.map((w) => w.body.value)).toEqual([1, 1]);
	expect(model.thumbs.get(A.id)).toBe(1);
	// A double tap on "Nie wieder" while its answer is on its way: one decision, one write, no second skip.
	model.mode = "hold";
	await neverKey(page).dblclick();
	await page.waitForTimeout(300);
	expect(model.writes.map((w) => w.body.value)).toEqual([1, 1, -1]);
	await answerNewestFirst(page, model);
	await expect(neverKey(page)).toHaveAttribute("aria-pressed", "true");
	expect(model.writes.map((w) => w.body.value)).toEqual([1, 1, -1]);
	expect(model.nexts).toEqual([]);
});

test("CTO-03 A, B, then A again: a late answer for the first A changes neither B nor the new A", async ({
	page,
}) => {
	const model = await setup(page);
	// Answered for the first A; its answer is still on its way while the listener moves on.
	await retestBox(page).getByRole("button", { name: "Eher nicht" }).click();
	await moveTo(page, model, "entry-1", TIME + 200_000);
	await moveTo(page, model, "entry-2", TIME + 400_000);
	await answerNewestFirst(page, model);
	// The new occurrence of A asks again, and can be answered.
	await expect(retestBox(page).getByRole("button", { name: "Gern wieder" })).toBeVisible();
	model.mode = "now";
	await retestBox(page).getByRole("button", { name: "Gern wieder" }).click();
	await expect(retestBox(page).getByRole("status")).toHaveText(
		"Danke. Der Song kommt wieder wie jeder andere.",
	);
	expect(model.verdicts).toEqual([
		{ id: A.id, keep: false },
		{ id: A.id, keep: true },
	]);
	expect(model.nexts).toEqual([]);
});

test("CTO-04 a failed skip is said apart from the stored rating, and retried only on that occurrence", async ({
	page,
}) => {
	const model = await setup(page);
	model.mode = "now";
	model.skipError = "Synthetic: Spotify hat abgelehnt";
	await neverKey(page).click();
	await expect(neverKey(page)).toHaveAttribute("aria-pressed", "true");
	await expect(answerLine(page)).toHaveText(
		/Nie wieder gespeichert\. Überspringen fehlgeschlagen: Synthetic: Spotify hat abgelehnt/,
	);
	await expect(answerLine(page)).not.toHaveText(/Nicht gespeichert/);
	// The explicit retry skips exactly the occurrence that was rated.
	await page.getByRole("button", { name: "Jetzt überspringen" }).click();
	await expect.poll(() => model.nexts.length).toBe(1);
	expect(model.nexts[0]).toMatchObject({ sessionId: "session-a", entryId: "entry-0" });

	// Rated again on the new A; the song moves on before the failed skip is retried: no skip key on B.
	await moveTo(page, model, "entry-2", TIME + 400_000);
	// The song is "Nie wieder" already: the first tap clears it, the second sets it again.
	await expect(neverKey(page)).toHaveAttribute("aria-pressed", "true");
	await neverKey(page).click();
	await expect(neverKey(page)).toHaveAttribute("aria-pressed", "false");
	await neverKey(page).click();
	await expect(page.getByRole("button", { name: "Jetzt überspringen" })).toBeVisible();
	model.state.session!.queue.push({ entryId: "entry-3", track: { ...B } });
	await moveTo(page, model, "entry-3", TIME + 600_000);
	await expect(page.getByRole("button", { name: "Jetzt überspringen" })).toHaveCount(0);
	await expect(answerLine(page)).toHaveCount(0);
	expect(model.nexts.length).toBe(1);
});

test("CTO-04 a late answer with a failed skip for A never offers to skip B", async ({ page }) => {
	const model = await setup(page);
	model.skipError = "Synthetic: Spotify hat abgelehnt";
	await neverKey(page).click();
	await moveTo(page, model, "entry-1", TIME + 200_000);
	await answerNewestFirst(page, model);
	await expect(page.locator(".now-copy h2")).toHaveText("Song B");
	await expect(page.getByRole("button", { name: "Jetzt überspringen" })).toHaveCount(0);
	expect(model.nexts).toEqual([]);
});
