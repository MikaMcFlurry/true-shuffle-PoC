import { describe, expect, it } from "vitest";
import { statePollMs } from "../../src/shared/poll-pace";
import {
	isStorageFull,
	isStorageLimit,
	storageFullMessage,
	storageLimitMessage,
} from "../../src/worker/lib/storage-limit";

describe("P1 storage limit", () => {
	it("tells Cloudflare's daily limit apart from ordinary failures", () => {
		for (const text of [
			"Exceeded allowed rows read in Durable Objects free tier.",
			"Your account has exceeded the daily free tier limit for rows_read",
			"Exceeded allowed rows written in Durable Objects free tier.",
		])
			expect(isStorageLimit(new Error(text)), text).toBe(true);
		for (const text of [
			"boom",
			"Cannot read properties of undefined",
			"Ungültige Song-ID",
			"Maximum call stack size exceeded",
			"Worker exceeded its memory limit",
			"Subrequest limit exceeded",
			"Exceeded CPU time limit",
			"Spotify rate limit reached",
			"Too many requests: rate limit exceeded",
			"Durable Object storage operation exceeded timeout which caused object to be reset.",
			"Durable Object is overloaded. Requests queued for too long.",
		]) {
			expect(isStorageLimit(new Error(text)), text).toBe(false);
			expect(isStorageFull(new Error(text)), text).toBe(false);
		}
	});

	it("a full database or another storage limit is no daily limit: no reset is promised (PR31-STORAGE)", () => {
		for (const text of [
			"SQLITE_FULL: database or disk is full",
			"database or disk is full",
			"storage operation exceeded limits",
			"Durable Object storage limit exceeded",
		]) {
			expect(isStorageLimit(new Error(text)), text).toBe(false);
			expect(isStorageFull(new Error(text)), text).toBe(true);
		}
		const said = storageFullMessage();
		expect(said).not.toMatch(/Uhr|Tageslimit|morgen|Mitternacht/);
		expect(said).toMatch(/bleibt erhalten/);
		expect(said).toMatch(/nicht bekannt/);
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
