/** Run on the HA network; publish only through authenticated HTTPS (e.g. Tunnel). */

import { timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const token = process.env.BRIDGE_TOKEN;
const haToken = process.env.HA_TOKEN;
const haUrl = process.env.HA_URL;
const file = process.env.BRIDGE_STATE_FILE || "./native-state.json";
const devices = JSON.parse(process.env.BRIDGE_DEVICES || "[]");
if (!token || token.length < 32 || !haToken || !haUrl)
	throw new Error("Set BRIDGE_TOKEN (32+ chars), HA_TOKEN, HA_URL");
if (
	!devices.every(
		(d) =>
			/^media_player\.[a-z0-9_]+$/.test(d.id) &&
			typeof d.name === "string" &&
			typeof d.mediaTemplate === "string" &&
			d.mediaTemplate.includes("{id}"),
	)
)
	throw new Error("Explicit device id/name/mediaTemplate required");
let state = { sequence: 0, devices: {}, commands: {} };
try {
	state = JSON.parse(await readFile(file, "utf8"));
} catch (e) {
	if (e.code !== "ENOENT") throw e;
}
async function save() {
	await writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
	await rename(`${file}.tmp`, file);
}
async function ha(path, body) {
	const r = await fetch(`${haUrl.replace(/\/$/, "")}/api/${path}`, {
		method: body ? "POST" : "GET",
		headers: { Authorization: `Bearer ${haToken}`, "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
		redirect: "error",
		signal: AbortSignal.timeout(10000),
	});
	if (!r.ok) throw new Error(`HA request failed (${r.status})`);
	return r.json();
}
function authorized(req) {
	const supplied = Buffer.from(req.headers.authorization || "");
	const wanted = Buffer.from(`Bearer ${token}`);
	return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}
async function observe(d) {
	const context = state.devices[d.id];
	if (!context) return null;
	const entity = await ha(`states/${d.id}`);
	const a = entity.attributes || {};
	const disconnected = ["unavailable", "unknown", "off"].includes(entity.state);
	// Context is trusted only when HA reports the exact configured media identity.
	const candidates = (
		context.queue || [{ entryId: context.context.entryId, mediaId: context.mediaId }]
	).filter((entry) => entry.mediaId === a.media_content_id);
	const matches = candidates.length === 1;
	if (matches) {
		context.context.entryId = candidates[0].entryId;
		if (context.queue)
			context.queue = context.queue.slice(
				context.queue.findIndex((entry) => entry.entryId === candidates[0].entryId),
			);
	}
	const status = disconnected
		? "disconnected"
		: matches
			? entity.state === "playing"
				? "playing"
				: "paused"
			: candidates.length > 1
				? "ambiguous"
				: "external";
	const progressMs =
		matches && typeof a.media_position === "number"
			? Math.max(0, Math.round(a.media_position * 1000))
			: null;
	const observation = {
		...context.context,
		deviceId: d.id,
		sequence: ++state.sequence,
		state: status,
		isPlaying: status === "playing",
		progressMs,
	};
	await save();
	return observation;
}
async function command(c) {
	if (!c || typeof c !== "object") return [400, { error: "bad_command" }];
	const d = devices.find((x) => x.id === c.deviceId);
	if (!d) return [403, { error: "device_denied" }];
	if (
		!c ||
		!/^[a-zA-Z0-9:-]{1,200}$/.test(c.operationId || "") ||
		typeof c.sessionId !== "string" ||
		!/^[A-Za-z0-9:-]{1,200}$/.test(c.sessionId) ||
		typeof c.entryId !== "string" ||
		!Number.isSafeInteger(c.playbackEpoch) ||
		c.playbackEpoch < 0 ||
		!Number.isSafeInteger(c.orderRevision) ||
		c.orderRevision < 0
	)
		return [400, { error: "bad_command" }];
	const fingerprint = JSON.stringify(c);
	const old = Object.hasOwn(state.commands, c.operationId) ? state.commands[c.operationId] : null;
	if (old)
		return old.fingerprint !== fingerprint
			? [409, { error: "operation_conflict" }]
			: old.done
				? [200, { accepted: true }]
				: [409, { error: "ambiguous_pending_command" }];
	if (!["play", "pause", "append"].includes(c.action)) return [400, { error: "unsupported" }];
	if (c.action === "play" && !/^[a-zA-Z0-9]{1,64}$/.test(c.mediaId || ""))
		return [400, { error: "bad_media" }];
	const held = state.devices[d.id];
	const epochs = { ...(held?.sessionEpochs || {}) };
	if (held)
		epochs[held.context.sessionId] = Math.max(
			epochs[held.context.sessionId] || 0,
			held.context.playbackEpoch,
		);
	if (
		c.action === "play" &&
		Object.hasOwn(epochs, c.sessionId) &&
		c.playbackEpoch <= epochs[c.sessionId]
	)
		return [409, { error: "stale_epoch" }];

	if (
		c.action === "pause" &&
		(!held ||
			held.context.sessionId !== c.sessionId ||
			held.context.playbackEpoch !== c.playbackEpoch ||
			held.context.entryId !== c.entryId)
	)
		return [409, { error: "stale_context" }];
	if (
		c.queue &&
		(!Array.isArray(c.queue) ||
			c.queue.length === 0 ||
			c.queue.length > 1000 ||
			c.queue.some(
				(e) => !e || typeof e.entryId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(e.mediaId || ""),
			))
	)
		return [400, { error: "bad_queue" }];
	if (Object.keys(epochs).length >= 1000 && !Object.hasOwn(epochs, c.sessionId))
		return [409, { error: "session_journal_full" }];
	if (c.action === "append") {
		if (
			d.service !== "music_assistant.play_media" ||
			!held ||
			held.context.sessionId !== c.sessionId ||
			held.context.playbackEpoch !== c.playbackEpoch ||
			c.orderRevision <= held.context.orderRevision ||
			!c.queue?.length
		)
			return [409, { error: "stale_append" }];
	}
	for (const [id, record] of Object.entries(state.commands)) {
		const previous = JSON.parse(record.fingerprint);
		if (
			record.done &&
			previous.deviceId === c.deviceId &&
			previous.sessionId === c.sessionId &&
			(previous.playbackEpoch < c.playbackEpoch ||
				(previous.action === "append" &&
					previous.playbackEpoch === c.playbackEpoch &&
					previous.orderRevision < c.orderRevision))
		)
			delete state.commands[id];
	}
	if (Object.keys(state.commands).length >= 1024) return [409, { error: "command_journal_full" }];
	if (
		c.action === "play" &&
		c.queue &&
		(c.queue[0].entryId !== c.entryId || c.queue[0].mediaId !== c.mediaId)
	)
		return [400, { error: "queue_context_mismatch" }];
	state.commands[c.operationId] = { fingerprint, done: false };
	await save();
	// No blind repeat after crash between HA effect and acknowledgement: pending is explicit.
	const context = {
		sessionId: c.sessionId,
		entryId: c.entryId,
		playbackEpoch: c.playbackEpoch,
		orderRevision: c.orderRevision,
	};
	if (c.action === "append") {
		const current = await ha(`states/${d.id}`);
		if (
			!["playing", "paused"].includes(current.state) ||
			!held.queue.some((entry) => entry.mediaId === current.attributes?.media_content_id)
		)
			return [409, { error: "external_playback" }];
		const additional = c.queue.map((entry) => ({
			entryId: entry.entryId,
			mediaId: d.mediaTemplate.replace("{id}", entry.mediaId),
		}));
		if (
			additional.some((entry) => held.queue.some((existing) => existing.entryId === entry.entryId))
		)
			return [409, { error: "duplicate_queue_entry" }];
		if (held.queue.length + additional.length > 1000) return [409, { error: "queue_capacity" }];
		await ha("services/music_assistant/play_media", {
			entity_id: d.id,
			media_id: additional.map((entry) => entry.mediaId),
			enqueue: "add",
		});

		held.queue.push(...additional);
		held.context.orderRevision = c.orderRevision;
	} else if (c.action === "pause") {
		if (!d.pause) return [409, { error: "pause_unsupported" }];
		const current = await ha(`states/${d.id}`);
		if (
			!held.queue.some(
				(entry) =>
					entry.entryId === c.entryId && entry.mediaId === current.attributes?.media_content_id,
			)
		)
			return [409, { error: "external_playback" }];
		await ha("services/media_player/media_pause", { entity_id: d.id });
	} else {
		const mediaId = d.mediaTemplate.replace("{id}", c.mediaId);
		const queue =
			d.service === "music_assistant.play_media" && Array.isArray(c.queue)
				? c.queue.map((entry) => ({
						entryId: entry.entryId,
						mediaId: d.mediaTemplate.replace("{id}", entry.mediaId),
					}))
				: [{ entryId: c.entryId, mediaId }];
		if (
			queue.length === 0 ||
			queue.length > 1000 ||
			queue.some((entry) => typeof entry.entryId !== "string" || typeof entry.mediaId !== "string")
		)
			return [400, { error: "bad_queue" }];
		if (d.service === "music_assistant.play_media")
			await ha("services/music_assistant/play_media", {
				entity_id: d.id,
				media_id: queue.map((entry) => entry.mediaId),
				enqueue: "replace",
			});
		else
			await ha("services/media_player/play_media", {
				entity_id: d.id,
				media_content_id: mediaId,
				media_content_type: d.mediaType || "music",
			});
		state.devices[d.id] = {
			context,
			mediaId,
			queue,
			sessionEpochs: { ...epochs, [c.sessionId]: c.playbackEpoch },
		};
		await save();
		if (d.seek && Number.isFinite(c.positionMs) && c.positionMs > 0)
			await ha("services/media_player/media_seek", {
				entity_id: d.id,
				seek_position: c.positionMs / 1000,
			});
	}
	state.commands[c.operationId].done = true;
	await save();
	return [200, { accepted: true }];
}
let tail = Promise.resolve();
const server = createServer((req, res) => {
	const run = async () => {
		res.setHeader("Content-Type", "application/json");
		res.setHeader("Cache-Control", "no-store");
		const reply = (status, value) => {
			res.writeHead(status);
			res.end(JSON.stringify(value));
		};
		if (!authorized(req)) return reply(401, { error: "unauthorized" });
		const u = new URL(req.url, "http://bridge");
		try {
			if (req.method === "GET" && u.pathname === "/v1/devices") {
				const visible = [];
				const services = await ha("services");
				const maAvailable =
					Array.isArray(services) &&
					services.some(
						(s) => s.domain === "music_assistant" && Object.hasOwn(s.services || {}, "play_media"),
					);
				for (const d of devices) {
					const e = await ha(`states/${d.id}`);
					const features = Number(e.attributes?.supported_features) || 0;
					if (
						!["unavailable", "unknown"].includes(e.state) &&
						((d.service === "music_assistant.play_media" && maAvailable) ||
							(d.service !== "music_assistant.play_media" && (features & 512) !== 0))
					)
						visible.push({
							id: d.id,
							name: d.name,
							provider: "home-assistant",
							seek: d.seek === true && (features & 2) !== 0,
							pause: d.pause === true && (features & 1) !== 0,
							resume: true,
							queue: d.service === "music_assistant.play_media",
						});
				}
				return reply(200, visible);
			}
			if (req.method === "GET" && u.pathname === "/v1/state") {
				const d = devices.find((d) => d.id === u.searchParams.get("deviceId"));
				return d ? reply(200, await observe(d)) : reply(403, { error: "device_denied" });
			}
			if (req.method === "POST" && u.pathname === "/v1/command") {
				let raw = "";
				for await (const chunk of req) {
					raw += chunk;
					if (raw.length > 262144) return reply(413, { error: "too_large" });
				}
				const [status, value] = await command(JSON.parse(raw));
				return reply(status, value);
			}
			reply(404, { error: "not_found" });
		} catch {
			reply(502, { error: "bridge_operation_failed" });
		}
	};
	tail = tail.then(run, run);
});
server.requestTimeout = 15000;
server.headersTimeout = 15000;
server.listen(Number(process.env.PORT || 8788), process.env.BRIDGE_HOST || "127.0.0.1", () =>
	process.stdout.write(`${server.address().port}\n`),
);
