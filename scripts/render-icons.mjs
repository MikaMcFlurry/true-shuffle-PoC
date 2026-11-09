/**
 * Renders the PNG app icons from src/client/public/icon.svg (the source of
 * truth): icon-192.png, icon-512.png and apple-touch-icon.png.
 * Run: npm run icons   (set CHROMIUM_PATH if Playwright has no browser)
 */

import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const PREINSTALLED = [
	"/opt/pw-browsers/chromium",
	"/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
].find((path) => existsSync(path));
const executablePath = process.env.CHROMIUM_PATH ?? PREINSTALLED;

const dir = "src/client/public";
const svg = readFileSync(`${dir}/icon.svg`, "utf8");
const browser = await chromium.launch(executablePath ? { executablePath } : {});
for (const [size, name] of [
	[192, "icon-192.png"],
	[512, "icon-512.png"],
	[180, "apple-touch-icon.png"],
]) {
	const ctx = await browser.newContext({ viewport: { width: size, height: size } });
	const page = await ctx.newPage();
	// Full-bleed square: the OS applies its own mask, so the rounded corner is dropped.
	const sized = svg
		.replace("<svg ", `<svg width="${size}" height="${size}" `)
		.replace(/<rect width="64" height="64" rx="14"/g, '<rect width="64" height="64" rx="0"');
	await page.setContent(`<html><body style="margin:0">${sized}</body></html>`);
	await page.screenshot({
		path: `${dir}/${name}`,
		clip: { x: 0, y: 0, width: size, height: size },
	});
	await ctx.close();
}
await browser.close();
