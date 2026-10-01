import { describe, expect, it } from "vitest";
import {
	foregroundObservationDeadline,
	MAX_RECENT_INTERVAL_MS,
	observationDeadline,
	pausedObservationPace,
} from "../../src/worker/hub/observation-policy";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CHECKED = Date.UTC(2026, 9, 1, 9);

describe("observation deadlines", () => {
	it("makes initial and evicted-without-cache observations due immediately", () => {
		expect(observationDeadline({ now: CHECKED, checkedAt: null, intervalMs: 30 * MINUTE })).toEqual(
			{ at: CHECKED, reason: "initial" },
		);
	});

	it("does not slide a durable deadline during repeated maintenance wakes or restart", () => {
		const saved = JSON.stringify({ checkedAt: CHECKED, intervalMs: 15 * MINUTE });
		for (const elapsed of [0, 1000, MINUTE, 10 * MINUTE, 15 * MINUTE, 16 * MINUTE]) {
			const deadline = observationDeadline({ ...JSON.parse(saved), now: CHECKED + elapsed });
			expect(deadline.at).toBe(CHECKED + 15 * MINUTE);
			expect(deadline.at <= CHECKED + elapsed).toBe(elapsed >= 15 * MINUTE);
		}
	});

	it("retains earlier absolute private, guest, guard and command deadlines", () => {
		for (const seconds of [1, 15, 20, 30, 120]) {
			const earlierAt = [CHECKED + 500_000, CHECKED + seconds * 1000];
			for (const elapsed of [0, 500, 900]) {
				expect(
					observationDeadline({
						now: CHECKED + elapsed,
						checkedAt: CHECKED,
						intervalMs: 30 * MINUTE,
						earlierAt,
					}),
				).toEqual({ at: CHECKED + seconds * 1000, reason: "earlier" });
			}
		}
	});

	it("paces failed reads without advancing successful freshness or sliding the retry", () => {
		const input = {
			checkedAt: CHECKED,
			failedAt: CHECKED + MINUTE,
			intervalMs: 30_000,
			earlierAt: [CHECKED + 1000],
		};
		for (const elapsed of [0, 1000, 15_000, 16_000]) {
			expect(observationDeadline({ ...input, now: input.failedAt + elapsed })).toEqual({
				at: input.failedAt + 15_000,
				reason: "retry",
			});
		}
		expect(input.checkedAt).toBe(CHECKED);
		expect(
			observationDeadline({
				...input,
				now: CHECKED + 90_000,
				checkedAt: CHECKED + 80_000,
				earlierAt: [],
			}),
		).toEqual({ at: CHECKED + 110_000, reason: "interval" });
	});

	it("also paces initial failures without fabricating a successful cached observation", () => {
		expect(
			observationDeadline({
				now: CHECKED + 1000,
				checkedAt: null,
				failedAt: CHECKED,
				intervalMs: 30 * MINUTE,
			}),
		).toEqual({ at: CHECKED + 15_000, reason: "retry" });
	});
});

describe("ordinary paused observation", () => {
	it.each([
		[0, 30_000],
		[5 * MINUTE - 1, 30_000],
		[5 * MINUTE, 2 * MINUTE],
		[30 * MINUTE - 1, 2 * MINUTE],
		[30 * MINUTE, 5 * MINUTE],
		[3 * HOUR - 1, 5 * MINUTE],
		[3 * HOUR, 15 * MINUTE],
		[36 * HOUR - 1, 15 * MINUTE],
		[36 * HOUR, 30 * MINUTE],
		[365 * 24 * HOUR, 30 * MINUTE],
	])("paces idle age %i ms at %i ms", (idleForMs, expected) => {
		expect(pausedObservationPace(idleForMs)).toBe(expected);
	});

	it("keeps a legacy recently-heard front protected even after a long pause", () => {
		expect(pausedObservationPace(72 * HOUR, true)).toBe(30_000);
	});

	it("keeps history's independent idle ceiling at 30 minutes", () => {
		expect(MAX_RECENT_INTERVAL_MS).toBe(30 * MINUTE);
	});
});

describe("foreground freshness", () => {
	it("uses two minutes for paused playback and 45 seconds for active playback", () => {
		for (const [playing, intervalMs] of [
			[false, 2 * MINUTE],
			[true, 45_000],
		] as const) {
			expect(
				foregroundObservationDeadline({ now: CHECKED + 15_000, checkedAt: CHECKED, playing }),
			).toEqual({ at: CHECKED + intervalMs, reason: "interval" });
		}
	});

	it("requests one second after the observed boundary without moving it on cache reads", () => {
		const input = {
			checkedAt: CHECKED,
			observedAt: CHECKED,
			playing: true,
			durationMs: 180_000,
			progressMs: 178_000,
		};
		for (const elapsed of [0, 1000, 2000, 3000, 5000]) {
			expect(foregroundObservationDeadline({ ...input, now: CHECKED + elapsed })).toEqual({
				at: CHECKED + 3000,
				reason: "earlier",
			});
		}
	});

	it("keeps paused and unknown-progress observations out of boundary inference", () => {
		for (const progressMs of [null, undefined, Number.NaN, -1]) {
			expect(
				foregroundObservationDeadline({
					now: CHECKED,
					checkedAt: CHECKED,
					observedAt: CHECKED,
					playing: true,
					durationMs: 180_000,
					progressMs,
				}).at,
			).toBe(CHECKED + 45_000);
		}
		expect(
			foregroundObservationDeadline({
				now: CHECKED,
				checkedAt: CHECKED,
				observedAt: CHECKED,
				playing: false,
				durationMs: 180_000,
				progressMs: 180_000,
			}).at,
		).toBe(CHECKED + 2 * MINUTE);
	});

	it("allows a one-second minimum after a real successful read at an elapsed boundary", () => {
		expect(
			foregroundObservationDeadline({
				now: CHECKED,
				checkedAt: CHECKED,
				observedAt: CHECKED - 10_000,
				playing: true,
				durationMs: 180_000,
				progressMs: 180_000,
			}).at,
		).toBe(CHECKED + 1000);
	});
});
