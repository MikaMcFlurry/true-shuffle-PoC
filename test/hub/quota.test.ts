import { describe, expect, it } from "vitest";
import { onboarded } from "./harness";

function failQuota(retry?: string) {
	return {
		status: 429,
		count: 1,
		body: {
			error: { status: 429, reason: "QUOTA_EXCEEDED", message: "sensitive provider message" },
		},
		headers: retry === undefined ? undefined : { "Retry-After": retry },
	};
}

describe("NN-09 durable hub provider cooldown", () => {
	it("survives eviction and suppresses device, play and background calls until long deadline", async () => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = failQuota("172800");
		await expect(h.hub.devices()).rejects.toMatchObject({ kind: "quota" });
		const calls = h.fake.calls.length;
		h.restart();
		await expect(h.hub.devices()).rejects.toMatchObject({ kind: "quota" });
		expect((await h.hub.play(h.allId)).ok).toBe(false);
		await h.hub.alarm();
		await expect(h.hub.retryQuota()).rejects.toMatchObject({ status: 429 });
		expect(h.fake.calls.length).toBe(calls);
		expect(JSON.stringify(await h.hub.spotifyDiagnostics())).not.toMatch(
			/sensitive|spotify:|Bearer/,
		);
	});
	it("unknown cooldown uses valid local maintenance alarms without provider retries", async () => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = failQuota();
		await expect(h.hub.devices()).rejects.toMatchObject({ kind: "quota" });
		const calls = h.fake.calls.length;
		await h.hub.alarm();
		expect(Number.isFinite(new Date(h.alarmAt()!).getTime())).toBe(true);
		await h.listen(3600000);
		expect(h.fake.calls.length).toBe(calls);
	});
	it("unknown reset needs explicit recheck; another quota restores the gate", async () => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = failQuota();
		await expect(h.hub.devices()).rejects.toMatchObject({ kind: "quota" });
		h.restart();
		const calls = h.fake.calls.length;
		h.fake.failNext = failQuota();
		await expect(h.hub.retryQuota()).rejects.toMatchObject({ kind: "quota" });
		expect(h.fake.calls.length).toBe(calls + 1);
		await expect(h.hub.devices()).rejects.toMatchObject({ kind: "quota" });
		expect(h.fake.calls.length).toBe(calls + 1);
		await h.hub.retryQuota();
		await h.hub.devices();
		expect(h.fake.calls.length).toBe(calls + 3);
	});
});
