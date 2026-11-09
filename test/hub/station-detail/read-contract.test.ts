/**
 * TS-STATION-DETAIL-CONTRACT-261016: the station page read (`stationDetail`)
 * against its contract (docs/testing/station-detail-contract.md). Real
 * HubCore + node:sqlite + the existing FakeSpotify through the shared
 * HubHarness; stored state comes from the frozen fixtures, expectations from
 * the independent reference model. Each read must also leave every stored
 * table, the alarm and the provider untouched.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { StationDetail } from "../../../src/shared/api";
import { HubError } from "../../../src/worker/hub/hub";
import {
	A_SONGS,
	B_SONGS,
	type DeckFx,
	FIXTURES,
	type Fixture,
	install,
	makeWorld,
	minutesAgo,
	type PlayFx,
	packed,
	type SongRef,
	type StationKey,
	type World,
} from "./fixtures";
import {
	type Catalog,
	expectDiscoveries,
	expectRecent,
	expectUpcoming,
	RECENT_MAX,
	UPCOMING_MAX,
	violations,
} from "./reference";

const fixture = (prefix: string): Fixture => {
	const fx = FIXTURES.find((f) => f.name.startsWith(`${prefix} `));
	if (!fx) throw new Error(`no fixture ${prefix}`);
	return fx;
};

function catalog(w: World): Catalog {
	const inRange = (song: SongRef, [lo, hi]: readonly [number, number]) =>
		typeof song === "number" && song >= lo && song <= hi;
	return {
		look(song) {
			const p = packed(w, song);
			return {
				id: p[0],
				name: p[1],
				artists: p[2].map((a) => a[1]).join(", "),
				album: p[3],
				durationMs: p[5],
			};
		},
		holds: (station, song) => inRange(song, station === "A" ? A_SONGS : B_SONGS),
		known: (song) => typeof song === "number",
		playedAt: (ago) => minutesAgo(w, ago),
	};
}

/** The fields the contract speaks about; anything else (images, thumbs, write numbers) is not compared. */
function project(d: StationDetail) {
	const look = (t: {
		id: string;
		name: string;
		artists: string;
		album: string;
		durationMs: number;
	}) => ({
		id: t.id,
		name: t.name,
		artists: t.artists,
		album: t.album,
		durationMs: t.durationMs,
	});
	return {
		upcoming: d.upcoming.map((t) => ({ ...look(t), kind: t.kind })),
		recent: d.recent.map((t) => ({ ...look(t), playedAt: t.playedAt })),
		discoveries: d.discoveries,
	};
}

/** Everything a read could change: stored tables, the alarm, the provider and its player. */
function snapshot(w: World) {
	const tables = [
		"plays",
		"memory",
		"bans",
		"stations",
		"discoveries",
		"playback_sessions",
		"kv",
		"jobs",
		"events",
		"pages",
		"playlists",
	];
	return {
		tables: Object.fromEntries(tables.map((t) => [t, w.h.sql.all(`SELECT * FROM ${t}`)])),
		alarm: w.h.alarmAt(),
		providerCalls: [...w.fake.calls],
		player: JSON.stringify(w.fake.user("mika").player),
		recentlyPlayed: JSON.stringify(w.fake.user("mika").recent),
		queue: JSON.stringify(w.fake.user("mika").player.userQueue),
	};
}

/** Install, read once, check against the reference and check nothing moved. */
function readChecked(w: World, fx: Fixture): ReturnType<typeof project> {
	install(w, fx);
	const before = snapshot(w);
	const d = w.h.hub.stationDetail(w.stationId[fx.read]);
	const after = snapshot(w);
	expect(d.id).toBe(w.stationId[fx.read]);
	const p = project(d);
	const cat = catalog(w);
	expect([
		...violations(`${fx.name} upcoming`, p.upcoming, expectUpcoming(fx, cat)),
		...violations(`${fx.name} recent`, p.recent, expectRecent(fx, cat)),
	]).toEqual([]);
	expect(p.discoveries, `${fx.name} discoveries`).toEqual(expectDiscoveries(fx));
	expect(after, `${fx.name}: the read changed stored or provider state`).toEqual(before);
	return p;
}

describe("station detail read contract (R5 4cca91df)", () => {
	let w: World;
	beforeAll(async () => {
		w = await makeWorld();
	}, 60_000);

	it("SD-00 fixture table: at least 30 frozen, uniquely named fixtures over two overlapping stations", () => {
		expect(FIXTURES.length).toBeGreaterThanOrEqual(30);
		expect(new Set(FIXTURES.map((f) => f.name)).size).toBe(FIXTURES.length);
		expect(Object.isFrozen(FIXTURES)).toBe(true);
		for (const f of FIXTURES) expect(Object.isFrozen(f) && Object.isFrozen(f.plays)).toBe(true);
		expect(w.stationId.A).not.toBe(w.stationId.B);
		const shared = Math.min(A_SONGS[1], B_SONGS[1]) - Math.max(A_SONGS[0], B_SONGS[0]) + 1;
		expect(shared).toBe(10);
		// The fixture table promises no tie: no two counted plays of one station share a time.
		for (const f of FIXTURES)
			for (const s of ["A", "B"] as const) {
				const at = f.plays.filter((p) => p.station === s).map((p) => p.ago);
				expect(new Set(at).size, f.name).toBe(at.length);
			}
	});

	it.each(FIXTURES.map((f) => [f.name, f] as const))(
		"SD-01 reference conformance and no write: %s",
		(_name, fx) => {
			readChecked(w, fx);
		},
	);

	it("SD-02 upcoming bounds 0 / 1 / 12 / 13 pending after the position", () => {
		const len = (p: string) => readChecked(w, fixture(p)).upcoming.length;
		expect(len("U01")).toBe(0);
		expect(len("U02")).toBe(0);
		expect(len("U03")).toBe(1);
		expect(len("U04")).toBe(UPCOMING_MAX);
		const thirteen = readChecked(w, fixture("U05")).upcoming;
		expect(thirteen).toHaveLength(UPCOMING_MAX);
		// The thirteenth pending song (deck place 3 + 12) is not shown.
		expect(thirteen.map((t) => t.id)).not.toContain(w.trackId(3 + 12));
		expect(thirteen[0]!.id).toBe(w.trackId(3));
		expect(readChecked(w, fixture("U13")).upcoming).toHaveLength(UPCOMING_MAX);
	});

	it("SD-03 upcoming starts after the seen position, else the held one, else at the deck's start", () => {
		const ids = (p: string) => readChecked(w, fixture(p)).upcoming.map((t) => t.id);
		expect(ids("U06")[0]).toBe(w.trackId(0));
		expect(ids("U07")).toEqual([5, 6, 7].map(w.trackId));
		expect(ids("U08")).toEqual([6, 7].map(w.trackId));
		expect(ids("U09")).toEqual([3, 4].map(w.trackId));
		// The song at the position plays or was just seen: it is not upcoming.
		expect(ids("U12")).toEqual([3, 4].map(w.trackId));
	});

	it("SD-04 upcoming keeps deck order and each place's own kind, pending places only", () => {
		const u10 = readChecked(w, fixture("U10")).upcoming;
		expect(u10.map((t) => [t.id, t.kind])).toEqual([
			[w.trackId(2), "probe"],
			[w.trackId(4), "favorite"],
			[w.trackId(6), "fresh"],
			[w.trackId(8), "favorite"],
		]);
		const u11 = readChecked(w, fixture("U11")).upcoming;
		expect(u11.map((t) => [t.id, t.kind])).toEqual([
			[w.trackId(5), "fresh"],
			[w.trackId(6), "probe"],
			[w.trackId(5), "favorite"],
		]);
		// Facts name the same kind as the place (existing song-facts contract).
		install(w, fixture("U10"));
		for (const t of w.h.hub.stationDetail(w.stationId.A).upcoming)
			expect(t.facts?.kind).toBe(t.kind);
	});

	it("SD-05 recent bounds 0 / 1 / 15 / 16 plays", () => {
		const rec = (p: string) => readChecked(w, fixture(p)).recent;
		expect(rec("R01")).toEqual([]);
		expect(rec("R02").map((t) => t.id)).toEqual([w.trackId(3)]);
		expect(rec("R03")).toHaveLength(RECENT_MAX);
		const r16 = rec("R04");
		expect(r16).toHaveLength(RECENT_MAX);
		// Song 15 was played 16 minutes ago, the oldest: it drops.
		expect(r16.map((t) => t.id)).not.toContain(w.trackId(15));
		expect(r16[0]).toMatchObject({ id: w.trackId(0), playedAt: minutesAgo(w, 1) });
	});

	it("SD-06 recent holds only the station's own plays that count", () => {
		const r05 = readChecked(w, fixture("R05")).recent;
		expect(r05).toHaveLength(RECENT_MAX);
		expect(r05[0]!.playedAt).toBe(minutesAgo(w, 10));
		const r06 = readChecked(w, fixture("R06")).recent;
		expect(r06.map((t) => [t.id, t.playedAt])).toEqual([
			[w.trackId(17), minutesAgo(w, 2)],
			[w.trackId(16), minutesAgo(w, 4)],
			[w.trackId(20), minutesAgo(w, 6)],
		]);
	});

	it("SD-07 recent is newest first and every repeat is its own event", () => {
		const r07 = readChecked(w, fixture("R07")).recent;
		expect(r07.map((t) => [t.id, t.playedAt])).toEqual([
			[w.trackId(4), minutesAgo(w, 1)],
			[w.trackId(4), minutesAgo(w, 5)],
			[w.trackId(7), minutesAgo(w, 9)],
			[w.trackId(4), minutesAgo(w, 13)],
		]);
		const r08 = readChecked(w, fixture("R08")).recent;
		expect(r08.map((t) => t.id)).toEqual([5, 2, 4, 1, 3].map(w.trackId));
		for (let i = 1; i < r08.length; i++)
			expect(r08[i - 1]!.playedAt).toBeGreaterThan(r08[i]!.playedAt);
	});

	it("SD-08 two stations sharing songs read independently", () => {
		const a = readChecked(w, fixture("C01"));
		const b = readChecked(w, fixture("C02"));
		expect(a.upcoming.map((t) => t.id)).toEqual(
			[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(w.trackId),
		);
		expect(b.upcoming.map((t) => t.id)).toEqual(
			[19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30].map(w.trackId),
		);
		// A's plays at odd minutes, B's at even ones: no play shows on the other page.
		for (const t of a.recent) expect(((w.now - t.playedAt) / 60_000) % 2).toBe(1);
		for (const t of b.recent) expect(((w.now - t.playedAt) / 60_000) % 2).toBe(0);
		expect(a.discoveries).toEqual({ pending: 1, kept: 1, rejected: 0 });
		expect(b.discoveries).toEqual({ pending: 1, kept: 0, rejected: 1 });
		// B's deck over shared songs does not leak into A, and back.
		expect(readChecked(w, fixture("U16")).upcoming.map((t) => t.id)).toEqual(
			[17, 18, 19].map(w.trackId),
		);
		expect(readChecked(w, fixture("U17")).upcoming[0]!.id).toBe(w.trackId(16));
		const r13 = readChecked(w, fixture("R13")).recent;
		expect(r13).toHaveLength(RECENT_MAX);
		for (const t of r13) expect(((w.now - t.playedAt) / 60_000) % 2).toBe(1);
	});

	it("SD-09 metadata gaps: nothing invented, stored metadata wins, the station or its finds fill in", () => {
		const ghostU = w.trackId("g1");
		const u14 = readChecked(w, fixture("U14")).upcoming;
		expect(u14.map((t) => t.id)).not.toContain(ghostU);
		const r11 = readChecked(w, fixture("R11")).recent;
		expect(r11.map((t) => t.id)).not.toContain(w.trackId("g2"));
		expect(readChecked(w, fixture("R09")).recent[0]).toMatchObject({
			id: w.trackId(6),
			name: "Song 6 (Live)",
			album: "Live Album",
		});
		expect(readChecked(w, fixture("R10")).recent.map((t) => t.id)).toEqual([8, 9].map(w.trackId));
		expect(readChecked(w, fixture("R12")).recent[0]).toMatchObject({
			id: w.trackId("d2"),
			name: "Found 2",
		});
		expect(readChecked(w, fixture("U15")).upcoming.map((t) => [t.id, t.kind])).toEqual([
			[w.trackId("d1"), "discovery"],
			[w.trackId(1), "fresh"],
		]);
	});

	it("SD-10 discovery counts: the station's own finds by status", () => {
		expect(readChecked(w, fixture("D01")).discoveries).toEqual({
			pending: 0,
			kept: 0,
			rejected: 0,
		});
		expect(readChecked(w, fixture("D02")).discoveries).toEqual({
			pending: 3,
			kept: 3,
			rejected: 1,
		});
		expect(readChecked(w, fixture("D03")).discoveries).toEqual({
			pending: 1,
			kept: 0,
			rejected: 1,
		});
	});

	it("SD-11 an unknown station is a 404 and changes nothing", () => {
		install(w, fixture("C01"));
		const before = snapshot(w);
		const known = new Set(Object.values(w.stationId));
		for (const id of [0, -1, 999_999, Number.NaN, 1.5, Math.max(...known) + 1000]) {
			let err: unknown = null;
			try {
				w.h.hub.stationDetail(id);
			} catch (e) {
				err = e;
			}
			expect(err, `id ${id}`).toBeInstanceOf(HubError);
			expect({ code: (err as HubError).code, status: (err as HubError).status }).toEqual({
				code: "not_found",
				status: 404,
			});
		}
		expect(snapshot(w)).toEqual(before);
	});

	it("SD-12 repeated reads of unchanged state answer the same and write nothing", () => {
		install(w, fixture("C01"));
		const before = snapshot(w);
		const first = project(w.h.hub.stationDetail(w.stationId.A));
		const firstB = project(w.h.hub.stationDetail(w.stationId.B));
		for (let i = 0; i < 3; i++) {
			expect(project(w.h.hub.stationDetail(w.stationId.A))).toEqual(first);
			expect(project(w.h.hub.stationDetail(w.stationId.B))).toEqual(firstB);
		}
		w.h.restart();
		expect(project(w.h.hub.stationDetail(w.stationId.A))).toEqual(first);
		expect(snapshot(w)).toEqual(before);
	});
});

describe("station detail over actually played state", () => {
	/** Turn what the hub stored after real playback into a fixture, songs by world number. */
	function storedFixture(w: World, read: StationKey): Fixture {
		const songOf = new Map<string, SongRef>();
		for (let n = 0; n < 40; n++) songOf.set(w.trackId(n), n);
		const ref = (id: string): SongRef => {
			const s = songOf.get(id);
			if (s === undefined) throw new Error(`song ${id} is not a world song`);
			return s;
		};
		const decks: Partial<Record<StationKey, DeckFx | null>> = {};
		for (const key of ["A", "B"] as const) {
			const row = w.h.sql.first<{ deck: string | null }>(
				`SELECT deck FROM stations WHERE id = ?`,
				w.stationId[key],
			);
			const d = row?.deck
				? (JSON.parse(row.deck) as {
						items: { id: string; kind: never; state: never }[];
						lastIndex: number | null;
						heldAt?: number | null;
					})
				: null;
			decks[key] = d
				? {
						items: d.items.map((it) => ({ song: ref(it.id), kind: it.kind, state: it.state })),
						lastIndex: d.lastIndex,
						heldAt: d.heldAt,
					}
				: null;
		}
		const keyOf = (sid: number | null): StationKey | null =>
			sid === w.stationId.A ? "A" : sid === w.stationId.B ? "B" : null;
		const plays: PlayFx[] = w.h.sql
			.all<{
				played_at: number;
				track_id: string;
				station_id: number | null;
				ignored: number;
				meta: string | null;
			}>(`SELECT played_at, track_id, station_id, ignored, meta FROM plays`)
			.map((p) => ({
				ago: (w.now - p.played_at) / 60_000,
				song: ref(p.track_id),
				station: keyOf(p.station_id),
				ignored: p.ignored === 1,
				meta: p.meta ? ("packed" as const) : ("none" as const),
			}));
		const discoveries = w.h.sql
			.all<{ station_id: number; id: string; status: never }>(
				`SELECT station_id, id, status FROM discoveries`,
			)
			.map((d) => ({ station: keyOf(d.station_id)!, song: ref(d.id), status: d.status }));
		return { name: `stored ${read}`, read, decks, plays, discoveries };
	}

	it("SD-13 after real playback on A: the read matches the reference over the stored state, mid-session, without a write", async () => {
		const w = await makeWorld();
		expect((await w.h.hub.play(w.stationId.A)).ok).toBe(true);
		await w.h.settle();
		await w.h.listen(45 * 60_000);
		const st = await w.h.hub.state({ live: true });
		expect(st.session?.stationId).toBe(w.stationId.A);
		w.now = w.h.clock.t;
		const counted = w.h.sql.first<{ n: number }>(
			`SELECT COUNT(*) AS n FROM plays WHERE station_id = ? AND ignored = 0`,
			w.stationId.A,
		)!.n;
		expect(counted).toBeGreaterThan(3);
		for (const read of ["A", "B"] as const) {
			const fx = storedFixture(w, read);
			const before = snapshot(w);
			const p = project(w.h.hub.stationDetail(w.stationId[read]));
			expect(snapshot(w), `reading ${read} mid-session`).toEqual(before);
			const cat = catalog(w);
			// Stored plays keep their own metadata; songs read from Spotify carry Spotify's names.
			expect([
				...violations(`stored ${read} upcoming`, p.upcoming, expectUpcoming(fx, cat)),
				...violations(`stored ${read} recent`, p.recent, expectRecent(fx, cat)),
			]).toEqual([]);
			expect(p.discoveries).toEqual(expectDiscoveries(fx));
		}
		expect(project(w.h.hub.stationDetail(w.stationId.A)).recent.length).toBe(
			Math.min(counted, RECENT_MAX),
		);
	});
});
