import { describe, expect, it } from "vitest";
import {
	addListens,
	finishListens,
	isEarlySkip,
	isListenRow,
	LISTEN_FLAG,
	newListens,
	platformOf,
} from "../../src/core/listens";
import { type ListenEvent, localTimes, periodProfile } from "../../src/core/period-profile";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../src/core/types";

const T0 = Date.UTC(2024, 0, 1, 12); // a Monday, noon UTC

function ev(
	at: number,
	song: string,
	artist: string,
	over: Partial<ListenEvent> = {},
): ListenEvent {
	return {
		at,
		song,
		name: song,
		artist,
		album: `${artist} Album`,
		ms: 200_000,
		exact: true,
		play: true,
		earlySkip: false,
		opener: false,
		platform: 1,
		shuffle: false,
		offline: false,
		imageUrl: null,
		...over,
	};
}

const utc = localTimes("UTC");

describe("period profile", () => {
	it("counts only the window and compares with the same length before", () => {
		const events = [
			ev(T0 - 10 * DAY_MS, "a", "A"),
			ev(T0 - 3 * DAY_MS, "a", "A"),
			ev(T0 + 1 * DAY_MS, "b", "B"),
			ev(T0 + 2 * DAY_MS, "b", "B"),
			ev(T0 + 3 * DAY_MS, "c", "B"),
			ev(T0 + 9 * DAY_MS, "d", "D"),
		];
		const p = periodProfile(events, { from: T0, to: T0 + 7 * DAY_MS }, utc);
		expect(p).toMatchObject({ plays: 3, songs: 2, artists: 1, activeDays: 3, days: 7 });
		expect(p.previous).toEqual({ plays: 1, minutes: Math.round(200_000 / 60_000) });
		expect(p.topArtists[0]).toMatchObject({ name: "B", plays: 3, minutes: 10 });
		expect(p.series.unit).toBe("day");
		expect(p.series.points.map((x) => x.key)).toEqual(["2024-01-02", "2024-01-03", "2024-01-04"]);
		expect(p.years).toEqual([2023, 2024]);
		const all = periodProfile(events, { from: null, to: T0 + 30 * DAY_MS }, utc);
		expect(all.plays).toBe(6);
		expect(all.previous).toBeNull();
	});

	it("chooses days, weeks or months for the series by the length shown", () => {
		const events = Array.from({ length: 400 }, (_, i) => ev(T0 + i * DAY_MS, `s${i}`, "A"));
		const w = periodProfile(events, { from: T0, to: T0 + 120 * DAY_MS }, utc);
		expect(w.series.unit).toBe("week");
		// Weeks start on Monday: 2024-01-01 is one.
		expect(w.series.points[0]).toMatchObject({ key: "2024-01-01", plays: 7 });
		const m = periodProfile(events, { from: null, to: T0 + 500 * DAY_MS }, utc);
		expect(m.series.unit).toBe("month");
		expect(m.series.points[0]).toMatchObject({ key: "2024-01", plays: 31 });
	});

	it("buckets by the listener's zone across a change to summer time", () => {
		const berlin = localTimes("Europe/Berlin");
		// 2024-03-31 01:30 UTC is 03:30 summer time in Berlin; an hour before, 01:30 winter time.
		expect(berlin(Date.UTC(2024, 2, 31, 1, 30))).toMatchObject({ hour: 3, weekday: 6, date: 31 });
		expect(berlin(Date.UTC(2024, 2, 31, 0, 30))).toMatchObject({ hour: 1, weekday: 6 });
		// Late on a Sunday in UTC is already Monday in Berlin.
		const p = periodProfile(
			[ev(Date.UTC(2024, 0, 7, 23, 30), "a", "A")],
			{ from: null, to: T0 + DAY_MS * 30 },
			berlin,
		);
		expect(p.hourWeek[0 * 24 + 0]).toBe(1);
	});

	it("finds the longest streak of days and the longest session without a gap", () => {
		const events = [
			// Three days in a row, then a gap, then two.
			...[0, 1, 2, 5, 6].map((d) => ev(T0 + d * DAY_MS, `s${d}`, "A")),
			// A session: five songs back to back, then one 20 minutes later.
			...[0, 1, 2, 3, 4].map((i) => ev(T0 + 2 * HOUR_MS + i * 200_000, `x${i}`, "B")),
			ev(T0 + 2 * HOUR_MS + 4 * 200_000 + 20 * MINUTE_MS, "y", "B"),
		].sort((a, b) => a.at - b.at);
		const p = periodProfile(events, { from: null, to: T0 + 30 * DAY_MS }, utc);
		expect(p.streak).toEqual({ days: 3, from: "2024-01-01", to: "2024-01-03" });
		expect(p.longestSession).toEqual({
			minutes: Math.round((5 * 200_000) / 60_000),
			at: T0 + 2 * HOUR_MS - 200_000,
		});
	});

	it("tells first-time songs and artists, and songs back after a year", () => {
		const events = [
			ev(T0 - 400 * DAY_MS, "old", "Old"),
			ev(T0 - 5 * DAY_MS, "known", "Known"),
			ev(T0 + DAY_MS, "old", "Old"),
			ev(T0 + DAY_MS, "known", "Known"),
			ev(T0 + 2 * DAY_MS, "new", "Fresh"),
			ev(T0 + 3 * DAY_MS, "new", "Fresh"),
		].sort((a, b) => a.at - b.at);
		const p = periodProfile(events, { from: T0, to: T0 + 7 * DAY_MS }, utc);
		expect(p.newSongs).toBe(1);
		expect(p.newArtists).toBe(1);
		expect(p.topNewArtists.map((x) => x.name)).toEqual(["Fresh"]);
		expect(p.comebacks).toEqual([expect.objectContaining({ name: "old", gapDays: 401 })]);
	});

	it("skips, devices and shuffle come from imported plays only, and say so", () => {
		const live = [ev(T0, "a", "A", { exact: false, platform: null, shuffle: null, offline: null })];
		const p = periodProfile(live, { from: null, to: T0 + DAY_MS }, utc);
		expect(p.skips).toBeNull();
		expect(p.platforms).toEqual([]);
		expect(p.shuffleShare).toBeNull();
		expect(p.minutesExact).toBe(false);
		const imported = [
			ev(T0, "a", "A", { platform: 2, shuffle: true }),
			ev(T0 + MINUTE_MS, "b", "A", { play: false, earlySkip: true, ms: 4_000 }),
			ev(T0 + 2 * MINUTE_MS, "b", "A", { play: false, earlySkip: true, ms: 4_000 }),
		];
		const q = periodProfile(imported, { from: null, to: T0 + DAY_MS }, utc);
		expect(q.plays).toBe(1);
		expect(q.skips).toMatchObject({ early: 2, share: 2 / 3, openers: 0 });
		expect(q.platforms).toEqual([{ name: "Android", plays: 1 }]);
		expect(q.shuffleShare).toBe(1);
	});

	it("an early skip of the first song after a start is told apart, not counted as early", () => {
		const skip = { play: false, earlySkip: true, ms: 4_000 };
		const events = [
			ev(T0, "opener", "A", { ...skip, opener: true }),
			ev(T0 + MINUTE_MS, "a", "A"),
			ev(T0 + 2 * MINUTE_MS, "b", "B", skip),
			ev(T0 + DAY_MS, "opener", "A", { ...skip, opener: true }),
			ev(T0 + DAY_MS + MINUTE_MS, "a", "A"),
		];
		const p = periodProfile(events, { from: null, to: T0 + 2 * DAY_MS }, utc);
		expect(p.skips).toMatchObject({ early: 1, share: 1 / 3, openers: 2 });
		expect(p.skips!.top.map((x) => x.name)).toEqual(["b"]);
		expect(p.skips!.topOpeners).toMatchObject([{ name: "opener", plays: 2 }]);
		// Only openers: the section still tells them, with no early share.
		const only = periodProfile([events[0]!], { from: null, to: T0 + DAY_MS }, utc);
		expect(only.skips).toMatchObject({ early: 0, share: 0, openers: 1 });
	});
});

describe("calendar edges (PR26-PROFILE-DST-04, previous year)", () => {
	it("a week starts on the local Monday also across the end of summer time", () => {
		const berlin = localTimes("Europe/Berlin");
		// Monday 19 Oct 2026 noon, and Sunday 25 Oct 23:30 local (after the change back).
		const events = [
			ev(Date.UTC(2026, 9, 19, 10), "a", "A"),
			ev(Date.UTC(2026, 9, 25, 22, 30), "b", "B"),
		];
		const p = periodProfile(
			events,
			{ from: Date.UTC(2026, 6, 31, 22), to: Date.UTC(2026, 9, 31, 23) },
			berlin,
		);
		expect(p.series.unit).toBe("week");
		expect(p.series.points).toEqual([{ key: "2026-10-19", plays: 2, minutes: 7 }]);
		// And at the start of summer time: Sunday 29 March 23:30 belongs to Monday 23 March.
		const spring = periodProfile(
			[ev(Date.UTC(2026, 2, 23, 10), "a", "A"), ev(Date.UTC(2026, 2, 29, 21, 30), "b", "B")],
			{ from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 4, 1) },
			berlin,
		);
		expect(spring.series.points.map((x) => x.key)).toEqual(["2026-03-23"]);
	});

	it("a calendar year is compared with the calendar year before, leap years included", () => {
		const events = [
			ev(Date.UTC(2022, 11, 31, 12), "a", "A"),
			ev(Date.UTC(2023, 0, 1, 12), "b", "A"),
		];
		const p = periodProfile(
			events,
			{ from: Date.UTC(2024, 0, 1), to: Date.UTC(2025, 0, 1), previousFrom: Date.UTC(2023, 0, 1) },
			utc,
		);
		expect(p.previous).toEqual({ plays: 1, minutes: 3 });
		// Without a start given, the same length right before (here: 366 days).
		const q = periodProfile(events, { from: Date.UTC(2024, 0, 1), to: Date.UTC(2025, 0, 1) }, utc);
		expect(q.previous?.plays).toBe(2);
	});

	it("a session takes songs with gaps under ten minutes; its minutes are only what was heard", () => {
		const events = [
			ev(T0 + 30 * MINUTE_MS, "a", "A", { ms: 30 * MINUTE_MS }),
			ev(T0 + 69 * MINUTE_MS, "b", "A", { ms: 30 * MINUTE_MS }),
			ev(T0 + 130 * MINUTE_MS, "c", "A", { ms: 30 * MINUTE_MS }),
		];
		const p = periodProfile(events, { from: null, to: T0 + DAY_MS }, utc);
		// 9 minutes between the first two: one session of 60 heard minutes; 31 before the third.
		expect(p.longestSession).toEqual({ minutes: 60, at: T0 });
	});
});

describe("imported plays in the browser", () => {
	it("keep every music play once, with flags, platform and its song", () => {
		const b = newListens();
		const entry = {
			ts: "2024-01-01T12:00:00Z",
			ms_played: 123_456,
			spotify_track_uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
			master_metadata_track_name: "Song",
			master_metadata_album_artist_name: "Artist",
			master_metadata_album_album_name: "Album",
			platform: "iOS 17.2 (iPhone15,2)",
			reason_end: "fwdbtn",
			skipped: true,
			shuffle: true,
		};
		addListens([entry, { ...entry }], b);
		// The same play in a second file is one play.
		addListens(
			[entry, { ...entry, spotify_episode_uri: "x", spotify_track_uri: null }] as never,
			b,
		);
		const { tracks, rows } = finishListens(b);
		expect(tracks).toEqual([["4uLU6hMCjMI75M1A2tKUQC", "Song", "Artist", "Album"]]);
		expect(rows).toEqual([
			[
				Date.UTC(2024, 0, 1, 12) / 1000,
				0,
				123_456,
				// First in its file: nothing known before it, so the first after a start.
				LISTEN_FLAG.skipped |
					LISTEN_FLAG.forward |
					LISTEN_FLAG.shuffle |
					LISTEN_FLAG.opener |
					LISTEN_FLAG.rated,
				1,
			],
		]);
		expect(isEarlySkip([0, 0, 10_000, LISTEN_FLAG.forward, 0])).toBe(true);
		expect(isEarlySkip([0, 0, 10_000, LISTEN_FLAG.done, 0])).toBe(false);
	});

	it("name the device from Spotify's platform text", () => {
		expect(platformOf("Android OS 13 API 33 (Google, Pixel 7)")).toBe(2);
		expect(platformOf("Windows 10 (10.0.19045; x64)")).toBe(3);
		expect(platformOf("OS X 14.1.0 [arm 2]")).toBe(4);
		expect(platformOf("web_player windows 10;chrome 120.0")).toBe(6);
		expect(platformOf("Partner sonos_s22")).toBe(7);
		expect(platformOf(null)).toBe(0);
	});

	it("rows the server takes: bounded and pointing into the song list", () => {
		expect(isListenRow([1_700_000_000, 0, 1000, 0, 0], 1, 1_800_000_000)).toBe(true);
		expect(isListenRow([1_700_000_000, 1, 1000, 0, 0], 1, 1_800_000_000)).toBe(false);
		expect(isListenRow([1_900_000_000, 0, 1000, 0, 0], 1, 1_800_000_000)).toBe(false);
		expect(isListenRow([1_700_000_000, 0, 1000, 255, 0], 1, 1_800_000_000)).toBe(true);
		expect(isListenRow([1_700_000_000, 0, 1000, 256, 0], 1, 1_800_000_000)).toBe(false);
		expect(isListenRow([1_700_000_000, 0, 1000, 0, 99], 1, 1_800_000_000)).toBe(false);
	});
});
