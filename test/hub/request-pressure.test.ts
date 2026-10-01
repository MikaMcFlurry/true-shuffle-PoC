import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { onboarded } from "./harness";

/** Finite simulated windows, using the real hub and production 15-second UI cadence. */
type Scenario = "visible" | "hidden" | "paused" | "device" | "reload" | "multiple_tabs";
async function measure(scenario: Scenario) {
	const h = await onboarded({ tracks: 120, durationMs: 180000 });
	await h.listen(2 * 60 * 60 * 1000);
	await h.hub.play(h.allId);
	if (scenario === "paused") {
		h.fake.pause();
		await h.hub.state({ live: true });
	}
	const start = h.fake.calls.length;
	for (let tick = 1; tick <= 60; tick++) {
		await h.listen(15000);
		if (scenario === "hidden") continue;
		if (scenario === "reload" && tick % 4 === 0) h.restart();
		await h.hub.state({ live: true });
		if (scenario === "device" && tick % 4 === 0) await h.hub.devices();
		if (scenario === "multiple_tabs") {
			// UserHub serializes tabs. They share the account's durable observations.
			await h.hub.state({ live: true });
			await h.hub.state({ live: true });
		}
	}
	const counts: Record<string, number> = {};
	for (const call of h.fake.calls.slice(start)) {
		const endpoint = call
			.replace(/\/playlists\/[^/]+/g, "/playlists/:id")
			.replace(/\/(artists|albums)\/[^/]+/g, "/$1/:id")
			.replace(/\/deezer\/artist\/[^/]+/g, "/deezer/artist/:id");
		counts[endpoint] = (counts[endpoint] ?? 0) + 1;
	}
	return {
		windowSeconds: 900,
		total: h.fake.calls.length - start,
		spotify: h.fake.calls.slice(start).filter((call) => / \/(?:v1|accounts)\//.test(call)).length,
		counts,
	};
}

describe("NN-09 finite request-pressure measurements", () => {
	it("records visible, hidden, paused, device, reload and three-tab windows", async () => {
		const scenarios: Scenario[] = [
			"visible",
			"hidden",
			"paused",
			"device",
			"reload",
			"multiple_tabs",
		];
		const results: Record<string, Awaited<ReturnType<typeof measure>>> = {};
		for (const scenario of scenarios) results[scenario] = await measure(scenario);
		writeFileSync(
			process.env.PRESSURE_REPORT ?? "/tmp/true-shuffle-pressure-current.json",
			JSON.stringify(
				{ simulated: true, cadenceSeconds: 15, settlementSeconds: 7200, results },
				null,
				2,
			),
		);
		expect(results.multiple_tabs!.total).toBeLessThanOrEqual(results.visible!.total + 2);
		expect(results.hidden!.total).toBeLessThan(results.visible!.total);
		expect(results.device!.counts["GET /v1/me/player/devices"]).toBe(15);
	}, 60000);
});
