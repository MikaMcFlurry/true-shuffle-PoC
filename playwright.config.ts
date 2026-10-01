import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/**
 * End-to-end: the real Worker (wrangler dev, fresh local state each run)
 * against the Spotify stand-in in e2e/fake-server.ts. One listener, one
 * story, so the tests run in order on one worker.
 */

const PREINSTALLED = [
	"/usr/bin/chromium",
	"/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
].find((path) => existsSync(path));
const executablePath = process.env.CHROMIUM_PATH ?? PREINSTALLED;

export default defineConfig({
	testDir: "e2e",
	testMatch: "*.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 90_000,
	expect: { timeout: 15_000 },
	reporter: [["list"]],
	outputDir: "e2e/.artifacts/results",
	use: {
		baseURL: "http://127.0.0.1:8787",
		locale: "de-DE",
		timezoneId: "Europe/Berlin",
		launchOptions: executablePath ? { executablePath } : {},
		trace: "retain-on-failure",
	},
	webServer: [
		{
			command: "node e2e/fake-server.ts",
			url: "http://127.0.0.1:8788/__control/status",
			reuseExistingServer: false,
			stdout: "ignore",
		},
		{
			command:
				"rm -rf e2e/.artifacts/state && npx vite build && npx wrangler dev -c wrangler.e2e.jsonc --port 8787 --ip 127.0.0.1 --persist-to e2e/.artifacts/state",
			url: "http://127.0.0.1:8787/api/health",
			reuseExistingServer: false,
			timeout: 180_000,
			stdout: "ignore",
		},
	],
});
