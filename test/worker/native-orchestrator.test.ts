import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";
import { expect, it } from "vitest";
import {
	type NativeCommand,
	NativeError,
	nativeIntentCurrent,
} from "../../src/worker/controllers/native";
import { onboarded } from "../hub/harness";

const compiled = transpileModule(readFileSync("src/worker/userhub.ts", "utf8"), {
	compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;
const start = compiled.indexOf("    nativePlay(");
const end = compiled.indexOf("    async observeNative(", start);
if (start < 0 || end < 0) throw new Error("Actual UserHub nativePlay method not found");
const actualNativePlay = runInNewContext(`({${compiled.slice(start, end)}}).nativePlay`, {
	NativeError,
	nativeIntentCurrent,
	crypto,
	Date,
}) as (
	this: unknown,
	epoch: number,
	uid: string,
	stationId: number,
	deviceId: string,
	action: "resume" | "pause" | "next",
	expected?: { sessionId?: string; entryId?: string; orderRevision?: number },
) => Promise<unknown>;

async function reservedTail() {
	const h = await onboarded({ tracks: 200 });
	const id = h.stationIds[0]!;
	const session = h.hub.nativeSession(id);
	h.hub.acceptSessionObservation(id, {
		sessionId: session.sessionId,
		entryId: session.entryIds.at(-10)!,
		playbackEpoch: session.playbackEpoch,
		sequence: 1,
		progressMs: 97000,
		isPlaying: true,
	});
	return { h, id, tail: h.hub.prepareNativeTail(id)! };
}
function shell(h: Awaited<ReturnType<typeof onboarded>>, queue: boolean, fail = false) {
	const storage = new Map<string, unknown>();
	const calls: NativeCommand[] = [];
	let observeCalls = 0;
	const controller = {
		devices: async () => [
			{ id: "media_player.ma", name: "MA", queue, seek: true, pause: true, resume: true },
		],
		command: async (c: NativeCommand) => {
			calls.push(c);
			if (fail) throw new NativeError("native_failed", "Fixture service failed.");
			return { accepted: true };
		},
	};
	return {
		hub: () => h.hub,
		session: (_epoch: number, operation: () => Promise<unknown>) => operation(),
		nativeController: async () => controller,
		ctx: {
			storage: {
				get: async (k: string) => storage.get(k),
				put: async (k: string, value: unknown) => {
					storage.set(k, value);
				},
				delete: async (k: string) => {
					storage.delete(k);
				},
				setAlarm: async () => {},
			},
		},
		observeNative: async () => {
			observeCalls++;
			return null;
		},
		calls,
		storage,
		observations: () => observeCalls,
	};
}
it("actual UserHub full-queue Resume acknowledges cancelled reserved tail once and later refill remains viable", async () => {
	const { h, id, tail } = await reservedTail();
	const initial = h.hub.savedSession(id)!;
	const s = shell(h, true);
	// Explicit cancel has suspended transport, but the locally reserved tail remains durable.
	s.storage.set("native_transport", {
		stationId: id,
		deviceId: "media_player.ma",
		pending: null,
		cancelled: true,
	});
	await actualNativePlay.call(s, 1, "listener", id, "media_player.ma", "resume", {
		sessionId: initial.sessionId,
		entryId: initial.entryIds[initial.currentIndex],
		orderRevision: initial.orderRevision,
	});
	expect(s.calls[0]).toMatchObject({ action: "play", orderRevision: tail.orderRevision });
	expect(s.calls[0]!.queue!.map((entry) => entry.entryId)).toEqual(
		h.hub.sessionView(id, 1000)!.queue.map((entry) => entry.entryId),
	);
	expect(h.hub.prepareNativeTail(id)).toBeNull();
	expect(s.observations()).toBe(1);
	const held = h.hub.savedSession(id)!;
	h.hub.acceptSessionObservation(id, {
		sessionId: held.sessionId,
		entryId: held.entryIds.at(-10)!,
		playbackEpoch: held.playbackEpoch,
		sequence: 2,
		progressMs: 97000,
		isPlaying: true,
	});
	const next = h.hub.prepareNativeTail(id)!;
	expect(next.orderRevision).toBeGreaterThan(tail.orderRevision);
	expect(
		next.entries.some((entry) => tail.entries.some((old) => old.entryId === entry.entryId)),
	).toBe(false);
});
it("actual UserHub Pause and generic single-track Resume retain untransported tail reservations", async () => {
	for (const [queue, action] of [
		[true, "pause"],
		[false, "resume"],
	] as const) {
		const { h, id, tail } = await reservedTail();
		const s = shell(h, queue);
		await actualNativePlay.call(s, 1, "listener", id, "media_player.ma", action);
		expect(h.hub.prepareNativeTail(id)).toEqual(tail);
	}
});

it("failed full-queue Play retains the same durable tail and pending transport intent", async () => {
	const { h, id, tail } = await reservedTail();
	const s = shell(h, true, true);
	await expect(
		actualNativePlay.call(s, 1, "listener", id, "media_player.ma", "resume"),
	).rejects.toMatchObject({ code: "native_failed" });
	expect(h.hub.prepareNativeTail(id)).toEqual(tail);
	expect(s.storage.get("native_transport")).toMatchObject({
		pending: { action: "play", orderRevision: tail.orderRevision },
	});
	expect(s.observations()).toBe(0);
});
