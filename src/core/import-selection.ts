/**
 * Which parts of an imported Spotify history shape the listener's memory.
 *
 * The listener keeps the import and decides, rule by rule, which of its plays
 * count: a period left out, an artist or a song left out or brought back in,
 * the old song totals without single plays left out. Nothing here deletes a
 * play; a rule only takes the influence of imported plays away (or gives it
 * back). Live plays, thumbs, hearts and bans are never touched.
 *
 * One rule decides each imported play, the most specific that matches:
 * a song rule, else an artist rule, else a period — and without any, the play
 * counts. So "2019 left out, this one song back in" keeps that song's 2019
 * plays and none of the others. Periods are whole calendar days in the time
 * zone the listener chose them in, both ends included; a play belongs to the
 * moment Spotify says it ended (`ts` of the export).
 *
 * The effective history equals the stored song totals for every song no rule
 * takes anything from; a song that loses plays is counted again from the
 * plays it keeps. A song known only by its totals (an import from before the
 * single plays were kept) can be left out as a whole, never split by period
 * or artist: those need its single plays, and inventing them is not allowed.
 */

import { LISTEN_FLAG, type ListenTrack } from "./listens";
import type { ImportedStats } from "./memory";
import { PLAY_THRESHOLD_MS, type TrackId } from "./types";

export type RuleKind = "exclude" | "include";

export type SelectionRule =
	| {
			type: "period";
			kind: "exclude";
			/** Calendar days, both included: "YYYY-MM-DD". */
			from: string;
			to: string;
			/** The IANA time zone the days are meant in. */
			zone: string;
	  }
	| { type: "artist"; kind: RuleKind; name: string }
	| { type: "track"; kind: RuleKind; id: TrackId; label?: string }
	/** Songs known only by their totals (no single plays stored). */
	| { type: "summary"; kind: "exclude" };

export interface ImportSelection {
	/** Off: the import is kept but counts for nothing. */
	enabled: boolean;
	rules: SelectionRule[];
}

export const MAX_RULES = 1000;

export function defaultSelection(): ImportSelection {
	return { enabled: true, rules: [] };
}

/** One artist, however the export spelled its case and spaces. */
export function artistKey(name: string): string {
	return name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("de");
}

/** A rule's identity: two rules with the same key are the same rule (the later wins). */
export function ruleKey(r: SelectionRule): string {
	switch (r.type) {
		case "period":
			return `period:${r.from}:${r.to}:${r.zone}`;
		case "artist":
			return `artist:${artistKey(r.name)}`;
		case "track":
			return `track:${r.id}`;
		case "summary":
			return "summary";
	}
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(s: unknown): s is string {
	if (typeof s !== "string") return false;
	const m = DATE.exec(s);
	if (!m) return false;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	if (y < 2000 || y > 2100) return false;
	const t = new Date(Date.UTC(y, mo - 1, d));
	return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function validZone(zone: unknown): zone is string {
	if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

export class SelectionError extends Error {}

/**
 * A selection as sent from the browser, checked and in one canonical form:
 * duplicates folded (the later rule wins), sorted by key. Two selections that
 * mean the same are equal as JSON, so applying one twice changes nothing.
 */
export function cleanSelection(input: unknown): ImportSelection {
	const bad = (why: string) => new SelectionError(why);
	const s = input as { enabled?: unknown; rules?: unknown } | null;
	if (!s || typeof s !== "object") throw bad("Auswahl fehlt");
	if (typeof s.enabled !== "boolean") throw bad("Aktiv/aus fehlt");
	if (!Array.isArray(s.rules)) throw bad("Regeln fehlen");
	if (s.rules.length > MAX_RULES) throw bad(`Höchstens ${MAX_RULES} Regeln`);
	const out = new Map<string, SelectionRule>();
	const kind = (k: unknown): RuleKind => {
		if (k !== "exclude" && k !== "include") throw bad("Regelart");
		return k;
	};
	for (const raw of s.rules as unknown[]) {
		const r = raw as Record<string, unknown> | null;
		if (!r || typeof r !== "object") throw bad("Regel");
		let rule: SelectionRule;
		switch (r.type) {
			case "period": {
				if (r.kind !== "exclude") throw bad("Ein Zeitraum kann nur ausgeschlossen werden");
				if (!validDate(r.from) || !validDate(r.to)) throw bad("Datum");
				if (r.from > r.to) throw bad("Zeitraum endet vor seinem Beginn");
				if (!validZone(r.zone)) throw bad("Zeitzone");
				rule = { type: "period", kind: "exclude", from: r.from, to: r.to, zone: r.zone };
				break;
			}
			case "artist": {
				if (typeof r.name !== "string" || r.name.length > 200 || !artistKey(r.name))
					throw bad("Künstler");
				rule = { type: "artist", kind: kind(r.kind), name: r.name.trim() };
				break;
			}
			case "track": {
				if (typeof r.id !== "string" || !/^[A-Za-z0-9]{22}$/.test(r.id)) throw bad("Song");
				const label =
					typeof r.label === "string" && r.label.trim() ? r.label.trim().slice(0, 200) : undefined;
				rule = { type: "track", kind: kind(r.kind), id: r.id, ...(label ? { label } : {}) };
				break;
			}
			case "summary": {
				if (r.kind !== "exclude") throw bad("Summen können nur ausgeschlossen werden");
				rule = { type: "summary", kind: "exclude" };
				break;
			}
			default:
				throw bad("Regeltyp");
		}
		const key = ruleKey(rule);
		out.delete(key);
		out.set(key, rule);
	}
	const rules = [...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return { enabled: s.enabled, rules: rules.map(([, r]) => r) };
}

export function sameSelection(a: ImportSelection, b: ImportSelection): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Calendar days in a time zone

function wallClock(zone: string): (at: number) => number {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	});
	// The zone's calendar time at a moment, written as if it were UTC.
	return (at) => {
		const p = Object.fromEntries(fmt.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
		return Date.UTC(
			Number(p.year),
			Number(p.month) - 1,
			Number(p.day),
			Number(p.hour),
			Number(p.minute),
			Number(p.second),
		);
	};
}

/**
 * When a calendar day ("YYYY-MM-DD") begins in a time zone: the first moment
 * whose local time is that day's midnight or later. A midnight skipped by a
 * clock change begins the day at the first moment after it; a day the zone
 * skipped altogether (Pacific/Apia, 30 December 2011) begins — and ends — when
 * the next day begins, so it holds no moment at all.
 */
export function dayStart(date: string, zone: string): number {
	const m = DATE.exec(date);
	if (!m) throw new SelectionError("Datum");
	const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	const local = wallClock(zone);
	// UTC offsets lie within -12 h … +14 h: the answer is between these two.
	let lo = Math.floor((wall - 15 * 3_600_000) / 1000);
	let hi = Math.ceil((wall + 13 * 3_600_000) / 1000);
	// Local time only ever jumps back below a midnight it has not reached yet,
	// so "at or after that midnight" turns true once: search it to the second.
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		if (local(mid * 1000) >= wall) hi = mid;
		else lo = mid;
	}
	return hi * 1000;
}

/** The day after ("YYYY-MM-DD"). */
export function nextDay(date: string): string {
	const m = DATE.exec(date);
	if (!m) throw new SelectionError("Datum");
	return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1))
		.toISOString()
		.slice(0, 10);
}

/** A period rule as times: from inclusive, to exclusive. */
export function periodBounds(r: { from: string; to: string; zone: string }): [number, number] {
	return [dayStart(r.from, r.zone), dayStart(nextDay(r.to), r.zone)];
}

// ---------------------------------------------------------------------------
// Deciding

/** Which rule decided: its index in `rules`, or -1 (no rule: the play counts). */
export interface Matcher {
	readonly enabled: boolean;
	readonly rules: readonly SelectionRule[];
	readonly keys: readonly string[];
	/** An imported play: when it ended (ms), its song, its artist (as artistKey). */
	event(at: number, id: TrackId, artist: string): number;
	/** A song known only by its totals. */
	summary(id: TrackId): number;
	included(decision: number): boolean;
}

export function matcher(sel: ImportSelection): Matcher {
	const tracks = new Map<TrackId, number>();
	const artists = new Map<string, number>();
	const periods: { from: number; to: number; i: number }[] = [];
	let summary = -1;
	sel.rules.forEach((r, i) => {
		if (r.type === "track") tracks.set(r.id, i);
		else if (r.type === "artist") artists.set(artistKey(r.name), i);
		else if (r.type === "period") {
			const [from, to] = periodBounds(r);
			periods.push({ from, to, i });
		} else summary = i;
	});
	periods.sort((a, b) => a.from - b.from || a.i - b.i);
	return {
		enabled: sel.enabled,
		rules: sel.rules,
		keys: sel.rules.map(ruleKey),
		event(at, id, artist) {
			const t = tracks.get(id);
			if (t !== undefined) return t;
			const a = artists.get(artist);
			if (a !== undefined) return a;
			for (const p of periods) {
				if (p.from > at) break;
				if (at < p.to) return p.i;
			}
			return -1;
		},
		summary(id) {
			const t = tracks.get(id);
			if (t !== undefined) return t;
			return summary;
		},
		included(d) {
			return d < 0 || sel.rules[d]!.kind === "include";
		},
	};
}

// ---------------------------------------------------------------------------
// The imported plays, as the hub holds them

export interface ListenColumns {
	tracks: ListenTrack[];
	rows: number;
	/** Ended at, whole seconds. */
	at: Uint32Array;
	track: Uint32Array;
	ms: Uint32Array;
	/** Flags and platform, two bytes a play. */
	meta: Uint8Array;
}

/** What one imported play says: 1 a play, 2 an early skip that counts, 0 nothing for the memory. */
export function weightOf(ms: number, flags: number): 0 | 1 | 2 {
	if (ms >= PLAY_THRESHOLD_MS) return 1;
	if ((flags & (LISTEN_FLAG.skipped | LISTEN_FLAG.forward)) === 0) return 0;
	// The first song after a start, told apart by the import: not held against it.
	if ((flags & LISTEN_FLAG.rated) !== 0 && (flags & LISTEN_FLAG.opener) !== 0) return 0;
	return 2;
}

/**
 * Songs whose stored single plays do not account for their stored totals
 * (other plays or skips counted than kept): the totals came from more (or
 * other) plays than were stored. A period or an artist cannot be applied to
 * plays that are not there, so such a song is decided as a whole, like a song
 * with totals only — by a song rule or the totals rule — and said so. By index
 * into `events.tracks`.
 */
export function partialTracks(
	events: ListenColumns | null,
	aggregate: ReadonlyMap<TrackId, ImportedStats>,
	liveSince: number | null,
): Set<number> {
	const out = new Set<number>();
	if (!events) return out;
	const limit = liveSince ?? Number.POSITIVE_INFINITY;
	const n = events.tracks.length;
	const plays = new Uint32Array(n);
	const skips = new Uint32Array(n);
	for (let i = 0; i < events.rows; i++) {
		if (events.at[i]! * 1000 >= limit) continue;
		const w = weightOf(events.ms[i]!, events.meta[i * 2]!);
		if (w === 1) plays[events.track[i]!]!++;
		else if (w === 2) skips[events.track[i]!]!++;
	}
	for (let t = 0; t < n; t++) {
		const s = aggregate.get(events.tracks[t]![0]);
		if (!s) continue;
		if (s.plays !== plays[t] || s.earlySkips !== skips[t]) out.add(t);
	}
	return out;
}

export interface RuleEffect {
	key: string;
	plays: number;
	skips: number;
	songs: number;
}

export interface SelectionCounts {
	enabled: boolean;
	/**
	 * Every stored single play; of those before live counting began, the ones
	 * that say nothing to the memory (under 30 s and not skipped, or the first
	 * song after a start skipped): kept and shown, but counted for nothing.
	 */
	rows: number;
	neutralRows: number;
	/**
	 * Stored plays from the moment live counting began on: the import counts
	 * them for nothing (that time belongs to true-shuffle's own count, which
	 * holds only what it observed itself), so nothing is counted twice.
	 */
	afterLiveRows: number;
	/** Plays (>= 30 s) and early skips the import holds, songs among them. */
	plays: number;
	skips: number;
	songs: number;
	/** Of those, what counts under the selection. */
	includedPlays: number;
	includedSkips: number;
	includedSongs: number;
	/** Songs whose imported numbers the selection changes (or takes away). */
	changedSongs: number;
	/** Songs known only by their totals, and their plays. */
	summarySongs: number;
	summaryPlays: number;
	/**
	 * Songs whose single plays do not account for their totals (see
	 * partialTracks), and their stored plays: decided as a whole, like totals.
	 */
	partialSongs: number;
	partialPlays: number;
	/** Of the songs known only by their totals or partly: those that count. */
	includedSummarySongs: number;
	/** First and last single play (ms), null without single plays. */
	from: number | null;
	to: number | null;
	/** What each rule decided (by key): plays/skips/songs it left out, or kept in. */
	rules: RuleEffect[];
}

export interface SelectionResult {
	/**
	 * Songs whose imported numbers differ from the stored totals: what counts
	 * now, or null for nothing at all. Every other song keeps its totals.
	 */
	overrides: Map<TrackId, ImportedStats | null>;
	counts: SelectionCounts;
}

/** The artist key of every song of the imported plays (computed once per upload). */
export function artistKeys(tracks: readonly ListenTrack[]): string[] {
	return tracks.map((t) => artistKey(t[2]));
}

/**
 * What the selection makes of the import: a pure function of the stored
 * plays, the stored song totals, the rules and the moment live counting
 * began (plays from then on belong to true-shuffle's own count).
 */
export function selectImport(input: {
	events: ListenColumns | null;
	artists?: readonly string[];
	/** See partialTracks (computed when left out). */
	partial?: ReadonlySet<number>;
	aggregate: ReadonlyMap<TrackId, ImportedStats>;
	selection: ImportSelection;
	liveSince: number | null;
}): SelectionResult {
	const { events, aggregate, selection, liveSince } = input;
	const m = matcher(selection);
	const n = events?.tracks.length ?? 0;
	const artists = events ? (input.artists ?? artistKeys(events.tracks)) : [];
	const limit = liveSince ?? Number.POSITIVE_INFINITY;
	const partial = input.partial ?? partialTracks(events, aggregate, liveSince);
	const playsIn = new Uint32Array(n);
	const playsOut = new Uint32Array(n);
	const skipsIn = new Uint32Array(n);
	const skipsOut = new Uint32Array(n);
	const effect = new Map<number, { plays: number; skips: number; songs: Set<number | string> }>();
	const note = (d: number, w: 1 | 2, song: number | string) => {
		if (d < 0) return;
		let e = effect.get(d);
		if (!e) {
			e = { plays: 0, skips: 0, songs: new Set() };
			effect.set(d, e);
		}
		if (w === 1) e.plays++;
		else e.skips++;
		e.songs.add(song);
	};
	let from: number | null = null;
	let to: number | null = null;
	let rows = 0;
	let neutralRows = 0;
	let afterLiveRows = 0;
	if (events)
		for (let i = 0; i < events.rows; i++) {
			const at = events.at[i]! * 1000;
			rows++;
			if (at >= limit) {
				afterLiveRows++;
				continue;
			}
			const w = weightOf(events.ms[i]!, events.meta[i * 2]!);
			if (w === 0) {
				neutralRows++;
				continue;
			}
			const t = events.track[i]!;
			const song = events.tracks[t];
			if (!song) continue;
			from = from === null ? at : Math.min(from, at);
			to = to === null ? at : Math.max(to, at);
			// Decided as a whole from its totals (below), never play by play.
			if (partial.has(t)) continue;
			const d = selection.enabled ? m.event(at, song[0], artists[t]!) : -1;
			const keep = selection.enabled && m.included(d);
			if (w === 1) (keep ? playsIn : playsOut)[t]!++;
			else (keep ? skipsIn : skipsOut)[t]!++;
			if (selection.enabled) note(d, w, t);
		}
	// Songs that lose plays are counted again from the plays they keep.
	const overrides = new Map<TrackId, ImportedStats | null>();
	const recount = new Map<number, ImportedStats & { skipSeen: boolean }>();
	const withEvents = new Set<TrackId>();
	let plays = 0;
	let skips = 0;
	let songs = 0;
	let includedPlays = 0;
	let includedSkips = 0;
	let includedSongs = 0;
	for (let t = 0; t < n; t++) {
		const total = playsIn[t]! + playsOut[t]! + skipsIn[t]! + skipsOut[t]!;
		if (total === 0) continue;
		const id = events!.tracks[t]![0];
		withEvents.add(id);
		songs++;
		plays += playsIn[t]! + playsOut[t]!;
		skips += skipsIn[t]! + skipsOut[t]!;
		includedPlays += playsIn[t]!;
		includedSkips += skipsIn[t]!;
		if (playsIn[t]! + skipsIn[t]! > 0) includedSongs++;
		if (!selection.enabled) continue;
		if (playsOut[t]! + skipsOut[t]! === 0) {
			// Untouched: the stored totals stand (a song only in the plays, never in
			// the totals, stays out — the selection takes away, it never adds).
			continue;
		}
		if (playsIn[t]! + skipsIn[t]! === 0) {
			overrides.set(id, null);
			continue;
		}
		recount.set(t, {
			plays: 0,
			earlySkips: 0,
			lastPlayedAt: null,
			lastSkippedAt: null,
			playedBeforeSkips: 0,
			skipSeen: false,
		});
	}
	if (recount.size > 0 && events) {
		// Oldest first (the upload is): plays before the first kept skip are counted as they come.
		for (let i = 0; i < events.rows; i++) {
			const r = recount.get(events.track[i]!);
			if (!r) continue;
			const at = events.at[i]! * 1000;
			if (at >= limit) continue;
			const w = weightOf(events.ms[i]!, events.meta[i * 2]!);
			if (w === 0) continue;
			const t = events.track[i]!;
			if (!m.included(m.event(at, events.tracks[t]![0], artists[t]!))) continue;
			if (w === 1) {
				r.plays++;
				r.lastPlayedAt = r.lastPlayedAt === null ? at : Math.max(r.lastPlayedAt, at);
				if (!r.skipSeen) r.playedBeforeSkips = (r.playedBeforeSkips ?? 0) + 1;
			} else {
				r.earlySkips++;
				r.lastSkippedAt = r.lastSkippedAt == null ? at : Math.max(r.lastSkippedAt, at);
				r.skipSeen = true;
			}
		}
		for (const [t, r] of recount) {
			const { skipSeen: _, ...stats } = r;
			overrides.set(events.tracks[t]![0], stats);
		}
	}
	// Songs known only by their totals, or partly by single plays.
	const partialIds = new Set([...partial].map((t) => events!.tracks[t]![0]));
	let summarySongs = 0;
	let summaryPlays = 0;
	let partialSongs = 0;
	let partialPlays = 0;
	let includedSummarySongs = 0;
	for (const [id, s] of aggregate) {
		if (withEvents.has(id)) continue;
		if (s.plays + s.earlySkips === 0) continue;
		if (partialIds.has(id)) {
			partialSongs++;
			partialPlays += s.plays;
		} else {
			summarySongs++;
			summaryPlays += s.plays;
		}
		songs++;
		plays += s.plays;
		skips += s.earlySkips;
		const d = selection.enabled ? m.summary(id) : -1;
		const keep = selection.enabled && m.included(d);
		if (keep) {
			includedSummarySongs++;
			includedSongs++;
			includedPlays += s.plays;
			includedSkips += s.earlySkips;
		} else if (selection.enabled) overrides.set(id, null);
		if (selection.enabled && d >= 0) {
			let e = effect.get(d);
			if (!e) {
				e = { plays: 0, skips: 0, songs: new Set() };
				effect.set(d, e);
			}
			e.plays += s.plays;
			e.skips += s.earlySkips;
			e.songs.add(id);
		}
	}
	return {
		overrides,
		counts: {
			enabled: selection.enabled,
			rows,
			neutralRows,
			afterLiveRows,
			plays,
			skips,
			songs,
			includedPlays,
			includedSkips,
			includedSongs,
			changedSongs: selection.enabled ? overrides.size : includedSongs === 0 ? songs : 0,
			summarySongs,
			summaryPlays,
			partialSongs,
			partialPlays,
			includedSummarySongs,
			from,
			to,
			rules: [...effect.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([i, e]) => ({
					key: m.keys[i]!,
					plays: e.plays,
					skips: e.skips,
					songs: e.songs.size,
				})),
		},
	};
}

/** The stored totals with the selection applied: what the memory merges with live plays. */
export function applyOverrides(
	aggregate: ReadonlyMap<TrackId, ImportedStats>,
	overrides: ReadonlyMap<TrackId, ImportedStats | null>,
): Map<TrackId, ImportedStats> {
	const out = new Map(aggregate);
	for (const [id, s] of overrides) {
		if (s === null) out.delete(id);
		else if (out.has(id)) out.set(id, s);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Looking through the import

export type InspectGroup = "track" | "artist";
export type InspectStatus = "all" | "included" | "excluded" | "partial" | "neutral";
export type InspectSort = "plays" | "name" | "recent";

export interface InspectQuery {
	q: string;
	group: InspectGroup;
	status: InspectStatus;
	sort: InspectSort;
	/** Only plays in this time (ms, from inclusive, to exclusive); a look, not a rule. */
	from: number | null;
	to: number | null;
	offset: number;
	limit: number;
}

export interface InspectItem {
	/** Track id, or artist key ("" for songs known only by their totals). */
	key: string;
	name: string;
	artist: string;
	album: string;
	songs: number;
	plays: number;
	skips: number;
	includedPlays: number;
	includedSkips: number;
	/** Stored single plays of it (all of them, those that count for nothing too). */
	rows: number;
	/** Of those, plays that say nothing to the memory (see SelectionCounts.neutralRows). */
	neutral: number;
	/** Of those, plays from when live counting began on: nothing from the import (see SelectionCounts.afterLiveRows). */
	afterLive: number;
	lastAt: number | null;
	/** Only totals are stored for it: no single plays. */
	summaryOnly: boolean;
	/** Its single plays do not account for its totals: decided as a whole (see partialTracks). */
	partial: boolean;
	/** "neutral": only plays that count for nothing either way (or lie in live time). */
	status: "included" | "excluded" | "partial" | "neutral";
	/** Keys of the rules that decided its plays (sorted), whichever way. */
	rules: string[];
}

export interface InspectPage {
	total: number;
	items: InspectItem[];
	/** Song ids of every match (at most 500), for "all matches" actions. */
	matchIds: TrackId[];
	matchArtists: string[];
}

/** Every imported song or artist with what the selection makes of it, for one page of a search. */
export function inspectImport(input: {
	events: ListenColumns | null;
	artists?: readonly string[];
	partial?: ReadonlySet<number>;
	aggregate: ReadonlyMap<TrackId, ImportedStats>;
	selection: ImportSelection;
	liveSince: number | null;
	query: InspectQuery;
	/** Names for songs known only by their totals, where the library knows them. */
	names?: (id: TrackId) => { name: string; artist: string; album: string } | null;
}): InspectPage {
	const { events, aggregate, selection, liveSince, query } = input;
	const m = matcher(selection);
	const artists = events ? (input.artists ?? artistKeys(events.tracks)) : [];
	const limit = liveSince ?? Number.POSITIVE_INFINITY;
	const partial = input.partial ?? partialTracks(events, aggregate, liveSince);
	const partialIds = new Set([...partial].map((t) => events!.tracks[t]![0]));
	const q = query.q.normalize("NFC").trim().toLocaleLowerCase("de");
	const groups = new Map<
		string,
		InspectItem & { ruleSet: Set<string>; songSet: Set<TrackId>; nameCount?: Map<string, number> }
	>();
	const matches = (name: string, artist: string, album: string, id: string) =>
		!q ||
		name.toLocaleLowerCase("de").includes(q) ||
		artist.toLocaleLowerCase("de").includes(q) ||
		album.toLocaleLowerCase("de").includes(q) ||
		id === query.q.trim();
	const fresh = (
		key: string,
		name: string,
		artist: string,
		album: string,
		summaryOnly: boolean,
	) => ({
		key,
		name,
		artist,
		album,
		songs: 0,
		plays: 0,
		skips: 0,
		includedPlays: 0,
		includedSkips: 0,
		rows: 0,
		neutral: 0,
		afterLive: 0,
		lastAt: null,
		summaryOnly,
		partial: false,
		status: "included" as const,
		rules: [],
		ruleSet: new Set<string>(),
		songSet: new Set<TrackId>(),
	});
	const seenEvents = new Set<TrackId>();
	if (events) {
		const hit = events.tracks.map((t) => matches(t[1], t[2], t[3], t[0]));
		for (let i = 0; i < events.rows; i++) {
			const at = events.at[i]! * 1000;
			const t = events.track[i]!;
			const song = events.tracks[t];
			if (!song) continue;
			// From live counting on: stored and listed, but no part of the import's influence.
			const live = at >= limit;
			const w = live ? 0 : weightOf(events.ms[i]!, events.meta[i * 2]!);
			if (w !== 0 && !partial.has(t)) seenEvents.add(song[0]);
			if (!hit[t]) continue;
			if (query.from !== null && at < query.from) continue;
			if (query.to !== null && at >= query.to) continue;
			const key = query.group === "track" ? song[0] : artists[t]!;
			let g = groups.get(key);
			if (!g) {
				g =
					query.group === "track"
						? fresh(key, song[1] || "Unbekannter Song", song[2], song[3], false)
						: fresh(key, song[2] || "Unbekannter Künstler", "", "", false);
				groups.set(key, g);
			}
			g.songSet.add(song[0]);
			if (live) {
				g.rows++;
				g.afterLive++;
				g.lastAt = g.lastAt === null ? at : Math.max(g.lastAt, at);
				continue;
			}
			if (partial.has(t)) {
				// Listed; what it counts comes from its totals as a whole (below).
				g.rows++;
				if (w === 0) g.neutral++;
				g.partial = true;
				g.lastAt = g.lastAt === null ? at : Math.max(g.lastAt, at);
				continue;
			}
			const d = selection.enabled ? m.event(at, song[0], artists[t]!) : -1;
			const keep = selection.enabled && m.included(d);
			if (d >= 0) g.ruleSet.add(m.keys[d]!);
			g.rows++;
			g.lastAt = g.lastAt === null ? at : Math.max(g.lastAt, at);
			if (w === 0) g.neutral++;
			else if (w === 1) {
				g.plays++;
				if (keep) g.includedPlays++;
			} else {
				g.skips++;
				if (keep) g.includedSkips++;
			}
		}
	}
	// Songs known only by their totals: undated, so a time filter leaves them out.
	if (query.from === null && query.to === null)
		for (const [id, s] of aggregate) {
			if (seenEvents.has(id) || s.plays + s.earlySkips === 0) continue;
			const named = input.names?.(id) ?? null;
			if (!matches(named?.name ?? "", named?.artist ?? "", named?.album ?? "", id)) continue;
			const key = query.group === "track" ? id : "";
			let g = groups.get(key);
			if (!g) {
				g =
					query.group === "track"
						? fresh(key, named?.name ?? id, named?.artist ?? "", named?.album ?? "", true)
						: fresh(key, "Nur Summen, ohne einzelne Wiedergaben", "", "", true);
				groups.set(key, g);
			}
			g.songSet.add(id);
			if (partialIds.has(id)) g.partial = true;
			else g.summaryOnly = true;
			const d = selection.enabled ? m.summary(id) : -1;
			const keep = selection.enabled && m.included(d);
			if (d >= 0) g.ruleSet.add(m.keys[d]!);
			g.plays += s.plays;
			g.skips += s.earlySkips;
			if (keep) {
				g.includedPlays += s.plays;
				g.includedSkips += s.earlySkips;
			}
			if (s.lastPlayedAt !== null)
				g.lastAt = g.lastAt === null ? s.lastPlayedAt : Math.max(g.lastAt, s.lastPlayedAt);
		}
	const all: InspectItem[] = [];
	for (const g of groups.values()) {
		const kept = g.includedPlays + g.includedSkips;
		const total = g.plays + g.skips;
		const status =
			total === 0 ? "neutral" : kept === total ? "included" : kept === 0 ? "excluded" : "partial";
		if (query.status !== "all" && query.status !== status) continue;
		const { ruleSet, songSet, nameCount: _, ...rest } = g;
		all.push({ ...rest, songs: songSet.size, status, rules: [...ruleSet].sort() });
	}
	const byName = (a: InspectItem, b: InspectItem) =>
		a.name.localeCompare(b.name, "de") ||
		a.artist.localeCompare(b.artist, "de") ||
		(a.key < b.key ? -1 : 1);
	all.sort((a, b) =>
		query.sort === "name"
			? byName(a, b)
			: query.sort === "recent"
				? (b.lastAt ?? 0) - (a.lastAt ?? 0) || byName(a, b)
				: b.plays - a.plays || byName(a, b),
	);
	const offset = Math.max(0, query.offset);
	return {
		total: all.length,
		items: all.slice(offset, offset + Math.max(1, Math.min(200, query.limit))),
		matchIds: query.group === "track" ? all.slice(0, 500).map((x) => x.key) : [],
		matchArtists: query.group === "artist" ? all.slice(0, 500).map((x) => x.name) : [],
	};
}
