import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";
import { expect, it } from "vitest";
import { NativeError } from "../../src/worker/controllers/native";
import { requestGenres } from "../../src/worker/hub/genres";
import { HubError } from "../../src/worker/hub/hub";
import { SpotifyError } from "../../src/worker/spotify/client";
import { onboarded } from "../hub/harness";

// The actual UserHub methods (lock, session check, logout, genre flight, player,
// state), run against a real HubCore; only the Durable Object base class is left
// out, as in native-orchestrator.test.ts.
const compiled = transpileModule(readFileSync("src/worker/userhub.ts", "utf8"), {
	compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;
function method(name: string) {
	const start = compiled.search(new RegExp(`\\n {4}(async )?${name}\\(`));
	if (start < 0) throw new Error(`UserHub ${name} not found`);
	// Class members sit at four spaces: the method ends at the first brace closing there.
	const end = compiled.slice(start + 1).search(/\n {4}\}/);
	return compiled.slice(start + 1, start + 1 + end + 6);
}
type Result = { ok: true; value: unknown } | { ok: false; error: { status: number } };
const real = runInNewContext(
	`({${["exclusive", "session", "logout", "state", "estimateGenres", "playerAction"].map(method).join(",")}})`,
	{ requestGenres, HubError, NativeError, SpotifyError, console },
) as Record<string, (this: unknown, ...args: unknown[]) => Promise<Result>>;

/** An imported history: one Glasfabrik song, three plays (see core/listens). */
function importHistory(h: { hub: { importListens(input: unknown): unknown } }) {
	const at = 1_600_000_000;
	h.hub.importListens({
		part: 0,
		parts: 2,
		tracks: 1,
		kind: "tracks",
		data: [["G".repeat(22), "Lied", "Glasfabrik", ""]],
	});
	h.hub.importListens({
		part: 1,
		parts: 2,
		tracks: 1,
		kind: "rows",
		data: [0, 1, 2].map((i) => [at + i * 600, 0, 180_000, 0, 0]),
	});
}
const ANSWER = { response: JSON.stringify({ genres: [{ name: "Indie", share: 1 }], summary: "" }) };

/** A UserHub shell around a real HubCore whose AI answers only when released. */
async function hubWithSlowAi() {
	const releases: ((v: unknown) => void)[] = [];
	const ai = { run: () => new Promise((r) => releases.push(r)) };
	const h = await onboarded({ tracks: 300, ai, env: { anthropicKey: null } });
	expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
	importHistory(h);
	const shell: Record<string, unknown> = {
		chain: Promise.resolve(),
		genreFlight: null,
		hub: () => h.hub,
		ctx: { storage: { get: async () => undefined } },
	};
	const call = (name: string, ...args: unknown[]) => real[name]!.call(shell, ...args);
	for (const name of ["exclusive", "session"]) shell[name] = real[name]!.bind(shell);
	const settled = <T>(p: Promise<T>) =>
		Promise.race([p, new Promise((r) => setTimeout(() => r("still waiting"), 1_000))]);
	return { h, call, releases, settled, epoch: h.hub.sessionEpoch() };
}

it("parallel genre requests of one session share one provider call", async () => {
	const { call, releases, epoch } = await hubWithSlowAi();
	const first = call("estimateGenres", epoch);
	const second = call("estimateGenres", epoch);
	await new Promise((r) => setTimeout(r, 10));
	expect(releases).toHaveLength(1);
	releases[0]!(ANSWER);
	expect(await first).toMatchObject({ ok: true, value: { estimate: { source: "workers-ai" } } });
	expect(await second).toEqual(await first);
	expect(releases).toHaveLength(1);
});

it("a revoked cookie neither joins a running estimate nor reads its answer", async () => {
	const { h, call, releases, settled, epoch } = await hubWithSlowAi();
	const valid = call("estimateGenres", epoch);
	await new Promise((r) => setTimeout(r, 10));
	// A correctly signed cookie of an earlier, revoked epoch: refused at once.
	expect(await settled(call("estimateGenres", epoch - 1))).toMatchObject({
		ok: false,
		error: { status: 401 },
	});
	releases[0]!(ANSWER);
	expect(await valid).toMatchObject({ ok: true });
	expect(releases).toHaveLength(1);
	expect(h.hub.listeningProfile("UTC").genres).not.toBeNull();
});

it("sign-out while the AI thinks: no answer for the old cookie, nothing stored, new sign-in waits for the gate", async () => {
	const { h, call, releases, settled, epoch } = await hubWithSlowAi();
	const before = call("estimateGenres", epoch);
	await new Promise((r) => setTimeout(r, 10));
	expect(await settled(call("logout", epoch))).toMatchObject({ ok: true });
	// Signed in again: a new epoch never joins the old flight and starts no second call.
	const fresh = h.hub.sessionEpoch();
	expect(fresh).not.toBe(epoch);
	const again = await settled(call("estimateGenres", fresh));
	expect(again).toMatchObject({ ok: true, value: { estimate: null } });
	expect((again as { value: { retryAt: number | null } }).value.retryAt).toBeGreaterThan(0);
	releases[0]!(ANSWER);
	expect(await before).toMatchObject({ ok: false, error: { status: 401 } });
	expect(h.hub.listeningProfile("UTC").genres).toBeNull();
	expect(releases).toHaveLength(1);
});

it("pause, resume, next and state go through while the AI never answers", async () => {
	const { h, call, settled, epoch } = await hubWithSlowAi();
	void call("estimateGenres", epoch);
	await new Promise((r) => setTimeout(r, 10));
	expect(await settled(call("playerAction", epoch, "pause"))).toMatchObject({ ok: true });
	expect(h.fake.user().player.isPlaying).toBe(false);
	expect(await settled(call("playerAction", epoch, "resume"))).toMatchObject({ ok: true });
	expect(h.fake.user().player.isPlaying).toBe(true);
	const current = () => {
		const p = h.fake.user().player;
		return p.currentFromQueue ?? p.order[p.index];
	};
	const playing = current();
	expect(playing).toBeTruthy();
	expect(await settled(call("playerAction", epoch, "next"))).toMatchObject({ ok: true });
	expect(current()).not.toBe(playing);
	expect(await settled(call("state", epoch, false))).toMatchObject({ ok: true });
});

it("a newer import while the AI thinks keeps the late answer out", async () => {
	const { h, call, releases, epoch } = await hubWithSlowAi();
	const pending = call("estimateGenres", epoch);
	await new Promise((r) => setTimeout(r, 10));
	importHistory(h);
	releases[0]!(ANSWER);
	expect(await pending).toMatchObject({ ok: true, value: { estimate: null } });
	expect(h.hub.listeningProfile("UTC").genres).toBeNull();
});
