/**
 * The song Spotify actually plays, rendered (NP06, 2026-10-17). Every /api
 * request of the page is answered by the real HubCore against the synthetic
 * Spotify stand-in (test/hub/harness.ts, node:sqlite, simulated clock), so the
 * page, the hub's own validation and the provider calls are the real ones;
 * nothing reaches a live Spotify. The listener's moves in Spotify are made on
 * the stand-in; the hub looks at the player only where the test says so, and
 * the page reads the hub on focus. Before/after records of the saved
 * true-shuffle session and the provider calls are attached to each test.
 */
import { expect, type Page, type Route, type TestInfo, test } from "@playwright/test";
import type { ObservedTarget } from "../src/shared/api";
import { HubError, type Occurrence } from "../src/worker/hub/hub";
import { RequestBudget } from "../src/worker/spotify/client";
import { onboarded } from "../test/hub/harness";

test.use({ viewport: { width: 390, height: 844 } });

type H = Awaited<ReturnType<typeof onboarded>>;
const NEXT = "POST /v1/me/player/next";

async function world() {
	const h = await onboarded({ tracks: 12, playlists: [6, 6] });
	const sid = h.stationIds[0]!;
	expect(await h.hub.play(sid)).toMatchObject({ ok: true });
	await look(h);
	const s = h.hub.savedSession(sid)!;
	const own = h.fake.playlists.get(s.contextUri.split(":")[2]!)!.items;
	const outside = [...h.fake.tracks.keys()].filter((id) => !own.includes(id));
	const name = (id: string) => h.fake.tracks.get(id)!.name;
	// Artwork as the e2e stand-in gives it (e2e/fake-server.ts): a data: URL the page's CSP allows.
	for (const id of outside)
		(h.fake.tracks.get(id) as { cover?: string }).cover =
			`data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 4 4'><title>${id}</title><rect width='4' height='4'/></svg>`)}`;
	const cover = (id: string) => (h.fake.tracks.get(id) as { cover?: string }).cover!;
	return { h, sid, a: h.fake.current()!, outside, name, cover };
}

/** One look of the hub at the player (what its alarm would do). */
async function look(h: H, ms = 1000) {
	h.clock.t += ms;
	await h.hub.sync(new RequestBudget(25), { force: true, observationOnly: true, playerOnly: true });
}

/** What only the existing reconciliation and explicit ratings may change. */
function ts(h: H, sid: number) {
	const s = h.hub.savedSession(sid)!;
	return {
		sessionId: s.sessionId,
		entryIds: s.entryIds,
		currentIndex: s.currentIndex,
		progressMs: s.progressMs,
		observedAt: s.observedAt,
		pending: s.pending,
		orderRevision: s.orderRevision,
		playbackEpoch: s.playbackEpoch,
		status: s.status,
	};
}

interface Served {
	requests: { method: string; path: string; body: unknown }[];
	/** Hold the next answer to this path until released. */
	hold: Map<string, Promise<void>>;
}

async function serve(page: Page, h: H): Promise<Served> {
	const served: Served = { requests: [], hold: new Map() };
	await page.clock.install({ time: h.clock.t });
	await page.clock.setFixedTime(h.clock.t);
	await page.route("**/api/**", async (route: Route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname;
		const body = req.postData() ? (JSON.parse(req.postData()!) as Record<string, unknown>) : {};
		served.requests.push({ method: req.method(), path, body });
		const held = served.hold.get(path);
		if (held) {
			served.hold.delete(path);
			await held;
		}
		try {
			if (path === "/api/state")
				return await route.fulfill({ json: await h.hub.state({ live: false }) });
			if (path === "/api/devices") return await route.fulfill({ json: await h.hub.devices() });
			if (path === "/api/native/devices")
				return await route.fulfill({ json: { configured: false, devices: [] } });
			const thumb = /^\/api\/tracks\/([^/]+)\/thumb$/.exec(path);
			if (thumb && req.method() === "POST") {
				const v = body.value === 1 ? 1 : body.value === -1 ? -1 : 0;
				const bound = (body.expected ?? null) as Occurrence | ObservedTarget | null;
				return await route.fulfill({ json: await h.hub.thumb(thumb[1]!, v, undefined, bound) });
			}
			if (path === "/api/player/next" && req.method() === "POST")
				return await route.fulfill({
					json: body.target
						? await h.hub.observedNext(body.target as ObservedTarget)
						: await h.hub.playerAction("next", body as unknown as Occurrence),
				});
			const play = /^\/api\/stations\/(\d+)\/play$/.exec(path);
			if (play && req.method() === "POST")
				return await route.fulfill({
					json: await h.hub.play(Number(play[1]), (body.deviceId as string) ?? null, {
						sessionId: body.sessionId as string | undefined,
					}),
				});
			return await route.fulfill({
				status: 500,
				json: { error: { code: "unexpected", message: `Unexpected ${path}` } },
			});
		} catch (e) {
			if (e instanceof HubError)
				return route.fulfill({
					status: e.status,
					json: { error: { code: e.code, message: e.message } },
				});
			throw e;
		}
	});
	return served;
}

/** The page reads the hub again (as on returning to it). */
const reread = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));
const title = (page: Page) => page.locator(".now-copy h2");
const status = (page: Page) => page.locator(".session-status");
const checkpoint = (page: Page) =>
	page.getByRole("region", { name: "Gespeicherte TrueShuffle-Stelle" });
const weiter = (page: Page) => page.getByRole("button", { name: "Weiter: Nächster Song" });
const calls = (h: H, call: string) => h.fake.calls.filter((c) => c === call).length;
const writes = (h: H) =>
	h.fake.calls.filter((c) =>
		/^(PUT|POST|DELETE) \/v1\/(playlists|me\/playlists|me\/player\/play)/.test(c),
	).length;

async function record(info: TestInfo, name: string, data: unknown) {
	await info.attach(name, { body: JSON.stringify(data, null, 2), contentType: "application/json" });
}

test("A, external B, C, back to true-shuffle: shown as observed, saved place kept, no extra writes", async ({
	page,
}, info) => {
	const { h, sid, a, outside, name, cover } = await world();
	await serve(page, h);
	await page.goto("/");
	await expect(title(page)).toHaveText(name(a));
	await expect(checkpoint(page)).toHaveCount(0);
	const before = ts(h, sid);
	const callsBefore = h.fake.calls.length;
	const writesBefore = writes(h);

	h.fake.playSong("mika", outside[0]!);
	await look(h);
	await reread(page);
	await expect(title(page)).toHaveText(name(outside[0]!));
	await expect(status(page)).toHaveText("Spotify · außerhalb deiner TrueShuffle-Folge");
	await expect(page.locator(".player-state__line")).toContainText("auf iPhone");
	await expect(checkpoint(page)).toContainText(name(a));
	await expect(page.getByRole("button", { name: "TrueShuffle fortsetzen" })).toBeVisible();
	await expect(page.locator(".player-song__art")).toHaveAttribute("src", cover(outside[0]!));

	const nexts = calls(h, NEXT);
	await weiter(page).click();
	await expect(status(page)).toHaveText(/Songwechsel (angefordert|angenommen) …/);
	await expect.poll(() => calls(h, NEXT)).toBe(nexts + 1);
	const c = h.fake.current()!;
	expect(c).not.toBe(outside[0]);
	await look(h);
	await reread(page);
	await expect(title(page)).toHaveText(name(c));
	expect(ts(h, sid)).toEqual({ ...before, status: "external" });

	// Back to true-shuffle in Spotify itself: the existing reconciliation shows it as its own.
	const s = h.hub.savedSession(sid)!;
	h.fake.startContext("mika", s.contextUri, s.currentIndex, "mika-phone", false);
	await look(h);
	await reread(page);
	await expect(title(page)).toHaveText(name(a));
	await expect(checkpoint(page)).toHaveCount(0);
	await expect(status(page)).toHaveText("Spielt");
	const after = ts(h, sid);
	expect(after.currentIndex).toBe(before.currentIndex);
	expect(after.pending).toBeNull();
	expect(writes(h)).toBe(writesBefore);
	expect(h.fake.calls.some((x) => x.includes("/me/player/queue"))).toBe(false);
	await record(info, "np06-ts-before-after", {
		before,
		after,
		providerCalls: h.fake.calls.slice(callsBefore),
	});
});

test("B queued in the station's own context: unconfirmed, external next journals nothing", async ({
	page,
}, info) => {
	const { h, sid, outside, name } = await world();
	const served = await serve(page, h);
	await page.goto("/");
	const b = outside[0]!;
	h.fake.user("mika").player.userQueue.push(b);
	const a = h.fake.current()!;
	h.fake.advance(h.fake.tracks.get(a)!.durationMs - h.fake.user("mika").player.progressMs);
	await look(h);
	await reread(page);
	await expect(title(page)).toHaveText(name(b));
	await expect(status(page)).toHaveText("Spotify · Zuordnung unbestätigt");
	await expect(page.locator(".player-state__line")).toContainText(
		"nicht als ihr nächster Song bestätigt",
	);
	await expect(page.getByText(/eingereiht|Warteschlange von Spotify/)).toHaveCount(0);
	const before = ts(h, sid);
	let journal: unknown = "unread";
	const handle = h.fake.handle.bind(h.fake);
	h.fake.handle = async (req: Request) => {
		if (req.method === "POST" && new URL(req.url).pathname === "/v1/me/player/next")
			journal = h.hub.savedSession(sid)!.pending;
		return handle(req);
	};
	await weiter(page).click();
	await expect.poll(() => journal).toBeNull();
	h.fake.handle = handle;
	const sent = served.requests.filter((r) => r.path === "/api/player/next");
	expect(sent).toHaveLength(1);
	expect(Object.keys(sent[0]!.body as object)).toEqual(["target"]);
	expect(ts(h, sid).pending).toBeNull();
	await record(info, "np06-same-context", { before, after: ts(h, sid), sent });
});

test("a stale B click after C: refused, nothing skipped, a new look shows C; double tap sends once", async ({
	page,
}) => {
	const { h, outside, name } = await world();
	const served = await serve(page, h);
	await page.goto("/");
	const [b, c] = outside;
	h.fake.playSong("mika", b!);
	await look(h);
	await reread(page);
	await expect(title(page)).toHaveText(name(b!));
	// Spotify moved on to C; the page still shows B.
	h.fake.playSong("mika", c!);
	const nexts = calls(h, NEXT);
	await weiter(page).dblclick();
	await expect(page.getByRole("alert")).toContainText("Der angezeigte Song läuft so nicht mehr");
	expect(served.requests.filter((r) => r.path === "/api/player/next")).toHaveLength(1);
	expect(calls(h, NEXT)).toBe(nexts);
	await expect(page.getByRole("button", { name: /erneut versuchen/ })).toHaveCount(0);
	await page.getByRole("button", { name: "Spotify neu ansehen" }).click();
	await expect(title(page)).toHaveText(name(c!));
});

test("an unclear answer to next is said and never sent again", async ({ page }) => {
	const { h, outside, name } = await world();
	const served = await serve(page, h);
	await page.goto("/");
	h.fake.playSong("mika", outside[0]!);
	await look(h);
	await reread(page);
	await expect(title(page)).toHaveText(name(outside[0]!));
	h.fake.failWhen = (m, p) => (m === "POST" && p === "/me/player/next" ? { status: 503 } : null);
	await weiter(page).click();
	await expect(
		page.getByRole("status").filter({ hasText: "Es wird nicht wiederholt" }),
	).toBeVisible();
	h.fake.failWhen = null;
	await expect(weiter(page)).toBeDisabled();
	expect(served.requests.filter((r) => r.path === "/api/player/next")).toHaveLength(1);
	expect(h.fake.calls.filter((c) => c === NEXT)).toHaveLength(1);
});

test("Favorit and Nie wieder on B: stored song-wide, B skipped once; toggled off; no library write", async ({
	page,
}) => {
	const { h, outside, name } = await world();
	await serve(page, h);
	await page.goto("/");
	const b = outside[0]!;
	h.fake.playSong("mika", b);
	await look(h);
	await reread(page);
	await expect(title(page)).toHaveText(name(b));
	const fav = page.getByRole("button", { name: "Daumen hoch: Favorit" });
	await fav.click();
	await expect(fav).toHaveAttribute("aria-pressed", "true");
	expect(h.hub.memory(b).thumb).toBe(1);
	await fav.click();
	await expect(fav).toHaveAttribute("aria-pressed", "false");
	await expect.poll(() => h.hub.memory(b).thumb).toBe(0);
	expect(
		h.fake.calls.filter((x) => /\/me\/(tracks|library)/.test(x) && !x.startsWith("GET")),
	).toEqual([]);
	const nexts = calls(h, NEXT);
	await page.getByRole("button", { name: "Daumen runter: diesen Song nie wieder" }).click();
	await expect(page.getByText("Kommt nie wieder")).toBeVisible();
	expect(h.hub.memory(b).thumb).toBe(-1);
	expect(calls(h, NEXT)).toBe(nexts + 1);
});

test("a late Nie wieder on B after C: stored for B, said as no longer applicable, C untouched", async ({
	page,
}) => {
	const { h, outside, name } = await world();
	const served = await serve(page, h);
	await page.goto("/");
	const [b, c] = outside;
	h.fake.playSong("mika", b!);
	await look(h);
	await reread(page);
	await expect(title(page)).toHaveText(name(b!));
	let release!: () => void;
	served.hold.set(
		`/api/tracks/${b}/thumb`,
		new Promise<void>((r) => {
			release = r;
		}),
	);
	await page.getByRole("button", { name: "Daumen runter: diesen Song nie wieder" }).click();
	await expect(page.getByText("Wird gespeichert …")).toBeVisible();
	h.fake.playSong("mika", c!);
	await look(h);
	await reread(page);
	await expect(title(page)).toHaveText(name(c!));
	const nexts = calls(h, NEXT);
	release();
	await expect(page.getByText("Der Song lief da schon nicht mehr")).toBeVisible();
	expect(h.hub.memory(b!).thumb).toBe(-1);
	expect(h.hub.memory(c!).thumb).toBe(0);
	expect(calls(h, NEXT)).toBe(nexts);
	await expect(
		page.getByRole("button", { name: "Daumen runter: diesen Song nie wieder" }),
	).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByRole("button", { name: "Jetzt überspringen" })).toHaveCount(0);
});

test("paused, no device, an episode, a failed look: never A as current, A as the saved place", async ({
	page,
}) => {
	const { h, a, outside, name } = await world();
	await serve(page, h);
	await page.goto("/");
	h.fake.playSong("mika", outside[0]!);
	h.fake.pause();
	await look(h);
	await reread(page);
	await expect(title(page)).toHaveText(name(outside[0]!));
	await expect(page.locator(".player-state__line")).toContainText("Pausiert in Spotify");

	h.fake.failWhen = (m, p) =>
		m === "GET" && p === "/me/player"
			? {
					status: 200,
					body: {
						device: {
							id: "mika-phone",
							is_active: true,
							is_restricted: false,
							name: "iPhone",
							type: "Smartphone",
						},
						is_playing: true,
						progress_ms: 10,
						context: null,
						item: { type: "episode", id: "6rqhFgbbKwnb9MLmUQDhG6", name: "Pod", duration_ms: 1000 },
						currently_playing_type: "episode",
					},
				}
			: null;
	await look(h);
	await reread(page);
	await expect(title(page)).toHaveText("Kein Song lesbar");
	await expect(checkpoint(page)).toContainText(name(a));
	await expect(weiter(page)).toBeDisabled();

	h.fake.failWhen = (m, p) => (m === "GET" && p === "/me/player" ? { status: 503 } : null);
	await look(h);
	await reread(page);
	await expect(title(page)).toHaveText("Spotify-Stand unbekannt");
	await expect(checkpoint(page)).toContainText(name(a));

	h.fake.failWhen = null;
	h.fake.user("mika").player.deviceId = null;
	await look(h);
	await reread(page);
	await expect(title(page)).toHaveText("Spotify spielt gerade nichts");
	await expect(checkpoint(page)).toContainText(name(a));
});
