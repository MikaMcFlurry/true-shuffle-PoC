import { defineConfig } from "@playwright/test";

/**
 * PR35 regressions against the client with synthetic /api answers: two
 * made-up accounts and a made-up device. Never a real account or session.
 * Run: npx playwright test -c e2e/review/pr35.config.ts (PR35_OUT=<dir> keeps the evidence).
 */
export default defineConfig({
	testDir: ".",
	testMatch: "pr35.fixture.ts",
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	outputDir: "../.artifacts/pr35-results",
	use: {
		baseURL: "http://127.0.0.1:8841",
		locale: "de-DE",
		timezoneId: "Europe/Berlin",
		viewport: { width: 375, height: 812 },
	},
	webServer: {
		command: "npx vite -c e2e/review/vite.pr35.config.ts",
		cwd: "../..",
		url: "http://127.0.0.1:8841",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
