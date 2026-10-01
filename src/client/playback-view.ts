import type { AppState, TrackView } from "../shared/api";
import { estimatedProgress } from "./progress";

/** A local display estimate is deliberately bounded across cached observations. */
export const PROJECTION_FRESHNESS_MS = 120_000;

export interface PlaybackView {
	track: TrackView | null;
	entryId: string | null;
	position: number | null;
	playing: boolean;
	estimating: boolean;
	projected: boolean;
	awaitingObservation: boolean;
}

/** Read-only: never feed this occurrence or position to a player command/checkpoint. */
export function playbackView(
	state: AppState,
	receivedAt: number,
	now: number,
	stale: boolean,
	frozen?: {
		entryId: string | null;
		position: number | null;
		track: TrackView | null;
		projected: boolean;
	} | null,
): PlaybackView {
	const session = state.session;
	const index = session?.queue.findIndex((entry) => entry.entryId === session.entryId) ?? -1;
	const current = index >= 0 ? session?.queue[index] : null;
	const ownNow =
		state.nowPlaying &&
		state.nowPlaying.stationId === session?.stationId &&
		(!current || state.nowPlaying.id === current.track.id)
			? state.nowPlaying
			: null;
	const track = current?.track ?? ownNow ?? null;
	const playing =
		session?.status === "active" &&
		(!!ownNow?.isPlaying || session.controller?.kind === "home-assistant");
	const observedAt = session ? session.observedAt : (ownNow?.observedAt ?? null);
	const savedPosition = session ? session.progressMs : (ownNow?.progressMs ?? null);
	const elapsed = Math.max(0, now - receivedAt);
	const age =
		observedAt === null
			? Number.POSITIVE_INFINITY
			: Math.max(0, state.serverTime - observedAt + elapsed);
	const estimating =
		!!playing &&
		!stale &&
		!session?.pending &&
		!frozen &&
		observedAt !== null &&
		savedPosition !== null &&
		age <= PROJECTION_FRESHNESS_MS;
	const position =
		frozen && frozen.entryId === session?.entryId
			? frozen.position
			: estimatedProgress(
					savedPosition,
					observedAt,
					state.serverTime,
					elapsed,
					estimating,
					track?.durationMs ?? 0,
				);
	const view: PlaybackView = {
		track,
		entryId: current?.entryId ?? null,
		position,
		playing: !!playing,
		estimating,
		projected: false,
		awaitingObservation:
			!!playing &&
			!stale &&
			!session?.pending &&
			!frozen &&
			!!track &&
			(age > PROJECTION_FRESHNESS_MS || (position !== null && position >= track.durationMs)),
	};
	if (frozen) return { ...view, ...frozen, estimating: false };
	const next = session?.queue[index + 1];
	if (
		!estimating ||
		!track ||
		track.durationMs <= 0 ||
		!next ||
		index < 0 ||
		!ownNow?.isPlaying ||
		ownNow.orderBroken ||
		ownNow.smartShuffle ||
		session?.controller?.kind === "home-assistant" ||
		age > PROJECTION_FRESHNESS_MS ||
		(savedPosition ?? 0) + age - track.durationMs > 30_000 ||
		(savedPosition ?? 0) + age < track.durationMs
	)
		return view;
	// At most one known successor. Repeated cached observations cannot extend the deadline.
	return {
		...view,
		track: next.track,
		entryId: next.entryId,
		position: Math.min(
			next.track.durationMs,
			Math.max(0, (savedPosition ?? 0) + age - track.durationMs),
		),
		projected: true,
		awaitingObservation: false,
	};
}
