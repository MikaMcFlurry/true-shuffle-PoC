import { describe, expect, it } from "vitest";
import {
	parseRetryAfter,
	RequestBudget,
	SpotifyClient,
	type SpotifyCooldown,
	SpotifyError,
	type SpotifyRequestMetric,
	type SpotifyTokens,
} from "../../src/worker/spotify/client";

function fixture(responses: (Response | Promise<Response>)[], expiresAt = 9e15) {
	let now = Date.UTC(2026, 8, 30);
	let cooldown: SpotifyCooldown | null = null;
	let calls = 0;
	let finishes = 0;
	const metrics: SpotifyRequestMetric[] = [];
	let tokens: SpotifyTokens = {
		accessToken: "private-token",
		refreshToken: "private-refresh",
		expiresAt,
		scope: "",
	};
	const states = new Map<string, { revision: number; cooldown: SpotifyCooldown | null }>();
	const create = () =>
		new SpotifyClient({
			endpoints: {
				apiBase: "https://api.test/v1",
				accountsBase: "https://accounts.test",
				clientId: "app",
			},
			tokens: {
				get: async () => tokens,
				set: async (t) => {
					tokens = t;
				},
			},
			budget: new RequestBudget(40),
			now: () => now,
			fetch: async () => {
				calls++;
				return responses.shift() ?? new Response(null, { status: 204 });
			},
			policy: {
				getCooldown: () => cooldown,
				getOperationSnapshot: (op) => states.get(op) ?? { revision: 0, cooldown: null },
				setOperationCooldown: (c) => {
					const old = states.get(c.operation!);
					cooldown = {
						...c,
						until:
							old?.cooldown?.until !== null && old?.cooldown?.until !== undefined
								? Math.max(old.cooldown.until, c.until ?? 0)
								: c.until,
					};
					states.set(c.operation!, { revision: (old?.revision ?? 0) + 1, cooldown });
				},
				finishOperation: (op, rev) => {
					finishes++;
					if (states.get(op)?.revision === rev)
						states.set(op, { revision: rev + 1, cooldown: null });
				},
				setCooldown: (c) => {
					cooldown = c;
				},
				record: (m) => {
					metrics.push(m);
				},
			},
		});
	return {
		create,
		metrics,
		get calls() {
			return calls;
		},
		get finishes() {
			return finishes;
		},
		get cooldown() {
			return cooldown;
		},
		advance: (ms: number) => {
			now += ms;
		},
		setCooldown: (c: SpotifyCooldown) => {
			cooldown = c;
			if (c.operation) states.set(c.operation, { revision: 1, cooldown: c });
		},
	};
}
function quota(retry?: string, reason = "QUOTA_EXCEEDED") {
	return new Response(
		JSON.stringify({
			error: { status: 429, reason, message: "private history spotify:track:secret" },
		}),
		{ status: 429, headers: retry === undefined ? {} : { "Retry-After": retry } },
	);
}

describe("NN-09 centralized provider gate", () => {
	it("records ordinary success without a redundant shared recovery write", async () => {
		const f = fixture([new Response(null, { status: 204 })]);
		await f.create().pause();
		expect(f.finishes).toBe(0);
		expect(f.metrics).toMatchObject([{ operation: "PUT /me/player/pause", status: 204 }]);
	});
	it("still clears a genuinely expired confirmed hold through revision-fenced recovery", async () => {
		const f = fixture([new Response(null, { status: 204 })]);
		f.setCooldown({
			operation: "GET /me/player",
			until: 0,
			kind: "rate",
			retryAfter: "1",
			observedAt: 0,
		});
		await f.create().player();
		expect(f.finishes).toBe(1);
		expect(f.metrics[0]).toMatchObject({ operation: "GET /me/player", status: 204 });
	});
	it("keeps long Retry-After only for the confirmed operation after recreation", async () => {
		const f = fixture([quota("172800")]);
		await expect(f.create().devices()).rejects.toMatchObject({
			kind: "quota",
			retryAfterMs: 172800000,
			retryAfter: "172800",
		});
		const c = f.create();
		const actions = [
			() => c.player(),
			() => c.play({ contextUri: "spotify:playlist:secret" }),
			() => c.pause(),
			() => c.resume(),
			() => c.next(),
			() => c.setShuffle(false),
			() => c.setRepeat("off"),
			() => c.recentlyPlayed(),
			() => c.myPlaylists(),
			() => c.likedTracks(),
			() => c.replaceItems("secret", []),
			() => c.searchTracks("private search"),
		];
		for (const action of actions) await action();
		await expect(c.devices()).rejects.toMatchObject({ operation: "GET /me/player/devices" });
		f.advance(3600000);
		await expect(f.create().devices()).rejects.toBeInstanceOf(SpotifyError);
		expect(f.calls).toBe(13);
		expect(JSON.stringify(f.metrics)).not.toMatch(/private|secret|spotify:|token/);
	});
	it.each([undefined, "invalid secret"])(
		"keeps missing/invalid reset unknown (%s)",
		async (retry) => {
			const f = fixture([quota(retry)]);
			await expect(f.create().player()).rejects.toMatchObject({
				retryAfterMs: 0,
				retryAfter: null,
			});
			expect(f.cooldown?.until).toBeNull();
			f.advance(7 * 86400000);
			await f.create().player();
			expect(f.calls).toBe(2);
		},
	);
	it("preserves HTTP date reset and permits requests only after deadline", async () => {
		const f = fixture([quota("Thu, 01 Oct 2026 00:00:00 GMT")]);
		await expect(f.create().player()).rejects.toMatchObject({ retryAfterMs: 86400000 });
		f.advance(86399999);
		await expect(f.create().player()).rejects.toBeInstanceOf(SpotifyError);
		f.advance(1);
		await f.create().player();
		expect(f.calls).toBe(2);
	});
	it("does not refresh an expired token during cooldown", async () => {
		const f = fixture([], 0);
		f.setCooldown({
			operation: "POST /api/token",
			until: 9e15,
			kind: "quota",
			retryAfter: "1",
			observedAt: 0,
		});
		await expect(f.create().devices()).rejects.toMatchObject({ kind: "quota" });
		expect(f.calls).toBe(0);
	});
	it("token endpoint quota establishes the same durable gate", async () => {
		const f = fixture([quota("7200")], 0);
		await expect(f.create().devices()).rejects.toMatchObject({ kind: "quota" });
		await expect(f.create().pause()).rejects.toMatchObject({ kind: "quota" });
		expect(f.calls).toBe(1);
		expect(f.metrics[0]?.category).toBe("refresh");
	});
	it("identifies quota from reason independently of message and masks resource IDs", async () => {
		const f = fixture([quota("2", "UNKNOWN")]);
		await expect(f.create().playlistItems("secret-user-resource")).rejects.toMatchObject({
			kind: "rate",
			retryAfterMs: 2000,
		});
		expect(f.metrics[0]?.endpoint).toBe("/playlists/:id/items");
	});
	it("retains a later durable deadline for concurrent responses", async () => {
		let resolveShort!: (r: Response) => void;
		const pending = new Promise<Response>((resolve) => {
			resolveShort = resolve;
		});
		const f = fixture([pending, quota("172800")]);
		const shortRequest = f.create().pause();
		// Wait for the first request to pass its gate before the second response records cooldown.
		for (let i = 0; i < 10 && f.calls === 0; i++) await Promise.resolve();
		await expect(f.create().pause()).rejects.toBeInstanceOf(SpotifyError);
		const later = f.cooldown?.until;
		resolveShort(quota("2"));
		await expect(shortRequest).rejects.toBeInstanceOf(SpotifyError);
		expect(f.cooldown?.until).toBe(later);
	});
	it("normalizes HTTP method once for transport, cooldown key, retry policy and metrics", async () => {
		const f = fixture([quota("60")]);
		await expect(f.create().request("get", "/me/player/devices")).rejects.toMatchObject({
			operation: "GET /me/player/devices",
		});
		expect(f.metrics[0]).toMatchObject({
			method: "GET",
			operation: "GET /me/player/devices",
			category: "read",
		});
		const before = f.calls;
		await expect(f.create().request("GeT", "/me/player/devices")).rejects.toMatchObject({
			operation: "GET /me/player/devices",
		});
		expect(f.calls).toBe(before);
		await f.create().request("put", "/me/player/play");
		expect(f.metrics.at(-1)).toMatchObject({
			method: "PUT",
			operation: "PUT /me/player/play",
			category: "write",
		});
	});

	it("request-local success fence cannot clear newer429 after another guard updates", async () => {
		let resolve!: (r: Response) => void;
		const pending = new Promise<Response>((r) => {
			resolve = r;
		});
		const f = fixture([pending, quota("3600")]);
		const c = f.create();
		const old = c.devices();
		for (let i = 0; i < 20 && f.calls === 0; i++) await Promise.resolve();
		await expect(c.devices()).rejects.toMatchObject({ status: 429 });
		await expect(c.devices()).rejects.toMatchObject({ status: 429 });
		resolve(new Response(JSON.stringify({ devices: [] }), { status: 200 }));
		await old;
		const before = f.calls;
		await expect(f.create().devices()).rejects.toMatchObject({ status: 429 });
		expect(f.calls).toBe(before);
	});

	it("reports transport start separately from delayed response for recovery ordering", async () => {
		let resolve!: (r: Response) => void;
		const f = fixture([
			new Promise<Response>((r) => {
				resolve = r;
			}),
		]);
		const pending = f.create().devices();
		for (let i = 0; i < 20 && f.calls === 0; i++) await Promise.resolve();
		f.advance(5000);
		resolve(new Response(JSON.stringify({ devices: [] }), { status: 200 }));
		await pending;
		const metric = f.metrics[0]!;
		expect(metric.startedAt).toBe(metric.at - 5000);
	});

	it("bounds a hanging player command with abort and never blindly retries the write", async () => {
		const controller = new AbortController();
		let calls = 0;
		let seenSignal: AbortSignal | undefined;
		const c = new SpotifyClient({
			endpoints: {
				apiBase: "https://api.test/v1",
				accountsBase: "https://accounts.test",
				clientId: "app",
			},
			tokens: {
				get: async () => ({
					accessToken: "private",
					refreshToken: "private",
					expiresAt: 9e15,
					scope: "",
				}),
				set: async () => {},
			},
			budget: new RequestBudget(5),
			now: () => 0,
			timeoutSignal: () => controller.signal,
			fetch: async (request) => {
				calls++;
				seenSignal = request.signal;
				return new Promise<Response>(() => {});
			},
		});
		const pending = c.pause();
		for (let i = 0; i < 10 && calls === 0; i++) await Promise.resolve();
		controller.abort();
		await expect(pending).rejects.toMatchObject({ kind: "network" });
		expect(seenSignal?.aborted).toBe(true);
		expect(calls).toBe(1);
	});

	it("does not blindly retry a player write after ambiguous server failure", async () => {
		const f = fixture([new Response(null, { status: 503 })]);
		await expect(f.create().pause()).rejects.toMatchObject({ kind: "server" });
		expect(f.calls).toBe(1);
	});

	it("authorization exchange obeys deployment gate before sending a code", async () => {
		let calls = 0;
		const policy = {
			getCooldown: () => null,
			getOperationSnapshot: () => ({
				revision: 1,
				cooldown: {
					operation: "POST /api/token",
					until: 9e15,
					kind: "quota" as const,
					retryAfter: "1",
					observedAt: 0,
				},
			}),
			setCooldown: () => {},
		};
		await expect(
			SpotifyClient.exchangeCode(
				{ apiBase: "https://api.test/v1", accountsBase: "https://accounts.test", clientId: "app" },
				async () => {
					calls++;
					return quota();
				},
				"private-code",
				"https://app.test/callback",
				"private-verifier",
				0,
				policy,
			),
		).rejects.toMatchObject({ kind: "quota" });
		expect(calls).toBe(0);
	});
	it("refuses absolute paging URLs on other origins without leaking bearer tokens", async () => {
		const f = fixture([]);
		await expect(f.create().request("GET", "https://other.test/v1/me")).rejects.toMatchObject({
			kind: "bad_request",
		});
		expect(f.calls).toBe(0);
	});
});

describe("Retry-After parsing", () => {
	it("accepts seconds and dates without a guessed fallback", () => {
		expect(parseRetryAfter("0", 0)).toEqual({ raw: "0", ms: 0 });
		expect(parseRetryAfter("2.5", 0)).toEqual({ raw: "2.5", ms: 2500 });
		expect(parseRetryAfter("-1", 0)).toBeNull();
		expect(parseRetryAfter(null, 0)).toBeNull();
		expect(parseRetryAfter("unknown", 0)).toBeNull();
	});
});
