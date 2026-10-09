import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "../../src/core/types";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

/** Time passes with no look at the player at all. */
const quiet = (h: H, ms: number) => {
	h.clock.t += ms;
	h.fake.advance(ms, h.fake.user().id);
};

/** Into the run, then a look that sees a new song begin. */
async function seenBeginning(h: H) {
	const sid = h.stationIds[0]!;
	expect((await h.hub.play(sid)).ok).toBe(true);
	await h.listen(10 * MINUTE_MS);
	const x = h.fake.current()!;
	while (h.fake.current() === x) await h.listen(1_000);
	await h.hub.state({ live: true, refresh: true });
	const saved = h.hub.savedSession(sid)!;
	const t = h.fake.current()!;
	return { sid, t, index: saved.currentIndex, progress: saved.progressMs! };
}

/** The phone is gone: no player to see any more. */
function gone(h: H) {
	const p = h.fake.user().player;
	p.isPlaying = false;
	p.deviceId = "gone";
}

describe("Fortsetzen after a song Spotify listed as played", () => {
	it("a song seen at 0:01 and then played out unseen: Fortsetzen goes on with the next song", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const { sid, t, index, progress } = await seenBeginning(h);
		expect(progress).toBeLessThan(5_000);
		const next = h.hub.savedSession(sid)!;
		const nextEntry = next.entryIds[index + 1];
		// It plays to its end, the next one begins, and the phone goes away.
		quiet(h, 180_000 - progress + 1_000);
		expect(h.fake.current()).not.toBe(t);
		gone(h);
		await h.hub.state({ live: true, refresh: true });
		await h.listen(5 * MINUTE_MS);
		const after = h.hub.savedSession(sid)!;
		expect(after.currentIndex).toBe(index + 1);
		expect(after.entryIds[after.currentIndex]).toBe(nextEntry);
		expect(after.progressMs).toBe(0);
		expect(h.hub.history(20).filter((e) => e.id === t).length).toBe(1);
	});

	it("several songs played out unseen move the place along with them", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const { sid, index, progress } = await seenBeginning(h);
		// This one and the next two run out; the fourth plays 10 s, then nothing.
		quiet(h, 180_000 - progress + 2 * 180_000 + 10_000);
		gone(h);
		await h.hub.state({ live: true, refresh: true });
		await h.listen(5 * MINUTE_MS);
		const after = h.hub.savedSession(sid)!;
		expect(after.currentIndex).toBe(index + 3);
		expect(after.progressMs).toBe(0);
	});

	// Owner decision (2026-10-09): an occurrence Spotify lists as played is over,
	// whether heard to its end or left after 30 s or more; Spotify cannot tell.
	it("a song left unseen after 30 s or more, or after a pause or a seek back, is over too", async () => {
		const cases: [string, (h: H, progress: number) => void][] = [
			[
				"skipped at 166 s",
				(h, progress) => {
					quiet(h, 166_000 - progress);
					h.fake.skip();
				},
			],
			[
				"paused ten minutes, 40 s more, skipped",
				(h, progress) => {
					quiet(h, 20_000 - progress);
					h.fake.user().player.isPlaying = false;
					quiet(h, 10 * MINUTE_MS);
					h.fake.user().player.isPlaying = true;
					quiet(h, 40_000);
					h.fake.skip();
				},
			],
			[
				"sought back to the start, 65 s, skipped",
				(h, progress) => {
					quiet(h, 121_000 - progress);
					h.fake.user().player.progressMs = 0;
					quiet(h, 65_000);
					h.fake.skip();
				},
			],
		];
		for (const [, run] of cases) {
			const h = await onboarded({ tracks: 300, durationMs: 180_000 });
			const { sid, t, index, progress } = await seenBeginning(h);
			run(h, progress);
			quiet(h, 5_000);
			gone(h);
			await h.hub.state({ live: true, refresh: true });
			await h.listen(5 * MINUTE_MS);
			expect(h.hub.history(20).filter((e) => e.id === t).length).toBe(1);
			const after = h.hub.savedSession(sid)!;
			expect(after.currentIndex).toBe(index + 1);
			expect(after.progressMs).toBe(0);
		}
	});

	it("a song not listed (paused, or under 30 s) keeps the place and its progress", async () => {
		for (const leave of ["paused", "short"] as const) {
			const h = await onboarded({ tracks: 300, durationMs: 180_000 });
			const { sid, index, progress } = await seenBeginning(h);
			if (leave === "paused") {
				quiet(h, 90_000);
				h.fake.user().player.isPlaying = false;
			} else {
				quiet(h, 20_000 - progress);
				h.fake.skip();
				quiet(h, 5_000);
			}
			gone(h);
			await h.hub.state({ live: true, refresh: true });
			await h.listen(5 * MINUTE_MS);
			const after = h.hub.savedSession(sid)!;
			expect(after.currentIndex).toBe(index);
			expect(after.progressMs).toBe(progress);
		}
	});

	it("a listing of an earlier play of the song, from before the saved look, moves nothing", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const { sid, t, index, progress } = await seenBeginning(h);
		const u = h.fake.user();
		// Spotify lists a play of the same song in the playlist, ended before that look.
		u.recent.unshift({ trackId: t, playedAt: h.clock.t - 60_000, contextUri: u.player.contextUri });
		gone(h);
		await h.hub.state({ live: true, refresh: true });
		await h.listen(5 * MINUTE_MS);
		const after = h.hub.savedSession(sid)!;
		expect(after.currentIndex).toBe(index);
		expect(after.progressMs).toBe(progress);
	});

	it("the same song listed from outside the playlist moves nothing", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const { sid, t, index, progress } = await seenBeginning(h);
		gone(h);
		await h.hub.state({ live: true, refresh: true });
		// Played on its own in Spotify, to its end, later.
		const u = h.fake.user();
		u.player.deviceId = u.devices[0]!.id;
		h.fake.playSong(u.id, t);
		quiet(h, 181_000);
		gone(h);
		await h.hub.state({ live: true, refresh: true });
		await h.listen(5 * MINUTE_MS);
		const after = h.hub.savedSession(sid)!;
		expect(after.currentIndex).toBe(index);
		expect(after.progressMs).toBe(progress);
	});

	it("a look at the playlist right now decides, not the listing", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const { sid, index, progress } = await seenBeginning(h);
		// It runs out and the next one plays on, seen by the next look.
		quiet(h, 180_000 - progress + 20_000);
		await h.hub.state({ live: true, refresh: true });
		const after = h.hub.savedSession(sid)!;
		expect(after.currentIndex).toBe(index + 1);
		// The look's own position, not the start the listing would give.
		expect(after.progressMs).toBeGreaterThan(10_000);
	});

	it("Fortsetzen then starts the next song from its beginning", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const { sid, t, progress } = await seenBeginning(h);
		quiet(h, 180_000 - progress + 1_000);
		const u = h.fake.user();
		gone(h);
		await h.hub.state({ live: true, refresh: true });
		await h.listen(5 * MINUTE_MS);
		const after = h.hub.savedSession(sid)!;
		u.player.deviceId = u.devices[0]!.id;
		expect((await h.hub.play(sid)).ok).toBe(true);
		expect(h.fake.current()).not.toBe(t);
		expect(h.hub.savedSession(sid)!.currentIndex).toBe(after.currentIndex);
		expect(u.player.progressMs).toBeLessThan(2_000);
	});

	describe("edges", () => {
		/** Spotify lists the saved song in the playlist at a chosen moment, then the history is read. */
		async function listed(h: H, sid: number, at: (observedAt: number) => number) {
			const u = h.fake.user();
			const s = h.hub.savedSession(sid)!;
			const t = s.entryIds.length ? h.fake.current()! : "";
			gone(h);
			u.recent.unshift({ trackId: t, playedAt: at(s.observedAt!), contextUri: s.contextUri });
			h.clock.t = Math.max(h.clock.t, at(s.observedAt!) + 1_000);
			await h.hub.state({ live: true, refresh: true });
			await h.listen(5 * MINUTE_MS);
			return h.hub.savedSession(sid)!;
		}

		it("moves only for a stamp more than 15 s after the saving look", async () => {
			for (const [delta, moves] of [
				[15_000, false],
				[15_001, true],
			] as const) {
				const h = await onboarded({ tracks: 300, durationMs: 180_000 });
				const { sid, index, progress } = await seenBeginning(h);
				const after = await listed(h, sid, (o) => o + delta);
				expect(after.currentIndex).toBe(moves ? index + 1 : index);
				expect(after.progressMs).toBe(moves ? 0 : progress);
			}
		});

		it("unknown saved progress moves too; no saving look at all moves nothing", async () => {
			for (const known of [true, false]) {
				const h = await onboarded({ tracks: 300, durationMs: 180_000 });
				const { sid, index } = await seenBeginning(h);
				const s = h.hub.savedSession(sid)!;
				const saved = { ...s, progressMs: null, observedAt: known ? s.observedAt : null };
				h.sql.run(
					`UPDATE playback_sessions SET data = ? WHERE station_id = ?`,
					JSON.stringify(saved),
					sid,
				);
				const after = await listed(h, sid, () => s.observedAt! + 60_000);
				expect(after.currentIndex).toBe(known ? index + 1 : index);
			}
		});

		it("a listing read hours late, after a restart, still moves the place", async () => {
			const h = await onboarded({ tracks: 300, durationMs: 180_000 });
			const { sid, index } = await seenBeginning(h);
			const u = h.fake.user();
			const s = h.hub.savedSession(sid)!;
			gone(h);
			u.recent.unshift({
				trackId: h.fake.current()!,
				playedAt: s.observedAt! + 90_000,
				contextUri: s.contextUri,
			});
			h.clock.t += 3 * 60 * MINUTE_MS;
			h.restart();
			await h.hub.state({ live: true, refresh: true });
			await h.listen(5 * MINUTE_MS);
			expect(h.hub.savedSession(sid)!.currentIndex).toBe(index + 1);
		});

		it("a pending command or native control keeps the place", async () => {
			for (const hold of ["pending", "native"] as const) {
				const h = await onboarded({ tracks: 300, durationMs: 180_000 });
				const { sid, index, progress } = await seenBeginning(h);
				const s = h.hub.savedSession(sid)!;
				const held =
					hold === "pending"
						? { ...s, pending: { operationId: "op", kind: "publish", startedAt: h.clock.t } }
						: { ...s, controller: "native" };
				h.sql.run(
					`UPDATE playback_sessions SET data = ? WHERE station_id = ?`,
					JSON.stringify(held),
					sid,
				);
				const after = await listed(h, sid, (o) => o + 60_000);
				expect(after.currentIndex).toBe(index);
				expect(after.progressMs).toBe(progress);
			}
		});

		it("guest time moves the place like a look would; a private session lists nothing and keeps it", async () => {
			for (const mode of ["guest", "private"] as const) {
				const h = await onboarded({ tracks: 300, durationMs: 180_000 });
				const { sid, index, progress } = await seenBeginning(h);
				const u = h.fake.user();
				if (mode === "guest") await h.hub.setGuest(true, 2);
				else for (const d of u.devices) d.privateSession = true;
				quiet(h, 180_000 - progress + 1_000);
				gone(h);
				await h.hub.state({ live: true, refresh: true });
				await h.listen(5 * MINUTE_MS);
				expect(h.hub.savedSession(sid)!.currentIndex).toBe(mode === "guest" ? index + 1 : index);
			}
		});
	});
});
