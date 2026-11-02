import type { HistoryRow } from "../core/history";
import type { StationRules } from "../core/types";
import type {
	AppState,
	ContinueAfterView,
	DeviceView,
	GenreAnswer,
	HistoryEntry,
	HistoryRateAnswer,
	HistoryRatingLookup,
	HistoryRatingReceipt,
	HistorySearchAnswer,
	HistorySelectionView,
	ImportSelection,
	InspectQuery,
	LikesView,
	ListeningProfile,
	ObservedSkip,
	ObservedTarget,
	PlaylistCountsView,
	PlaylistView,
	PlayResult,
	PreviewResult,
	RemoteKeyView,
	SelectionPreview,
	StationDetail,
	StationSource,
} from "../shared/api";
import type { SpotifyUsageReport } from "../shared/spotify-usage";
import { pendingMutations } from "./pending-mutations";

/** One occurrence of a song in a saved queue: the session and its entry. */
export interface PlayingOccurrence {
	sessionId: string;
	entryId: string;
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/**
 * Every write is counted as on its way (pending-mutations.ts) from before it
 * is sent until its answer was read and judged, whatever the outcome; the
 * request and its result or error are untouched.
 */
async function call<T>(
	method: string,
	path: string,
	body?: unknown,
	timeoutMs?: number,
): Promise<T> {
	const end = method !== "GET" ? pendingMutations.begin() : null;
	try {
		return await send<T>(method, path, body, timeoutMs);
	} finally {
		end?.();
	}
}

async function send<T>(
	method: string,
	path: string,
	body?: unknown,
	timeoutMs?: number,
): Promise<T> {
	let res: Response;
	try {
		res = await fetch(path, {
			method,
			signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
			credentials: "same-origin",
			headers: {
				...(method !== "GET" ? { "x-ts": "1" } : {}),
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "TimeoutError")
			throw new ApiError(
				0,
				"timeout",
				"Keine rechtzeitige Antwort. Der Befehl könnte am Gerät angekommen sein.",
			);
		throw new ApiError(0, "offline", "Keine Verbindung — bist du online?");
	}
	const text = await res.text();
	let data: unknown = null;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			throw new ApiError(
				res.status,
				"invalid_response",
				"Der Server antwortet gerade nicht richtig. Bitte erneut verbinden.",
			);
		}
	}
	if (!res.ok) {
		const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
		throw new ApiError(res.status, err?.code ?? "error", err?.message ?? "Das hat nicht geklappt.");
	}
	return data as T;
}

export interface NativeDevice {
	id: string;
	name: string;
	provider: "home-assistant";
	seek: boolean;
	resume: boolean;
	pause: boolean;
	queue: boolean;
}
export interface SpotifyCooldownView {
	until: number | null;
	kind: string;
	reason?: string;
	retryAfter: string | null;
	observedAt: number;
	endpoint?: string;
	scope?: "artist-albums" | "devices" | "player" | "history" | "legacy-catalog";
}
export type SpotifyFunction = "devices" | "player" | "history";
export interface SpotifyAvailabilityExperiment {
	testedAt: number;
	outcomes: Record<
		SpotifyFunction,
		{
			state: "available" | "held" | "failed" | "not_tested";
			status?: number;
			kind?: string;
			reason?: string;
			retryAfter?: string | null;
		}
	>;
	controls: "untested";
	catalog: "held" | "untested";
	stopped: boolean;
	devices?: DeviceView[];
}
export interface SpotifyDiagnostics {
	policyVersion?: 2;
	operationCooldowns?: Array<SpotifyCooldownView & { operation: string }>;
	cooldown: SpotifyCooldownView | null;
	artistAlbumsCooldown?: SpotifyCooldownView | null;
	devicesCooldown?: SpotifyCooldownView | null;
	playerCooldown?: SpotifyCooldownView | null;
	historyCooldown?: SpotifyCooldownView | null;
	catalogQuarantine?: SpotifyCooldownView | null;
	availability?: SpotifyAvailabilityExperiment | null;
	recentRequests?: {
		startedAt: number;
		hours: Array<{
			hour: number;
			counts: Record<string, number>;
			firstQuotaAt?: number;
			firstQuotaEndpoint?: string;
			firstQuotaReason?: string;
		}>;
	};
	requests: { hour: number; counts: Record<string, number>; latest: unknown } | null;
}
export const api = {
	nativeDevices: () =>
		call<{ configured: boolean; devices: NativeDevice[] }>("GET", "/api/native/devices"),
	nativePlay: (
		stationId: number,
		deviceId: string,
		expected?: { sessionId?: string; entryId?: string; orderRevision?: number; newQueue?: boolean },
	) =>
		call<{ accepted: boolean }>(
			"POST",
			"/api/native/play",
			{
				stationId,
				deviceId,
				...expected,
			},
			30_000,
		).then((r): PlayResult => ({ ok: r.accepted })),
	nativePlayer: (
		stationId: number,
		deviceId: string,
		action: "resume" | "pause" | "next",
		expected?: { sessionId?: string; entryId?: string; orderRevision?: number },
	) =>
		call<{ accepted: boolean }>(
			"POST",
			"/api/native/player",
			{
				stationId,
				deviceId,
				action,
				...expected,
			},
			30_000,
		).then((r): PlayResult => ({ ok: r.accepted })),
	nativeCancel: (expected?: { sessionId?: string; entryId?: string; orderRevision?: number }) =>
		call<unknown>("POST", "/api/native/cancel", expected),
	spotifyUsage: () => call<SpotifyUsageReport>("GET", "/api/spotify/usage"),
	spotifyDiagnostics: () => call<SpotifyDiagnostics>("GET", "/api/spotify/diagnostics"),
	testSpotifyAvailability: () =>
		call<SpotifyAvailabilityExperiment>("POST", "/api/spotify/availability-test"),
	state: (live = true, fresh = false) =>
		call<AppState>("GET", `/api/state${live ? `?live=1${fresh ? "&refresh=1" : ""}` : ""}`),
	playlists: () => call<PlaylistView[]>("GET", "/api/playlists"),
	onboard: (playlistIds: string[]) => call<unknown>("POST", "/api/onboarding", { playlistIds }),
	station: (id: number) => call<StationDetail>("GET", `/api/stations/${id}`),
	createStation: (input: {
		name: string;
		sources: StationSource[];
		rules?: Partial<StationRules>;
	}) => call<number>("POST", "/api/stations", input),
	updateStation: (
		id: number,
		patch: { name?: string; rules?: Partial<StationRules>; sources?: StationSource[] },
	) => call<unknown>("PATCH", `/api/stations/${id}`, patch),
	deleteStation: (id: number) => call<unknown>("DELETE", `/api/stations/${id}`),
	play: (id: number, deviceId?: string, opts?: { newQueue?: boolean; sessionId?: string }) =>
		call<PlayResult>(
			"POST",
			`/api/stations/${id}/play`,
			{
				...(deviceId ? { deviceId } : {}),
				...opts,
			},
			30_000,
		),
	retrySpotify: (scope?: SpotifyFunction | "artist-albums") =>
		call<unknown>("POST", "/api/spotify/retry", scope ? { scope } : undefined),
	player: (action: "pause" | "resume" | "next", opts?: { sessionId?: string; entryId?: string }) =>
		call<PlayResult>("POST", `/api/player/${action}`, opts, 30_000),
	/**
	 * "Next" on the song Spotify was seen playing outside true-shuffle (NP06):
	 * the target alone. The server looks again first; `observedChanged`: nothing
	 * was sent — look again, never send it again blindly.
	 */
	observedNext: (target: ObservedTarget) =>
		call<PlayResult>("POST", "/api/player/next", { target }, 30_000),
	devices: () => call<DeviceView[]>("GET", "/api/devices"),
	/**
	 * A thumb. With `expected` (the queue occurrence shown when it was given),
	 * "Nie wieder" may skip exactly that occurrence; without it the server only
	 * rates (see docs/HISTORY_RATINGS.md, CTO playback boundary). With an observed
	 * target (NP06) it may skip exactly that observed play; `observedSkip` says how.
	 */
	thumb: (trackId: string, value: -1 | 0 | 1, expected?: PlayingOccurrence | ObservedTarget) =>
		call<{ skipped?: boolean; skipError?: string; observedSkip?: ObservedSkip }>(
			"POST",
			`/api/tracks/${trackId}/thumb`,
			expected ? { value, expected } : { value },
		),
	/** A rating from the Verlauf, under the page's own id (see docs/HISTORY_RATINGS.md). */
	rateFromHistory: (b: { actionId: string; trackId: string; value: -1 | 0 | 1; basis: number }) =>
		call<HistoryRateAnswer>("POST", "/api/history/ratings", b, 15_000),
	/** After a lost answer: stored "no" only when provably not stored; "unknown" otherwise. */
	historyRatingReceipt: (actionId: string, trackId?: string, basis?: number) => {
		const q = new URLSearchParams();
		if (trackId !== undefined) q.set("track", trackId);
		if (basis !== undefined) q.set("basis", String(basis));
		const query = q.toString();
		return call<HistoryRatingLookup>(
			"GET",
			`/api/history/ratings/${encodeURIComponent(actionId)}${query ? `?${query}` : ""}`,
			undefined,
			15_000,
		);
	},
	undoHistoryRating: (actionId: string) =>
		call<{ receipt: HistoryRatingReceipt | null }>(
			"POST",
			`/api/history/ratings/${encodeURIComponent(actionId)}/undo`,
			undefined,
			15_000,
		),
	retestVerdict: (trackId: string, keep: boolean, expected?: PlayingOccurrence) =>
		call<{ skipped?: boolean; skipError?: string }>(
			"POST",
			`/api/tracks/${trackId}/retest`,
			expected ? { keep, expected } : { keep },
		),
	remoteKey: () => call<RemoteKeyView>("GET", "/api/remote"),
	newRemoteKey: () => call<RemoteKeyView>("POST", "/api/remote"),
	dropRemoteKey: () => call<unknown>("DELETE", "/api/remote"),
	guest: (on: boolean, hours?: number) => call<unknown>("POST", "/api/guest", { on, hours }),
	guestDevices: (devices: { id: string; name: string }[]) =>
		call<{ id: string; name: string }[]>("PUT", "/api/guest/devices", { devices }),
	/** Begins an import on purpose; its first block names the answer's `start`. */
	startImport: () => call<{ start: number }>("POST", "/api/history/begin"),
	importHistory: (
		rows: HistoryRow[],
		part: number,
		parts: number,
		upload?: string,
		start?: number,
	) =>
		call<{ stored: number; upload: string }>("POST", "/api/history/import", {
			rows,
			part,
			parts,
			upload,
			start,
		}),
	historySelection: () => call<HistorySelectionView>("GET", "/api/history/selection"),
	/** Read-only: counts and one page of a search under a draft selection. */
	previewSelection: (draft: ImportSelection, query: Partial<InspectQuery>) =>
		call<SelectionPreview>("POST", "/api/history/selection/preview", { ...draft, query }),
	/**
	 * Takes the draft over, on the revision the page showed and the stored
	 * import it was made on (its preview's dataset key) — else 409.
	 */
	applySelection: (baseRevision: number, draft: ImportSelection, dataset: string) =>
		call<HistorySelectionView>("POST", "/api/history/selection", {
			baseRevision,
			...draft,
			dataset,
		}),
	deleteImport: (dataset: string) =>
		call<{ deleted: { songs: number; rows: number; summaryProfile: boolean }; commit: number }>(
			"POST",
			"/api/history/delete",
			{ dataset },
		),
	playlistCounts: () => call<PlaylistCountsView>("GET", "/api/playlist-counts"),
	countPlaylists: () => call<PlaylistCountsView>("POST", "/api/playlist-counts"),
	historySearch: (since = 0) =>
		call<HistorySearchAnswer>("GET", `/api/history/search${since ? `?since=${since}` : ""}`),
	history: (before?: number) =>
		call<HistoryEntry[]>("GET", `/api/history?limit=60${before ? `&before=${before}` : ""}`),
	/**
	 * A listening sample for one Verlauf row (docs/HISTORY_PREVIEW.md). A POST
	 * only so no other site can trigger it; it changes nothing, so it is not
	 * counted as a write on its way.
	 */
	historyPreview: (trackId: string, playedAt: number) =>
		send<PreviewResult>("POST", "/api/history/preview", { trackId, playedAt }, 10_000),
	importListens: (block: {
		/** From the first block's answer; every later block carries it. */
		upload?: string;
		/** The first block names the upload of song totals the plays belong to. */
		importId?: string;
		part: number;
		parts: number;
		tracks: number;
		kind: "tracks" | "rows";
		data: unknown[];
	}) => call<{ stored: number; upload: string }>("POST", "/api/history/listens", block),
	genres: () => call<GenreAnswer>("POST", "/api/profile/genres"),
	/** A period: from inclusive, to exclusive (ms); from null = everything. */
	profile: (
		period: { from: number | null; to: number | null; previousFrom?: number | null } = {
			from: null,
			to: null,
		},
	) =>
		call<ListeningProfile>(
			"GET",
			`/api/profile?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC")}${
				period.from !== null ? `&from=${period.from}` : ""
			}${period.to !== null ? `&to=${period.to}` : ""}${
				period.previousFrom != null ? `&prev=${period.previousFrom}` : ""
			}`,
		),
	sync: () => call<unknown>("POST", "/api/sync"),
	likesSync: () => call<LikesView>("POST", "/api/likes/sync"),
	continueAfter: (trackId: string) =>
		call<ContinueAfterView>("POST", "/api/continue-after", { trackId }),
	cancelContinueAfter: () => call<null>("DELETE", "/api/continue-after"),
	changeVolume: (deviceId: string, step: 1 | -1) =>
		call<{ deviceName: string; volume: number }>("POST", "/api/volume", { deviceId, step }),
	playFromHistory: (trackId: string, playedAt: number, deviceId: string) =>
		call<{ deviceName: string | null }>("POST", "/api/history/play", {
			trackId,
			playedAt,
			deviceId,
		}),
	logout: () => call<unknown>("POST", "/auth/logout"),
	deleteAccount: () => call<{ stuck: string[] }>("DELETE", "/api/account"),
};
