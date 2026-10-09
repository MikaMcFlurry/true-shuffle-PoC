import type { StationRules } from "../core/types";
import type {
	AppState,
	DeviceView,
	HistoryEntry,
	PlaylistView,
	PlayResult,
	RemoteKeyView,
	StationDetail,
	StationSource,
} from "../shared/api";
import type { SpotifyUsageReport } from "../shared/spotify-usage";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

async function call<T>(
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
	devices: () => call<DeviceView[]>("GET", "/api/devices"),
	thumb: (trackId: string, value: -1 | 0 | 1) =>
		call<{ skipped?: boolean }>("POST", `/api/tracks/${trackId}/thumb`, { value }),
	remoteKey: () => call<RemoteKeyView>("GET", "/api/remote"),
	newRemoteKey: () => call<RemoteKeyView>("POST", "/api/remote"),
	dropRemoteKey: () => call<unknown>("DELETE", "/api/remote"),
	guest: (on: boolean, hours?: number) => call<unknown>("POST", "/api/guest", { on, hours }),
	guestDevices: (devices: { id: string; name: string }[]) =>
		call<{ id: string; name: string }[]>("PUT", "/api/guest/devices", { devices }),
	importHistory: (rows: [string, number, number, number][], part: number, parts: number) =>
		call<{ stored: number }>("POST", "/api/history/import", { rows, part, parts }),
	history: (before?: number) =>
		call<HistoryEntry[]>("GET", `/api/history?limit=60${before ? `&before=${before}` : ""}`),
	sync: () => call<unknown>("POST", "/api/sync"),
	logout: () => call<unknown>("POST", "/auth/logout"),
	deleteAccount: () => call<{ stuck: string[] }>("DELETE", "/api/account"),
};
