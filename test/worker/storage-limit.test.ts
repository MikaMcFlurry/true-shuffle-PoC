import { describe, expect, it } from "vitest";
import { statePollMs } from "../../src/shared/poll-pace";
import { isStorageLimit, storageLimitMessage } from "../../src/worker/lib/storage-limit";

describe("P1 storage limit", () => {
	it("tells Cloudflare's limit errors apart from ordinary failures", () => {
		for (const text of [
			"Exceeded allowed rows read in Durable Objects free tier.",
			"Your account has exceeded the daily free tier limit for rows_read",
			"storage operation exceeded limits",
			"SQLITE_FULL: database or disk is full",
		])
			expect(isStorageLimit(new Error(text)), text).toBe(true);
		for (const text of ["boom", "Cannot read properties of undefined", "Ungültige Song-ID"])
			expect(isStorageLimit(new Error(text)), text).toBe(false);
	});

	it("names when it ends on the German clock (00:00 UTC)", () => {
		// 2. November (winter time): 00:00 UTC is 01:00 in Berlin.
		expect(storageLimitMessage(Date.UTC(2026, 10, 2, 20, 31))).toContain("Ab 01:00 Uhr");
		// 22. Oktober (summer time): 02:00.
		expect(storageLimitMessage(Date.UTC(2026, 9, 22, 20, 31))).toContain("Ab 02:00 Uhr");
		expect(storageLimitMessage()).not.toMatch(/Interner Fehler/);
	});
});

describe("P1 poll pace", () => {
	it("is quick after a tap and slows down when nobody touches the app", () => {
		expect(statePollMs({ playing: true, sinceInteractionMs: 0 })).toBe(15_000);
		expect(statePollMs({ playing: true, sinceInteractionMs: 10 * 60_000 })).toBe(30_000);
		expect(statePollMs({ playing: false, sinceInteractionMs: 0 })).toBe(30_000);
		expect(statePollMs({ playing: false, sinceInteractionMs: 5 * 60_000 })).toBe(60_000);
		expect(statePollMs({ playing: false, sinceInteractionMs: 20 * 60_000 })).toBe(120_000);
		expect(statePollMs({ playing: false, sinceInteractionMs: 5 * 3600_000 })).toBe(300_000);
	});
	it("never asks more often than 1.2.0 did (every 15 s)", () => {
		for (const playing of [true, false])
			for (let ms = 0; ms < 24 * 3600_000; ms += 60_000)
				expect(statePollMs({ playing, sinceInteractionMs: ms })).toBeGreaterThanOrEqual(15_000);
	});
});
