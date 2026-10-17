/**
 * The shared release record (TS-RELEASE-NOTICE-261017): one version for the
 * loaded page and the Worker's health, read from package.json and written
 * nowhere else; a date that is a day; at most three short changes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import pkg from "../../package.json";
import {
	isLater,
	MAX_CHANGES,
	RELEASE,
	releaseProblems,
	versionParts,
} from "../../src/shared/release";

it("takes its version from package.json and is a valid, short release", () => {
	expect(RELEASE.version).toBe(pkg.version);
	expect(releaseProblems(RELEASE)).toEqual([]);
	expect(RELEASE.changes.length).toBeGreaterThan(0);
	expect(RELEASE.changes.length).toBeLessThanOrEqual(MAX_CHANGES);
	expect(Object.isFrozen(RELEASE)).toBe(true);
	expect(Object.isFrozen(RELEASE.changes)).toBe(true);
});

it("keeps the known NP-OB-01 limit reachable with the notes", () => {
	expect(RELEASE.known).toMatch(/von Hand/);
	expect(RELEASE.known).toMatch(/Fortsetzung/);
});

it("finds what is wrong with a release record", () => {
	const ok = { version: "1.2.3", date: "2026-10-17", changes: ["a"], known: null };
	expect(releaseProblems(ok)).toEqual([]);
	expect(releaseProblems({ ...ok, version: "1.2" })).toHaveLength(1);
	expect(releaseProblems({ ...ok, date: "2026-02-30" })).toHaveLength(1);
	expect(releaseProblems({ ...ok, date: "17.10.2026" })).toHaveLength(1);
	expect(releaseProblems({ ...ok, changes: [] })).toHaveLength(1);
	expect(releaseProblems({ ...ok, changes: ["a", "b", "c", "d"] })).toHaveLength(1);
	expect(releaseProblems({ ...ok, changes: ["x".repeat(141)] })).toHaveLength(1);
	expect(releaseProblems({ ...ok, changes: [" "] })).toHaveLength(1);
});

it("orders versions by their numbers, and nothing else counts as one", () => {
	expect(versionParts("1.0.0")).toEqual([1, 0, 0]);
	expect(versionParts("1.0")).toBeNull();
	expect(versionParts("1.0.0-beta")).toBeNull();
	expect(versionParts("on")).toBeNull();
	expect(versionParts(null)).toBeNull();
	expect(isLater("1.0.1", "1.0.0")).toBe(true);
	expect(isLater("1.10.0", "1.9.9")).toBe(true);
	expect(isLater("2.0.0", "10.0.0")).toBe(false);
	expect(isLater("1.0.0", "1.0.0")).toBe(false);
	expect(isLater("0.9.9", "1.0.0")).toBe(false);
	expect(isLater("garbage", "1.0.0")).toBe(false);
	expect(isLater("1.0.1", "garbage")).toBe(false);
});

/** Every source file under a directory. */
function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
	});
}

it("the Worker's health names the shared release; no source repeats the version", () => {
	const worker = readFileSync("src/worker/index.ts", "utf8");
	expect(worker).toMatch(/import \{ RELEASE \} from "\.\.\/shared\/release";/);
	const health = /app\.get\("\/api\/health"[\s\S]*?\n\);/.exec(worker)?.[0] ?? "";
	expect(health).toMatch(/version: RELEASE\.version/);
	expect(health).toMatch(/released: RELEASE\.date/);
	const literal = new RegExp(`["'\`]${pkg.version.replaceAll(".", "\\.")}["'\`]`);
	const repeated = ["src/client", "src/worker", "src/shared"]
		.flatMap(sources)
		.filter((f) => literal.test(readFileSync(f, "utf8")));
	expect(repeated).toEqual([]);
});
