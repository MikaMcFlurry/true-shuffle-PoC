import { describe, expect, it } from "vitest";
import { BUILD_ID, checkForUpdate } from "../../src/client/app-update";

const answer = (body: unknown, ok = true) =>
	(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

describe("P7: a newer deploy is noticed by its build id", () => {
	it("the same build: nothing to update", async () => {
		expect(await checkForUpdate(answer({ version: "1.3.0", build: BUILD_ID }))).toBeNull();
	});
	it("a failed or unreadable answer changes nothing", async () => {
		expect(await checkForUpdate(answer(null, false))).toBeNull();
		expect(
			await checkForUpdate((async () => {
				throw new Error("offline");
			}) as unknown as typeof fetch),
		).toBeNull();
	});
	it("another build: ready, with its version", async () => {
		expect(await checkForUpdate(answer({ version: "1.3.1", build: "abc" }))).toEqual({
			version: "1.3.1",
			build: "abc",
		});
	});
});
