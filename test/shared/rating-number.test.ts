import { describe, expect, it } from "vitest";
import {
	RATED_ZERO_IS_UNKNOWN,
	writeNumber,
	writeNumberUnder,
} from "../../src/shared/rating-number";

describe("I1: the rule for `rated: 0` sits in one place", () => {
	it("under A1, 0 is no known write: read like an answer without `rated`", () => {
		expect(writeNumberUnder(true, 0)).toBeUndefined();
		expect(writeNumberUnder(true, undefined)).toBeUndefined();
		expect(writeNumberUnder(true, 3)).toBe(3);
	});
	it("under D7 (ZERO-FOLLOW), 0 is a confirmed write", () => {
		expect(writeNumberUnder(false, 0)).toBe(0);
		expect(writeNumberUnder(false, undefined)).toBeUndefined();
		expect(writeNumberUnder(false, 3)).toBe(3);
	});
	it("the client reads every `rated` through the rule in force", () => {
		expect(writeNumber(0)).toBe(RATED_ZERO_IS_UNKNOWN ? undefined : 0);
		expect(writeNumber(7)).toBe(7);
	});
});
