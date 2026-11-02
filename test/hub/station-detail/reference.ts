/**
 * TS-STATION-DETAIL-CONTRACT-261016: the reference model of the station page
 * read, written from the contract alone (docs/testing/station-detail-contract.md)
 * and never from the hub's code. It sees only a fixture and what a song looks
 * like, and says per list:
 *
 *  - `must`: entries the answer has to contain, in this order;
 *  - `may`:  every entry the answer is allowed to contain, in order (a
 *            superset of `must`);
 *  - `max`:  the list's bound.
 *
 * Without metadata gaps `must` and `may` are equal and the answer is exactly
 * that. A song whose metadata the station cannot supply may be left out —
 * never invented — and the model does not decide whether a later entry then
 * takes its place.
 */

import type { SlotKind } from "../../../src/core/types";
import type { Fixture, PlayFx, SongRef, StationKey } from "./fixtures";

export const UPCOMING_MAX = 12;
export const RECENT_MAX = 15;

export interface SongLook {
	id: string;
	name: string;
	artists: string;
	album: string;
	durationMs: number;
}

/** What the model may know about the world, nothing more. */
export interface Catalog {
	look(song: SongRef): SongLook;
	/** The station's own playlist holds this song. */
	holds(station: StationKey, song: SongRef): boolean;
	/** Some playlist of the listener holds it (another station's included). */
	known(song: SongRef): boolean;
	playedAt(ago: number): number;
}

export type UpcomingEntry = SongLook & { kind: SlotKind };
export type RecentEntry = SongLook & { playedAt: number };

export interface Expectation<E> {
	must: E[];
	may: E[];
	max: number;
}

type Certainty = "must" | "may" | "never";

function discovered(fx: Fixture, song: SongRef): boolean {
	return (
		typeof song === "string" && song.startsWith("d") && fx.discoveries.some((d) => d.song === song)
	);
}

/** How surely the read station can show this song's metadata from its own songs and the finds. */
function certainty(fx: Fixture, cat: Catalog, song: SongRef): Certainty {
	if (cat.holds(fx.read, song) || discovered(fx, song)) return "must";
	if (cat.known(song)) return "may";
	return "never";
}

function split<E>(
	rows: { entry: E; sure: Certainty; inWindow: boolean }[],
	max: number,
): Expectation<E> {
	return {
		must: rows.filter((r) => r.inWindow && r.sure === "must").map((r) => r.entry),
		may: rows.filter((r) => r.sure !== "never").map((r) => r.entry),
		max,
	};
}

/**
 * Upcoming: the deck's pending songs after the player's position — the seen
 * position, else the held one, else before the first song — in deck order,
 * each with the kind of its own deck place; the first twelve of them.
 */
export function expectUpcoming(fx: Fixture, cat: Catalog): Expectation<UpcomingEntry> {
	const deck = fx.decks[fx.read];
	if (!deck) return { must: [], may: [], max: UPCOMING_MAX };
	const pos = deck.lastIndex ?? deck.heldAt ?? -1;
	const pending = deck.items.slice(pos + 1).filter((it) => it.state === "pending");
	return split(
		pending.map((it, n) => ({
			entry: { ...cat.look(it.song), kind: it.kind },
			sure: certainty(fx, cat, it.song),
			inWindow: n < UPCOMING_MAX,
		})),
		UPCOMING_MAX,
	);
}

function playLook(cat: Catalog, p: PlayFx): SongLook {
	const base = cat.look(p.song);
	return typeof p.meta === "object" ? { ...base, name: p.meta.name, album: p.meta.album } : base;
}

/**
 * Recent: the station's own plays that count (not ignored), newest first,
 * every play its own entry; the newest fifteen. A play brings its stored
 * metadata; without it the station's songs or finds supply it.
 */
export function expectRecent(fx: Fixture, cat: Catalog): Expectation<RecentEntry> {
	const plays = fx.plays
		.filter((p) => p.station === fx.read && !p.ignored)
		.slice()
		.sort((a, b) => a.ago - b.ago);
	return split(
		plays.map((p, n) => ({
			entry: { ...playLook(cat, p), playedAt: cat.playedAt(p.ago) },
			sure: p.meta === "none" ? certainty(fx, cat, p.song) : "must",
			inWindow: n < RECENT_MAX,
		})),
		RECENT_MAX,
	);
}

/** Finds of the read station only: waiting (candidate or on probation), kept, rejected. */
export function expectDiscoveries(fx: Fixture): {
	pending: number;
	kept: number;
	rejected: number;
} {
	const own = fx.discoveries.filter((d) => d.station === fx.read);
	const n = (...s: string[]) => own.filter((d) => s.includes(d.status)).length;
	return { pending: n("candidate", "probation"), kept: n("kept"), rejected: n("rejected") };
}

/**
 * Every way `actual` breaks the expectation, as readable lines (empty: it
 * holds). The answer must be an ordered selection of `may` that contains all
 * of `must` and stays within `max`.
 */
export function violations<E extends object>(
	label: string,
	actual: readonly E[],
	exp: Expectation<E>,
): string[] {
	const key = (e: object) => JSON.stringify(e, Object.keys(e).sort());
	const out: string[] = [];
	if (actual.length > exp.max) out.push(`${label}: ${actual.length} entries, more than ${exp.max}`);
	const may = exp.may.map(key);
	const used = new Set<number>();
	let at = 0;
	for (const [i, a] of actual.entries()) {
		const k = key(a);
		let j = at;
		while (j < may.length && may[j] !== k) j++;
		if (j === may.length) {
			out.push(`${label}[${i}] not allowed here (unknown, out of order or invented): ${k}`);
			continue;
		}
		used.add(j);
		at = j + 1;
	}
	const mayIndex = new Map<string, number[]>();
	for (const [j, k] of may.entries()) mayIndex.set(k, [...(mayIndex.get(k) ?? []), j]);
	const seenMust = new Map<string, number>();
	for (const m of exp.must) {
		const k = key(m);
		const nth = seenMust.get(k) ?? 0;
		seenMust.set(k, nth + 1);
		const places = (mayIndex.get(k) ?? []).filter((j) => used.has(j));
		if (places.length <= nth) out.push(`${label}: missing required entry ${k}`);
	}
	return out;
}
