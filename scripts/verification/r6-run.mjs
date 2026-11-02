// R6 bound runner (copy of R5 v2 with R6 paths; unversioned, TS-FIX-261016-R6). Usage from the repo root:
//   node e2e/.artifacts/rsr-261016-r6/run.mjs <label> pw <wrapper> <spec files...>
// (older usage lines below kept from R3)
//   node e2e/.artifacts/rsr-261016-r3/run.mjs <label> pw <spec files...>
//   node e2e/.artifacts/rsr-261016-r3/run.mjs <label> vitest <test files...>
// Records, before and after: this runner's own bytes, the wrapper and the base config it
// imports, every named test file, the product file under repair, the lockfile, HEAD/tree,
// status and the full working diff (saved). For Playwright it first lists the tests the
// filter selects, then runs with a JSON report; the executed files/tests/statuses/retries
// are taken from that report, not from the arguments. Full raw logs are kept.
// v4 (TS-RUNNER-IDENTITY): the run must execute exactly the listed test identities
// (playwright-identities.mjs), not just the same number of tests; order may differ.
// v5 (TS-RUNNER-BINDING-COR1): that helper is part of the run binding. Its bytes are read
// once, imported from exactly those bytes and hashed before/after like the runner itself,
// also when the runner lies outside the repo under test (and its git status).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./playwright-identities.mjs", import.meta.url));
const helperBytes = readFileSync(helper);
const { compareIdentities, testsOf, undeclaredProjects } = await import(
	`data:text/javascript;base64,${helperBytes.toString("base64")}`
);

const [label, kind, ...rest] = process.argv.slice(2);
const wrapperArg = kind === "pw" ? rest[0] : undefined;
const files = kind === "pw" ? rest.slice(1) : rest;
if (!label || !["pw", "vitest"].includes(kind) || files.length === 0)
	throw new Error("usage: run.mjs <label> pw|vitest <files...>");
const dir = "e2e/.artifacts/rsr-261016-r6";
const self = fileURLToPath(import.meta.url);
const wrapper = wrapperArg ?? "";
if (kind === "pw" && !wrapper.startsWith(`${dir}/`)) throw new Error("pw needs an R6 wrapper path");
const base = kind === "pw" ? "playwright.config.ts" : "vitest.config.ts";
const sha = (p) =>
	existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
const shaText = (t) => createHash("sha256").update(t).digest("hex");
const git = (...a) => {
	const r = spawnSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 });
	return { argv: ["git", ...a], exit: r.status, out: r.stdout };
};
const env = {
	RSR_PORT: process.env.RSR_PORT ?? "",
	RSR_INSPECTOR_PORT: process.env.RSR_INSPECTOR_PORT ?? "",
	...(process.env.FAKE_PORT ? { FAKE_PORT: process.env.FAKE_PORT } : {}),
	...(process.env.RSR_RUN ? { RSR_RUN: process.env.RSR_RUN } : {}),
	CHROMIUM_PATH: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	WRANGLER_SEND_METRICS: "false",
	NO_UPDATE_NOTIFIER: "1",
	HTTP_PROXY: "http://127.0.0.1:9",
	HTTPS_PROXY: "http://127.0.0.1:9",
	NO_PROXY: "127.0.0.1,localhost",
};
const bound = [
	self,
	helper,
	...(kind === "pw" ? [wrapper] : []),
	base,
	...files,
	"src/shared/api.ts",
	"src/worker/hub/hub.ts",
	"src/client/store.ts",
	"src/client/history-ratings.ts",
	"test/client/rate-sheet-list-freshness.repro.test.ts",
	"e2e/rate-sheet-retry-values.spec.ts",
	"package-lock.json",
];
const snapshot = (when) => {
	const diff = git("diff", "--binary", "HEAD");
	const untracked = git("ls-files", "--others", "--exclude-standard")
		.out.split("\n")
		.filter(Boolean);
	writeFileSync(`${dir}/${label}.${when}.diff`, diff.out);
	return {
		at: new Date().toISOString(),
		head: git("rev-parse", "HEAD").out.trim(),
		tree: git("rev-parse", "HEAD^{tree}").out.trim(),
		branch: git("branch", "--show-current").out.trim(),
		status: git("status", "--porcelain=v1").out,
		workingDiff: {
			file: `${dir}/${label}.${when}.diff`,
			sha256: shaText(diff.out),
			exit: diff.exit,
		},
		untracked: untracked.map((p) => ({ path: p, sha256: sha(p) })),
		files: Object.fromEntries(bound.map((p) => [p.split("\\").join("/"), sha(p)])),
	};
};
const run = (name, argv, extraEnv = {}) => {
	const started = new Date().toISOString();
	const r = spawnSync(argv.join(" "), {
		shell: true,
		encoding: "utf8",
		env: { ...process.env, ...env, ...extraEnv },
		maxBuffer: 1 << 28,
	});
	const log = `${dir}/${label}.${name}.log`;
	writeFileSync(log, `${r.stdout ?? ""}${r.stderr ?? ""}`);
	return {
		argv,
		env: { ...env, ...extraEnv },
		started,
		ended: new Date().toISOString(),
		exit: r.status,
		log,
		logSha256: sha(log),
	};
};

const record = {
	runId: "TS-FIX-261016-R6",
	label,
	kind,
	cwd: process.cwd(),
	identityHelper: { path: helper.split("\\").join("/"), sha256: shaText(helperBytes) },
	before: snapshot("before"),
};
if (kind === "pw") {
	const listJson = resolve(`${dir}/${label}.list.json`);
	record.list = run(
		"list",
		[
			"npx",
			"--no-install",
			"playwright",
			"test",
			"-c",
			wrapper,
			"--list",
			"--reporter=json",
			...files,
		],
		{ PLAYWRIGHT_JSON_OUTPUT_NAME: listJson },
	);
	const reportJson = resolve(`${dir}/${label}.report.json`);
	record.run = run(
		"run",
		["npx", "--no-install", "playwright", "test", "-c", wrapper, "--reporter=list,json", ...files],
		{ PLAYWRIGHT_JSON_OUTPUT_NAME: reportJson },
	);
	const walk = (r) =>
		testsOf(r).map(({ identity, test: t }) => ({
			file: identity.file,
			line: identity.line,
			title: identity.title,
			identity,
			expectedStatus: t.expectedStatus,
			status: t.status,
			attempts: (t.results ?? []).map((x) => ({
				status: x.status,
				retry: x.retry,
				errors: (x.errors ?? []).length,
			})),
			annotations: t.annotations ?? [],
		}));
	const parse = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
	const list = parse(listJson);
	const report = parse(reportJson);
	const listedTests = list ? walk(list) : null;
	record.listed = listedTests ? listedTests.map((t) => `${t.file}:${t.line} ${t.title}`) : null;
	record.listedIdentities = listedTests ? listedTests.map((t) => t.identity) : null;
	record.listProjects = list
		? (list.config?.projects ?? []).map((p) => ({ name: p.name, id: p.id }))
		: null;
	record.listUndeclaredProjects = list
		? undeclaredProjects(list, record.listedIdentities, "listed")
		: null;
	record.listJsonSha256 = sha(listJson);
	record.report = report
		? {
				file: reportJson,
				sha256: sha(reportJson),
				configFile: report.config?.configFile,
				projects: (report.config?.projects ?? []).map((p) => ({
					name: p.name,
					id: p.id,
					retries: p.retries,
					testDir: p.testDir,
					testMatch: p.testMatch,
				})),
				stats: report.stats,
				tests: walk(report),
			}
		: null;
	if (record.report)
		record.report.undeclaredProjects = undeclaredProjects(
			report,
			record.report.tests.map((t) => t.identity),
			"ran",
		);
	if (record.report) {
		const files = [...new Set(record.report.tests.map((t) => t.file))];
		record.executedSpecs = files.map((f) => ({ file: f, sha256: sha(`e2e/${f}`) ?? sha(f) }));
	}
} else {
	const reportJson = resolve(`${dir}/${label}.report.json`);
	record.run = run("run", [
		"npx",
		"--no-install",
		"vitest",
		"run",
		"--reporter=default",
		"--reporter=json",
		`--outputFile.json=${reportJson}`,
		...files,
	]);
	const report = existsSync(reportJson) ? JSON.parse(readFileSync(reportJson, "utf8")) : null;
	record.report = report
		? {
				file: reportJson,
				sha256: sha(reportJson),
				numTotalTests: report.numTotalTests,
				numPassedTests: report.numPassedTests,
				numFailedTests: report.numFailedTests,
				numPendingTests: report.numPendingTests,
				numTodoTests: report.numTodoTests,
				files: (report.testResults ?? []).map((f) => ({
					file: f.name.split(process.cwd()).join("").split("\\").join("/"),
					sha256: sha(f.name),
					status: f.status,
					tests: (f.assertionResults ?? []).map((a) => ({ title: a.fullName, status: a.status })),
				})),
			}
		: null;
}
record.after = snapshot("after");
record.unchanged =
	JSON.stringify(record.before.files) === JSON.stringify(record.after.files) &&
	record.before.workingDiff.sha256 === record.after.workingDiff.sha256 &&
	record.before.head === record.after.head &&
	record.before.status === record.after.status;

// Validation (runner v5): any missing report, unbound or drifting file (the identity helper
// included), skipped/retried/
// expected-to-fail test, or a list whose test identities differ from what ran makes the runner FAIL.
const problems = [];
const check = (ok, what) => {
	if (!ok) problems.push(what);
};
const norm = (p) => String(p).split("\\").join("/").replace(/^\/+/, "");
const asked = files.map(norm);
check(record.unchanged, "before/after hashes, HEAD, status or working diff differ");
for (const when of ["before", "after"])
	check(
		record[when].files[record.identityHelper.path] === record.identityHelper.sha256,
		`identity helper bytes loaded != ${when}: ${record.identityHelper.path}`,
	);
check(record.run.exit === 0, `run exit ${record.run.exit}`);
check(!!record.report, "no report");
if (kind === "pw" && record.report) {
	const r = record.report;
	check(record.list?.exit === 0, `list exit ${record.list?.exit}`);
	check(Array.isArray(record.listed), "no test list");
	check(
		record.listed?.length === r.tests.length,
		`listed ${record.listed?.length} != ran ${r.tests.length}`,
	);
	if (Array.isArray(record.listedIdentities)) {
		for (const p of compareIdentities(
			record.listedIdentities,
			r.tests.map((t) => t.identity),
		))
			check(false, p);
		for (const p of [...record.listUndeclaredProjects, ...r.undeclaredProjects]) check(false, p);
		const projects = (ps) => JSON.stringify(ps.map((p) => [p.name, p.id]));
		check(
			projects(record.listProjects) === projects(r.projects),
			`projects listed ${projects(record.listProjects)} != ran ${projects(r.projects)}`,
		);
	}
	check(r.tests.length > 0, "no tests ran");
	check(norm(r.configFile ?? "").endsWith(norm(wrapper)), `config file ${r.configFile}`);
	check(
		r.projects.every((p) => p.retries === 0),
		"retries configured",
	);
	check(
		r.stats?.unexpected === 0 && r.stats?.skipped === 0 && r.stats?.flaky === 0,
		`stats ${JSON.stringify(r.stats)}`,
	);
	check(r.stats?.expected === r.tests.length, "not every test expected-passed");
	for (const t of r.tests) {
		check(t.expectedStatus === "passed", `${t.title}: expectedStatus ${t.expectedStatus}`);
		check(t.status === "expected", `${t.title}: status ${t.status}`);
		check(
			t.attempts.length === 1 && t.attempts[0].retry === 0 && t.attempts[0].status === "passed",
			`${t.title}: attempts ${JSON.stringify(t.attempts)}`,
		);
		check(
			t.annotations.every((a) => a.type === "serial"),
			`${t.title}: annotations ${JSON.stringify(t.annotations)}`,
		);
	}
	const ran = (record.executedSpecs ?? []).map((s) => ({ ...s, path: `e2e/${norm(s.file)}` }));
	check(
		ran.length === asked.length && asked.every((a) => ran.some((s) => s.path === a)),
		`executed specs ${JSON.stringify(ran.map((s) => s.path))} != asked ${JSON.stringify(asked)}`,
	);
	for (const s of ran)
		check(s.sha256 && s.sha256 === record.before.files[s.path], `spec hash not bound: ${s.path}`);
}
if (kind === "vitest" && record.report) {
	const r = record.report;
	check(
		r.numFailedTests === 0 && r.numPendingTests === 0 && r.numTodoTests === 0,
		"failed/pending/todo tests",
	);
	check(r.numTotalTests > 0 && r.numPassedTests === r.numTotalTests, "not every test passed");
	const ran = r.files.map((f) => norm(f.file));
	check(
		ran.length === asked.length && asked.every((a) => ran.some((f) => f.endsWith(a))),
		`executed files ${JSON.stringify(ran)} != asked ${JSON.stringify(asked)}`,
	);
	for (const f of r.files) {
		const a = asked.find((x) => norm(f.file).endsWith(x));
		check(!!a && f.sha256 === record.before.files[a], `test file hash not bound: ${f.file}`);
		check(
			f.tests.length > 0 && f.tests.every((t) => t.status === "passed"),
			`${f.file}: not all passed`,
		);
	}
}
record.validation = { runner: "v5", pass: problems.length === 0, problems };
writeFileSync(`${dir}/${label}.json`, `${JSON.stringify(record, null, 2)}\n`);
console.log(
	JSON.stringify({
		label,
		exit: record.run.exit,
		listExit: record.list?.exit,
		stats: record.report?.stats ?? {
			total: record.report?.numTotalTests,
			passed: record.report?.numPassedTests,
			failed: record.report?.numFailedTests,
			pending: record.report?.numPendingTests,
		},
		unchanged: record.unchanged,
		validation: record.validation,
	}),
);
process.exit(problems.length === 0 ? 0 : record.run.exit || 3);
