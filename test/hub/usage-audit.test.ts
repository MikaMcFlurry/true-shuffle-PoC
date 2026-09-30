import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { RequestBudget } from "../../src/worker/spotify/client";
import { onboarded } from "./harness";

it("audits full-day Spotify pressure and the history feed during a device cooldown", async () => {
	const profiles = [];
	for (const profile of [
		"paused_closed",
		"four_hours_visible_then_paused_closed",
		"four_hours_closed_then_paused_closed",
	]) {
		const h = await onboarded({ tracks: 1200, durationMs: 180000 });
		const onboarding = h.fake.calls.filter((call) => / \/(?:v1|accounts)\//.test(call)).length;
		await h.listen(2 * 3600_000);
		await h.hub.play(h.allId);
		const start = h.fake.calls.length;
		if (profile !== "paused_closed") {
			for (let tick = 0; tick < 960; tick++) {
				await h.listen(15000);
				if (profile === "four_hours_visible_then_paused_closed") await h.hub.state({ live: true });
			}
		}
		const playingCalls = h.fake.calls
			.slice(start)
			.filter((call) => / \/(?:v1|accounts)\//.test(call)).length;
		h.fake.pause();
		await h.hub.sync(new RequestBudget(8));
		await h.listen((profile === "paused_closed" ? 24 : 20) * 3600_000);
		const counts: Record<string, number> = {};
		for (const call of h.fake.calls
			.slice(start)
			.filter((call) => / \/(?:v1|accounts)\//.test(call))) {
			const key = call
				.replace(/\/playlists\/[^/]+/g, "/playlists/:id")
				.replace(/\/artists\/[^/]+/g, "/artists/:id")
				.replace(/\/albums\/[^/]+/g, "/albums/:id");
			counts[key] = (counts[key] ?? 0) + 1;
		}
		const spotify = h.fake.calls
			.slice(start)
			.filter((call) => / \/(?:v1|accounts)\//.test(call)).length;
		profiles.push({
			profile,
			simulatedHours: 24,
			libraryTracks: 1200,
			onboardingRequests: onboarding,
			playingWindowRequests: playingCalls,
			totalSpotifyRequests: spotify,
			counts,
			pausedWindowSpotifyRequests: spotify - playingCalls,
			linearScalingEstimate: { oneUser: spotify, threeUsers: spotify * 3, fiveUsers: spotify * 5 },
			limits:
				"Three/five-user figures are arithmetic estimates of identical independent accounts, not a real Spotify quota test. The measured window includes background discovery/maintenance; setup imports and the initial Play command are outside it. Different libraries, further user commands, HA/MA and provider retries can change the totals.",
		});
	}
	const h = await onboarded({ tracks: 120, durationMs: 180000 });
	await h.hub.play(h.allId);
	await h.listen(10 * 60_000);
	await h.hub.sync(new RequestBudget(8));
	const before = h.hub.history(200);
	expect(before.length).toBeGreaterThan(0);
	h.fake.failNext = {
		status: 429,
		count: 1,
		body: { error: { status: 429, reason: "QUOTA_EXCEEDED" } },
		headers: { "Retry-After": "30363" },
	};
	await expect(h.hub.devices()).rejects.toMatchObject({ kind: "quota" });
	const providerCallsAtGate = h.fake.calls.length;
	await h.listen(30 * 60_000);
	await h.hub.state({ live: true });
	expect(h.fake.calls.length).toBe(providerCallsAtGate);
	expect(h.hub.history(200)).toEqual(before);
	writeFileSync(
		"/tmp/ts-full-day-usage-audit.json",
		JSON.stringify(
			{
				simulated: true,
				noRealSpotifyRequests: true,
				sourceRevision: process.env.AUDIT_SOURCE_REVISION ?? "WORKSPACE",
				profiles,
				historyFeed: {
					ordinaryHistoryPopulatedBySync: true,
					deviceQuotaStopsAllEndpointsForAuditedAccount: true,
					newHistoryRecordsDuringKnownCooldown: 0,
					elapsedMinutes: 30,
				},
			},
			null,
			2,
		),
	);
}, 180000);
