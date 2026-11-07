/**
 * PR35 UI-01 and UI-02, strict: a search answer for account A never shows
 * under account B, and the volume readout is readable in day and night.
 * Synthetic accounts and devices only (see pr35.config.ts).
 */
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { DEFAULT_RULES } from "../../src/core/types";
import type { AppState } from "../../src/shared/api";

const OUT = process.env.PR35_OUT ?? "e2e/.artifacts/pr35";
mkdirSync(OUT, { recursive: true });
const TIME = Date.UTC(2026, 9, 1, 12);
const A = {
	id: "track-a",
	name: "Song A",
	artists: "Test Artist",
	album: "Test Album",
	imageUrl: null,
	durationMs: 180_000,
	thumb: 0 as -1 | 0 | 1,
};

function snapshot(profile: string): AppState {
	return {
		profile: { id: profile, name: `Listener ${profile}`, imageUrl: null },
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
			queue: [{ entryId: "entry-0", track: { ...A } }],
		},
		nowPlaying: {
			...A,
			isPlaying: true,
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
	} as unknown as AppState;
}

const hit = (id: string, name: string) => ({
	through: TIME,
	complete: true,
	songs: [
		{
			entry: { ...A, id, name, playedAt: TIME, stationName: null, ignored: false },
			plays: [TIME],
		},
	],
});

async function quiet(page: Page, illumination = "day") {
	await page.addInitScript((i) => {
		localStorage.setItem("ts-release-seen", "9.9.9");
		localStorage.setItem("ts-illumination", i);
	}, illumination);
}

async function refresh(page: Page) {
	await page.evaluate(async () => {
		// The page's own store module, served by Vite (not resolvable from here).
		const module = "/store.ts";
		const { store } = await import(module);
		await store.refresh(true, true);
	});
}

for (const how of ["another", "same-again"] as const) {
	test(`UI-01: A's search answer on its way never shows (${how})`, async ({ page }) => {
		let state: AppState | null = snapshot("A");
		const asked: string[] = [];
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		await quiet(page);
		await page.route("**/api/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === "/api/state")
				return state ? route.fulfill({ json: state }) : route.fulfill({ status: 401, json: {} });
			if (path === "/api/history/search") {
				const who = state?.profile.id ?? "none";
				asked.push(who);
				if (asked.length === 1) {
					await held;
					return route.fulfill({ json: hit("private-a", "Alice private listening") });
				}
				return route.fulfill({ json: hit(`only-${who}`, `Alice for ${who}`) });
			}
			return route.fulfill({ json: [] });
		});
		await page.goto("/verlauf");
		await page.getByRole("searchbox").fill("Alice");
		await expect.poll(() => asked.length).toBe(1);
		if (how === "another") {
			// B signs in while A's answer is still on its way.
			state = snapshot("B");
			await refresh(page);
		} else {
			// Signed out, then back as A: the old session's answer is not this one's.
			state = null;
			await refresh(page);
			state = snapshot("A");
			await refresh(page);
			// Same page (no reload): the Verlauf comes back, the search is asked again.
			await page.getByRole("searchbox").fill("Alice");
		}
		await page.waitForTimeout(400);
		release();
		await page.waitForTimeout(800);
		const shown = await page.locator(".hist-hit").allInnerTexts();
		await page.screenshot({ path: `${OUT}/ui01-${how}.png`, fullPage: true });
		console.log("UI01", JSON.stringify({ how, active: state?.profile.id, asked, shown }));
		expect(shown.join(" ")).not.toContain("Alice private listening");
		// The account now signed in got its own answer, from its own request.
		expect(asked).toEqual(["A", how === "another" ? "B" : "A"]);
		expect(shown.join(" ")).toContain(`Alice for ${state?.profile.id}`);
	});
}

function contrast(fg: number[], bg: number[]): number {
	const l = (c: number[]) => {
		const [r, g, b] = c.map((v) => {
			const s = v / 255;
			return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
	};
	const [hi, lo] = [l(fg), l(bg)].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}

const CASES = [
	["day-320", 320, "day", true, "Wohnzimmer Lautsprecher"],
	["day-1280-long", 1280, "day", true, "Sehr langer Gerätename im Arbeitszimmer unter dem Dach"],
	["day-375-fixed", 375, "day", false, "Küchenradio"],
	["night-375", 375, "night", true, "Wohnzimmer Lautsprecher"],
	["night-375-fixed", 375, "night", false, "Küchenradio"],
] as const;

for (const [label, width, illumination, control, name] of CASES) {
	test(`UI-02: the volume readout is readable (${label})`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await quiet(page, illumination);
		const state = snapshot("A") as AppState & { observed?: unknown };
		state.observed = {
			state: "playing",
			checkedAt: TIME,
			track: { ...A },
			progressMs: 30_000,
			device: { id: "device-a", name, volume: 35, volumeControl: control },
			attribution: "outside",
			stationId: null,
			target: null,
		};
		await page.route("**/api/**", (r) => {
			const path = new URL(r.request().url()).pathname;
			if (path === "/api/state") return r.fulfill({ json: state });
			if (path.includes("native") || path.includes("home-assistant"))
				return r.fulfill({ json: { devices: [] } });
			return r.fulfill({ json: [] });
		});
		await page.goto("/");
		const el = page.locator(control ? ".volume__value" : ".volume--fixed");
		await expect(el).toBeVisible();
		await expect(el).toContainText(name);
		const colors = await el.evaluate((node) => {
			const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
			let p: Element | null = node;
			let bg = "";
			while (p) {
				bg = getComputedStyle(p).backgroundColor;
				if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") break;
				p = p.parentElement;
			}
			const fg = getComputedStyle(node).color;
			return { text: rgb(fg), bg: rgb(bg), raw: [fg, bg] };
		});
		const ratio = contrast(colors.text, colors.bg);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
		await el.screenshot({ path: `${OUT}/ui02-${label}.png` });
		await page.screenshot({ path: `${OUT}/ui02-${label}-page.png` });
		console.log(
			"UI02",
			label,
			JSON.stringify({ raw: colors.raw, ratio: Number(ratio.toFixed(3)), overflow }),
		);
		expect(overflow).toBe(0);
		expect(ratio).toBeGreaterThanOrEqual(4.5);
	});
}
