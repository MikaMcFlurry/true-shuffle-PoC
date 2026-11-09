import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// The fallback surface (docs/FALLBACK_8D_UI.md): the 8d client with its
// compatibility changes, built to the same place as the current client, so the
// unchanged wrangler.jsonc serves it with the current Worker. Otherwise the
// same build as vite.config.ts.
export default defineConfig({
	root: "src/client-fallback-8d",
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
});
