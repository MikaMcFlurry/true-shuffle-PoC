/**
 * Spotify Web API client.
 *
 * Deliberately small: every call true-shuffle makes is listed here, typed,
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
		readonly retryAfter: string | null = null,
		readonly scope?: SpotifyCooldownScope,
		readonly endpoint?: string,
		readonly operation?: string,
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

/** Account-owned provider gate. A null deadline is unknown, never a guessed reset. */
export type SpotifyCooldownScope =
	| "artist-albums"
	| "devices"
	| "player"
	| "history"
	| "legacy-catalog";
export const SPOTIFY_COOLDOWN_SCOPES: SpotifyCooldownScope[] = [
	"artist-albums",
	"devices",
	"player",
	"history",
	"legacy-catalog",
];
export function readScope(endpoint: string): SpotifyCooldownScope | undefined {
	return (
		{
			"/artists/:id/albums": "artist-albums",
			"/me/player/devices": "devices",
			"/me/player": "player",
			"/me/player/recently-played": "history",
		} as Record<string, SpotifyCooldownScope>
	)[endpoint];
}
export function eligibleLegacy(c: SpotifyCooldown | null): c is SpotifyCooldown {
	return !!c && !c.scope && !c.endpoint && c.kind === "quota" && c.reason === "QUOTA_EXCEEDED";
}
export const ARTIST_ALBUMS_ENDPOINT = "/artists/:id/albums";

export interface SpotifyCooldown {
	operation?: string;
	scope?: SpotifyCooldownScope;
	endpoint?: string;
	/** Private provider source; never exposed in diagnostics. */
	probePath?: string;
	until: number | null;
	kind: "rate" | "quota";
	reason?: string;
	retryAfter: string | null;
	observedAt: number;
}
export interface SpotifyRequestMetric {
	startedAt?: number;
	method?: string;
	operation?: string;
	endpoint: string;
	category: "read" | "write" | "refresh";
	status: number;
	reason?: string;
	retryAfter: string | null;
	retryCategory: "none" | "auth" | "server" | "network" | "rate" | "quota" | "blocked";
	at: number;
}
export interface SpotifyRequestPolicy {
	getOperationSnapshot?(
		operation: string,
	):
		| { revision: number; cooldown: SpotifyCooldown | null }
		| Promise<{ revision: number; cooldown: SpotifyCooldown | null }>;
	setOperationCooldown?(value: SpotifyCooldown): void | Promise<void>;
	finishOperation?(operation: string, revision: number): void | Promise<void>;
	getCooldown(
		scope?: SpotifyCooldownScope,
	): SpotifyCooldown | null | Promise<SpotifyCooldown | null>;
	setCooldown(value: SpotifyCooldown): void | Promise<void>;
	record?(metric: SpotifyRequestMetric): void | Promise<void>;
}

export interface ClientOptions {
	endpoints: SpotifyEndpoints;
	tokens: TokenStore;
	budget: RequestBudget;
	fetch: Fetcher;
	now: () => number;
	policy?: SpotifyRequestPolicy;
	requestTimeoutMs?: number;
	singleTransport?: boolean;
	allowUnknownRetry?: boolean;
	/** Deterministic timeout injection for the transport harness. */
	timeoutSignal?: (timeoutMs: number) => AbortSignal;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export class SpotifyClient {
	private cached: SpotifyTokens | null = null;
	private operationCooldowns = new Map<string, SpotifyCooldown>();
	private operationRevisions = new Map<string, number>();
	private failedOperations = new Set<string>();
	private refreshes = 0;

	constructor(private readonly o: ClientOptions) {}

	/** Requests this invocation may still make. */
	get requestsLeft(): number {
		return this.o.budget.left;
	}

	private async fetchBounded(request: Request): Promise<Response> {
		const timeoutMs = this.o.requestTimeoutMs ?? 15_000;
		const signal = this.o.timeoutSignal?.(timeoutMs) ?? AbortSignal.timeout(timeoutMs);
		signal.throwIfAborted();
		return new Promise<Response>((resolve, reject) => {
			const abort = () =>
				reject(new SpotifyError("network", "Spotify hat nicht rechtzeitig geantwortet"));
			signal.addEventListener("abort", abort, { once: true });
			this.o
				.fetch(new Request(request, { signal }))
				.then(resolve, reject)
				.finally(() => signal.removeEventListener("abort", abort));
		});
	}

	private async guard(
		endpoint: string,
		category: SpotifyRequestMetric["category"],
		method = category === "refresh" ? "POST" : "GET",
	): Promise<{ revision: number; generation: number; hadCooldown: boolean }> {
		const operation = `${method} ${endpoint}`;
		const snapshot = await this.o.policy?.getOperationSnapshot?.(operation);
		const generation = this.operationRevisions.get(operation) ?? 0;
		const c = snapshot ? snapshot.cooldown : this.operationCooldowns.get(operation);
		if (
			c?.operation === operation &&
			((c.until !== null && c.until > this.o.now()) ||
				(c.until === null &&
					(this.failedOperations.has(operation) || this.o.allowUnknownRetry === false)))
		) {
			await this.metric(endpoint, category, 429, "blocked", c.reason, c.retryAfter, method);
			throw new SpotifyError(
				c.kind,
				"Spotify hat diese Anfrage vorübergehend gesperrt",
				429,
				c.until === null ? 0 : c.until - this.o.now(),
				c.reason,
				c.retryAfter,
				c.scope,
				c.endpoint,
				operation,
			);
		}
		return { revision: snapshot?.revision ?? generation, generation, hadCooldown: !!c };
	}
	private async succeeded(
		endpoint: string,
		method: string,
		fence: { revision: number; generation: number; hadCooldown: boolean },
	): Promise<void> {
		const operation = `${method} ${endpoint}`;
		// Ordinary successes have no saved hold to clear. Avoid a shared write
		// and readback; a newer concurrent hold remains untouched. Real recovery
		// still uses the exact revision captured immediately before transport.
		if (fence.hadCooldown) await this.o.policy?.finishOperation?.(operation, fence.revision);
		if ((this.operationRevisions.get(operation) ?? 0) === fence.generation) {
			this.operationCooldowns.delete(operation);
			this.failedOperations.delete(operation);
		}
	}

	private async metric(
		endpoint: string,
		category: SpotifyRequestMetric["category"],
		status: number,
		retryCategory: SpotifyRequestMetric["retryCategory"],
		reason?: string,
		retryAfter: string | null = null,
		method = category === "refresh" ? "POST" : category === "read" ? "GET" : "WRITE",
		startedAt?: number,
	): Promise<void> {
		await this.o.policy?.record?.({
			operation: `${method} ${endpoint}`,
			method,
			startedAt,
			endpoint,
			category,
			status,
			retryCategory,
			reason,
			retryAfter,
			at: this.o.now(),
		});
	}

	private async failure(
		res: Response,
		endpoint?: string,
		method?: string,
		path?: string,
	): Promise<SpotifyError> {
		const parsed = await toError(res, this.o.now());
		const scope =
			parsed.kind === "quota" && parsed.reason === "QUOTA_EXCEEDED" && method === "GET"
				? readScope(endpoint ?? "")
				: undefined;
		const error = new SpotifyError(
			parsed.kind,
			parsed.message,
			parsed.status,
			parsed.retryAfterMs,
			parsed.reason,
			parsed.retryAfter,
			scope,
			endpoint,
			`${method} ${endpoint}`,
		);
		if (error.kind === "rate" || error.kind === "quota") {
			const operation = `${method} ${endpoint}`;
			const previous = this.operationCooldowns.get(operation);
			const proposed = error.retryAfter === null ? null : this.o.now() + error.retryAfterMs;
			const until =
				previous?.until !== null && previous?.until !== undefined && previous.until > this.o.now()
					? Math.max(previous.until, proposed ?? 0)
					: proposed;
			const c: SpotifyCooldown = {
				operation,
				scope,
				endpoint,
				probePath: scope === "artist-albums" && validArtistAlbumsProbe(path) ? path : undefined,
				until,
				kind: error.kind,
				reason: error.reason,
				retryAfter: error.retryAfter,
				observedAt: this.o.now(),
			};
			this.operationRevisions.set(operation, (this.operationRevisions.get(operation) ?? 0) + 1);
			this.operationCooldowns.set(operation, c);
			this.failedOperations.add(operation);
			if (this.o.policy?.setOperationCooldown) await this.o.policy.setOperationCooldown(c);
			else await this.o.policy?.setCooldown(c);
		}
		return error;
	}

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
		policy?: SpotifyRequestPolicy,
	): Promise<SpotifyTokens> {
		const transport = new SpotifyClient({
			endpoints: e,
			fetch: fetcher,
			now: () => now,
			policy,
			budget: new RequestBudget(1),
			tokens: { get: async () => null, set: async () => {} },
		});
		const fence = await transport.guard("/api/token", "refresh");
		transport.o.budget.take();
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: e.clientId,
			code_verifier: verifier,
		});
		const startedAt = transport.o.now();
		let res: Response;
		try {
			res = await transport.fetchBounded(
				new Request(`${e.accountsBase}/api/token`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body,
				}),
			);
		} catch {
			await transport.metric(
				"/api/token",
				"refresh",
				0,
				"network",
				undefined,
				null,
				"POST",
				startedAt,
			);
			throw new SpotifyError("network", "Spotify nicht erreichbar");
		}
		if (!res.ok) {
			const error = await transport.failure(res, "/api/token", "POST");
			await transport.metric(
				"/api/token",
				"refresh",
				res.status,
				error.kind === "rate" || error.kind === "quota" ? error.kind : "none",
				error.reason,
				error.retryAfter,
				"POST",
				startedAt,
			);
			throw error;
		}
		await transport.metric(
			"/api/token",
			"refresh",
			res.status,
			"none",
			undefined,
			null,
			"POST",
			startedAt,
		);
		await transport.succeeded("/api/token", "POST", fence);
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
		if (this.o.singleTransport && this.refreshes >= 1)
			throw new SpotifyError("auth", "Spotify-Anmeldung konnte nicht bestätigt werden", 401);
		this.refreshes++;
		const fence = await this.guard("/api/token", "refresh");
		this.o.budget.take();
		const body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: t.refreshToken,
			client_id: this.o.endpoints.clientId,
		});
		const startedAt = this.o.now();
		let res: Response;
		try {
			res = await this.fetchBounded(
				new Request(`${this.o.endpoints.accountsBase}/api/token`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body,
				}),
			);
		} catch {
			await this.metric("/api/token", "refresh", 0, "network", undefined, null, "POST", startedAt);
			throw new SpotifyError(
				"network",
				"Spotify nicht erreichbar",
				0,
				0,
				undefined,
				null,
				undefined,
				"/api/token",
				"POST /api/token",
			);
		}
		if (!res.ok) {
			const e = await this.failure(res, "/api/token", "POST");
			await this.metric(
				"/api/token",
				"refresh",
				res.status,
				e.kind === "quota" || e.kind === "rate" ? e.kind : "none",
				e.reason,
				e.retryAfter,
				"POST",
				startedAt,
			);
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
		await this.metric(
			"/api/token",
			"refresh",
			res.status,
			"none",
			undefined,
			null,
			"POST",
			startedAt,
		);
		await this.succeeded("/api/token", "POST", fence);
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
		inputMethod: string,
		path: string,
		opts: { query?: Query; body?: unknown } = {},
	): Promise<T | null> {
		const method = inputMethod.toUpperCase();
		const url = new URL(path.startsWith("http") ? path : `${this.o.endpoints.apiBase}${path}`);
		const base = new URL(this.o.endpoints.apiBase);
		if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`))
			throw new SpotifyError("bad_request", "Unzulässiges Spotify-Ziel");
		const endpoint = sanitizedEndpoint(url.pathname.slice(base.pathname.length));
		const category = method === "GET" ? "read" : "write";
		for (const [k, v] of Object.entries(opts.query ?? {})) {
			if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
		}
		let attempt = 0;
		let forced = false;
		for (;;) {
			await this.guard(endpoint, category, method);
			const token = await this.token(forced);
			const fence = await this.guard(endpoint, category, method);
			this.o.budget.take();
			const startedAt = this.o.now();
			let res: Response;
			try {
				res = await this.fetchBounded(
					new Request(url.toString(), {
						method,
						headers: {
							authorization: `Bearer ${token}`,
							...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
						},
						body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
					}),
				);
			} catch {
				await this.metric(endpoint, category, 0, "network", undefined, null, method, startedAt);
				if (!this.o.singleTransport && method === "GET" && attempt++ < 1) continue;
				throw new SpotifyError(
					"network",
					"Spotify nicht erreichbar",
					0,
					0,
					undefined,
					null,
					undefined,
					endpoint,
					`${method} ${endpoint}`,
				);
			}
			if (!this.o.singleTransport && res.status === 401 && !forced) {
				await this.metric(
					endpoint,
					category,
					res.status,
					"auth",
					undefined,
					null,
					method,
					startedAt,
				);
				forced = true;
				continue;
			}
			if (!this.o.singleTransport && method === "GET" && res.status >= 500 && attempt++ < 1) {
				await this.metric(
					endpoint,
					category,
					res.status,
					"server",
					undefined,
					null,
					method,
					startedAt,
				);
				continue;
			}
			if (!res.ok) {
				const error = await this.failure(
					res,
					endpoint,
					method,
					url.pathname.slice(base.pathname.length),
				);
				await this.metric(
					endpoint,
					category,
					res.status,
					error.kind === "rate" || error.kind === "quota" ? error.kind : "none",
					error.reason,
					error.retryAfter,
					method,
					startedAt,
				);
				throw error;
			}
			await this.metric(endpoint, category, res.status, "none", undefined, null, method, startedAt);
			await this.succeeded(endpoint, method, fence);
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
		progressMs?: number;
		deviceId?: string | null;
	}): Promise<unknown> {
		return this.request("PUT", "/me/player/play", {
			query: { device_id: opts.deviceId ?? undefined },
			body: {
				context_uri: opts.contextUri,
				offset: { position: opts.position ?? 0 },
				position_ms: Math.max(0, Math.floor(opts.progressMs ?? 0)),
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

async function toError(res: Response, now: number): Promise<SpotifyError> {
	let body: SpErrorBody = {};
	try {
		body = (await res.json()) as SpErrorBody;
	} catch {
		/* not JSON */
	}
	const err = typeof body.error === "object" ? body.error : undefined;
	const reason = safeReason(err?.reason);
	const message =
		err?.message ??
		(typeof body.error === "string" ? body.error : undefined) ??
		body.error_description ??
		res.statusText;
	const status = res.status;
	if (status === 429) {
		const raw = res.headers.get("retry-after");
		const retry = parseRetryAfter(raw, now);
		const kind = reason === "QUOTA_EXCEEDED" ? "quota" : "rate";
		return new SpotifyError(
			kind,
			kind === "quota"
				? "Spotify-Kontingent dieser App ist aufgebraucht"
				: "Spotify bremst gerade (zu viele Anfragen)",
			status,
			retry?.ms ?? 0,
			reason,
			retry?.raw ?? null,
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
		if (
			reason === "RESTRICTION_VIOLATED" ||
			(reason === "UNKNOWN" && /restricted/i.test(message ?? ""))
		) {
			return new SpotifyError(
				"restricted",
				"Dieses Gerät nimmt keine Befehle an",
				status,
				0,
				reason,
			);
		}
		return new SpotifyError("forbidden", "Zugriff verweigert", status, 0, reason);
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
		return new SpotifyError("not_found", "Nicht gefunden", status, 0, reason);
	}
	if (status === 401)
		return new SpotifyError("auth", "Spotify-Anmeldung ungültig", status, 0, reason);
	if (status >= 500)
		return new SpotifyError("server", `Spotify-Fehler ${status}`, status, 0, reason);
	return new SpotifyError(
		"bad_request",
		`Spotify-Anfrage fehlgeschlagen (HTTP ${status})`,
		status,
		0,
		reason,
	);
}

function safeReason(reason: unknown): string | undefined {
	const allowed = [
		"QUOTA_EXCEEDED",
		"PREMIUM_REQUIRED",
		"NO_ACTIVE_DEVICE",
		"RESTRICTION_VIOLATED",
		"UNKNOWN",
	];
	return typeof reason === "string" && allowed.includes(reason) ? reason : undefined;
}

export function parseRetryAfter(
	raw: string | null,
	now: number,
): { raw: string; ms: number } | null {
	if (raw === null) return null;
	const value = raw.trim();
	if (/^\d+(?:\.\d+)?$/.test(value)) {
		const ms = Number(value) * 1000;
		return Number.isFinite(ms) ? { raw: value, ms: Math.max(0, ms) } : null;
	}
	// Only canonical HTTP dates are retained; arbitrary header text never enters diagnostics.
	if (
		!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
	)
		return null;
	const deadline = Date.parse(value);
	return Number.isFinite(deadline) ? { raw: value, ms: Math.max(0, deadline - now) } : null;
}

function sanitizedEndpoint(path: string): string {
	const known = new Set([
		"me",
		"player",
		"devices",
		"recently-played",
		"play",
		"pause",
		"next",
		"shuffle",
		"repeat",
		"seek",
		"playlists",
		"items",
		"tracks",
		"top",
		"artists",
		"albums",
		"search",
		"library",
	]);
	return path
		.split("/")
		.map((part) => (!part || known.has(part) ? part : ":id"))
		.join("/");
}

export function validArtistAlbumsProbe(path: unknown): path is string {
	return typeof path === "string" && /^\/artists\/[a-zA-Z0-9]{22}\/albums$/.test(path);
}
export function publicCooldown(
	c: SpotifyCooldown | null,
): Omit<SpotifyCooldown, "probePath"> | null {
	if (!c) return null;
	const { probePath: _privateSource, ...safe } = c;
	return safe;
}
