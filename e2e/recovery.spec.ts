import { expect, test } from "@playwright/test";
import type { AppState } from "../src/shared/api";

const CONTROL = "http://127.0.0.1:8788/__control";
async function control(
	action: string,
): Promise<{ playing: boolean; current: string | null; index: number; progressMs: number }> {
	return await (await fetch(`${CONTROL}/${action}`)).json();
}

test("deliberately recovers an unconfirmed Spotify resume without changing its occurrence", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("link", { name: "Mit Spotify anmelden" }).click();
	let state = (await (await page.request.get("/api/state")).json()) as AppState;
	if (!state.onboarded) {
		await page.getByRole("checkbox", { name: /Indie & Gitarren/ }).check();
		await page.getByRole("checkbox", { name: /Lange Autofahrt/ }).check();
		await page.getByRole("button", { name: "2 Sender speichern" }).click();
	}
	await page.getByRole("button", { name: /^Indie & Gitarren/ }).click();
	await expect(page.locator(".transport-main")).toBeEnabled({ timeout: 60000 });
	if ((await page.locator(".transport-main").textContent()) !== "Pause")
		await page.locator(".transport-main").click();
	await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
	await expect.poll(async () => (await control("status")).playing).toBe(true);
	await control("position?ms=97000&paused=1");
	await page.request.post("/api/sync", { headers: { "x-ts": "1" } });
	await page.reload();
	await expect(page.getByText("1:37 gespeichert")).toBeVisible();
	state = (await (await page.request.get("/api/state")).json()) as AppState;
	const held = state.session;
	expect(held).toBeTruthy();
	const before = await control("status");
	const queue = held?.queue.map((entry) => entry.entryId);
	const commands: string[] = [];
	page.on("request", (request) => {
		if (request.method() === "POST") commands.push(new URL(request.url()).pathname);
	});
	await control("fail-play?on=1");
	try {
		await page.getByRole("button", { name: "Fortsetzen", exact: true }).click();
		const recovery = page.getByRole("button", {
			name: "Gespeicherten Befehl erneut versuchen",
			exact: true,
		});
		await expect(recovery).toBeVisible();
		await expect(page.locator(".session-status")).toHaveText("Bestätigung steht aus");
		await expect(
			page.getByRole("button", { name: "Befehl erneut versuchen", exact: true }),
		).toHaveCount(0);
		await expect(page.locator(".transport-main")).toBeDisabled();
		const pending = ((await (await page.request.get("/api/state")).json()) as AppState).session;
		expect(pending?.pending).toBe(true);
		expect(pending?.sessionId).toBe(held?.sessionId);
		expect(pending?.entryId).toBe(held?.entryId);
		expect(pending?.progressMs).toBe(97000);
		expect(pending?.queue.map((entry) => entry.entryId)).toEqual(queue);
		expect((await control("status")).playing).toBe(false);
		await page.screenshot({ path: ".impeccable/review/spotify-pending.png", fullPage: true });
		await recovery.click();
		await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
		await expect.poll(async () => (await control("status")).playing).toBe(true);
		const after = ((await (await page.request.get("/api/state")).json()) as AppState).session;
		expect(after?.pending).toBe(false);
		expect(after?.sessionId).toBe(held?.sessionId);
		expect(after?.entryId).toBe(held?.entryId);
		expect(after?.queue.map((entry) => entry.entryId)).toEqual(queue);
		expect(after?.progressMs).toBeGreaterThanOrEqual(97000);
		const provider = await control("status");
		expect(provider.current).toBe(before.current);
		expect(provider.index).toBe(before.index);
		expect(provider.progressMs).toBeGreaterThanOrEqual(97000);
		expect(commands).not.toContain("/api/player/next");
		expect(
			commands.filter((path) => path === `/api/stations/${held?.stationId}/play`),
		).toHaveLength(2);
	} finally {
		await control("fail-play?on=0");
	}
});
