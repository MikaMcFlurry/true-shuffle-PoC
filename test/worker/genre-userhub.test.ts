import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";
import { expect, it } from "vitest";
import { requestGenres } from "../../src/worker/hub/genres";
import { onboarded } from "../hub/harness";

// The actual UserHub methods, run against a real HubCore (only the Durable
// Object base class is left out, as in native-orchestrator.test.ts).
const compiled = transpileModule(readFileSync("src/worker/userhub.ts", "utf8"), {
	compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;
function method(name: string, next: string) {
	const start = compiled.indexOf(`    ${name}(`);
	const end = compiled.indexOf(`    ${next}(`, start);
	if (start < 0 || end < 0) throw new Error(`UserHub ${name} not found`);
	return compiled.slice(start, end);
}
const methods = runInNewContext(
	`({${method("estimateGenres", "listeningProfile")}, ${method("playerAction", "async nativeController")}})`,
	{ requestGenres },
) as {
	estimateGenres(this: unknown, epoch: number): Promise<{ ok: boolean }>;
	playerAction(this: unknown, epoch: number, action: "pause"): Promise<{ ok: boolean }>;
};

it("UserHub: pause goes through while the genre AI still thinks; requests share one call", async () => {
	let release: (v: unknown) => void = () => {};
	let calls = 0;
	const ai = {
		run: () =>
			new Promise((r) => {
				calls++;
				release = r;
			}),
	};
	const h = await onboarded({ tracks: 300, ai, env: { anthropicKey: null } });
	expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
	h.hub.setImportedProfile({
		at: 0,
		from: 1_600_000_000_000,
		to: 1_700_000_000_000,
		plays: 3,
		minutes: 9,
		songs: 1,
		artists: 1,
		earlySkips: 0,
		hourWeek: new Array<number>(168).fill(0),
		months: [],
		topArtists: [{ name: "Glasfabrik", plays: 3, minutes: 9 }],
		topSongs: [],
	});
	let chain: Promise<unknown> = Promise.resolve();
	const self = {
		genreFlight: null,
		hub: () => h.hub,
		// UserHub.session: the account's lock, one operation after another.
		session<T>(_epoch: number, fn: () => T | Promise<T>) {
			const run = chain.then(async () => {
				try {
					return { ok: true, value: await fn() };
				} catch (error) {
					return { ok: false, error };
				}
			});
			chain = run.catch(() => undefined);
			return run;
		},
	};
	const first = methods.estimateGenres.call(self, 1);
	const second = methods.estimateGenres.call(self, 1);
	await new Promise((r) => setTimeout(r, 10));
	const pause = await Promise.race([
		methods.playerAction.call(self, 1, "pause"),
		new Promise((r) => setTimeout(() => r("blocked"), 2_000)),
	]);
	expect(pause).toMatchObject({ ok: true });
	expect(h.fake.user().player.isPlaying).toBe(false);
	release({ response: JSON.stringify({ genres: [{ name: "Indie", share: 1 }], summary: "" }) });
	expect(await first).toMatchObject({ ok: true });
	expect(await second).toBe(await first);
	expect(calls).toBe(1);
});
