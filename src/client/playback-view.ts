import type { AppState, ObservedTarget, TrackView } from "../shared/api";
import { estimatedProgress } from "./progress";

/** A local display estimate is deliberately bounded across cached observations. */
export const PROJECTION_FRESHNESS_MS = 120_000;

/** What Spotify plays outside true-shuffle's confirmed order (NP06). */
export interface ObservedView {
	/** "outside": another context; "unconfirmed": a station's context, not confirmed as its entry. */
	attribution: "outside" | "unconfirmed";
	deviceName: string | null;
	/** What an answer or an external "next" names; null: rating only, no skip from here. */
	target: ObservedTarget | null;
}

/** The saved true-shuffle place, shown apart while something else is (or may be) playing. */
export interface CheckpointView {
	track: TrackView;
	entryId: string;
	position: number | null;
}

export interface PlaybackView {
	track: TrackView | null;
	entryId: string | null;
	position: number | null;
	playing: boolean;
	estimating: boolean;
	projected: boolean;
	awaitingObservation: boolean;
	/**
	 * "station": true-shuffle's own occurrence (or an older answer without an
	 * observation); "observed": the song Spotify plays outside its confirmed
	 * order; "unavailable": nothing current can be shown (no device, an
	 * unreadable item, no fresh look) — never the saved song in its place.
	 */
	source: "station" | "observed" | "unavailable";
	observed: ObservedView | null;
	unavailable: "none" | "unknown" | "unsupported" | null;
	checkpoint: CheckpointView | null;
}

export interface FrozenView {
	entryId: string | null;
	position: number | null;
	track: TrackView | null;
	projected: boolean;
	/** A command given on an observed song holds that song and its target. */
	observed?: ObservedView | null;
}

/** Read-only: never feed this occurrence or position to a player command/checkpoint. */
export function playbackView(
	state: AppState,
	receivedAt: number,
	now: number,
	stale: boolean,
	frozen?: FrozenView | null,
): PlaybackView {
	const station = stationView(state, receivedAt, now, stale, frozen);
	const session = state.session;
	const o = state.observed;
	const plain = { ...station, source: "station" as const, observed: null, unavailable: null };
	// Older answers carry no observation; a Home Assistant player is not Spotify's.
	if (!o || session?.controller?.kind === "home-assistant") return { ...plain, checkpoint: null };
	const saved = session?.queue.find((e) => e.entryId === session.entryId);
	const checkpoint: CheckpointView | null =
		session && saved
			? { track: saved.track, entryId: saved.entryId, position: session.progressMs }
			: null;
	// A true-shuffle command in flight holds its own (saved) song, as before.
	if (frozen && !frozen.observed) return { ...plain, checkpoint: null };
	if (frozen?.observed)
		return {
			track: frozen.track,
			entryId: null,
			position: frozen.position,
			playing: false,
			estimating: false,
			projected: false,
			awaitingObservation: false,
			source: "observed",
			observed: frozen.observed,
			unavailable: null,
			checkpoint,
		};
	if (o.state === "playing" || o.state === "paused") {
		const own =
			o.attribution === "station" ||
			// The saved entry's own song while a true-shuffle command is unconfirmed: as before.
			(!!session &&
				o.stationId === session.stationId &&
				!!saved &&
				o.track?.id === saved.track.id &&
				session.pending);
		if (own || !o.track) return { ...plain, checkpoint: null };
		const elapsed = Math.max(0, now - receivedAt);
		const age =
			o.checkedAt === null
				? Number.POSITIVE_INFINITY
				: Math.max(0, state.serverTime - o.checkedAt + elapsed);
		const playing = o.state === "playing";
		const estimating = playing && !stale && age <= PROJECTION_FRESHNESS_MS;
		// The hub's position holds the time up to serverTime already: only the
		// time since this answer arrived is added, once.
		const position = estimatedProgress(
			o.progressMs,
			state.serverTime,
			state.serverTime,
			elapsed,
			estimating,
			o.track.durationMs,
		);
		return {
			track: o.track,
			entryId: null,
			position,
			playing,
			estimating,
			projected: false,
			awaitingObservation:
				playing &&
				!stale &&
				(age > PROJECTION_FRESHNESS_MS || (position !== null && position >= o.track.durationMs)),
			source: "observed",
			observed: {
				attribution: o.attribution === "unconfirmed" ? "unconfirmed" : "outside",
				deviceName: o.device?.name ?? null,
				target: o.target,
			},
			unavailable: null,
			checkpoint,
		};
	}
	if (!session) return { ...plain, checkpoint: null };
	return {
		track: null,
		entryId: null,
		position: null,
		playing: false,
		estimating: false,
		projected: false,
		awaitingObservation: false,
		source: "unavailable",
		observed: null,
		unavailable: o.state,
		checkpoint,
	};
}

/** True-shuffle's own occurrence, as before NP06. */
function stationView(
	state: AppState,
	receivedAt: number,
	now: number,
	stale: boolean,
	frozen?: FrozenView | null,
): Omit<PlaybackView, "source" | "observed" | "unavailable" | "checkpoint"> {
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
	const view = {
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
	if (frozen) {
		const { observed: _observed, ...held } = frozen;
		return { ...view, ...held, estimating: false };
	}
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

/**
 * The songs under "Als Nächstes" (P10): after true-shuffle's own song, or
 * after its saved place while Spotify plays another. Never the song shown as
 * playing right now: after a skip the view can already show the next song
 * (observed, or held by the command) while the saved place still points at
 * the one before, and 1.2.0 then listed the playing song a second time.
 */
export function upcomingEntries<E extends { entryId: string; track: { id: string } }>(
	queue: readonly E[],
	view: Pick<PlaybackView, "entryId" | "track" | "checkpoint">,
	limit = 50,
): E[] {
	const after = view.entryId ?? view.checkpoint?.entryId ?? null;
	let list = queue.slice(Math.max(0, queue.findIndex((e) => e.entryId === after) + 1));
	// Only when the view shows a song other than its own entry's (the next one,
	// already playing): the same song twice in a row stays listed twice.
	const own = queue.find((e) => e.entryId === view.entryId)?.track.id;
	if (view.track && list[0]?.track.id === view.track.id && own !== view.track.id)
		list = list.slice(1);
	return list.filter((e) => e.entryId !== view.entryId).slice(0, limit);
}
