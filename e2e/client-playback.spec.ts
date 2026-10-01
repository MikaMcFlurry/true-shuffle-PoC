/** Rendered client races use intercepted API snapshots; no provider or history writes. */
import { expect, type Page, type Route, test } from "@playwright/test";
import { DEFAULT_RULES } from "../src/core/types";
import type { AppState, DeviceView } from "../src/shared/api";

test.use({ viewport: { width: 390, height: 844 } });

const TIME = Date.UTC(2026, 9, 1, 12);
const tracks = ["Erster Song", "Zweiter Song", "Dritter Song"].map((name, index) => ({
	id: `track-${index}`,
	name,
	artists: "Test Artist",
	album: "Test Album",
	imageUrl: null,
	durationMs: 60_000,
	thumb: 0 as const,
}));
function snapshot(playing = true): AppState {
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
				playing,
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
			status: playing ? "active" : "paused",
			pending: false,
			queue: tracks.map((track, index) => ({ entryId: `entry-${index}`, track })),
		},
		nowPlaying: {
			...tracks[0]!,
			isPlaying: playing,
			progressMs: 12_000,
			stationId: 1,
			kind: "fresh",
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
function deferred() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
async function setup(page: Page, initial = snapshot()) {
	const model = {
		state: initial,
		stateCalls: 0,
		stateQueries: [] as string[],
		requests: [] as string[],
		devices: [
			{ id: "iphone", name: "Test iPhone", active: true, restricted: false, type: "Smartphone" },
		] as DeviceView[],
		stateHandler: null as ((route: Route) => Promise<void>) | null,
	};
	await page.clock.install({ time: TIME });
	await page.clock.setFixedTime(TIME);
	await page.route("**/api/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		model.requests.push(path);
		if (path === "/api/state") {
			model.stateCalls++;
			model.stateQueries.push(new URL(route.request().url()).search);
			if (model.stateHandler) return model.stateHandler(route);
			return route.fulfill({ json: model.state });
		}
		if (path === "/api/devices") return route.fulfill({ json: model.devices });
		if (path === "/api/native/devices")
			return route.fulfill({ json: { configured: false, devices: [] } });
		return route.fulfill({
			status: 500,
			json: { error: { code: "unexpected", message: `Unexpected ${path}` } },
		});
	});
	await page.goto("/");
	await expect(page.locator(".now-copy h2")).toHaveText("Erster Song");
	await expect(
		page.locator(".device-select select option", { hasText: "Test iPhone" }),
	).toHaveCount(1);
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
	).toBeLessThanOrEqual(0);
	return model;
}
async function advance(page: Page, milliseconds: number) {
	const now = await page.evaluate(() => Date.now());
	await page.clock.setFixedTime(now + milliseconds);
	await page.clock.runFor(milliseconds);
}
async function refresh(page: Page) {
	const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/state");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await response;
}
function observe(
	model: { state: AppState },
	patch: Partial<NonNullable<AppState["session"]>>,
	at: number,
) {
	Object.assign(model.state.session!, patch, { observedAt: at });
	model.state.serverTime = at;
	if (model.state.nowPlaying)
		Object.assign(model.state.nowPlaying, {
			observedAt: at,
			progressMs: patch.progressMs ?? model.state.nowPlaying.progressMs,
		});
}

test("projects one known successor locally and uses the authoritative occurrence for pause", async ({
	page,
}) => {
	const state = snapshot();
	state.session!.progressMs = 59_000;
	state.nowPlaying!.progressMs = 59_000;
	const model = await setup(page, state);
	const requestCount = model.requests.length;
	await advance(page, 2000);
	await expect(page.locator(".now-copy h2")).toHaveText("Zweiter Song");
	await expect(page.locator(".session-status")).toHaveText("Nächster Song · geschätzt");
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1000");
	await expect(page.getByRole("button", { name: "Weiter: Nächster Song" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Daumen hoch: Favorit" })).toBeDisabled();
	await expect(page.locator(".queue-list")).not.toContainText("Zweiter Song");
	expect(model.requests.length).toBe(requestCount);
	let body: unknown;
	await page.route("**/api/player/pause", async (route) => {
		body = route.request().postDataJSON();
		await route.fulfill({ json: { ok: true, acceptedAt: TIME + 2000 } });
	});
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	await expect.poll(() => body).toEqual({ sessionId: "session-a", entryId: "entry-0" });
	await advance(page, 3000);
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1000");
	await expect(page.locator(".progress-labels")).toContainText("Bestätigung ausstehend");
	await page.screenshot({ path: "e2e/.artifacts/responsive-projected-mobile.png", fullPage: true });
});

test("pause freezes immediately through a slow response, then reconciles a fresh observation", async ({
	page,
}) => {
	const model = await setup(page);
	const gate = deferred();
	await page.route("**/api/player/pause", async (route) => {
		await gate.promise;
		await route.fulfill({ json: { ok: true, acceptedAt: TIME + 6000 } });
	});
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	await expect(page.getByRole("button", { name: "Pause angefordert …" })).toBeDisabled();
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "12000");
	await advance(page, 6000);
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "12000");
	await page.screenshot({ path: "e2e/.artifacts/responsive-pause-mobile.png", fullPage: true });
	gate.release();
	await expect(page.getByText("Befehl angenommen.", { exact: false })).toBeVisible();
	await expect(page.locator(".session-status")).not.toHaveText("Pausiert");
	observe(model, { status: "paused", progressMs: 12_080 }, TIME + 6500);
	model.state.nowPlaying!.isPlaying = false;
	await advance(page, 1500);
	await expect(page.locator(".session-status")).toHaveText("Pausiert");
	await expect(page.getByRole("button", { name: "Fortsetzen", exact: true })).toBeEnabled();
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "12080");
});

test("a poll started before pause cannot win; one fresh serialized follow-up confirms it", async ({
	page,
}) => {
	const model = await setup(page);
	const old = structuredClone(model.state);
	const gate = deferred();
	let held = false;
	model.stateHandler = async (route) => {
		if (!held) {
			held = true;
			await gate.promise;
			await route.fulfill({ json: old });
		} else await route.fulfill({ json: model.state });
	};
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect.poll(() => held).toBe(true);
	await page.route("**/api/player/pause", async (route) => {
		observe(model, { status: "paused", progressMs: 12_100 }, TIME + 1000);
		model.state.nowPlaying!.isPlaying = false;
		await route.fulfill({ json: { ok: true, acceptedAt: TIME + 500 } });
	});
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	await expect(page.getByText("Befehl angenommen.", { exact: false })).toBeVisible();
	gate.release();
	await expect(page.locator(".session-status")).toHaveText("Pausiert");
	expect(model.stateCalls).toBe(3);
	// Even a subsequently delivered older provider observation cannot make playback flip back.
	model.stateHandler = async (route) =>
		route.fulfill({ json: { ...old, serverTime: TIME + 2000 } });
	await refresh(page);
	await expect(page.locator(".session-status")).toHaveText("Pausiert");
});

test("resume acceptance stays pending through old observations and exposes bounded retry", async ({
	page,
}) => {
	const model = await setup(page, snapshot(false));
	let writes = 0;
	await page.route("**/api/stations/1/play", async (route) => {
		writes++;
		await route.fulfill({ json: { ok: true, acceptedAt: TIME + 500 } });
	});
	await page.getByRole("button", { name: "Fortsetzen", exact: true }).click();
	await expect(page.getByText("Befehl angenommen.", { exact: false })).toBeVisible();
	model.state.session!.status = "active";
	model.state.nowPlaying!.isPlaying = true;
	await advance(page, 5000);
	await expect(page.locator(".session-status")).toHaveText("Start angefordert …");
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "12000");
	await advance(page, 16_000);
	await expect(page.locator(".session-status")).toHaveText("Bestätigung steht aus");
	await expect(
		page.getByRole("button", { name: "Gespeicherten Befehl erneut versuchen" }),
	).toBeEnabled();
	expect(writes).toBe(1);
	observe(model, { status: "active", progressMs: 13_000 }, TIME + 21_000);
	await refresh(page);
	await expect(page.locator(".session-status")).toHaveText("Spielt");
	await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
});

test("a rejected pause restores observed playback and provides an explicit retry", async ({
	page,
}) => {
	await setup(page);
	await page.route("**/api/player/pause", async (route) =>
		route.fulfill({
			json: {
				ok: false,
				error: { code: "restricted", message: "Gerät nimmt keine Befehle an." },
			},
		}),
	);
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Gerät nimmt keine Befehle an. Bitte erneut versuchen.",
	);
	await expect(page.getByRole("button", { name: "Befehl erneut versuchen" })).toBeEnabled();
	await advance(page, 2000);
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "14000");
});

test("device refresh preserves an absent explicit device and the Spotify sentinel routing", async ({
	page,
}) => {
	const model = await setup(page, snapshot(false));
	const select = page.getByLabel("Wiedergabegerät", { exact: true });
	await select.selectOption("iphone");
	model.devices = [];
	await page.getByRole("button", { name: "Geräte aktualisieren" }).click();
	await expect(select).toHaveValue("iphone");
	await expect(select.locator("option:checked")).toHaveText("Test iPhone · zurzeit nicht sichtbar");
	let sent: unknown;
	await page.route("**/api/stations/1/play", async (route) => {
		sent = route.request().postDataJSON();
		await route.fulfill({
			json: { ok: false, error: { code: "no_device", message: "Gerät fehlt." } },
		});
	});
	await page.getByRole("button", { name: "Fortsetzen", exact: true }).click();
	await expect.poll(() => sent).toMatchObject({ deviceId: "iphone", sessionId: "session-a" });
	await expect(page.getByRole("button", { name: "Befehl erneut versuchen" })).toBeEnabled();
	model.state.session!.controller = {
		kind: "home-assistant",
		deviceId: "living-room",
		deviceName: "Wohnzimmer",
	};
	await refresh(page);
	await select.selectOption("spotify");
	await page.getByRole("button", { name: "Geräte aktualisieren" }).click();
	await expect(select).toHaveValue("spotify");
	await page.getByRole("button", { name: "Fortsetzen", exact: true }).click();
	await expect.poll(() => sent).toEqual({ newQueue: false, sessionId: "session-a" });
});

test("projection expires without advancing further and seeks, offline and private observations correct it", async ({
	page,
}) => {
	const initial = snapshot();
	initial.session!.progressMs = 59_000;
	const model = await setup(page, initial);
	await advance(page, 2000);
	await expect(page.locator(".now-copy h2")).toHaveText("Zweiter Song");
	await advance(page, 30_000);
	await expect(page.locator(".now-copy h2")).toHaveText("Erster Song");
	await expect(page.locator(".now-copy h2")).not.toHaveText("Dritter Song");
	observe(model, { progressMs: 5000 }, TIME + 32_000);
	await refresh(page);
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "5000");
	observe(model, { progressMs: 59_000 }, TIME + 32_000);
	await refresh(page);
	await advance(page, 2000);
	await expect(page.locator(".now-copy h2")).toHaveText("Zweiter Song");
	await page.evaluate(() => window.dispatchEvent(new Event("offline")));
	await expect(page.locator(".now-copy h2")).toHaveText("Erster Song");
	model.state.nowPlaying = null;
	observe(model, { status: "ambiguous", progressMs: null }, TIME + 35_000);
	await refresh(page);
	await advance(page, 10_000);
	await expect(page.locator(".now-copy h2")).toHaveText("Erster Song");
	await expect(page.locator(".progress-labels")).toContainText("Position unbekannt");
});

test("identity change discards a pending command and its late response", async ({ page }) => {
	const model = await setup(page);
	const gate = deferred();
	await page.route("**/api/player/pause", async (route) => {
		await gate.promise;
		await route.fulfill({ json: { ok: true, acceptedAt: TIME + 1000 } });
	});
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	model.state = snapshot(false);
	model.state.profile.id = "listener-b";
	model.state.session!.sessionId = "session-b";
	await refresh(page);
	await expect(page.locator(".session-status")).toHaveText("Pausiert");
	gate.release();
	await expect(page.getByRole("button", { name: "Fortsetzen", exact: true })).toBeEnabled();
	await expect(page.getByText("Befehl angenommen.", { exact: false })).toBeHidden();
});

test("accepted next keeps the saved occurrence until the actual successor is observed", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	const model = await setup(page);
	await page.route("**/api/player/next", async (route) => {
		expect(route.request().postDataJSON()).toEqual({ sessionId: "session-a", entryId: "entry-0" });
		model.state.session!.pending = true;
		await route.fulfill({ json: { ok: true, acceptedAt: TIME + 1000 } });
	});
	await page.getByRole("button", { name: "Weiter: Nächster Song" }).click();
	await expect(page.getByText("Befehl angenommen.", { exact: false })).toBeVisible();
	await expect(page.locator(".now-copy h2")).toHaveText("Erster Song");
	await expect(page.getByRole("button", { name: "Weiter: Nächster Song" })).toBeDisabled();
	await page.screenshot({ path: "e2e/.artifacts/responsive-next-desktop.png", fullPage: true });
	observe(model, { entryId: "entry-1", progressMs: 1500, pending: false }, TIME + 2000);
	model.state.nowPlaying = { ...model.state.nowPlaying!, ...tracks[1]!, progressMs: 1500 };
	await refresh(page);
	await expect(page.locator(".now-copy h2")).toHaveText("Zweiter Song");
	await expect(page.getByRole("button", { name: "Weiter: Nächster Song" })).toBeEnabled();
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1500");
});

test("an absent saved native selection keeps its native route", async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem("ts-device", "native:living-room");
		localStorage.setItem("ts-device-name", "Wohnzimmer");
	});
	await setup(page, snapshot(false));
	await expect(page.getByLabel("Wiedergabegerät", { exact: true })).toHaveValue(
		"native:living-room",
	);
	let body: unknown;
	await page.route("**/api/native/play", async (route) => {
		body = route.request().postDataJSON();
		await route.fulfill({
			status: 409,
			json: { error: { code: "unavailable", message: "Gerät ist nicht erreichbar." } },
		});
	});
	await page.getByRole("button", { name: "Fortsetzen", exact: true }).click();
	await expect
		.poll(() => body)
		.toMatchObject({
			deviceId: "living-room",
			sessionId: "session-a",
			entryId: "entry-0",
			orderRevision: 1,
		});
	await expect(page.getByRole("alert")).toContainText("Gerät ist nicht erreichbar.");
});

test("a lost transport response remains uncertain and never claims pause", async ({ page }) => {
	await setup(page);
	await page.route("**/api/player/pause", async (route) => route.abort("failed"));
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	await expect(page.locator(".session-status")).toHaveText("Bestätigung steht aus");
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "12000");
	await expect(page.getByRole("button", { name: "Pause erneut versuchen" })).toBeEnabled();
	await expect(page.locator(".session-status")).not.toHaveText("Pausiert");
});

test("opens and returns with a coalesced fresh read while regular polling stays cached", async ({
	page,
}) => {
	const model = await setup(page);
	expect(model.stateQueries).toEqual(["?live=1&refresh=1"]);
	await advance(page, 15_000);
	await expect.poll(() => model.stateQueries).toEqual(["?live=1&refresh=1", "?live=1"]);
	const gate = deferred();
	model.stateHandler = async (route) => {
		await gate.promise;
		await route.fulfill({ json: model.state });
	};
	await page.evaluate(() => {
		window.dispatchEvent(new Event("focus"));
		window.dispatchEvent(new Event("focus"));
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect.poll(() => model.stateQueries.length).toBe(3);
	expect(model.stateQueries[2]).toBe("?live=1&refresh=1");
	gate.release();
	await expect(page.locator(".now-copy h2")).toHaveText("Erster Song");
	expect(model.stateQueries.length).toBe(3);
});

test("an ambiguous pause error stays frozen until a fresh paused observation confirms it", async ({
	page,
}) => {
	const model = await setup(page);
	let writes = 0;
	await page.route("**/api/player/pause", async (route) => {
		writes++;
		await route.fulfill({
			json: {
				ok: false,
				uncertain: true,
				error: { code: "unknown", message: "Spotify hat keine eindeutige Antwort geliefert." },
			},
		});
	});
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	await expect(page.locator(".session-status")).toHaveText("Bestätigung steht aus");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByText("Befehl fehlgeschlagen", { exact: true })).toHaveCount(0);
	await advance(page, 6000);
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "12000");
	await expect(page.locator(".session-status")).not.toHaveText("Pausiert");
	await expect(page.getByRole("button", { name: "Pause erneut versuchen" })).toBeEnabled();
	expect(writes).toBe(1);
	observe(model, { status: "paused", progressMs: 12_050 }, TIME + 6000);
	model.state.nowPlaying!.isPlaying = false;
	await refresh(page);
	await expect(page.locator(".session-status")).toHaveText("Pausiert");
	await expect(page.getByRole("button", { name: "Fortsetzen", exact: true })).toBeEnabled();
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "12050");
});

test("a reloaded paused session waits for confirmation when its cached Spotify observation still plays", async ({
	page,
}) => {
	const state = snapshot(false);
	state.nowPlaying!.isPlaying = true;
	const model = await setup(page, state);
	let writes = 0;
	page.on("request", (request) => {
		if (request.method() === "POST") writes++;
	});
	await expect(page.locator(".session-status")).toHaveText("Gerätebestätigung steht aus");
	await advance(page, 6000);
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "12000");
	await expect(page.locator(".session-status")).not.toHaveText("Pausiert");
	await page.reload();
	await expect(page.locator(".session-status")).toHaveText("Gerätebestätigung steht aus");
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "12000");
	observe(model, { status: "paused", progressMs: 12_050 }, TIME + 6000);
	model.state.nowPlaying!.isPlaying = false;
	await refresh(page);
	await expect(page.locator(".session-status")).toHaveText("Pausiert");
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "12050");
	expect(writes).toBe(0);
});

test("a confirmed native pause stays authoritative over cached matching Spotify playback", async ({
	page,
}) => {
	const state = snapshot(false);
	state.session!.controller = {
		kind: "home-assistant",
		deviceId: "living-room",
		deviceName: "Wohnzimmer",
	};
	state.nowPlaying!.isPlaying = true;
	await setup(page, state);
	await expect(page.locator(".session-status")).toHaveText("Pausiert");
	await advance(page, 6000);
	await expect(page.locator(".session-status")).toHaveText("Pausiert");
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "12000");
	await expect(page.locator(".now-copy h2")).toHaveText("Erster Song");
	await expect(page.getByText("Gerätebestätigung steht aus", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Nächster Song · geschätzt", { exact: true })).toHaveCount(0);
});

test("an unconfirmed pause with a vanished device allows deliberate saved-song recovery elsewhere", async ({
	page,
}) => {
	const model = await setup(page);
	const saved = structuredClone(model.state.session!);
	const writes: { path: string; body: unknown }[] = [];
	page.on("request", (request) => {
		if (request.method() === "POST")
			writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
	});
	const device = page.getByLabel("Wiedergabegerät", { exact: true });
	await device.selectOption("iphone");
	await page.route("**/api/player/pause", async (route) => {
		model.state.session!.status = "disconnected";
		model.state.nowPlaying = null;
		model.state.serverTime = TIME + 500;
		model.devices = [
			{
				id: "speaker",
				name: "Wohnzimmer Spotify",
				type: "Speaker",
				active: true,
				restricted: false,
			},
		];
		await route.fulfill({ json: { ok: true, acceptedAt: TIME + 500 } });
	});
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	await expect(page.getByText("Befehl angenommen.", { exact: false })).toBeVisible();
	await expect(device).toBeDisabled();
	await advance(page, 21_000);
	await expect(page.locator(".session-status")).toHaveText("Bestätigung steht aus");
	await expect(page.getByRole("progressbar")).toHaveAttribute("value", "12000");
	await expect(device).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "Pause erneut versuchen", exact: true }),
	).toBeEnabled();
	const resume = page.getByRole("button", { name: "Gespeicherten Song fortsetzen", exact: true });
	await expect(resume).toBeEnabled();
	expect(writes).toEqual([
		{ path: "/api/player/pause", body: { sessionId: saved.sessionId, entryId: saved.entryId } },
	]);
	await page.getByRole("button", { name: "Geräte aktualisieren" }).click();
	await expect(device.locator("option:checked")).toHaveText("Test iPhone · zurzeit nicht sichtbar");
	await device.selectOption("speaker");
	await page.route("**/api/stations/1/play", async (route) =>
		route.fulfill({ json: { ok: true, acceptedAt: TIME + 21_000 } }),
	);
	await resume.click();
	await expect
		.poll(() => writes)
		.toEqual([
			{ path: "/api/player/pause", body: { sessionId: saved.sessionId, entryId: saved.entryId } },
			{
				path: "/api/stations/1/play",
				body: { deviceId: "speaker", newQueue: false, sessionId: saved.sessionId },
			},
		]);
	await expect(page.locator(".session-status")).toHaveText("Start angefordert …");
	expect(model.state.session!.sessionId).toBe(saved.sessionId);
	expect(model.state.session!.entryId).toBe(saved.entryId);
	expect(model.state.session!.progressMs).toBe(saved.progressMs);
	expect(model.state.session!.queue).toEqual(saved.queue);
});
