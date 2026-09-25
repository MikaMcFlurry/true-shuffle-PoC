import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// The client is a static SPA served by Workers Static Assets.
export default defineConfig({
	root: "src/client",
	publicDir: "public",
	plugins: [preact()],
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
