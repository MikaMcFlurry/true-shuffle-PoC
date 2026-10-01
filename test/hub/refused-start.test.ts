import { expect, it } from "vitest";
import { RequestBudget } from "../../src/worker/spotify/client";
import { onboarded } from "./harness";

const observe = (h: Awaited<ReturnType<typeof onboarded>>) =>
	h.hub.sync(new RequestBudget(25), { force: true });

it.each([
	[403, "PREMIUM_REQUIRED", "premium"],
	[404, "NO_ACTIVE_DEVICE", "no_device"],
	[403, "RESTRICTION_VIOLATED", "restricted"],
] as const)(
	"keeps the prior saved station and both checkpoints after a definitive %s/%s refusal",
	async (status, reason, code) => {
		const h = await onboarded({ playlists: [60, 60] });
		const [a, b] = h.stationIds as [number, number];
		await h.hub.play(b);
		h.fake.user().player.progressMs = 42_000;
		await observe(h);
		await h.hub.playerAction("pause");
		const candidate = h.hub.savedSession(b)!;
		await h.hub.play(a);
		h.fake.user().player.progressMs = 97_000;
		await observe(h);
		await h.hub.playerAction("pause");
		const prior = h.hub.savedSession(a)!;
		const handle = h.fake.handle.bind(h.fake);
		h.fake.handle = async (req) =>
			req.method === "PUT" && new URL(req.url).pathname === "/v1/me/player/play"
				? new Response(JSON.stringify({ error: { status, reason, message: reason } }), { status })
				: handle(req);
		const result = await h.hub.play(b, "mika-phone");
		expect(result).toMatchObject({ ok: false, error: { code } });
		expect(result.uncertain).toBeUndefined();
		expect((await h.hub.state()).session).toMatchObject({
			stationId: a,
			sessionId: prior.sessionId,
			entryId: prior.entryIds[prior.currentIndex],
			progressMs: 97_000,
		});
		expect(h.hub.savedSession(b)).toMatchObject({
			sessionId: candidate.sessionId,
			entryIds: candidate.entryIds,
			currentIndex: candidate.currentIndex,
			progressMs: 42_000,
			pending: null,
		});
		h.restart();
		expect(h.hub.savedSession()!.stationId).toBe(a);
		h.fake.handle = handle;
		expect(await h.hub.play(b, "mika-phone")).toMatchObject({ ok: true });
		expect(h.hub.savedSession()!.stationId).toBe(b);
		expect(h.fake.user().player.progressMs).toBe(42_000);
	},
);

it("does not display a never-started initial candidate after local device discovery finds no device", async () => {
	const h = await onboarded({ tracks: 60 });
	const id = h.stationIds[0]!;
	h.fake.user().devices = [];
	expect(await h.hub.play(id)).toMatchObject({ ok: false, error: { code: "no_device" } });
	expect((await h.hub.state()).session).toBeNull();
	expect(h.hub.savedSession(id)).toMatchObject({ pending: null, status: "disconnected" });
	h.restart();
	expect(h.hub.savedSession()).toBeNull();
});

it.each(["server", "network"])(
	"keeps a submitted other-station intent visible after an applied start with lost %s response",
	async (failure) => {
		const h = await onboarded({ playlists: [60, 60] });
		const [a, b] = h.stationIds as [number, number];
		await h.hub.play(a);
		h.fake.user().player.progressMs = 97_000;
		await observe(h);
		await h.hub.playerAction("pause");
		const prior = h.hub.savedSession(a)!;
		const handle = h.fake.handle.bind(h.fake);
		let starts = 0;
		h.fake.handle = async (req) => {
			const result = await handle(req);
			if (req.method === "PUT" && new URL(req.url).pathname === "/v1/me/player/play") {
				starts++;
				if (failure === "network") throw new Error("fixture lost applied response");
				return new Response(JSON.stringify({ error: { status: 500, message: "response lost" } }), {
					status: 500,
				});
			}
			return result;
		};
		expect(await h.hub.play(b)).toMatchObject({ ok: false, uncertain: true });
		expect(h.hub.savedSession()).toMatchObject({
			stationId: b,
			pending: { kind: "resume", phase: "submitted" },
		});
		expect(h.hub.savedSession(a)).toMatchObject({
			sessionId: prior.sessionId,
			entryIds: prior.entryIds,
			progressMs: 97_000,
		});
		h.fake.handle = handle;
		h.restart();
		await h.listen(1000);
		expect(starts).toBe(1);
		expect(h.hub.savedSession()).toMatchObject({ stationId: b, pending: null, status: "active" });
	},
);

it.each([
	[403, "PREMIUM_REQUIRED", "premium"],
	[404, "NO_ACTIVE_DEVICE", "no_device"],
	[403, "RESTRICTION_VIOLATED", "restricted"],
] as const)(
	"does not promote an initial candidate after definitive %s/%s rejection",
	async (status, reason, code) => {
		const h = await onboarded({ tracks: 60 });
		const id = h.stationIds[0]!;
		const handle = h.fake.handle.bind(h.fake);
		h.fake.handle = async (req) =>
			req.method === "PUT" && new URL(req.url).pathname === "/v1/me/player/play"
				? new Response(JSON.stringify({ error: { status, reason, message: reason } }), { status })
				: handle(req);
		expect(await h.hub.play(id, "mika-phone")).toMatchObject({ ok: false, error: { code } });
		expect(h.hub.savedSession()).toBeNull();
		const candidate = h.hub.savedSession(id)!;
		expect(candidate.pending).toBeNull();
		h.fake.handle = handle;
		h.restart();
		expect(await h.hub.play(id, "mika-phone")).toMatchObject({ ok: true });
		expect(h.hub.savedSession()).toMatchObject({
			sessionId: candidate.sessionId,
			entryIds: candidate.entryIds,
		});
	},
);

it("keeps the native held occurrence visible when Spotify has no target device for another station", async () => {
	const h = await onboarded({ playlists: [60, 60] });
	const [a, b] = h.stationIds as [number, number];
	const native = h.hub.nativeSession(a);
	h.hub.acceptSessionObservation(a, {
		sessionId: native.sessionId,
		entryId: native.entryIds[native.currentIndex]!,
		playbackEpoch: native.playbackEpoch,
		sequence: 1,
		progressMs: 97_000,
		isPlaying: false,
	});
	h.fake.user().devices = [];
	expect(await h.hub.play(b)).toMatchObject({ ok: false, error: { code: "no_device" } });
	expect(h.hub.savedSession()).toMatchObject({
		stationId: a,
		sessionId: native.sessionId,
		entryIds: native.entryIds,
		progressMs: 97_000,
		controller: "native",
		status: "paused",
	});
});
