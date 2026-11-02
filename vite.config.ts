import { execSync } from "node:child_process";
import preact from "@preact/preset-vite";
import { defineConfig, type Plugin } from "vite";
import { version } from "./package.json";

/**
 * The build id: the commit Workers Builds builds from, else the local commit,
 * else the time. Unlike the version it changes with every deploy, so an open
 * page can tell that a newer one is live (src/client/app-update.ts).
 */
function buildId(): string {
	const ci = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.GITHUB_SHA;
	if (ci) return ci.slice(0, 12);
	try {
		return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
	} catch {
		return `local-${Date.now().toString(36)}`;
	}
}
const BUILD_ID = buildId();

/** /build.json: what the newest deploy is, read by open pages (never cached, see _headers). */
function buildFile(): Plugin {
	return {
		name: "ts-build-file",
		generateBundle() {
			this.emitFile({
				type: "asset",
				fileName: "build.json",
				source: `${JSON.stringify({ version, build: BUILD_ID })}\n`,
			});
		},
	};
}

// The client is a static SPA served by Workers Static Assets.
export default defineConfig({
	root: "src/client",
	publicDir: "public",
	plugins: [preact(), buildFile()],
	define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
	build: {
		outDir: "../../dist/client",
		emptyOutDir: true,
		target: "es2022",
		sourcemap: true,
		// Fonts and images ship as files: the CSP allows no data: fonts.
		assetsInlineLimit: 0,
	},
	server: {
		proxy: {
			"/api": "http://127.0.0.1:8787",
			"/auth": "http://127.0.0.1:8787",
		},
	},
});
