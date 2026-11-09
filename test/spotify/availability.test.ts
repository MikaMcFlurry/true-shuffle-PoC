import { describe, expect, it } from "vitest";
import { RequestBudget, type SpotifyClient } from "../../src/worker/spotify/client";
import { onboarded, T0 } from "../hub/harness";
import { operationFixture } from "./operation-fixture";

const failure = (status = 429, reason = "QUOTA_EXCEEDED", retry?: string) => ({
	status,
	count: 1,
	body: { error: { reason } },
	headers: retry ? { "Retry-After": retry } : undefined,
});
const provider = (h: { hub: unknown }) =>
	(h.hub as { client(b: RequestBudget): SpotifyClient }).client(new RequestBudget(10));
describe("bounded actual function availability", () => {
	it("tests three GETs without quarantining any untested operation; caches without more provider calls", async () => {
		const h = await onboarded({ tracks: 30 });
		const before = h.fake.calls.length;
		const result = await h.hub.testSpotifyAvailability();
		expect(h.fake.calls.length - before).toBe(3);
		expect(Object.values(result.outcomes).every((o) => o.state === "available")).toBe(true);
		expect(result.controls).toBe("untested");
		expect(result.catalog).toBe("untested");
		expect(result.devices?.length).toBeGreaterThan(0);
		expect((await h.hub.testSpotifyAvailability()).cached).toBe(true);
		expect(h.fake.calls.length - before).toBe(3);
		expect(
			((await h.hub.spotifyDiagnostics()) as { availability: { devices?: unknown } }).availability
				.devices,
		).toBeUndefined();
	});
	it.each(["QUOTA_EXCEEDED", "UNKNOWN"])(
		"actual429 %s continues other independent GETs",
		async (reason) => {
			const h = await onboarded({ tracks: 30 });
			h.fake.failNext = failure(429, reason, "7200");
			const before = h.fake.calls.length;
			const result = await h.hub.testSpotifyAvailability();
			expect(result.outcomes.devices.state).toBe("held");
			expect(result.outcomes.player.state).toBe("available");
			expect(result.outcomes.history.state).toBe("available");
			expect(result.stopped).toBe(false);
			expect(h.fake.calls.length - before).toBe(3);
			h.clock.t += 60001;
			h.restart();
			const next = h.fake.calls.length;
			await h.hub.testSpotifyAvailability();
			expect(h.fake.calls.length - next).toBe(2);
		},
	);
	it.each([401, 503])("single transport aborts %s without same-endpoint retry", async (status) => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = failure(status);
		const before = h.fake.calls.length;
		const result = await h.hub.testSpotifyAvailability();
		expect(result.stopped).toBe(true);
		expect(result.outcomes.devices.status).toBe(status);
		expect(h.fake.calls.length - before).toBe(1);
	});
	it("single refresh plus three GETs is bounded; history explicit retry uses exact GET", async () => {
		const h = await onboarded({ tracks: 30 });
		h.clock.t += 3600000;
		const before = h.fake.calls.length;
		await h.hub.testSpotifyAvailability();
		expect(h.fake.calls.length - before).toBe(4);
		h.fake.failNext = failure();
		await expect(provider(h).recentlyPlayed()).rejects.toMatchObject({
			operation: "GET /me/player/recently-played",
		});
		await h.hub.retryQuota("history");
		expect(h.fake.calls.at(-1)).toBe("GET /v1/me/player/recently-played");
	});
	it("cached success never clears newer confirmed same-operation hold", async () => {
		const h = await onboarded({ tracks: 30 });
		await h.hub.testSpotifyAvailability();
		h.fake.failNext = failure(429, "UNKNOWN", "100");
		await expect(h.hub.devices()).rejects.toMatchObject({ kind: "rate" });
		const before = h.fake.calls.length;
		const cached = await h.hub.testSpotifyAvailability();
		expect(cached.outcomes.devices.state).toBe("held");
		expect(cached.outcomes.player.state).toBe("available");
		expect(h.fake.calls.length).toBe(before);
	});
	it("same-user stale successful response cannot clear newer429; another account remains untested", async () => {
		const f = operationFixture();
		const a = await onboarded({ tracks: 30, sharedSpotify: f.account("a") });
		const b = await onboarded({ tracks: 30, sharedSpotify: f.account("b") });
		const shared = f.account("a");
		const observed = await shared.getOperationSnapshot!("GET /me/player");
		await shared.setOperationCooldown!({
			operation: "GET /me/player",
			until: a.clock.t + 10000,
			kind: "rate",
			retryAfter: "10",
			observedAt: a.clock.t,
		});
		await shared.finishOperation!("GET /me/player", observed.revision);
		a.restart();
		const before = a.fake.calls.length;
		await expect(provider(a).player()).rejects.toMatchObject({ status: 429 });
		expect(a.fake.calls.length).toBe(before);
		await provider(b).player();
	});
	it("player429 still ingests due real history without changing saved session or snapshot", async () => {
		const h = await onboarded({ tracks: 30 });
		await h.hub.play(h.allId);
		const beforeSession = h.sql.all("SELECT * FROM playback_sessions");
		const beforePlayer = h.sql.first("SELECT v FROM kv WHERE k='player'");
		const track = h.fake.tracks.values().next().value!;
		h.fake
			.user()
			.recent.unshift({ trackId: track.id, playedAt: h.clock.t + 1000, contextUri: null });
		h.clock.t += 1001;
		h.fake.failNext = failure(429, "QUOTA_EXCEEDED", "3600");
		await h.hub.sync(new RequestBudget(4), { force: true });
		expect(h.sql.first("SELECT track_id FROM plays WHERE played_at=?", h.clock.t - 1)).toBeTruthy();
		expect(h.sql.all("SELECT * FROM playback_sessions")).toEqual(beforeSession);
		expect(h.sql.first("SELECT v FROM kv WHERE k='player'")).toEqual(beforePlayer);
	});
	it("retains max24 hourly evidence without treating blocked metrics as real quota", async () => {
		const h = await onboarded({ tracks: 30 });
		const core = h.hub as unknown as { recordSpotifyRequest(m: unknown): Promise<void> };
		for (let i = 0; i < 30; i++)
			await core.recordSpotifyRequest({
				endpoint: "/me/player",
				method: "GET",
				category: "read",
				status: 429,
				retryAfter: null,
				retryCategory: "blocked",
				at: T0 + i * 3600000,
			});
		await core.recordSpotifyRequest({
			endpoint: "/me/player/devices",
			method: "GET",
			category: "read",
			status: 429,
			retryAfter: "1",
			retryCategory: "quota",
			reason: "QUOTA_EXCEEDED",
			at: T0 + 29 * 3600000 + 1,
		});
		const d = (await h.hub.spotifyDiagnostics()) as {
			recentRequests: { hours: { firstQuotaEndpoint?: string }[] };
		};
		expect(d.recentRequests.hours).toHaveLength(24);
		expect(d.recentRequests.hours.filter((h) => h.firstQuotaEndpoint)).toEqual([
			expect.objectContaining({ firstQuotaEndpoint: "/me/player/devices" }),
		]);
	});
});
