/**
 * How long the visible app waits before its next `GET /api/state` (P1).
 *
 * 1.2.0 asked every 15 s, all the time the app was open, and every answer
 * reads rows on the Durable Object. Playing, the hub already watches the end
 * of the song itself and the song clock runs locally, so the app only needs
 * to hear about changes made elsewhere. Quick right after a tap, slower
 * the longer nobody touches the app, slowest when nothing plays. Focus,
 * becoming visible and coming back online still ask at once.
 */
export function statePollMs(input: { playing: boolean; sinceInteractionMs: number }): number {
	const idle = Math.max(0, input.sinceInteractionMs);
	if (input.playing) return idle < 2 * 60_000 ? 15_000 : 30_000;
	if (idle < 2 * 60_000) return 30_000;
	if (idle < 10 * 60_000) return 60_000;
	if (idle < 30 * 60_000) return 120_000;
	return 300_000;
}
