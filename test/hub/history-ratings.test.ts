/**
 * Ratings given in the Verlauf (see docs/HISTORY_RATINGS.md): stored with a
 * receipt, answered again from it after a lost answer, refused when the song
 * was rated again since, and taken back exactly — what changed since stays.
 * The real hub against the Spotify stand-in; synthetic data only.
 */

import { describe, expect, it } from "vitest";
import { HOUR_MS, MINUTE_MS } from "../../src/core/types";
import type { HistoryRateAnswer } from "../../src/shared/api";
import { HubError } from "../../src/worker/hub/hub";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

let n = 0;
const newId = () => `act-${++n}-${Math.random().toString(36).slice(2, 10)}`;

/** The song's rating write number, as the Verlauf lists it (0 when never rated). */
function rated(h: H, id: string): number {
	const c = h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'rating_clock'`);
	if (!c) return 0;
	const clock = JSON.parse(c.v) as { floor: number; touched: Record<string, number> };
	return clock.touched[id] ?? clock.floor;
}

async function rate(h: H, trackId: string, value: -1 | 0 | 1, actionId = newId()) {
	const a = await h.hub.rateFromHistory({ actionId, trackId, value, basis: rated(h, trackId) });
	if (a.kind !== "done") throw new Error(`not stored: ${JSON.stringify(a)}`);
	return a.receipt;
}

const thumb = (h: H, id: string) =>
	h.sql.first<{ thumb: number }>(`SELECT thumb FROM memory WHERE id = ?`, id)?.thumb ?? null;
const discovery = (h: H, sid: number, id: string) =>
	h.sql.first<{ status: string; updated_at: number }>(
		`SELECT status, updated_at FROM discoveries WHERE station_id = ? AND id = ?`,
		sid,
		id,
	);
const bans = (h: H, id: string) =>
	h.sql.all<{ station_id: number; at: number }>(
		`SELECT station_id, at FROM bans WHERE track_id = ? ORDER BY station_id`,
		id,
	);
const nexts = (h: H) => h.fake.calls.filter((c) => c === "POST /v1/me/player/next").length;
const transport = (h: H) =>
	h.fake.calls.filter((c) =>
		/^(POST|PUT) \/v1\/me\/player\/(next|previous|play|pause|seek)/.test(c),
	).length;
const playlistWrites = (h: H) =>
	h.fake.calls.filter((c) => /^POST \/v1\/(playlists|users)\//.test(c)).length;

/** A song of the library no station plays now, with a discovery row on the first station. */
function seedDiscovery(h: H, status: string): { sid: number; id: string } {
	const sid = h.stationIds[0]!;
	const id = [...h.fake.tracks.keys()].at(-1)!;
	h.sql.run(
		`INSERT INTO discoveries (station_id, id, source, score, status, meta, heard, created_at, updated_at)
		 VALUES (?, ?, 'artist', 1, ?, '{}', 0, ?, ?)`,
		sid,
		id,
		status,
		h.clock.t - HOUR_MS,
		h.clock.t - HOUR_MS,
	);
	return { sid, id };
}

describe("a rating from the Verlauf", () => {
	it("is stored with a receipt; asked again by its id it is answered from it, nothing twice", async () => {
		const h = await onboarded({ tracks: 60 });
		const id = [...h.fake.tracks.keys()][3]!;
		const before = rated(h, id);
		const actionId = newId();
		const r = await rate(h, id, 1, actionId);
		expect(r).toMatchObject({ id: actionId, trackId: id, value: 1, prev: 0, skip: "none" });
		expect(thumb(h, id)).toBe(1);
		expect(r.seq).toBeGreaterThan(before);
		expect(h.hub.history(200).find((e) => e.id === id)?.rated ?? r.seq).toBe(r.seq);
		// The answer got lost: the page reads the receipt, or sends the same again.
		expect(h.hub.historyRatingReceipt(actionId).receipt).toEqual(r);
		const again = await h.hub.rateFromHistory({ actionId, trackId: id, value: 1, basis: before });
		expect(again).toEqual({ kind: "done", receipt: r });
		expect(rated(h, id)).toBe(r.seq);
		// The same id for another decision is refused.
		await expect(
			h.hub.rateFromHistory({ actionId, trackId: id, value: -1, basis: r.seq }),
		).rejects.toThrow(HubError);
		expect(h.hub.historyRatingReceipt("never-sent-1").receipt).toBeNull();
	});

	it("is refused when the song was rated again since the page read it (Siri, the sheet, another tab)", async () => {
		const h = await onboarded({ tracks: 60 });
		const id = [...h.fake.tracks.keys()][4]!;
		const basis = rated(h, id);
		await h.hub.thumb(id, -1);
		const a: HistoryRateAnswer = await h.hub.rateFromHistory({
			actionId: newId(),
			trackId: id,
			value: 1,
			basis,
		});
		expect(a).toEqual({ kind: "changed", current: { value: -1, seq: rated(h, id) } });
		expect(thumb(h, id)).toBe(-1);
	});

	it("checks what it is sent", async () => {
		const h = await onboarded({ tracks: 60 });
		const id = [...h.fake.tracks.keys()][4]!;
		for (const bad of [
			{ actionId: "x", trackId: id, value: 1, basis: 0 },
			{ actionId: newId(), trackId: "nope", value: 1, basis: 0 },
			{ actionId: newId(), trackId: id, value: 2, basis: 0 },
			{ actionId: newId(), trackId: id, value: 1, basis: -1 },
			{ actionId: newId(), trackId: id, value: 1 },
		])
			await expect(h.hub.rateFromHistory(bad)).rejects.toThrow(HubError);
		expect(thumb(h, id)).toBeNull();
	});
});

describe("taking a rating from the Verlauf back", () => {
	it("brings back the rating before: none, favourite, never again", async () => {
		const h = await onboarded({ tracks: 60 });
		const id = [...h.fake.tracks.keys()][5]!;
		// Before: none (no memory row at all) — afterwards none again, no row left behind.
		const a = await rate(h, id, 1);
		const ua = (await h.hub.undoHistoryRating(a.id)).receipt!;
		expect(ua.undo).toMatchObject({ outcome: "undone", value: 0, notes: [] });
		expect(thumb(h, id)).toBeNull();
		// Before: favourite; never again; taken back: favourite.
		await rate(h, id, 1);
		const b = await rate(h, id, -1);
		expect(b.prev).toBe(1);
		const ub = (await h.hub.undoHistoryRating(b.id)).receipt!;
		expect(ub.undo).toMatchObject({ outcome: "undone", value: 1 });
		expect(thumb(h, id)).toBe(1);
		// Before: never again; favourite; taken back: never again.
		await rate(h, id, -1);
		const c = await rate(h, id, 1);
		expect((await h.hub.undoHistoryRating(c.id)).receipt!.undo?.value).toBe(-1);
		expect(thumb(h, id)).toBe(-1);
		// Asked again: the same answer, nothing changes.
		const seq = rated(h, id);
		expect((await h.hub.undoHistoryRating(c.id)).receipt!.undo?.seq).toBe(seq);
		expect(rated(h, id)).toBe(seq);
		expect((await h.hub.undoHistoryRating("never-sent-2")).receipt).toBeNull();
	});

	it("keeps a memory row it did not make, and one that changed since", async () => {
		const h = await onboarded({ tracks: 60 });
		const id = [...h.fake.tracks.keys()][6]!;
		const r = await rate(h, id, 1);
		// The song was heard meanwhile: its row is no longer just the rating.
		h.sql.run(`UPDATE memory SET plays = plays + 1 WHERE id = ?`, id);
		h.restart();
		await h.hub.undoHistoryRating(r.id);
		expect(
			h.sql.first<{ plays: number; thumb: number }>(
				`SELECT plays, thumb FROM memory WHERE id = ?`,
				id,
			),
		).toEqual({
			plays: 1,
			thumb: 0,
		});
	});

	it("is a conflict once the song was rated again since: nothing changes", async () => {
		const h = await onboarded({ tracks: 60 });
		const id = [...h.fake.tracks.keys()][7]!;
		const r = await rate(h, id, -1);
		await h.hub.thumb(id, 1); // Siri: Favorit
		const banned = bans(h, id);
		const u = (await h.hub.undoHistoryRating(r.id)).receipt!;
		expect(u.superseded).toBe(true);
		expect(u.undo).toMatchObject({ outcome: "conflict", value: 1 });
		expect(thumb(h, id)).toBe(1);
		expect(bans(h, id)).toEqual(banned);
		// An older receipt of the song is out of date as well.
		const a = await rate(h, id, 0);
		const b = await rate(h, id, -1);
		expect((await h.hub.undoHistoryRating(a.id)).receipt!.undo?.outcome).toBe("conflict");
		expect(thumb(h, id)).toBe(-1);
		expect((await h.hub.undoHistoryRating(b.id)).receipt!.undo?.outcome).toBe("undone");
		expect(thumb(h, id)).toBe(0);
	});

	it("Favorit: lifted station bans come back, the discovery goes back, a hand-over to Spotify not yet tried is called off", async () => {
		const h = await onboarded({ tracks: 60, playlists: [30, 30] });
		const { sid, id } = seedDiscovery(h, "probation");
		const other = h.stationIds[1]!;
		h.sql.run(
			`INSERT INTO bans (station_id, track_id, at) VALUES (?, ?, ?), (?, ?, ?)`,
			sid,
			id,
			111,
			other,
			id,
			222,
		);
		const before = discovery(h, sid, id);
		const r = await rate(h, id, 1);
		expect(bans(h, id)).toEqual([]);
		expect(discovery(h, sid, id)?.status).toBe("kept");
		expect(h.sql.first(`SELECT 1 FROM jobs WHERE key = ?`, `keep:${id}`)).not.toBeNull();
		const writes = playlistWrites(h);
		const u = (await h.hub.undoHistoryRating(r.id)).receipt!;
		expect(u.undo).toMatchObject({ outcome: "undone", notes: [] });
		expect(u.lasting).toEqual([]);
		expect(bans(h, id)).toEqual([
			{ station_id: Math.min(sid, other), at: sid < other ? 111 : 222 },
			{ station_id: Math.max(sid, other), at: sid < other ? 222 : 111 },
		]);
		expect(discovery(h, sid, id)).toEqual(before);
		expect(h.sql.first(`SELECT 1 FROM jobs WHERE key = ?`, `keep:${id}`)).toBeNull();
		await h.settle();
		await h.listen(10 * MINUTE_MS);
		const kept = [...h.fake.playlists.values()].find(
			(p) => p.name === "true-shuffle · Entdeckungen",
		);
		expect(kept?.items ?? []).not.toContain(id);
		expect(playlistWrites(h)).toBe(writes);
	});

	it("Favorit: a song already handed to the Spotify playlist stays there, and that is said", async () => {
		const h = await onboarded({ tracks: 60 });
		const { sid, id } = seedDiscovery(h, "candidate");
		const before = discovery(h, sid, id);
		const r = await rate(h, id, 1);
		await h.settle();
		await h.listen(10 * MINUTE_MS);
		const kept = () =>
			[...h.fake.playlists.values()].find((p) => p.name === "true-shuffle · Entdeckungen")?.items ??
			[];
		expect(kept()).toContain(id);
		const writes = playlistWrites(h);
		const u = (await h.hub.undoHistoryRating(r.id)).receipt!;
		expect(u.undo?.outcome).toBe("partial");
		expect(u.undo?.notes.join(" ")).toMatch(
			/steht schon in deiner Spotify-Playlist .* bleibt dort/,
		);
		expect(discovery(h, sid, id)).toEqual(before);
		// No rating before, and the row it made is gone again.
		expect(thumb(h, id)).toBeNull();
		await h.listen(10 * MINUTE_MS);
		expect(kept()).toContain(id);
		expect(playlistWrites(h)).toBe(writes);
	});

	it("Favorit: a hand-over tried already (its answer maybe lost) is called off, said as unclear", async () => {
		const h = await onboarded({ tracks: 60 });
		const { id } = seedDiscovery(h, "candidate");
		const r = await rate(h, id, 1);
		h.sql.run(`UPDATE jobs SET attempts = 1, error = 'timeout' WHERE key = ?`, `keep:${id}`);
		const u = (await h.hub.undoHistoryRating(r.id)).receipt!;
		expect(u.undo?.outcome).toBe("partial");
		expect(u.undo?.notes.join(" ")).toMatch(/ob er dort angekommen ist, ist unklar/);
		expect(h.sql.first(`SELECT 1 FROM jobs WHERE key = ?`, `keep:${id}`)).toBeNull();
	});

	it("Favorit: a hand-over waiting from before is not its own and stays", async () => {
		const h = await onboarded({ tracks: 60 });
		const { id } = seedDiscovery(h, "candidate");
		h.sql.run(
			`INSERT INTO jobs (key, kind, state, priority, run_after, attempts, error, created_at, updated_at)
			 VALUES (?, 'keep', ?, 6, ?, 0, NULL, ?, ?)`,
			`keep:${id}`,
			JSON.stringify({ trackId: id }),
			h.clock.t + HOUR_MS,
			h.clock.t,
			h.clock.t,
		);
		const r = await rate(h, id, 1);
		await h.hub.undoHistoryRating(r.id);
		expect(h.sql.first(`SELECT 1 FROM jobs WHERE key = ?`, `keep:${id}`)).not.toBeNull();
	});

	it("Favorit: a newer ban and a discovery that moved on since stay, and are said", async () => {
		const h = await onboarded({ tracks: 60 });
		const { sid, id } = seedDiscovery(h, "probation");
		h.sql.run(`INSERT INTO bans (station_id, track_id, at) VALUES (?, ?, 111)`, sid, id);
		const r = await rate(h, id, 1);
		h.sql.run(`INSERT INTO bans (station_id, track_id, at) VALUES (?, ?, 999)`, sid, id);
		h.sql.run(
			`UPDATE discoveries SET heard = heard + 1, updated_at = ? WHERE id = ?`,
			h.clock.t + 5,
			id,
		);
		const u = (await h.hub.undoHistoryRating(r.id)).receipt!;
		expect(u.undo?.outcome).toBe("partial");
		expect(u.undo?.notes.join(" ")).toMatch(/weiterentwickelt/);
		expect(bans(h, id)).toEqual([{ station_id: sid, at: 999 }]);
		expect(discovery(h, sid, id)).toEqual({ status: "kept", updated_at: h.clock.t + 5 });
		expect(thumb(h, id)).toBeNull();
	});

	it("Nie wieder: the discovery comes back, the decks it changed get their watch list back and plan anew", async () => {
		const h = await onboarded({ tracks: 60 });
		const { sid, id } = seedDiscovery(h, "probation");
		const deck = () =>
			JSON.parse(
				h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!.deck,
			) as { writtenAt: number; former?: [string, number][]; formerOff?: string[] };
		const d = deck();
		h.sql.run(
			`UPDATE stations SET deck = ?, deck_dirty = 0 WHERE id = ?`,
			JSON.stringify({ ...d, former: [[id, h.clock.t + HOUR_MS]] }),
			sid,
		);
		h.restart();
		const before = discovery(h, sid, id);
		const r = await rate(h, id, -1);
		expect(discovery(h, sid, id)?.status).toBe("rejected");
		expect(deck().formerOff).toContain(id);
		const u = (await h.hub.undoHistoryRating(r.id)).receipt!;
		expect(u.undo).toMatchObject({ outcome: "undone", value: 0 });
		expect(discovery(h, sid, id)).toEqual(before);
		expect(deck().formerOff ?? []).not.toContain(id);
		expect(
			h.sql.first<{ deck_dirty: number }>(`SELECT deck_dirty FROM stations WHERE id = ?`, sid)
				?.deck_dirty,
		).toBe(1);
	});

	it("Nie wieder: a deck planned anew since keeps its new plan, and that is said", async () => {
		const h = await onboarded({ tracks: 60 });
		const sid = h.stationIds[0]!;
		const id = [...h.fake.tracks.keys()][9]!;
		const raw = () =>
			h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!.deck;
		const d = JSON.parse(raw());
		h.sql.run(
			`UPDATE stations SET deck = ? WHERE id = ?`,
			JSON.stringify({ ...d, former: [[id, h.clock.t + HOUR_MS]] }),
			sid,
		);
		h.restart();
		const r = await rate(h, id, -1);
		const later = { ...JSON.parse(raw()), writtenAt: h.clock.t + 1 };
		h.sql.run(`UPDATE stations SET deck = ? WHERE id = ?`, JSON.stringify(later), sid);
		h.restart();
		const u = (await h.hub.undoHistoryRating(r.id)).receipt!;
		expect(u.undo?.outcome).toBe("partial");
		expect(u.undo?.notes.join(" ")).toMatch(/neu geplant/);
		expect(JSON.parse(raw()).formerOff).toContain(id);
	});

	it("never takes back or repeats a skip, nor touches playback", async () => {
		const h = await onboarded();
		await h.hub.play(h.stationIds[0]!);
		await h.listen(MINUTE_MS);
		await h.hub.state({ live: true });
		const cur = h.fake.current()!;
		const before = nexts(h);
		const actionId = newId();
		const r = await rate(h, cur, -1, actionId);
		expect(r.skip).toBe("skipped");
		expect(r.lasting.join(" ")).toMatch(/übersprungen.*bleibt so/);
		expect(nexts(h)).toBe(before + 1);
		const after = h.fake.current();
		expect(after).not.toBe(cur);
		// Sent again after a lost answer: no second skip.
		await h.hub.rateFromHistory({ actionId, trackId: cur, value: -1, basis: 0 });
		const moves = transport(h);
		const u = (await h.hub.undoHistoryRating(actionId)).receipt!;
		expect(u.undo?.outcome).toBe("undone");
		expect(u.lasting.join(" ")).toMatch(/übersprungen/);
		expect(transport(h)).toBe(moves);
		expect(nexts(h)).toBe(before + 1);
		expect(h.fake.current()).toBe(after);
	});

	it("Nie wieder for a song not playing, or one the listener already left, skips nothing", async () => {
		const h = await onboarded();
		await h.hub.play(h.stationIds[0]!);
		await h.listen(MINUTE_MS);
		await h.hub.state({ live: true });
		const playing = h.fake.current()!;
		const other = [...h.fake.tracks.keys()].find((t) => t !== playing)!;
		const before = nexts(h);
		expect((await rate(h, other, -1)).skip).toBe("none");
		h.fake.skip(); // left in Spotify (not through the API); the hub's picture still shows it
		expect((await rate(h, playing, -1)).skip).toBe("none");
		expect(nexts(h)).toBe(before);
	});

	it("a refused skip is said apart from the stored rating", async () => {
		const h = await onboarded();
		await h.hub.play(h.stationIds[0]!);
		await h.listen(MINUTE_MS);
		await h.hub.state({ live: true });
		const cur = h.fake.current()!;
		h.fake.user().premium = false;
		const r = await rate(h, cur, -1);
		expect(r.skip).toBe("failed");
		expect(r.skipStage).toBe("next");
		expect(r.skipError).toMatch(/Premium/);
		expect(thumb(h, cur)).toBe(-1);
		expect(h.fake.current()).toBe(cur);
	});
});

describe("ratings from the Verlauf: whether the song still plays could not be read (HUI-RT-003/004)", () => {
	async function playingNow() {
		const h = await onboarded();
		await h.hub.play(h.stationIds[0]!);
		await h.listen(MINUTE_MS);
		await h.hub.state({ live: true });
		return { h, cur: h.fake.current()! };
	}
	const unreadable: Record<string, (h: H) => void> = {
		"Spotify answering 503": (h) => {
			h.fake.failWhen = (m, p) =>
				m === "GET" && p === "/me/player"
					? {
							status: 503,
							body: { error: { status: 503, message: "Synthetic player unreadable" } },
						}
					: null;
		},
		"the quota used up": (h) => {
			h.fake.failWhen = (m, p) =>
				m === "GET" && p === "/me/player"
					? {
							status: 429,
							body: { error: { reason: "QUOTA_EXCEEDED", message: "private provider" } },
							headers: { "Retry-After": "600" },
						}
					: null;
		},
		"no connection": (h) => {
			const handle = h.fake.handle.bind(h.fake);
			h.fake.handle = async (req) => {
				if (req.method === "GET" && new URL(req.url).pathname === "/v1/me/player")
					throw new Error("fixture network down");
				return handle(req);
			};
		},
	};

	for (const [why, fail] of Object.entries(unreadable))
		it(`${why}: the rating is stored, the failed look is said apart, nothing skipped`, async () => {
			const { h, cur } = await playingNow();
			fail(h);
			const before = nexts(h);
			const actionId = newId();
			const r = await rate(h, cur, -1, actionId);
			expect(thumb(h, cur)).toBe(-1);
			expect(r).toMatchObject({ value: -1, skip: "failed", skipStage: "read" });
			expect(r.skipError).toBeTruthy();
			expect(nexts(h)).toBe(before);
			expect(h.fake.current()).toBe(cur);
			// Sent again after a lost answer: answered from the receipt, no new look, no skip.
			const calls = h.fake.calls.length;
			const again = await h.hub.rateFromHistory({ actionId, trackId: cur, value: -1, basis: 0 });
			expect(again).toEqual({ kind: "done", receipt: r });
			expect(h.fake.calls.length).toBe(calls);
			expect(h.hub.historyRatingReceipt(actionId).receipt).toEqual(r);
		});

	it("sent again after a stored skip: exactly one skip", async () => {
		const { h, cur } = await playingNow();
		const before = nexts(h);
		const actionId = newId();
		const r = await rate(h, cur, -1, actionId);
		expect(r).toMatchObject({ skip: "skipped" });
		expect(r.skipStage).toBeUndefined();
		for (let i = 0; i < 3; i++)
			await h.hub.rateFromHistory({ actionId, trackId: cur, value: -1, basis: 0 });
		expect(nexts(h)).toBe(before + 1);
	});

	it("another song, or one left already: no look said as failed, nothing skipped — even when Spotify is unreadable", async () => {
		const { h, cur } = await playingNow();
		const other = [...h.fake.tracks.keys()].find((t) => t !== cur)!;
		unreadable["Spotify answering 503"]!(h);
		const before = nexts(h);
		expect(await rate(h, other, -1)).toMatchObject({ skip: "none", skipError: null });
		expect(nexts(h)).toBe(before);
	});

	it("a Home Assistant player: stored, never skipped, nothing read", async () => {
		const { h, cur } = await playingNow();
		const s = h.hub.savedSession()!;
		s.controller = "native";
		h.sql.run(
			"UPDATE playback_sessions SET data=? WHERE station_id=?",
			JSON.stringify(s),
			s.stationId,
		);
		const before = nexts(h);
		const reads = h.fake.calls.filter((c) => c === "GET /v1/me/player").length;
		const r = await rate(h, cur, -1);
		expect(r).toMatchObject({ skip: "none", skipError: null });
		expect(thumb(h, cur)).toBe(-1);
		expect(nexts(h)).toBe(before);
		expect(h.fake.calls.filter((c) => c === "GET /v1/me/player").length).toBe(reads);
	});

	it("the sheet and Siri keep their meaning when the look fails: stored, not skipped, no error", async () => {
		const { h, cur } = await playingNow();
		unreadable["Spotify answering 503"]!(h);
		const before = nexts(h);
		expect(await h.hub.thumb(cur, -1)).toEqual({ skipped: false });
		expect(thumb(h, cur)).toBe(-1);
		expect(nexts(h)).toBe(before);
	});

	it("a lookup names what holds now beside the receipt", async () => {
		const h = await onboarded({ tracks: 60 });
		const id = [...h.fake.tracks.keys()][5]!;
		const r = await rate(h, id, 1);
		await h.hub.thumb(id, -1);
		const look = h.hub.historyRatingReceipt(r.id, id);
		expect(look.receipt).toMatchObject({ id: r.id, value: 1, superseded: true });
		expect(look.current).toEqual({ value: -1, seq: rated(h, id) });
		// Without a song named, no rating now.
		expect(h.hub.historyRatingReceipt(r.id).current).toBeUndefined();
	});
});

describe("ratings from the Verlauf: what changed since stays", () => {
	it("a basis this account never gave out stores nothing", async () => {
		const h = await onboarded({ tracks: 60 });
		const id = [...h.fake.tracks.keys()][11]!;
		const a = await h.hub.rateFromHistory({
			actionId: newId(),
			trackId: id,
			value: 1,
			basis: 10_000,
		});
		expect(a).toEqual({ kind: "changed", current: { value: 0, seq: 0 } });
		expect(thumb(h, id)).toBeNull();
	});

	it("a basis the song never had — even below the account's newest number — stores nothing and proves nothing", async () => {
		const h = await onboarded({ tracks: 60 });
		const [target, other] = [...h.fake.tracks.keys()].slice(14, 16) as [string, string];
		await h.hub.thumb(target, 1);
		await h.hub.thumb(target, 0); // target's number: 2
		for (let i = 0; i < 8; i++) await h.hub.thumb(other, i % 2 === 0 ? 1 : 0); // newest: 10
		expect(rated(h, target)).toBe(2);
		expect(
			JSON.parse(h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'rating_clock'`)!.v).seq,
		).toBe(10);
		const actionId = newId();
		const a = await h.hub.rateFromHistory({ actionId, trackId: target, value: -1, basis: 5 });
		expect(a).toEqual({ kind: "changed", current: { value: 0, seq: 2 } });
		expect(h.hub.memory(target).thumb).toBe(0);
		expect(rated(h, target)).toBe(2);
		// Not found, but that basis proves nothing either.
		expect(h.hub.historyRatingReceipt(actionId, target, 5)).toEqual({
			receipt: null,
			stored: "unknown",
			current: { value: 0, seq: 2 },
		});
		expect(h.hub.historyRatingReceipt(actionId, target, 1)).toEqual({
			receipt: null,
			stored: "unknown",
			current: { value: 0, seq: 2 },
		});
		expect(h.hub.historyRatingReceipt(actionId, target, 2)).toEqual({
			receipt: null,
			stored: "no",
			current: { value: 0, seq: 2 },
		});
		// Exactly the song's number: stored.
		expect((await rate(h, target, -1)).prev).toBe(0);
	});

	it("after a lost answer, 'not found' is 'not stored' only when provable — otherwise unclear", async () => {
		const h = await onboarded({ tracks: 200 });
		const id = [...h.fake.tracks.keys()][12]!;
		// Never sent (or never arrived): nothing written since its basis.
		expect(h.hub.historyRatingReceipt("lost-but-never-1", id, rated(h, id))).toEqual({
			receipt: null,
			stored: "no",
			current: { value: 0, seq: rated(h, id) },
		});
		// Stored, then its receipt pushed out by 100 newer ones: unclear, never "not stored".
		const basis = rated(h, id);
		const actionId = newId();
		await rate(h, id, -1, actionId);
		for (const other of [...h.fake.tracks.keys()].slice(20, 121)) await rate(h, other, 1);
		expect(h.hub.historyRatingReceipt(actionId, id, basis)).toEqual({
			receipt: null,
			stored: "unknown",
			current: { value: -1, seq: rated(h, id) },
		});
		// Sent again then: nothing stored twice, nothing skipped — the song was rated since its basis.
		const again = await h.hub.rateFromHistory({ actionId, trackId: id, value: -1, basis });
		expect(again.kind).toBe("changed");
		// Without the song and its basis, nothing can be proven either.
		expect(h.hub.historyRatingReceipt("lost-but-never-2").stored).toBe("unknown");
		expect(h.hub.historyRatingReceipt("lost-but-never-3", id, 10_000).stored).toBe("unknown");
	});

	it("a discovery changed since in the same millisecond is not written back", async () => {
		const h = await onboarded({ tracks: 60 });
		const { sid, id } = seedDiscovery(h, "probation");
		const r = await rate(h, id, -1);
		// Same status, same time stamp — but heard once more meanwhile.
		h.sql.run(`UPDATE discoveries SET heard = heard + 1 WHERE station_id = ? AND id = ?`, sid, id);
		const u = (await h.hub.undoHistoryRating(r.id)).receipt!;
		expect(u.undo?.outcome).toBe("partial");
		expect(discovery(h, sid, id)?.status).toBe("rejected");
		expect(
			h.sql.first<{ heard: number }>(`SELECT heard FROM discoveries WHERE id = ?`, id)?.heard,
		).toBe(1);
	});

	it("a deck planned anew in the same millisecond keeps its new plan", async () => {
		const h = await onboarded({ tracks: 60 });
		const sid = h.stationIds[0]!;
		const id = [...h.fake.tracks.keys()][13]!;
		const raw = () =>
			h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!.deck;
		const d = JSON.parse(raw());
		h.sql.run(
			`UPDATE stations SET deck = ? WHERE id = ?`,
			JSON.stringify({ ...d, former: [[id, h.clock.t + HOUR_MS]] }),
			sid,
		);
		h.restart();
		const r = await rate(h, id, -1);
		// Same version stamp, another order of songs.
		const now = JSON.parse(raw());
		h.sql.run(
			`UPDATE stations SET deck = ? WHERE id = ?`,
			JSON.stringify({ ...now, items: [...now.items].reverse() }),
			sid,
		);
		h.restart();
		const u = (await h.hub.undoHistoryRating(r.id)).receipt!;
		expect(u.undo?.outcome).toBe("partial");
		expect(JSON.parse(raw()).formerOff).toContain(id);
	});

	it("a hand-over to Spotify replaced since by a later one is not its own: it stays, and that is said", async () => {
		const h = await onboarded({ tracks: 60 });
		const { id } = seedDiscovery(h, "candidate");
		const r = await rate(h, id, 1);
		// Its hand-over ran; a later one (another path) waits now under the same key.
		h.sql.run(`DELETE FROM jobs WHERE key = ?`, `keep:${id}`);
		h.sql.run(
			`INSERT INTO jobs (key, kind, state, priority, run_after, attempts, error, created_at, updated_at)
			 VALUES (?, 'keep', ?, 6, ?, 0, NULL, ?, ?)`,
			`keep:${id}`,
			JSON.stringify({ trackId: id }),
			h.clock.t + HOUR_MS,
			h.clock.t + 7,
			h.clock.t + 7,
		);
		const u = (await h.hub.undoHistoryRating(r.id)).receipt!;
		expect(u.undo?.outcome).toBe("partial");
		expect(u.undo?.notes.join(" ")).toMatch(/gehört nicht zu dieser Bewertung und bleibt/);
		expect(h.sql.first(`SELECT 1 FROM jobs WHERE key = ?`, `keep:${id}`)).not.toBeNull();
	});

	it("a hand-over touched since (re-planned or tried) is called off, said as unclear", async () => {
		const h = await onboarded({ tracks: 60 });
		const { id } = seedDiscovery(h, "candidate");
		const r = await rate(h, id, 1);
		h.sql.run(`UPDATE jobs SET updated_at = updated_at + 1 WHERE key = ?`, `keep:${id}`);
		const u = (await h.hub.undoHistoryRating(r.id)).receipt!;
		expect(u.undo?.notes.join(" ")).toMatch(/ob er dort angekommen ist, ist unklar/);
		expect(h.sql.first(`SELECT 1 FROM jobs WHERE key = ?`, `keep:${id}`)).toBeNull();
	});

	it("with several changes since, only its own still-standing effects go back — in one step", async () => {
		const h = await onboarded({ tracks: 60, playlists: [30, 30] });
		const { sid, id } = seedDiscovery(h, "probation");
		const other = h.stationIds[1]!;
		h.sql.run(
			`INSERT INTO discoveries (station_id, id, source, score, status, meta, heard, created_at, updated_at)
			 VALUES (?, ?, 'artist', 1, 'candidate', '{}', 0, 1, 1)`,
			other,
			id,
		);
		h.sql.run(
			`INSERT INTO bans (station_id, track_id, at) VALUES (?, ?, 111), (?, ?, 222)`,
			sid,
			id,
			other,
			id,
		);
		const r = await rate(h, id, 1);
		// Meanwhile: the discovery on one station moved on, a new ban on the other.
		h.sql.run(`UPDATE discoveries SET heard = 3 WHERE station_id = ? AND id = ?`, sid, id);
		h.sql.run(`INSERT INTO bans (station_id, track_id, at) VALUES (?, ?, 999)`, other, id);
		const u = (await h.hub.undoHistoryRating(r.id)).receipt!;
		expect(u.undo?.outcome).toBe("partial");
		// Own effects back: the other station's discovery, the first station's ban, the rating.
		expect(discovery(h, other, id)).toEqual({ status: "candidate", updated_at: 1 });
		expect(bans(h, id).find((b) => b.station_id === sid)?.at).toBe(111);
		expect(thumb(h, id)).toBeNull();
		// Newer ones untouched: no old state written over them.
		expect(discovery(h, sid, id)?.status).toBe("kept");
		expect(bans(h, id).find((b) => b.station_id === other)?.at).toBe(999);
	});
});

describe("ratings from the Verlauf: a skip held while everything else moves on (R-HUI-01)", () => {
	it("a receipt pushed out while the skip was on its way is not brought back; the newer rating stays; one skip", async () => {
		const h = await onboarded({ tracks: 300 });
		await h.hub.play(h.stationIds[0]!);
		await h.listen(MINUTE_MS);
		await h.hub.state({ live: true });
		const cur = h.fake.current()!;
		const others = [...h.fake.tracks.keys()].filter((t) => t !== cur).slice(0, 101);
		const orig = h.fake.handle.bind(h.fake);
		let held = false;
		h.fake.handle = async (req: Request) => {
			if (!held && req.method === "POST" && new URL(req.url).pathname.endsWith("/me/player/next")) {
				held = true;
				// While the provider holds the skip: 101 ratings push the receipt out,
				// and the song itself is rated again elsewhere (Siri: Favorit).
				for (const o of others) await rate(h, o, 1);
				await h.hub.thumb(cur, 1);
			}
			return orig(req);
		};
		const before = nexts(h);
		const actionId = newId();
		const answer = await h.hub.rateFromHistory({
			actionId,
			trackId: cur,
			value: -1,
			basis: rated(h, cur),
		});
		h.fake.handle = orig;
		expect(held).toBe(true);
		expect(nexts(h)).toBe(before + 1);
		expect(answer.kind === "done" && answer.receipt.superseded).toBe(true);
		const kept = JSON.parse(
			h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'rating_receipts'`)!.v,
		) as {
			id: string;
		}[];
		expect(kept.some((r) => r.id === actionId)).toBe(false);
		expect(h.hub.historyRatingReceipt(actionId).receipt).toBeNull();
		expect(thumb(h, cur)).toBe(1);
		const seq = rated(h, cur);
		expect((await h.hub.undoHistoryRating(actionId)).receipt).toBeNull();
		expect(thumb(h, cur)).toBe(1);
		expect(rated(h, cur)).toBe(seq);
		expect(nexts(h)).toBe(before + 1);
	});

	it("a receipt whose song the rating clock forgot can no longer be taken back: a conflict, nothing changes", async () => {
		const h = await onboarded({ tracks: 700 });
		const ids = [...h.fake.tracks.keys()];
		const target = ids[0]!;
		const r = await rate(h, target, 1);
		// 501 other songs rated by the old route: the clock forgets the target (its number becomes the floor).
		for (const o of ids.slice(1, 502)) await h.hub.thumb(o, 1);
		expect(rated(h, target)).toBeGreaterThan(r.seq);
		expect(h.hub.historyRatingReceipt(r.id).receipt?.superseded).toBe(true);
		const u = (await h.hub.undoHistoryRating(r.id)).receipt!;
		expect(u.undo?.outcome).toBe("conflict");
		expect(u.undo?.notes.join(" ")).toMatch(/lässt sich nicht mehr genau sagen/);
		expect(thumb(h, target)).toBe(1);
	});
});

describe("ratings from the Verlauf: storage", () => {
	/** The storage refuses the first write `when` matches, once. */
	function failOnce(h: H, when: (q: string, p: unknown[]) => boolean) {
		const run = h.sql.run;
		let armed = true;
		h.sql.run = (q, ...p) => {
			if (armed && when(q, p)) {
				armed = false;
				throw new Error("Synthetic storage failure");
			}
			run.call(h.sql, q, ...p);
		};
		return () => {
			h.sql.run = run;
		};
	}
	const dump = (h: H) =>
		JSON.stringify(
			["memory", "discoveries", "bans", "stations", "jobs", "kv"].map((t) =>
				h.sql
					.all(`SELECT * FROM ${t}`)
					.map((r) => JSON.stringify(r))
					.sort(),
			),
		);

	it("a failure storing the receipt stores nothing; sent again, it counts once", async () => {
		const h = await onboarded({ tracks: 60 });
		const { id } = seedDiscovery(h, "probation");
		h.sql.run(`INSERT INTO bans (station_id, track_id, at) VALUES (?, ?, 5)`, h.stationIds[0]!, id);
		const stored = dump(h);
		const actionId = newId();
		const restore = failOnce(h, (_q, p) => p[0] === "rating_receipts");
		await expect(
			h.hub.rateFromHistory({ actionId, trackId: id, value: 1, basis: 0 }),
		).rejects.toThrow("Synthetic storage failure");
		restore();
		expect(dump(h)).toBe(stored);
		expect(h.hub.historyRatingReceipt(actionId).receipt).toBeNull();
		h.restart();
		const r = await rate(h, id, 1, actionId);
		expect(r.seq).toBe(1);
		expect(thumb(h, id)).toBe(1);
	});

	it("a failure taking back changes nothing; asked again, it is taken back once", async () => {
		const h = await onboarded({ tracks: 60 });
		const { id } = seedDiscovery(h, "probation");
		const r = await rate(h, id, -1);
		const stored = dump(h);
		const restore = failOnce(h, (_q, p) => p[0] === "rating_receipts");
		await expect(h.hub.undoHistoryRating(r.id)).rejects.toThrow("Synthetic storage failure");
		restore();
		expect(dump(h)).toBe(stored);
		h.restart();
		expect((await h.hub.undoHistoryRating(r.id)).receipt!.undo?.outcome).toBe("undone");
		expect(thumb(h, id)).toBeNull();
	});

	/** What every reader sees of the song right now: memory, the Verlauf row, the receipt. */
	const seen = (h: H, id: string, actionId: string) => ({
		thumb: h.hub.memory(id).thumb,
		row: h.hub
			.history(200)
			.filter((e) => e.id === id)
			.map((e) => [e.thumb, e.rated]),
		receipt: h.hub.historyRatingReceipt(actionId).receipt,
	});

	for (const [where, when] of [
		["at the rating clock", (_q: string, p: unknown[]) => p[0] === "rating_clock"],
		["at the receipt", (_q: string, p: unknown[]) => p[0] === "rating_receipts"],
	] as const)
		it(`a rating failing ${where} leaves every reader — at once and after reopening — with the state before; sent again it counts once`, async () => {
			const h = await onboarded({ tracks: 60 });
			await h.hub.play(h.stationIds[0]!);
			await h.listen(10 * MINUTE_MS);
			const id = h.hub.history(200)[0]!.id;
			const { sid } = seedDiscovery(h, "probation");
			h.sql.run(`UPDATE discoveries SET id = ? WHERE station_id = ?`, id, sid);
			h.sql.run(`INSERT INTO bans (station_id, track_id, at) VALUES (?, ?, 5)`, sid, id);
			const actionId = newId();
			const basis = rated(h, id);
			const stored = dump(h);
			const before = seen(h, id, actionId);
			expect(before.row.length).toBeGreaterThan(0);
			const restore = failOnce(h, when);
			await expect(
				h.hub.rateFromHistory({ actionId, trackId: id, value: 1, basis }),
			).rejects.toThrow("Synthetic storage failure");
			restore();
			expect(seen(h, id, actionId)).toEqual(before);
			expect(dump(h)).toBe(stored);
			h.restart();
			expect(seen(h, id, actionId)).toEqual(before);
			const r = await rate(h, id, 1, actionId);
			expect(r.seq).toBe(basis + 1);
			expect(seen(h, id, actionId).thumb).toBe(1);
			await rate(h, id, 1, actionId);
			expect(rated(h, id)).toBe(basis + 1);
		});

	for (const [where, when] of [
		["at the rating clock", (_q: string, p: unknown[]) => p[0] === "rating_clock"],
		["at the receipt", (_q: string, p: unknown[]) => p[0] === "rating_receipts"],
	] as const)
		it(`taking back failing ${where} leaves every reader with the rating given; asked again it is taken back once`, async () => {
			const h = await onboarded({ tracks: 60 });
			const { id } = seedDiscovery(h, "candidate");
			const r = await rate(h, id, 1);
			const stored = dump(h);
			const before = {
				thumb: h.hub.memory(id).thumb,
				receipt: h.hub.historyRatingReceipt(r.id).receipt,
			};
			const restore = failOnce(h, when);
			await expect(h.hub.undoHistoryRating(r.id)).rejects.toThrow("Synthetic storage failure");
			restore();
			expect({
				thumb: h.hub.memory(id).thumb,
				receipt: h.hub.historyRatingReceipt(r.id).receipt,
			}).toEqual(before);
			expect(dump(h)).toBe(stored);
			h.restart();
			expect(h.hub.memory(id).thumb).toBe(1);
			const u = (await h.hub.undoHistoryRating(r.id)).receipt!;
			expect(u.undo?.outcome).toBe("undone");
			const seq = rated(h, id);
			expect(seq).toBe(r.seq + 1);
			await h.hub.undoHistoryRating(r.id);
			expect(rated(h, id)).toBe(seq);
			expect(h.hub.memory(id).thumb).toBe(0);
		});

	it("receipts survive a restart, belong to one listener, and the old thumb keeps its meaning", async () => {
		const a = await onboarded({ tracks: 60 });
		const b = await onboarded({ tracks: 60 });
		const id = [...a.fake.tracks.keys()][2]!;
		const r = await rate(a, id, 1);
		a.restart();
		expect(a.hub.historyRatingReceipt(r.id).receipt).toEqual(r);
		expect(b.hub.historyRatingReceipt(r.id).receipt).toBeNull();
		expect((await b.hub.undoHistoryRating(r.id)).receipt).toBeNull();
		// The sheet and Siri: same answer and effect as ever, and they end the receipt's undo.
		expect(await a.hub.thumb(id, -1)).toEqual({ skipped: false });
		expect(a.hub.historyRatingReceipt(r.id).receipt?.superseded).toBe(true);
		expect(thumb(a, id)).toBe(-1);
	});

	it("the clock and the receipts stay bounded", async () => {
		const h = await onboarded({ tracks: 700 });
		const ids = [...h.fake.tracks.keys()].slice(0, 520);
		for (const id of ids) await h.hub.thumb(id, 1);
		const clock = JSON.parse(
			h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'rating_clock'`)!.v,
		);
		expect(Object.keys(clock.touched)).toHaveLength(500);
		expect(clock.floor).toBe(20);
		// A song that fell out answers with the floor: an old page is refused, never let through.
		expect(rated(h, ids[0]!)).toBe(20);
		for (const id of ids.slice(0, 110)) await rate(h, id, 0);
		const receipts = JSON.parse(
			h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'rating_receipts'`)!.v,
		);
		expect(receipts).toHaveLength(100);
	});
});
