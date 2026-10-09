import { describe, expect, it } from "vitest";
import { RequestBudget } from "../../src/worker/spotify/client";
import { onboarded } from "./harness";

const observe = async (h: Awaited<ReturnType<typeof onboarded>>) =>
	h.hub.sync(new RequestBudget(25), { force: true });

it("acknowledges pause before observation, then durably saves the stopped position", async () => {
	const h = await onboarded();
	const id = h.stationIds[0]!;
	await h.hub.play(id);
	h.fake.user().player.progressMs = 97000;
	const before = h.hub.savedSession(id)!;
	const handle = h.fake.handle.bind(h.fake);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.fake.handle = async (request) => {
		if (request.method === "GET" && new URL(request.url).pathname.endsWith("/me/player"))
			await gate;
		return handle(request);
	};
	let acknowledged = false;
	const pending = h.hub.playerAction("pause").then((result) => {
		acknowledged = result.ok;
		return result;
	});
	try {
		await expect.poll(() => acknowledged).toBe(true);
		expect(h.fake.user().player.isPlaying).toBe(false);
		expect(h.hub.savedSession(id)!.progressMs).toBe(before.progressMs);
		expect(h.hub.savedSession(id)!.observedAt).toBe(before.observedAt);
	} finally {
		release();
	}
	expect(await pending).toMatchObject({ ok: true, acceptedAt: h.clock.t });
	h.restart();
	await h.listen(1000);
	expect(h.hub.savedSession(id)).toMatchObject({
		status: "paused",
		progressMs: 97000,
		sessionId: before.sessionId,
		entryIds: before.entryIds,
	});
});

describe("durable listening session NN-02–07", () => {
	it("resumes the same unfinished occurrence at 1:37 after restart, including backwards seek", async () => {
		const h = await onboarded();
		const id = h.stationIds[0]!;
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		const initial = h.hub.savedSession(id)!;
		h.fake.user().player.progressMs = 97_000;
		await observe(h);
		await h.hub.playerAction("pause");
		h.restart();
		expect(h.hub.savedSession(id)!.progressMs).toBe(97_000);
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.fake.user().player.progressMs).toBe(97_000);
		expect(h.hub.savedSession(id)!.sessionId).toBe(initial.sessionId);
		expect(h.hub.savedSession(id)!.entryIds).toEqual(initial.entryIds);
		h.clock.t += 1000;
		h.fake.user().player.progressMs = 12_000;
		await observe(h);
		expect(h.hub.savedSession(id)!.progressMs).toBe(12_000);
	});
	it("does not replace a paused queue on days of alarms or when listening history accounts 30 seconds", async () => {
		const h = await onboarded();
		const id = h.stationIds[0]!;
		await h.hub.play(id);
		h.fake.user().player.progressMs = 97_000;
		await observe(h);
		await h.hub.playerAction("pause");
		const old = h.hub.savedSession(id)!;
		const deck = h.sql.first<{ deck: string }>("SELECT deck FROM stations WHERE id = ?", id)!.deck;
		await h.listen(48 * 60 * 60 * 1000);
		h.restart();
		expect(h.hub.savedSession(id)!.entryIds).toEqual(old.entryIds);
		expect(
			JSON.parse(
				h.sql.first<{ deck: string }>("SELECT deck FROM stations WHERE id = ?", id)!.deck,
			).items.map((it: { id: string }) => it.id),
		).toEqual(JSON.parse(deck).items.map((it: { id: string }) => it.id));
		await h.hub.play(id);
		expect(h.fake.user().player.progressMs).toBe(97_000);
	});
	it("explicit new queue is separate and stale tabs cannot replace its session", async () => {
		const h = await onboarded();
		const id = h.stationIds[0]!;
		await h.hub.play(id);
		const old = h.hub.savedSession(id)!;
		expect(await h.hub.play(id, null, { newQueue: true, sessionId: old.sessionId })).toMatchObject({
			ok: true,
		});
		expect(h.hub.savedSession(id)!.sessionId).not.toBe(old.sessionId);
		expect(await h.hub.play(id, null, { sessionId: old.sessionId })).toMatchObject({ ok: false });
	});
	it("unknown checkpoint repeats the same song; unrelated Spotify playback remains untouched", async () => {
		const h = await onboarded();
		const id = h.stationIds[0]!;
		await h.hub.play(id);
		const original = h.hub.savedSession(id)!;
		h.fake.user().player.contextUri = "spotify:playlist:unrelated";
		await observe(h);
		expect(h.hub.savedSession(id)!.status).toBe("external");
		expect(h.fake.user().player.contextUri).toBe("spotify:playlist:unrelated");
		expect(h.hub.savedSession(id)!.entryIds).toEqual(original.entryIds);
	});
	it("migrates legacy deck and retains imported history without inventing progress", async () => {
		const h = await onboarded();
		const id = h.stationIds[0]!;
		await h.hub.play(id);
		await observe(h);
		const memory = h.sql.all("SELECT * FROM memory");
		h.sql.run("DROP TABLE playback_sessions");
		h.sql.run("ALTER TABLE plays DROP COLUMN lane");
		h.sql.run("ALTER TABLE memory DROP COLUMN verdict");
		h.sql.run("ALTER TABLE memory DROP COLUMN verdict_at");
		h.sql.run("UPDATE kv SET v = '3' WHERE k = 'schema_version'");
		h.fake.user().player.contextUri = null;
		h.restart();
		await h.hub.play(id);
		expect(h.hub.savedSession(id)).not.toBeNull();
		expect(h.sql.all("SELECT * FROM memory")).toEqual(memory);
	});
});

it("appends rolling rounds while preserving current occurrence and restart position", async () => {
	const h = await onboarded({ tracks: 40, durationMs: 60_000 });
	const id = h.stationIds[0]!;
	await h.hub.play(id);
	const first = h.hub.savedSession(id)!;
	await h.listen(50 * 60_000);
	const session = h.hub.savedSession(id)!;
	expect(session.sessionId).toBe(first.sessionId);
	expect(session.orderRevision).toBeGreaterThan(first.orderRevision);
	expect(h.sql.all("SELECT * FROM plays WHERE station_id = ?", id).length).toBeGreaterThan(44);
	expect(new Set(session.entryIds).size).toBe(session.entryIds.length);
	await h.hub.playerAction("pause");
	await h.listen(1000);
	const paused = h.hub.savedSession(id)!;
	const current = paused.entryIds[paused.currentIndex];
	h.restart();
	await h.hub.play(id);
	expect(h.hub.savedSession(id)!.entryIds[h.hub.savedSession(id)!.currentIndex]).toBe(current);
});

it("retains the saved queue after a definite preflight failure across restart", async () => {
	const h = await onboarded();
	const id = h.stationIds[0]!;
	await h.hub.play(id);
	await observe(h);
	const old = h.hub.savedSession(id)!;
	h.fake.user().devices = [];
	expect(await h.hub.play(id)).toMatchObject({ ok: false });
	expect(h.hub.savedSession(id)!.pending).toBeNull();
	h.restart();
	expect(h.hub.savedSession(id)!.sessionId).toBe(old.sessionId);
	expect(h.hub.savedSession(id)!.entryIds).toEqual(old.entryIds);
});

it("recovers a partially written new queue idempotently after Worker restart", async () => {
	const h = await onboarded();
	const id = h.stationIds[0]!;
	await h.hub.play(id);
	const old = h.hub.savedSession(id)!;
	const handle = h.fake.handle.bind(h.fake);
	h.fake.handle = async (req) =>
		new URL(req.url).pathname.includes("/items") && req.method === "POST"
			? new Response(
					JSON.stringify({ error: { status: 500, message: "fixture interrupted write" } }),
					{ status: 500 },
				)
			: handle(req);
	expect(await h.hub.play(id, null, { newQueue: true })).toMatchObject({ ok: false });
	const pending = h.hub.savedSession(id)!;
	expect(pending.sessionId).not.toBe(old.sessionId);
	expect(pending.pending).not.toBeNull();
	h.fake.handle = handle;
	h.restart();
	expect(await h.hub.play(id)).toMatchObject({ ok: true });
	expect(h.hub.savedSession(id)!.sessionId).toBe(pending.sessionId);
	expect(h.hub.savedSession(id)!.entryIds).toEqual(pending.entryIds);
	const row = h.sql.first<{ playlist_id: string }>(
		"SELECT playlist_id FROM stations WHERE id = ?",
		id,
	)!;
	expect(h.fake.playlists.get(row.playlist_id)!.items.length).toBe(pending.entryIds.length);
});

it("preserves large imported history, preferences and bans through additive migration", async () => {
	const h = await onboarded({ tracks: 600 });
	const id = h.stationIds[0]!;
	const ids = [...h.fake.tracks.keys()];
	for (let part = 0; part < 2; part++)
		h.hub.importHistory(
			Array.from(
				{ length: 5000 },
				(_, i) =>
					[
						`T${(part * 5000 + i).toString(36).padStart(21, "0")}`,
						i + 1,
						0,
						h.clock.t - 1_000_000,
					] as [string, number, number, number],
			),
			part,
			2,
		);
	await h.hub.thumb(ids[0]!, 1);
	await h.hub.thumb(ids[1]!, -1);
	const before = {
		history: h.sql.all("SELECT * FROM hist_pages"),
		memory: h.sql.all("SELECT * FROM memory"),
		stations: h.sql.all("SELECT * FROM stations"),
		bans: h.sql.all("SELECT * FROM bans"),
	};
	h.sql.run("DROP TABLE playback_sessions");
	h.sql.run("ALTER TABLE plays DROP COLUMN lane");
	h.sql.run("ALTER TABLE memory DROP COLUMN verdict");
	h.sql.run("ALTER TABLE memory DROP COLUMN verdict_at");
	h.sql.run("UPDATE kv SET v = '3' WHERE k = 'schema_version'");
	h.restart();
	expect(h.sql.all("SELECT * FROM hist_pages")).toEqual(before.history);
	expect(h.sql.all("SELECT * FROM memory")).toEqual(before.memory);
	expect(h.sql.all("SELECT * FROM stations")).toEqual(before.stations);
	expect(h.sql.all("SELECT * FROM bans")).toEqual(before.bans);
	// Earlier consumers read their original columns unchanged; no destructive rollback needed.
	expect(
		h.sql.first<{ name: string }>("SELECT name FROM stations WHERE id = ?", id),
	).not.toBeNull();
	const second = await onboarded({ tracks: 40 });
	await second.hub.play(second.stationIds[0]!);
	expect(h.hub.savedSession()).toBeNull();
	expect(second.hub.savedSession()).not.toBeNull();
});

it("bounds rolling storage after more than 10000 ordered occurrences without changing the unfinished entry", async () => {
	const h = await onboarded({ tracks: 200 });
	const id = h.stationIds[0]!;
	await h.hub.play(id);
	const core = h.hub as unknown as {
		stepExtend(client: unknown, id: number): Promise<unknown>;
		client(budget: RequestBudget): unknown;
	};
	let total = 0;
	for (let round = 0; round < 110; round++) {
		const row = h.sql.first<{ deck: string }>("SELECT deck FROM stations WHERE id = ?", id)!;
		const deck = JSON.parse(row.deck) as { items: { id: string }[] };
		const session = h.hub.savedSession(id)!;
		session.currentIndex = deck.items.length - 10;
		session.progressMs = 97_000;
		session.status = "paused";
		const entry = session.entryIds[session.currentIndex]!;
		h.sql.run(
			"UPDATE playback_sessions SET data = ? WHERE station_id = ?",
			JSON.stringify(session),
			id,
		);
		// Extension now verifies the provider occurrence before trimming. Keep
		// this accelerated fixture's actual player aligned with its checkpoint.
		h.fake.startContext(
			"mika",
			session.contextUri,
			session.currentIndex,
			h.fake.user().devices[0]!.id,
			false,
		);
		h.fake.user().player.progressMs = session.progressMs!;
		h.fake.pause();
		await core.stepExtend(core.client(new RequestBudget(25)), id);
		const after = h.hub.savedSession(id)!;
		expect(after.entryIds[after.currentIndex]).toBe(entry);
		expect(after.progressMs).toBe(97_000);
		expect(after.entryIds.length).toBeLessThanOrEqual(900);
		total += after.entryIds.filter((entry) => !session.entryIds.includes(entry)).length;
	}
	expect(total).toBeGreaterThan(10000);
});

it("fences duplicated stale skip commands and leaves unrelated music outside held queue accounting", async () => {
	const h = await onboarded();
	const id = h.stationIds[0]!;
	await h.hub.play(id);
	await observe(h);
	const old = h.hub.savedSession(id)!;
	const expected = { sessionId: old.sessionId, entryId: old.entryIds[old.currentIndex]! };
	const results = await Promise.all([
		h.hub.playerAction("next", expected),
		h.hub.playerAction("next", expected),
	]);
	expect(results.map((r) => r.ok)).toEqual([true, false]);
	await observe(h);
	const saved = h.hub.savedSession(id)!;
	h.fake.user().player.contextUri = "spotify:playlist:unrelated";
	await h.hub.playerAction("next");
	expect(h.hub.savedSession(id)!.currentIndex).toBe(saved.currentIndex);
	await h.hub.playerAction("pause");
	expect(h.hub.savedSession(id)!.status).toBe("external");
});

it("keeps repeated-track occurrences ambiguous without a trustworthy provider offset", async () => {
	const h = await onboarded({ tracks: 40 });
	const id = h.stationIds[0]!;
	await h.hub.play(id);
	await observe(h);
	const session = h.hub.savedSession(id)!;
	const row = h.sql.first<{ deck: string }>("SELECT deck FROM stations WHERE id = ?", id)!;
	const deck = JSON.parse(row.deck) as { items: { id: string }[] };
	deck.items.push({ ...deck.items[0]! });
	session.entryIds.push("repeat-occurrence");
	h.sql.run("UPDATE stations SET deck = ? WHERE id = ?", JSON.stringify(deck), id);
	h.sql.run(
		"UPDATE playback_sessions SET data = ? WHERE station_id = ?",
		JSON.stringify(session),
		id,
	);
	h.restart();
	h.fake.user().player.progressMs = 90_000;
	await observe(h);
	const after = h.hub.savedSession(id)!;
	expect(after.status).toBe("ambiguous");
	expect(after.currentIndex).toBe(session.currentIndex);
	expect(after.progressMs).toBe(session.progressMs);
});

it("acknowledges Spotify-side Play after a definitely failed no-device resume (RT-02)", async () => {
	const h = await onboarded();
	const id = h.stationIds[0]!;
	await h.hub.play(id);
	h.fake.user().player.progressMs = 97_000;
	await observe(h);
	await h.hub.playerAction("pause");
	const held = h.hub.savedSession(id)!;
	const devices = h.fake.user().devices;
	h.fake.user().devices = [];
	expect(await h.hub.play(id)).toMatchObject({ ok: false });
	expect(h.hub.savedSession(id)!.pending).toBeNull();
	h.restart();
	h.fake.user().devices = devices;
	h.fake.startContext("mika", held.contextUri, held.currentIndex, devices[0]!.id, false);
	h.fake.user().player.progressMs = 120_000;
	h.clock.t += 1000;
	await observe(h);
	const restored = h.hub.savedSession(id)!;
	expect(restored.sessionId).toBe(held.sessionId);
	expect(restored.entryIds[restored.currentIndex]).toBe(held.entryIds[held.currentIndex]);
	expect(restored.progressMs).toBe(120_000);
	expect(restored.status).toBe("active");
	expect(restored.pending).toBeNull();
});

it("reconciles an ambiguous submitted resume only from fresh own-occurrence playback", async () => {
	const h = await onboarded();
	const id = h.stationIds[0]!;
	await h.hub.play(id);
	h.fake.user().player.progressMs = 97_000;
	await observe(h);
	await h.hub.playerAction("pause");
	const handle = h.fake.handle.bind(h.fake);
	h.fake.handle = async (req) => {
		const result = await handle(req);
		return req.method === "PUT" && new URL(req.url).pathname.endsWith("/me/player/play")
			? new Response(
					JSON.stringify({
						error: { status: 500, message: "fixture response lost after execution" },
					}),
					{ status: 500 },
				)
			: result;
	};
	expect(await h.hub.play(id)).toMatchObject({ ok: false });
	const held = h.hub.savedSession(id)!;
	expect(held.pending?.phase).toBe("submitted");
	h.fake.handle = handle;
	h.restart();
	h.fake.user().player.contextUri = "spotify:playlist:unrelated";
	h.clock.t += 1000;
	await observe(h);
	expect(h.hub.savedSession(id)!.pending).not.toBeNull();
	expect(h.hub.savedSession(id)!.progressMs).toBe(97_000);
	h.fake.user().player.contextUri = held.contextUri;
	h.fake.user().player.progressMs = 120_000;
	h.clock.t += 1000;
	await observe(h);
	expect(h.hub.savedSession(id)!.pending).toBeNull();
	expect(h.hub.savedSession(id)!.progressMs).toBe(120_000);
});

it("reserves native rolling tails durably without any Spotify request during provider cooldown", async () => {
	const h = await onboarded({ tracks: 200 });
	const id = h.stationIds[0]!;
	let session = h.hub.nativeSession(id);
	const atTail = session.entryIds[session.entryIds.length - 10]!;
	h.hub.acceptSessionObservation(id, {
		sessionId: session.sessionId,
		entryId: atTail,
		playbackEpoch: session.playbackEpoch,
		sequence: 1,
		progressMs: 97_000,
		isPlaying: true,
	});
	h.sql.run(
		"INSERT INTO kv(k,v) VALUES ('backoff',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
		JSON.stringify({ until: Number.MAX_SAFE_INTEGER, kind: "quota" }),
	);
	const calls = h.fake.calls.length;
	const tail = h.hub.prepareNativeTail(id)!;
	expect(tail.entries.length).toBeGreaterThan(0);
	expect(tail.entries.every((entry) => /^[A-Za-z0-9]{22}$/.test(entry.mediaId))).toBe(true);
	expect(h.fake.calls.length).toBe(calls);
	h.restart();
	expect(h.hub.prepareNativeTail(id)).toEqual(tail);
	session = h.hub.savedSession(id)!;
	expect(session.entryIds[session.currentIndex]).toBe(atTail);
	expect(session.progressMs).toBe(97_000);
	expect(h.hub.acknowledgeNativeTail(id, tail.orderRevision + 1)).toBe(false);
	expect(h.hub.acknowledgeNativeTail(id, tail.orderRevision)).toBe(true);
	expect(h.hub.prepareNativeTail(id)).toBeNull();
});

it("fences reordered native status events and retains unknown-position transitions", async () => {
	const h = await onboarded();
	const id = h.stationIds[0]!;
	const session = h.hub.nativeSession(id);
	const event = {
		sessionId: session.sessionId,
		entryId: session.entryIds[0]!,
		playbackEpoch: session.playbackEpoch,
		sequence: 10,
		progressMs: 97_000,
		isPlaying: true,
	};
	expect(h.hub.acceptSessionObservation(id, event)).toBe(true);
	expect(
		h.hub.nativeObservationStatus(id, session.sessionId, session.playbackEpoch, "disconnected", 9),
	).toBe(false);
	expect(
		h.hub.nativeObservationStatus(id, session.sessionId, session.playbackEpoch, "paused", 11),
	).toBe(true);
	expect(h.hub.savedSession(id)!.progressMs).toBe(97_000);
	expect(h.hub.acceptSessionObservation(id, { ...event, sequence: 12, progressMs: null })).toBe(
		true,
	);
	expect(h.hub.savedSession(id)!.progressMs).toBe(97_000);
	expect(
		h.hub.acceptSessionObservation(id, {
			...event,
			entryId: session.entryIds[1]!,
			sequence: 13,
			progressMs: null,
		}),
	).toBe(true);
	expect(h.hub.savedSession(id)!.currentIndex).toBe(1);
	expect(h.hub.savedSession(id)!.progressMs).toBeNull();
});

it("accounts native observed listening independently of queue completion and never sends Spotify dislike commands", async () => {
	const h = await onboarded();
	const id = h.stationIds[0]!;
	const session = h.hub.nativeSession(id);
	const event = {
		sessionId: session.sessionId,
		entryId: session.entryIds[0]!,
		playbackEpoch: session.playbackEpoch,
		sequence: 1,
		progressMs: 0,
		isPlaying: true,
	};
	h.hub.acceptSessionObservation(id, event);
	h.clock.t += 31_000;
	h.hub.acceptSessionObservation(id, { ...event, sequence: 2, progressMs: 31_000 });
	expect(h.sql.all("SELECT * FROM plays WHERE station_id = ?", id).length).toBe(1);
	expect(h.hub.savedSession(id)!.currentIndex).toBe(0);
	const resumed = h.hub.nativeSession(id);
	h.hub.acceptSessionObservation(id, {
		...event,
		playbackEpoch: resumed.playbackEpoch,
		sequence: 1,
		progressMs: 31_000,
	});
	h.clock.t += 31_000;
	h.hub.acceptSessionObservation(id, {
		...event,
		playbackEpoch: resumed.playbackEpoch,
		sequence: 2,
		progressMs: 62_000,
	});
	expect(h.sql.all("SELECT * FROM plays WHERE station_id = ?", id).length).toBe(1);
	const track = h.hub.sessionView(id)!.queue[0]!.track.id;
	const calls = h.fake.calls.length;
	const rating = await h.hub.thumb(track, -1, true);
	expect(rating.skipped).toBe(false);
	expect(h.fake.calls.length).toBe(calls);
});

it("bounds native storage over 10000 transport-appended occurrences without touching Spotify", async () => {
	const h = await onboarded({ tracks: 200 });
	const id = h.stationIds[0]!;
	h.hub.nativeSession(id);
	const calls = h.fake.calls.length;
	let total = 0;
	for (let turn = 0; turn < 110; turn++) {
		const before = h.hub.savedSession(id)!;
		const held = before.entryIds[before.entryIds.length - 10]!;
		expect(
			h.hub.acceptSessionObservation(id, {
				sessionId: before.sessionId,
				entryId: held,
				playbackEpoch: before.playbackEpoch,
				sequence: turn + 1,
				progressMs: 97_000,
				isPlaying: true,
			}),
		).toBe(true);
		const tail = h.hub.prepareNativeTail(id)!;
		total += tail.entries.length;
		const after = h.hub.savedSession(id)!;
		expect(after.entryIds[after.currentIndex]).toBe(held);
		expect(after.progressMs).toBe(97_000);
		expect(after.entryIds.length).toBeLessThanOrEqual(900);
		expect(new Set(after.entryIds).size).toBe(after.entryIds.length);
		expect(h.hub.acknowledgeNativeTail(id, tail.orderRevision)).toBe(true);
	}
	expect(total).toBeGreaterThan(10000);
	expect(h.fake.calls.length).toBe(calls);
});

it("creates a native queue only through the explicit action, preserving history without Spotify calls", async () => {
	const h = await onboarded({ tracks: 200 });
	const id = h.stationIds[0]!;
	const initial = h.hub.nativeSession(id);
	const event = {
		sessionId: initial.sessionId,
		entryId: initial.entryIds[0]!,
		playbackEpoch: initial.playbackEpoch,
		sequence: 1,
		progressMs: 0,
		isPlaying: true,
	};
	h.hub.acceptSessionObservation(id, event);
	h.clock.t += 31_000;
	h.hub.acceptSessionObservation(id, { ...event, sequence: 2, progressMs: 31_000 });
	const before = h.hub.savedSession(id)!;
	const oldOrder = h.hub.sessionView(id, 1000)!.queue.map((entry) => entry.track.id);
	const history = h.sql.all("SELECT * FROM plays");
	const memory = h.sql.all("SELECT * FROM memory");
	h.sql.run(
		"INSERT INTO kv(k,v) VALUES ('backoff',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
		JSON.stringify({ until: Number.MAX_SAFE_INTEGER, kind: "quota" }),
	);
	const calls = h.fake.calls.length;
	const ordinary = h.hub.nativeSession(id);
	expect(ordinary.sessionId).toBe(before.sessionId);
	expect(ordinary.entryIds).toEqual(before.entryIds);
	expect(ordinary.progressMs).toBe(31_000);
	const fresh = h.hub.newNativeQueue(id);
	expect(fresh.sessionId).not.toBe(before.sessionId);
	expect(fresh.currentIndex).toBe(0);
	expect(fresh.progressMs).toBeNull();
	expect(h.hub.sessionView(id, 1000)!.queue.map((entry) => entry.track.id)).not.toEqual(oldOrder);
	expect(h.sql.all("SELECT * FROM plays")).toEqual(history);
	expect(h.sql.all("SELECT * FROM memory")).toEqual(memory);
	expect(h.fake.calls.length).toBe(calls);
	h.restart();
	expect(h.hub.nativeSession(id).sessionId).toBe(fresh.sessionId);
});

it.each(["premium", "no_device"] as const)(
	"releases a definitely rejected %s resume for retry of the same checkpoint",
	async (rejection) => {
		const h = await onboarded();
		const id = h.stationIds[0]!;
		await h.hub.play(id);
		h.fake.user().player.progressMs = 97_000;
		await observe(h);
		await h.hub.playerAction("pause");
		const held = h.hub.savedSession(id)!;
		const devices = h.fake.user().devices;
		if (rejection === "premium") h.fake.user().premium = false;
		else h.fake.user().devices = [];
		expect(await h.hub.play(id)).toMatchObject({ ok: false });
		const rejected = h.hub.savedSession(id)!;
		expect(rejected.pending).toBeNull();
		expect(h.hub.sessionView(id)!.pending).toBe(false);
		expect(rejected.sessionId).toBe(held.sessionId);
		expect(rejected.currentIndex).toBe(held.currentIndex);
		expect(rejected.progressMs).toBe(97_000);
		h.fake.user().premium = true;
		h.fake.user().devices = devices;
		h.restart();
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.hub.savedSession(id)!.sessionId).toBe(held.sessionId);
		expect(h.fake.user().player.progressMs).toBe(97_000);
	},
);

it("resumes the native held checkpoint when switching to an independently playing Spotify context (RT-06)", async () => {
	const h = await onboarded();
	const id = h.stationIds[0]!;
	await h.hub.play(id);
	const native = h.hub.nativeSession(id);
	const event = {
		sessionId: native.sessionId,
		entryId: native.entryIds[native.currentIndex]!,
		playbackEpoch: native.playbackEpoch,
		sequence: 1,
		progressMs: 97_000,
		isPlaying: true,
	};
	expect(h.hub.acceptSessionObservation(id, event)).toBe(true);
	h.fake.user().player.progressMs = 200_000;
	const nextCalls = h.fake.calls.filter((call) => call === "PUT /v1/me/player/play").length;
	expect(await h.hub.play(id)).toMatchObject({ ok: true });
	const switched = h.hub.savedSession(id)!;
	expect(switched.controller).toBe("spotify");
	expect(switched.playbackEpoch).toBeGreaterThan(native.playbackEpoch);
	expect(switched.sessionId).toBe(native.sessionId);
	expect(switched.entryIds[switched.currentIndex]).toBe(event.entryId);
	expect(h.fake.user().player.progressMs).toBe(97_000);
	expect(h.fake.calls.filter((call) => call === "PUT /v1/me/player/play").length).toBe(
		nextCalls + 1,
	);
	expect(h.hub.acceptSessionObservation(id, { ...event, sequence: 2, progressMs: 210_000 })).toBe(
		false,
	);
	expect(h.hub.prepareNativeTail(id)).toBeNull();
});
