/**
 * Every play of an imported Spotify streaming history, kept compact so the
 * Hörprofil can look at any period of it (see `period-profile.ts`).
 *
 * The browser turns the export into a song list and one short row per play;
 * the server stores both packed in pages (schema: listen_pages), so even a
 * history of several hundred thousand plays costs only a few hundred row
 * writes, and reads back in as many rows.
 */

import { PLAY_THRESHOLD_MS, type TrackId } from "./types";

/** [id, song name, album artist, album]. */
export type ListenTrack = [TrackId, string, string, string];

/**
 * [ended at, in whole seconds; index into the song list; ms heard; flags;
 * platform (index into PLATFORMS)].
 */
export type ListenRow = [number, number, number, number, number];

export const LISTEN_FLAG = {
	/** Spotify marked it skipped. */
	skipped: 1,
	/** Ended with the forward button. */
	forward: 2,
	/** Played to its end. */
	done: 4,
	shuffle: 8,
	offline: 16,
	/** A private session. */
	incognito: 32,
	/**
	 * The first song after a start (see `startTracker`), as the browser told
	 * from the whole export, podcasts included.
	 */
	opener: 64,
	/**
	 * The import told openers apart. Rows from before that rule carry neither
	 * bit, and their early skips all count, in the mix as in the Hörprofil.
	 */
	rated: 128,
} as const;

/** Spotify's `reason_start` for a song that followed on from the one before. */
const FOLLOWED_ON = new Set(["trackdone", "fwdbtn", "backbtn"]);

/** Began by a start, as far as Spotify's `reason_start` tells (unknown: no). */
export const startedAfresh = (reason: string | null | undefined) =>
	!!reason && reason !== "unknown" && !FOLLOWED_ON.has(reason);

/** Silence after which the next song counts as the first of a new start. */
export const OPENER_GAP_MS = 10 * 60_000;

/**
 * The first song after a start: Spotify's shuffle likes to open with the
 * same few songs, and skipping such an opener says little about taste. It
 * began by a start, or nothing played in the ten minutes before it began
 * (or nothing is known before it).
 */
export function isOpener(started: boolean, beganAt: number, previousEnd: number | null): boolean {
	return started || previousEnd === null || beganAt - previousEnd >= OPENER_GAP_MS;
}

/**
 * Tells, entry by entry through one export file (in time order), whether an
 * entry was the first after a start. Every entry keeps the listening going,
 * podcasts too; what came before the file's first entry is not known. The
 * one rule for the mix (`aggregateHistory`) and the Hörprofil (`addListens`):
 * both walk the same file through it, so they always agree.
 */
export function startTracker(): (e: {
	ts?: string;
	ms_played?: number;
	reason_start?: string | null;
}) => boolean {
	let previousEnd: number | null = null;
	return (e) => {
		const at = e.ts ? Date.parse(e.ts) : Number.NaN;
		if (!Number.isFinite(at)) return false;
		const ms = typeof e.ms_played === "number" && e.ms_played > 0 ? e.ms_played : 0;
		const opener = isOpener(startedAfresh(e.reason_start), at - ms, previousEnd);
		previousEnd = at;
		return opener;
	};
}

/** Where it was heard, as far as Spotify's platform text tells. */
export const PLATFORMS = [
	"Sonstiges",
	"iPhone/iPad",
	"Android",
	"Windows",
	"Mac",
	"Linux",
	"Web",
	"Lautsprecher/TV",
	"Auto",
] as const;

export function platformOf(raw: string | null | undefined): number {
	const p = (raw ?? "").toLowerCase();
	if (!p) return 0;
	if (/web_player|web player|webplayer/.test(p)) return 6;
	if (/carplay|android auto|car thing|auto/.test(p)) return 8;
	if (/partner|cast|sonos|speaker|tv|google home|alexa|amazon|echo|playstation|xbox|bose/.test(p))
		return 7;
	if (/ios|iphone|ipad|ipod/.test(p)) return 1;
	if (/android/.test(p)) return 2;
	if (/windows/.test(p)) return 3;
	if (/os x|macos|mac os|osx/.test(p)) return 4;
	if (/linux/.test(p)) return 5;
	return 0;
}

export interface ListenEntry {
	ts?: string;
	ms_played?: number;
	spotify_track_uri?: string | null;
	master_metadata_track_name?: string | null;
	master_metadata_album_artist_name?: string | null;
	master_metadata_album_album_name?: string | null;
	platform?: string | null;
	reason_start?: string | null;
	reason_end?: string | null;
	skipped?: boolean | null;
	shuffle?: boolean | null;
	offline?: boolean | null;
	incognito_mode?: boolean | null;
}

export interface ListenBuilder {
	tracks: ListenTrack[];
	index: Map<TrackId, number>;
	rows: Map<string, ListenRow>;
}

export function newListens(): ListenBuilder {
	return { tracks: [], index: new Map(), rows: new Map() };
}

/** One play as read: its full time (ms), its place in the reading order, its row. */
type Read = [at: number, n: number, row: ListenRow];

/**
 * What the builder read beyond its rows, kept beside it in the browser only
 * (never sent, never stored): the full time of every play, so that
 * `finishListens` cuts by the moment before the rows lose their milliseconds
 * and before the same song in the same second is kept once.
 */
interface Raw {
	/** Plays read so far. */
	n: number;
	/** Every play read, under its row's key, in the order read. */
	plays: Map<string, Read[]>;
	/**
	 * Per song (index into `tracks`), its names as read at its first play and
	 * again at every play earlier than all read before it: [full time, song].
	 */
	songs: Map<number, [number, ListenTrack][]>;
}

const raws = new WeakMap<ListenBuilder, Raw>();

function rawOf(b: ListenBuilder): Raw {
	let raw = raws.get(b);
	if (!raw) {
		raw = { n: 0, plays: new Map(), songs: new Map() };
		raws.set(b, raw);
	}
	return raw;
}

/**
 * Folds one file into the builder: music only (podcasts have no track URI).
 * The same play in two files (an export sent twice) is kept once. Plays
 * under 30 s are kept too: a skip is part of the story. Every entry of the
 * file, podcasts and later plays included, tells which play opened a start.
 */
export function addListens(entries: readonly ListenEntry[], b: ListenBuilder): ListenBuilder {
	const text = (v: string | null | undefined) => (v ?? "").trim().slice(0, 200);
	const raw = rawOf(b);
	const opens = startTracker();
	for (const e of entries) {
		const opener = opens(e);
		const m = /^spotify:track:([A-Za-z0-9]{22})$/.exec(e.spotify_track_uri ?? "");
		const at = e.ts ? Date.parse(e.ts) : Number.NaN;
		if (!m || !Number.isFinite(at) || at <= 0) continue;
		const id = m[1]!;
		const song = (): ListenTrack => [
			id,
			text(e.master_metadata_track_name),
			text(e.master_metadata_album_artist_name),
			text(e.master_metadata_album_album_name),
		];
		let t = b.index.get(id);
		if (t === undefined) {
			t = b.tracks.length;
			b.index.set(id, t);
			const named = song();
			b.tracks.push(named);
			raw.songs.set(t, [[at, named]]);
		} else {
			const names = raw.songs.get(t);
			if (names && at < names.at(-1)![0]) names.push([at, song()]);
		}
		const ms =
			typeof e.ms_played === "number" && e.ms_played > 0
				? Math.min(Math.round(e.ms_played), 24 * 3_600_000)
				: 0;
		const flags =
			(e.skipped === true ? LISTEN_FLAG.skipped : 0) |
			(e.reason_end === "fwdbtn" ? LISTEN_FLAG.forward : 0) |
			(e.reason_end === "trackdone" ? LISTEN_FLAG.done : 0) |
			(e.shuffle === true ? LISTEN_FLAG.shuffle : 0) |
			(e.offline === true ? LISTEN_FLAG.offline : 0) |
			(e.incognito_mode === true ? LISTEN_FLAG.incognito : 0) |
			(opener ? LISTEN_FLAG.opener : 0) |
			LISTEN_FLAG.rated;
		const sec = Math.floor(at / 1000);
		const key = `${sec}:${t}`;
		const row: ListenRow = [sec, t, ms, flags, platformOf(e.platform)];
		b.rows.set(key, row);
		const read: Read = [at, raw.n++, row];
		const same = raw.plays.get(key);
		if (same) same.push(read);
		else raw.plays.set(key, [read]);
	}
	return b;
}

/**
 * The song list and every play, oldest first; with `before`, only the plays
 * whose full time is before then (and only their songs): what came after the
 * first sign-in stays out, as it does in the weighting (`aggregateHistory`).
 * The cut comes first: of the same song in the same second, the last play
 * read before then is kept, in the place of the first, and a song is named as
 * at its first play read before then, so a play left out changes nothing.
 * Without `before`, the last play read of a song in a second is kept, and a
 * song is named as at its first play read. The builder stays as it was.
 */
export function finishListens(
	b: ListenBuilder,
	before: number | null = null,
): { tracks: ListenTrack[]; rows: ListenRow[] } {
	const raw = raws.get(b);
	const kept = (at: number) => before === null || at < before;
	// [row, place among the plays read]; rows not read by addListens, by their whole second.
	const picked: [ListenRow, number][] = [];
	for (const [key, row] of b.rows) {
		const same = raw?.plays.get(key);
		if (!same) {
			if (kept(row[0] * 1000)) picked.push([row, -1]);
			continue;
		}
		let last: Read | undefined;
		let first: number | undefined;
		for (const r of same)
			if (kept(r[0])) {
				last = r;
				first ??= r[1];
			}
		if (last) picked.push([last[2], first!]);
	}
	picked.sort((x, y) => x[0][0] - y[0][0] || x[1] - y[1]);
	const remap = new Map<number, number>();
	const tracks: ListenTrack[] = [];
	const rows = picked.map(([r]): ListenRow => {
		let i = remap.get(r[1]);
		if (i === undefined) {
			i = tracks.length;
			remap.set(r[1], i);
			const names = raw?.songs.get(r[1]);
			tracks.push(names?.find(([at]) => kept(at))?.[1] ?? b.tracks[r[1]]!);
		}
		return [r[0], i, r[2], r[3], r[4]];
	});
	return { tracks, rows };
}

/** A play that counts (as everywhere in true-shuffle: 30 s or more). */
export const countsAsPlay = (r: ListenRow) => r[2] >= PLAY_THRESHOLD_MS;

/** Left within its first 30 s by the listener's own choice. */
export const isEarlySkip = (r: ListenRow) =>
	r[2] < PLAY_THRESHOLD_MS && (r[3] & (LISTEN_FLAG.skipped | LISTEN_FLAG.forward)) !== 0;

/** Upload blocks: the song list first, then the plays. */
export const LISTEN_PAGE = 1000;

export function isListenTrack(v: unknown): v is ListenTrack {
	return (
		Array.isArray(v) &&
		v.length === 4 &&
		typeof v[0] === "string" &&
		/^[A-Za-z0-9]{22}$/.test(v[0]) &&
		v.slice(1).every((s) => typeof s === "string" && s.length <= 200)
	);
}

export function isListenRow(v: unknown, tracks: number, latestSec: number): v is ListenRow {
	const int = (x: unknown, max: number) =>
		typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= max;
	return (
		Array.isArray(v) &&
		v.length === 5 &&
		int(v[0], latestSec) &&
		int(v[1], tracks - 1) &&
		int(v[2], 24 * 3_600_000) &&
		int(v[3], 255) &&
		int(v[4], PLATFORMS.length - 1)
	);
}
