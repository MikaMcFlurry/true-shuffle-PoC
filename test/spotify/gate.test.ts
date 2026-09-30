import { describe, expect, it } from "vitest";

import type { HubDeps } from "../../src/worker/hub/hub";
import { SpotifyGate, type SpotifyGateState } from "../../src/worker/spotify/gate";
import { onboarded } from "../hub/harness";
import { operationFixture } from "./operation-fixture";

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
	it("confirmed operation survives same-user eviction without blocking untested other user", async () => {
		const f = operationFixture();
		const a = await onboarded({ tracks: 30, sharedSpotify: f.account("a") });
		const b = await onboarded({ tracks: 30, sharedSpotify: f.account("b") });
		a.fake.failNext = {
			status: 429,
			count: 1,
			body: { error: { reason: "QUOTA_EXCEEDED" } },
			headers: { "Retry-After": "3600" },
		};
		await expect(a.hub.devices()).rejects.toMatchObject({ operation: "GET /me/player/devices" });
		a.restart();
		await expect(a.hub.devices()).rejects.toMatchObject({ kind: "quota" });
		await b.hub.devices();
		expect((await a.hub.play(a.allId, "device-1")).ok).toBe(true);
	});
	it("successful expired operation reset is revision fenced", async () => {
		const f = operationFixture();
		const a = await onboarded({ tracks: 30, sharedSpotify: f.account("a") });
		a.fake.failNext = {
			status: 429,
			count: 1,
			body: { error: { reason: "UNKNOWN" } },
			headers: { "Retry-After": "1" },
		};
		await expect(a.hub.devices()).rejects.toMatchObject({ kind: "rate" });
		a.clock.t += 1000;
		await a.hub.devices();
		expect(
			(await f.account("a").getOperationSnapshot!("GET /me/player/devices")).cooldown,
		).toBeNull();
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
