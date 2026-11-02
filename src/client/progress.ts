/** Display-only estimation; this value must never become a listening checkpoint. */
export function estimatedProgress(
	position: number | null,
	observedAt: number | null,
	serverTime: number,
	elapsed: number,
	playing: boolean,
	durationMs: number,
): number | null {
	if (position === null) return null;
	const delta = playing && observedAt !== null ? Math.max(0, serverTime - observedAt + elapsed) : 0;
	return Math.min(Math.max(0, durationMs), Math.max(0, position + delta));
}
