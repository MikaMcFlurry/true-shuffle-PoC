/**
 * The Hörprofil of one period: everything the listener's timeline says about
 * those days (see `ListeningProfile`). Pure — the hub hands in the timeline,
 * oldest first: imported plays up to the first sign-in, true-shuffle's own
 * count from then on, so nothing is counted twice.
 */

import type { ListeningProfile, ProfileItem } from "../shared/api";
import { PLATFORMS } from "./listens";
import { FAMILIAR_PLAYS } from "./memory";
import { DAY_MS } from "./types";

export interface ListenEvent {
	/** When it ended (ms). */
	at: number;
	song: string;
	name: string;
	/** Its (first) artist. */
	artist: string;
	album: string | null;
	/** Heard: exact from an import, the song's length for a play counted live. */
	ms: number;
	exact: boolean;
	/** 30 s or more: a play. Otherwise only an early skip is of interest. */
	play: boolean;
	earlySkip: boolean;
	/**
	 * An early skip of the first song after a start (see `isOpener`): told
	 * apart, since Spotify's shuffle opens with the same few songs.
	 */
	opener: boolean;
	/**
	 * An imported row that tells openers apart (see core/listens): only then
	 * is a skip judged overplayed, as the mix does from the same import.
	 */
	rated: boolean;
	/** From an import only. */
	platform: number | null;
	shuffle: boolean | null;
	offline: boolean | null;
	imageUrl: string | null;
}

/** Local calendar position of a moment: days since 1970, Monday-first weekday, hour, date. */
export interface LocalTime {
	day: number;
	weekday: number;
	hour: number;
	year: number;
	month: number;
	date: number;
}

/** Local time in a zone, the zone's offset looked up once per hour. */
export function localTimes(zone: string): (at: number) => LocalTime {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		hourCycle: "h23",
	});
	const offsets = new Map<number, number>();
	const offsetAt = (at: number) => {
		const hour = Math.floor(at / 3_600_000);
		let off = offsets.get(hour);
		if (off === undefined) {
			const base = hour * 3_600_000;
			const p = Object.fromEntries(fmt.formatToParts(new Date(base)).map((x) => [x.type, x.value]));
			off =
				Date.UTC(
					Number(p.year),
					Number(p.month) - 1,
					Number(p.day),
					Number(p.hour),
					Number(p.minute),
				) - base;
			offsets.set(hour, off);
		}
		return off;
	};
	return (at) => {
		const d = new Date(at + offsetAt(at));
		return {
			day: Math.floor((at + offsetAt(at)) / DAY_MS),
			weekday: (d.getUTCDay() + 6) % 7,
			hour: d.getUTCHours(),
			year: d.getUTCFullYear(),
			month: d.getUTCMonth() + 1,
			date: d.getUTCDate(),
		};
	};
}

const SESSION_GAP_MS = 10 * 60_000;
const COMEBACK_MS = 365 * DAY_MS;

type Stats = Omit<
	ListeningProfile,
	"genres" | "canEstimate" | "genresRetryAt" | "learned" | "coverage" | "edition"
>;

/** A key for a calendar day (YYYY-MM-DD) or month (YYYY-MM). */
const dayKey = (t: LocalTime) =>
	`${t.year}-${String(t.month).padStart(2, "0")}-${String(t.date).padStart(2, "0")}`;
const monthKey = (t: LocalTime) => `${t.year}-${String(t.month).padStart(2, "0")}`;
/** The key of a local calendar day by its number (days since 1970): no clock hours involved. */
const dayIndexKey = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

export function periodProfile(
	/** Oldest first; a function to walk a large timeline without holding it (walked twice). */
	events: Iterable<ListenEvent> | (() => Iterable<ListenEvent>),
	period: { from: number | null; to: number; previousFrom?: number | null },
	local: (at: number) => LocalTime,
): Stats {
	const { from, to } = period;
	const inWindow = (at: number) => (from === null || at >= from) && at < to;
	const span = from === null ? null : to - from;
	// What it is compared with: the given start (a calendar year: the year
	// before, however long), else the same length right before.
	const previousFrom =
		from === null ? null : (period.previousFrom ?? (span === null ? null : from - span));
	// The unit of the series follows the length of what is shown.
	const each = typeof events === "function" ? events : () => events;
	let first: number | null = null;
	for (const e of each())
		if (e.play && inWindow(e.at)) {
			first = e.at;
			break;
		}
	const shownSpan = to - (from ?? first ?? to);
	const unit: "day" | "week" | "month" =
		shownSpan <= 45 * DAY_MS ? "day" : shownSpan <= 190 * DAY_MS ? "week" : "month";

	const hourWeek = new Array<number>(168).fill(0);
	const series = new Map<string, { plays: number; minutes: number }>();
	const songs = new Map<string, ProfileItem & { ms: number }>();
	const artists = new Map<string, ProfileItem & { ms: number }>();
	const albums = new Map<string, ProfileItem & { ms: number }>();
	const skipped = new Map<string, ProfileItem & { ms: number }>();
	const opened = new Map<string, ProfileItem & { ms: number }>();
	const tired = new Map<string, ProfileItem & { ms: number }>();
	// Per song: plays before its first early skip, and whether that made it overplayed.
	const playsBefore = new Map<string, number>();
	const overplayed = new Map<string, boolean>();
	const firstSong = new Map<string, number>();
	const firstArtist = new Map<string, number>();
	const lastSong = new Map<string, number>();
	const comebacks = new Map<string, number>();
	const days = new Map<number, string>();
	const seenInWindow = new Set<string>();
	const years = new Set<number>();
	const platforms = new Array<number>(PLATFORMS.length).fill(0);
	let plays = 0;
	let ms = 0;
	let exact = true;
	let last: number | null = null;
	let early = 0;
	let openers = 0;
	let overplayedSkips = 0;
	let importedPlays = 0;
	let shuffled = 0;
	let offline = 0;
	let prevPlays = 0;
	let prevMs = 0;
	let session = { ms: 0, at: 0, end: Number.NEGATIVE_INFINITY };
	let longest: { ms: number; at: number } | null = null;

	const bump = (
		map: Map<string, ProfileItem & { ms: number }>,
		key: string,
		item: () => ProfileItem,
		e: ListenEvent,
	) => {
		const x = map.get(key) ?? { ...item(), ms: 0 };
		x.plays++;
		x.ms += e.ms;
		if (!x.imageUrl && e.imageUrl) x.imageUrl = e.imageUrl;
		map.set(key, x);
	};

	for (const e of each()) {
		const artistKey = e.artist.toLowerCase();
		// As core/memory isOverplayed and core/history playedBeforeSkips, over the whole timeline.
		if (e.play && !overplayed.has(e.song))
			playsBefore.set(e.song, (playsBefore.get(e.song) ?? 0) + 1);
		else if (e.earlySkip && e.rated && !e.opener && !overplayed.has(e.song))
			overplayed.set(e.song, (playsBefore.get(e.song) ?? 0) >= FAMILIAR_PLAYS);
		if (e.play) {
			const t = local(e.at);
			years.add(t.year);
			if (!firstSong.has(e.song)) firstSong.set(e.song, e.at);
			if (artistKey && !firstArtist.has(artistKey)) firstArtist.set(artistKey, e.at);
		}
		if (previousFrom !== null && from !== null && e.play && e.at >= previousFrom && e.at < from) {
			prevPlays++;
			prevMs += e.ms;
		}
		if (!inWindow(e.at)) {
			if (e.play) lastSong.set(e.song, e.at);
			continue;
		}
		if (!e.play) {
			if (e.earlySkip) {
				const tiredOf = !e.opener && overplayed.get(e.song) === true;
				if (e.opener) openers++;
				else if (tiredOf) overplayedSkips++;
				else early++;
				bump(
					e.opener ? opened : tiredOf ? tired : skipped,
					e.song,
					() => ({ id: e.song, name: e.name, sub: e.artist, plays: 0, minutes: 0, imageUrl: null }),
					e,
				);
			}
			continue;
		}
		const t = local(e.at);
		plays++;
		ms += e.ms;
		if (!e.exact) exact = false;
		last = e.at;
		days.set(t.day, dayKey(t));
		hourWeek[t.weekday * 24 + t.hour]!++;
		const key =
			unit === "month" ? monthKey(t) : unit === "week" ? dayIndexKey(t.day - t.weekday) : dayKey(t);
		const s = series.get(key) ?? { plays: 0, minutes: 0 };
		s.plays++;
		s.minutes += e.ms / 60_000;
		series.set(key, s);
		bump(
			songs,
			e.song,
			() => ({ id: e.song, name: e.name, sub: e.artist, plays: 0, minutes: 0, imageUrl: null }),
			e,
		);
		if (artistKey)
			bump(
				artists,
				artistKey,
				() => ({ name: e.artist, sub: "", plays: 0, minutes: 0, imageUrl: null }),
				e,
			);
		if (e.album)
			bump(
				albums,
				`${e.album.toLowerCase()}\u0000${artistKey}`,
				() => ({ name: e.album!, sub: e.artist, plays: 0, minutes: 0, imageUrl: null }),
				e,
			);
		// Back after a year or more without it.
		const before = lastSong.get(e.song);
		if (before !== undefined && !seenInWindow.has(e.song) && e.at - before >= COMEBACK_MS)
			comebacks.set(e.song, Math.floor((e.at - before) / DAY_MS));
		seenInWindow.add(e.song);
		lastSong.set(e.song, e.at);
		if (e.exact && e.platform !== null) {
			importedPlays++;
			platforms[e.platform]!++;
			if (e.shuffle) shuffled++;
			if (e.offline) offline++;
		}
		// One session: each song began no more than ten minutes after the one before ended.
		if (e.at - e.ms <= session.end + SESSION_GAP_MS) session.ms += e.ms;
		else session = { ms: e.ms, at: e.at - e.ms, end: e.at };
		session.end = e.at;
		if (!longest || session.ms > longest.ms) longest = { ms: session.ms, at: session.at };
	}

	const finish = (x: ProfileItem & { ms: number }): ProfileItem => {
		const { ms: heard, ...rest } = x;
		return { ...rest, minutes: Math.round(heard / 60_000) };
	};
	const byPlays = (a: { plays: number; ms: number }, b: { plays: number; ms: number }) =>
		b.plays - a.plays || b.ms - a.ms;
	const byTime = (a: { plays: number; ms: number }, b: { plays: number; ms: number }) =>
		b.ms - a.ms || b.plays - a.plays;

	// The longest run of days in a row with music.
	const sorted = [...days.keys()].sort((a, b) => a - b);
	let streak: { days: number; from: string; to: string } | null = null;
	for (let i = 0, start = 0; i < sorted.length; i++) {
		if (i > 0 && sorted[i]! !== sorted[i - 1]! + 1) start = i;
		const len = i - start + 1;
		if (!streak || len > streak.days)
			streak = { days: len, from: days.get(sorted[start]!)!, to: days.get(sorted[i]!)! };
	}

	const newArtists = [...artists.entries()].filter(([k]) => {
		const f = firstArtist.get(k);
		return f !== undefined && inWindow(f);
	});
	const share = (n: number) => (importedPlays > 0 ? n / importedPlays : null);
	return {
		period: { from, to },
		years: [...years].sort((a, b) => a - b),
		first,
		last,
		plays,
		minutes: Math.round(ms / 60_000),
		minutesExact: exact,
		songs: songs.size,
		artists: artists.size,
		albums: albums.size,
		activeDays: days.size,
		days: Math.max(1, Math.round(shownSpan / DAY_MS)),
		previous:
			previousFrom === null ? null : { plays: prevPlays, minutes: Math.round(prevMs / 60_000) },
		hourWeek,
		series: {
			unit,
			points: [...series.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, v]) => ({ key, plays: v.plays, minutes: Math.round(v.minutes) })),
		},
		topArtists: [...artists.values()].sort(byTime).slice(0, 50).map(finish),
		topSongs: [...songs.values()].sort(byPlays).slice(0, 20).map(finish),
		topAlbums: [...albums.values()].sort(byTime).slice(0, 10).map(finish),
		skips:
			importedPlays + early + openers + overplayedSkips > 0
				? {
						early,
						share: early + importedPlays > 0 ? early / (early + importedPlays) : 0,
						top: [...skipped.values()].sort(byPlays).slice(0, 10).map(finish),
						openers,
						topOpeners: [...opened.values()].sort(byPlays).slice(0, 10).map(finish),
						overplayed: overplayedSkips,
						topOverplayed: [...tired.values()].sort(byPlays).slice(0, 10).map(finish),
					}
				: null,
		newSongs: [...songs.keys()].filter((k) => {
			const f = firstSong.get(k);
			return f !== undefined && inWindow(f);
		}).length,
		newArtists: newArtists.length,
		topNewArtists: newArtists
			.map(([, v]) => v)
			.sort(byTime)
			.slice(0, 10)
			.map(finish),
		comebacks: [...comebacks.entries()]
			.map(([id, gapDays]) => ({ ...finish(songs.get(id)!), gapDays }))
			.sort((a, b) => b.plays - a.plays || b.gapDays - a.gapDays)
			.slice(0, 10),
		streak,
		longestSession: longest ? { minutes: Math.round(longest.ms / 60_000), at: longest.at } : null,
		platforms: platforms
			.map((n, i) => ({ name: PLATFORMS[i]!, plays: n }))
			.filter((p) => p.plays > 0)
			.sort((a, b) => b.plays - a.plays),
		shuffleShare: share(shuffled),
		offlineShare: share(offline),
	};
}
