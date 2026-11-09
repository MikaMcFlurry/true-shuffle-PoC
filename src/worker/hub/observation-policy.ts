const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

export const OBSERVATION_RETRY_MS = 15 * SECOND_MS;
export const MAX_RECENT_INTERVAL_MS = 30 * MINUTE_MS;

/** Ordinary held playback only; private/guest/guard deadlines may run sooner. */
export function pausedObservationPace(idleForMs: number, guardedFront = false): number {
	if (guardedFront || idleForMs < 5 * MINUTE_MS) return 30 * SECOND_MS;
	if (idleForMs < 30 * MINUTE_MS) return 2 * MINUTE_MS;
	if (idleForMs < 3 * HOUR_MS) return 5 * MINUTE_MS;
	if (idleForMs < 36 * HOUR_MS) return 15 * MINUTE_MS;
	return 30 * MINUTE_MS;
}

export interface ObservationDeadline {
	at: number;
	reason: "initial" | "interval" | "earlier" | "retry";
}

interface DeadlineInput {
	now: number;
	/** Persist only after a successful provider read, including a 204 response. */
	checkedAt: number | null;
	/** Choose this from the last successful observation, not each maintenance wake. */
	intervalMs: number;
	/** Absolute private, guest, guard, command or track-boundary deadlines. */
	earlierAt?: readonly number[];
	/** Failed attempt time, kept separately; clear it on successful observation. */
	failedAt?: number | null;
}

/**
 * Job wakeups cannot postpone an observation: successful read time anchors it.
 * Local retry pacing never changes successful freshness or provider operation holds.
 */
export function observationDeadline(input: DeadlineInput): ObservationDeadline {
	const { now, checkedAt, intervalMs, earlierAt = [], failedAt } = input;
	if (failedAt != null && (checkedAt === null || failedAt >= checkedAt))
		return { at: failedAt + OBSERVATION_RETRY_MS, reason: "retry" };
	if (checkedAt === null) return { at: now, reason: "initial" };
	let deadline: ObservationDeadline = { at: checkedAt + intervalMs, reason: "interval" };
	for (const at of earlierAt) {
		if (Number.isFinite(at) && at < deadline.at) deadline = { at, reason: "earlier" };
	}
	return deadline;
}

interface ForegroundInput {
	now: number;
	checkedAt: number | null;
	playing: boolean;
	/** Original provider observation time; a cache read must never update it. */
	observedAt?: number | null;
	durationMs?: number | null;
	progressMs?: number | null;
	failedAt?: number | null;
}

/** Visible polling reuses paused state for two minutes, active state for 45 seconds. */
export function foregroundObservationDeadline(input: ForegroundInput): ObservationDeadline {
	const { observedAt, durationMs, progressMs } = input;
	const earlierAt: number[] = [];
	if (
		input.playing &&
		input.checkedAt !== null &&
		observedAt != null &&
		durationMs != null &&
		durationMs > 0 &&
		progressMs != null &&
		progressMs >= 0 &&
		Number.isFinite(observedAt + durationMs + progressMs)
	) {
		earlierAt.push(
			Math.max(input.checkedAt + SECOND_MS, observedAt + durationMs - progressMs + SECOND_MS),
		);
	}
	return observationDeadline({
		now: input.now,
		checkedAt: input.checkedAt,
		intervalMs: input.playing ? 45 * SECOND_MS : 2 * MINUTE_MS,
		earlierAt,
		failedAt: input.failedAt,
	});
}
