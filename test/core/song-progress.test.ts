import { describe, expect, it } from "vitest";
import { estimatedProgress } from "../../src/client/progress";

describe("display-only song clock", () => {
	it("counts from provider observation across cached snapshots", () => {
		expect(estimatedProgress(176000, 1000, 61000, 3000, true, 300000)).toBe(239000);
	});
	it("accepts a backwards seek on the next observation", () => {
		expect(estimatedProgress(12000, 61000, 61000, 1000, true, 300000)).toBe(13000);
	});
	it("keeps pauses and unavailable playback at the saved position", () => {
		expect(estimatedProgress(97000, 1000, 61000, 3000, false, 300000)).toBe(97000);
	});
	it("does not invent unknown progress or an observation timestamp", () => {
		expect(estimatedProgress(null, 1000, 61000, 3000, true, 300000)).toBeNull();
		expect(estimatedProgress(97000, null, 61000, 3000, true, 300000)).toBe(97000);
	});
	it("stops at the track end without advancing the queue", () => {
		expect(estimatedProgress(176000, 1000, 61000, 90000, true, 300000)).toBe(300000);
	});
	it("does not subtract time for clock skew", () => {
		expect(estimatedProgress(97000, 90000, 61000, 1000, true, 300000)).toBe(97000);
	});
});
