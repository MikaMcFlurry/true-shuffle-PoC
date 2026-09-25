/**
 * Spotify Web API client.
 *
 * Deliberately small: every call True Shuffle makes is listed here, typed,
 * and funnelled through one `request()` that handles token refresh, the
 * error classes the product must react to differently (no Premium, no
 * device, rate limit, exhausted quota) and the per-invocation request
 * budget of the Workers free plan (50 external requests).
 */

import type {
	SpAlbum,
	SpArtist,
	SpCursorPaging,
	SpDevice,
	SpErrorBody,
	SpPaging,
	SpPlaybackState,
	SpPlayHistory,
	SpPlaylist,
	SpPlaylistItem,
	SpSavedTrack,
	SpTokenResponse,
	SpTrack,
	SpUser,
} from "./types";

export const SPOTIFY_SCOPES = [
	"user-read-private",
	"playlist-read-private",
	"playlist-read-collaborative",
	"playlist-modify-private",
	"playlist-modify-public",
	"user-library-read",
	"user-top-read",
	"user-read-recently-played",
	"user-read-playback-state",
	"user-read-currently-playing",
	"user-modify-playback-state",
];

export interface SpotifyEndpoints {
	accountsBase: string;
	apiBase: string;
	clientId: string;
}

export const DEFAULT_ENDPOINTS: Omit<SpotifyEndpoints, "clientId"> = {
	accountsBase: "https://accounts.spotify.com",
	apiBase: "https://api.spotify.com/v1",
};

export interface SpotifyTokens {
	accessToken: string;
	refreshToken: string;
	/** Epoch ms. */
	expiresAt: number;
	scope: string;
}

export interface TokenStore {
	get(): Promise<SpotifyTokens | null>;
	set(tokens: SpotifyTokens): Promise<void>;
}

export type SpotifyErrorKind =
	| "auth" // refresh token revoked or expired — the listener must sign in again
	| "premium" // the player refused because the account is not Premium
	| "no_device" // nothing to play on
	| "restricted" // the device does not accept remote commands
	| "rate" // 429 with Retry-After
	| "quota" // 429 QUOTA_EXCEEDED — waiting a few seconds will not help
	| "forbidden" // other 403 (not allowlisted, not the owner of a playlist, …)
	| "not_found"
	| "bad_request"
	| "server"
	| "network"
	| "budget"; // our own per-invocation request budget is used up

export class SpotifyError extends Error {
	constructor(
		readonly kind: SpotifyErrorKind,
		message: string,
		readonly status = 0,
		readonly retryAfterMs = 0,
		readonly reason?: string,
	) {
		super(message);
		this.name = "SpotifyError";
	}
}

/** Counts external requests made during one Worker/DO invocation. */
export class RequestBudget {
	used = 0;
	constructor(readonly limit: number) {}
	get left(): number {
		return Math.max(0, this.limit - this.used);
	}
	take(n = 1): void {
		if (this.used + n > this.limit) {
			throw new SpotifyError("budget", "Anfragebudget dieses Aufrufs erschöpft");
		}
		this.used += n;
	}
}

export type Fetcher = (input: Request) => Promise<Response>;

export interface ClientOptions {
	endpoints: SpotifyEndpoints;
	tokens: TokenStore;
	budget: RequestBudget;
	fetch: Fetcher;
	now: () => number;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export class SpotifyClient {
	private cached: SpotifyTokens | null = null;

	constructor(private readonly o: ClientOptions) {}

	// ---------------------------------------------------------------------
	// Auth
	// ---------------------------------------------------------------------

	static authorizeUrl(
		e: SpotifyEndpoints,
		redirectUri: string,
		state: string,
		challenge: string,
	): string {
		const u = new URL(`${e.accountsBase}/authorize`);
		u.searchParams.set("client_id", e.clientId);
		u.searchParams.set("response_type", "code");
		u.searchParams.set("redirect_uri", redirectUri);
		u.searchParams.set("state", state);
		u.searchParams.set("scope", SPOTIFY_SCOPES.join(" "));
		u.searchParams.set("code_challenge_method", "S256");
		u.searchParams.set("code_challenge", challenge);
		return u.toString();
	}

	static async exchangeCode(
		e: SpotifyEndpoints,
		fetcher: Fetcher,
		code: string,
		redirectUri: string,
		verifier: string,
		now: number,
	): Promise<SpotifyTokens> {
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: e.clientId,
			code_verifier: verifier,
		});
		const res = await fetcher(
			new Request(`${e.accountsBase}/api/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body,
			}),
		);
		if (!res.ok) throw await toError(res);
		const t = (await res.json()) as SpTokenResponse;
		if (!t.refresh_token)
			throw new SpotifyError("auth", "Spotify hat kein Refresh-Token geliefert");
		return {
			accessToken: t.access_token,
			refreshToken: t.refresh_token,
			expiresAt: now + t.expires_in * 1000,
			scope: t.scope ?? "",
		};
	}

	private async token(force = false): Promise<string> {
		let t = this.cached ?? (await this.o.tokens.get());
		if (!t) throw new SpotifyError("auth", "Nicht mit Spotify verbunden");
		if (force || t.expiresAt - this.o.now() < 120_000) {
			t = await this.refresh(t);
		}
		this.cached = t;
		return t.accessToken;
	}

	private async refresh(t: SpotifyTokens): Promise<SpotifyTokens> {
		this.o.budget.take();
		const body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: t.refreshToken,
			client_id: this.o.endpoints.clientId,
		});
		let res: Response;
		try {
			res = await this.o.fetch(
				new Request(`${this.o.endpoints.accountsBase}/api/token`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body,
				}),
			);
		} catch (err) {
			throw new SpotifyError("network", `Spotify nicht erreichbar: ${String(err)}`);
		}
		if (!res.ok) {
			const e = await toError(res);
			// invalid_grant / invalid_client: the grant is gone for good.
			if (res.status === 400 || res.status === 401) {
				throw new SpotifyError(
					"auth",
					"Spotify-Anmeldung abgelaufen — bitte neu verbinden",
					res.status,
				);
			}
			throw e;
		}
		const r = (await res.json()) as SpTokenResponse;
		const next: SpotifyTokens = {
			accessToken: r.access_token,
			// PKCE refresh tokens rotate; keep the old one if none is returned.
			refreshToken: r.refresh_token ?? t.refreshToken,
			expiresAt: this.o.now() + r.expires_in * 1000,
			scope: r.scope ?? t.scope,
		};
		await this.o.tokens.set(next);
		return next;
	}

	// ---------------------------------------------------------------------
	// Transport
	// ---------------------------------------------------------------------

	async request<T>(
		method: string,
		path: string,
		opts: { query?: Query; body?: unknown } = {},
	): Promise<T | null> {
		const url = new URL(path.startsWith("http") ? path : `${this.o.endpoints.apiBase}${path}`);
		for (const [k, v] of Object.entries(opts.query ?? {})) {
			if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
		}
		let attempt = 0;
		let forced = false;
		for (;;) {
			const token = await this.token(forced);
			this.o.budget.take();
			let res: Response;
			try {
				res = await this.o.fetch(
					new Request(url.toString(), {
						method,
						headers: {
							authorization: `Bearer ${token}`,
							...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
						},
						body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
					}),
				);
			} catch (err) {
				if (attempt++ < 1) continue;
				throw new SpotifyError("network", `Spotify nicht erreichbar: ${String(err)}`);
			}
			if (res.status === 401 && !forced) {
				forced = true;
				continue;
			}
			if (res.status >= 500 && attempt++ < 1) continue;
			if (!res.ok) throw await toError(res);
			if (res.status === 204) return null;
			const text = await res.text();
			if (!text) return null;
			try {
				return JSON.parse(text) as T;
			} catch {
				// Some player endpoints answer 200 with a non-JSON body (a snapshot id string).
				return null;
			}
		}
	}

	// ---------------------------------------------------------------------
	// Profile & library
	// ---------------------------------------------------------------------

	me(): Promise<SpUser | null> {
		return this.request<SpUser>("GET", "/me");
	}

	myPlaylists(offset = 0): Promise<SpPaging<SpPlaylist> | null> {
		return this.request<SpPaging<SpPlaylist>>("GET", "/me/playlists", {
			query: { limit: 50, offset },
		});
	}

	playlist(id: string): Promise<SpPlaylist | null> {
		return this.request<SpPlaylist>("GET", `/playlists/${enc(id)}`, {
			query: {
				fields: "id,name,snapshot_id,owner(id,display_name),images,items(total),uri,collaborative",
			},
		});
	}

	playlistItems(id: string, offset = 0): Promise<SpPaging<SpPlaylistItem> | null> {
		return this.request<SpPaging<SpPlaylistItem>>("GET", `/playlists/${enc(id)}/items`, {
			query: {
				limit: 50,
				offset,
				market: "from_token",
				additional_types: "track",
			},
		});
	}

	likedTracks(offset = 0): Promise<SpPaging<SpSavedTrack> | null> {
		return this.request<SpPaging<SpSavedTrack>>("GET", "/me/tracks", {
			query: { limit: 50, offset, market: "from_token" },
		});
	}

	topArtists(
		range: "short_term" | "medium_term" | "long_term" = "medium_term",
	): Promise<SpPaging<SpArtist> | null> {
		return this.request<SpPaging<SpArtist>>("GET", "/me/top/artists", {
			query: { limit: 50, time_range: range },
		});
	}

	// ---------------------------------------------------------------------
	// Playlists we own (the station decks)
	// ---------------------------------------------------------------------

	createPlaylist(name: string, description: string): Promise<SpPlaylist | null> {
		return this.request<SpPlaylist>("POST", "/me/playlists", {
			body: { name, description, public: false },
		});
	}

	updatePlaylistDetails(id: string, name: string, description: string): Promise<unknown> {
		return this.request("PUT", `/playlists/${enc(id)}`, { body: { name, description } });
	}

	/** Replace all items (max 100). An empty list clears the playlist. */
	replaceItems(id: string, uris: string[]): Promise<unknown> {
		if (uris.length > 100) throw new Error("replaceItems takes at most 100 uris");
		return this.request("PUT", `/playlists/${enc(id)}/items`, { body: { uris } });
	}

	addItems(id: string, uris: string[], position?: number): Promise<unknown> {
		if (uris.length > 100) throw new Error("addItems takes at most 100 uris");
		return this.request("POST", `/playlists/${enc(id)}/items`, {
			body: position === undefined ? { uris } : { uris, position },
		});
	}

	/** "Delete" a playlist we own: Spotify only knows unfollowing it. */
	unfollowPlaylist(id: string): Promise<unknown> {
		return this.request("DELETE", "/me/library", { query: { uris: `spotify:playlist:${id}` } });
	}

	// ---------------------------------------------------------------------
	// Player
	// ---------------------------------------------------------------------

	player(): Promise<SpPlaybackState | null> {
		return this.request<SpPlaybackState>("GET", "/me/player", { query: { market: "from_token" } });
	}

	async devices(): Promise<SpDevice[]> {
		const r = await this.request<{ devices: SpDevice[] }>("GET", "/me/player/devices");
		return r?.devices ?? [];
	}

	recentlyPlayed(after?: number): Promise<SpCursorPaging<SpPlayHistory> | null> {
		return this.request<SpCursorPaging<SpPlayHistory>>("GET", "/me/player/recently-played", {
			query: { limit: 50, after: after && after > 0 ? after : undefined },
		});
	}

	play(opts: {
		contextUri: string;
		position?: number;
		deviceId?: string | null;
	}): Promise<unknown> {
		return this.request("PUT", "/me/player/play", {
			query: { device_id: opts.deviceId ?? undefined },
			body: {
				context_uri: opts.contextUri,
				offset: { position: opts.position ?? 0 },
				position_ms: 0,
			},
		});
	}

	pause(deviceId?: string | null): Promise<unknown> {
		return this.request("PUT", "/me/player/pause", { query: { device_id: deviceId ?? undefined } });
	}

	resume(deviceId?: string | null): Promise<unknown> {
		return this.request("PUT", "/me/player/play", { query: { device_id: deviceId ?? undefined } });
	}

	next(deviceId?: string | null): Promise<unknown> {
		return this.request("POST", "/me/player/next", { query: { device_id: deviceId ?? undefined } });
	}

	setShuffle(state: boolean, deviceId?: string | null): Promise<unknown> {
		return this.request("PUT", "/me/player/shuffle", {
			query: { state, device_id: deviceId ?? undefined },
		});
	}

	setRepeat(state: "off" | "track" | "context", deviceId?: string | null): Promise<unknown> {
		return this.request("PUT", "/me/player/repeat", {
			query: { state, device_id: deviceId ?? undefined },
		});
	}

	// ---------------------------------------------------------------------
	// Catalogue (discovery)
	// ---------------------------------------------------------------------

	artist(id: string): Promise<SpArtist | null> {
		return this.request<SpArtist>("GET", `/artists/${enc(id)}`);
	}

	artistAlbums(id: string, limit = 20, offset = 0): Promise<SpPaging<SpAlbum> | null> {
		return this.request<SpPaging<SpAlbum>>("GET", `/artists/${enc(id)}/albums`, {
			query: { include_groups: "album,single", limit, offset, market: "from_token" },
		});
	}

	album(id: string): Promise<SpAlbum | null> {
		return this.request<SpAlbum>("GET", `/albums/${enc(id)}`, { query: { market: "from_token" } });
	}

	async searchTracks(q: string, limit = 10, offset = 0): Promise<SpTrack[]> {
		const r = await this.request<{ tracks?: SpPaging<SpTrack> }>("GET", "/search", {
			query: { q, type: "track", limit: Math.min(10, limit), offset, market: "from_token" },
		});
		return r?.tracks?.items ?? [];
	}
}

function enc(id: string): string {
	return encodeURIComponent(id);
}

async function toError(res: Response): Promise<SpotifyError> {
	let body: SpErrorBody = {};
	try {
		body = (await res.json()) as SpErrorBody;
	} catch {
		/* not JSON */
	}
	const err = typeof body.error === "object" ? body.error : undefined;
	const reason = err?.reason;
	const message =
		err?.message ??
		(typeof body.error === "string" ? body.error : undefined) ??
		body.error_description ??
		res.statusText;
	const status = res.status;
	if (status === 429) {
		const retryAfter = Number(res.headers.get("retry-after") ?? "0");
		if (reason === "QUOTA_EXCEEDED" || /quota/i.test(message ?? "")) {
			return new SpotifyError(
				"quota",
				"Spotify-Kontingent dieser App ist aufgebraucht",
				status,
				3_600_000,
				reason,
			);
		}
		return new SpotifyError(
			"rate",
			"Spotify bremst gerade (zu viele Anfragen)",
			status,
			Math.max(1, retryAfter) * 1000,
			reason,
		);
	}
	if (status === 403) {
		if (reason === "PREMIUM_REQUIRED" || /premium/i.test(message ?? "")) {
			return new SpotifyError(
				"premium",
				"Für die Wiedergabesteuerung braucht Spotify ein Premium-Konto",
				status,
				0,
				reason,
			);
		}
		if (reason === "UNKNOWN" && /restricted/i.test(message ?? "")) {
			return new SpotifyError(
				"restricted",
				"Dieses Gerät nimmt keine Befehle an",
				status,
				0,
				reason,
			);
		}
		return new SpotifyError("forbidden", message || "Zugriff verweigert", status, 0, reason);
	}
	if (status === 404) {
		if (reason === "NO_ACTIVE_DEVICE" || /device/i.test(message ?? "")) {
			return new SpotifyError(
				"no_device",
				"Kein aktives Spotify-Gerät gefunden",
				status,
				0,
				reason,
			);
		}
		return new SpotifyError("not_found", message || "Nicht gefunden", status, 0, reason);
	}
	if (status === 401)
		return new SpotifyError("auth", "Spotify-Anmeldung ungültig", status, 0, reason);
	if (status >= 500)
		return new SpotifyError("server", `Spotify-Fehler ${status}`, status, 0, reason);
	return new SpotifyError("bad_request", message || `HTTP ${status}`, status, 0, reason);
}
