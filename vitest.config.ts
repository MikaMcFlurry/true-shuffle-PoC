import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		testTimeout: 20_000,
		// The hub logs every event to the console for the Worker's logs; in
		// tests that is noise unless a test fails.
		silent: "passed-only",
	},
});
