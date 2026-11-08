/**
 * P1: when Cloudflare's daily Durable Object limits are used up (22./23.10.),
 * every storage call fails until 00:00 UTC. 1.2.0 said "Interner Fehler" to
 * that; the listener deserves the actual cause and when it ends.
 *
 * Cloudflare does not document the exact wording, so this matches the
 * families of text its storage errors use and never a Spotify error (those
 * are typed earlier). Only an error that names the daily limit (rows read or
 * written, daily, free tier) promises the reset at 00:00 UTC. A full database
 * (SQLITE_FULL) or another storage limit says what happened and promises no
 * time: nothing proves it ends at midnight (PR31-STORAGE-CLASSIFICATION).
 */
const DAILY = /rows?[ _-]?(read|written)|daily (free )?(tier )?(limit|quota)|free tier/i;
const OTHER =
	/SQLITE_FULL|database or disk is full|durable objects?.*(limit|exceeded|quota)|storage (operation|limit|quota)/i;
/** Worker runtime limits and provider rate limits are transient, never a storage limit. */
const NOT_STORAGE =
	/call stack|memory limit|subrequest|cpu time|rate limit|timeout|timed out|reset|overloaded/i;

function text(err: unknown): string {
	return err instanceof Error ? `${err.name} ${err.message}` : String(err);
}

/** Cloudflare's daily limit, named as such: it ends at 00:00 UTC. */
export function isStorageLimit(err: unknown): boolean {
	const t = text(err);
	return DAILY.test(t) && !NOT_STORAGE.test(t);
}

/** Storage refused for another reason (full, a non-daily limit): no known end. */
export function isStorageFull(err: unknown): boolean {
	const t = text(err);
	return !isStorageLimit(err) && OTHER.test(t) && !NOT_STORAGE.test(t);
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

/** No time is promised: what was stored stays, new things are not stored for now. */
export function storageFullMessage(): string {
	return "Der Speicher des Servers (Cloudflare) nimmt gerade nichts mehr an. Was schon gespeichert ist, bleibt erhalten; wann es wieder geht, ist nicht bekannt.";
}

export const STORAGE_LIMIT_CODE = "storage_limit";
export const STORAGE_FULL_CODE = "storage_full";
