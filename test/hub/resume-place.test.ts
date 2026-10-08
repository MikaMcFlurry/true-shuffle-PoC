/**
 * The saved place of a station only moves forward.
 *
 * Field report (2026-10-04 → 10-07): after a night, a second device resumed
 * the station's playlist at a place it had loaded hours earlier; the saved
 * place followed it back, and every later start replayed the same songs in
 * the same order for two days.
 */

import { describe, expect, it } from "vitest";
import { RequestBudget } from "../../src/worker/spotify/client";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

const observe = (h: H) => h.hub.sync(new RequestBudget(25), { force: true });

const deckIds = (h: H, id: number): string[] =>
	JSON.parse(
		h.sql.first<{ deck: string }>("SELECT deck FROM stations WHERE id = ?", id)!.deck,
	).items.map((it: { id: string }) => it.id);

/** Play the station from true-shuffle and let a few songs run to their end. */
async function listenSome(h: H, id: number, songs: number, songMs = 180_000) {
	expect(await h.hub.play(id)).toMatchObject({ ok: true });
	await h.listen(songs * songMs + 30_000);
	await observe(h);
	const s = h.hub.savedSession(id)!;
	expect(s.currentIndex).toBeGreaterThanOrEqual(songs);
	return s;
}

describe("the saved place never moves back", () => {
	it("a second device resuming an old place does not move it", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 180_000 });
		const id = h.stationIds[0]!;
		const before = await listenSome(h, id, 5);
		await h.hub.playerAction("pause");
		await h.listen(60_000);
		const saved = h.hub.savedSession(id)!.currentIndex;
		expect(saved).toBe(before.currentIndex);

		// The laptop wakes up the next morning in the same playlist, two songs in.
		const u = h.fake.user();
		u.devices.push({ id: "mika-laptop", name: "Laptop", type: "Computer", restricted: false });
		h.clock.t += 10 * 60 * 60 * 1000;
		h.fake.startContext(u.id, before.contextUri, 1, "mika-laptop", false);
		await observe(h);
		expect(h.hub.savedSession(id)!.currentIndex).toBe(saved);
		expect(h.hub.savedSession(id)!.status).toBe("external");

		// Back in true-shuffle: it continues where its order got to.
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.fake.current()).toBe(deckIds(h, id)[saved]);
	});

	it("a start continues after the furthest song heard, even when the saved place lags", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 180_000 });
		const id = h.stationIds[0]!;
		await listenSome(h, id, 6);
		await h.hub.playerAction("pause");
		await h.listen(60_000);
		const ids = deckIds(h, id);
		const heard = h.sql
			.all<{ track_id: string }>("SELECT track_id FROM plays WHERE station_id = ?", id)
			.map((r) => r.track_id);
		const furthest = Math.max(...heard.map((t) => ids.indexOf(t)));
		expect(furthest).toBeGreaterThanOrEqual(5);

		// The listener went on with other music; whatever froze or reset it, the
		// saved place points at the top again.
		h.fake.user().player.contextUri = "spotify:playlist:unrelated";
		await observe(h);
		const s = h.hub.savedSession(id)!;
		h.sql.run(
			"UPDATE playback_sessions SET data = ? WHERE station_id = ?",
			JSON.stringify({ ...s, currentIndex: 0, progressMs: 23_000 }),
			id,
		);
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.fake.current()).toBe(ids[furthest + 1]);
		expect(h.fake.user().player.progressMs).toBe(0);
	});

	it("a song paused in its middle still resumes where it stopped", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 180_000 });
		const id = h.stationIds[0]!;
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		await h.listen(2 * 180_000 + 90_000);
		await observe(h);
		await h.hub.playerAction("pause");
		await h.listen(60_000);
		const s = h.hub.savedSession(id)!;
		expect(s.progressMs).toBeGreaterThan(30_000);
		// Spotify already lists the paused song (heard 30 s).
		h.fake.user().recent.unshift({
			trackId: deckIds(h, id)[s.currentIndex]!,
			playedAt: h.clock.t,
			contextUri: s.contextUri,
		});
		await observe(h);
		const progress = h.hub.savedSession(id)!.progressMs;
		expect(await h.hub.play(id)).toMatchObject({ ok: true });
		expect(h.fake.current()).toBe(deckIds(h, id)[s.currentIndex]);
		expect(h.fake.user().player.progressMs).toBe(progress);
	});

	it("an unconfirmed command stops freezing the saved place after a while", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 180_000 });
		const id = h.stationIds[0]!;
		const s = await listenSome(h, id, 2);
		h.sql.run(
			"UPDATE playback_sessions SET data = ? WHERE station_id = ?",
			JSON.stringify({
				...h.hub.savedSession(id)!,
				pending: { operationId: "lost", kind: "resume", phase: "submitted", startedAt: h.clock.t },
			}),
			id,
		);
		await h.listen(10 * 60_000);
		await observe(h);
		const after = h.hub.savedSession(id)!;
		expect(after.pending).toBeNull();
		expect(after.currentIndex).toBeGreaterThan(s.currentIndex + 1);
	});
});

describe("one play is counted once", () => {
	it("Spotify listing a play minutes after the looks counted it does not make it two", async () => {
		const h = await onboarded({ tracks: 200, durationMs: 247_000 });
		const id = h.stationIds[0]!;
		await listenSome(h, id, 1, 247_000);
		const row = h.sql.first<{ track_id: string; meta: string }>(
			"SELECT track_id, meta FROM plays WHERE station_id = ? ORDER BY played_at LIMIT 1",
			id,
		)!;
		// A later song of the deck, counted from the looks (a private session, a
		// start that replaced it) before Spotify lists it.
		const later = deckIds(h, id)[150]!;
		const track = JSON.parse(row.meta);
		track[0] = later;
		const count = () =>
			h.sql.first<{ n: number }>("SELECT COUNT(*) AS n FROM plays WHERE track_id = ?", later)!.n;
		const at = h.clock.t;
		const hub = h.hub as unknown as {
			recordSeenPlay(e: {
				id: string;
				at: number;
				start: number;
				end: number;
				contextUri: string | null;
				track: unknown;
			}): unknown;
		};
		expect(
			hub.recordSeenPlay({
				id: later,
				at,
				start: at - 200_000,
				end: at,
				contextUri: h.hub.savedSession(id)!.contextUri,
				track,
			}),
		).not.toBeNull();
		expect(count()).toBe(1);
		// Spotify lists the same play six minutes later.
		h.clock.t += 6 * 60_000;
		h.fake.user().recent.unshift({
			trackId: later,
			playedAt: h.clock.t,
			contextUri: h.hub.savedSession(id)!.contextUri,
		});
		await observe(h);
		expect(count()).toBe(1);
	});
});
