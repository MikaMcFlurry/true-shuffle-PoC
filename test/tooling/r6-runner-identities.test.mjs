// The R6 runner (scripts/verification/r6-run.mjs) must accept a Playwright run only when it
// executed exactly the tests the list selected: same file, suite path, title, position,
// project and spec id. Equal counts are not enough. Each case runs the real runner in a
// throwaway git repo whose `npx` is a stand-in that writes a JSON fixture as the
// Playwright list/run report. The runner imports playwright-identities.mjs, which lies outside
// that throwaway repo (and its git status), so the runner must bind the helper bytes itself.
// Run: node --test test/tooling/r6-runner-identities.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../../scripts/verification/r6-run.mjs", import.meta.url));
const helper = fileURLToPath(
	new URL("../../scripts/verification/playwright-identities.mjs", import.meta.url),
);
const fixtures = fileURLToPath(new URL("./fixtures/r6-runner-identities/", import.meta.url));
const DIR = "e2e/.artifacts/rsr-261016-r6";
const WRAPPER = `${DIR}/playwright.fixture.config.ts`;
const SPEC = "e2e/r6-fixture.spec.ts";

let root;
let repo;
let bin;

before(() => {
	root = mkdtempSync(join(tmpdir(), "r6-runner-identities-"));
	repo = join(root, "repo");
	bin = join(root, "bin");
	mkdirSync(join(repo, DIR), { recursive: true });
	mkdirSync(bin);
	writeFileSync(join(repo, ".gitignore"), "e2e/.artifacts/\n");
	writeFileSync(join(repo, "playwright.config.ts"), "export default {};\n");
	writeFileSync(join(repo, SPEC), "// stand-in spec; the reports come from fixtures\n");
	writeFileSync(join(repo, WRAPPER), "export default {};\n");
	const init = spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
	assert.equal(init.status, 0, init.stderr);
	// `npx --no-install playwright test ... [--list] ...` -> copy the fixture named by
	// R6_FAKE_LIST / R6_FAKE_RUN to PLAYWRIGHT_JSON_OUTPUT_NAME (empty name: write no report).
	// R6_FAKE_MUTATE: during the run step, append a line to that file (mutation control).
	writeFileSync(
		join(bin, "fake-npx.mjs"),
		[
			'import { appendFileSync, copyFileSync } from "node:fs";',
			'const list = process.argv.includes("--list");',
			'if (!list && process.env.R6_FAKE_MUTATE) appendFileSync(process.env.R6_FAKE_MUTATE, "// mutated\\n");',
			"const name = list ? process.env.R6_FAKE_LIST : process.env.R6_FAKE_RUN;",
			'if (name) copyFileSync(process.env.R6_FAKE_DIR + "/" + name, process.env.PLAYWRIGHT_JSON_OUTPUT_NAME);',
			'console.log("fake " + (list ? "list" : "run") + ": " + (name || "(no report)"));',
			'process.exit(list ? 0 : Number(process.env.R6_FAKE_EXIT ?? "0"));',
			"",
		].join("\n"),
	);
	writeFileSync(join(bin, "npx.cmd"), '@node "%~dp0fake-npx.mjs" %*\r\n');
	writeFileSync(join(bin, "npx"), '#!/bin/sh\nexec node "$(dirname "$0")/fake-npx.mjs" "$@"\n');
	chmodSync(join(bin, "npx"), 0o755);
});

const runR6 = (label, list, run, { runnerPath = runner, extraEnv = {} } = {}) => {
	const env = { ...process.env };
	const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	env[pathKey] = `${bin}${process.platform === "win32" ? ";" : ":"}${env[pathKey] ?? ""}`;
	Object.assign(env, {
		R6_FAKE_DIR: fixtures,
		R6_FAKE_LIST: list,
		R6_FAKE_RUN: run,
		RSR_PORT: "1",
		RSR_INSPECTOR_PORT: "2",
		...extraEnv,
	});
	const r = spawnSync(process.execPath, [runnerPath, label, "pw", WRAPPER, SPEC], {
		cwd: repo,
		env,
		encoding: "utf8",
	});
	const record = JSON.parse(readFileSync(join(repo, DIR, `${label}.json`), "utf8"));
	return { exit: r.status, record, output: `${r.stdout}${r.stderr}` };
};

const green = (label, list, run) => {
	const { exit, record, output } = runR6(label, list, run);
	assert.equal(record.report?.tests?.length, 3, output);
	assert.deepEqual(record.validation.problems, []);
	assert.equal(record.validation.pass, true);
	assert.equal(exit, 0, output);
};

const red = (label, list, run, reason) => {
	const { exit, record, output } = runR6(label, list, run);
	assert.equal(
		record.validation.pass,
		false,
		`runner accepted ${run || "(no run report)"}: ${output}`,
	);
	assert.notEqual(exit, 0, output);
	assert.ok(
		record.validation.problems.some((p) => reason.test(p)),
		`no problem matching ${reason}: ${JSON.stringify(record.validation.problems)}`,
	);
};

test("accepts a run with exactly the listed identities", () =>
	green("same", "list.json", "run-same.json"));

test("accepts the listed identities in another order", () =>
	green("reordered", "list.json", "run-reordered.json"));

test("rejects a run with the same count where one listed test was swapped for another", () =>
	red("swapped", "list.json", "run-swapped.json", /identit.*not run.*gamma shows the sheet/));

test("rejects a run with the same count where one test ran twice", () =>
	red("duplicate", "list.json", "run-duplicate.json", /duplicate.*alpha keeps its value/));

test("rejects a run where a test ran under another project", () =>
	red("wrong-project", "list.json", "run-wrong-project.json", /project/));

test("rejects a run where a test was reported in another suite", () =>
	red(
		"other-suite",
		"list.json",
		"run-other-suite.json",
		/identit.*Group B.*beta sends the retry/,
	));

test("rejects a missing run report", () => red("no-run-report", "list.json", "", /no report/));

test("rejects a missing list report", () =>
	red("no-list-report", "", "run-same.json", /no test list|list report/));

test("rejects a test that passed only on retry", () =>
	red("retry", "list.json", "run-retry.json", /retr/));

test("rejects a skipped test", () =>
	red("skip", "list.json", "run-skip.json", /skipped|status skipped/));

test("rejects an expected failure", () =>
	red("expected-failure", "list.json", "run-expected-failure.json", /expectedStatus failed/));

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const key = (p) => p.split("\\").join("/");

// A private copy of the runner and its helper, so a control can change the helper bytes
// without touching the checkout.
const runnerCopy = (name) => {
	const d = join(root, name, "scripts", "verification");
	mkdirSync(d, { recursive: true });
	copyFileSync(runner, join(d, "r6-run.mjs"));
	copyFileSync(helper, join(d, "playwright-identities.mjs"));
	return { runner: join(d, "r6-run.mjs"), helper: join(d, "playwright-identities.mjs") };
};

test("binds the bytes of the imported identity helper before and after the run", () => {
	const { exit, record, output } = runR6("helper-bound", "list.json", "run-same.json");
	assert.equal(exit, 0, output);
	const expected = sha256(helper);
	assert.equal(record.before.files[key(helper)], expected, "helper not hashed before the run");
	assert.equal(record.after.files[key(helper)], expected, "helper not hashed after the run");
	assert.equal(record.before.files[key(runner)], sha256(runner), "runner not hashed before");
});

test("rejects a run during which the imported identity helper changed", () => {
	const copy = runnerCopy("mutated-helper");
	const { exit, record, output } = runR6("helper-mutated", "list.json", "run-same.json", {
		runnerPath: copy.runner,
		extraEnv: { R6_FAKE_MUTATE: copy.helper },
	});
	assert.notEqual(
		record.before.files[key(copy.helper)],
		record.after.files[key(copy.helper)],
		`helper change not seen: ${JSON.stringify(record.after.files)}`,
	);
	assert.equal(record.validation.pass, false, `runner accepted a changed helper: ${output}`);
	assert.notEqual(exit, 0, output);
	assert.ok(
		record.validation.problems.some((p) => /before\/after hashes/.test(p)),
		JSON.stringify(record.validation.problems),
	);
	assert.ok(
		record.validation.problems.includes(
			`identity helper bytes loaded != after: ${key(copy.helper)}`,
		),
		JSON.stringify(record.validation.problems),
	);
});

test("binds the helper copy the runner actually imports, not the checkout one", () => {
	const copy = runnerCopy("changed-helper");
	writeFileSync(copy.helper, `${readFileSync(copy.helper, "utf8")}// changed copy\n`);
	const { exit, record, output } = runR6("helper-copy", "list.json", "run-same.json", {
		runnerPath: copy.runner,
	});
	assert.equal(exit, 0, output);
	assert.equal(record.before.files[key(copy.helper)], sha256(copy.helper));
	assert.notEqual(record.before.files[key(copy.helper)], sha256(helper));
	assert.equal(record.before.files[key(helper)], undefined);
});
