/**
 * A behavioural fake of the Spotify Web API (February 2026 shapes) with a
 * player simulator, plus the two discovery side services (Last.fm, Deezer).
 *
 * It is used twice: in-process by the hub integration tests (with a fake
 * clock), and behind a local HTTP server by the Playwright end-to-end tests.
 *
 * The player simulates what matters for True Shuffle:
 *  - a playlist context plays its items in order (or shuffled when the
 *    listener has shuffle on), reading the playlist's contents LIVE;
 *  - recently-played records a song only once 30 s of it were heard, and
 *    can be told to drop the context (as Spotify does for some API plays);
 *  - when a context runs out, Autoplay starts foreign songs;
 *  - the listener can skip, pause, switch context or toggle shuffle.
 */

export interface FakeTrack {
	id: string;
	name: string;
	artistId: string;
	artistName: string;
	albumId: string;
	albumName: string;
	durationMs: number;
	releaseDate: string;
	playable: boolean;
	isLocal?: boolean;
}

export interface FakePlaylist {
	id: string;
	name: string;
	ownerId: string;
	items: string[]; // track ids
	snapshot: number;
	public: boolean;
	description: string;
	followedBy: Set<string>;
}

export interface FakeUser {
	id: string;
	name: string;
	premium: boolean;
	liked: string[];
	recent: { trackId: string; playedAt: number; contextUri: string | null }[];
	devices: { id: string; name: string; type: string; restricted: boolean }[];
	player: PlayerSim;
}

export interface PlayerSim {
	deviceId: string | null;
	contextUri: string | null;
	order: string[]; // resolved play order (track ids) — reflects context at play time + live appends
	index: number;
	progressMs: number;
	listenedMs: number; // heard of the current track (for the 30 s rule)
	isPlaying: boolean;
	shuffle: boolean;
	smartShuffle: boolean;
	repeat: "off" | "track" | "context";
	autoplay: boolean;
	userQueue: string[];
	currentFromQueue: string | null;
}

export interface FakeOptions {
	now?: () => number;
	/** Drop the context of recently-played entries for plays we started via API. */
	nullContextForApiPlays?: boolean;
	/** Emulate the client bug: a `uris` play keeps only the first uri. */
	urisFirstOnly?: boolean;
	/** Page size cap for playlist items (Spotify: 50). */
	pageSize?: number;
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function fakeId(prefix: string, n: number): string {
	let s = "";
	let x = n;
	do {
		s = B62[x % 62] + s;
		x = Math.floor(x / 62);
	} while (x > 0);
	return `${prefix}${s.padStart(22 - prefix.length, "0")}`.slice(0, 22);
}

export class FakeSpotify {
	readonly tracks = new Map<string, FakeTrack>();
	readonly playlists = new Map<string, FakePlaylist>();
	readonly users = new Map<string, FakeUser>();
	readonly tokens = new Map<string, { userId: string; expiresAt: number }>();
	readonly refreshTokens = new Map<string, string>(); // refresh -> userId
	readonly codes = new Map<string, { userId: string; challenge: string; redirectUri: string }>();
	/** Every API call, for assertions: "GET /v1/me/player". */
	readonly calls: string[] = [];
	now: () => number;
	opts: FakeOptions;
	private seq = 1;
	defaultUserId = "mika";
	/** Force the next N API requests to answer with this status. */
	failNext: {
		status: number;
		count: number;
		body?: unknown;
		headers?: Record<string, string>;
	} | null = null;

	constructor(opts: FakeOptions = {}) {
		this.opts = opts;
		this.now = opts.now ?? (() => Date.now());
	}

	// ------------------------------------------------------------------
	// Seeding
	// ------------------------------------------------------------------

	addTracks(
		n: number,
		opts: { artists?: number; prefix?: string; durationMs?: number } = {},
	): FakeTrack[] {
		const artists = opts.artists ?? Math.max(1, Math.floor(n / 5));
		const out: FakeTrack[] = [];
		for (let i = 0; i < n; i++) {
			const k = this.tracks.size;
			const a = k % artists;
			const t: FakeTrack = {
				id: fakeId(opts.prefix ?? "T", k),
				name: `Song ${k}`,
				artistId: fakeId("A", a),
				artistName: `Artist ${a}`,
				albumId: fakeId("L", Math.floor(k / 10)),
				albumName: `Album ${Math.floor(k / 10)}`,
				durationMs: opts.durationMs ?? 180_000 + (k % 7) * 10_000,
				releaseDate: `20${String(10 + (k % 16)).padStart(2, "0")}-01-01`,
				playable: true,
			};
			this.tracks.set(t.id, t);
			out.push(t);
		}
		return out;
	}

	addUser(id: string, opts: { premium?: boolean; name?: string } = {}): FakeUser {
		const u: FakeUser = {
			id,
			name: opts.name ?? id,
			premium: opts.premium ?? true,
			liked: [],
			recent: [],
			devices: [{ id: `${id}-phone`, name: "iPhone", type: "Smartphone", restricted: false }],
			player: {
				deviceId: null,
				contextUri: null,
				order: [],
				index: 0,
				progressMs: 0,
				listenedMs: 0,
				isPlaying: false,
				shuffle: false,
				smartShuffle: false,
				repeat: "off",
				autoplay: true,
				userQueue: [],
				currentFromQueue: null,
			},
		};
		this.users.set(id, u);
		return u;
	}

	addPlaylist(ownerId: string, name: string, trackIds: string[], id?: string): FakePlaylist {
		const pid = id ?? fakeId("P", this.playlists.size + 1);
		const p: FakePlaylist = {
			id: pid,
			name,
			ownerId,
			items: trackIds.slice(),
			snapshot: 1,
			public: true,
			description: "",
			followedBy: new Set([ownerId]),
		};
		this.playlists.set(pid, p);
		return p;
	}

	issueToken(userId: string): string {
		const t = `at-${userId}-${this.seq++}`;
		this.tokens.set(t, { userId, expiresAt: this.now() + 3_600_000 });
		return t;
	}

	// ------------------------------------------------------------------
	// Player simulation (listener side)
	// ------------------------------------------------------------------

	user(id = this.defaultUserId): FakeUser {
		const u = this.users.get(id);
		if (!u) throw new Error(`no fake user ${id}`);
		return u;
	}

	current(userId = this.defaultUserId): string | null {
		const p = this.user(userId).player;
		if (p.currentFromQueue) return p.currentFromQueue;
		return p.order[p.index] ?? null;
	}

	private resolveContext(uri: string, startIndex: number, shuffle: boolean): string[] {
		const m = /^spotify:playlist:(.+)$/.exec(uri);
		if (!m) return [];
		const pl = this.playlists.get(m[1]!);
		if (!pl) return [];
		const items = pl.items.filter((id) => this.tracks.get(id)?.playable !== false);
		if (!shuffle) return items;
		const first = items[startIndex];
		const rest = items.filter((_, i) => i !== startIndex);
		for (let i = rest.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[rest[i], rest[j]] = [rest[j]!, rest[i]!];
		}
		return first ? [first, ...rest] : rest;
	}

	/** Start a context the way a Spotify client does. */
	startContext(
		userId: string,
		uri: string,
		position: number,
		deviceId: string,
		viaApi: boolean,
	): void {
		const u = this.user(userId);
		const p = u.player;
		p.deviceId = deviceId;
		p.contextUri = uri;
		p.order = this.resolveContext(uri, position, p.shuffle || p.smartShuffle);
		p.index = p.shuffle || p.smartShuffle ? 0 : position;
		p.progressMs = 0;
		p.listenedMs = 0;
		p.isPlaying = p.order.length > 0;
		p.currentFromQueue = null;
		(p as PlayerSim & { viaApi?: boolean }).viaApi = viaApi;
	}

	/** The listener plays a single song outside any context. */
	playSong(userId: string, trackId: string): void {
		const p = this.user(userId).player;
		p.contextUri = null;
		p.order = [trackId];
		p.index = 0;
		p.progressMs = 0;
		p.listenedMs = 0;
		p.isPlaying = true;
		p.currentFromQueue = null;
		p.deviceId ??= this.user(userId).devices[0]!.id;
	}

	private recordIfHeard(u: FakeUser, trackId: string | null, at: number): void {
		const p = u.player;
		if (!trackId || p.listenedMs < 30_000) return;
		const viaApi = (p as PlayerSim & { viaApi?: boolean }).viaApi;
		const ctx = p.currentFromQueue ? p.contextUri : p.contextUri;
		u.recent.unshift({
			trackId,
			playedAt: at,
			contextUri: this.opts.nullContextForApiPlays && viaApi ? null : ctx,
		});
		if (u.recent.length > 200) u.recent.length = 200;
	}

	private moveNext(u: FakeUser, at: number): void {
		const p = u.player;
		this.recordIfHeard(u, this.current(u.id), at);
		p.progressMs = 0;
		p.listenedMs = 0;
		// Spotify plays the listener's own queue before continuing the context.
		// While it does, `index` keeps pointing at the context item that ended.
		if (p.userQueue.length > 0) {
			p.currentFromQueue = p.userQueue.shift()!;
			return;
		}
		p.currentFromQueue = null;
		p.index++;
		// Live context: pick up items appended since playback started.
		if (p.contextUri && !p.shuffle && !p.smartShuffle) {
			const live = this.resolveContext(p.contextUri, 0, false);
			if (live.length > p.order.length && live.slice(0, p.order.length).join() === p.order.join()) {
				p.order = live;
			}
		}
		if (p.index >= p.order.length) {
			if (p.repeat === "context" && p.order.length > 0) {
				p.index = 0;
				return;
			}
			if (p.autoplay) {
				const foreign = [...this.tracks.values()].find(
					(t) => !p.order.includes(t.id) && t.playable,
				);
				if (foreign) {
					p.contextUri = null;
					p.order = [foreign.id];
					p.index = 0;
					return;
				}
			}
			p.isPlaying = false;
			p.index = Math.max(0, p.order.length - 1);
		}
	}

	/** Let `ms` of playback happen. */
	advance(ms: number, userId = this.defaultUserId): void {
		const u = this.user(userId);
		const p = u.player;
		let left = ms;
		let t = this.now() - ms;
		let guard = 0;
		while (left > 0 && p.isPlaying && guard++ < 100_000) {
			const id = this.current(userId);
			const track = id ? this.tracks.get(id) : undefined;
			if (!track) {
				p.isPlaying = false;
				break;
			}
			const remaining = track.durationMs - p.progressMs;
			if (left < remaining) {
				p.progressMs += left;
				p.listenedMs += left;
				break;
			}
			left -= remaining;
			t += remaining;
			p.listenedMs += remaining;
			p.progressMs = track.durationMs;
			this.moveNext(u, t);
		}
	}

	/** The listener presses "next" after hearing `afterMs` of the song. */
	skip(userId = this.defaultUserId): void {
		const u = this.user(userId);
		this.moveNext(u, this.now());
	}

	pause(userId = this.defaultUserId): void {
		this.user(userId).player.isPlaying = false;
	}

	// ------------------------------------------------------------------
	// HTTP
	// ------------------------------------------------------------------

	async handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		let path = url.pathname;
		// The fake can be mounted under a prefix (e2e: /accounts, /v1, /lastfm, /deezer).
		const idx = path.search(/\/(accounts|v1|lastfm|deezer)(\/|$)/);
		if (idx > 0) path = path.slice(idx);
		this.calls.push(`${req.method} ${path}`);
		try {
			if (path.startsWith("/accounts"))
				return await this.accounts(req, url, path.slice("/accounts".length));
			if (path.startsWith("/lastfm")) return this.lastfm(url);
			if (path.startsWith("/deezer")) return this.deezer(path.slice("/deezer".length), url);
			if (path.startsWith("/v1")) {
				if (this.failNext && this.failNext.count > 0) {
					this.failNext.count--;
					const f = this.failNext;
					return json(
						f.body ?? { error: { status: f.status, message: "fail" } },
						f.status,
						f.headers,
					);
				}
				const auth = req.headers.get("authorization") ?? "";
				const tok = this.tokens.get(auth.replace(/^Bearer /, ""));
				if (!tok || tok.expiresAt < this.now()) {
					return json({ error: { status: 401, message: "The access token expired" } }, 401);
				}
				return await this.api(req, url, path.slice(3), this.user(tok.userId));
			}
		} catch (err) {
			return json({ error: { status: 500, message: String(err) } }, 500);
		}
		return json({ error: { status: 404, message: "no route" } }, 404);
	}

	private async accounts(req: Request, url: URL, path: string): Promise<Response> {
		if (path === "/authorize" && req.method === "GET") {
			const userId = url.searchParams.get("login_hint") ?? this.defaultUserId;
			const code = `code-${this.seq++}`;
			this.codes.set(code, {
				userId,
				challenge: url.searchParams.get("code_challenge") ?? "",
				redirectUri: url.searchParams.get("redirect_uri") ?? "",
			});
			const back = new URL(url.searchParams.get("redirect_uri")!);
			back.searchParams.set("code", code);
			back.searchParams.set("state", url.searchParams.get("state") ?? "");
			return new Response(null, { status: 302, headers: { location: back.toString() } });
		}
		if (path === "/api/token" && req.method === "POST") {
			const form = new URLSearchParams(await req.text());
			const grant = form.get("grant_type");
			if (grant === "authorization_code") {
				const c = this.codes.get(form.get("code") ?? "");
				if (!c) return json({ error: "invalid_grant" }, 400);
				const verifier = form.get("code_verifier") ?? "";
				const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
				const challenge = b64url(new Uint8Array(digest));
				if (challenge !== c.challenge)
					return json({ error: "invalid_grant", error_description: "pkce" }, 400);
				if (form.get("redirect_uri") !== c.redirectUri)
					return json({ error: "invalid_grant" }, 400);
				this.codes.delete(form.get("code")!);
				const refresh = `rt-${c.userId}-${this.seq++}`;
				this.refreshTokens.set(refresh, c.userId);
				return json({
					access_token: this.issueToken(c.userId),
					token_type: "Bearer",
					expires_in: 3600,
					refresh_token: refresh,
					scope: "all",
				});
			}
			if (grant === "refresh_token") {
				const userId = this.refreshTokens.get(form.get("refresh_token") ?? "");
				if (!userId) return json({ error: "invalid_grant" }, 400);
				this.refreshTokens.delete(form.get("refresh_token")!);
				const refresh = `rt-${userId}-${this.seq++}`;
				this.refreshTokens.set(refresh, userId);
				return json({
					access_token: this.issueToken(userId),
					token_type: "Bearer",
					expires_in: 3600,
					refresh_token: refresh,
				});
			}
		}
		return json({ error: "unsupported" }, 400);
	}

	private trackJson(t: FakeTrack) {
		return {
			id: t.isLocal ? null : t.id,
			uri: t.isLocal ? `spotify:local:${t.name}` : `spotify:track:${t.id}`,
			name: t.name,
			type: "track",
			duration_ms: t.durationMs,
			is_local: !!t.isLocal,
			is_playable: t.playable,
			artists: [{ id: t.artistId, name: t.artistName }],
			album: {
				id: t.albumId,
				name: t.albumName,
				images: [{ url: `https://img.example/${t.albumId}.jpg`, width: 300, height: 300 }],
				release_date: t.releaseDate,
			},
		};
	}

	private playlistJson(p: FakePlaylist, u: FakeUser) {
		const readable = p.ownerId === u.id;
		return {
			id: p.id,
			name: p.name,
			description: p.description,
			public: p.public,
			collaborative: false,
			snapshot_id: `snap-${p.snapshot}`,
			owner: { id: p.ownerId, display_name: this.users.get(p.ownerId)?.name ?? p.ownerId },
			images: [{ url: `https://img.example/${p.id}.jpg` }],
			uri: `spotify:playlist:${p.id}`,
			...(readable ? { items: { total: p.items.length } } : {}),
		};
	}

	private async api(req: Request, url: URL, path: string, u: FakeUser): Promise<Response> {
		const m = req.method;
		const q = url.searchParams;
		const body = m === "GET" || m === "DELETE" ? null : await req.text();
		const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
		let r: RegExpExecArray | null;

		if (m === "GET" && path === "/me") return json({ id: u.id, display_name: u.name, images: [] });

		if (m === "GET" && path === "/me/playlists") {
			const all = [...this.playlists.values()].filter((p) => p.followedBy.has(u.id));
			return json(
				page(
					all.map((p) => this.playlistJson(p, u)),
					q,
					50,
				),
			);
		}
		if (m === "POST" && path === "/me/playlists") {
			const p = this.addPlaylist(u.id, String(data.name ?? "Untitled"), []);
			p.public = data.public !== false;
			p.description = String(data.description ?? "");
			return json(this.playlistJson(p, u), 201);
		}
		if ((r = /^\/playlists\/([^/]+)$/.exec(path)) && (m === "GET" || m === "PUT")) {
			const p = this.playlists.get(r[1]!);
			if (!p) return json({ error: { status: 404, message: "Not found" } }, 404);
			if (m === "PUT") {
				if (p.ownerId !== u.id) return json({ error: { status: 403, message: "Forbidden" } }, 403);
				if (typeof data.name === "string") p.name = data.name;
				if (typeof data.description === "string") p.description = data.description;
				return new Response(null, { status: 200 });
			}
			return json(this.playlistJson(p, u));
		}
		if ((r = /^\/playlists\/([^/]+)\/items$/.exec(path))) {
			const p = this.playlists.get(r[1]!);
			if (!p) return json({ error: { status: 404, message: "Not found" } }, 404);
			if (m === "GET") {
				if (p.ownerId !== u.id) return json({ error: { status: 403, message: "Forbidden" } }, 403);
				const items = p.items.map((id) => {
					const t = this.tracks.get(id)!;
					return {
						added_at: "2026-01-01T00:00:00Z",
						is_local: !!t.isLocal,
						item: this.trackJson(t),
					};
				});
				return json(page(items, q, this.opts.pageSize ?? 50));
			}
			if (p.ownerId !== u.id) return json({ error: { status: 403, message: "Forbidden" } }, 403);
			const uris = (data.uris as string[] | undefined) ?? [];
			if (uris.length > 100) return json({ error: { status: 400, message: "Too many" } }, 400);
			const ids = uris.map((x) => x.replace("spotify:track:", ""));
			if (m === "PUT") {
				p.items = ids;
				p.snapshot++;
				return json({ snapshot_id: `snap-${p.snapshot}` });
			}
			if (m === "POST") {
				const pos = typeof data.position === "number" ? data.position : p.items.length;
				p.items.splice(pos, 0, ...ids);
				p.snapshot++;
				return json({ snapshot_id: `snap-${p.snapshot}` }, 201);
			}
		}
		if (m === "DELETE" && path === "/me/library") {
			for (const uri of (q.get("uris") ?? "").split(",")) {
				const id = uri.replace("spotify:playlist:", "");
				this.playlists.get(id)?.followedBy.delete(u.id);
			}
			return new Response(null, { status: 200 });
		}
		if (m === "GET" && path === "/me/tracks") {
			const items = u.liked.map((id) => ({
				added_at: "2026-01-01T00:00:00Z",
				track: this.trackJson(this.tracks.get(id)!),
			}));
			return json(page(items, q, 50));
		}
		if (m === "GET" && path === "/me/top/artists") return json(page([], q, 50));

		// ---------------- player ----------------
		const p = u.player;
		const premiumOnly = () =>
			json(
				{
					error: {
						status: 403,
						message: "Player command failed: Premium required",
						reason: "PREMIUM_REQUIRED",
					},
				},
				403,
			);
		if (m === "GET" && path === "/me/player") {
			if (!p.deviceId) return new Response(null, { status: 204 });
			const id = this.current(u.id);
			const t = id ? this.tracks.get(id) : undefined;
			const dev = u.devices.find((d) => d.id === p.deviceId)!;
			return json({
				device: {
					id: dev.id,
					is_active: true,
					is_restricted: dev.restricted,
					name: dev.name,
					type: dev.type,
				},
				shuffle_state: p.shuffle,
				smart_shuffle: p.smartShuffle,
				repeat_state: p.repeat,
				timestamp: this.now(),
				context: p.contextUri ? { uri: p.contextUri, type: "playlist" } : null,
				progress_ms: p.progressMs,
				is_playing: p.isPlaying,
				item: t ? this.trackJson(t) : null,
				currently_playing_type: "track",
			});
		}
		if (m === "GET" && path === "/me/player/devices") {
			return json({
				devices: u.devices.map((d) => ({
					id: d.id,
					is_active: d.id === p.deviceId,
					is_restricted: d.restricted,
					name: d.name,
					type: d.type,
				})),
			});
		}
		if (m === "GET" && path === "/me/player/recently-played") {
			const after = Number(q.get("after") ?? "0");
			const limit = Number(q.get("limit") ?? "20");
			const items = u.recent
				.filter((e) => e.playedAt > after)
				.slice(0, limit)
				.map((e) => ({
					track: this.trackJson(this.tracks.get(e.trackId)!),
					played_at: new Date(e.playedAt).toISOString(),
					context: e.contextUri ? { uri: e.contextUri, type: "playlist" } : null,
				}));
			return json({ items, next: null, cursors: null, limit });
		}
		if (m === "PUT" && path === "/me/player/play") {
			if (!u.premium) return premiumOnly();
			const deviceId = q.get("device_id") ?? p.deviceId ?? null;
			if (!deviceId)
				return json(
					{
						error: {
							status: 404,
							message: "Player command failed: No active device found",
							reason: "NO_ACTIVE_DEVICE",
						},
					},
					404,
				);
			if (data.context_uri) {
				const cm = /^spotify:playlist:(.+)$/.exec(String(data.context_uri));
				if (cm && !this.playlists.has(cm[1]!)) {
					return json({ error: { status: 404, message: "Not found." } }, 404);
				}
				const off = data.offset as { position?: number } | undefined;
				this.startContext(u.id, String(data.context_uri), off?.position ?? 0, deviceId, true);
			} else if (Array.isArray(data.uris)) {
				const ids = (data.uris as string[]).map((x) => x.replace("spotify:track:", ""));
				p.contextUri = null;
				p.order = this.opts.urisFirstOnly ? ids.slice(0, 1) : ids;
				p.index = 0;
				p.progressMs = 0;
				p.listenedMs = 0;
				p.isPlaying = true;
				p.deviceId = deviceId;
			} else {
				p.deviceId = deviceId;
				p.isPlaying = true;
			}
			return new Response(null, { status: 204 });
		}
		if (m === "PUT" && path === "/me/player/pause") {
			if (!u.premium) return premiumOnly();
			p.isPlaying = false;
			return new Response(null, { status: 204 });
		}
		if (m === "POST" && path === "/me/player/next") {
			if (!u.premium) return premiumOnly();
			this.skip(u.id);
			return new Response(null, { status: 204 });
		}
		if (m === "PUT" && path === "/me/player/shuffle") {
			if (!u.premium) return premiumOnly();
			p.shuffle = q.get("state") === "true";
			return new Response(null, { status: 204 });
		}
		if (m === "PUT" && path === "/me/player/repeat") {
			if (!u.premium) return premiumOnly();
			p.repeat = (q.get("state") as PlayerSim["repeat"]) ?? "off";
			return new Response(null, { status: 204 });
		}

		// ---------------- catalogue ----------------
		if ((r = /^\/artists\/([^/]+)$/.exec(path)) && m === "GET") {
			const t = [...this.tracks.values()].find((x) => x.artistId === r![1]);
			if (!t) return json({ error: { status: 404, message: "Not found" } }, 404);
			return json({ id: t.artistId, name: t.artistName, genres: ["indie rock"], images: [] });
		}
		if ((r = /^\/artists\/([^/]+)\/albums$/.exec(path)) && m === "GET") {
			const albums = new Map<string, FakeTrack>();
			for (const t of this.tracks.values())
				if (t.artistId === r[1] && !albums.has(t.albumId)) albums.set(t.albumId, t);
			return json(
				page(
					[...albums.values()].map((t) => ({
						id: t.albumId,
						name: t.albumName,
						release_date: t.releaseDate,
						album_type: "album",
						images: [],
					})),
					q,
					50,
				),
			);
		}
		if ((r = /^\/albums\/([^/]+)$/.exec(path)) && m === "GET") {
			const ts = [...this.tracks.values()].filter((t) => t.albumId === r![1]);
			if (ts.length === 0) return json({ error: { status: 404, message: "Not found" } }, 404);
			const a = ts[0]!;
			return json({
				id: a.albumId,
				name: a.albumName,
				release_date: a.releaseDate,
				images: [],
				artists: [{ id: a.artistId, name: a.artistName }],
				tracks: {
					items: ts.map((t) => this.trackJson(t)),
					next: null,
					total: ts.length,
					limit: 50,
					offset: 0,
				},
			});
		}
		if (m === "GET" && path === "/search") {
			const text = (q.get("q") ?? "").toLowerCase();
			const limit = Math.min(10, Number(q.get("limit") ?? "5"));
			const titleMatch = /track:"?([^"]+)"?/.exec(text)?.[1]?.trim();
			const artistMatch = /artist:"?([^"]+)"?/.exec(text)?.[1]?.trim();
			const hits = [...this.tracks.values()].filter((t) => {
				if (titleMatch && !t.name.toLowerCase().includes(titleMatch)) return false;
				if (artistMatch && !t.artistName.toLowerCase().includes(artistMatch)) return false;
				if (!titleMatch && !artistMatch)
					return (
						t.name.toLowerCase().includes(text) ||
						t.artistName.toLowerCase().includes(text) ||
						text.includes("genre:")
					);
				return true;
			});
			return json({
				tracks: page(
					hits.map((t) => this.trackJson(t)),
					q,
					limit,
				),
			});
		}
		return json({ error: { status: 404, message: `no route ${m} ${path}` } }, 404);
	}

	private lastfm(url: URL): Response {
		const method = url.searchParams.get("method");
		const artist = url.searchParams.get("artist") ?? "";
		const byArtist = new Map<string, FakeTrack[]>();
		for (const t of this.tracks.values()) {
			const arr = byArtist.get(t.artistName) ?? [];
			arr.push(t);
			byArtist.set(t.artistName, arr);
		}
		const names = [...byArtist.keys()].filter((n) => n !== artist).slice(0, 5);
		if (method === "artist.getsimilar") {
			return json({ similarartists: { artist: names.map((n) => ({ name: n, match: "0.8" })) } });
		}
		if (method === "artist.gettoptracks") {
			const ts = byArtist.get(artist) ?? [];
			return json({
				toptracks: {
					track: ts.slice(0, 5).map((t) => ({ name: t.name, artist: { name: t.artistName } })),
				},
			});
		}
		if (method === "track.getsimilar") {
			const ts = [...this.tracks.values()].slice(0, 5);
			return json({
				similartracks: {
					track: ts.map((t) => ({ name: t.name, artist: { name: t.artistName }, match: 0.7 })),
				},
			});
		}
		return json({ error: 3, message: "Invalid Method" }, 400);
	}

	private deezer(path: string, url: URL): Response {
		const artists = new Map<string, FakeTrack>();
		for (const t of this.tracks.values())
			if (!artists.has(t.artistName)) artists.set(t.artistName, t);
		const list = [...artists.values()];
		if (path === "/search/artist") {
			const qn = (url.searchParams.get("q") ?? "").toLowerCase();
			const hit = list.filter((t) => t.artistName.toLowerCase() === qn).slice(0, 1);
			return json({
				data: hit.map((t, i) => ({ id: 1000 + list.indexOf(t) + i, name: t.artistName })),
			});
		}
		let r: RegExpExecArray | null;
		if ((r = /^\/artist\/(\d+)\/related$/.exec(path))) {
			const i = Number(r[1]) - 1000;
			return json({
				data: list
					.filter((_, k) => k !== i)
					.slice(0, 5)
					.map((t) => ({ id: 1000 + list.indexOf(t), name: t.artistName })),
			});
		}
		if ((r = /^\/artist\/(\d+)\/top$/.exec(path))) {
			const a = list[Number(r[1]) - 1000];
			const ts = a
				? [...this.tracks.values()].filter((t) => t.artistName === a.artistName).slice(0, 5)
				: [];
			return json({ data: ts.map((t) => ({ title: t.name, artist: { name: t.artistName } })) });
		}
		return json({ error: { type: "DataException", message: "no data", code: 800 } });
	}
}

function page<T>(items: T[], q: URLSearchParams, max: number) {
	const limit = Math.min(max, Number(q.get("limit") ?? "20"));
	const offset = Number(q.get("offset") ?? "0");
	const slice = items.slice(offset, offset + limit);
	return {
		items: slice,
		total: items.length,
		limit,
		offset,
		next:
			offset + limit < items.length ? `https://api.example/next?offset=${offset + limit}` : null,
	};
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

export function b64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
