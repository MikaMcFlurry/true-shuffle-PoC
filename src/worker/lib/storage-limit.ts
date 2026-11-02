/**
 * P1: when Cloudflare's daily Durable Object limits are used up (22./23.10.),
 * every storage call fails until 00:00 UTC. 1.2.0 said "Interner Fehler" to
 * that; the listener deserves the actual cause and when it ends.
 *
 * Cloudflare does not document the exact wording, so this matches the
 * families of text its storage errors use (rows read/written, limits,
 * exceeded, SQLITE_FULL) and never a Spotify error (those are typed earlier).
 */
const LIMIT =
	/rows?[ _-]?(read|written)|SQLITE_FULL|durable objects?.*(limit|exceeded|quota)|storage (operation|limit|quota)|daily (free )?(tier )?(limit|quota)|free tier/i;
/** Worker runtime limits and provider rate limits are transient, never "the day's limit". */
const NOT_STORAGE = /call stack|memory limit|subrequest|cpu time|rate limit|spotify/i;

export function isStorageLimit(err: unknown): boolean {
	const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
	return LIMIT.test(text) && !NOT_STORAGE.test(text);
}

/** The next reset (00:00 UTC) on the listener's clock in Germany. */
export function storageLimitMessage(now = Date.now()): string {
	const reset = new Date(now);
	reset.setUTCHours(24, 0, 0, 0);
	const at = new Intl.DateTimeFormat("de-DE", {
		timeZone: "Europe/Berlin",
		hour: "2-digit",
		minute: "2-digit",
	}).format(reset);
	return `Das Tageslimit des Servers (Cloudflare) ist erreicht. Ab ${at} Uhr geht es weiter, deine Daten bleiben erhalten.`;
}

export const STORAGE_LIMIT_CODE = "storage_limit";
