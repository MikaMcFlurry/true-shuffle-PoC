// Generates isolated DO probe harnesses for one checkout (author-owned, evidence only).
// Usage: node make-do.mjs <label> <checkout> <portBase> <persistRoot>
// - reviewer copies: clock-fault / clock-shell worker+spec, byte-identical except the
//   candidate import path (-> <checkout>) and the playwright import path; configs own ports/output/persistence.
// - own probe: do-atomic worker+spec (fault points before/at/after the commit number, retry, duplicate, reopen).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [label, checkoutArg, base, persistArg] = process.argv.slice(2);
const E = "C:/Users/mikah/Documents/Codex/2026-10-13/task-5/delta4-evidence-6408961";
const root = resolve(".").replaceAll("\\", "/");
const checkout = resolve(checkoutArg).replaceAll("\\", "/");
const persist = resolve(persistArg).replaceAll("\\", "/");
const port = Number(base);
const dir = `${root}/${label}`;
mkdirSync(dir, { recursive: true });
for (const d of ["home/AppData/Roaming", "home/AppData/Local", "config", "cache"])
	mkdirSync(`${root}/${d}`, { recursive: true });
mkdirSync(`${persist}/tmp`, { recursive: true });

const retarget = (name, out) => {
	let s = readFileSync(`${E}/${name}`, "utf8");
	const n = s.split("../delta4-candidate-6408961/").length - 1;
	s = s.replaceAll("../delta4-candidate-6408961/", `${checkout}/`);
	writeFileSync(`${dir}/${out}`, s);
	return n;
};
const changed = {};
for (const f of ["clock-fault-worker.ts", "clock-fault.spec.ts", "clock-shell-worker.ts", "clock-shell.spec.ts"])
	changed[f] = retarget(f, f);
writeFileSync(`${dir}/do-atomic-worker.ts`, readFileSync(`${root}/do-atomic-worker.ts`, "utf8").replaceAll("__CHECKOUT__", checkout));
writeFileSync(`${dir}/do-atomic.spec.ts`, readFileSync(`${root}/do-atomic.spec.ts`, "utf8").replaceAll("__CHECKOUT__", checkout));

const wrangler = (name, main, bindings, vars) =>
	JSON.stringify(
		{
			name,
			main: `${dir}/${main}`,
			compatibility_date: "2026-09-20",
			compatibility_flags: ["nodejs_compat"],
			durable_objects: { bindings },
			migrations: [{ tag: "probe-v1", new_sqlite_classes: bindings.map((b) => b.class_name) }],
			...(vars ? { vars } : {}),
		},
		null,
		2,
	);
const vars = {
	APP_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e-secret",
	SPOTIFY_CLIENT_ID: "e2e-client",
	SPOTIFY_ACCOUNTS_BASE: "http://127.0.0.1:19142/accounts",
	SPOTIFY_API_BASE: "http://127.0.0.1:19142/v1",
	LASTFM_API_BASE: "http://127.0.0.1:19142/lastfm",
	DEEZER_API_BASE: "http://127.0.0.1:19142/deezer",
};
writeFileSync(`${dir}/wrangler.clock-fault.json`, wrangler("author-clock-fault-copy", "clock-fault-worker.ts", [{ name: "PROBE", class_name: "ClockProbe" }]));
const shellBindings = (cls) => [
	{ name: "PROBE", class_name: cls },
	{ name: "REGISTRY", class_name: "Registry" },
];
writeFileSync(`${dir}/wrangler.clock-shell.json`, wrangler("author-clock-shell-copy", "clock-shell-worker.ts", shellBindings("ClockShellProbe"), vars));
writeFileSync(`${dir}/wrangler.do-atomic.json`, wrangler("author-do-atomic", "do-atomic-worker.ts", shellBindings("AtomicProbe"), vars));

const env = {};
for (const k of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) if (process.env[k]) env[k] = process.env[k];
Object.assign(env, {
	// Short temp dir: workerd's temporary SQLite files under the long scratch path fail (MAX_PATH).
	TEMP: `${persist}/tmp`,
	TMP: `${persist}/tmp`,
	USERPROFILE: `${root}/home`,
	APPDATA: `${root}/home/AppData/Roaming`,
	LOCALAPPDATA: `${root}/home/AppData/Local`,
	XDG_CONFIG_HOME: `${root}/config`,
	XDG_CACHE_HOME: `${root}/cache`,
	WRANGLER_SEND_METRICS: "false",
	CI: "true",
	NO_COLOR: "1",
});
writeFileSync(
	`${dir}/runtime.mjs`,
	`import {spawn} from 'node:child_process'; const child=spawn(${JSON.stringify(process.execPath)},process.argv.slice(2),{env:${JSON.stringify(env)},cwd:${JSON.stringify(dir)},stdio:'inherit',windowsHide:true}); child.on('exit',c=>process.exit(c??1)); for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>child.kill(s));`,
);
let i = 0;
for (const probe of ["clock-fault", "clock-shell", "do-atomic"]) {
	const web = port + i * 2;
	i++;
	writeFileSync(
		`${dir}/playwright.${probe}.mts`,
		`export default {testDir:'.',testMatch:'${probe}.spec.ts',workers:1,retries:0,timeout:30000,reporter:[['list']],outputDir:'${dir}/results-${probe}',use:{baseURL:'http://127.0.0.1:${web}',trace:'on'},webServer:[{command:'node runtime.mjs ${checkout}/node_modules/wrangler/bin/wrangler.js dev -c ${dir}/wrangler.${probe}.json --port ${web} --inspector-port ${web + 1} --ip 127.0.0.1 --persist-to ${persist}/${label}-${probe}',url:'http://127.0.0.1:${web}/health',reuseExistingServer:false,timeout:120000,stdout:'pipe',stderr:'pipe'}]};`,
	);
}
console.log(JSON.stringify({ label, checkout, ports: [port, port + 5], replacedCandidatePaths: changed }));
