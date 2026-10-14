/**
 * Ratings right in the Verlauf (option "Bewertungen im Verlauf direkt
 * anzeigen", see docs/HISTORY_RATINGS.md): off by default, per device and
 * account, the old Verlauf unchanged when off; with it on, every row rates —
 * honestly through slow, refused and lost answers, and takes back exactly.
 * The real Worker against the Spotify stand-in (e2e/fake-server.ts); plays
 * are made by listening in the stand-in, never written into storage. Requests
 * are only held, refused (503), cut (offline) or passed on — no answer is
 * made up.
 */

import {
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	type Request,
	type Route,
	test,
} from "@playwright/test";
import type { HistoryEntry } from "../src/shared/api";

const FAKE = "http://127.0.0.1:8788/__control";

interface FakeStatus {
	current: string | null;
	playing: boolean;
	calls: number;
	recent: number;
}

async function fake(action: string): Promise<FakeStatus> {
	const res = await fetch(`${FAKE}/${action}`);
	return (await res.json()) as FakeStatus;
}

const post = (page: Page, url: string, data: unknown = {}) =>
	page.request.post(url, { headers: { "x-ts": "1" }, data });

/** Signs in; on a fresh listener, one station is set up first. */
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

/** Lets the Worker read Spotify's recently played until the Verlauf grew past `n` rows. */
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

async function account(page: Page): Promise<string> {
	return ((await (await page.request.get("/api/state")).json()) as { profile: { id: string } })
		.profile.id;
}

const thumbOf = async (page: Page, id: string) =>
	(await history(page)).find((e) => e.id === id)?.thumb;

/** Every request the page sends that writes a rating, or fetches audio. */
function watch(page: Page) {
	const writes: string[] = [];
	const audio: string[] = [];
	page.on("request", (r: Request) => {
		const u = new URL(r.url());
		if (
			r.method() !== "GET" &&
			(u.pathname.startsWith("/api/history/ratings") ||
				/^\/api\/tracks\/[^/]+\/thumb$/.test(u.pathname))
		)
			writes.push(`${r.method()} ${u.pathname}`);
		if (r.resourceType() === "media" || /preview|\.mp3|\.m4a|audio/i.test(u.href))
			audio.push(u.href);
	});
	return { writes, audio };
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rows = (page: Page) => page.locator(".hist-row");
const rowsOf = (page: Page, name: string) =>
	rows(page).filter({
		has: page.locator(".hist-row__title", { hasText: new RegExp(`^${literal(name)}$`) }),
	});
const fav = (row: Locator) => row.getByRole("button", { name: "Favorit", exact: true });
const never = (row: Locator) => row.getByRole("button", { name: "Nie wieder", exact: true });
const undo = (row: Locator) => row.getByRole("button", { name: /^Rückgängig/ });
const line = (row: Locator) => row.locator(".hist-rate__state");
const optionSwitch = (page: Page) =>
	page.getByRole("switch", { name: /Bewertungen im Verlauf direkt anzeigen/ });

/** The songs the tests act on, from the plays made in the first test. */
const songs = {
	twice: { id: "", name: "" }, // heard on the station and twice outside it
	guest: { id: "", name: "" },
	plain: [] as { id: string; name: string }[],
};

async function setOption(page: Page, on: boolean): Promise<void> {
	await page.goto("/mehr");
	const sw = optionSwitch(page);
	if ((await sw.isChecked()) !== on) await sw.click();
	await expect(sw).toBeChecked({ checked: on });
}

/** Plays `id` in the stand-in (from `context`, if given) until the Worker has looked and sees it playing. */
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

/** A song's rating write number, read from the Worker. */
async function currentSeq(page: Page, id: string): Promise<number> {
	return (await history(page)).find((e) => e.id === id)?.rated ?? 0;
}

test.describe.configure({ mode: "serial" });

test.describe("ratings right in the Verlauf", () => {
	test("plays heard in the stand-in fill the Verlauf: a station, outside, as a guest, more than a page", async ({
		page,
	}) => {
		test.setTimeout(900_000);
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
		// Four hours of the station, read in parts: well over one page of 60.
		for (let i = 0; i < 4; i++) {
			const before = all.length;
			await fake("advance?ms=3600000");
			all = await heard(page, before + 10);
		}
		expect(all.length).toBeGreaterThan(60);
		const counts = new Map<string, number>();
		for (const e of all) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
		const unique = all.filter((e) => counts.get(e.name) === 1 && e.stationName);
		// Outside any station, twice: the same song in three rows. Played from an
		// album in Spotify (a context no station has): without one, the Worker
		// rightly counts a song for the one station deck holding it (e2e-hr-9/10).
		// Each play is seen by the Worker as it runs and ends now.
		const twice = unique[0]!;
		for (let i = 0; i < 2; i++) {
			await playing(page, twice.id, "spotify:album:E2EOUTSIDEALBUM0000000");
			console.log("outside-seed finish", Date.now(), JSON.stringify(await fake("finish")));
			all = await heard(page, all.length);
		}
		// As a guest: listed, and counting for nothing.
		const guest = unique[1]!;
		expect((await post(page, "/api/guest", { on: true, hours: 1 })).ok()).toBe(true);
		await playing(page, guest.id);
		// The stand-in dates a play by when it ends: the song ends now, inside
		// the guest time (an earlier fixture advanced past it and dated the play
		// before guest mode came on — rightly the owner's, see e2e-hr-1…4 logs).
		const ended = Date.now();
		console.log("guest-seed finish", ended, JSON.stringify(await fake("finish")));
		await expect
			.poll(
				async () => {
					await page.request.get("/api/state?live=1&refresh=1");
					const mine = (await history(page)).filter((e) => e.id === guest.id);
					console.log(
						"guest-seed look",
						Date.now(),
						JSON.stringify(mine.map((e) => [e.ignored, e.playedAt])),
					);
					return mine.some((e) => e.ignored);
				},
				{ timeout: 60_000, intervals: [6_000] },
			)
			.toBe(true);
		expect((await post(page, "/api/guest", { on: false })).ok()).toBe(true);
		expect((await history(page)).some((e) => e.id === guest.id && e.ignored)).toBe(true);
		all = await history(page);
		expect(all.filter((e) => e.id === twice.id)).toHaveLength(3);
		expect(all.filter((e) => e.id === twice.id && !e.stationName)).toHaveLength(2);
		songs.twice = { id: twice.id, name: twice.name };
		songs.guest = { id: guest.id, name: guest.name };
		songs.plain = unique.slice(2, 12).map((e) => ({ id: e.id, name: e.name }));
		await fake("pause");
	});

	test("off unless switched on, per device and account; switching and viewing write nothing", async ({
		page,
		browser,
	}) => {
		await signIn(page);
		const seen = watch(page);
		const me = await account(page);
		await page.goto("/verlauf");
		await expect(rows(page).first()).toBeVisible();
		// Off: the Verlauf as before — the whole row opens the rating sheet, no keys in the rows.
		const total = await rows(page).count();
		await expect(page.getByRole("button", { name: / bewerten$/ })).toHaveCount(total);
		await expect(rows(page).getByRole("button", { name: "Favorit", exact: true })).toHaveCount(0);
		// Unreadable or foreign values mean off.
		for (const [key, value] of [
			[`ts-history-ratings:${me}`, "1"],
			[`ts-history-ratings:${me}`, "true"],
			["ts-history-ratings:someone-else", "on"],
			["ts-history-ratings:", "on"],
		] as const) {
			await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value] as [string, string]);
			await page.reload();
			await expect(rows(page).first()).toBeVisible();
			await expect(rows(page).getByRole("button", { name: "Favorit", exact: true })).toHaveCount(0);
			await page.evaluate((k) => localStorage.removeItem(k), key);
		}
		// Switched on under Mehr → App: kept for this account on this device, over a reload.
		await page.goto("/mehr");
		await expect(optionSwitch(page)).not.toBeChecked();
		await optionSwitch(page).click();
		await expect(optionSwitch(page)).toBeChecked();
		expect(await page.evaluate((k) => localStorage.getItem(k), `ts-history-ratings:${me}`)).toBe(
			"on",
		);
		await page.reload();
		await expect(optionSwitch(page)).toBeChecked();
		await page.goto("/verlauf");
		await expect(rows(page).first()).toBeVisible();
		await expect(rows(page).getByRole("button", { name: "Favorit", exact: true })).toHaveCount(
			total,
		);
		await expect(page.getByRole("button", { name: / bewerten$/ })).toHaveCount(0);
		// Another device (a fresh browser) still has it off.
		const other: BrowserContext = await browser.newContext();
		const p2 = await other.newPage();
		await signIn(p2);
		await p2.goto("/verlauf");
		await expect(rowsOf(p2, songs.plain[0]!.name).first()).toBeVisible();
		await expect(rows(p2).getByRole("button", { name: "Favorit", exact: true })).toHaveCount(0);
		await other.close();
		// Off again: the old Verlauf, and still nothing written.
		await setOption(page, false);
		expect(
			await page.evaluate((k) => localStorage.getItem(k), `ts-history-ratings:${me}`),
		).toBeNull();
		await page.goto("/verlauf");
		await expect(page.getByRole("button", { name: / bewerten$/ })).toHaveCount(total);
		expect(seen.writes).toEqual([]);
		expect(seen.audio).toEqual([]);
	});

	test("a browser that keeps no settings shows the old Verlauf and says the switch is not kept", async ({
		browser,
	}) => {
		const ctx = await browser.newContext();
		await ctx.addInitScript(() => {
			const fail = () => {
				throw new DOMException("blocked", "SecurityError");
			};
			Storage.prototype.getItem = fail;
			Storage.prototype.setItem = fail;
			Storage.prototype.removeItem = fail;
		});
		const page = await ctx.newPage();
		await signIn(page);
		await page.goto("/verlauf");
		await expect(rows(page).first()).toBeVisible();
		await expect(rows(page).getByRole("button", { name: "Favorit", exact: true })).toHaveCount(0);
		await page.goto("/mehr");
		await optionSwitch(page).click();
		await expect(page.getByText(/speichert die Einstellung nicht/)).toBeVisible();
		await ctx.close();
	});

	test("every row rates: older pages, outside, guest, every occurrence alike; ratings stay when switched off", async ({
		page,
	}) => {
		await signIn(page);
		const seen = watch(page);
		await setOption(page, true);
		await page.goto("/verlauf");
		await expect(rows(page).first()).toBeVisible();
		const first = await rows(page).count();
		await expect(rows(page).getByRole("button", { name: "Favorit", exact: true })).toHaveCount(
			first,
		);
		await expect(rows(page).getByRole("button", { name: "Nie wieder", exact: true })).toHaveCount(
			first,
		);
		await page.getByRole("button", { name: "Ältere laden" }).click();
		await expect.poll(() => rows(page).count()).toBeGreaterThan(first);
		const total = await rows(page).count();
		await expect(rows(page).getByRole("button", { name: "Favorit", exact: true })).toHaveCount(
			total,
		);
		await expect(rows(page).getByRole("button", { name: "Nie wieder", exact: true })).toHaveCount(
			total,
		);
		// Outside true-shuffle and as a guest: the same keys; rating a guest play leaves it a guest play.
		const outside = rowsOf(page, songs.twice.name).filter({
			hasText: "außerhalb von true-shuffle",
		});
		await expect(outside).toHaveCount(2);
		const guest = rowsOf(page, songs.guest.name).filter({ hasText: "Gast" });
		await expect(guest).toHaveCount(1);
		await fav(guest).click();
		await expect(line(guest)).toHaveText(/^Gespeichert: Favorit\./);
		expect((await history(page)).find((e) => e.id === songs.guest.id && e.ignored)?.thumb).toBe(1);
		// Three rows of one song: one rating, shown in all of them.
		const all = rowsOf(page, songs.twice.name);
		await expect(all).toHaveCount(3);
		await never(all.nth(1)).click();
		for (let i = 0; i < 3; i++) {
			await expect(never(all.nth(i))).toHaveAttribute("aria-pressed", "true");
			await expect(fav(all.nth(i))).toHaveAttribute("aria-pressed", "false");
		}
		await fav(all.nth(2)).click();
		for (let i = 0; i < 3; i++) {
			await expect(fav(all.nth(i))).toHaveAttribute("aria-pressed", "true");
			await expect(line(all.nth(i))).toHaveText(/^Gespeichert: Favorit\./);
		}
		expect(await thumbOf(page, songs.twice.id)).toBe(1);
		// Tapping the set one again clears it.
		await fav(all.nth(0)).click();
		await expect(fav(all.nth(0))).toHaveAttribute("aria-pressed", "false");
		await expect(line(all.nth(0))).toHaveText(/^Gespeichert: keine Bewertung\./);
		expect(await thumbOf(page, songs.twice.id)).toBe(0);
		await fav(all.nth(0)).click();
		await expect(line(all.nth(0))).toHaveText(/^Gespeichert: Favorit\./);
		// Switched off: the old Verlauf shows the stored ratings; nothing was lost or written by it.
		const writes = seen.writes.length;
		await setOption(page, false);
		await page.goto("/verlauf");
		await expect(
			rowsOf(page, songs.twice.name).first().getByRole("img", { name: "Favorit" }),
		).toBeVisible();
		expect(await thumbOf(page, songs.twice.id)).toBe(1);
		expect(await thumbOf(page, songs.guest.id)).toBe(1);
		expect(seen.writes.length).toBe(writes);
		expect(seen.audio).toEqual([]);
	});

	test("slow, double, refused, lost: one write at a time, never a false 'stored', never twice", async ({
		page,
		context,
	}) => {
		await signIn(page);
		await setOption(page, true);
		await page.goto("/verlauf");
		const song = songs.plain[0]!;
		const row = rowsOf(page, song.name).first();
		await expect(fav(row)).toBeVisible();
		const posts: string[] = [];
		page.on("request", (r) => {
			if (r.method() === "POST" && new URL(r.url()).pathname === "/api/history/ratings")
				posts.push(r.postData() ?? "");
		});
		const hold = () => {
			let open = () => {};
			const shut = new Promise<void>((r) => {
				open = r;
			});
			return { open, shut };
		};

		// Slow: held before the Worker. Double taps, keyboard and the other key do nothing meanwhile.
		const gate = hold();
		const slow = async (route: Route) => {
			if (route.request().method() !== "POST") return route.fallback();
			await gate.shut;
			await route.fallback();
		};
		await page.route("**/api/history/ratings", slow);
		await fav(row).click();
		await expect(line(row)).toHaveText(/^Wird gespeichert: Favorit/);
		await expect(fav(row)).toHaveAttribute("aria-disabled", "true");
		// A real double tap on the greyed key while it saves (forced: Playwright would otherwise wait
		// for aria-disabled to clear — e2e-hr-5 waited 15 s until the page's own timeout, then tapped).
		await fav(row).dblclick({ force: true });
		await never(row).focus();
		await page.keyboard.press("Enter");
		await page.keyboard.press("Space");
		await expect.poll(() => posts.length).toBe(1);
		gate.open();
		await expect(line(row)).toHaveText(/^Gespeichert: Favorit\./);
		await expect(fav(row)).toHaveAttribute("aria-pressed", "true");
		expect(posts).toHaveLength(1);
		await page.unroute("**/api/history/ratings", slow);
		// Focus stayed where it was (the key pressed during the wait).
		await expect(never(row)).toBeFocused();

		// Refused (503) or cut (offline) before the Worker: provably not stored, said so; sent again, stored once.
		for (const outcome of ["503", "offline"] as const) {
			const before = await currentSeq(page, song.id);
			const refuse = async (route: Route) => {
				if (route.request().method() !== "POST") return route.fallback();
				return outcome === "offline"
					? route.abort("internetdisconnected")
					: route.fulfill({
							status: 503,
							contentType: "application/json",
							body: JSON.stringify({
								error: { code: "busy", message: "Gerade nicht erreichbar." },
							}),
						});
			};
			await page.route("**/api/history/ratings", refuse);
			await never(row).click();
			await expect(line(row)).toHaveText(/^Nicht gespeichert: /);
			await expect(fav(row)).toHaveAttribute("aria-pressed", "true");
			expect(await currentSeq(page, song.id)).toBe(before);
			await page.unroute("**/api/history/ratings", refuse);
			const sent = posts.length;
			await row.getByRole("button", { name: "Nochmal speichern" }).click();
			await expect(line(row)).toHaveText(/^Gespeichert: Nie wieder\./);
			expect(posts.length).toBe(sent + 1);
			// The same decision again: the same id.
			expect(JSON.parse(posts.at(-1)!).actionId).toBe(JSON.parse(posts.at(-2)!).actionId);
			expect(await currentSeq(page, song.id)).toBe(before + 1);
			await fav(row).click();
			await expect(line(row)).toHaveText(/^Gespeichert: Favorit\./);
		}

		// Lost answer: stored by the Worker, its answer cut. The receipt says stored; no second write.
		const lose = async (route: Route) => {
			if (route.request().method() !== "POST") return route.fallback();
			await route.fetch();
			await route.abort("internetdisconnected");
		};
		{
			const before = await currentSeq(page, song.id);
			await page.route("**/api/history/ratings", lose);
			const sent = posts.length;
			await never(row).click();
			await expect(line(row)).toHaveText(/^Gespeichert: Nie wieder\./);
			expect(posts.length).toBe(sent + 1);
			expect(await currentSeq(page, song.id)).toBe(before + 1);
			await page.unroute("**/api/history/ratings", lose);
		}

		// Lost answer, and the receipt cannot be read either: unclear, said so; looking again finds it.
		{
			const before = await currentSeq(page, song.id);
			const blind = (route: Route) =>
				route.request().method() === "GET" ? route.abort("internetdisconnected") : route.fallback();
			await page.route("**/api/history/ratings", lose);
			await page.route("**/api/history/ratings/*", blind);
			const sent = posts.length;
			await fav(row).click();
			await expect(line(row)).toHaveText(/^Unklar, ob gespeichert: /);
			await expect(fav(row)).toHaveAttribute("aria-pressed", "false");
			await page.unroute("**/api/history/ratings/*", blind);
			await page.unroute("**/api/history/ratings", lose);
			await row.getByRole("button", { name: "Nachsehen" }).click();
			await expect(line(row)).toHaveText(/^Gespeichert: Favorit\./);
			expect(posts.length).toBe(sent + 1);
			expect(await currentSeq(page, song.id)).toBe(before + 1);
		}

		// No answer in time (held beyond the page's 15 s): the request may still arrive — unclear, not
		// "not stored", however often it is looked at, and when sending it again is refused (synthetic
		// 429 at the edge, HUI-RT-002). It arrives later: found, stored once.
		{
			const before = await currentSeq(page, song.id);
			const late = hold();
			let attempts = 0;
			const stall = async (route: Route) => {
				if (route.request().method() !== "POST") return route.fallback();
				if (++attempts > 1)
					return route.fulfill({
						status: 429,
						contentType: "application/json",
						body: JSON.stringify({
							error: { code: "rate_limited", message: "Synthetic retry refused." },
						}),
					});
				await late.shut;
				await route.fetch().catch(() => {}); // the original reaches the Worker only now
				await route.abort("timedout").catch(() => {});
			};
			await page.route("**/api/history/ratings", stall);
			const sent = posts.length;
			await never(row).click();
			await expect(line(row)).toHaveText(/^Unklar, ob gespeichert: Bisher nicht angekommen/, {
				timeout: 30_000,
			});
			expect(posts.length).toBe(sent + 1);
			// Looking again, twice, while it is still on its way: still unclear, nothing stored, nothing sent.
			for (let i = 0; i < 2; i++) {
				const reads = page.waitForResponse(
					(r) => r.request().method() === "GET" && /\/api\/history\/ratings\/h/.test(r.url()),
				);
				await row.getByRole("button", { name: "Nachsehen" }).click();
				await reads;
				await expect(line(row)).toHaveText(/^Unklar, ob gespeichert: Bisher nicht angekommen/);
				await expect(line(row)).not.toHaveText(/Nicht gespeichert/);
				expect(await currentSeq(page, song.id)).toBe(before);
			}
			// Sent again on purpose, and that attempt refused: the first may still arrive — unclear,
			// said so also aloud, „Nachsehen“ kept; the same decision (same id).
			await row.getByRole("button", { name: "Nochmal speichern" }).click();
			await expect(line(row)).toHaveText(
				/^Unklar, ob gespeichert: Dieser Versuch wurde abgelehnt \(Synthetic retry refused\.\); der frühere kann aber noch ankommen\./,
			);
			await expect(page.locator(".sr-only[role=status]")).toHaveText(/unklar, ob gespeichert\./);
			await expect(row.getByRole("button", { name: "Nachsehen" })).toBeVisible();
			expect(posts.length).toBe(sent + 2);
			expect(JSON.parse(posts.at(-1)!).actionId).toBe(JSON.parse(posts.at(-2)!).actionId);
			expect(await currentSeq(page, song.id)).toBe(before);
			late.open();
			await expect.poll(() => currentSeq(page, song.id)).toBe(before + 1);
			await page.unroute("**/api/history/ratings", stall);
			await row.getByRole("button", { name: "Nachsehen" }).click();
			await expect(line(row)).toHaveText(/^Gespeichert: Nie wieder\./);
			expect(posts.length).toBe(sent + 2);
			expect(await currentSeq(page, song.id)).toBe(before + 1);
			await fav(row).click();
			await expect(line(row)).toHaveText(/^Gespeichert: Favorit\./);
		}

		// Rated in another tab since this one read it: nothing stored here, the rating now is shown.
		const tab = await context.newPage();
		await tab.goto("/verlauf");
		const there = rowsOf(tab, song.name).first();
		await never(there).click();
		await expect(line(there)).toHaveText(/^Gespeichert: Nie wieder\./);
		const seq = await currentSeq(page, song.id);
		// This tab still shows "Favorit"; tapping "Nie wieder" here is told "rated since", nothing stored.
		await never(row).click();
		await expect(line(row)).toHaveText(/^Inzwischen anders bewertet \(jetzt: Nie wieder\)/);
		await expect(never(row)).toHaveAttribute("aria-pressed", "true");
		expect(await currentSeq(page, song.id)).toBe(seq);
		await tab.close();
	});

	test("a lost answer whose receipt was pushed out since stays unclear: never 'not stored', never a second write", async ({
		page,
	}) => {
		await signIn(page);
		await setOption(page, true);
		await page.goto("/verlauf");
		const song = songs.plain[5]!;
		const row = rowsOf(page, song.name).first();
		await expect(fav(row)).toBeVisible();
		const posts: string[] = [];
		page.on("request", (r) => {
			if (r.method() === "POST" && new URL(r.url()).pathname === "/api/history/ratings")
				posts.push(r.postData() ?? "");
		});
		const lose = async (route: Route) => {
			if (route.request().method() !== "POST") return route.fallback();
			await route.fetch();
			await route.abort("internetdisconnected");
		};
		const blind = (route: Route) =>
			route.request().method() === "GET" ? route.abort("internetdisconnected") : route.fallback();
		await page.route("**/api/history/ratings", lose);
		await page.route("**/api/history/ratings/*", blind);
		await fav(row).click();
		await expect(line(row)).toHaveText(/^Unklar, ob gespeichert: /);
		await page.unroute("**/api/history/ratings/*", blind);
		await page.unroute("**/api/history/ratings", lose);
		const stored = await currentSeq(page, song.id);
		expect(await thumbOf(page, song.id)).toBe(1);
		// 101 later ratings (another song, another tab) push its receipt out of the kept ones.
		const other = songs.plain[6]!;
		let basis = await currentSeq(page, other.id);
		for (let i = 0; i < 101; i++) {
			const a = await post(page, "/api/history/ratings", {
				actionId: `prune-${i}-${Date.now()}`,
				trackId: other.id,
				value: i % 2 === 0 ? 1 : 0,
				basis,
			});
			const body = (await a.json()) as { kind: string; receipt: { seq: number } };
			expect(body.kind).toBe("done");
			basis = body.receipt.seq;
		}
		// Looking again: no receipt — and since the song was rated after this tap's basis, that proves nothing.
		const sent = posts.length;
		await row.getByRole("button", { name: "Nachsehen" }).click();
		await expect(line(row)).toHaveText(
			/^Unklar, ob gespeichert: Der Song wurde inzwischen bewertet, vielleicht durch diesen Tipp\. Lade den Verlauf neu/,
		);
		await expect(row.getByRole("button", { name: "Nochmal speichern" })).toHaveCount(0);
		expect(posts.length).toBe(sent);
		expect(await currentSeq(page, song.id)).toBe(stored);
		expect(await thumbOf(page, song.id)).toBe(1);
		// Reloaded: the stored rating shows.
		await page.reload();
		await expect(fav(rowsOf(page, song.name).first())).toHaveAttribute("aria-pressed", "true");
	});

	test("taking back brings the rating before; a rating changed elsewhere since is a conflict", async ({
		page,
	}) => {
		await signIn(page);
		await setOption(page, true);
		await page.goto("/verlauf");
		const song = songs.plain[1]!;
		const row = rowsOf(page, song.name).first();
		await expect(fav(row)).toHaveAttribute("aria-pressed", "false");
		// none → Favorit → back: none.
		await fav(row).click();
		await expect(line(row)).toHaveText(/^Gespeichert: Favorit\./);
		await undo(row).click();
		await expect(line(row)).toHaveText(/^Zurückgenommen: wieder keine Bewertung\./);
		await expect(fav(row)).toHaveAttribute("aria-pressed", "false");
		await expect(fav(row)).toBeFocused();
		expect(await thumbOf(page, song.id)).toBe(0);
		// Favorit → Nie wieder → back: Favorit.
		await fav(row).click();
		await expect(line(row)).toHaveText(/^Gespeichert: Favorit\./);
		await never(row).click();
		await expect(line(row)).toHaveText(/^Gespeichert: Nie wieder\./);
		await undo(row).focus();
		await page.keyboard.press("Enter");
		await expect(line(row)).toHaveText(/^Zurückgenommen: wieder Favorit\./);
		await expect(fav(row)).toHaveAttribute("aria-pressed", "true");
		expect(await thumbOf(page, song.id)).toBe(1);
		// Nie wieder here, then "Favorit" from the sheet or Siri (the old route): taking back changes nothing.
		await never(row).click();
		await expect(line(row)).toHaveText(/^Gespeichert: Nie wieder\./);
		expect((await post(page, `/api/tracks/${song.id}/thumb`, { value: 1 })).ok()).toBe(true);
		await undo(row).click();
		await expect(line(row)).toHaveText(
			/^Nicht zurückgenommen: Der Song wurde inzwischen anders bewertet/,
		);
		await expect(fav(row)).toHaveAttribute("aria-pressed", "true");
		expect(await thumbOf(page, song.id)).toBe(1);
	});

	test("Nie wieder on the song playing says the skip first, reports it apart, and never takes it back", async ({
		page,
	}) => {
		await signIn(page);
		await setOption(page, true);
		const song = songs.plain[2]!;
		await playing(page, song.id);
		await page.goto("/verlauf");
		const row = rowsOf(page, song.name).first();
		const hint = row.locator(".hist-rate__hint");
		await expect(hint).toHaveText(
			"Läuft gerade in Spotify: „Nie wieder“ überspringt ihn, wenn er beim Speichern noch läuft.",
		);
		// HUI-RT-005: a refused Favorit leaves "Nie wieder" possible — and its effect still said, apart.
		const refuse = (route: Route) =>
			route.request().method() !== "POST"
				? route.fallback()
				: route.fulfill({
						status: 400,
						contentType: "application/json",
						body: JSON.stringify({ error: { code: "bad", message: "Synthetic bad request" } }),
					});
		await page.route("**/api/history/ratings", refuse);
		await fav(row).click();
		await expect(row.locator(".hist-rate__status")).toHaveText(
			"Nicht gespeichert: Synthetic bad request",
		);
		await expect(hint).toHaveText(/^Läuft gerade in Spotify: „Nie wieder“ überspringt ihn/);
		await expect(never(row)).not.toHaveAttribute("aria-disabled", "true");
		await page.unroute("**/api/history/ratings", refuse);
		await never(row).click();
		await expect(line(row)).toHaveText(
			/^Gespeichert: Nie wieder\. Der laufende Song wurde übersprungen\./,
		);
		await expect.poll(async () => (await fake("status")).current).not.toBe(song.id);
		const after = await fake("status");
		await expect(undo(row)).toHaveText("Rückgängig (Überspringen bleibt)");
		await undo(row).click();
		await expect(line(row)).toHaveText(
			/^Zurückgenommen: wieder keine Bewertung\..*übersprungen.*bleibt so/,
		);
		const later = await fake("status");
		expect(later.current).toBe(after.current);
		expect(later.playing).toBe(after.playing);

		// Spotify refuses the skip: the rating is stored all the same, and both are said apart.
		const other = songs.plain[3]!;
		await playing(page, other.id);
		await fake("premium?on=0");
		await page.reload();
		const r2 = rowsOf(page, other.name).first();
		await expect(line(r2)).toHaveText(/Läuft gerade/);
		await never(r2).click();
		await expect(line(r2)).toHaveText(
			/^Gespeichert: Nie wieder\. Bewertung gespeichert; Überspringen fehlgeschlagen: /,
		);
		expect((await fake("status")).current).toBe(other.id);
		expect(await thumbOf(page, other.id)).toBe(-1);
		await fake("premium?on=1");
		await fake("pause");
	});

	test("R-HUI-02: rated with the old sheet meanwhile (same app, option off and on again), the Verlauf shows that rating", async ({
		page,
	}) => {
		await signIn(page);
		await setOption(page, true);
		await page.goto("/verlauf");
		const song = songs.plain[7]!;
		let row = rowsOf(page, song.name).first();
		await fav(row).click();
		await expect(line(row)).toHaveText(/^Gespeichert: Favorit\./);
		const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
		// From here on only inside the app: no reload, no new page.
		// Option off; the old Verlauf; its row opens the old sheet: "Nie wieder".
		await nav.getByRole("link", { name: "Mehr" }).click();
		await optionSwitch(page).click();
		await expect(optionSwitch(page)).not.toBeChecked();
		await nav.getByRole("link", { name: "Verlauf" }).click();
		row = rowsOf(page, song.name).first();
		await row.getByRole("button", { name: / bewerten$/ }).click();
		await page.getByRole("button", { name: /Daumen runter: nie wieder/ }).click();
		await expect.poll(() => thumbOf(page, song.id)).toBe(-1);
		// Option on again; the Verlauf opened with its list held: no old rows meanwhile.
		await nav.getByRole("link", { name: "Mehr" }).click();
		await optionSwitch(page).click();
		await expect(optionSwitch(page)).toBeChecked();
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const hold = async (route: Route) => {
			await gate;
			await route.fallback();
		};
		await page.route("**/api/history?limit=60", hold);
		await nav.getByRole("link", { name: "Verlauf" }).click();
		await expect(page.locator(".skeleton")).toBeVisible();
		await expect(rows(page)).toHaveCount(0);
		release();
		row = rowsOf(page, song.name).first();
		await expect(never(row)).toHaveAttribute("aria-pressed", "true");
		await expect(fav(row)).toHaveAttribute("aria-pressed", "false");
		await expect(line(row)).not.toHaveText(/Gespeichert: Favorit/);
		await page.unroute("**/api/history?limit=60", hold);
		// Acting on it stores on the rating shown.
		await fav(row).click();
		await expect(line(row)).toHaveText(/^Gespeichert: Favorit\./);
		expect(await thumbOf(page, song.id)).toBe(1);
	});

	test("R-HUI-03: a lost answer to taking back is unclear (said so, also aloud), never 'nicht zurückgenommen'; looking again finds it", async ({
		page,
	}) => {
		await signIn(page);
		await setOption(page, true);
		await page.goto("/verlauf");
		const song = songs.plain[8]!;
		const row = rowsOf(page, song.name).first();
		await fav(row).click();
		await expect(line(row)).toHaveText(/^Gespeichert: Favorit\./);
		const undos: string[] = [];
		page.on("request", (r) => {
			if (r.method() === "POST" && r.url().endsWith("/undo")) undos.push(r.url());
		});
		const lose = async (route: Route) => {
			await route.fetch();
			await route.abort("internetdisconnected");
		};
		const blind = (route: Route) =>
			route.request().method() === "GET" ? route.abort("internetdisconnected") : route.fallback();
		await page.route("**/api/history/ratings/*/undo", lose);
		await page.route("**/api/history/ratings/*", blind);
		await undo(row).click();
		await expect(line(row)).toHaveText(/^Unklar, ob zurückgenommen: /);
		await expect(page.locator(".sr-only[role=status]")).toHaveText(/unklar, ob zurückgenommen/);
		await expect(page.locator(".sr-only[role=status]")).not.toHaveText(/nicht zurückgenommen/);
		await page.unroute("**/api/history/ratings/*", blind);
		await page.unroute("**/api/history/ratings/*/undo", lose);
		await row.getByRole("button", { name: "Nachsehen" }).click();
		await expect(line(row)).toHaveText(/^Zurückgenommen: wieder keine Bewertung\./);
		expect(undos).toHaveLength(1);
		expect(await thumbOf(page, song.id)).toBe(0);
	});

	test("R-HUI-04: answers on their way when signing out (Verlauf closed) count for nothing after signing in again", async ({
		page,
	}) => {
		await signIn(page);
		await setOption(page, true);
		await page.goto("/verlauf");
		await expect(rows(page).first()).toBeVisible();
		const first = await rows(page).count();
		const song = songs.plain[9]!;
		const row = rowsOf(page, song.name).first();
		const before = await thumbOf(page, song.id);
		// An older page and a rating, both held on their way.
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const holdList = async (route: Route) => {
			if (!route.request().url().includes("before=")) return route.fallback();
			await gate;
			await route.fallback();
		};
		const holdRate = async (route: Route) => {
			if (route.request().method() !== "POST") return route.fallback();
			await gate;
			await route.fallback();
		};
		await page.route("**/api/history?*", holdList);
		await page.route("**/api/history/ratings", holdRate);
		await page.getByRole("button", { name: "Ältere laden" }).click();
		await fav(row).click();
		await expect(line(row)).toHaveText(/^Wird gespeichert/);
		// Signed out from Mehr (the Verlauf closes), and in again as the same account.
		const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
		await nav.getByRole("link", { name: "Mehr" }).click();
		await page.getByRole("button", { name: /Abmelden/ }).click();
		await expect(page.getByRole("link", { name: "Mit Spotify anmelden" })).toBeVisible();
		await signIn(page);
		await page.goto("/verlauf");
		await expect(rows(page).first()).toBeVisible();
		release();
		await page.waitForTimeout(1500);
		// The old page was not added, nothing is stuck loading, the old rating's answer claims nothing.
		await expect(rows(page)).toHaveCount(first);
		await expect(page.getByRole("button", { name: "Ältere laden" })).toBeEnabled();
		const now = rowsOf(page, song.name).first();
		// No status from the old session anywhere in the row (a row without news has no status line at all).
		await expect(now.getByText(/Gespeichert|Wird gespeichert/)).toHaveCount(0);
		const stored = await thumbOf(page, song.id);
		await expect(fav(now)).toHaveAttribute("aria-pressed", String(stored === 1));
		console.log("R-HUI-04 rating held across sign-out", JSON.stringify({ before, stored }));
		await page.unroute("**/api/history?*", holdList);
		await page.unroute("**/api/history/ratings", holdRate);
	});

	test("phone, desktop and 200 % zoom: labelled keys of about 44 px, nothing laid over them, keyboard order", async ({
		page,
	}) => {
		await signIn(page);
		await setOption(page, true);
		for (const [width, height] of [
			[320, 700],
			[390, 844],
			[1280, 800],
			[640, 400], // 1280 × 800 at 200 % zoom
		] as const) {
			await page.setViewportSize({ width, height });
			await page.goto("/verlauf");
			await expect(rows(page).first()).toBeVisible();
			const overflow = await page.evaluate(
				() => document.scrollingElement!.scrollWidth - window.innerWidth,
			);
			expect(overflow, `${width}px`).toBeLessThanOrEqual(0);
			const problems = await page.evaluate(() => {
				const out: string[] = [];
				const list = [...document.querySelectorAll<HTMLElement>(".hist-row")].slice(0, 12);
				for (const row of list) {
					row.scrollIntoView({ block: "center" });
					const keys = [...row.querySelectorAll<HTMLElement>(".hist-rate__key")];
					const texts = [
						...row.querySelectorAll<HTMLElement>(
							".hist-row__title, .hist-row__sub, .hist-row__time",
						),
					].map((e) => e.getBoundingClientRect());
					for (const k of keys) {
						const b = k.getBoundingClientRect();
						if (b.height < 44 || b.width < 44)
							out.push(`small ${k.textContent} ${b.width}x${b.height}`);
						const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
						if (!hit || !k.contains(hit)) out.push(`covered ${k.textContent}`);
						for (const t of texts)
							if (b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top)
								out.push(`overlaps text ${k.textContent}`);
						if (!k.textContent?.trim()) out.push("unnamed key");
					}
					if (row.querySelector(".track__hit")) out.push("row overlay present");
				}
				return out;
			});
			expect(problems, `${width}px`).toEqual([]);
			// For review: the Verlauf with the option on, at this width (saved outside the repository).
			await page.evaluate(() => window.scrollTo(0, 0));
			await page.screenshot({ path: `D:/Codex/Temp/history-ui/screens/verlauf-on-${width}px.png` });
		}
		// Keyboard: Favorit, then Nie wieder; Space works on either, and the focus stays.
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/verlauf");
		const row = rowsOf(page, songs.plain[4]!.name).first();
		await fav(row).focus();
		await page.keyboard.press("Tab");
		await expect(never(row)).toBeFocused();
		await page.keyboard.press("Space");
		await expect(line(row)).toHaveText(/^Gespeichert: Nie wieder\./);
		await expect(never(row)).toBeFocused();
		await expect(page.locator("audio, video")).toHaveCount(0);
		// A live region tells what happened.
		await expect(page.locator(".sr-only[role=status]")).toHaveText(/gespeichert — Nie wieder\./);
	});
});
