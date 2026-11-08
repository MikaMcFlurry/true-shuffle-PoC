/**
 * What this build is, said once for both halves: the page the listener
 * loaded (Mehr → Über, the "Was ist neu?" notice) and the Worker's health
 * answer. Both import this record, so a built page and a built Worker always
 * name the same release. The version is the package's own (package.json);
 * nothing here repeats it.
 */

import { version } from "../../package.json";

export interface Release {
	/** The package version this build was made from. */
	version: string;
	/** The day this release was put together (YYYY-MM-DD). */
	date: string;
	/** What changed for the listener: at most four short lines. */
	changes: readonly string[];
	/** A known limit that stays with this release, said plainly. */
	known: string | null;
}

/** A notice is short: never more changes than this. */
export const MAX_CHANGES = 4;
/** A change is one short line. */
export const MAX_CHANGE_LENGTH = 140;

export const RELEASE: Release = Object.freeze({
	version,
	date: "2026-11-08",
	changes: Object.freeze([
		"Pausierst du selbst, bleibt es still – auch in der letzten Sekunde: „Nach diesem Song fortsetzen“ wartet auf das echte Ende.",
		"Startest du kurz vor dem Ende selbst einen anderen Song, läuft er weiter. true-shuffle schneidet ihn nicht mehr ab.",
		"TrueShuffle Likes: Nach einem Spotify-Aussetzer schreibt true-shuffle die Playlist neu, statt einer Zählung zu trauen.",
		"Ist der Speicher des Servers voll, sagt die App das ehrlich, ohne eine Uhrzeit zu versprechen.",
	]),
	known:
		"Reihst du in Spotify von Hand einen späteren Song deiner Kassette ein, hält true-shuffle ihn für die Fortsetzung und rückt deine gespeicherte Stelle dorthin vor. Pausierst du und springst danach in Spotify zurück oder weiter, kann „Nach diesem Song fortsetzen“ trotzdem fortsetzen. Mit Crossfade oder nach Vorspulen setzt es oft nicht fort und sagt das, weil sich das nicht von einem selbst gewählten Song unterscheiden lässt. Bei manchen alten Bewertungsdaten können Listen und Bewertungsfenster noch unterschiedliche Werte zeigen. Nicht jeder Song hat eine Hörprobe; sie ist nur zum privaten Anhören gedacht, und ob andere Audio-Apps dabei pausieren, entscheidet dein Gerät.",
});

/** "1.2.3" as numbers; anything else (a pre-release, a word) is no version here. */
export function versionParts(v: unknown): [number, number, number] | null {
	if (typeof v !== "string") return null;
	const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(v);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `a` is a later version than `b`; false when either is no version. */
export function isLater(a: unknown, b: unknown): boolean {
	const x = versionParts(a);
	const y = versionParts(b);
	if (!x || !y) return false;
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
	return false;
}

/** What is wrong with a release record (empty: nothing). */
export function releaseProblems(r: Release): string[] {
	const out: string[] = [];
	if (!versionParts(r.version)) out.push(`version "${r.version}" is not x.y.z`);
	const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.date);
	const day = d ? new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))) : null;
	if (!day || day.toISOString().slice(0, 10) !== r.date) out.push(`date "${r.date}" is no day`);
	if (r.changes.length === 0 || r.changes.length > MAX_CHANGES)
		out.push(`${r.changes.length} changes (1 to ${MAX_CHANGES})`);
	for (const c of r.changes)
		if (!c.trim() || c.length > MAX_CHANGE_LENGTH) out.push(`change not one short line: "${c}"`);
	return out;
}
