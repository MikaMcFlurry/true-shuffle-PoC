import { describe, expect, it } from "vitest";
import { songTags } from "../../src/client/components/song-tags-text";
import { DAY_MS, MINUTE_MS, type SlotKind } from "../../src/core/types";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

/** The deck items from the session's place on: what the queue shows, in order. */
function deckAhead(h: H, stationId: number): { id: string; kind: SlotKind }[] {
	const row = h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, stationId)!;
	const deck = JSON.parse(row.deck) as { items: { id: string; kind: SlotKind }[] };
	return deck.items.slice(h.hub.savedSession(stationId)!.currentIndex);
}

const factsOf = (h: H, stationId: number, id: string) =>
	h.hub.sessionView(stationId, 1000)!.queue.find((e) => e.track.id === id)?.facts;

const play = (h: H, at: number, id: string, stationId: number | null, ignored: 0 | 1) =>
	h.sql.run(
		`INSERT INTO plays (played_at, track_id, context_uri, station_id, ignored, meta) VALUES (?, ?, NULL, ?, ?, NULL)`,
		at,
		id,
		stationId,
		ignored,
	);

const remember = (h: H, id: string, plays: number, at: number) =>
	h.sql.run(
		`INSERT INTO memory (id, last_played_at, plays, early_skips, last_skipped_at, thumb) VALUES (?, ?, ?, 0, NULL, 0)`,
		id,
		at,
		plays,
	);

describe("song facts in the queue", () => {
	it("a never-heard song: no plays, no last play, not from this station; kind from the deck", async () => {
		const h = await onboarded({ tracks: 200, playlists: [100, 100] });
		const sid = h.stationIds[0]!;
		expect(await h.hub.play(sid)).toMatchObject({ ok: true });
		const view = h.hub.sessionView(sid)!;
		expect(view.queue.length).toBeGreaterThan(0);
		const ahead = deckAhead(h, sid);
		view.queue.forEach((e, n) => {
			expect(e.track.id).toBe(ahead[n]!.id);
			expect(e.facts).toEqual({
				plays: 0,
				lastPlayedAt: null,
				inStation: false,
				kind: ahead[n]!.kind,
			});
		});
	});

	it("counts live plays on this and other stations, imported history, and never guest plays", async () => {
		const h = await onboarded({ tracks: 200, playlists: [100, 100] });
		const [sid, other] = [h.stationIds[0]!, h.stationIds[1]!];
		await h.hub.play(sid);
		const [, here, elsewhere, imported, guest, both] = h.hub
			.sessionView(sid)!
			.queue.map((e) => e.track.id);
		const t = h.clock.t;
		// Heard live on this station, twice.
		remember(h, here!, 2, t - 2 * DAY_MS);
		play(h, t - 3 * DAY_MS, here!, sid, 0);
		play(h, t - 2 * DAY_MS, here!, sid, 0);
		// Heard live only on another station.
		remember(h, elsewhere!, 1, t - DAY_MS);
		play(h, t - DAY_MS, elsewhere!, other, 0);
		// Played on this station in guest mode only: stored as ignored, never in memory.
		play(h, t - 4 * DAY_MS, guest!, sid, 1);
		// Live once on this station plus three imported plays from before.
		remember(h, both!, 1, t - DAY_MS);
		play(h, t - DAY_MS, both!, sid, 0);
		// Known only from an imported Spotify history.
		h.hub.importHistory(
			[
				[imported!, 5, 1, t - 30 * DAY_MS],
				[both!, 3, 0, t - 40 * DAY_MS],
			],
			0,
			1,
		);
		h.restart();

		expect(factsOf(h, sid, here!)).toMatchObject({
			plays: 2,
			lastPlayedAt: t - 2 * DAY_MS,
			inStation: true,
		});
		expect(factsOf(h, sid, elsewhere!)).toMatchObject({
			plays: 1,
			lastPlayedAt: t - DAY_MS,
			inStation: false,
		});
		expect(factsOf(h, sid, imported!)).toMatchObject({
			plays: 5,
			lastPlayedAt: t - 30 * DAY_MS,
			inStation: false,
		});
		expect(factsOf(h, sid, guest!)).toMatchObject({
			plays: 0,
			lastPlayedAt: null,
			inStation: false,
		});
		expect(factsOf(h, sid, both!)).toMatchObject({
			plays: 4,
			lastPlayedAt: t - DAY_MS,
			inStation: true,
		});
		// The labels change nothing about the order.
		expect(h.hub.sessionView(sid, 1000)!.queue.map((e) => e.track.id)).toEqual(
			deckAhead(h, sid).map((it) => it.id),
		);
	});

	it("songs a guest played stay unheard", async () => {
		const h = await onboarded({ tracks: 200, playlists: [100, 100] });
		const sid = h.stationIds[0]!;
		await h.hub.setGuest(true, 1);
		await h.hub.play(sid);
		await h.listen(20 * MINUTE_MS);
		const guestOnly = h.sql
			.all<{ track_id: string }>(
				`SELECT track_id FROM plays GROUP BY track_id HAVING MIN(ignored) = 1`,
			)
			.map((r) => r.track_id);
		expect(guestOnly.length).toBeGreaterThan(0);
		await h.hub.setGuest(false);
		await h.hub.play(h.allId);
		const queue = h.hub.sessionView(h.allId, 1000)!.queue;
		const seen = queue.filter((e) => guestOnly.includes(e.track.id));
		expect(seen.length).toBeGreaterThan(0);
		for (const e of seen)
			expect(e.facts).toMatchObject({ plays: 0, lastPlayedAt: null, inStation: false });
	});

	it("the station page's upcoming songs carry the same facts", async () => {
		const h = await onboarded({ tracks: 200, playlists: [100, 100] });
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		const queue = h.hub.sessionView(sid, 1000)!.queue;
		const upcoming = h.hub.stationDetail(sid).upcoming;
		expect(upcoming.length).toBeGreaterThan(0);
		for (const u of upcoming) {
			expect(u.facts).toEqual(queue.find((e) => e.track.id === u.id)!.facts);
			expect(u.facts!.kind).toBe(u.kind);
		}
	});

	it("a poll reads only new plays of the station, however long its log is", async () => {
		const h = await onboarded({ tracks: 200, playlists: [100, 100] });
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		const t = h.clock.t;
		// A long log of old plays on this station (outside the queue).
		for (let n = 0; n < 3000; n++) play(h, t - 30 * DAY_MS - n * MINUTE_MS, `old${n}`, sid, 0);
		h.hub.sessionView(sid); // first look reads the station once
		// Count every read of the plays log, not the rows it returns: a filtered
		// query can return little while it still scans the whole station.
		let reads = 0;
		const all = h.sql.all.bind(h.sql);
		const first = h.sql.first.bind(h.sql);
		h.sql.all = (<T>(q: string, ...p: never[]) => {
			if (/FROM plays\b/.test(q)) reads++;
			return all<T>(q, ...p);
		}) as typeof h.sql.all;
		h.sql.first = (<T>(q: string, ...p: never[]) => {
			if (/FROM plays\b/.test(q)) reads++;
			return first<T>(q, ...p);
		}) as typeof h.sql.first;
		for (let n = 0; n < 5; n++) h.hub.sessionView(sid);
		expect(reads).toBe(0);
		h.sql.first = first;
		h.sql.all = all;
		// Plays recorded while listening reach the set without another read of the log.
		await h.listen(15 * MINUTE_MS);
		const live = h.sql
			.all<{ track_id: string }>(
				`SELECT DISTINCT track_id FROM plays WHERE station_id = ? AND ignored = 0 AND track_id NOT LIKE 'old%'`,
				sid,
			)
			.map((r) => r.track_id);
		expect(live.length).toBeGreaterThan(0);
		const heard = (h.hub as unknown as { stationHeard(id: number): Set<string> }).stationHeard(sid);
		for (const id of live) expect(heard.has(id)).toBe(true);
	});

	it("after pruning and a wake, a half-year-old station play reads as not here, which the label bounds", async () => {
		const h = await onboarded({ tracks: 200, playlists: [100, 100] });
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		const id = h.hub.sessionView(sid)!.queue[3]!.track.id;
		const old = h.clock.t - 200 * DAY_MS;
		play(h, old, id, sid, 0);
		remember(h, id, 1, old);
		h.restart();
		expect(factsOf(h, sid, id)).toMatchObject({ plays: 1, inStation: true });
		// The daily prune drops single plays older than half a year; the next wake reads the log.
		h.sql.run(`DELETE FROM plays WHERE played_at < ?`, h.clock.t - 180 * DAY_MS);
		h.restart();
		const facts = factsOf(h, sid, id)!;
		expect(facts).toMatchObject({ plays: 1, lastPlayedAt: old, inStation: false });
		expect(songTags("fresh", facts).map((t) => t.text)).toContain(
			"in den letzten 180 Tagen nicht auf dieser Kassette",
		);
	});
});

describe("song facts in the Verlauf", () => {
	type Row = ReturnType<H["hub"]["history"]>[number];
	const key = (e: Row) => `${e.id}@${e.playedAt}`;

	it("live plays carry the total count, and never a source the play did not record", async () => {
		const h = await onboarded({ tracks: 200, playlists: [100, 100] });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(30 * MINUTE_MS);
		const onStation = h.hub.history(50).filter((e) => e.stationName !== null && !e.ignored);
		expect(onStation.length).toBeGreaterThan(0);
		for (const e of onStation)
			expect(e.facts).toMatchObject({ kind: null, inStation: true, plays: expect.any(Number) });
		expect(onStation.every((e) => (e.facts?.plays ?? 0) >= 1)).toBe(true);
		play(h, h.clock.t + 1, onStation[0]!.id, null, 0);
		expect(h.hub.history(1)[0]).toMatchObject({ stationName: null, facts: { kind: null } });
	});

	it("a later recommendation, a new mix or a guest replay never gives an old play a source", async () => {
		const h = await onboarded({ tracks: 200, playlists: [100, 100] });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(10 * MINUTE_MS);
		const before = new Map(
			h.hub
				.history(200)
				.filter((e) => !e.ignored)
				.map((e) => [key(e), e] as const),
		);
		expect(before.size).toBeGreaterThan(0);
		// Recommended afterwards, kept, then replayed in guest mode on a fresh mix.
		for (const e of before.values())
			h.sql.run(
				`INSERT OR IGNORE INTO discoveries (station_id, id, source, score, status, meta, heard, created_at, updated_at) VALUES (?, ?, 'ai', 1, 'kept', '[]', 1, ?, ?)`,
				sid,
				e.id,
				h.clock.t,
				h.clock.t,
			);
		await h.hub.setGuest(true, 6);
		expect((await h.hub.play(sid, null, { newQueue: true })).ok).toBe(true);
		await h.listen(20 * MINUTE_MS);
		await h.hub.setGuest(false);
		h.clock.t += 25 * 60 * MINUTE_MS;
		expect((await h.hub.play(sid, null, { newQueue: true })).ok).toBe(true);
		await h.listen(10 * MINUTE_MS);
		const after = h.hub.history(200);
		for (const e of after) expect(e.facts?.kind ?? null).toBeNull();
		for (const [k, was] of before) {
			const now = after.find((e) => key(e) === k);
			expect(now?.ignored).toBe(false);
			expect(now?.playedAt).toBe(was.playedAt);
		}
	});

	it("reading the Verlauf writes nothing", async () => {
		const h = await onboarded({ tracks: 200, playlists: [100, 100] });
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		await h.listen(10 * MINUTE_MS);
		const dump = () =>
			JSON.stringify(
				["plays", "memory", "stations", "discoveries", "kv"].map((t) =>
					h.sql.all(`SELECT * FROM ${t} ORDER BY 1`),
				),
			);
		const was = dump();
		h.hub.history(200);
		expect(dump()).toBe(was);
	});
});
