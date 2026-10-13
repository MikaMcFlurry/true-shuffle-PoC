// Author-owned DO probe spec (evidence only): real local Durable Object SQLite, unchanged UserHub catch.
import { expect, test } from "C:/Users/mikah/AppData/Local/Temp/claude/C--Users-mikah-Documents-Codex-2026-10-13-task-work-true-shuffle-PoC/b3717cfc-5a7e-4563-a95d-82405b75acd7/scratchpad/c640/node_modules/@playwright/test/index.mjs";

const cases = [
	["profile", "counter"],
	["profile", "after-profile"],
	["events", "mid-events"],
	["events", "counter"],
	["events", "after-events"],
] as const;

for (const [kind, at] of cases)
	test(`${kind}: a storage failure ${at} answers 500, leaves every stored row and the commit, and the change sent again counts once`, async ({
		request,
	}) => {
		const path = `/${kind}-${at}`;
		await request.get(`${path}?op=init`);
		const failed = await request.get(`${path}?op=fault&at=${at}`);
		const f = await failed.json();
		console.log("do-atomic-fault", JSON.stringify({ kind, at, http: failed.status(), hit: f.hit, result: f.result, before: f.before.view.commit, after: f.after.view.commit }));
		expect(f.hit).toBe(true);
		expect(failed.status()).toBe(500);
		expect(f.result.ok).toBe(false);
		expect(f.after.view).toEqual(f.before.view);
		expect(f.after.stored).toBe(f.before.stored);
		const reopened = await (await request.get(`${path}?op=restart`)).json();
		expect(reopened.after.view).toEqual(f.before.view);
		expect(reopened.after.stored).toBe(f.before.stored);
		// The same change again, without a failure: stored once, the commit one higher.
		const sent = await (await request.get(`${path}?op=send`)).json();
		console.log("do-atomic-retry", JSON.stringify({ kind, at, result: sent.result?.ok, commit: sent.after.view.commit, dataset: sent.after.view.dataset }));
		expect(sent.result.ok).toBe(true);
		expect(sent.after.view.commit).toBe(f.before.view.commit + 1);
		if (kind === "profile") expect(sent.after.view.dataset.summaryProfile).toBe(true);
		else expect(sent.after.view).toMatchObject({ uploading: false, dataset: { rows: 4, coverage: "events" } });
		// Sent once more: a repeated summary or an already taken block changes no commit.
		const again = await (await request.get(`${path}?op=send`)).json();
		expect(again.after.view.commit).toBe(f.before.view.commit + 1);
		if (kind === "events") expect(again.result.ok).toBe(false);
		const last = await (await request.get(`${path}?op=restart`)).json();
		expect(last.after.view.commit).toBe(f.before.view.commit + 1);
	});
