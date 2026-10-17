/**
 * The import cutoff (JH06), through the real file picker and parser against the
 * real Worker and the unchanged Spotify stand-in: only plays before the moment
 * fixed at the first sign-in (`history.liveSince`) shape the import. Plays at
 * that moment and later, a millisecond, a second or days later, and also songs
 * true-shuffle never saw live, stay out of the weighting and the Hörprofil,
 * without the page claiming that true-shuffle counted them itself. All data is
 * synthetic; nothing here signs in to the real Spotify.
 */

import { expect, type Page, test } from "@playwright/test";

const BERLIN = "Europe/Berlin";
const dateFmt = new Intl.DateTimeFormat("de-DE", {
	day: "numeric",
	month: "long",
	year: "numeric",
	timeZone: BERLIN,
});
const clockFmt = new Intl.DateTimeFormat("de-DE", {
	hour: "2-digit",
	minute: "2-digit",
	timeZone: BERLIN,
});
/** The cutoff as the page names it: a moment, not a day. */
const moment = (at: number) => `${dateFmt.format(at)} um ${clockFmt.format(at)} Uhr`;

const DAY = 86_400_000;
/** Claims the import page must never make about plays after the cutoff. */
const LIVE_CLAIMS = [
	"selbst gezählt",
	"selbst mitgezählt",
	"nichts zählt doppelt",
	"Es gibt nichts zu übernehmen",
];

/** Signs in through the stand-in; on a fresh state, one cassette ends the onboarding. */
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
	await expect(home).toBeVisible({ timeout: 60_000 });
}

interface History {
	importedTracks: number;
	importedAt: number | null;
	liveSince: number | null;
	effectiveTracks?: number;
	enabled?: boolean;
	rules?: number;
}

async function history(page: Page): Promise<History> {
	const st = (await (await page.request.get("/api/state")).json()) as { history: History };
	return st.history;
}

async function cutoff(page: Page): Promise<number> {
	const at = (await history(page)).liveSince;
	expect(at, "liveSince after sign-in").not.toBeNull();
	return at!;
}

/** A 22-character synthetic Spotify track id that no stand-in playlist holds. */
const id = (tag: string) => `JH06${tag}`.padEnd(22, "0");

type Entry = Record<string, unknown>;
const play = (at: number, tag: string, ms = 200_000): Entry => ({
	ts: new Date(at).toISOString(),
	ms_played: ms,
	spotify_track_uri: `spotify:track:${id(tag)}`,
	master_metadata_track_name: `Synthetisch ${tag}`,
	master_metadata_album_artist_name: "Stichtag-Kapelle",
	master_metadata_album_album_name: "Synthetische Platte",
	reason_start: "trackdone",
	reason_end: "trackdone",
});
const byTime = (xs: Entry[]) =>
	[...xs].sort((a, b) => Date.parse(String(a.ts)) - Date.parse(String(b.ts)));

async function pick(page: Page, files: { name: string; entries: Entry[] | string }[]) {
	await page.locator('input[type="file"]').setInputFiles(
		files.map((f) => ({
			name: f.name,
			mimeType: "application/json",
			buffer: Buffer.from(typeof f.entries === "string" ? f.entries : JSON.stringify(f.entries)),
		})),
	);
}

/** Every import and Hörprofil request body the page sends, in order. */
function capture(page: Page) {
	const sent: { url: string; body: Record<string, unknown> | null }[] = [];
	page.on("request", (r) => {
		if (!/\/api\/history\/(begin|import|listens)$/.test(new URL(r.url()).pathname)) return;
		sent.push({ url: new URL(r.url()).pathname, body: r.postDataJSON() ?? null });
	});
	return {
		sent,
		rows: () =>
			sent.filter((s) => s.url.endsWith("/import")).flatMap((s) => s.body!.rows as unknown[][]),
		listens: () => {
			const blocks = sent.filter((s) => s.url.endsWith("/listens")).map((s) => s.body!);
			return {
				tracks: blocks.filter((b) => b.kind === "tracks").flatMap((b) => b.data as unknown[][]),
				rows: blocks.filter((b) => b.kind === "rows").flatMap((b) => b.data as unknown[][]),
			};
		},
		clear: () => {
			sent.length = 0;
		},
	};
}

async function takeOver(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Übernehmen" }).click();
	await expect(
		page.getByRole("heading", { name: "Übernommen. Das ist jetzt anders:" }),
	).toBeVisible();
	await expect(page.getByRole("link", { name: "Dein Hörprofil ansehen" })).toBeVisible();
}

const hint = (page: Page) => page.locator(".step .hint", { hasText: "Import-Gewichtung" });

async function noLiveClaim(page: Page): Promise<void> {
	const text = await page.locator(".page").innerText();
	for (const claim of LIVE_CLAIMS) expect(text, `claim "${claim}"`).not.toContain(claim);
}

test.describe("Import cutoff at the first sign-in", () => {
	test("plays before the cutoff count as before; at, after, the same day and never-live songs stay out", async ({
		page,
	}) => {
		await signIn(page);
		const L = await cutoff(page);
		await page.goto("/import");
		await expect(hint(page)).toHaveText(
			`Für die Import-Gewichtung zählen nur Wiedergaben vor dem ${moment(L)}. Diesen Zeitpunkt hat true-shuffle bei deiner ersten Anmeldung festgelegt. Spätere Wiedergaben aus deinen Dateien bleiben unberücksichtigt; true-shuffle hat sie möglicherweise nicht selbst erfasst.`,
		);
		await noLiveClaim(page);
		const net = capture(page);

		// Before the cutoff: an old favourite days back and two plays a minute and a second before.
		const before = [
			...Array.from({ length: 5 }, (_, i) => play(L - (400 - i) * DAY, "A")),
			play(L - 60_000, "B"),
			play(L - 1_000, "B"),
		];
		// At the cutoff and after: a second, minutes and days later; the old
		// favourite again, and songs true-shuffle never saw live.
		const later = [
			play(L, "C"),
			play(L + 1_000, "D"),
			play(L + 60_000, "D"),
			play(L + 120_000, "A"),
			play(L + 2 * DAY, "E"),
			play(L + 30 * DAY, "E"),
			play(L + 3 * DAY, "A"),
		];
		const live = (await (await page.request.get("/api/history?limit=200")).json()) as {
			id: string;
		}[];
		for (const tag of ["C", "D", "E"])
			expect(
				live.some((e) => e.id === id(tag)),
				`${tag} never seen live`,
			).toBe(false);

		// The before-only file sets what the import changes and what it sends.
		await pick(page, [{ name: "Streaming_History_Audio_vorher.json", entries: before }]);
		const result = page.locator(".import-result");
		await expect(result).toBeVisible();
		const shownBefore = await result.innerText();
		const profileBefore = await page.locator(".step .hint", { hasText: "Hörprofil:" }).innerText();
		await takeOver(page);
		const rowsBefore = net.rows();
		const listensBefore = net.listens();
		expect(rowsBefore.map((r) => r[0]).sort()).toEqual([id("A"), id("B")]);
		expect((await history(page)).importedTracks).toBe(2);

		// The same plays with everything from the cutoff on in the same file.
		net.clear();
		await page.goto("/import");
		await pick(page, [
			{ name: "Streaming_History_Audio_gemischt.json", entries: byTime([...before, ...later]) },
		]);
		await expect(result).toBeVisible();
		expect(await result.innerText()).toBe(shownBefore);
		await takeOver(page);
		// The weighting: exactly the rows of before, nothing of C, D, E or A's later plays.
		expect(net.rows()).toEqual(rowsBefore);
		// The Hörprofil: exactly the song list and plays of before, nothing from the cutoff on.
		const listens = net.listens();
		expect(listensBefore.tracks.map((t) => t[0])).toEqual([id("A"), id("B")]);
		expect(listensBefore.rows).toHaveLength(7);
		expect(listens).toEqual(listensBefore);
		for (const tag of ["C", "D", "E"])
			expect(
				listens.tracks.map((t) => t[0]),
				`${tag} in the Hörprofil`,
			).not.toContain(id(tag));
		for (const r of listens.rows)
			expect(Number(r[0]) * 1000, "Hörprofil play time").toBeLessThan(L);
		const h = await history(page);
		expect(h.importedTracks).toBe(2);
		expect(h.liveSince).toBe(L);
		expect(profileBefore).toMatch(/^Hörprofil: 7 Mal gehört/);
	});

	test("files from after the cutoff only are explained, never uploaded, and keep the import in force", async ({
		page,
	}) => {
		await signIn(page);
		const L = await cutoff(page);
		await page.goto("/import");
		await pick(page, [
			{
				name: "Streaming_History_Audio_bestand.json",
				entries: Array.from({ length: 4 }, (_, i) => play(L - (90 - i) * DAY, "F")),
			},
		]);
		await takeOver(page);
		const kept = await history(page);
		expect(kept.importedTracks).toBeGreaterThan(0);

		await page.goto("/import");
		const net = capture(page);
		// Later only: a second after, the same day, days later; songs never seen live.
		await pick(page, [
			{
				name: "Streaming_History_Audio_2026.json",
				entries: [play(L + 1_000, "G"), play(L + 90_000, "G"), play(L + 2 * DAY, "H")],
			},
			{
				name: "Streaming_History_Audio_2027.json",
				entries: [play(L + 40 * DAY, "H"), play(L + 41 * DAY, "F")],
			},
		]);
		const alert = page.getByRole("alert");
		await expect(alert).toHaveText(
			`Alle Wiedergaben in diesen Dateien sind vom ${moment(L)} oder später. Sie liegen außerhalb der aktuellen Import-Gewichtung und werden deshalb nicht übernommen, auch nicht ins Hörprofil. true-shuffle hat sie möglicherweise nicht selbst erfasst.`,
		);
		await noLiveClaim(page);
		await expect(page.getByRole("button", { name: "Übernehmen" })).toHaveCount(0);
		await expect(page.locator(".notice").first()).toContainText(
			`Gespeichert sind ${kept.importedTracks === 1 ? "1 Song" : `${kept.importedTracks} Songs`} aus deinem Spotify-Verlauf`,
		);
		expect(net.sent).toEqual([]);
		expect(await history(page)).toEqual(kept);
	});

	test("a file that cannot be read or an upload that fails keeps the import in force", async ({
		page,
	}) => {
		await signIn(page);
		const L = await cutoff(page);
		await page.goto("/import");
		await pick(page, [
			{
				name: "Streaming_History_Audio_bestand.json",
				entries: Array.from({ length: 3 }, (_, i) => play(L - (30 - i) * DAY, "J")),
			},
		]);
		await takeOver(page);
		const kept = await history(page);
		expect(kept.importedTracks).toBeGreaterThan(0);

		// Unreadable: nothing is sent, nothing changes.
		await page.goto("/import");
		const net = capture(page);
		await pick(page, [{ name: "Streaming_History_Audio_kaputt.json", entries: "[{ kaputt" }]);
		await expect(page.getByRole("alert")).toHaveText(
			"„Streaming_History_Audio_kaputt.json“ konnte nicht gelesen werden.",
		);
		await expect(page.getByRole("button", { name: "Übernehmen" })).toHaveCount(0);
		expect(net.sent).toEqual([]);
		expect(await history(page)).toEqual(kept);

		// The server refuses the upload of a file with plays before and after the cutoff.
		let refused = 0;
		await page.route(/\/api\/history\/import$/, (route) => {
			refused++;
			return route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ error: { code: "busy", message: "Gerade nicht erreichbar." } }),
			});
		});
		await pick(page, [
			{
				name: "Streaming_History_Audio_neu.json",
				entries: [
					play(L - 5 * DAY, "K"),
					play(L - 2_000, "K"),
					play(L + 1_000, "M"),
					play(L + DAY, "M"),
				],
			},
		]);
		await page.getByRole("button", { name: "Übernehmen" }).click();
		await expect(page.getByRole("alert")).toHaveText("Gerade nicht erreichbar.");
		await expect(page.getByRole("button", { name: "Übernehmen" })).toBeVisible();
		expect(refused).toBe(1);
		expect(net.sent.filter((s) => s.url.endsWith("/listens"))).toEqual([]);
		expect(await history(page)).toEqual(kept);
	});

	test("a file from the cutoff moment on, the first play exactly at it, is explained as later only", async ({
		page,
	}) => {
		await signIn(page);
		const L = await cutoff(page);
		await page.goto("/import");
		const net = capture(page);
		await pick(page, [
			{
				name: "Streaming_History_Audio_ab-stichtag.json",
				entries: [play(L, "N"), play(L + 60_000, "N"), play(L + 5 * DAY, "P")],
			},
		]);
		await expect(page.getByRole("alert")).toHaveText(
			`Alle Wiedergaben in diesen Dateien sind vom ${moment(L)} oder später. Sie liegen außerhalb der aktuellen Import-Gewichtung und werden deshalb nicht übernommen, auch nicht ins Hörprofil. true-shuffle hat sie möglicherweise nicht selbst erfasst.`,
		);
		await expect(page.getByRole("button", { name: "Übernehmen" })).toHaveCount(0);
		await expect(page.locator(".step .hint", { hasText: "Hörprofil:" })).toHaveCount(0);
		expect(net.sent).toEqual([]);
		expect((await history(page)).liveSince).toBe(L);
	});

	test("a play exactly at the cutoff stays out of the Hörprofil as it stays out of the weighting", async ({
		page,
	}) => {
		await signIn(page);
		const L = await cutoff(page);
		await page.goto("/import");
		const net = capture(page);
		await pick(page, [
			{
				name: "Streaming_History_Audio_grenze.json",
				entries: [play(L - 10 * DAY, "Q"), play(L - 1_000, "Q"), play(L, "R"), play(L + 1, "S")],
			},
		]);
		await expect(page.locator(".step .hint", { hasText: "Hörprofil:" })).toHaveText(
			/^Hörprofil: 2 Mal gehört,/,
		);
		await takeOver(page);
		expect(net.rows().map((r) => r[0])).toEqual([id("Q")]);
		const listens = net.listens();
		expect(listens.tracks).toEqual([
			[id("Q"), "Synthetisch Q", "Stichtag-Kapelle", "Synthetische Platte"],
		]);
		expect(listens.rows.map((r) => [r[0], r[1], r[2]])).toEqual([
			[Math.floor((L - 10 * DAY) / 1000), 0, 200_000],
			[Math.floor((L - 1_000) / 1000), 0, 200_000],
		]);
		const h = await history(page);
		expect(h.importedTracks).toBe(1);
		expect(h.liveSince).toBe(L);
	});
});
