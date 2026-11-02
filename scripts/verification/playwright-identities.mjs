// Exact test identities from a Playwright JSON report (`--list` or a run) and their comparison,
// for the R6 runner (r6-run.mjs). One identity per test entry: project (name and id), spec
// file, describe-suite path, title, position (line, column) and the spec id when present.
// Execution order is not part of an identity.
const norm = (p) =>
	String(p ?? "")
		.split("\\")
		.join("/")
		.replace(/^\/+/, "");

/** Every test of the report with its identity, in report order. */
export const testsOf = (report) => {
	const out = [];
	const walk = (suite, suitePath, file) => {
		for (const spec of suite.specs ?? [])
			for (const t of spec.tests ?? [])
				out.push({
					identity: {
						project: t.projectName ?? null,
						projectId: t.projectId ?? null,
						file: norm(spec.file ?? file),
						suite: suitePath,
						title: spec.title,
						line: spec.line,
						column: spec.column,
						specId: spec.id ?? null,
					},
					test: t,
				});
		for (const s of suite.suites ?? []) walk(s, [...suitePath, s.title], s.file ?? file);
	};
	// Top-level suites are the spec files; nested ones are describe blocks.
	for (const fileSuite of report?.suites ?? []) walk(fileSuite, [], fileSuite.file);
	return out;
};

export const identityKey = (i) =>
	JSON.stringify([i.project, i.projectId, i.file, i.suite, i.title, i.line, i.column, i.specId]);

export const describeIdentity = (i) =>
	`[project ${JSON.stringify(i.project)}${i.projectId === i.project ? "" : ` id ${JSON.stringify(i.projectId)}`}] ${i.file}:${i.line}:${i.column} ${[...i.suite, i.title].join(" > ")}${i.specId ? ` (${i.specId})` : ""}`;

const counts = (ids) => {
	const m = new Map();
	for (const i of ids) {
		const k = identityKey(i);
		m.set(k, { identity: i, n: (m.get(k)?.n ?? 0) + 1 });
	}
	return m;
};

/** Problems when the run did not execute exactly the listed identities (any order). */
export const compareIdentities = (listed, ran) => {
	const problems = [];
	const l = counts(listed);
	const r = counts(ran);
	for (const [what, m] of [
		["listed", l],
		["ran", r],
	])
		for (const { identity, n } of m.values())
			if (n > 1) problems.push(`duplicate identity ${what} ${n}x: ${describeIdentity(identity)}`);
	for (const [k, { identity }] of l)
		if (!r.has(k)) problems.push(`listed identity not run: ${describeIdentity(identity)}`);
	for (const [k, { identity }] of r)
		if (!l.has(k)) problems.push(`ran identity not listed: ${describeIdentity(identity)}`);
	return problems;
};

/** Problems when a test's project is not one of the projects the report's config declares. */
export const undeclaredProjects = (report, ids, what) => {
	const declared = (report?.config?.projects ?? []).map((p) =>
		JSON.stringify([p.name ?? null, p.id ?? null]),
	);
	return ids
		.filter((i) => !declared.includes(JSON.stringify([i.project, i.projectId])))
		.map((i) => `${what} project not declared by the config: ${describeIdentity(i)}`);
};
