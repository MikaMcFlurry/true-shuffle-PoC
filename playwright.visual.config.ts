import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

/**
 * U1 (1.3.0): the UI bug pass on phones, a tablet and desktops, in the three
 * engines (WebKit for iOS Safari, Chromium for Android Chrome and desktop,
 * Firefox), portrait and landscape. Same Worker and Spotify stand-in as the
 * functional suite; only synthetic data. Milestone-only (CI: workflow_dispatch
 * with visual), never on every push.
 *
 * TS_VISUAL_ENGINES=chromium,webkit limits the engines for a local run.
 */

type Device = { name: string; use: Record<string, unknown> };
const phone = (name: string, d: (typeof devices)[string], width?: number): Device[] => {
	const vp = width
		? { width, height: Math.round((d.viewport.height * width) / d.viewport.width) }
		: d.viewport;
	return [
		{ name, use: { ...d, viewport: vp } },
		{ name: `${name}-quer`, use: { ...d, viewport: { width: vp.height, height: vp.width } } },
	];
};
const DEVICES: Device[] = [
	...phone("iphone-se-320", devices["iPhone SE"], 320),
	...phone("iphone-se-375", devices["iPhone SE"]),
	...phone("iphone-15-393", devices["iPhone 15"]),
	...phone("pixel-7-412", devices["Pixel 7"]),
	{ name: "ipad-mini", use: { ...devices["iPad Mini"] } },
	{ name: "ipad-mini-quer", use: { ...devices["iPad Mini landscape"] } },
	// 1280 px at 200 % zoom lays out like 640 px.
	{
		name: "desktop-640-zoom200",
		use: { viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 },
	},
	{ name: "desktop-1280", use: { viewport: { width: 1280, height: 800 } } },
	{ name: "desktop-1920", use: { viewport: { width: 1920, height: 1080 } } },
];
const ENGINES = (process.env.TS_VISUAL_ENGINES ?? "chromium,firefox,webkit").split(",");

export default defineConfig({
	...base,
	testDir: "e2e-visual",
	testMatch: "*.spec.ts",
	outputDir: "e2e/.artifacts/visual-results",
	timeout: 180_000,
	projects: ENGINES.flatMap((engine) =>
		DEVICES.filter((d) => engine !== "firefox" || !("isMobile" in d.use) || !d.use.isMobile).map(
			(d) => ({
				name: `${engine}:${d.name}`,
				use: {
					...base.use,
					...d.use,
					// Firefox has no mobile emulation: it gets the plain viewport.
					...(engine === "firefox" ? { isMobile: undefined, hasTouch: undefined } : {}),
					browserName: engine as "chromium" | "firefox" | "webkit",
					launchOptions: {},
					locale: "de-DE",
					timezoneId: "Europe/Berlin",
				},
			}),
		),
	),
});
