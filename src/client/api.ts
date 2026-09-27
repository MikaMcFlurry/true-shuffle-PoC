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

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	let res: Response;
	try {
		res = await fetch(path, {
			method,
			credentials: "same-origin",
			headers: {
				...(method !== "GET" ? { "x-ts": "1" } : {}),
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
	} catch {
		throw new ApiError(0, "offline", "Keine Verbindung — bist du online?");
	}
	const text = await res.text();
	const data = text ? (JSON.parse(text) as unknown) : null;
	if (!res.ok) {
		const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
		throw new ApiError(res.status, err?.code ?? "error", err?.message ?? "Das hat nicht geklappt.");
	}
	return data as T;
}

export const api = {
	state: (live = true) => call<AppState>("GET", `/api/state${live ? "?live=1" : ""}`),
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
	play: (id: number, deviceId?: string) =>
		call<PlayResult>("POST", `/api/stations/${id}/play`, deviceId ? { deviceId } : {}),
	player: (action: "pause" | "resume" | "next") =>
		call<PlayResult>("POST", `/api/player/${action}`),
	devices: () => call<DeviceView[]>("GET", "/api/devices"),
	thumb: (trackId: string, value: -1 | 0 | 1) =>
		call<{ skipped?: boolean }>("POST", `/api/tracks/${trackId}/thumb`, { value }),
	remoteKey: () => call<RemoteKeyView>("GET", "/api/remote"),
	newRemoteKey: () => call<RemoteKeyView>("POST", "/api/remote"),
	dropRemoteKey: () => call<unknown>("DELETE", "/api/remote"),
	guest: (on: boolean, hours?: number) => call<unknown>("POST", "/api/guest", { on, hours }),
	importHistory: (rows: [string, number, number, number][], part: number, parts: number) =>
		call<{ stored: number }>("POST", "/api/history/import", { rows, part, parts }),
	history: (before?: number) =>
		call<HistoryEntry[]>("GET", `/api/history?limit=60${before ? `&before=${before}` : ""}`),
	sync: () => call<unknown>("POST", "/api/sync"),
	logout: () => call<unknown>("POST", "/auth/logout"),
	deleteAccount: () => call<{ stuck: string[] }>("DELETE", "/api/account"),
};
