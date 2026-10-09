/**
 * Builds an `ImportedProfile` from Spotify's extended streaming history files
 * in the browser: hours, months, top artists and songs. Only this summary is
 * uploaded; the files stay on the device.
 */

import { PLAY_THRESHOLD_MS } from "../core/types";
import type { ImportedProfile } from "../shared/api";

export interface ProfileEntry {
	ts?: string;
	ms_played?: number;
	spotify_track_uri?: string | null;
	master_metadata_track_name?: string | null;
	master_metadata_album_artist_name?: string | null;
	reason_end?: string | null;
	skipped?: boolean | null;
}

export interface ProfileBuilder {
	from: number | null;
	to: number | null;
	plays: number;
	ms: number;
	earlySkips: number;
	hourWeek: number[];
	months: Map<string, { plays: number; ms: number }>;
	artists: Map<string, { plays: number; ms: number }>;
	songs: Map<string, { name: string; artist: string; plays: number }>;
}

export function newProfile(): ProfileBuilder {
	return {
		from: null,
		to: null,
		plays: 0,
		ms: 0,
		earlySkips: 0,
		hourWeek: new Array<number>(168).fill(0),
		months: new Map(),
		artists: new Map(),
		songs: new Map(),
	};
}

/** Folds one file into the profile; music only (podcasts have no track URI). */
export function addToProfile(entries: readonly ProfileEntry[], p: ProfileBuilder): ProfileBuilder {
	for (const e of entries) {
		const m = /^spotify:track:([A-Za-z0-9]{22})$/.exec(e.spotify_track_uri ?? "");
		const at = e.ts ? Date.parse(e.ts) : Number.NaN;
		if (!m || !Number.isFinite(at)) continue;
		const ms = typeof e.ms_played === "number" && e.ms_played > 0 ? e.ms_played : 0;
		if (ms < PLAY_THRESHOLD_MS) {
			if (e.reason_end === "fwdbtn" || e.skipped === true) p.earlySkips++;
			continue;
		}
		const id = m[1]!;
		const d = new Date(at);
		p.plays++;
		p.ms += ms;
		p.from = p.from === null ? at : Math.min(p.from, at);
		p.to = p.to === null ? at : Math.max(p.to, at);
		p.hourWeek[((d.getDay() + 6) % 7) * 24 + d.getHours()]!++;
		const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
		const mo = p.months.get(month) ?? { plays: 0, ms: 0 };
		mo.plays++;
		mo.ms += ms;
		p.months.set(month, mo);
		const artist = (e.master_metadata_album_artist_name ?? "").trim();
		if (artist) {
			const a = p.artists.get(artist) ?? { plays: 0, ms: 0 };
			a.plays++;
			a.ms += ms;
			p.artists.set(artist, a);
		}
		const s = p.songs.get(id) ?? {
			name: (e.master_metadata_track_name ?? "").trim().slice(0, 200),
			artist: artist.slice(0, 200),
			plays: 0,
		};
		s.plays++;
		p.songs.set(id, s);
	}
	return p;
}

export function finishProfile(p: ProfileBuilder, at: number): ImportedProfile | null {
	if (p.plays === 0 || p.from === null || p.to === null) return null;
	const minutes = (ms: number) => Math.round(ms / 60_000);
	return {
		at,
		from: p.from,
		to: p.to,
		plays: p.plays,
		minutes: minutes(p.ms),
		songs: p.songs.size,
		artists: p.artists.size,
		earlySkips: p.earlySkips,
		hourWeek: p.hourWeek,
		months: [...p.months.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.slice(-240)
			.map(([month, v]) => ({ month, plays: v.plays, minutes: minutes(v.ms) })),
		topArtists: [...p.artists.entries()]
			.sort((a, b) => b[1].ms - a[1].ms)
			.slice(0, 50)
			.map(([name, v]) => ({ name: name.slice(0, 200), plays: v.plays, minutes: minutes(v.ms) })),
		topSongs: [...p.songs.entries()]
			.sort((a, b) => b[1].plays - a[1].plays)
			.slice(0, 50)
			.map(([id, v]) => ({
				id,
				name: v.name || "Unbekannter Song",
				artist: v.artist,
				plays: v.plays,
			})),
	};
}
