// Runs the unit/Worker tests and compares the failures with the known ones
// (test/known-failures.json): any other failure fails, and so does a
// known one that passes now (so the list only ever shrinks). Honest gate:
// never green on a new failure, never silently hiding a fixed one.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const known = new Set(JSON.parse(readFileSync("test/known-failures.json", "utf8")).tests);
const out = join(tmpdir(), `ts-vitest-${process.pid}.json`);
const run = spawnSync(
	"npx",
	["vitest", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${out}`],
	{
		stdio: ["inherit", "pipe", "pipe"],
		shell: process.platform === "win32",
		maxBuffer: 256 * 1024 * 1024,
	},
);
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
// Errors outside any test (an unhandled rejection) fail the run but no test (re-check M3).
const unhandled = /Unhandled (Rejection|Errors?)/.test(`${run.stdout}${run.stderr}`);
let report;
try {
	report = JSON.parse(readFileSync(out, "utf8"));
} catch {
	console.error("known-failures: no test report (vitest exit %s)", run.status);
	process.exit(1);
} finally {
	rmSync(out, { force: true });
}
const failed = [];
const passed = new Set();
for (const file of report.testResults ?? [])
	for (const t of file.assertionResults ?? []) {
		const name = [...(t.ancestorTitles ?? []), t.title].join(" > ");
		if (t.status === "failed") failed.push(name);
		else if (t.status === "passed") passed.add(name);
	}
const unexpected = failed.filter((n) => !known.has(n));
const fixed = [...known].filter((n) => passed.has(n));
const missing = [...known].filter((n) => !passed.has(n) && !failed.includes(n));
console.log(
	`known-failures: ${report.numPassedTests} passed, ${failed.length} failed (${failed.length - unexpected.length} known)`,
);
for (const n of unexpected) console.error(`NEW FAILURE: ${n}`);
for (const n of fixed) console.error(`KNOWN FAILURE NOW PASSES (remove it from the list): ${n}`);
for (const n of missing) console.error(`KNOWN FAILURE NOT RUN: ${n}`);
// A file that failed without a failing test in it did not load or run (red-team M3).
const broken = (report.testResults ?? []).filter(
	(file) =>
		file.status === "failed" && !(file.assertionResults ?? []).some((t) => t.status === "failed"),
);
for (const file of broken) console.error(`TEST FILE FAILED TO RUN: ${file.name}`);
if (broken.length > 0) process.exit(1);
if (unhandled) {
	console.error("known-failures: vitest reported unhandled errors");
	process.exit(1);
}
process.exit(unexpected.length || fixed.length || missing.length ? 1 : 0);
