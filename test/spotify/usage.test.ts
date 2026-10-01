import { expect, it } from "vitest";
import { SpotifyClient, type SpotifyRequestMetric } from "../../src/worker/spotify/client";
import { SpotifyOperationGates } from "../../src/worker/spotify/operation-gates";
import { SpotifyUsageTracker } from "../../src/worker/spotify/usage";
import { nodeSql, T0 } from "../hub/harness";

const metric = (
	status: number,
	at = T0,
	extra: Partial<SpotifyRequestMetric> = {},
): SpotifyRequestMetric => ({
	endpoint: "/me/player/devices",
	method: "GET",
	category: "read",
	status,
	retryCategory: status === 429 ? "quota" : "none",
	at,
	retryAfter: status === 429 ? "60" : null,
	reason: status === 429 ? "QUOTA_EXCEEDED" : undefined,
	...extra,
});
it("counts all five listeners, overflow and signin without exposing actor identifiers", () => {
	const sql = nodeSql();
	const t = new SpotifyUsageTracker(sql, () => T0);
	for (let i = 1; i <= 7; i++) t.record("private-listener-" + i, metric(200));
	t.record(
		"@signin:privateflow",
		metric(200, T0, { endpoint: "/api/token", method: "POST", category: "refresh" }),
	);
	const r = t.report(7);
	expect(r.totals.sent).toBe(8);
	expect(r.observedListeners).toBe(5);
	expect(r.overflowObserved).toBe(true);
	expect(r.listeners.find((x) => x.listener === "Anmeldung")?.totals.refresh).toBe(1);
	expect(JSON.stringify(r)).not.toMatch(/private-listener|privateflow/);
	expect(sql.first<{ n: number }>("SELECT COUNT(*) AS n FROM spotify_usage_listeners")?.n).toBe(5);
});
it("correlates recovery to same overflow listener and same OAuth flow only", () => {
	const t = new SpotifyUsageTracker(nodeSql(), () => T0);
	for (let i = 1; i <= 5; i++) t.record("u" + i, metric(200));
	t.record("overflow-A", metric(429));
	t.record("overflow-B", metric(200));
	expect(t.report(7).episodes[0]?.firstSuccessAt).toBeNull();
	t.record("overflow-A", metric(200));
	expect(t.report(7).episodes[0]?.firstSuccessAt).toBe(T0);
	t.record("@signin:flowA", metric(429));
	t.record("@signin:flowB", metric(200));
	expect(t.report(7).episodes[0]?.firstSuccessAt).toBeNull();
	t.record("@signin:flowA", metric(200));
	expect(t.report(7).episodes[0]?.firstSuccessAt).toBe(T0);
});
it("never treats an uncorrelated old signin or migrated episode as proven recovery", () => {
	const sql = nodeSql();
	const t = new SpotifyUsageTracker(sql, () => T0);
	t.record("@signin", metric(429));
	t.record("@signin", metric(200));
	expect(t.report(0).episodes[0]?.firstSuccessAt).toBeNull();
	sql.run("UPDATE spotify_usage_episodes SET actor=NULL,first_success_at=?", T0);
	expect(t.report(0).episodes[0]?.firstSuccessAt).toBeNull();
});
it("keeps a failure pending when stale inflight success predates its confirmed429", () => {
	let now = T0;
	const t = new SpotifyUsageTracker(nodeSql(), () => now);
	t.record("u", metric(429));
	now += 1000;
	t.record("u", metric(200, now, { startedAt: T0 - 1000 }));
	expect(t.report(1).episodes[0]?.firstSuccessAt).toBeNull();
	t.record("u", metric(200, now, { startedAt: T0 + 1 }));
	expect(t.report(1).episodes[0]?.firstSuccessAt).toBe(now);
});
it("separates real429, localblocks, network, writes and token refresh", () => {
	const t = new SpotifyUsageTracker(nodeSql(), () => T0);
	t.record("u", metric(429));
	t.record("u", metric(429, T0, { retryCategory: "blocked" }));
	t.record("u", metric(0, T0, { retryCategory: "network" }));
	t.record("u", metric(204, T0, { method: "PUT", endpoint: "/me/player/play", category: "write" }));
	t.record("u", metric(200, T0, { method: "POST", endpoint: "/api/token", category: "refresh" }));
	expect(t.report(1).totals).toEqual({
		sent: 4,
		read: 2,
		write: 1,
		refresh: 1,
		blocked: 1,
		quota: 1,
		rate: 0,
		network: 1,
	});
});
it("retains 720 hourly buckets and200 episodes, reports observed success without invented reset", () => {
	let now = T0;
	const sql = nodeSql();
	const t = new SpotifyUsageTracker(sql, () => now);
	for (let i = 0; i < 730; i++) {
		now = T0 + i * 3600000;
		t.record("u", metric(200, now));
	}
	expect(t.report(1).hours).toHaveLength(720);
	for (let i = 0; i < 210; i++) {
		t.record("u", metric(429, now));
		now += 1;
		t.record("u", metric(200, now));
	}
	expect(t.report(1).episodes).toHaveLength(200);
	expect(t.report(1).episodes[0]?.firstSuccessAt).toBe(now);
	expect(t.report(1).episodes[0]?.earliestRetryAt).toBe(now - 1 + 60000);
});
it("real OAuth clients honor same-flow deadline without suppressing another flow", async () => {
	const gates = new SpotifyOperationGates(nodeSql());
	let calls = 0;
	const policy = (flow: string) => ({
		getCooldown: () => null,
		setCooldown: () => {},
		getOperationSnapshot: (op: string) => gates.snapshot(flow, op),
		setOperationCooldown: (c: import("../../src/worker/spotify/client").SpotifyCooldown) => {
			gates.block(flow, c);
		},
		finishOperation: (op: string, revision: number) => gates.finish(flow, op, revision),
	});
	const endpoints = {
		accountsBase: "https://accounts.test",
		apiBase: "https://api.test/v1",
		clientId: "test-app",
	};
	const fetch = async () => {
		calls++;
		return calls === 1
			? new Response(JSON.stringify({ error: { reason: "QUOTA_EXCEEDED" } }), {
					status: 429,
					headers: { "Retry-After": "3600" },
				})
			: Response.json({ access_token: "synthetic", refresh_token: "synthetic", expires_in: 3600 });
	};
	await expect(
		SpotifyClient.exchangeCode(
			endpoints,
			fetch,
			"A",
			"https://app.test/callback",
			"vA",
			T0,
			policy("@signin:flowA"),
		),
	).rejects.toMatchObject({ status: 429 });
	await expect(
		SpotifyClient.exchangeCode(
			endpoints,
			fetch,
			"A",
			"https://app.test/callback",
			"vA",
			T0,
			policy("@signin:flowA"),
		),
	).rejects.toMatchObject({ status: 429 });
	expect(calls).toBe(1);
	await expect(
		SpotifyClient.exchangeCode(
			endpoints,
			fetch,
			"B",
			"https://app.test/callback",
			"vB",
			T0,
			policy("@signin:flowB"),
		),
	).resolves.toMatchObject({ accessToken: "synthetic" });
	expect(calls).toBe(2);
});
it("stale successful response never clears a newer confirmed operation429 or another listener", () => {
	const gates = new SpotifyOperationGates(nodeSql());
	const c = {
		operation: "GET /me/player/devices",
		endpoint: "/me/player/devices",
		until: T0 + 60000,
		kind: "quota" as const,
		reason: "QUOTA_EXCEEDED",
		retryAfter: "60",
		observedAt: T0,
	};
	const rev = gates.block("A", c);
	gates.block("A", { ...c, until: T0 + 120000 });
	gates.finish("A", c.operation, rev);
	expect(gates.snapshot("A", c.operation).cooldown?.until).toBe(T0 + 120000);
	expect(gates.snapshot("B", c.operation).cooldown).toBeNull();
	expect(gates.snapshot("A", "PUT /me/player/play").cooldown).toBeNull();
});
