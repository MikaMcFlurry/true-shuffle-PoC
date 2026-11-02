import { describe, expect, it } from "vitest";
import { RequestBudget } from "../../src/worker/spotify/client";
import { type Harness, onboarded } from "./harness";

const MINUTE = 60_000;
const playerCalls = (h: Harness) => h.fake.calls.filter((x) => x === "GET /v1/me/player").length;
const read = <T>(h: Harness, key: string): T | null => {
	const row = h.sql.first<{ v: string }>("SELECT v FROM kv WHERE k = ?", key);
	return row ? (JSON.parse(row.v) as T) : null;
};

async function paused() {
	const h = await onboarded({ tracks: 120 });
	await h.hub.play(h.allId);
	await h.listen(1000);
	h.fake.user().player.progressMs = 97_000;
	h.fake.pause();
	await h.hub.sync(new RequestBudget(25), { force: true });
	await h.hub.alarm();
	await h.listen(40 * MINUTE);
	// Isolate observation pacing from unrelated discovery/import work.
	h.sql.run("DELETE FROM jobs");
	await h.hub.sync(new RequestBudget(25), { force: true });
	await h.hub.alarm();
	return h;
}

describe("durable provider observation scheduling", () => {
	it("keeps the first short watch after an explicit Play immediately pauses before any active look", async () => {
		const h = await onboarded({ tracks: 120 });
		await h.listen(2 * 60 * MINUTE);
		await h.hub.play(h.allId);
		h.fake.pause();
		await h.hub.sync(new RequestBudget(8));
		h.sql.run("DELETE FROM jobs");
		await h.hub.alarm();
		expect(h.alarmAt()).toBe(h.clock.t + 30_000);
		const calls = playerCalls(h);
		await h.listen(30_000);
		expect(playerCalls(h)).toBe(calls + 1);
	});

	it("reuses unchanged paused observations after eviction and during maintenance wakes", async () => {
		const h = await paused();
		const checked = read<number>(h, "player_checked_at")!;
		const before = h.hub.savedSession()!;
		const calls = playerCalls(h);
		for (const elapsed of [1000, MINUTE, 2 * MINUTE, 4 * MINUTE, 5 * MINUTE - 1]) {
			h.clock.t = checked + elapsed;
			h.restart();
			// A local maintenance job wakes the same account without needing Spotify.
			h.sql.run(
				"INSERT INTO jobs(key,kind,state,priority,run_after,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
				`local:${elapsed}`,
				"test-local",
				"{}",
				1,
				h.clock.t,
				0,
				h.clock.t,
				h.clock.t,
			);
			await h.hub.alarm();
			expect(playerCalls(h)).toBe(calls);
			expect(h.alarmAt()).toBe(checked + 5 * MINUTE);
		}
		h.clock.t = checked + 5 * MINUTE;
		await h.hub.alarm();
		expect(playerCalls(h)).toBe(calls + 1);
		expect(h.hub.savedSession()).toMatchObject({
			sessionId: before.sessionId,
			entryIds: before.entryIds,
			currentIndex: before.currentIndex,
			progressMs: 97_000,
		});
	});

	it("uses two-minute visible paused freshness and coalesces fresh reopen across tabs/restarts", async () => {
		const h = await paused();
		const checked = read<number>(h, "player_checked_at")!;
		const calls = playerCalls(h);
		h.clock.t = checked + 2 * MINUTE - 1;
		await h.hub.state({ live: true });
		expect(playerCalls(h)).toBe(calls);
		h.clock.t++;
		await h.hub.state({ live: true });
		expect(playerCalls(h)).toBe(calls + 1);
		for (let tab = 0; tab < 3; tab++) {
			h.restart();
			await h.hub.state({ live: true, refresh: true });
		}
		expect(playerCalls(h)).toBe(calls + 1);
		h.clock.t += 5000;
		h.fake.user().player.isPlaying = true;
		await h.hub.state({ live: false, refresh: true });
		expect(playerCalls(h)).toBe(calls + 1);
		const state = await h.hub.state({ live: true, refresh: true });
		expect(playerCalls(h)).toBe(calls + 2);
		expect(state.nowPlaying?.isPlaying).toBe(true);
	});

	it("records successful unchanged GETs durably without rewriting their progress timestamp", async () => {
		const h = await paused();
		const snapshot = read<{ at: number }>(h, "player")!;
		h.clock.t += 1000;
		await h.hub.sync(new RequestBudget(8));
		expect(read<{ at: number }>(h, "player")!.at).toBe(snapshot.at);
		expect(read<number>(h, "player_checked_at")).toBe(h.clock.t);
		h.restart();
		const calls = playerCalls(h);
		await h.hub.state({ live: true });
		expect(playerCalls(h)).toBe(calls);
	});

	it("queues an explicit Sync through a fresh cache and saves the provider's paused checkpoint", async () => {
		const h = await paused();
		h.fake.user().player.isPlaying = true;
		h.fake.user().player.progressMs = 90_000;
		await h.hub.sync(new RequestBudget(8));
		const before = h.hub.savedSession()!;
		const calls = playerCalls(h);
		h.clock.t += 1000;
		h.fake.user().player.progressMs = 97_000;
		h.fake.pause();
		await h.hub.requestSync();
		expect(playerCalls(h)).toBe(calls);
		expect(read(h, "player_observation_due")).toBe(h.clock.t);
		expect(read(h, "history_due")).toBe(1);
		h.restart();
		await h.hub.alarm();
		expect(playerCalls(h)).toBe(calls + 1);
		expect(read(h, "player_observation_due")).toBeNull();
		expect(read(h, "history_due")).toBeNull();
		expect(h.hub.savedSession()).toMatchObject({
			sessionId: before.sessionId,
			entryIds: before.entryIds,
			currentIndex: before.currentIndex,
			progressMs: 97_000,
		});
		expect((await h.hub.state({ live: false })).nowPlaying?.isPlaying).toBe(false);
	});

	it("checks one second after a provider track boundary without advancing a queue on a timer", async () => {
		const h = await onboarded({ tracks: 120, durationMs: 180_000 });
		await h.hub.play(h.allId);
		h.fake.user().player.progressMs = 178_000;
		await h.hub.sync(new RequestBudget(25), { force: true });
		const before = h.hub.savedSession()!;
		const calls = playerCalls(h);
		h.clock.t += 2000;
		h.fake.advance(2000, "mika");
		await h.hub.state({ live: true });
		expect(playerCalls(h)).toBe(calls);
		expect(h.hub.savedSession()!.currentIndex).toBe(before.currentIndex);
		h.clock.t += 1000;
		h.fake.advance(1000, "mika");
		await h.hub.state({ live: true });
		expect(playerCalls(h)).toBe(calls + 1);
		expect(h.hub.savedSession()!.currentIndex).toBe(before.currentIndex + 1);
	});

	it("paces real failed reads across eviction without advancing successful freshness", async () => {
		const h = await paused();
		const checked = read<number>(h, "player_checked_at")!;
		h.clock.t += 2 * MINUTE;
		h.fake.failNext = { status: 503, count: 2 };
		await h.hub.state({ live: true });
		const failed = h.clock.t;
		const calls = playerCalls(h);
		expect(read<number>(h, "player_checked_at")).toBe(checked);
		expect(read<number>(h, "player_failed_at")).toBe(failed);
		for (const elapsed of [1000, 10_000, 14_999]) {
			h.clock.t = failed + elapsed;
			h.restart();
			await h.hub.state({ live: true, refresh: true });
			await h.hub.alarm();
			expect(playerCalls(h)).toBe(calls);
		}
		h.clock.t = failed + 15_000;
		await h.hub.alarm();
		expect(playerCalls(h)).toBe(calls + 1);
		expect(read<number>(h, "player_failed_at")).toBeNull();
		expect(read<number>(h, "player_checked_at")).toBe(h.clock.t);
	});

	it("does not turn deferred history and its confirmed hold into a one-second player loop", async () => {
		const h = await paused();
		await h.hub.sync(new RequestBudget(8), { force: true, playerOnly: true });
		expect(read(h, "history_due")).toBe(1);
		const handle = h.fake.handle.bind(h.fake);
		h.fake.handle = async (request) => {
			if (new URL(request.url).pathname.endsWith("/recently-played"))
				h.fake.failNext = {
					status: 429,
					count: 1,
					headers: { "Retry-After": "3600" },
					body: { error: { status: 429, reason: "QUOTA_EXCEEDED" } },
				};
			return handle(request);
		};
		h.clock.t += 1000;
		await h.hub.alarm();
		h.fake.handle = handle;
		expect(read(h, "history_due")).toBe(1);
		const start = h.fake.calls.length;
		const calls = playerCalls(h);
		await h.listen(MINUTE);
		expect(h.fake.calls.slice(start)).toEqual([]);
		expect(playerCalls(h)).toBe(calls);
		expect(read(h, "history_due")).toBe(1);
	});

	it("retains real failure time when a matching unknown hold suppresses later observations", async () => {
		const h = await paused();
		h.clock.t += 2 * MINUTE;
		h.fake.failNext = {
			status: 429,
			count: 1,
			body: { error: { status: 429, reason: "QUOTA_EXCEEDED" } },
		};
		await h.hub.state({ live: true });
		const failedAt = read<number>(h, "player_failed_at");
		const calls = playerCalls(h);
		h.clock.t += 20_000;
		// Explicit sync still encounters the local gate; it must not be recorded as an actual GET.
		await h.hub.sync(new RequestBudget(8));
		expect(read<number>(h, "player_failed_at")).toBe(failedAt);
		h.restart();
		await h.hub.requestSync();
		await h.listen(31 * MINUTE);
		await h.hub.state({ live: true, refresh: true });
		expect(playerCalls(h)).toBe(calls);
		expect(read<number>(h, "player_failed_at")).toBe(failedAt);
	});

	it.each([
		{ failed: false, historyDelay: 0 },
		{ failed: true, historyDelay: 0 },
		{ failed: false, historyDelay: 2000 },
	])(
		"refreshes the occurrence before extension without letting history latency discard the fresh look ($failed, $historyDelay ms)",
		async ({ failed, historyDelay }) => {
			const h = await paused();
			const before = h.hub.savedSession()!;
			const index = before.entryIds.length - 10;
			h.fake.startContext("mika", before.contextUri, index, h.fake.user().devices[0]!.id, false);
			h.fake.user().player.progressMs = 97_000;
			h.fake.pause();
			h.clock.t += historyDelay ? 61_000 : 10_000;
			if (historyDelay) {
				h.fake.user().player.isPlaying = true;
				const handle = h.fake.handle.bind(h.fake);
				h.fake.handle = async (request) => {
					if (new URL(request.url).pathname.endsWith("/recently-played")) h.clock.t += historyDelay;
					return handle(request);
				};
			}
			h.sql.run(
				"INSERT INTO jobs(key,kind,state,priority,run_after,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
				`extend:${before.stationId}`,
				"extend",
				JSON.stringify({ stationId: before.stationId }),
				1,
				h.clock.t,
				0,
				h.clock.t,
				h.clock.t,
			);
			if (failed) h.fake.failNext = { status: 503, count: 2 };
			const start = h.fake.calls.length;
			await h.hub.alarm();
			const calls = h.fake.calls.slice(start);
			expect(calls).toContain("GET /v1/me/player");
			if (historyDelay) expect(calls).toContain("GET /v1/me/player/recently-played");
			const after = h.hub.savedSession()!;
			if (failed) {
				expect(calls.some((call) => /^(PUT|POST) \/v1\/playlists\//.test(call))).toBe(false);
				expect(after.entryIds).toEqual(before.entryIds);
				expect(after.currentIndex).toBe(before.currentIndex);
			} else {
				expect(after.entryIds[after.currentIndex]).toBe(before.entryIds[index]);
				expect(after.progressMs).toBe(97_000);
				expect(calls.some((call) => /^PUT \/v1\/playlists\//.test(call))).toBe(true);
			}
		},
	);

	it("refills with a fresh player during a confirmed history-only hold without clearing its intent", async () => {
		const h = await paused();
		const before = h.hub.savedSession()!;
		const index = before.entryIds.length - 10;
		h.fake.startContext("mika", before.contextUri, index, h.fake.user().devices[0]!.id, false);
		h.fake.user().player.progressMs = 97_000;
		h.fake.pause();
		h.clock.t += 61_000; // A fresh-memory request is now genuinely due.
		const handle = h.fake.handle.bind(h.fake);
		h.fake.handle = async (request) => {
			if (new URL(request.url).pathname.endsWith("/recently-played"))
				h.fake.failNext = {
					status: 429,
					count: 1,
					headers: { "Retry-After": "3600" },
					body: { error: { status: 429, reason: "QUOTA_EXCEEDED" } },
				};
			return handle(request);
		};
		await h.hub.sync(new RequestBudget(8), { force: true });
		h.fake.handle = handle;
		await h.hub.sync(new RequestBudget(8), { force: true, playerOnly: true });
		const operation = "GET /me/player/recently-played";
		const hold = read<Record<string, unknown>>(h, "spotify_operation_cooldowns")![operation];
		h.sql.run(
			"INSERT INTO jobs(key,kind,state,priority,run_after,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
			`extend:${before.stationId}`,
			"extend",
			JSON.stringify({ stationId: before.stationId }),
			1,
			h.clock.t,
			0,
			h.clock.t,
			h.clock.t,
		);
		const start = h.fake.calls.length;
		await h.hub.alarm();
		const calls = h.fake.calls.slice(start);
		expect(calls.some((call) => /^PUT \/v1\/playlists\//.test(call))).toBe(true);
		expect(calls).not.toContain("GET /v1/me/player/recently-played");
		const after = h.hub.savedSession()!;
		expect(after.entryIds[after.currentIndex]).toBe(before.entryIds[index]);
		expect(after.progressMs).toBe(97_000);
		expect(read(h, "history_due")).toBe(1);
		expect(read<Record<string, unknown>>(h, "spotify_operation_cooldowns")![operation]).toEqual(
			hold,
		);
	});
});
