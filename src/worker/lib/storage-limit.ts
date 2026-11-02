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
	/exceeded|rows?[ _-]?(read|written)|daily (free )?(tier )?limit|SQLITE_FULL|storage (operation|limit)|over (the )?limit|limit (reached|exceeded)/i;

export function isStorageLimit(err: unknown): boolean {
	const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
	return LIMIT.test(text);
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
