/**
 * TS-STATION-DETAIL-CONTRACT-261016: frozen fixtures for the station page's
 * read contract (`HubCore.stationDetail`). One world — the real HubCore on
 * node:sqlite against the existing FakeSpotify, built through the shared
 * HubHarness — with two playlist stations whose songs overlap. Each fixture
 * declares only stored state (decks, plays, discoveries); `install` writes it
 * into the hub's own tables and starts a fresh HubCore over them, so every
 * read begins with cold caches.
 *
 * Fixture times are minutes before the world's clock; no two events of one
 * station share a time (the read promises no order among ties).
 */

import type { DeckItemState } from "../../../src/core/deck";
import type { SlotKind } from "../../../src/core/types";
import { FakeSpotify } from "../../fakes/fake-spotify";
import { type Harness, makeHarness } from "../harness";

/** The two playlist stations of the world. */
export type StationKey = "A" | "B";

/** World songs 0..39: A holds 0..24, B holds 15..39, both hold 15..24. */
export const WORLD_TRACKS = 40;
export const A_SONGS = [0, 24] as const;
export const B_SONGS = [15, 39] as const;

/**
 * A song reference: a world song by number, a discovery (its metadata lives
 * only in the discoveries table) or a ghost (no metadata anywhere).
 */
export type SongRef = number | `d${number}` | `g${number}`;

export interface DeckItemFx {
	song: SongRef;
	kind: SlotKind;
	state: DeckItemState;
}

export interface DeckFx {
	items: readonly DeckItemFx[];
	lastIndex: number | null;
	heldAt?: number | null;
}

/** Stored metadata of a play: the packed song (default), none, or a renamed copy. */
export type PlayMeta = "packed" | "none" | { name: string; album: string };

export interface PlayFx {
	/** Minutes before the world's clock. */
	ago: number;
	song: SongRef;
	station: StationKey | null;
	ignored?: boolean;
	meta?: PlayMeta;
}

export type DiscoveryStatus = "candidate" | "probation" | "kept" | "rejected";

export interface DiscoveryFx {
	station: StationKey;
	song: SongRef;
	status: DiscoveryStatus;
}

export interface Fixture {
	name: string;
	/** The station whose page is read. */
	read: StationKey;
	decks: Partial<Record<StationKey, DeckFx | null>>;
	plays: readonly PlayFx[];
	discoveries: readonly DiscoveryFx[];
}

// ---------------------------------------------------------------------------
// Builders (used only to write the frozen table below)
// ---------------------------------------------------------------------------

const K: readonly SlotKind[] = ["fresh", "favorite", "discovery", "probe"];
const kindAt = (i: number): SlotKind => K[i % K.length]!;

/** `before` consumed songs (played), then `pending` waiting ones; position on the last consumed. */
function deckAfter(first: number, before: number, pending: number): DeckFx {
	const items: DeckItemFx[] = [];
	for (let i = 0; i < before; i++) items.push({ song: first + i, kind: "fresh", state: "played" });
	for (let i = 0; i < pending; i++)
		items.push({ song: first + before + i, kind: kindAt(i), state: "pending" });
	return { items, lastIndex: before > 0 ? before - 1 : null };
}

/** `n` plays of station `station`, one minute apart, newest `startAgo` minutes ago. */
function playsOf(station: StationKey, songs: readonly SongRef[], startAgo = 1): PlayFx[] {
	return songs.map((song, i) => ({ ago: startAgo + i, song, station }));
}

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

function deepFreeze<T>(o: T): T {
	if (o && typeof o === "object") {
		for (const v of Object.values(o)) deepFreeze(v);
		Object.freeze(o);
	}
	return o;
}

// ---------------------------------------------------------------------------
// The frozen fixtures
// ---------------------------------------------------------------------------

const none: Pick<Fixture, "plays" | "discoveries"> = { plays: [], discoveries: [] };

export const FIXTURES: readonly Fixture[] = deepFreeze<Fixture[]>([
	// --- upcoming: window bounds ------------------------------------------
	{ name: "U01 no deck written", read: "A", decks: { A: null }, ...none },
	{ name: "U02 0 pending after position", read: "A", decks: { A: deckAfter(0, 6, 0) }, ...none },
	{ name: "U03 1 pending after position", read: "A", decks: { A: deckAfter(0, 3, 1) }, ...none },
	{ name: "U04 12 pending after position", read: "A", decks: { A: deckAfter(0, 3, 12) }, ...none },
	{ name: "U05 13 pending after position", read: "A", decks: { A: deckAfter(0, 3, 13) }, ...none },
	{
		name: "U06 no position: from the deck's start, 13 pending",
		read: "A",
		decks: { A: deckAfter(0, 0, 13) },
		...none,
	},
	{
		name: "U07 held position when nothing was seen",
		read: "A",
		decks: {
			A: {
				items: range(0, 8).map((s) => ({ song: s, kind: kindAt(s), state: "pending" as const })),
				lastIndex: null,
				heldAt: 4,
			},
		},
		...none,
	},
	{
		name: "U08 seen position wins over held position",
		read: "A",
		decks: {
			A: {
				items: range(0, 8).map((s) => ({ song: s, kind: kindAt(s), state: "pending" as const })),
				lastIndex: 5,
				heldAt: 1,
			},
		},
		...none,
	},
	{
		name: "U09 pending songs before the position stay out",
		read: "A",
		decks: {
			A: {
				items: [
					{ song: 0, kind: "fresh", state: "pending" },
					{ song: 1, kind: "favorite", state: "pending" },
					{ song: 2, kind: "fresh", state: "played" },
					{ song: 3, kind: "probe", state: "pending" },
					{ song: 4, kind: "discovery", state: "pending" },
				],
				lastIndex: 2,
			},
		},
		...none,
	},
	{
		name: "U10 passed/played/skipped after the position are left out, order and kinds kept",
		read: "A",
		decks: {
			A: {
				items: [
					{ song: 0, kind: "fresh", state: "played" },
					{ song: 1, kind: "favorite", state: "skipped" },
					{ song: 2, kind: "probe", state: "pending" },
					{ song: 3, kind: "fresh", state: "passed" },
					{ song: 4, kind: "favorite", state: "pending" },
					{ song: 5, kind: "discovery", state: "played" },
					{ song: 6, kind: "fresh", state: "pending" },
					{ song: 7, kind: "probe", state: "skipped" },
					{ song: 8, kind: "favorite", state: "pending" },
				],
				lastIndex: 0,
			},
		},
		...none,
	},
	{
		name: "U11 one song twice in the deck: two entries, each with its own kind",
		read: "A",
		decks: {
			A: {
				items: [
					{ song: 0, kind: "fresh", state: "played" },
					{ song: 5, kind: "fresh", state: "pending" },
					{ song: 6, kind: "probe", state: "pending" },
					{ song: 5, kind: "favorite", state: "pending" },
				],
				lastIndex: 0,
			},
		},
		...none,
	},
	{
		name: "U12 the song at the position itself is not upcoming",
		read: "A",
		decks: {
			A: {
				items: range(0, 5).map((s) => ({ song: s, kind: kindAt(s), state: "pending" as const })),
				lastIndex: 2,
			},
		},
		...none,
	},
	{
		name: "U13 13 pending after a position that holds 12 consumed songs and interleaved skips",
		read: "A",
		decks: {
			A: {
				items: [
					...range(0, 12).map((s) => ({
						song: s,
						kind: "fresh" as const,
						state: "played" as const,
					})),
					...range(12, 13).flatMap((s, i) => [
						{ song: s, kind: kindAt(i), state: "pending" as const },
						...(i % 4 === 1
							? [{ song: s, kind: "fresh" as const, state: "skipped" as const }]
							: []),
					]),
				],
				lastIndex: 11,
			},
		},
		...none,
	},
	{
		name: "U14 metadata gap: a ghost song inside the 12-window, 14 pending",
		read: "A",
		decks: {
			A: {
				items: [
					{ song: 0, kind: "fresh", state: "played" },
					{ song: 1, kind: "fresh", state: "pending" },
					{ song: 2, kind: "favorite", state: "pending" },
					{ song: "g1", kind: "fresh", state: "pending" },
					...range(3, 11).map((s, i) => ({ song: s, kind: kindAt(i), state: "pending" as const })),
				],
				lastIndex: 0,
			},
		},
		...none,
	},
	{
		name: "U15 discovery in the deck: metadata from the discoveries table",
		read: "A",
		decks: {
			A: {
				items: [
					{ song: 0, kind: "fresh", state: "played" },
					{ song: "d1", kind: "discovery", state: "pending" },
					{ song: 1, kind: "fresh", state: "pending" },
				],
				lastIndex: 0,
			},
		},
		plays: [],
		discoveries: [{ station: "A", song: "d1", status: "probation" }],
	},
	{
		name: "U16 overlapping station B: its deck does not leak into A's page",
		read: "A",
		decks: {
			A: deckAfter(15, 2, 3),
			B: deckAfter(15, 0, 13),
		},
		...none,
	},
	{
		name: "U17 overlapping station B read: its own window over shared songs",
		read: "B",
		decks: {
			A: deckAfter(15, 2, 3),
			B: deckAfter(15, 1, 13),
		},
		...none,
	},

	// --- recent: window bounds and filters ---------------------------------
	{ name: "R01 0 plays", read: "A", decks: {}, ...none },
	{ name: "R02 1 play", read: "A", decks: {}, plays: playsOf("A", [3]), discoveries: [] },
	{
		name: "R03 15 plays",
		read: "A",
		decks: {},
		plays: playsOf("A", range(0, 15)),
		discoveries: [],
	},
	{
		name: "R04 16 plays: the oldest drops",
		read: "A",
		decks: {},
		plays: playsOf("A", range(0, 16)),
		discoveries: [],
	},
	{
		name: "R05 ignored plays never count, even when newest",
		read: "A",
		decks: {},
		plays: [
			...playsOf("A", range(0, 16), 10),
			...range(0, 5).map((i) => ({
				ago: 1 + i,
				song: 20 + i,
				station: "A" as const,
				ignored: true,
			})),
			{ ago: 40, song: 2, station: "A", ignored: true },
		],
		discoveries: [],
	},
	{
		name: "R06 plays of the other station and of no station stay out (shared songs)",
		read: "A",
		decks: {},
		plays: [
			{ ago: 1, song: 16, station: "B" },
			{ ago: 2, song: 17, station: "A" },
			{ ago: 3, song: 18, station: null },
			{ ago: 4, song: 16, station: "A" },
			{ ago: 5, song: 19, station: "B" },
			{ ago: 6, song: 20, station: "A" },
		],
		discoveries: [],
	},
	{
		name: "R07 repeats stay separate events",
		read: "A",
		decks: {},
		plays: [
			{ ago: 1, song: 4, station: "A" },
			{ ago: 5, song: 4, station: "A" },
			{ ago: 9, song: 7, station: "A" },
			{ ago: 13, song: 4, station: "A" },
		],
		discoveries: [],
	},
	{
		name: "R08 newest first, whatever order the rows were stored in",
		read: "A",
		decks: {},
		plays: [
			{ ago: 30, song: 1, station: "A" },
			{ ago: 2, song: 2, station: "A" },
			{ ago: 600, song: 3, station: "A" },
			{ ago: 15, song: 4, station: "A" },
			{ ago: 1, song: 5, station: "A" },
		],
		discoveries: [],
	},
	{
		name: "R09 the play's own stored metadata wins",
		read: "A",
		decks: {},
		plays: [
			{ ago: 1, song: 6, station: "A", meta: { name: "Song 6 (Live)", album: "Live Album" } },
			{ ago: 2, song: 7, station: "A" },
		],
		discoveries: [],
	},
	{
		name: "R10 play without stored metadata: the station's songs supply it",
		read: "A",
		decks: {},
		plays: [
			{ ago: 1, song: 8, station: "A", meta: "none" },
			{ ago: 2, song: 9, station: "A" },
		],
		discoveries: [],
	},
	{
		name: "R11 metadata gap: a ghost play without metadata among 16",
		read: "A",
		decks: {},
		plays: [
			...playsOf("A", range(0, 3)),
			{ ago: 4, song: "g2", station: "A", meta: "none" },
			...playsOf("A", range(3, 12), 5),
		],
		discoveries: [],
	},
	{
		name: "R12 play of a kept discovery without stored metadata",
		read: "A",
		decks: {},
		plays: [
			{ ago: 1, song: "d2", station: "A", meta: "none" },
			{ ago: 2, song: 1, station: "A" },
		],
		discoveries: [{ station: "A", song: "d2", status: "kept" }],
	},
	{
		name: "R13 16 plays of station B over shared songs, with A's plays interleaved",
		read: "B",
		decks: {},
		plays: [
			...range(0, 16).map((i) => ({ ago: 2 * i + 1, song: 15 + (i % 10), station: "B" as const })),
			...range(0, 16).map((i) => ({ ago: 2 * i + 2, song: 15 + (i % 10), station: "A" as const })),
		],
		discoveries: [],
	},

	// --- discoveries ---------------------------------------------------------
	{ name: "D01 no discoveries", read: "A", decks: {}, ...none },
	{
		name: "D02 counts by status: candidate+probation pending, kept, rejected",
		read: "A",
		decks: {},
		plays: [],
		discoveries: [
			{ station: "A", song: "d1", status: "candidate" },
			{ station: "A", song: "d2", status: "candidate" },
			{ station: "A", song: "d3", status: "probation" },
			{ station: "A", song: "d4", status: "kept" },
			{ station: "A", song: "d5", status: "kept" },
			{ station: "A", song: "d6", status: "kept" },
			{ station: "A", song: "d7", status: "rejected" },
		],
	},
	{
		name: "D03 the other station's discoveries are not counted, a shared find counts per station",
		read: "A",
		decks: {},
		plays: [],
		discoveries: [
			{ station: "A", song: "d1", status: "candidate" },
			{ station: "B", song: "d1", status: "kept" },
			{ station: "B", song: "d2", status: "rejected" },
			{ station: "B", song: "d3", status: "probation" },
			{ station: "A", song: "d4", status: "rejected" },
		],
	},

	// --- everything at once ---------------------------------------------------
	{
		name: "C01 both stations full: decks, plays and finds over shared songs",
		read: "A",
		decks: { A: deckAfter(0, 4, 13), B: deckAfter(15, 4, 13) },
		plays: [
			...range(0, 17).map((i) => ({ ago: 2 * i + 1, song: 10 + i, station: "A" as const })),
			...range(0, 17).map((i) => ({ ago: 2 * i + 2, song: 15 + i, station: "B" as const })),
			{ ago: 0.5, song: 12, station: "A", ignored: true },
		],
		discoveries: [
			{ station: "A", song: "d1", status: "candidate" },
			{ station: "B", song: "d1", status: "candidate" },
			{ station: "A", song: "d2", status: "kept" },
		],
	},
	{
		name: "C02 both stations full, read from B",
		read: "B",
		decks: { A: deckAfter(0, 4, 13), B: deckAfter(15, 4, 13) },
		plays: [
			...range(0, 17).map((i) => ({ ago: 2 * i + 1, song: 10 + i, station: "A" as const })),
			...range(0, 17).map((i) => ({ ago: 2 * i + 2, song: 15 + i, station: "B" as const })),
			{ ago: 0.5, song: 20, station: "B", ignored: true },
		],
		discoveries: [
			{ station: "A", song: "d1", status: "candidate" },
			{ station: "B", song: "d1", status: "candidate" },
			{ station: "B", song: "d3", status: "rejected" },
		],
	},
]);

// ---------------------------------------------------------------------------
// World: the real hub with two overlapping playlist stations
// ---------------------------------------------------------------------------

export interface World {
	h: Harness;
	fake: FakeSpotify;
	/** Clock at setup end: fixture times count back from here. */
	now: number;
	stationId: Record<StationKey, number>;
	trackId(song: SongRef): string;
}

/** A 22-character id that no source and no fake song uses. */
function special(prefix: "D" | "G", n: number): string {
	return `${prefix}${"x".repeat(17)}${String(n).padStart(4, "0")}`;
}

export async function makeWorld(): Promise<World> {
	const fake = new FakeSpotify();
	const tracks = fake.addTracks(WORLD_TRACKS);
	fake.addUser("mika");
	const plA = fake.addPlaylist(
		"mika",
		"Sender A",
		tracks.slice(A_SONGS[0], A_SONGS[1] + 1).map((t) => t.id),
	);
	const plB = fake.addPlaylist(
		"mika",
		"Sender B",
		tracks.slice(B_SONGS[0], B_SONGS[1] + 1).map((t) => t.id),
	);
	const h = await makeHarness({ fake });
	fake.refreshTokens.set("rt-world", "mika");
	await h.hub.connect(
		{ id: "mika", name: "Mika", imageUrl: null },
		{
			accessToken: fake.issueToken("mika"),
			refreshToken: "rt-world",
			expiresAt: h.clock.t + 3_600_000,
			scope: "all",
		},
	);
	await h.settle();
	await h.hub.onboard([plA.id, plB.id]);
	await h.settle();
	await h.listen(60_000);
	await h.settle();
	const st = await h.hub.state();
	const byPlaylist = (pid: string) =>
		st.stations.find((s) => s.sources.some((x) => x.type === "playlist" && x.id === pid))!.id;
	const trackId = (song: SongRef): string => {
		if (typeof song === "number") return tracks[song]!.id;
		return special(song[0] === "d" ? "D" : "G", Number(song.slice(1)));
	};
	return {
		h,
		fake,
		now: h.clock.t,
		stationId: { A: byPlaylist(plA.id), B: byPlaylist(plB.id) },
		trackId,
	};
}

/** The packed form the hub stores for a song (see `PackedTrack`). */
export function packed(
	w: World,
	song: SongRef,
): [string, string, [string, string][], string, null, number] {
	if (typeof song === "number") {
		const t = w.fake.tracks.get(w.trackId(song))!;
		return [t.id, t.name, [[t.artistId, t.artistName]], t.albumName, null, t.durationMs];
	}
	const n = Number(song.slice(1));
	return [
		w.trackId(song),
		`Found ${n}`,
		[[`AR${n}`, `Finder ${n}`]],
		`Found Album ${n}`,
		null,
		200_000 + n,
	];
}

export const minutesAgo = (w: World, ago: number) => Math.round(w.now - ago * 60_000);

/** Write a fixture's stored state into the hub's tables, then start a fresh hub over them. */
export function install(w: World, fx: Fixture): void {
	const sql = w.h.sql;
	sql.transaction(() => {
		sql.run(`DELETE FROM plays`);
		sql.run(`DELETE FROM discoveries`);
		for (const key of ["A", "B"] as const) {
			// A station the fixture does not name has no deck: nothing from an earlier fixture stays.
			const d = fx.decks[key] ?? null;
			const deck =
				d === null
					? null
					: JSON.stringify({
							version: 1,
							items: d.items.map((it) => ({
								id: w.trackId(it.song),
								kind: it.kind,
								state: it.state,
								at: it.state === "pending" ? null : w.now - 3_600_000,
							})),
							writtenAt: w.now - 7_200_000,
							lastIndex: d.lastIndex,
							lastTrackId: d.lastIndex === null ? null : w.trackId(d.items[d.lastIndex]!.song),
							lastObservedAt: d.lastIndex === null ? null : w.now - 60_000,
							...(d.heldAt !== undefined ? { heldAt: d.heldAt } : {}),
						});
			sql.run(`UPDATE stations SET deck = ? WHERE id = ?`, deck, w.stationId[key]);
		}
		for (const p of fx.plays) {
			const meta = p.meta ?? "packed";
			const base = packed(w, p.song);
			const stored =
				meta === "none"
					? null
					: JSON.stringify(
							meta === "packed" ? base : [base[0], meta.name, base[2], meta.album, null, base[5]],
						);
			sql.run(
				`INSERT INTO plays (played_at, track_id, context_uri, station_id, ignored, meta, lane) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
				minutesAgo(w, p.ago),
				w.trackId(p.song),
				null,
				p.station === null ? null : w.stationId[p.station],
				p.ignored ? 1 : 0,
				stored,
			);
		}
		for (const d of fx.discoveries)
			sql.run(
				`INSERT INTO discoveries (station_id, id, source, score, status, meta, heard, created_at, updated_at) VALUES (?, ?, 'fixture', 1, ?, ?, 0, ?, ?)`,
				w.stationId[d.station],
				w.trackId(d.song),
				d.status,
				JSON.stringify(packed(w, d.song)),
				w.now - 86_400_000,
				w.now - 86_400_000,
			);
	});
	w.h.restart();
}
