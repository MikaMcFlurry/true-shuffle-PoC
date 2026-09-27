/**
 * Spotify "Extended streaming history" import.
 *
 * The export (Streaming_History_Audio_*.json) is parsed in the browser, so a
 * 100 000-play history never has to travel to — or be parsed by — the
 * server. Only the aggregate per track is uploaded.
 *
 * The older "Account data" export (StreamingHistory_music_*.json) has no
 * track URIs and cannot be matched reliably; it is recognised and refused
 * with an explanation instead of being guessed at.
 */

import type { ImportedStats } from "./memory";
import { PLAY_THRESHOLD_MS, type TrackId } from "./types";

export interface ExtendedEntry {
	ts?: string;
	ms_played?: number;
	spotify_track_uri?: string | null;
	reason_end?: string | null;
	skipped?: boolean | null;
}

export type HistoryFileKind = "extended" | "account" | "unknown";

export function detectHistoryFile(data: unknown): HistoryFileKind {
	if (!Array.isArray(data) || data.length === 0) return "unknown";
	const first = data[0] as Record<string, unknown>;
	if (first && typeof first === "object") {
		if ("spotify_track_uri" in first || "ms_played" in first) return "extended";
		if ("msPlayed" in first && "trackName" in first) return "account";
	}
	return "unknown";
}

export function trackIdFromUri(uri: string | null | undefined): TrackId | null {
	if (!uri) return null;
	const m = /^spotify:track:([A-Za-z0-9]{22})$/.exec(uri);
	return m ? m[1]! : null;
}

export interface Aggregate {
	stats: Map<TrackId, ImportedStats>;
	entries: number;
	counted: number;
	skipped: number;
	ignored: number;
	firstAt: number | null;
	lastAt: number | null;
}

export function emptyAggregate(): Aggregate {
	return {
		stats: new Map(),
		entries: 0,
		counted: 0,
		skipped: 0,
		ignored: 0,
		firstAt: null,
		lastAt: null,
	};
}

/**
 * Fold one file's entries into the aggregate. A play is >= 30 s (Spotify's
 * own stream rule); an early skip is < 30 s ended by the forward button or
 * flagged `skipped`. Everything else (errors, logouts, podcasts) is ignored.
 */
export function aggregateHistory(
	entries: readonly ExtendedEntry[],
	agg: Aggregate = emptyAggregate(),
	/** Only listening before this time counts: after it, true-shuffle counted live. */
	opts: { before?: number | null } = {},
): Aggregate {
	for (const e of entries) {
		agg.entries++;
		const id = trackIdFromUri(e.spotify_track_uri ?? null);
		const at = e.ts ? Date.parse(e.ts) : Number.NaN;
		if (!id || !Number.isFinite(at) || (opts.before != null && at >= opts.before)) {
			agg.ignored++;
			continue;
		}
		const ms = typeof e.ms_played === "number" ? e.ms_played : 0;
		let s = agg.stats.get(id);
		if (ms >= PLAY_THRESHOLD_MS) {
			if (!s) {
				s = { plays: 0, earlySkips: 0, lastPlayedAt: null };
				agg.stats.set(id, s);
			}
			s.plays++;
			s.lastPlayedAt = s.lastPlayedAt === null ? at : Math.max(s.lastPlayedAt, at);
			agg.counted++;
		} else if (e.reason_end === "fwdbtn" || e.skipped === true) {
			if (!s) {
				s = { plays: 0, earlySkips: 0, lastPlayedAt: null };
				agg.stats.set(id, s);
			}
			s.earlySkips++;
			agg.skipped++;
		} else {
			agg.ignored++;
			continue;
		}
		agg.firstAt = agg.firstAt === null ? at : Math.min(agg.firstAt, at);
		agg.lastAt = agg.lastAt === null ? at : Math.max(agg.lastAt, at);
	}
	return agg;
}

/** Compact wire format: [id, plays, earlySkips, lastPlayedAt|0]. */
export type HistoryRow = [TrackId, number, number, number];

export function toRows(agg: Aggregate): HistoryRow[] {
	const rows: HistoryRow[] = [];
	for (const [id, s] of agg.stats) rows.push([id, s.plays, s.earlySkips, s.lastPlayedAt ?? 0]);
	return rows;
}

export function fromRow(row: HistoryRow): [TrackId, ImportedStats] {
	return [row[0], { plays: row[1], earlySkips: row[2], lastPlayedAt: row[3] > 0 ? row[3] : null }];
}
