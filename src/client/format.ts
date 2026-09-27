const nf = new Intl.NumberFormat("de-DE");

/**
 * Separator for short facts on one line. Overpass draws U+00B7 off-centre,
 * so the display uses the centred bullet operator instead.
 */
export const SEP = "\u00a0\u2219 ";

/** How the station playlists are named in Spotify, as the interface writes it. */
export const DECK_PREFIX = "true-shuffle\u00a0\u2219\u00a0";

export function num(n: number): string {
	return nf.format(n);
}

export function pct(x: number): string {
	return `${Math.round(x * 100)} %`;
}

export function duration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const rtf = new Intl.RelativeTimeFormat("de-DE", { numeric: "auto" });

export function ago(at: number, now = Date.now()): string {
	const diff = at - now;
	const abs = Math.abs(diff);
	if (abs < 60_000) return "gerade eben";
	if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
	if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
	return rtf.format(Math.round(diff / 86_400_000), "day");
}

const tf = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
const df = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long" });

export function clock(at: number): string {
	return tf.format(at);
}

export function day(at: number): string {
	const d = new Date(at);
	const today = new Date();
	const y = new Date();
	y.setDate(today.getDate() - 1);
	if (d.toDateString() === today.toDateString()) return "Heute";
	if (d.toDateString() === y.toDateString()) return "Gestern";
	return df.format(d);
}

/** The radio display shows station names in capitals, like an RDS name. */
export function rds(name: string): string {
	return name.toLocaleUpperCase("de-DE");
}
