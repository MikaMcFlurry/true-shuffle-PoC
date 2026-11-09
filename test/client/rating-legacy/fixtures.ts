/**
 * Synthetic answers for the legacy read tests: one account, two songs, a
 * write number (`rated`) only where a case gives one. Nothing here talks to a
 * server; the snapshot and Verlauf answers are built and handed in by hand.
 */
import type { AppState, HistoryEntry, TrackView } from "../../../src/shared/api";

export type Thumb = -1 | 0 | 1;

export const ACCOUNT = "listener-a";
export const X = "track-x";
export const Y = "track-y";

export const track = (id: string, thumb: Thumb, rated?: number): TrackView => ({
	id,
	name: id,
	artists: "Test Artist",
	album: "Test Album",
	imageUrl: null,
	durationMs: 180_000,
	thumb,
	...(rated === undefined ? {} : { rated }),
});

/** A Verlauf row; `rated` absent is an older answer, `rated: 0` is a write number. */
export const row = (id: string, thumb: Thumb, rated?: number): HistoryEntry => ({
	...track(id, thumb, rated),
	playedAt: 1,
	stationName: null,
	ignored: false,
});

let serverTime = 100;

/** A snapshot of the one account with these songs queued, as the hub would answer it. */
export const snap = (songs: TrackView[]): AppState => ({
	profile: { id: ACCOUNT, name: ACCOUNT, imageUrl: null },
	onboarded: true,
	stations: [],
	session: {
		sessionId: "S",
		stationId: 1,
		entryId: "S:0",
		orderRevision: 1,
		progressMs: 0,
		observedAt: 100,
		status: "active",
		pending: false,
		queue: songs.map((t, i) => ({ entryId: `S:${i}`, track: t })),
	},
	nowPlaying: null,
	guest: { active: false, until: null },
	warnings: [],
	jobs: [],
	history: { importedTracks: 0, importedAt: null, liveSince: null },
	aiSource: "off",
	serverTime: ++serverTime,
});
