import { describe, expect, it } from "vitest";
import { addToProfile, finishProfile, newProfile } from "../../src/client/history-profile";

const uri = (n: number) => `spotify:track:${String(n).padStart(22, "A")}`;
const entry = (n: number, ts: string, ms: number, artist = "Glasfabrik", extra = {}) => ({
	ts,
	ms_played: ms,
	spotify_track_uri: uri(n),
	master_metadata_track_name: `Song ${n}`,
	master_metadata_album_artist_name: artist,
	...extra,
});

describe("imported history profile", () => {
	it("counts plays of 30 s or more, real listening time, hours, months, tops; skips apart", () => {
		const p = newProfile();
		addToProfile(
			[
				entry(1, "2024-03-01T18:10:00Z", 200_000),
				entry(1, "2024-03-02T18:10:00Z", 100_000),
				entry(2, "2024-04-05T07:00:00Z", 60_000, "Nachtbus"),
				entry(3, "2024-04-05T07:05:00Z", 5_000, "Nachtbus", { reason_end: "fwdbtn" }),
				entry(4, "2024-04-05T07:06:00Z", 10_000, "Nachtbus"),
				{ ts: "2024-04-05T08:00:00Z", ms_played: 900_000, spotify_track_uri: null },
			],
			p,
		);
		const f = finishProfile(p, 1)!;
		expect(f.plays).toBe(3);
		expect(f.minutes).toBe(Math.round(360_000 / 60_000));
		expect(f.earlySkips).toBe(1);
		expect(f.songs).toBe(2);
		expect(f.artists).toBe(2);
		expect(f.hourWeek.reduce((a, b) => a + b, 0)).toBe(3);
		const d = new Date("2024-03-01T18:10:00Z");
		expect(f.hourWeek[((d.getDay() + 6) % 7) * 24 + d.getHours()]).toBeGreaterThanOrEqual(1);
		expect(f.months.map((m) => m.month)).toEqual(["2024-03", "2024-04"].filter(Boolean));
		expect(f.topArtists[0]).toEqual({ name: "Glasfabrik", plays: 2, minutes: 5 });
		expect(f.topSongs[0]).toMatchObject({ name: "Song 1", artist: "Glasfabrik", plays: 2 });
		expect(f.from).toBe(Date.parse("2024-03-01T18:10:00Z"));
	});

	it("is null with nothing counted, and stays within the upload bounds", () => {
		expect(finishProfile(newProfile(), 1)).toBeNull();
		const p = newProfile();
		addToProfile(
			Array.from({ length: 400 }, (_, i) =>
				entry(i, `20${10 + (i % 15)}-0${1 + (i % 9)}-01T12:00:00Z`, 40_000, `A${i}`),
			),
			p,
		);
		const f = finishProfile(p, 1)!;
		expect(f.topArtists.length).toBeLessThanOrEqual(50);
		expect(f.topSongs.length).toBeLessThanOrEqual(50);
		expect(f.months.length).toBeLessThanOrEqual(240);
		expect(f.hourWeek).toHaveLength(168);
	});
});
