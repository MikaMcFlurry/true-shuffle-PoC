import { describe, expect, it } from "vitest";
import { songTags } from "../../src/client/components/song-tags-text";
import { DAY_MS, MINUTE_MS, type SlotKind } from "../../src/core/types";
import { migrate } from "../../src/worker/hub/schema";
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
	const lanes = (h: H) =>
		new Map<string, string | null>(
			h.sql
				.all<{ played_at: number; track_id: string; lane: string | null }>(
					`SELECT played_at, track_id, lane FROM plays`,
				)
				.map((r) => [`${r.track_id}@${r.played_at}`, r.lane] as const),
		);
	it("a play the app watched to its end is stamped with its deck reason once, when recorded", async () => {
		const h = await onboarded({ tracks: 200, playlists: [100, 100], durationMs: 180_000 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		const p = h.fake.user().player;
		// The app open: a look a few seconds before each song ends sees that very play.
		for (let i = 0; i < 8; i++) {
			await h.listen(Math.max(1_000, 180_000 - p.progressMs - 8_000));
			await h.hub.state({ live: true, refresh: true });
			await h.listen(10_000);
			await h.hub.state({ live: true, refresh: true });
		}
		await h.listen(2 * MINUTE_MS);
		const row = h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!;
		const items = (JSON.parse(row.deck) as { items: { id: string; kind: SlotKind }[] }).items;
		const onStation = h.hub
			.history(50)
			.filter((e) => e.stationName !== null && !e.ignored)
			.reverse();
		expect(onStation.length).toBeGreaterThanOrEqual(8);
		const stored = lanes(h);
		// The first song no earlier look saw arrive; every later one has the deck's one reason.
		expect(onStation[0]!.facts?.kind ?? null).toBeNull();
		for (const e of onStation.slice(1, 8)) {
			const reasons = new Set(items.filter((it) => it.id === e.id).map((it) => it.kind));
			expect(e.facts?.kind ?? null).toBe(reasons.size === 1 ? [...reasons][0] : null);
			expect(stored.get(key(e))).toBe(e.facts?.kind);
		}
		expect(onStation.slice(1, 8).filter((e) => e.facts?.kind != null).length).toBeGreaterThan(4);
		// Heard outside any station: nothing to stamp.
		play(h, h.clock.t + 1, onStation[0]!.id, null, 0);
		expect(h.hub.history(1)[0]).toMatchObject({ stationName: null, facts: { kind: null } });
	});

	it("a later recommendation, a new mix or a guest replay never changes an old play's source", async () => {
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
		for (const [k, was] of before) {
			const now = after.find((e) => key(e) === k);
			expect(now?.ignored).toBe(false);
			expect(now?.facts?.kind ?? null).toBe(was.facts?.kind ?? null);
		}
	});

	it("a song paused across a new deck keeps its lane when the new deck gives the same reason, else none", async () => {
		for (const same of [true, false]) {
			const h = await onboarded({ tracks: 300, durationMs: 180_000 });
			const sid = h.stationIds[0]!;
			expect((await h.hub.play(sid)).ok).toBe(true);
			const p = h.fake.user().player;
			// Into the run, so the next song is seen arriving after another one.
			await h.listen(10 * MINUTE_MS);
			const x = h.fake.current()!;
			while (h.fake.current() === x) await h.listen(1_000);
			const y = h.fake.current()!;
			await h.hub.state({ live: true, refresh: true });
			const row = h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!;
			const deck = JSON.parse(row.deck) as {
				writtenAt: number;
				items: { id: string; kind: SlotKind }[];
			};
			const began = new Set(deck.items.filter((it) => it.id === y).map((it) => it.kind));
			expect(began.size).toBe(1);
			const lane = [...began][0]!;
			await h.listen(30_000);
			p.isPlaying = false;
			await h.hub.state({ live: true, refresh: true });
			h.clock.t += 30 * MINUTE_MS;
			// A new deck: the song for the same reason, or for another one.
			const other: SlotKind = lane === "favorite" ? "fresh" : "favorite";
			if (!same) deck.items = deck.items.map((it) => (it.id === y ? { ...it, kind: other } : it));
			deck.writtenAt = h.clock.t;
			(h.hub as unknown as { saveDeck(id: number, d: unknown): void }).saveDeck(sid, deck);
			h.restart();
			h.clock.t += 30 * MINUTE_MS;
			p.isPlaying = true;
			await h.listen(155_000);
			await h.hub.state({ live: true, refresh: true });
			const entry = h.hub.history(200).find((e) => e.id === y);
			expect(entry).toBeDefined();
			// Either deck gives the same reason: proven. Two reasons: which deck
			// the play came from cannot be told, so none.
			expect(entry!.facts?.kind ?? null).toBe(same ? lane : null);
		}
	});

	it("plays only the background looks saw arrive get the deck's one reason: it is the same for every play", async () => {
		const h = await onboarded({ tracks: 200, playlists: [100, 100], durationMs: 180_000 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		// Only the background looks, which come right after each expected end.
		await h.listen(30 * MINUTE_MS);
		const row = h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!;
		const items = (JSON.parse(row.deck) as { items: { id: string; kind: SlotKind }[] }).items;
		const onStation = h.hub
			.history(50)
			.filter((e) => e.stationName !== null && !e.ignored)
			.reverse();
		expect(onStation.length).toBeGreaterThan(5);
		expect(onStation[0]!.facts?.kind ?? null).toBeNull();
		for (const e of onStation.slice(1)) {
			const reasons = new Set(items.filter((it) => it.id === e.id).map((it) => it.kind));
			expect(e.facts?.kind ?? null).toBe(reasons.size === 1 ? [...reasons][0] : null);
		}
	});

	it("a repeat that ends exactly where the first play would have ended gets no lane (PR23-LANE-04)", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		const p = h.fake.user().player;
		const quiet = (ms: number) => {
			h.clock.t += ms;
			h.fake.advance(ms, h.fake.user().id);
		};
		await h.listen(10 * MINUTE_MS);
		const x = h.fake.current()!;
		while (h.fake.current() === x) await h.listen(1_000);
		await h.hub.state({ live: true, refresh: true });
		const t = h.fake.current()!;
		const seenAt = p.progressMs;
		// Skipped after 6 s, another song 60 s, all unseen; a new deck; a restart.
		quiet(6_000 - seenAt);
		h.fake.skip();
		quiet(60_000);
		const row = h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!;
		const deck = JSON.parse(row.deck) as {
			writtenAt: number;
			items: { id: string; kind: SlotKind }[];
		};
		deck.items = deck.items.map((it) => (it.id === t ? { ...it, kind: "favorite" } : it));
		deck.writtenAt = h.clock.t;
		(h.hub as unknown as { saveDeck(id: number, d: unknown): void }).saveDeck(sid, deck);
		h.restart();
		// Played again for 114 s, skipped: the next song begins right where the
		// first play, had it run on, would have ended.
		p.order.splice(p.index + 1, 0, t);
		h.fake.skip();
		quiet(114_000);
		h.fake.skip();
		quiet(1_000);
		await h.hub.state({ live: true, refresh: true });
		await h.listen(2 * MINUTE_MS);
		await h.hub.state({ live: true, refresh: true });
		const later = h.hub.history(200).filter((e) => e.id === t);
		expect(later.length).toBe(1);
		expect(later[0]!.facts?.kind ?? null).toBeNull();
	});

	it("a listing read hours late still finds the lane of the play the looks saw end", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		const p = h.fake.user().player;
		await h.listen(10 * MINUTE_MS);
		const x = h.fake.current()!;
		while (h.fake.current() === x) await h.listen(1_000);
		await h.hub.state({ live: true, refresh: true });
		const t = h.fake.current()!;
		const kind = (
			JSON.parse(h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'lane_notes'`)!.v) as {
				id: string;
				kind: SlotKind | null;
			}[]
		).find((n) => n.id === t)?.kind;
		expect(kind).toBeTruthy();
		const quiet = (ms: number) => {
			h.clock.t += ms;
			h.fake.advance(ms, h.fake.user().id);
		};
		quiet(180_000 - p.progressMs - 6_000);
		await h.hub.state({ live: true, refresh: true });
		// It ends, playback stops, and nothing reads the history for three hours.
		quiet(6_000);
		p.isPlaying = false;
		quiet(3 * 60 * MINUTE_MS);
		h.restart();
		await h.hub.state({ live: true, refresh: true });
		await h.listen(2 * MINUTE_MS);
		const e = h.hub.history(200).filter((r) => r.id === t);
		expect(e.length).toBe(1);
		expect(e[0]!.facts?.kind).toBe(kind);
	});

	it("a song played again between looks after a short unlisted play gets no lane (PR20-LANE-03)", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		const p = h.fake.user().player;
		// Time passes with no look at the player at all.
		const quiet = (ms: number) => {
			h.clock.t += ms;
			h.fake.advance(ms, h.fake.user().id);
		};
		await h.listen(10 * MINUTE_MS);
		const x = h.fake.current()!;
		while (h.fake.current() === x) await h.listen(1_000);
		await h.hub.state({ live: true, refresh: true });
		const t = h.fake.current()!;
		const notes = () =>
			JSON.parse(
				h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'lane_notes'`)?.v ?? "[]",
			) as { id: string; kind: SlotKind | null }[];
		const noted = notes().find((n) => n.id === t);
		expect(noted?.kind).toBeTruthy();
		// Skipped after 6 s (never listed), another song for 60 s, all unseen.
		quiet(5_000);
		h.fake.skip();
		quiet(60_000);
		// A new deck holds the same songs, this one for another reason; the
		// saved player still shows the song, so its note stays open.
		const row = h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!;
		const deck = JSON.parse(row.deck) as {
			writtenAt: number;
			items: { id: string; kind: SlotKind }[];
		};
		const other: SlotKind = noted!.kind === "favorite" ? "fresh" : "favorite";
		deck.items = deck.items.map((it) => (it.id === t ? { ...it, kind: other } : it));
		deck.writtenAt = h.clock.t;
		(h.hub as unknown as { saveDeck(id: number, d: unknown): void }).saveDeck(sid, deck);
		h.restart();
		// The song again in the same playlist, 45 s, skipped, between looks.
		p.order.splice(p.index + 1, 0, t);
		h.fake.skip();
		expect(h.fake.current()).toBe(t);
		quiet(45_000);
		h.fake.skip();
		quiet(1_000);
		await h.hub.state({ live: true, refresh: true });
		await h.listen(2 * MINUTE_MS);
		await h.hub.state({ live: true, refresh: true });
		const later = h.hub.history(200).filter((e) => e.id === t);
		expect(later.length).toBe(1);
		expect(later[0]!.facts?.kind ?? null).toBeNull();
	});

	it("unseen repeats, pauses and seeks: the deck's one reason, or none once a deck gave another (LANE-05/06)", async () => {
		type H = Awaited<ReturnType<typeof onboarded>>;
		const quiet = (h: H, ms: number) => {
			h.clock.t += ms;
			h.fake.advance(ms, h.fake.user().id);
		};
		/** A new deck giving the song another reason, published as the hub does, then a restart. */
		const otherReason = (h: H, t: string, sid: number) => {
			const row = h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!;
			const deck = JSON.parse(row.deck) as {
				writtenAt: number;
				items: { id: string; kind: SlotKind }[];
			};
			const was = deck.items.find((it) => it.id === t)!.kind;
			deck.items = deck.items.map((it) =>
				it.id === t ? { ...it, kind: was === "favorite" ? "fresh" : "favorite" } : it,
			);
			deck.writtenAt = h.clock.t;
			(h.hub as unknown as { saveDeck(id: number, d: unknown): void }).saveDeck(sid, deck);
			h.restart();
		};
		/** Skipped unseen at 6 s, another song 60 s, a new deck; the song again in the playlist. */
		const again = (h: H, t: string, sid: number, seen: number) => {
			const p = h.fake.user().player;
			quiet(h, 6_000 - seen);
			h.fake.skip();
			quiet(h, 60_000);
			otherReason(h, t, sid);
			p.order.splice(p.index + 1, 0, t);
			h.fake.skip();
		};
		const cases: [string, boolean, (h: H, t: string, sid: number, seen: number) => void][] = [
			[
				"LANE-05: again 40 s",
				false,
				(h, t, sid, seen) => {
					again(h, t, sid, seen);
					quiet(h, 40_000);
				},
			],
			[
				"LANE-06: again 40 s, then sought to where the first play would be",
				false,
				(h, t, sid, seen) => {
					const first = h.clock.t - seen;
					again(h, t, sid, seen);
					quiet(h, 40_000);
					h.fake.user().player.progressMs = h.clock.t - first;
				},
			],
			[
				"LANE-06: the same, paused right after the seek",
				false,
				(h, t, sid, seen) => {
					const first = h.clock.t - seen;
					again(h, t, sid, seen);
					quiet(h, 40_000);
					h.fake.user().player.progressMs = h.clock.t - first;
					h.fake.user().player.isPlaying = false;
					quiet(h, 5_000);
					h.fake.user().player.isPlaying = true;
				},
			],
			[
				"paused unseen a minute, same deck",
				true,
				(h) => {
					const p = h.fake.user().player;
					quiet(h, 20_000);
					p.isPlaying = false;
					quiet(h, 60_000);
					p.isPlaying = true;
					quiet(h, 40_000);
				},
			],
			[
				"sought forward unseen, same deck",
				true,
				(h) => {
					quiet(h, 20_000);
					h.fake.user().player.progressMs += 60_000;
					quiet(h, 20_000);
				},
			],
		];
		for (const [name, keeps, run] of cases) {
			const h = await onboarded({ tracks: 300, durationMs: 180_000 });
			const sid = h.stationIds[0]!;
			expect((await h.hub.play(sid)).ok).toBe(true);
			await h.listen(10 * MINUTE_MS);
			const x = h.fake.current()!;
			while (h.fake.current() === x) await h.listen(1_000);
			await h.hub.state({ live: true, refresh: true });
			const t = h.fake.current()!;
			const reason = (
				JSON.parse(
					h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!.deck,
				) as {
					items: { id: string; kind: SlotKind }[];
				}
			).items.find((it) => it.id === t)!.kind;
			run(h, t, sid, h.fake.user().player.progressMs);
			// A look sees the song, a second later it is skipped and the history read.
			await h.hub.state({ live: true, refresh: true });
			quiet(h, 1_000);
			h.fake.skip();
			quiet(h, 6_000);
			await h.hub.state({ live: true, refresh: true });
			await h.listen(2 * MINUTE_MS);
			await h.hub.state({ live: true, refresh: true });
			const e = h.hub.history(200).filter((r) => r.id === t);
			expect(e.length, name).toBe(1);
			expect(e[0]!.facts?.kind ?? null, name).toBe(keeps ? reason : null);
		}
	});

	it("a song skipped from the app after 40 s keeps the lane the looks saw it begin with", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(10 * MINUTE_MS);
		const x = h.fake.current()!;
		while (h.fake.current() === x) await h.listen(1_000);
		await h.hub.state({ live: true, refresh: true });
		const t = h.fake.current()!;
		const kind = (
			JSON.parse(h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'lane_notes'`)!.v) as {
				id: string;
				kind: SlotKind | null;
			}[]
		).find((n) => n.id === t)?.kind;
		expect(kind).toBeTruthy();
		h.clock.t += 40_000;
		h.fake.advance(40_000, h.fake.user().id);
		// Next looks at the player before it skips: that look still shows this play.
		expect((await h.hub.playerAction("next")).ok).toBe(true);
		await h.listen(2 * MINUTE_MS);
		await h.hub.state({ live: true, refresh: true });
		const e = h.hub.history(200).filter((x) => x.id === t);
		expect(e.length).toBe(1);
		expect(e[0]!.facts?.kind).toBe(kind);
	});

	it("a short play nobody listed never lends its lane to a later play of the song", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		const p = h.fake.user().player;
		await h.listen(10_000);
		await h.hub.state({ live: true, refresh: true });
		h.fake.skip();
		await h.listen(6_000);
		await h.hub.state({ live: true, refresh: true });
		const t = h.fake.current()!;
		const notes = () =>
			JSON.parse(
				h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'lane_notes'`)?.v ?? "[]",
			) as { id: string; kind: SlotKind | null }[];
		const noted = notes().find((n) => n.id === t);
		expect(noted?.kind).toBeTruthy();
		// Skipped after 12 s: never listed by Spotify.
		await h.listen(6_000);
		h.fake.skip();
		await h.listen(6_000);
		await h.hub.state({ live: true, refresh: true });
		// A minute later a new deck holds it for another reason, and it plays
		// again in the same playlist for 45 s between the app's looks.
		await h.listen(60_000);
		const row = h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!;
		const deck = JSON.parse(row.deck) as {
			writtenAt: number;
			items: { id: string; kind: SlotKind }[];
		};
		const other: SlotKind = noted!.kind === "favorite" ? "fresh" : "favorite";
		deck.items = deck.items.map((it) => (it.id === t ? { ...it, kind: other } : it));
		deck.writtenAt = h.clock.t;
		h.sql.run(`UPDATE stations SET deck = ? WHERE id = ?`, JSON.stringify(deck), sid);
		h.restart();
		p.order.splice(p.index + 1, 0, t);
		h.fake.skip();
		expect(h.fake.current()).toBe(t);
		await h.listen(45_000);
		h.fake.skip();
		await h.listen(1_000);
		await h.hub.state({ live: true, refresh: true });
		await h.listen(2 * MINUTE_MS);
		await h.hub.state({ live: true, refresh: true });
		const later = h.hub.history(200).filter((e) => e.id === t);
		expect(later.length).toBe(1);
		expect(later[0]!.facts?.kind ?? null).toBeNull();
	});

	it("a song of the station played outside its playlist gets no lane", async () => {
		const h = await onboarded({ tracks: 300, durationMs: 180_000 });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(10 * MINUTE_MS);
		const row = h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!;
		const later = (JSON.parse(row.deck) as { items: { id: string }[] }).items.at(-1)!.id;
		// Started on its own in Spotify, outside any playlist.
		h.fake.playSong(h.fake.user().id, later);
		await h.listen(6_000);
		await h.hub.state({ live: true, refresh: true });
		await h.listen(4 * MINUTE_MS);
		await h.hub.state({ live: true, refresh: true });
		const e = h.hub.history(200).find((x) => x.id === later);
		expect(e).toBeDefined();
		expect(e!.facts?.kind ?? null).toBeNull();
	});

	it("the first song after a start, which no earlier look saw arrive, has no lane", async () => {
		const h = await onboarded({ tracks: 200, playlists: [100, 100] });
		const sid = h.stationIds[0]!;
		expect((await h.hub.play(sid)).ok).toBe(true);
		const first = h.fake.current()!;
		await h.listen(10 * MINUTE_MS);
		const e = h.hub.history(200).find((x) => x.id === first && x.stationName !== null);
		expect(e).toBeDefined();
		expect(e!.facts?.kind ?? null).toBeNull();
	});

	it("the additive migration keeps every play and gives older ones no source", async () => {
		const h = await onboarded({ tracks: 200, playlists: [100, 100] });
		const sid = h.stationIds[0]!;
		await h.hub.play(sid);
		await h.listen(10 * MINUTE_MS);
		const plays = h.sql.all(`SELECT played_at, track_id, station_id, ignored FROM plays`);
		expect(plays.length).toBeGreaterThan(0);
		h.sql.run(`ALTER TABLE plays DROP COLUMN lane`);
		h.sql.run(`UPDATE kv SET v = '4' WHERE k = 'schema_version'`);
		migrate(h.sql);
		expect(h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'schema_version'`)!.v).toBe("5");
		expect(h.sql.all(`SELECT played_at, track_id, station_id, ignored FROM plays`)).toEqual(plays);
		h.restart();
		for (const e of h.hub.history(200)) expect(e.facts?.kind ?? null).toBeNull();
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
