/**
 * The observed target at the HTTP edge and through the actual UserHub methods
 * (NP06, 2026-10-17): the route's own parser (src/worker/index.ts, its source
 * run as is) takes exactly the discriminated shape and refuses mixed, malformed
 * and other accounts' targets; UserHub passes a valid one, under the session
 * check, to the real HubCore, which looks again before Spotify is asked. The
 * true-shuffle occurrence form stays as it was (test/worker/rating-userhub.test.ts).
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";
import { expect, it } from "vitest";
import type { ObservedTarget } from "../../src/shared/api";
import { NativeError } from "../../src/worker/controllers/native";
import { HubError } from "../../src/worker/hub/hub";
import { RequestBudget, SpotifyError } from "../../src/worker/spotify/client";
import { onboarded } from "../hub/harness";

const compile = (path: string) =>
	transpileModule(readFileSync(path, "utf8"), {
		compilerOptions: { target: ScriptTarget.ES2022 },
	}).outputText;

const hubSource = compile("src/worker/userhub.ts");
function method(name: string) {
	const start = hubSource.search(new RegExp(`\\n {4}(async )?${name}\\(`));
	if (start < 0) throw new Error(`UserHub ${name} not found`);
	const end = hubSource.slice(start + 1).search(/\n {4}\}/);
	return hubSource.slice(start + 1, start + 1 + end + 6);
}
type Result = { ok: true; value: unknown } | { ok: false; error: { status: number; code: string } };
const real = runInNewContext(
	`({${["exclusive", "session", "thumb", "observedNext", "playerAction", "retestVerdict"].map(method).join(",")}})`,
	{ HubError, NativeError, SpotifyError, console },
) as Record<string, (this: unknown, ...args: unknown[]) => Promise<Result>>;

// The route's parsers, from the Worker's own source.
const workerSource = compile("src/worker/index.ts");
const piece = (re: RegExp) => {
	const m = re.exec(workerSource);
	if (!m) throw new Error(`index.ts: ${re} not found`);
	const start = m.index;
	const end = workerSource.indexOf("\n}", start);
	const endConst = workerSource.indexOf("];", start);
	return workerSource.slice(start, re.source.startsWith("const") ? endConst + 2 : end + 2);
};
const edge = runInNewContext(
	`${piece(/const OBSERVED_KEYS = \[/)}\n${piece(/function occurrence\(/)}\n${piece(/function observedTarget\(/)}\n({ occurrence, observedTarget })`,
	{},
) as {
	occurrence: (v: unknown) => unknown;
	observedTarget: (v: unknown, uid: string, trackId?: string) => unknown;
};

const ID = "T000000000000000000005";
const valid = (): ObservedTarget => ({
	kind: "observed",
	account: "mika",
	trackId: ID,
	deviceId: "mika-phone",
	observationId: "1790000000000",
	playId: `${ID}:1790000000000`,
});

it("the route takes exactly the observed shape, for the signed-in account and the route's song", () => {
	expect(edge.observedTarget(valid(), "mika", ID)).toEqual(valid());
	expect(edge.observedTarget({ ...valid(), deviceId: null }, "mika", ID)).toMatchObject({
		deviceId: null,
	});
	// Another account's page: stale, not bad.
	expect(edge.observedTarget(valid(), "someone-else", ID)).toBe("stale");
	for (const bad of [
		null,
		[],
		"observed",
		{ ...valid(), kind: "occurrence" },
		{ ...valid(), sessionId: "s", entryId: "e" },
		{ ...valid(), extra: 1 },
		(({ playId: _p, ...rest }) => rest)(valid()),
		{ ...valid(), trackId: "short" },
		{ ...valid(), observationId: "12a" },
		{ ...valid(), observationId: 12 },
		{ ...valid(), deviceId: "" },
		{ ...valid(), playId: "x".repeat(201) },
		{ ...valid(), account: "" },
	])
		expect(edge.observedTarget(bad, "mika", ID)).toBe("bad");
	// A target for another song than the route's.
	expect(edge.observedTarget(valid(), "mika", "T000000000000000000006")).toBe("bad");
});

it("a true-shuffle occurrence stays as it was and never carries observed fields", () => {
	expect(edge.occurrence(undefined)).toBeNull();
	expect(edge.occurrence({ sessionId: "s", entryId: "e" })).toEqual({
		sessionId: "s",
		entryId: "e",
	});
	expect(edge.occurrence({ sessionId: "s" })).toBe("bad");
	for (const k of ["kind", "account", "deviceId", "observationId", "playId"])
		expect(edge.occurrence({ sessionId: "s", entryId: "e", [k]: "x" })).toBe("bad");
});

async function shell() {
	const h = await onboarded({ tracks: 12, playlists: [6, 6] });
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
	const playlist = h.hub.savedSession(sid)!.contextUri.split(":")[2]!;
	const outside = [...h.fake.tracks.keys()].filter(
		(id) => !h.fake.playlists.get(playlist)!.items.includes(id),
	);
	const nexts = () => h.fake.calls.filter((c) => c === "POST /v1/me/player/next").length;
	const look = async () => {
		h.clock.t += 1000;
		await h.hub.sync(new RequestBudget(25), {
			force: true,
			observationOnly: true,
			playerOnly: true,
		});
		return (await h.hub.state()).observed!;
	};
	return { h, sid, call, outside, nexts, look, epoch: h.hub.sessionEpoch() };
}

it("UserHub passes an observed Nie wieder under the session check: stored, B moved on once", async () => {
	const { h, sid, call, outside, nexts, look, epoch } = await shell();
	const b = outside[0]!;
	h.fake.playSong("mika", b);
	const target = (await look()).target!;
	const saved = JSON.stringify(h.hub.savedSession(sid));
	const before = nexts();
	expect(await call("thumb", epoch, b, -1, target)).toEqual({
		ok: true,
		value: { skipped: true, observedSkip: "skipped" },
	});
	expect(h.hub.memory(b).thumb).toBe(-1);
	expect(nexts() - before).toBe(1);
	expect(JSON.stringify(h.hub.savedSession(sid))).toBe(saved);
});

it("UserHub observedNext: the session's own; an ended session or another account changes nothing", async () => {
	const { h, call, outside, nexts, look, epoch } = await shell();
	h.fake.playSong("mika", outside[0]!);
	const target = (await look()).target!;
	const before = nexts();
	// A signed-out page (an older epoch): refused before the hub acts.
	const old = await call("observedNext", epoch - 1, target);
	expect(old.ok).toBe(false);
	expect(await call("observedNext", epoch, { ...target, account: "other" })).toMatchObject({
		ok: true,
		value: { ok: false, observedChanged: true },
	});
	expect(nexts()).toBe(before);
	expect(await call("observedNext", epoch, target)).toMatchObject({
		ok: true,
		value: { ok: true },
	});
	expect(nexts() - before).toBe(1);
});

it("a stale B answer after C: B rated, C neither rated nor skipped", async () => {
	const { h, call, outside, nexts, look, epoch } = await shell();
	const [b, c] = outside;
	h.fake.playSong("mika", b!);
	const target = (await look()).target!;
	h.fake.playSong("mika", c!);
	const before = nexts();
	expect(await call("thumb", epoch, b, -1, target)).toEqual({
		ok: true,
		value: { skipped: false, observedSkip: "over" },
	});
	expect(h.hub.memory(b!).thumb).toBe(-1);
	expect(h.hub.memory(c!).thumb).toBe(0);
	expect(nexts()).toBe(before);
	expect(h.fake.current()).toBe(c);
});

it("an observed target for another song than the one rated is refused, nothing stored", async () => {
	const { h, call, outside, look, epoch } = await shell();
	h.fake.playSong("mika", outside[0]!);
	const target = (await look()).target!;
	const r = await call("thumb", epoch, outside[1], -1, target);
	expect(r).toMatchObject({ ok: false, error: { status: 400, code: "bad_target" } });
	expect(h.hub.memory(outside[1]!).thumb).toBe(0);
});

it("a missing target rates only, as before", async () => {
	const { h, call, outside, nexts, look, epoch } = await shell();
	const b = outside[0]!;
	h.fake.playSong("mika", b);
	await look();
	const before = nexts();
	expect(await call("thumb", epoch, b, -1)).toEqual({ ok: true, value: { skipped: false } });
	expect(h.hub.memory(b).thumb).toBe(-1);
	expect(nexts()).toBe(before);
});
