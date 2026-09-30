import { describe, expect, it } from "vitest";
import type { HubDeps } from "../../src/worker/hub/hub";
import {
	RequestBudget,
	type SpotifyClient,
	type SpotifyCooldown,
	type SpotifyCooldownScope,
} from "../../src/worker/spotify/client";
import { SpotifyGate, type SpotifyGateState } from "../../src/worker/spotify/gate";
import { onboarded, T0 } from "../hub/harness";

function shared() {
	const states = new Map<SpotifyCooldownScope | undefined, SpotifyGateState>();
	const gate = (scope?: SpotifyCooldownScope) =>
		new SpotifyGate(
			{
				get: () => states.get(scope) ?? null,
				set: (s) => {
					states.set(scope, s);
				},
			},
			() => T0,
		);
	const tokens = new Map<SpotifyCooldownScope | undefined, string>();
	const deps: NonNullable<HubDeps["sharedSpotify"]> = {
		getCooldown: async (s) => gate(s).get(tokens.get(s)),
		getSnapshot: async (s) => gate(s).snapshot(tokens.get(s)),
		setCooldown: async (c) => gate(c.scope).block(c, tokens.get(c.scope)),
		beginRecheck: async (scope) => {
			const t = gate(scope).begin("probe");
			if (t) tokens.set(scope, t);
			return !!t;
		},
		finishRecheck: async (ok, scope) => {
			const t = tokens.get(scope);
			if (t) gate(scope).finish(t, ok);
			tokens.delete(scope);
		},
		quarantineLegacyGlobal: async (c, r) => {
			const quarantined = gate().quarantine(c, r, gate("legacy-catalog"));
			return {
				quarantined,
				globalRevision: gate().snapshot().revision,
				catalogRevision: gate("legacy-catalog").snapshot().revision,
			};
		},
	};
	return { gate, deps };
}
const legacy: SpotifyCooldown = {
	kind: "quota",
	reason: "QUOTA_EXCEEDED",
	observedAt: T0,
	retryAfter: "3600",
	until: T0 + 3600000,
};
const client = (h: { hub: unknown }) =>
	(h.hub as { client(b: RequestBudget): SpotifyClient }).client(new RequestBudget(10));
describe("bounded explicit owner availability experiment", () => {
	it("quarantines conservatively, tests three GETs, caches, holds writes/catalog across another account and restart", async () => {
		const s = shared();
		const a = await onboarded({ tracks: 30, sharedSpotify: s.deps });
		const b = await onboarded({ tracks: 30, sharedSpotify: s.deps });
		s.gate().block(legacy);
		const before = a.fake.calls.length;
		const result = await a.hub.testSpotifyAvailability();
		expect(a.fake.calls.length - before).toBe(3);
		expect(Object.values(result.outcomes).every((o) => o.state === "available")).toBe(true);
		expect(result.controls).toBe("untested");
		expect(result.catalog).toBe("held");
		expect(result.devices?.length).toBeGreaterThan(0);
		expect(s.gate().get()).toBeNull();
		expect(s.gate("legacy-catalog").get()?.until).toBe(legacy.until);
		expect((await a.hub.testSpotifyAvailability()).cached).toBe(true);
		expect(a.fake.calls.length - before).toBe(3);
		b.restart();
		const bbefore = b.fake.calls.length;
		await expect(client(b).me()).rejects.toMatchObject({ scope: "legacy-catalog" });
		await expect(client(b).pause()).rejects.toMatchObject({ scope: "legacy-catalog" });
		expect(b.fake.calls.length).toBe(bbefore);
		await b.hub.devices();
		const diag = await a.hub.spotifyDiagnostics();
		expect(JSON.stringify(diag)).not.toContain("Device");
		expect((diag as { availability: { devices?: unknown } }).availability.devices).toBeUndefined();
	});
	it.each([T0 + 7200000, null])(
		"diagnostics preserve stronger shared catalog deadline %s after quarantine",
		async (until) => {
			const s = shared();
			const h = await onboarded({ tracks: 30, sharedSpotify: s.deps });
			s.gate().block(legacy);
			s.gate("legacy-catalog").block({ ...legacy, scope: "legacy-catalog", until });
			expect((await h.hub.testSpotifyAvailability()).catalog).toBe("held");
			const diagnostics = (await h.hub.spotifyDiagnostics()) as {
				catalogQuarantine: { until: number | null };
			};
			expect(diagnostics.catalogQuarantine.until).toBe(until);
			expect(diagnostics.catalogQuarantine.until).toBe(s.gate("legacy-catalog").get()?.until);
			h.clock.t = legacy.until! + 1;
			expect((await h.hub.testSpotifyAvailability()).catalog).toBe("held");
			expect(
				((await h.hub.spotifyDiagnostics()) as { catalogQuarantine: { until: number | null } })
					.catalogQuarantine.until,
			).toBe(until);
		},
	);

	it("new device quota holds only exact GET and repeated trial does not probe held family", async () => {
		const s = shared();
		const h = await onboarded({ tracks: 30, sharedSpotify: s.deps });
		s.gate().block(legacy);
		h.fake.failNext = {
			status: 429,
			count: 1,
			body: { error: { reason: "QUOTA_EXCEEDED" } },
			headers: { "Retry-After": "7200" },
		};
		const result = await h.hub.testSpotifyAvailability();
		expect(result.outcomes.devices.state).toBe("held");
		expect(result.outcomes.player.state).toBe("available");
		expect(s.gate("devices").get()?.until).toBe(result.testedAt + 7200000);
		h.clock.t += 60001;
		h.restart();
		const before = h.fake.calls.length;
		await h.hub.testSpotifyAvailability();
		expect(h.fake.calls.length - before).toBe(2);
	});
	it("real rate aborts remaining probes and cached success never clears new global rate", async () => {
		const s = shared();
		const h = await onboarded({ tracks: 30, sharedSpotify: s.deps });
		s.gate().block(legacy);
		h.fake.failNext = {
			status: 429,
			count: 1,
			body: { error: { reason: "UNKNOWN" } },
			headers: { "Retry-After": "100" },
		};
		const before = h.fake.calls.length;
		const result = await h.hub.testSpotifyAvailability();
		expect(result.stopped).toBe(true);
		expect(result.outcomes.player.state).toBe("not_tested");
		expect(h.fake.calls.length - before).toBe(1);
		expect(s.gate().get()?.kind).toBe("rate");
		expect((await h.hub.testSpotifyAvailability()).outcomes.devices.state).toBe("held");
		expect(h.fake.calls.length - before).toBe(1);
	});
	it.each([
		{ ...legacy, kind: "rate" as const },
		{ ...legacy, endpoint: "/me" },
		{ ...legacy, reason: "UNKNOWN" },
	])("refuses identified/ordinary gates without HTTP", async (hold) => {
		const s = shared();
		const h = await onboarded({ tracks: 30, sharedSpotify: s.deps });
		s.gate().block(hold);
		const before = h.fake.calls.length;
		await expect(h.hub.testSpotifyAvailability()).rejects.toMatchObject({ status: 429 });
		expect(h.fake.calls.length).toBe(before);
		expect(s.gate().get()).toEqual(hold);
	});
	it.each([401, 503])("single transport aborts %i without a refresh or retry", async (status) => {
		const s = shared();
		const h = await onboarded({ tracks: 30, sharedSpotify: s.deps });
		s.gate().block(legacy);
		h.fake.failNext = { status, count: 2 };
		const before = h.fake.calls.length;
		const result = await h.hub.testSpotifyAvailability();
		expect(result.stopped).toBe(true);
		expect(result.outcomes.devices.status).toBe(status);
		expect(h.fake.calls.length - before).toBe(1);
	});
	it("single refresh and three GETs exhaust the bounded trial; scoped unknown manual recheck is exact", async () => {
		const s = shared();
		const h = await onboarded({ tracks: 30, sharedSpotify: s.deps });
		h.clock.t += 3600000;
		s.gate().block({ ...legacy, until: h.clock.t + 3600000 });
		const before = h.fake.calls.length;
		await h.hub.testSpotifyAvailability();
		expect(h.fake.calls.length - before).toBe(4);
		s.gate("history").block({ ...legacy, scope: "history", until: null });
		await h.hub.retryQuota("history");
		expect(h.fake.calls.at(-1)).toBe("GET /v1/me/player/recently-played");
	});

	it("player quota fallback ingests genuine recent history without changing session or snapshot", async () => {
		const s = shared();
		const h = await onboarded({ tracks: 30, sharedSpotify: s.deps });
		await h.hub.play(h.allId);
		const beforeSession = h.sql.all("SELECT * FROM playback_sessions");
		const beforePlayer = h.sql.first("SELECT v FROM kv WHERE k='player'");
		const track = h.fake.tracks.values().next().value!;
		h.fake
			.user()
			.recent.unshift({ trackId: track.id, playedAt: h.clock.t + 1000, contextUri: null });
		h.clock.t += 1001;
		s.gate("player").block({ ...legacy, scope: "player", until: h.clock.t + 3600000 });
		await h.hub.sync(new RequestBudget(4), { force: true });
		expect(h.sql.first("SELECT track_id FROM plays WHERE played_at=?", h.clock.t - 1)).toBeTruthy();
		expect(h.sql.all("SELECT * FROM playback_sessions")).toEqual(beforeSession);
		expect(h.sql.first("SELECT v FROM kv WHERE k='player'")).toEqual(beforePlayer);
	});

	it("a newer identified global cause cannot be hidden by longer legacy metadata", () => {
		const s = shared();
		s.gate().block(legacy);
		s.gate().block({ ...legacy, endpoint: "/me", until: T0 + 1000 });
		const snapshot = s.gate().snapshot();
		expect(snapshot.cooldown?.endpoint).toBe("/me");
		expect(
			s.gate().quarantine(snapshot.cooldown!, snapshot.revision, s.gate("legacy-catalog")),
		).toBe(false);
		expect(s.gate().get()?.until).toBe(legacy.until);
	});

	it("CAS refuses changed gate or active probe and preserves stronger catalog deadline", () => {
		const s = shared();
		s.gate().block(legacy);
		const rev = s.gate().snapshot().revision;
		s.gate().block({ ...legacy, endpoint: "/me" });
		expect(s.gate().quarantine(legacy, rev, s.gate("legacy-catalog"))).toBe(false);
		const fresh = shared();
		fresh.gate().block(legacy);
		fresh.gate("legacy-catalog").block({ ...legacy, scope: "legacy-catalog", until: T0 + 7200000 });
		expect(fresh.gate().quarantine(legacy, 1, fresh.gate("legacy-catalog"))).toBe(true);
		expect(fresh.gate("legacy-catalog").get()?.until).toBe(T0 + 7200000);
	});
	it("retains only 24 rolling hours and excludes local blocks from first genuine quota", async () => {
		const h = await onboarded({ tracks: 30 });
		const core = h.hub as unknown as { recordSpotifyRequest(m: unknown): void };
		for (let i = 0; i < 30; i++)
			core.recordSpotifyRequest({
				endpoint: "/me/player",
				category: "read",
				status: 429,
				retryAfter: null,
				retryCategory: "blocked",
				at: T0 + i * 3600000,
			});
		core.recordSpotifyRequest({
			endpoint: "/me/player/devices",
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
