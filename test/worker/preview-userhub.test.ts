/**
 * The Verlauf's listening sample in the actual UserHub method (lock, session,
 * rate): Deezer is asked outside the lock, a sign-out meanwhile learns
 * nothing, a row outside the Verlauf asks nobody, and a run of taps is cut
 * off before it reaches Deezer. Only the Durable Object base class is left
 * out, as in genre-userhub.test.ts.
 */

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";
import { expect, it } from "vitest";
import type { PreviewResult } from "../../src/shared/api";
import { NativeError } from "../../src/worker/controllers/native";
import { HubError } from "../../src/worker/hub/hub";
import type { PreviewSubject } from "../../src/worker/preview/deezer";
import { SpotifyError } from "../../src/worker/spotify/client";
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
const limit = Number(/const PREVIEW_PER_MINUTE = (\d+);/.exec(compiled)![1]);
type Result =
	| { ok: true; value: PreviewResult }
	| { ok: false; error: { status: number; code: string } };

const READY: PreviewResult = {
	status: "ready",
	source: "deezer",
	url: "https://cdnt-preview.dzcdn.net/api/1/1/s/y/n/t/1.mp3?hdnea=exp=1~acl=/x*~hmac=synthetic",
	expiresAt: 1000,
	title: "t",
	artist: "a",
	album: "b",
	link: null,
};

async function shell() {
	const asked: { subject: PreviewSubject; release: (r: PreviewResult) => void }[] = [];
	const h = await onboarded({ tracks: 40 });
	expect((await h.hub.play(h.stationIds[0]!)).ok).toBe(true);
	await h.listen(10 * 60_000);
	const real = runInNewContext(
		`({${["exclusive", "session", "logout", "historyPreview"].map(method).join(",")}})`,
		{
			HubError,
			NativeError,
			SpotifyError,
			console,
			Date,
			PREVIEW_PER_MINUTE: limit,
			hubEnv: () => ({ deezerBase: "https://fake/deezer" }),
			fetch: () => {
				throw new Error("no network here");
			},
			resolveDeezerPreview: (subject: PreviewSubject) =>
				new Promise<PreviewResult>((release) => asked.push({ subject, release })),
		},
	) as Record<string, (this: unknown, ...args: unknown[]) => Promise<Result>>;
	const s: Record<string, unknown> = {
		chain: Promise.resolve(),
		previewTimes: [],
		env: {},
		hub: () => h.hub,
	};
	for (const name of ["exclusive", "session"]) s[name] = real[name]!.bind(s);
	const call = (name: string, ...args: unknown[]) => real[name]!.call(s, ...args);
	const row = h.hub.history(5)[0]!;
	return { h, call, asked, row, epoch: h.hub.sessionEpoch() };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

it("asks Deezer outside the lock and answers the session that asked", async () => {
	const { call, asked, row, epoch } = await shell();
	const answer = call("historyPreview", epoch, row.id, row.playedAt);
	await tick();
	expect(asked).toHaveLength(1);
	expect(asked[0]!.subject.name).toBe(row.name);
	// The listener's other requests are not held up by a slow Deezer.
	expect(await call("session", epoch, () => "free")).toEqual({ ok: true, value: "free" });
	asked[0]!.release(READY);
	expect(await answer).toEqual({ ok: true, value: READY });
});

it("a sign-out while Deezer is asked: the answer goes nowhere", async () => {
	const { call, asked, row, epoch } = await shell();
	const answer = call("historyPreview", epoch, row.id, row.playedAt);
	await tick();
	expect((await call("logout", epoch)).ok).toBe(true);
	asked[0]!.release(READY);
	expect(await answer).toMatchObject({ ok: false, error: { status: 401 } });
	// And a revoked cookie asks nobody at all.
	expect(await call("historyPreview", epoch, row.id, row.playedAt)).toMatchObject({
		ok: false,
		error: { status: 401 },
	});
	expect(asked).toHaveLength(1);
});

it("a row outside the Verlauf asks nobody", async () => {
	const { call, asked, row, epoch } = await shell();
	expect(await call("historyPreview", epoch, row.id, row.playedAt - 1)).toMatchObject({
		ok: false,
		error: { status: 404, code: "not_in_history" },
	});
	expect(
		await call("historyPreview", epoch, "../../v1/me/player/play", row.playedAt),
	).toMatchObject({
		ok: false,
		error: { status: 400 },
	});
	expect(asked).toHaveLength(0);
});

it("a run of taps is cut off before it reaches Deezer", async () => {
	const { call, asked, row, epoch } = await shell();
	const answers = [];
	for (let i = 0; i < limit; i++) {
		const a = call("historyPreview", epoch, row.id, row.playedAt);
		await tick();
		asked[i]!.release(READY);
		answers.push(await a);
	}
	expect(answers.every((a) => a.ok)).toBe(true);
	expect(await call("historyPreview", epoch, row.id, row.playedAt)).toMatchObject({
		ok: true,
		value: { status: "error", reason: "rate" },
	});
	expect(asked).toHaveLength(limit);
});
