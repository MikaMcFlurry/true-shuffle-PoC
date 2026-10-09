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

/**
 * Folds one file into the builder: music only (podcasts have no track URI).
 * The same play in two files (an export sent twice) is kept once. Plays
 * under 30 s are kept too: a skip is part of the story.
 */
export function addListens(entries: readonly ListenEntry[], b: ListenBuilder): ListenBuilder {
	const text = (v: string | null | undefined) => (v ?? "").trim().slice(0, 200);
	const opens = startTracker();
	for (const e of entries) {
		const opener = opens(e);
		const m = /^spotify:track:([A-Za-z0-9]{22})$/.exec(e.spotify_track_uri ?? "");
		const at = e.ts ? Date.parse(e.ts) : Number.NaN;
		if (!m || !Number.isFinite(at) || at <= 0) continue;
		const id = m[1]!;
		let t = b.index.get(id);
		if (t === undefined) {
			t = b.tracks.length;
			b.index.set(id, t);
			b.tracks.push([
				id,
				text(e.master_metadata_track_name),
				text(e.master_metadata_album_artist_name),
				text(e.master_metadata_album_album_name),
			]);
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
		b.rows.set(`${sec}:${t}`, [sec, t, ms, flags, platformOf(e.platform)]);
	}
	return b;
}

/**
 * The song list and every play, oldest first; with `before`, only the plays
 * before then (and only their songs): what came after the first sign-in,
 * true-shuffle counted itself.
 */
export function finishListens(
	b: ListenBuilder,
	before: number | null = null,
): { tracks: ListenTrack[]; rows: ListenRow[] } {
	const rows = [...b.rows.values()]
		.filter((r) => before === null || r[0] * 1000 < before)
		.sort((x, y) => x[0] - y[0]);
	const remap = new Map<number, number>();
	const tracks: ListenTrack[] = [];
	for (const r of rows) {
		let i = remap.get(r[1]);
		if (i === undefined) {
			i = tracks.length;
			remap.set(r[1], i);
			tracks.push(b.tracks[r[1]]!);
		}
		r[1] = i;
	}
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
