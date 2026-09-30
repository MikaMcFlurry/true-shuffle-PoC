import { describe, expect, it } from "vitest";
import { RequestBudget, type SpotifyClient } from "../../src/worker/spotify/client";

const provider = (h: { hub: unknown }) =>
	(h.hub as { client(b: RequestBudget): SpotifyClient }).client(new RequestBudget(10));

import type { HubDeps } from "../../src/worker/hub/hub";
import { SpotifyGate, type SpotifyGateState } from "../../src/worker/spotify/gate";
import { onboarded } from "../hub/harness";

function sharedFixture() {
	let state: SpotifyGateState | null = null;
	let now = 0;
	const gate = () =>
		new SpotifyGate(
			{
				get: () => state,
				set: (s) => {
					state = s;
				},
			},
			() => now,
		);
	let seq = 0;
	const account = (): NonNullable<HubDeps["sharedSpotify"]> => {
		let token: string | null = null;
		return {
			getCooldown: async () => gate().get(token),
			getSnapshot: async () => gate().snapshot(token),
			setCooldown: async (c) => gate().block(c, token),
			beginRecheck: async () => {
				token = gate().begin(`probe-${++seq}`);
				return token !== null;
			},
			finishRecheck: async (ok) => {
				if (token) gate().finish(token, ok);
				token = null;
			},
		};
	};
	return {
		gate,
		account,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("NN-09 deployment-wide provider gate", () => {
	it("blocks a second isolated account after first account quota and hub restart", async () => {
		const shared = sharedFixture();
		const a = await onboarded({ tracks: 30, sharedSpotify: shared.account() });
		const b = await onboarded({ tracks: 35, sharedSpotify: shared.account() });
		a.fake.failNext = { status: 429, count: 1, body: { error: { reason: "QUOTA_EXCEEDED" } } };
		await expect(provider(a).me()).rejects.toMatchObject({ kind: "quota" });
		const before = b.fake.calls.length;
		b.restart();
		await expect(b.hub.devices()).rejects.toMatchObject({ kind: "quota" });
		expect(b.fake.calls.length).toBe(before);
		await b.hub.retryQuota();
		await b.hub.devices();
		expect(b.fake.calls.length).toBe(before + 2);
		// Successful shared recheck supersedes A's published local gate even after restart.
		a.restart();
		await a.hub.devices();
		expect(shared.gate().get()).toBeNull();
		expect((await a.hub.play(a.allId)).ok).toBe(true);
		expect(shared.gate().get()).toBeNull();
	});
	it("a shared recheck with a new known deadline supersedes another account's old unknown gate", async () => {
		const shared = sharedFixture();
		const a = await onboarded({ tracks: 30, sharedSpotify: shared.account() });
		const b = await onboarded({ tracks: 35, sharedSpotify: shared.account() });
		a.fake.failNext = { status: 429, count: 1, body: { error: { reason: "QUOTA_EXCEEDED" } } };
		await expect(provider(a).me()).rejects.toMatchObject({ kind: "quota" });
		b.fake.failNext = {
			status: 429,
			count: 1,
			body: { error: { reason: "UNKNOWN" } },
			headers: { "Retry-After": "3600" },
		};
		await expect(b.hub.retryQuota()).rejects.toMatchObject({
			kind: "rate",
			retryAfterMs: 3600000,
		});
		a.restart();
		await expect(provider(a).me()).rejects.toMatchObject({ kind: "rate", retryAfterMs: 3600000 });
		expect(shared.gate().get()?.until).not.toBeNull();
		expect(
			((await a.hub.spotifyDiagnostics()) as { cooldown: { until: number | null } }).cooldown.until,
		).toBe(shared.gate().get()?.until);
	});
	it("enforces known deadline across accounts without early manual retry", async () => {
		const f = sharedFixture();
		f.gate().block({ until: 172800000, kind: "quota", retryAfter: "172800", observedAt: 0 });
		expect(await f.account().beginRecheck()).toBe(false);
		f.advance(172800000);
		expect(await f.account().beginRecheck()).toBe(true);
	});
	it("one explicit unknown probe is exclusive and stale success cannot clear newer quota", () => {
		const f = sharedFixture();
		const cooldown = { until: null, kind: "quota" as const, retryAfter: null, observedAt: 0 };
		f.gate().block(cooldown);
		expect(f.gate().begin("one")).toBe("one");
		expect(f.gate().get("one")).toBeNull();
		expect(f.gate().get()).toEqual(cooldown);
		expect(f.gate().begin("two")).toBeNull();
		f.gate().block({ ...cooldown, observedAt: 1 });
		f.gate().finish("one", true);
		expect(f.gate().get()).toMatchObject({ until: null, observedAt: 1 });
	});
	it("probe failure retains gate and explicit recovery after lease expiry fences old operation", () => {
		const f = sharedFixture();
		f.gate().block({ until: null, kind: "rate", retryAfter: null, observedAt: 0 });
		f.gate().begin("old");
		f.advance(30000);
		expect(f.gate().get()?.until).toBeNull();
		expect(f.gate().begin("new")).toBe("new");
		f.gate().finish("old", true);
		expect(f.gate().get()?.until).toBeNull();
		f.gate().finish("new", false);
		expect(f.gate().get()?.until).toBeNull();
	});
});
