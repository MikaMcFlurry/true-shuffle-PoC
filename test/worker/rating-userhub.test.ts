/**
 * The page's ratings through the actual UserHub methods (session check, the
 * occurrence passed on or left out) against a real HubCore (CTO playback
 * boundary, 2026-10-15). The route maps a body without `expected` to `null`
 * (src/worker/index.ts `occurrence`); here UserHub's own default is `null`
 * too, so a legacy payload only rates. The e2e test in
 * e2e/cto-history-import.spec.ts sends the same payloads over HTTP.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";
import { expect, it } from "vitest";
import { NativeError } from "../../src/worker/controllers/native";
import { HubError, type Occurrence } from "../../src/worker/hub/hub";
import { RequestBudget, SpotifyError } from "../../src/worker/spotify/client";
import { onboarded } from "../hub/harness";

const compiled = transpileModule(readFileSync("src/worker/userhub.ts", "utf8"), {
	compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;
function method(name: string) {
	const start = compiled.search(new RegExp(`\\n {4}(async )?${name}\\(`));
	if (start < 0) throw new Error(`UserHub ${name} not found`);
	const end = compiled.slice(start + 1).search(/\n {4}\}/);
	return compiled.slice(start + 1, start + 1 + end + 6);
}
type Result = { ok: true; value: unknown } | { ok: false; error: { status: number } };
const real = runInNewContext(
	`({${["exclusive", "session", "logout", "thumb", "retestVerdict"].map(method).join(",")}})`,
	{ HubError, NativeError, SpotifyError, console },
) as Record<string, (this: unknown, ...args: unknown[]) => Promise<Result>>;

async function shell() {
	const h = await onboarded({ tracks: 8, playlists: [1, 7] });
	const sid = h.stationIds[0]!;
	expect(await h.hub.play(sid)).toMatchObject({ ok: true });
	h.clock.t += 1000;
	await h.hub.sync(new RequestBudget(25), { force: true });
	const s: Record<string, unknown> = {
		chain: Promise.resolve(),
		genreFlight: null,
		hub: () => h.hub,
		ctx: { storage: { get: async () => undefined } },
	};
	for (const name of ["exclusive", "session"]) s[name] = real[name]!.bind(s);
	const call = (name: string, ...args: unknown[]) => real[name]!.call(s, ...args);
	const saved = h.hub.savedSession(sid)!;
	const current: Occurrence = {
		sessionId: saved.sessionId,
		entryId: saved.entryIds[saved.currentIndex]!,
	};
	const nexts = () => h.fake.calls.filter((c) => c === "POST /v1/me/player/next").length;
	return { h, sid, call, current, nexts, a: h.fake.current()!, epoch: h.hub.sessionEpoch() };
}

it("a legacy payload (no occurrence) on the song playing: stored, answered as not skipped, nothing moved", async () => {
	const { h, call, nexts, a, epoch } = await shell();
	const before = nexts();
	expect(await call("thumb", epoch, a, -1)).toEqual({ ok: true, value: { skipped: false } });
	expect(await call("retestVerdict", epoch, a, false)).toEqual({
		ok: true,
		value: { skipped: false },
	});
	expect(h.hub.memory(a).thumb).toBe(-1);
	expect(nexts()).toBe(before);
	expect(h.fake.current()).toBe(a);
});

it("bound to the occurrence playing: skipped once; bound to it again after it moved on: nothing", async () => {
	const { h, call, current, nexts, a, epoch } = await shell();
	const before = nexts();
	expect(await call("thumb", epoch, a, -1, current)).toEqual({
		ok: true,
		value: { skipped: true },
	});
	expect(nexts()).toBe(before + 1);
	h.clock.t += 1000;
	await h.hub.sync(new RequestBudget(25), { force: true });
	const now = h.fake.current();
	// Not skipped again; the reason may be that the first skip is not confirmed yet.
	expect(await call("retestVerdict", epoch, a, false, current)).toMatchObject({
		ok: true,
		value: { skipped: false },
	});
	expect(nexts()).toBe(before + 1);
	expect(h.fake.current()).toBe(now);
});

it("an earlier session's cookie, or one signed out since: refused, nothing stored, nothing skipped", async () => {
	const { h, call, current, nexts, a, epoch } = await shell();
	const before = nexts();
	expect(await call("thumb", epoch - 1, a, -1, current)).toMatchObject({
		ok: false,
		error: { status: 401 },
	});
	expect(h.hub.memory(a).thumb).toBe(0);
	expect(await call("logout", epoch)).toMatchObject({ ok: true });
	expect(await call("thumb", epoch, a, -1, current)).toMatchObject({
		ok: false,
		error: { status: 401 },
	});
	expect(await call("retestVerdict", epoch, a, false, current)).toMatchObject({
		ok: false,
		error: { status: 401 },
	});
	expect(h.hub.memory(a).thumb).toBe(0);
	expect(nexts()).toBe(before);
});
