import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const token = "bridge-fixture-bearer-at-least-32-chars";
let child: ChildProcess, base: string, dir: string;
let entity = {
	state: "playing",
	attributes: { media_content_id: "spotify://track/a", media_position: 97, supported_features: 3 },
};
const calls: unknown[] = [];
let serviceFails = false;
const ha = createServer(async (req, res) => {
	let raw = "";
	for await (const part of req) raw += part;
	expect(req.headers.authorization).toBe("Bearer fixture-ha-token");
	if (req.method === "POST") calls.push({ path: req.url, body: JSON.parse(raw) });
	res.setHeader("Content-Type", "application/json");
	if (req.method === "POST" && serviceFails) {
		res.writeHead(500);
		res.end(JSON.stringify({ error: "simulated_failure" }));
		return;
	}
	res.end(
		JSON.stringify(
			req.method === "POST"
				? []
				: req.url === "/api/services"
					? [{ domain: "music_assistant", services: { play_media: {} } }]
					: entity,
		),
	);
});
async function start() {
	child = spawn(process.execPath, ["scripts/native/ha-bridge.mjs"], {
		env: {
			...process.env,
			PORT: "0",
			BRIDGE_TOKEN: token,
			HA_TOKEN: "fixture-ha-token",
			HA_URL: `http://127.0.0.1:${(ha.address() as { port: number }).port}`,
			BRIDGE_STATE_FILE: join(dir, "state.json"),
			BRIDGE_DEVICES: JSON.stringify([
				{
					id: "media_player.ma",
					name: "MA",
					mediaTemplate: "spotify://track/{id}",
					service: "music_assistant.play_media",
					seek: true,
					pause: true,
				},
			]),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const port = await new Promise<string>((resolve, reject) => {
		child.stdout!.once("data", (d) => resolve(String(d).trim()));
		child.once("exit", () => reject(new Error("Bridge failed to start")));
		child.stderr!.on("data", (d) => reject(new Error(String(d))));
	});
	base = `http://127.0.0.1:${port}`;
}
async function stop() {
	const old = child;
	if (!old || old.exitCode !== null) return;
	await new Promise<void>((resolve) => {
		old.once("exit", () => resolve());
		old.kill();
	});
}
async function request(path: string, body?: unknown, auth = token) {
	return fetch(base + path, {
		method: body ? "POST" : "GET",
		headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
}
const command = {
	operationId: "op-1",
	action: "play",
	deviceId: "media_player.ma",
	sessionId: "s",
	entryId: "s:0",
	playbackEpoch: 1,
	orderRevision: 2,
	mediaId: "a",
	positionMs: 97000,
	queue: [
		{ entryId: "s:0", mediaId: "a" },
		{ entryId: "s:1", mediaId: "b" },
	],
};
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "native-bridge-"));
	await new Promise<void>((resolve, reject) => {
		ha.once("error", reject);
		ha.listen(0, "127.0.0.1", resolve);
	});
	await start();
});
afterAll(async () => {
	await stop();
	await new Promise<void>((resolve) => ha.close(() => resolve()));
	await rm(dir, { recursive: true, force: true });
});
describe("real local bridge with HA REST fixture", () => {
	it("denies unauthenticated clients and exposes actual configured capabilities", async () => {
		expect((await request("/v1/devices", undefined, "wrong")).status).toBe(401);
		expect(await (await request("/v1/devices")).json()).toMatchObject([
			{ queue: true, seek: true },
		]);
	});
	it("sends ordered native MA queue and seek, retries without repeating effects", async () => {
		expect((await request("/v1/command", command)).status).toBe(200);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({
			path: "/api/services/music_assistant/play_media",
			body: { media_id: ["spotify://track/a", "spotify://track/b"], enqueue: "replace" },
		});
		expect((await request("/v1/command", command)).status).toBe(200);
		expect(calls).toHaveLength(2);
	});
	it("checkpoints 1:37, trusted native transition, disconnect and restart continuity", async () => {
		const a = await (await request("/v1/state?deviceId=media_player.ma")).json();
		expect(a).toMatchObject({ entryId: "s:0", progressMs: 97000, state: "playing" });
		entity = {
			state: "playing",
			attributes: {
				...entity.attributes,
				media_content_id: "spotify://track/b",
				media_position: 12,
			},
		};
		const b = await (await request("/v1/state?deviceId=media_player.ma")).json();
		expect(b).toMatchObject({ entryId: "s:1", progressMs: 12000 });
		entity.state = "unavailable";
		expect(await (await request("/v1/state?deviceId=media_player.ma")).json()).toMatchObject({
			state: "disconnected",
		});
		await stop();
		await start();
		expect((await request("/v1/command", command)).status).toBe(200);
		expect(calls).toHaveLength(2);
		const resumed = await (await request("/v1/state?deviceId=media_player.ma")).json();
		expect(resumed.sequence).toBeGreaterThan(b.sequence);
		expect(resumed.entryId).toBe("s:1");
	});
	it("fences older epochs and unrelated music instead of replacing queue", async () => {
		expect(
			(await request("/v1/command", { ...command, operationId: "stale", playbackEpoch: 0 })).status,
		).toBe(409);
		entity.state = "playing";
		entity.attributes.media_content_id = "spotify://track/external";
		expect(await (await request("/v1/state?deviceId=media_player.ma")).json()).toMatchObject({
			state: "external",
			progressMs: null,
		});
	});
});

it("appends a fenced MA tail without replacing current playback", async () => {
	entity.state = "playing";
	entity.attributes.media_content_id = "spotify://track/b";
	const append = {
		...command,
		operationId: "tail-1",
		action: "append",
		orderRevision: 3,
		queue: [{ entryId: "s:2", mediaId: "c" }],
	};
	expect((await request("/v1/command", append)).status).toBe(200);
	expect(calls.at(-1)).toMatchObject({
		path: "/api/services/music_assistant/play_media",
		body: { media_id: ["spotify://track/c"], enqueue: "add" },
	});
	const n = calls.length;
	expect((await request("/v1/command", append)).status).toBe(200);
	expect(calls).toHaveLength(n);
});

it("keeps a failed native service intent explicit across retry and bridge restart", async () => {
	serviceFails = true;
	const pending = { ...command, operationId: "ambiguous-2", playbackEpoch: 2 };
	expect((await request("/v1/command", pending)).status).toBe(502);
	const n = calls.length;
	expect((await request("/v1/command", pending)).status).toBe(409);
	expect(calls).toHaveLength(n);
	await stop();
	await start();
	expect((await request("/v1/command", pending)).status).toBe(409);
	expect(calls).toHaveLength(n);
	serviceFails = false;
	expect(
		(
			await request("/v1/command", {
				...pending,
				operationId: "deliberate-resume-3",
				playbackEpoch: 3,
			})
		).status,
	).toBe(200);
});

it("returns to an older saved station with a newer fenced epoch", async () => {
	const other = {
		...command,
		operationId: "other-station",
		sessionId: "other",
		entryId: "other:0",
		playbackEpoch: 1,
		queue: [{ entryId: "other:0", mediaId: "a" }],
	};
	expect((await request("/v1/command", other)).status).toBe(200);
	const previous = { ...command, operationId: "return-station", playbackEpoch: 4 };
	expect((await request("/v1/command", previous)).status).toBe(200);
	expect(
		(
			await request("/v1/command", {
				...command,
				operationId: "replayed-retired-epoch",
				playbackEpoch: 2,
			})
		).status,
	).toBe(409);
});
