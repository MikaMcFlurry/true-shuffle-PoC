import { describe, expect, it } from "vitest";
import { RequestBudget, type SpotifyClient } from "../../src/worker/spotify/client";
import { onboarded } from "./harness";

const provider = (h: { hub: unknown }) =>
	(h.hub as { client(b: RequestBudget): SpotifyClient }).client(new RequestBudget(10));
const quota = (retry?: string) => ({
	status: 429,
	count: 1,
	body: { error: { reason: "QUOTA_EXCEEDED", message: "private provider" } },
	headers: retry ? { "Retry-After": retry } : undefined,
});
describe("durable exact operation cooldown", () => {
	it("survives restart for matching operation while playback/history/catalog continue", async () => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = quota("172800");
		await expect(h.hub.devices()).rejects.toMatchObject({ operation: "GET /me/player/devices" });
		h.restart();
		const before = h.fake.calls.length;
		await expect(h.hub.devices()).rejects.toMatchObject({ kind: "quota" });
		expect(h.fake.calls.length).toBe(before);
		await provider(h).player();
		await provider(h).recentlyPlayed();
		await provider(h).me();
		expect((await h.hub.play(h.allId, "device-1")).ok).toBe(true);
		expect(JSON.stringify(await h.hub.spotifyDiagnostics())).not.toMatch(
			/private provider|Bearer|spotify:/,
		);
	});
	it("unknown next invocation makes exactly one real attempt and then succeeds without invented deadline", async () => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = quota();
		await expect(h.hub.devices()).rejects.toMatchObject({ retryAfter: null });
		const before = h.fake.calls.length;
		await h.hub.devices();
		expect(h.fake.calls.length - before).toBe(1);
		expect(
			((await h.hub.spotifyDiagnostics()) as { operationCooldowns: unknown[] }).operationCooldowns,
		).toEqual([]);
	});
	it("deadline expiry permits actual same-operation retry and clears only after success", async () => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = quota("10");
		await expect(h.hub.devices()).rejects.toMatchObject({ kind: "quota" });
		const before = h.fake.calls.length;
		h.clock.t += 9999;
		await expect(h.hub.devices()).rejects.toMatchObject({ status: 429 });
		expect(h.fake.calls.length).toBe(before);
		h.clock.t++;
		await h.hub.devices();
		expect(h.fake.calls.length).toBe(before + 1);
	});
	it("unknown background operation does not loop alarms; explicit same operation can recheck", async () => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = quota();
		await expect(provider(h).player()).rejects.toMatchObject({ retryAfter: null });
		const before = h.fake.calls.filter((c) => c === "GET /v1/me/player").length;
		await h.hub.sync(new RequestBudget(10));
		await h.hub.sync(new RequestBudget(10));
		expect(h.fake.calls.filter((c) => c === "GET /v1/me/player").length).toBe(before);
		await h.hub.retryQuota("player");
		expect(h.fake.calls.filter((c) => c === "GET /v1/me/player").length).toBe(before + 1);
	});
	it("unknown job is suspended without retries and resumes only after confirmed explicit success", async () => {
		const h = await onboarded({ tracks: 30 });
		h.sql.run(
			"INSERT INTO jobs(key,kind,state,priority,run_after,attempts,error,created_at,updated_at) VALUES('unknown-probe','playlists','{}',1,?,0,NULL,?,?)",
			h.clock.t,
			h.clock.t,
			h.clock.t,
		);
		h.fake.failNext = quota();
		await (h.hub as unknown as { runJobs(b: RequestBudget): Promise<void> }).runJobs(
			new RequestBudget(10),
		);
		const before = h.fake.calls.filter((c) => c === "GET /v1/me/playlists").length;
		const job = h.sql.first<{ run_after: number }>(
			"SELECT run_after FROM jobs WHERE key='unknown-probe'",
		);
		expect(job?.run_after).toBe(Number.MAX_SAFE_INTEGER);
		await h.hub.alarm();
		expect(h.fake.calls.filter((c) => c === "GET /v1/me/playlists").length).toBe(before);
		await provider(h).myPlaylists();
		expect(
			h.sql.first<{ run_after: number }>("SELECT run_after FROM jobs WHERE key='unknown-probe'")
				?.run_after,
		).toBe(h.clock.t);
	});
});

it("migration admits jobs delayed by old local guard without changing genuine provider or normal schedules", async () => {
	const h = await onboarded({ tracks: 20 });
	h.sql.run("DELETE FROM kv WHERE k='spotify_operation_policy'");
	const future = h.clock.t + 3600000;
	for (const [key, error] of [
		["legacy-blocked", "Spotify wartet auf die Freigabe weiterer Anfragen"],
		["provider-confirmed", "Spotify bremst gerade (zu viele Anfragen)"],
		["normal-schedule", null],
	] as const)
		h.sql.run(
			"INSERT INTO jobs(key,kind,state,priority,run_after,attempts,error,created_at,updated_at) VALUES(?, 'playlists', '{}', 5, ?, 0, ?, ?, ?)",
			key,
			future,
			error,
			h.clock.t,
			h.clock.t,
		);
	await h.hub.spotifyDiagnostics();
	expect(
		h.sql.first<{ run_after: number; error: string | null }>(
			"SELECT run_after,error FROM jobs WHERE key='legacy-blocked'",
		),
	).toEqual({ run_after: h.clock.t, error: null });
	expect(
		h.sql.first<{ run_after: number }>("SELECT run_after FROM jobs WHERE key='provider-confirmed'")
			?.run_after,
	).toBe(future);
	expect(
		h.sql.first<{ run_after: number }>("SELECT run_after FROM jobs WHERE key='normal-schedule'")
			?.run_after,
	).toBe(future);
	h.sql.run(
		"UPDATE jobs SET run_after=?,error='Spotify wartet auf die Freigabe weiterer Anfragen' WHERE key='legacy-blocked'",
		future,
	);
	await h.hub.spotifyDiagnostics();
	expect(
		h.sql.first<{ run_after: number }>("SELECT run_after FROM jobs WHERE key='legacy-blocked'")
			?.run_after,
	).toBe(future);
});
