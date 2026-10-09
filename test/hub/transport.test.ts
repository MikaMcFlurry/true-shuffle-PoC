import { describe, expect, it } from "vitest";
import { RequestBudget } from "../../src/worker/spotify/client";
import { onboarded } from "./harness";

const observe = (h: Awaited<ReturnType<typeof onboarded>>) =>
	h.hub.sync(new RequestBudget(25), { force: true });
const error = (status: number, reason: string) =>
	new Response(JSON.stringify({ error: { status, reason, message: reason } }), {
		status,
		...(status === 429 ? { headers: { "Retry-After": "60" } } : {}),
	});
const paused = async () => {
	const h = await onboarded({ tracks: 60 });
	const id = h.stationIds[0]!;
	await h.hub.play(id);
	h.fake.user().player.progressMs = 97_000;
	await observe(h);
	await h.hub.playerAction("pause");
	return { h, id };
};

describe("provider acknowledgement and checkpoint integrity", () => {
	it("rejects a stale Next when its fresh preflight discovers a naturally advanced occurrence", async () => {
		const { h, id } = await paused();
		await h.hub.play(id);
		const before = h.hub.savedSession(id)!;
		const expected = {
			sessionId: before.sessionId,
			entryId: before.entryIds[before.currentIndex]!,
		};
		const remaining =
			h.fake.tracks.get(h.fake.current()!)!.durationMs - h.fake.user().player.progressMs + 1;
		h.clock.t += remaining;
		h.fake.advance(remaining);
		const actualSong = h.fake.current();
		const calls = h.fake.calls.length;
		const result = await h.hub.playerAction("next", expected);
		expect(result).toMatchObject({
			ok: false,
			error: { message: "Die Ansicht ist veraltet. Bitte aktualisieren." },
		});
		expect(result.uncertain).toBeUndefined();
		expect(h.fake.calls.slice(calls)).toEqual(["GET /v1/me/player"]);
		expect(h.fake.current()).toBe(actualSong);
		expect(h.hub.savedSession(id)).toMatchObject({
			currentIndex: before.currentIndex + 1,
			pending: null,
		});
	});

	it("revalidates the expected session after Spotify-side playback switches to another saved queue", async () => {
		const { h, id } = await paused();
		await h.hub.play(h.allId);
		const other = h.hub.savedSession(h.allId)!;
		await h.hub.play(id);
		const before = h.hub.savedSession(id)!;
		h.fake.startContext("mika", other.contextUri, other.currentIndex, "mika-phone", false);
		const calls = h.fake.calls.length;
		expect(await h.hub.playerAction("next", { sessionId: before.sessionId })).toMatchObject({
			ok: false,
		});
		expect(h.fake.calls.slice(calls)).toEqual(["GET /v1/me/player"]);
		expect(h.hub.savedSession()!.sessionId).toBe(other.sessionId);
		expect(h.fake.user().player.index).toBe(other.currentIndex);
	});

	it("does not skip a fenced occurrence when the fresh player observation fails", async () => {
		const { h, id } = await paused();
		const before = h.hub.savedSession(id)!;
		const handle = h.fake.handle.bind(h.fake);
		h.fake.handle = async (req) =>
			new URL(req.url).pathname === "/v1/me/player" ? error(500, "unavailable") : handle(req);
		const calls = h.fake.calls.length;
		expect(
			await h.hub.playerAction("next", {
				sessionId: before.sessionId,
				entryId: before.entryIds[before.currentIndex]!,
			}),
		).toMatchObject({ ok: false });
		expect(h.fake.calls.slice(calls)).not.toContain("POST /v1/me/player/next");
		expect(h.hub.savedSession(id)!.pending).toBeNull();
	});

	it.each(["server", "network"])(
		"reports an applied pause with a lost %s response as uncertain and observes it durably",
		async (failure) => {
			const { h, id } = await paused();
			await h.hub.play(id);
			await observe(h);
			const before = h.hub.savedSession(id)!;
			h.fake.user().player.progressMs = 120_000;
			const handle = h.fake.handle.bind(h.fake);
			let writes = 0;
			h.fake.handle = async (req) => {
				const response = await handle(req);
				if (req.method === "PUT" && new URL(req.url).pathname === "/v1/me/player/pause") {
					writes++;
					if (failure === "network") throw new Error("fixture response lost");
					return error(500, "response lost after applying pause");
				}
				return response;
			};
			expect(await h.hub.playerAction("pause")).toMatchObject({
				ok: false,
				uncertain: true,
				error: { code: "unknown" },
			});
			expect(h.fake.user().player.isPlaying).toBe(false);
			expect(writes).toBe(1);
			expect(h.hub.savedSession(id)).toMatchObject({
				progressMs: before.progressMs,
				observedAt: before.observedAt,
			});
			expect(h.sql.first("SELECT v FROM kv WHERE k = 'player_observation_due'")).not.toBeNull();
			h.fake.handle = handle;
			h.restart();
			await h.listen(1000);
			expect(h.hub.savedSession(id)).toMatchObject({ progressMs: 120_000, status: "paused" });
		},
	);

	it.each([
		[404, "NO_ACTIVE_DEVICE", "no_device"],
		[403, "RESTRICTION_VIOLATED", "restricted"],
		[429, "QUOTA_EXCEEDED", "quota"],
	])("reports an actual %s %s pause rejection as definite", async (status, reason, code) => {
		const { h, id } = await paused();
		await h.hub.play(id);
		const handle = h.fake.handle.bind(h.fake);
		h.fake.handle = async (req) =>
			req.method === "PUT" && new URL(req.url).pathname === "/v1/me/player/pause"
				? error(status as number, reason as string)
				: handle(req);
		const result = await h.hub.playerAction("pause");
		expect(result).toMatchObject({ ok: false, error: { code } });
		expect(result.uncertain).toBeUndefined();
		expect(h.fake.user().player.isPlaying).toBe(true);
	});

	it.each(["resume", "next"] as const)(
		"reports an applied %s with a lost response as uncertain and reconciles without another write",
		async (action) => {
			const { h, id } = await paused();
			const before = h.hub.savedSession(id)!;
			const path = action === "resume" ? "/v1/me/player/play" : "/v1/me/player/next";
			const handle = h.fake.handle.bind(h.fake);
			let writes = 0;
			h.fake.handle = async (req) => {
				const response = await handle(req);
				if (new URL(req.url).pathname === path) {
					writes++;
					return error(500, "fixture response lost after execution");
				}
				return response;
			};
			const result = await h.hub.playerAction(action);
			expect(result).toMatchObject({ ok: false, uncertain: true });
			expect(result.acceptedAt).toBeUndefined();
			expect(writes).toBe(1);
			expect(h.hub.savedSession(id)).toMatchObject({
				currentIndex: before.currentIndex,
				progressMs: before.progressMs,
				pending: { kind: action, phase: "submitted" },
			});
			h.fake.handle = handle;
			h.restart();
			await h.listen(1000);
			expect(h.hub.savedSession(id)!.pending).toBeNull();
			expect(h.hub.savedSession(id)!.currentIndex).toBe(
				before.currentIndex + (action === "next" ? 1 : 0),
			);
		},
	);

	it("keeps a refresh network failure before pause distinct from an uncertain player write", async () => {
		const { h, id } = await paused();
		await h.hub.play(id);
		h.clock.t += 3_600_000;
		const handle = h.fake.handle.bind(h.fake);
		h.fake.handle = async (req) => {
			if (new URL(req.url).pathname === "/accounts/api/token")
				throw new Error("fixture refresh unavailable");
			return handle(req);
		};
		const calls = h.fake.calls.length;
		const result = await h.hub.playerAction("pause");
		expect(result.ok).toBe(false);
		expect(result.uncertain).toBeUndefined();
		expect(h.fake.calls.slice(calls)).not.toContain("PUT /v1/me/player/pause");
		expect(h.fake.user().player.isPlaying).toBe(true);
	});

	it.each(["next", "resume"] as const)(
		"releases a rejected %s intent when its automatic 401 refresh fails and permits the same occurrence retry",
		async (action) => {
			const { h, id } = await paused();
			const before = h.hub.savedSession(id)!;
			const expected = {
				sessionId: before.sessionId,
				entryId: before.entryIds[before.currentIndex]!,
			};
			const path = action === "next" ? "/v1/me/player/next" : "/v1/me/player/play";
			const handle = h.fake.handle.bind(h.fake);
			let playerAttempts = 0;
			let refreshAttempts = 0;
			h.fake.handle = async (req) => {
				const endpoint = new URL(req.url).pathname;
				if (endpoint === path) {
					playerAttempts++;
					return error(401, "fixture expired access token");
				}
				if (endpoint === "/accounts/api/token") {
					refreshAttempts++;
					throw new Error("fixture refresh connection lost");
				}
				return handle(req);
			};
			const result = await h.hub.playerAction(action, expected);
			expect(result.ok).toBe(false);
			expect(result.uncertain).toBeUndefined();
			expect(playerAttempts).toBe(1);
			expect(refreshAttempts).toBe(1);
			expect(h.fake.user().player.index).toBe(before.currentIndex);
			expect(h.fake.user().player.isPlaying).toBe(false);
			expect(h.hub.savedSession(id)).toMatchObject({
				sessionId: before.sessionId,
				entryIds: before.entryIds,
				currentIndex: before.currentIndex,
				progressMs: before.progressMs,
				pending: null,
			});
			h.fake.handle = handle;
			h.restart();
			expect(await h.hub.playerAction(action, expected)).toMatchObject({ ok: true });
			expect(h.fake.user().player.index).toBe(before.currentIndex + (action === "next" ? 1 : 0));
			if (action === "resume") expect(h.fake.user().player.progressMs).toBe(before.progressMs);
		},
	);

	it("resumes through one fresh player read and one play write while observing a paused backwards seek", async () => {
		const { h, id } = await paused();
		const before = h.hub.savedSession(id)!;
		h.fake.user().player.progressMs = 12_000;
		const calls = h.fake.calls.length;
		const result = await h.hub.play(id);
		expect(result).toMatchObject({ ok: true, acceptedAt: h.clock.t });
		expect(h.fake.calls.slice(calls)).toEqual(["GET /v1/me/player", "PUT /v1/me/player/play"]);
		expect(h.fake.user().player.progressMs).toBe(12_000);
		expect(h.hub.savedSession(id)).toMatchObject({
			sessionId: before.sessionId,
			entryIds: before.entryIds,
			currentIndex: before.currentIndex,
			progressMs: 12_000,
		});
		expect(h.sql.first("SELECT v FROM kv WHERE k = 'history_due'")).not.toBeNull();
		h.restart();
		await h.listen(1000);
		expect(h.sql.first("SELECT v FROM kv WHERE k = 'history_due'")).toBeNull();
	});

	it("never acknowledges stale playing snapshots after the fresh player request fails", async () => {
		const { h, id } = await paused();
		const handle = h.fake.handle.bind(h.fake);
		h.fake.handle = async (req) =>
			req.method === "GET" && new URL(req.url).pathname === "/v1/me/player"
				? error(500, "temporarily unavailable")
				: handle(req);
		const calls = h.fake.calls.length;
		expect(await h.hub.play(id, "mika-phone")).toMatchObject({ ok: true });
		expect(h.fake.calls.slice(calls)).toEqual([
			"PUT /v1/me/player/shuffle",
			"PUT /v1/me/player/repeat",
			"PUT /v1/me/player/play",
		]);
		expect(h.fake.user().player.isPlaying).toBe(true);
		expect(h.fake.user().player.progressMs).toBe(97_000);
	});

	it("sets unknown repeat mode before starting without repeating a known shuffle setting", async () => {
		const { h, id } = await paused();
		const handle = h.fake.handle.bind(h.fake);
		h.fake.handle = async (req) => {
			const response = await handle(req);
			if (req.method !== "GET" || new URL(req.url).pathname !== "/v1/me/player") return response;
			const state = (await response.json()) as Record<string, unknown>;
			delete state.repeat_state;
			return Response.json(state);
		};
		const calls = h.fake.calls.length;
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.fake.calls.slice(calls)).toEqual([
			"GET /v1/me/player",
			"PUT /v1/me/player/repeat",
			"PUT /v1/me/player/play",
		]);
	});

	it("fences a player response captured before pause from overwriting its checkpoint or snapshot", async () => {
		const { h, id } = await paused();
		await h.hub.play(id);
		const before = h.hub.savedSession(id)!;
		h.fake.user().player.progressMs = 120_000;
		const handle = h.fake.handle.bind(h.fake);
		let captured!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			captured = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		h.fake.handle = async (req) => {
			const result = await handle(req);
			if (req.method === "GET" && new URL(req.url).pathname === "/v1/me/player") {
				captured();
				await gate;
			}
			return result;
		};
		const stale = observe(h);
		await started;
		try {
			expect(await h.hub.playerAction("pause")).toMatchObject({ ok: true });
		} finally {
			release();
		}
		expect(await stale).toBe(false);
		expect(h.hub.savedSession(id)).toMatchObject({
			progressMs: before.progressMs,
			observedAt: before.observedAt,
			status: "paused",
		});
		expect(h.sql.first("SELECT v FROM kv WHERE k = 'player_observation_due'")).not.toBeNull();
		h.fake.handle = handle;
		await h.listen(1000);
		expect(h.hub.savedSession(id)).toMatchObject({ progressMs: 120_000, status: "paused" });
	});

	it("keeps next as an intent until an actual observation identifies the next occurrence", async () => {
		const { h, id } = await paused();
		const before = h.hub.savedSession(id)!;
		expect(await h.hub.playerAction("next")).toMatchObject({ ok: true });
		expect(h.hub.savedSession(id)).toMatchObject({
			currentIndex: before.currentIndex,
			progressMs: before.progressMs,
			observedAt: before.observedAt,
			pending: { kind: "next", phase: "submitted" },
		});
		h.restart();
		await h.listen(1000);
		expect(h.hub.savedSession(id)).toMatchObject({
			currentIndex: before.currentIndex + 1,
			progressMs: 0,
			pending: null,
		});
	});

	it("retains checkpoint and releases a definitely rejected next for a later retry", async () => {
		const { h, id } = await paused();
		const before = h.hub.savedSession(id)!;
		h.fake.user().premium = false;
		expect(await h.hub.playerAction("next")).toMatchObject({
			ok: false,
			error: { code: "premium" },
		});
		expect(h.hub.savedSession(id)).toMatchObject({
			currentIndex: before.currentIndex,
			progressMs: 97_000,
			pending: null,
		});
		h.fake.user().premium = true;
		expect(await h.hub.playerAction("next")).toMatchObject({ ok: true });
	});

	it("retains deferred history work through an independent actual history 429", async () => {
		const { h, id } = await paused();
		await h.hub.play(id);
		const handle = h.fake.handle.bind(h.fake);
		let history = 0;
		h.fake.handle = async (req) => {
			if (new URL(req.url).pathname === "/v1/me/player/recently-played") {
				history++;
				return error(429, "QUOTA_EXCEEDED");
			}
			return handle(req);
		};
		await h.listen(1000);
		expect(history).toBe(1);
		expect(h.sql.first("SELECT v FROM kv WHERE k = 'history_due'")).not.toBeNull();
		await h.hub.playerAction("pause");
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(history).toBe(1);
	});
});

describe("bounded Spotify Connect target selection", () => {
	it("honors an explicit target absent from device discovery without switching to another device", async () => {
		const { h, id } = await paused();
		h.fake.user().devices.push({ id: "speaker", name: "Box", type: "Speaker", restricted: false });
		const handle = h.fake.handle.bind(h.fake);
		let discoveries = 0;
		h.fake.handle = async (req) => {
			if (new URL(req.url).pathname === "/v1/me/player/devices") {
				discoveries++;
				return Response.json({ devices: [] });
			}
			return handle(req);
		};
		expect(await h.hub.play(id, "speaker")).toMatchObject({ ok: true });
		expect(h.fake.user().player.deviceId).toBe("speaker");
		expect(discoveries).toBe(0);
		expect(await h.hub.play(id, "missing")).toMatchObject({
			ok: false,
			error: { code: "no_device" },
		});
		expect(h.fake.user().player.deviceId).toBe("speaker");
		expect(discoveries).toBe(0);
	});

	it("automatically uses the freshly observed iPhone even when discovery would return an empty list", async () => {
		const { h, id } = await paused();
		const handle = h.fake.handle.bind(h.fake);
		let discoveries = 0;
		h.fake.handle = async (req) => {
			if (new URL(req.url).pathname === "/v1/me/player/devices") {
				discoveries++;
				return Response.json({ devices: [] });
			}
			return handle(req);
		};
		expect(await h.hub.play(id)).toMatchObject({ ok: true, deviceName: "iPhone" });
		expect(h.fake.user().player.deviceId).toBe("mika-phone");
		expect(discoveries).toBe(0);
	});

	it("reuses device discovery for 60 seconds across restart and then refreshes it", async () => {
		const { h } = await paused();
		await h.hub.devices();
		const calls = h.fake.calls.length;
		h.restart();
		await h.hub.devices();
		h.clock.t += 59_999;
		await h.hub.devices();
		expect(h.fake.calls.length).toBe(calls);
		h.clock.t += 1;
		await h.hub.devices();
		expect(h.fake.calls.slice(calls)).toEqual(["GET /v1/me/player/devices"]);
	});

	it("refreshes once after an actual stale auto-target rejection and tries a different discovered target", async () => {
		const { h, id } = await paused();
		await h.hub.devices();
		h.fake.user().player.deviceId = null;
		h.fake.user().devices = [
			{ id: "new-phone", name: "iPhone neu", type: "Smartphone", restricted: false },
		];
		const calls = h.fake.calls.length;
		expect(await h.hub.play(id)).toMatchObject({ ok: true, deviceName: "iPhone neu" });
		expect(h.fake.user().player.deviceId).toBe("new-phone");
		const after = h.fake.calls.slice(calls);
		expect(after.filter((call) => call === "GET /v1/me/player/devices")).toHaveLength(1);
		expect(after.filter((call) => call === "PUT /v1/me/player/play")).toHaveLength(2);
		expect(h.hub.savedSession(id)!.progressMs).toBe(97_000);
	});

	it.each([429, 500])(
		"never repeats an auto transport write after an actual %s response",
		async (status) => {
			const { h, id } = await paused();
			const handle = h.fake.handle.bind(h.fake);
			let writes = 0;
			let discoveries = 0;
			h.fake.handle = async (req) => {
				const path = new URL(req.url).pathname;
				if (path === "/v1/me/player/devices") discoveries++;
				if (req.method === "PUT" && path === "/v1/me/player/play") {
					writes++;
					return error(status, status === 429 ? "QUOTA_EXCEEDED" : "unavailable");
				}
				return handle(req);
			};
			expect(await h.hub.play(id)).toMatchObject({ ok: false });
			expect(writes).toBe(1);
			expect(discoveries).toBe(0);
			expect(h.hub.savedSession(id)!.progressMs).toBe(97_000);
			if (status === 429) {
				expect(h.hub.savedSession(id)!.pending).toBeNull();
				expect(await h.hub.play(id)).toMatchObject({ ok: false, error: { code: "quota" } });
				expect(writes).toBe(1);
			} else expect(h.hub.savedSession(id)!.pending?.phase).toBe("submitted");
		},
	);
});

it("returns the current occurrence and 50 queued songs from durable order without Spotify traffic", async () => {
	const { h, id } = await paused();
	const before = h.hub.savedSession(id)!;
	const calls = h.fake.calls.length;
	const preview = h.hub.sessionView(id)!;
	expect(preview.queue).toHaveLength(51);
	expect(preview.queue.map((entry) => entry.entryId)).toEqual(
		before.entryIds.slice(before.currentIndex, before.currentIndex + 51),
	);
	expect(h.fake.calls.length).toBe(calls);
	expect(h.hub.savedSession(id)).toEqual(before);
});
