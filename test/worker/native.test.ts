import { describe, expect, it } from "vitest";
import {
	NativeController,
	nativeBinding,
	nativeIntentCurrent,
} from "../../src/worker/controllers/native";

const binding = { url: "https://bridge.example", token: "fixture-token-32-characters-minimum" };
describe("native authenticated account adapter", () => {
	it("requires explicit account authorization and valid HTTPS destination", () => {
		expect(nativeBinding(JSON.stringify({ alice: binding }), "bob")).toBeNull();
		expect(nativeBinding(undefined, "alice")).toBeNull();
		for (const url of [
			"http://localhost",
			"https://user:pass@example.com",
			"https://example.com?target=evil",
		])
			expect(() =>
				nativeBinding(JSON.stringify({ alice: { ...binding, url } }), "alice"),
			).toThrow();
		expect(nativeBinding(JSON.stringify({ alice: binding }), "alice")).toEqual(binding);
	});
	it("uses bearer only server-side, refuses redirect, observes capability fixtures", async () => {
		const controller = new NativeController(binding, async (request) => {
			expect(request.headers.get("authorization")).toBe(`Bearer ${binding.token}`);
			expect(request.redirect).toBe("error");
			return Response.json([
				{
					id: "media_player.ma",
					name: "Music Assistant",
					provider: "home-assistant",
					seek: true,
					resume: true,
					pause: true,
					queue: true,
				},
				{
					id: "unexpected",
					name: "Bad",
					provider: "home-assistant",
					seek: true,
					resume: true,
					pause: true,
				},
			]);
		});
		expect(await controller.devices()).toHaveLength(1);
	});
	it("revocation and unreachable bridge return sanitized errors", async () => {
		const controller = new NativeController(binding, async () => new Response("", { status: 403 }));
		await expect(controller.devices()).rejects.toMatchObject({ code: "native_revoked" });
		const offline = new NativeController(binding, async () => {
			throw new Error(binding.token);
		});
		await expect(offline.devices()).rejects.toMatchObject({ code: "native_disconnected" });
		await expect(offline.devices()).rejects.not.toThrow(binding.token);
	});
	it("validates sequenced occurrence observations including backwards seek", async () => {
		const observation = {
			sessionId: "s",
			entryId: "s:0",
			playbackEpoch: 1,
			orderRevision: 3,
			sequence: 4,
			progressMs: 97000,
			isPlaying: true,
			state: "playing",
			deviceId: "media_player.ma",
		};
		const controller = new NativeController(binding, async () => Response.json(observation));
		expect((await controller.observe("media_player.ma"))?.progressMs).toBe(97000);
		observation.progressMs = 12000;
		expect((await controller.observe("media_player.ma"))?.progressMs).toBe(12000);
		observation.sequence = NaN;
		await expect(controller.observe("media_player.ma")).rejects.toMatchObject({
			code: "native_protocol",
		});
	});
});

describe("native pending recovery fence", () => {
	const pending = {
		operationId: "op",
		action: "play" as const,
		deviceId: "media_player.ma",
		sessionId: "s",
		entryId: "s:0",
		playbackEpoch: 2,
		orderRevision: 1,
	};
	const transport = {
		stationId: 1,
		pending,
		prepared: { sessionId: "s", playbackEpoch: 2, sequence: -1 },
	};
	const session = {
		stationId: 1,
		controller: "native",
		sessionId: "s",
		playbackEpoch: 2,
		sequence: -1,
	};
	it("retries only the still-held native session, not Spotify switches or stale epochs", () => {
		expect(nativeIntentCurrent(session, transport)).toBe(true);
		for (const changed of [
			{ ...session, controller: "spotify" },
			{ ...session, playbackEpoch: 3 },
			{ ...session, sessionId: "new" },
			{ ...session, stationId: 2 },
			{ ...session, sequence: 4 },
		])
			expect(nativeIntentCurrent(changed, transport)).toBe(false);
	});
});

it("does not commit a bridge accepted:false response", async () => {
	const controller = new NativeController(binding, async () => Response.json({ accepted: false }));
	await expect(
		controller.command({
			operationId: "op",
			action: "play",
			deviceId: "media_player.ma",
			sessionId: "s",
			entryId: "s:0",
			playbackEpoch: 1,
			orderRevision: 1,
		}),
	).rejects.toMatchObject({ code: "native_rejected" });
});
