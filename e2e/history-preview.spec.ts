/**
 * Listening samples in the Verlauf (docs/HISTORY_PREVIEW.md), end to end: the
 * real Worker and page against the Spotify/Deezer stand-in (e2e/fake-server.ts).
 * The sample audio itself is synthetic: requests to Deezer's media host are
 * answered here with a generated tone, so the page's CSP and the real
 * <audio> path are exercised without any real recording. Spotify must see no
 * player command at all from anything a sample does.
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

const FAKE = `http://127.0.0.1:${process.env.FAKE_PORT ?? 8788}/__control`;
const MEDIA = "https://cdnt-preview.dzcdn.net/**";
const SHOTS = process.env.PREVIEW_SHOTS ?? "e2e/.artifacts/preview-shots";

function acknowledgeRelease(context: BrowserContext): void {
	const handle = (p: Page) =>
		void p.addLocatorHandler(p.getByRole("dialog", { name: /^Neu in Version / }), (d) =>
			d.getByRole("button", { name: "Verstanden" }).click(),
		);
	for (const p of context.pages()) handle(p);
	context.on("page", handle);
}

async function fake<T = { calls: number; log?: string[] }>(action: string): Promise<T> {
	return (await (await fetch(`${FAKE}/${action}`)).json()) as T;
}
/** Every request to the stand-in since `since`. */
const callsSince = async (since: number) => (await fake(`calls?since=${since}`)).log ?? [];
/** Anything a player would be told: play, pause, seek, next, transfer, queue, shuffle, volume. */
const transport = (calls: string[]) =>
	calls.filter((c) => !c.startsWith("GET ") && /\/v1\/me\/player/.test(c));

/** A generated tone, `seconds` long: the only "audio" any test plays. */
function tone(seconds: number): Buffer {
	const rate = 8000;
	const n = rate * seconds;
	const b = Buffer.alloc(44 + n * 2);
	b.write("RIFF", 0);
	b.writeUInt32LE(36 + n * 2, 4);
	b.write("WAVEfmt ", 8);
	b.writeUInt32LE(16, 16);
	b.writeUInt16LE(1, 20);
	b.writeUInt16LE(1, 22);
	b.writeUInt32LE(rate, 24);
	b.writeUInt32LE(rate * 2, 28);
	b.writeUInt16LE(2, 32);
	b.writeUInt16LE(16, 34);
	b.write("data", 36);
	b.writeUInt32LE(n * 2, 40);
	for (let i = 0; i < n; i++)
		b.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / rate) * 2000), 44 + i * 2);
	return b;
}

/**
 * The page's sample traffic, its writes, and the audio elements it made.
 * `media` answers Deezer's host with a tone (or a status); nothing else leaves.
 */
async function instrument(
	page: Page,
	media: { status: number; seconds: number } = { status: 200, seconds: 3 },
) {
	const seen = {
		previews: [] as string[],
		media: [] as string[],
		writes: [] as string[],
		foreign: [] as string[],
	};
	page.on("request", (r) => {
		const u = new URL(r.url());
		if (u.pathname === "/api/history/preview") seen.previews.push(r.postData() ?? "");
		else if (r.method() !== "GET" && u.host === "127.0.0.1:8787")
			seen.writes.push(`${r.method()} ${u.pathname}`);
		if (u.host === "cdnt-preview.dzcdn.net" || r.resourceType() === "media")
			seen.media.push(u.href);
		else if (!["127.0.0.1", "localhost"].includes(u.hostname) && !u.protocol.startsWith("data"))
			seen.foreign.push(u.href);
	});
	await page.route(MEDIA, (route: Route) =>
		media.status === 200
			? route.fulfill({ status: 200, contentType: "audio/wav", body: tone(media.seconds) })
			: route.fulfill({ status: media.status, body: "" }),
	);
	await page.addInitScript(() => {
		const w = window as unknown as { __audios: HTMLAudioElement[]; Audio: typeof Audio };
		w.__audios = [];
		const Orig = w.Audio;
		const Wrapped = function (this: unknown, src?: string) {
			const a = new Orig(src);
			w.__audios.push(a);
			return a;
		} as unknown as typeof Audio;
		Wrapped.prototype = Orig.prototype;
		w.Audio = Wrapped;
	});
	return seen;
}
const audios = (page: Page) =>
	page.evaluate(() =>
		(window as unknown as { __audios: HTMLAudioElement[] }).__audios.map((a) => ({
			paused: a.paused,
			src: a.getAttribute("src") ?? "",
		})),
	);
const silent = async (page: Page) => (await audios(page)).every((a) => a.paused);

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

/** Lookups that reach Deezer, by time: the Worker allows 12 a minute; tests stay under it. */
const asked: number[] = [];
async function budget(page: Page, n = 1): Promise<void> {
	const now = Date.now();
	const recent = asked.filter((t) => now - t < 61_000);
	if (recent.length + n > 11)
		await page.waitForTimeout(61_000 - (now - recent[recent.length - 11 + n]!));
	for (let i = 0; i < n; i++) asked.push(Date.now());
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rowAt = (page: Page, e: { name: string; playedAt: number }) =>
	page
		.locator(".hist-row")
		.filter({
			has: page.locator(`time[datetime="${new Date(e.playedAt).toISOString()}"]`),
		})
		.filter({
			has: page.locator(".hist-row__title", { hasText: new RegExp(`^${literal(e.name)}$`) }),
		});
const key = (row: Locator) => row.locator(".hist-preview__key");
const said = (row: Locator) => row.locator(".hist-preview__state");
const source = (row: Locator) => row.locator(".hist-preview__source");

/** Rows chosen in the first test: each with a sample, one song twice. */
const rows = {
	ready: [] as HistoryEntry[],
	twice: [] as HistoryEntry[],
};

test.describe.configure({ mode: "serial" });

test.describe("listening samples in the Verlauf", () => {
	test("setup: plays heard in the stand-in fill the Verlauf; a song twice", async ({ page }) => {
		test.setTimeout(600_000);
		acknowledgeRelease(page.context());
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
		expect(
			(
				await page.request.post(`/api/stations/${station!.id}/play`, {
					headers: { "x-ts": "1" },
					data: {},
				})
			).ok(),
		).toBe(true);
		await fake("advance?ms=3600000");
		let all: HistoryEntry[] = [];
		await expect
			.poll(
				async () => {
					await page.request.get("/api/state?live=1&refresh=1");
					all = await history(page);
					return all.length;
				},
				{ timeout: 240_000, intervals: [6_000] },
			)
			.toBeGreaterThan(8);
		// The same song once more, outside the station: two rows of one song.
		const first = all[all.length - 1]!;
		await fake(
			`play-song?id=${first.id}&context=${encodeURIComponent("spotify:album:E2EPREVIEWALBUM00000000")}`,
		);
		await expect
			.poll(
				async () => {
					const st = (await (await page.request.get("/api/state?live=1&refresh=1")).json()) as {
						nowPlaying: { id: string } | null;
					};
					return st.nowPlaying?.id ?? null;
				},
				{ timeout: 30_000, intervals: [1_000, 3_000] },
			)
			.toBe(first.id);
		await fake("finish");
		await expect
			.poll(
				async () => {
					await page.request.get("/api/state?live=1&refresh=1");
					all = await history(page);
					return all.filter((e) => e.id === first.id).length;
				},
				{ timeout: 120_000, intervals: [6_000] },
			)
			.toBe(2);
		await fake("pause");
		// Rows whose song has a sample, asked once here so the tests know.
		const distinct = all.filter((e, i) => all.findIndex((x) => x.id === e.id) === i);
		for (const e of distinct.slice(0, 6)) {
			await budget(page);
			const r = await page.request.post("/api/history/preview", {
				headers: { "x-ts": "1" },
				data: { trackId: e.id, playedAt: e.playedAt },
			});
			const v = (await r.json()) as { status: string };
			console.log("classify", e.name, v.status);
			if (v.status === "ready" && e.id !== first.id) rows.ready.push(e);
		}
		rows.twice = all.filter((e) => e.id === first.id);
		console.log(
			"twice classify",
			(
				(await (
					await page.request.post("/api/history/preview", {
						headers: { "x-ts": "1" },
						data: { trackId: first.id, playedAt: rows.twice[0]!.playedAt },
					})
				).json()) as { status: string }
			).status,
		);
		asked.push(Date.now());
		expect(rows.ready.length).toBeGreaterThanOrEqual(3);
	});

	test("A: without a tap, nothing — viewing, more rows, rating and undo send no sample request and load no audio", async ({
		page,
	}) => {
		acknowledgeRelease(page.context());
		const seen = await instrument(page);
		await signIn(page);
		const since = (await fake("status")).calls;
		await page.goto("/verlauf");
		const row = rowAt(page, rows.ready[0]!);
		await expect(row).toBeVisible();
		await expect(page.locator(".hist-preview__key")).toHaveCount(
			await page.locator(".hist-row").count(),
		);
		await expect(key(row)).toHaveText(/^Hörprobe/);
		await page.mouse.wheel(0, 4000);
		const more = page.getByRole("button", { name: "Ältere laden" });
		if (await more.isVisible()) await more.click();
		await row.getByRole("button", { name: "Favorit", exact: true }).click();
		await expect(row.locator(".hist-rate__state")).toHaveText(/^Gespeichert: Favorit\./);
		await row.getByRole("button", { name: /^Rückgängig/ }).click();
		await expect(row.locator(".hist-rate__state")).toHaveText(/^Zurückgenommen/);
		await row.getByRole("button", { name: "Nie wieder", exact: true }).click();
		await expect(row.locator(".hist-rate__state")).toHaveText(/^Gespeichert: Nie wieder\./);
		await row.getByRole("button", { name: /^Rückgängig/ }).click();
		await expect(row.locator(".hist-rate__state")).toHaveText(/^Zurückgenommen/);
		await page.waitForTimeout(1_000);
		expect(seen.previews).toEqual([]);
		expect(seen.media).toEqual([]);
		expect(seen.foreign).toEqual([]);
		expect(await audios(page)).toEqual([]);
		// Only the rating writes the taps made; none from samples.
		expect(seen.writes.every((w) => w.startsWith("POST /api/history/ratings"))).toBe(true);
		const calls = await callsSince(since);
		expect(calls.filter((c) => c.includes("/deezer"))).toEqual([]);
		expect(transport(calls)).toEqual([]);
	});

	test("B: a tap plays, stop, natural end, again; A→B→A; two rows of one song; a refused play() asks for a tap", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		acknowledgeRelease(page.context());
		const seen = await instrument(page);
		// The first play() is refused as a strict mobile browser would.
		await page.addInitScript(() => {
			const orig = HTMLMediaElement.prototype.play;
			let refused = false;
			HTMLMediaElement.prototype.play = function () {
				if (!refused && (window as unknown as { __refuseOnce?: boolean }).__refuseOnce) {
					refused = true;
					return Promise.reject(new DOMException("needs a gesture", "NotAllowedError"));
				}
				return orig.call(this);
			};
		});
		await signIn(page);
		const since = (await fake("status")).calls;
		const before = JSON.stringify(await history(page));
		await page.goto("/verlauf");
		const [a, b] = [rowAt(page, rows.ready[0]!), rowAt(page, rows.ready[1]!)];
		await expect(a).toBeVisible();
		await budget(page);
		await key(a).click();
		await expect(key(a)).toHaveText(/^Stopp/);
		await expect(source(a)).toContainText("Kurze Hörprobe von Deezer");
		await expect(source(a).getByRole("link", { name: "Bei Deezer ansehen" })).toHaveAttribute(
			"href",
			/^https:\/\/www\.deezer\.com\/track\/\d+$/,
		);
		await page.screenshot({ path: `${SHOTS}/B1-playing.png`, fullPage: false });
		expect((await audios(page)).filter((x) => !x.paused)).toHaveLength(1);
		await key(a).click();
		await expect(key(a)).toHaveText(/^Nochmal hören/);
		expect(await silent(page)).toBe(true);
		await key(a).click(); // again, without asking again
		await expect(key(a)).toHaveText(/^Stopp/);
		await expect(key(a)).toHaveText(/^Nochmal hören/, { timeout: 10_000 }); // the 3 s tone ended
		expect(seen.previews).toHaveLength(1);
		expect(await audios(page)).toHaveLength(1); // one player for the page

		// A → B → A quickly, with A's first answer held until after B.
		const held: Route[] = [];
		await page.route("**/api/history/preview", async (route) => {
			if (
				JSON.parse(route.request().postData() ?? "{}").trackId === rows.ready[0]!.id &&
				held.length === 0
			)
				held.push(route);
			else await route.continue();
		});
		await page.reload();
		await expect(a).toBeVisible();
		await budget(page, 3);
		await key(a).click();
		await expect(key(a)).toHaveText(/^Sucht/);
		await key(b).click();
		await expect(key(b)).toHaveText(/^Stopp/);
		await expect(key(a)).toHaveText(/^Hörprobe/);
		await held[0]!.continue(); // A's late answer
		await page.waitForTimeout(800);
		await expect(key(a)).toHaveText(/^Hörprobe/);
		await expect(key(b)).toHaveText(/^Stopp/);
		const now = await audios(page);
		expect(now.filter((x) => !x.paused)).toHaveLength(1);
		expect(now[0]!.src).toContain(rows.ready[1]!.id);
		await key(a).click();
		await expect(key(a)).toHaveText(/^Stopp/);
		await expect(key(b)).toHaveText(/^Hörprobe/);
		expect((await audios(page))[0]!.src).toContain(rows.ready[0]!.id);
		await page.unroute("**/api/history/preview");

		// Two rows of one song: each its own.
		const [t1, t2] = rows.twice.map((e) => rowAt(page, e));
		await budget(page);
		await key(t1!).click();
		await expect(key(t1!)).not.toHaveText(/^(Hörprobe|Sucht)/);
		await expect(key(t2!)).toHaveText(/^Hörprobe/);
		await key(t1!).click();

		// A refused play(): honest "ready", the next tap plays.
		await page.evaluate(() => {
			(window as unknown as { __refuseOnce: boolean }).__refuseOnce = true;
		});
		const c = rowAt(page, rows.ready[2]!);
		await budget(page);
		await key(c).click();
		await expect(key(c)).toHaveText(/^Abspielen/);
		await expect(said(c)).toHaveText("Bereit — zum Abspielen nochmal tippen.");
		await page.screenshot({ path: `${SHOTS}/B2-ready-after-refused-play.png` });
		await key(c).click();
		await expect(key(c)).toHaveText(/^Stopp/);
		await key(c).click();

		expect(seen.foreign).toEqual([]);
		expect(transport(await callsSince(since))).toEqual([]);
		// Nothing in the Verlauf changed (ratings, facts, rows).
		expect(JSON.stringify(await history(page))).toBe(before);
	});

	test("C: no sample, ambiguous, Deezer refusing, offline, broken media — said honestly, never Spotify", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		acknowledgeRelease(page.context());
		const seen = await instrument(page, { status: 404, seconds: 0 });
		await signIn(page);
		const since = (await fake("status")).calls;
		await page.goto("/verlauf");
		const [r0, r1, r2] = rows.ready.map((e) => rowAt(page, e));
		await expect(r0!).toBeVisible();
		try {
			await fake(`deezer?reset=1&none=${rows.ready[0]!.id}&twin=${rows.ready[1]!.id}`);
			await budget(page, 2);
			await key(r0!).click();
			await expect(key(r0!)).toHaveText(/^Keine Hörprobe/);
			await expect(key(r0!)).toHaveAttribute("aria-disabled", "true");
			await expect(said(r0!)).toHaveText("Deezer hat für diese Aufnahme keine Hörprobe.");
			await key(r1!).click();
			await expect(said(r1!)).toHaveText(/mehrere Aufnahmen/);
			await page.screenshot({ path: `${SHOTS}/C1-unavailable-ambiguous.png` });
			// A tap on a row already said changes nothing and asks nobody.
			// (aria-disabled, so Playwright would wait for it to become enabled: forced.)
			const n = seen.previews.length;
			await key(r0!).click({ force: true });
			await page.waitForTimeout(300);
			expect(seen.previews).toHaveLength(n);
			for (const [status, text] of [
				[429, "Deezer bittet gerade um eine Pause. Später nochmal."],
				[403, "Deezer lässt die Abfrage gerade nicht zu."],
				[401, "Deezer lässt die Abfrage gerade nicht zu."],
				[500, "Deezer antwortet gerade nicht richtig."],
			] as const) {
				await fake(`deezer?reset=1&fail=${status}`);
				await budget(page);
				await key(r2!).click();
				await expect(said(r2!)).toHaveText(text);
				await expect(key(r2!)).toHaveText(/^Nochmal versuchen/);
				await page.waitForTimeout(500);
			}
			await fake("deezer?reset=1");
			// Offline: the request never leaves.
			await page.route("**/api/history/preview", (r) => r.abort("internetdisconnected"));
			await key(r2!).click();
			await expect(said(r2!)).toHaveText("Keine Verbindung — Hörprobe nicht geladen.");
			await page.unroute("**/api/history/preview");
			// Found, but the media host answers 404: an error, the key asks again on a tap only.
			await budget(page);
			const before = seen.previews.length;
			await key(r2!).click();
			await expect(said(r2!)).toHaveText(/^Die Hörprobe ließ sich nicht (laden|abspielen)/);
			await expect(key(r2!)).toHaveText(/^Nochmal versuchen/);
			await page.screenshot({ path: `${SHOTS}/C2-media-error.png` });
			await page.waitForTimeout(2_000);
			expect(seen.previews).toHaveLength(before + 1);
		} finally {
			await fake("deezer?reset=1");
		}
		expect(await silent(page)).toBe(true);
		expect(seen.foreign).toEqual([]);
		expect(transport(await callsSince(since))).toEqual([]);
	});

	test("D: leaving, background, signing out while loading or playing — silent, nothing comes back; another session starts clean", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		acknowledgeRelease(page.context());
		const seen = await instrument(page, { status: 200, seconds: 20 });
		await signIn(page);
		const since = (await fake("status")).calls;
		await page.goto("/verlauf");
		const a = rowAt(page, rows.ready[0]!);
		await expect(a).toBeVisible();
		// Playing, then away to "Mehr": silent.
		await budget(page);
		await key(a).click();
		await expect(key(a)).toHaveText(/^Stopp/);
		await page.getByRole("link", { name: "Mehr", exact: true }).first().click();
		await expect(page).toHaveURL(/\/mehr$/);
		await expect.poll(() => silent(page)).toBe(true);
		// Loading, then away: the late answer plays nothing.
		await page.getByRole("link", { name: "Verlauf", exact: true }).first().click();
		const held: Route[] = [];
		await page.route("**/api/history/preview", (r) => void held.push(r));
		await budget(page);
		const mediaBefore = seen.media.length;
		await key(a).click();
		await expect.poll(() => held.length).toBe(1);
		await page.getByRole("link", { name: "Mehr", exact: true }).first().click();
		await held.pop()!.continue();
		await page.waitForTimeout(1_500);
		expect(await silent(page)).toBe(true);
		expect(seen.media).toHaveLength(mediaBefore); // the late answer loaded nothing
		await page.unroute("**/api/history/preview");
		// The tab goes to the background while playing: stopped, it stays stopped.
		await page.getByRole("link", { name: "Verlauf", exact: true }).first().click();
		await budget(page);
		await key(a).click();
		await expect(key(a)).toHaveText(/^Stopp/);
		await page.evaluate(() => {
			Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await expect(key(a)).toHaveText(/^Nochmal hören/);
		expect(await silent(page)).toBe(true);
		await page.evaluate(() => {
			Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await page.waitForTimeout(1_000);
		expect(await silent(page)).toBe(true);
		// Signed out elsewhere while playing: the page learns it and stops.
		await key(a).click();
		await expect(key(a)).toHaveText(/^Stopp/);
		const b = rowAt(page, rows.ready[1]!);
		await fake(`deezer?none=${rows.ready[1]!.id}`);
		await budget(page);
		await key(b).click();
		await expect(key(b)).toHaveText(/^Keine Hörprobe/); // a's sample stopped by this; b said
		await budget(page);
		await key(a).click();
		await expect(key(a)).toHaveText(/^Stopp/);
		expect((await page.request.post("/auth/logout", { headers: { "x-ts": "1" } })).ok()).toBe(true);
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect.poll(() => silent(page), { timeout: 20_000 }).toBe(true);
		await expect(page.getByRole("link", { name: "Mit Spotify anmelden" })).toBeVisible({
			timeout: 20_000,
		});
		// Loading when the session ends: the Worker answers nothing about the song.
		await fake("deezer?reset=1");
		await signIn(page);
		await page.goto("/verlauf");
		await expect(a).toBeVisible();
		// The account before (even the same one) left nothing behind: b is "not asked" again.
		await expect(key(b)).toHaveText(/^Hörprobe/);
		const held2: Route[] = [];
		await page.route("**/api/history/preview", (r) => void held2.push(r));
		const mediaBefore2 = seen.media.length;
		await key(a).click();
		await expect.poll(() => held2.length).toBe(1);
		expect((await page.request.post("/auth/logout", { headers: { "x-ts": "1" } })).ok()).toBe(true);
		const answer = page.waitForResponse(
			(r) => new URL(r.url()).pathname === "/api/history/preview",
		);
		await held2.pop()!.continue();
		expect((await answer).status()).toBe(401);
		// Said on the row, unless the page already learned of the sign-out and left the Verlauf.
		await expect(
			said(a)
				.filter({ hasText: "Bitte neu anmelden." })
				.or(page.getByRole("link", { name: "Mit Spotify anmelden" })),
		).toBeVisible();
		await page.unroute("**/api/history/preview");
		await page.waitForTimeout(1_000);
		expect(await silent(page)).toBe(true);
		expect(seen.media).toHaveLength(mediaBefore2);
		expect(transport(await callsSince(since))).toEqual([]);
	});

	test("F: named key, keyboard focus after the rating keys, ≥44 px, small screens and large text", async ({
		page,
	}) => {
		acknowledgeRelease(page.context());
		await instrument(page);
		await signIn(page);
		await page.goto("/verlauf");
		const a = rowAt(page, rows.ready[0]!);
		await expect(a).toBeVisible();
		// The ratings keep their one status line; the sample speaks in its own region.
		await expect(page.locator(".sr-only[role=status]")).toHaveCount(1);
		await expect(page.locator(".hist-preview__said[aria-live=polite]")).toHaveCount(1);
		await expect(key(a)).toHaveAccessibleName(
			`Hörprobe – „${rows.ready[0]!.name}“ von ${rows.ready[0]!.artists}`,
		);
		// Favorit → Nie wieder → Hörprobe, as before plus one.
		await a.getByRole("button", { name: "Favorit", exact: true }).focus();
		await page.keyboard.press("Tab");
		await expect(a.getByRole("button", { name: "Nie wieder", exact: true })).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(key(a)).toBeFocused();
		const outline = await key(a).evaluate((el) => getComputedStyle(el).outlineStyle);
		expect(outline).not.toBe("none");
		await page.screenshot({ path: `${SHOTS}/F1-keyboard-focus.png` });
		for (const [w, font] of [
			[320, "100%"],
			[320, "200%"],
			[390, "150%"],
		] as const) {
			await page.setViewportSize({ width: w, height: 800 });
			await page.evaluate((f) => {
				document.documentElement.style.fontSize = f;
			}, font);
			await a.scrollIntoViewIfNeeded();
			const box = (await key(a).boundingBox())!;
			expect(box.height).toBeGreaterThanOrEqual(44);
			expect(box.width).toBeGreaterThanOrEqual(44);
			expect(box.x + box.width).toBeLessThanOrEqual(w);
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > window.innerWidth,
			);
			expect(overflow).toBe(false);
			await page.screenshot({ path: `${SHOTS}/F2-${w}px-font${font.replace("%", "")}.png` });
		}
	});

	test("G: only signed-in, only a Verlauf row, no URL proxy; the page may load media only from Deezer's sample host", async ({
		page,
		playwright,
	}) => {
		acknowledgeRelease(page.context());
		await signIn(page);
		const csp = (await page.request.get("/verlauf")).headers()["content-security-policy"] ?? "";
		expect(csp).toContain("media-src https://cdnt-preview.dzcdn.net;");
		expect(csp).not.toMatch(/media-src[^;]*(\*|https:(?!\/\/cdnt))/);
		const anon = await playwright.request.newContext({ baseURL: "http://127.0.0.1:8787" });
		const r0 = rows.ready[0]!;
		expect(
			(
				await anon.post("/api/history/preview", {
					headers: { "x-ts": "1" },
					data: { trackId: r0.id, playedAt: r0.playedAt },
				})
			).status(),
		).toBe(401);
		await anon.dispose();
		expect(
			(
				await page.request.post("/api/history/preview", {
					data: { trackId: r0.id, playedAt: r0.playedAt },
				})
			).status(),
		).toBe(403);
		expect(
			(
				await page.request.post("/api/history/preview", {
					headers: { "x-ts": "1" },
					data: { trackId: r0.id, playedAt: r0.playedAt + 1 },
				})
			).status(),
		).toBe(404);
		expect(
			(
				await page.request.post("/api/history/preview", {
					headers: { "x-ts": "1" },
					data: { trackId: "https://evil.example/a.mp3", playedAt: r0.playedAt },
				})
			).status(),
		).toBe(400);
		expect(
			(
				await page.request.post("/api/history/preview", {
					headers: { "x-ts": "1" },
					data: { url: "https://evil.example/a.mp3" },
				})
			).status(),
		).toBe(400);
		// The browser itself refuses media from anywhere else.
		await page.goto("/verlauf");
		const blocked = await page.evaluate(
			() =>
				new Promise<string>((resolve) => {
					document.addEventListener(
						"securitypolicyviolation",
						(e) => resolve(`${e.effectiveDirective} ${e.blockedURI}`),
						{ once: true },
					);
					void new Audio("https://evil.example/a.mp3").play().catch(() => {});
					setTimeout(() => resolve("no violation"), 3_000);
				}),
		);
		expect(blocked).toBe("media-src https://evil.example/a.mp3");
	});
});
