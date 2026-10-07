/**
 * Renders the PNG app icons for every design from
 * src/client/public/brand/<design>/icon.svg (the source of truth) into the
 * same folder: icon-192.png, icon-512.png and apple-touch-icon.png. The
 * default design's set is also copied to the public root for the manifest.
 * Run: npm run icons   (set CHROMIUM_PATH if Playwright has no browser)
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const DESIGNS = ["kontakt", "linie", "strich", "klassik"];
const DEFAULT = "kontakt";
const PREINSTALLED = [
	"/opt/pw-browsers/chromium",
	"/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
].find((path) => existsSync(path));
const executablePath = process.env.CHROMIUM_PATH ?? PREINSTALLED;

const browser = await chromium.launch(executablePath ? { executablePath } : {});
for (const design of DESIGNS) {
	const dir = `src/client/public/brand/${design}`;
	const svg = readFileSync(`${dir}/icon.svg`, "utf8");
	for (const [size, name, inset] of [
		[192, "icon-192.png", 0],
		[512, "icon-512.png", 0],
		[180, "apple-touch-icon.png", 0],
	]) {
		const ctx = await browser.newContext({ viewport: { width: size, height: size } });
		const page = await ctx.newPage();
		// Full-bleed square: the OS applies its own mask, so the rounded corner is dropped.
		const sized = svg
			.replace("<svg ", `<svg width="${size}" height="${size}" `)
			.replace(/<rect width="64" height="64" rx="14"/g, '<rect width="64" height="64" rx="0"');
		await page.setContent(`<html><body style="margin:0;padding:${inset}px">${sized}</body></html>`);
		await page.screenshot({
			path: `${dir}/${name}`,
			clip: { x: 0, y: 0, width: size, height: size },
		});
		await ctx.close();
	}
}
await browser.close();
for (const name of ["icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"])
	copyFileSync(`src/client/public/brand/${DEFAULT}/${name}`, `src/client/public/${name}`);
