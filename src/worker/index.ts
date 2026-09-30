/**
 * The Worker: sign-in with Spotify, a small JSON API in front of each
 * listener's UserHub, and the cron safety net. Static client assets are
 * served by Workers Static Assets and never reach this code.
 */

import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { StationRules } from "../core/types";
import type { RemoteAction, RemoteKeyView, StationSource } from "../shared/api";
import { type Env, endpoints } from "./env";
import { Keys, randomToken, sha256b64url } from "./lib/crypto";
import { readRemoteKey, remoteKeyFor } from "./lib/remote-key";
import { RequestBudget, SpotifyClient, SpotifyError, type SpotifyTokens } from "./spotify/client";
import { boundedSpotifyRpc } from "./spotify/rpc";
import type { RpcResult, UserHub } from "./userhub";

export { Registry } from "./registry";
export { UserHub } from "./userhub";

const SESSION_COOKIE = "ts_session";
const OAUTH_COOKIE = "ts_oauth";
const SESSION_DAYS = 180;

type Vars = { uid: string; epoch: number; hub: DurableObjectStub<UserHub> };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

function origin(c: { req: { url: string }; env: Env }): string {
	return c.env.PUBLIC_URL?.replace(/\/$/, "") || new URL(c.req.url).origin;
}

function secure(c: { req: { url: string } }): boolean {
	return new URL(c.req.url).protocol === "https:";
}

function configured(env: Env): string | null {
	if (!env.SPOTIFY_CLIENT_ID) return "SPOTIFY_CLIENT_ID fehlt";
	if (!env.APP_SECRET || env.APP_SECRET.length < 32)
		return "APP_SECRET fehlt oder ist zu kurz (mind. 32 Zeichen)";
	return null;
}

/** The signed session cookie: who, until when, which sign-in generation. */
async function readSession(c: {
	env: Env;
	req: { raw: Request };
}): Promise<{ uid: string; epoch: number } | null> {
	const signed = getCookie(c as never, SESSION_COOKIE);
	const payload = signed ? await new Keys(c.env.APP_SECRET!).verify(signed) : null;
	const [uid, exp, epoch] = payload?.split("|") ?? [];
	if (!uid || !(Number(exp) >= Date.now()) || !Number.isInteger(Number(epoch))) return null;
	// Taken off the list: signed out at once, not when the cookie runs out.
	if (!allowed(c.env, uid)) return null;
	return { uid, epoch: Number(epoch) };
}

/** `ALLOWED_SPOTIFY_IDS`, if set, names everyone who may use this true-shuffle. */
function allowed(env: Env, uid: string): boolean {
	const allow = (env.ALLOWED_SPOTIFY_IDS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return allow.length === 0 || allow.includes(uid);
}

function hubFor(env: Env, uid: string): DurableObjectStub<UserHub> {
	return env.USER_HUB.get(env.USER_HUB.idFromName(uid));
}

// ---------------------------------------------------------------------------
// Sign-in with Spotify (Authorization Code + PKCE)
// ---------------------------------------------------------------------------

app.get("/auth/login", async (c) => {
	const missing = configured(c.env);
	if (missing) return c.redirect(`/?setup=${encodeURIComponent(missing)}`);
	const keys = new Keys(c.env.APP_SECRET!);
	const state = randomToken(16);
	const verifier = randomToken(48);
	const challenge = await sha256b64url(verifier);
	const exp = Date.now() + 10 * 60_000;
	setCookie(c, OAUTH_COOKIE, await keys.sign(`${state}.${verifier}.${exp}`), {
		httpOnly: true,
		secure: secure(c),
		sameSite: "Lax",
		path: "/auth",
		maxAge: 600,
	});
	const redirectUri = `${origin(c)}/auth/callback`;
	return c.redirect(SpotifyClient.authorizeUrl(endpoints(c.env), redirectUri, state, challenge));
});

app.get("/auth/callback", async (c) => {
	const missing = configured(c.env);
	if (missing) return c.redirect(`/?setup=${encodeURIComponent(missing)}`);
	const keys = new Keys(c.env.APP_SECRET!);
	const url = new URL(c.req.url);
	if (url.searchParams.get("error")) return c.redirect("/?login=denied");
	const signed = getCookie(c, OAUTH_COOKIE);
	deleteCookie(c, OAUTH_COOKIE, { path: "/auth" });
	const payload = signed ? await keys.verify(signed) : null;
	const [state, verifier, exp] = payload?.split(".") ?? [];
	if (!state || !verifier || Number(exp) < Date.now() || state !== url.searchParams.get("state")) {
		return c.redirect("/?login=expired");
	}
	const code = url.searchParams.get("code");
	if (!code) return c.redirect("/?login=denied");
	const e = endpoints(c.env);
	const registry = c.env.REGISTRY.get(c.env.REGISTRY.idFromName("registry"));
	const spotifyPolicy = {
		getCooldown: () => boundedSpotifyRpc(registry.spotifyCooldown()),
		setCooldown: async (cooldown: import("./spotify/client").SpotifyCooldown) => {
			await boundedSpotifyRpc(registry.spotifyBlocked(cooldown));
		},
	};
	let tokens: SpotifyTokens;
	try {
		tokens = await SpotifyClient.exchangeCode(
			e,
			(r) => fetch(r),
			code,
			`${origin(c)}/auth/callback`,
			verifier,
			Date.now(),
			spotifyPolicy,
		);
	} catch {
		return c.redirect("/?login=failed");
	}
	let held = tokens;
	const client = new SpotifyClient({
		endpoints: e,
		tokens: {
			get: async () => held,
			set: async (t) => {
				held = t;
			},
		},
		budget: new RequestBudget(5),
		fetch: (r) => fetch(r),
		now: () => Date.now(),
		policy: spotifyPolicy,
	});
	let me: Awaited<ReturnType<SpotifyClient["me"]>>;
	try {
		me = await client.me();
	} catch (err) {
		// Development Mode answers 403 for accounts not allowlisted in the dashboard.
		if (err instanceof SpotifyError && err.kind === "forbidden")
			return c.redirect("/?login=not_allowed");
		return c.redirect("/?login=failed");
	}
	if (!me?.id) return c.redirect("/?login=failed");
	if (!allowed(c.env, me.id)) return c.redirect("/?login=not_allowed");

	const hub = hubFor(c.env, me.id);
	const res = (await hub.attach(
		{ id: me.id, name: me.display_name || me.id, imageUrl: me.images?.[0]?.url ?? null },
		held,
	)) as RpcResult<number>;
	if (!res.ok) return c.redirect("/?login=failed");
	await c.env.REGISTRY.get(c.env.REGISTRY.idFromName("registry")).register(me.id);
	const sessionExp = Date.now() + SESSION_DAYS * 86_400_000;
	setCookie(c, SESSION_COOKIE, await keys.sign(`${me.id}|${sessionExp}|${res.value}`), {
		httpOnly: true,
		secure: secure(c),
		sameSite: "Lax",
		path: "/",
		maxAge: SESSION_DAYS * 86_400,
	});
	return c.redirect("/");
});

app.post("/auth/logout", async (c) => {
	if (c.req.header("x-ts") !== "1")
		return c.json({ error: { code: "csrf", message: "Ungültige Anfrage" } }, 403);
	// Ends every session of this listener, not just this browser's cookie.
	const session = configured(c.env) ? null : await readSession(c);
	if (session) await hubFor(c.env, session.uid).logout(session.epoch);
	deleteCookie(c, SESSION_COOKIE, { path: "/" });
	return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Remote: one POST per command, for Siri Shortcuts, a watch, a widget
// ---------------------------------------------------------------------------

const REMOTE_ACTIONS: readonly RemoteAction[] = ["like", "dislike", "skip"];

app.post("/remote/:action", async (c) => {
	// Plain text, so a Shortcut can speak or show the answer as it comes.
	const say = (text: string, status: ContentfulStatusCode) =>
		c.text(text, status, { "cache-control": "no-store" });
	const missing = configured(c.env);
	if (missing) return say(`true-shuffle ist nicht eingerichtet: ${missing}`, 503);
	const action = c.req.param("action") as RemoteAction;
	if (!REMOTE_ACTIONS.includes(action))
		return say("Unbekannter Befehl. Es gibt like, dislike und skip.", 404);
	const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
	const key = m ? await readRemoteKey(c.env.APP_SECRET!, m[1]!) : null;
	if (!key || !allowed(c.env, key.uid))
		return say(
			"Kein gültiger Schlüssel. Den Schlüssel gibt es in true-shuffle unter Menü, Fernbedienung.",
			401,
		);
	const r = (await hubFor(c.env, key.uid).remote(key.kid, action)) as RpcResult<string>;
	return r.ok ? say(r.value, 200) : say(r.error.message, r.error.status as ContentfulStatusCode);
});

app.all("/remote/*", (c) =>
	c.text("Befehle an true-shuffle kommen als POST.", 405, { "cache-control": "no-store" }),
);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.get("/api/health", (c) =>
	c.json({ ok: true, version: "1.0.0", configured: configured(c.env) === null }),
);

app.use("/api/*", async (c, next) => {
	if (c.req.path === "/api/health") return next();
	const missing = configured(c.env);
	if (missing) return c.json({ error: { code: "setup", message: missing } }, 503);
	// Mutations must carry a custom header: a cross-site form cannot set one.
	if (c.req.method !== "GET" && c.req.header("x-ts") !== "1") {
		return c.json({ error: { code: "csrf", message: "Ungültige Anfrage" } }, 403);
	}
	const session = await readSession(c);
	if (!session) {
		return c.json({ error: { code: "auth", message: "Bitte mit Spotify anmelden." } }, 401);
	}
	c.set("uid", session.uid);
	c.set("epoch", session.epoch);
	c.set("hub", hubFor(c.env, session.uid));
	return next();
});

async function unwrap<T>(
	c: { json: (b: unknown, s?: ContentfulStatusCode) => Response },
	p: Promise<unknown>,
): Promise<Response> {
	const r = (await p) as RpcResult<T>;
	if (r.ok) return c.json(r.value ?? { ok: true });
	return c.json(
		{ error: { code: r.error.code, message: r.error.message } },
		r.error.status as ContentfulStatusCode,
	);
}

async function body<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
	try {
		return (await c.req.json()) as T;
	} catch {
		return {} as T;
	}
}

app.get("/api/state", async (c) => {
	const r = (await c.var.hub.state(c.var.epoch, c.req.query("live") === "1")) as RpcResult<{
		profile: { id: string };
	}>;
	if (r.ok && !r.value.profile.id) {
		// The account was deleted on another device.
		deleteCookie(c, SESSION_COOKIE, { path: "/" });
		return c.json({ error: { code: "auth", message: "Bitte mit Spotify anmelden." } }, 401);
	}
	return r.ok
		? c.json(r.value)
		: c.json({ error: r.error }, r.error.status as ContentfulStatusCode);
});

app.get("/api/playlists", (c) => unwrap(c, c.var.hub.playlists(c.var.epoch)));

app.post("/api/onboarding", async (c) => {
	const b = await body<{ playlistIds?: unknown }>(c);
	const ids = Array.isArray(b.playlistIds)
		? b.playlistIds.filter((x): x is string => typeof x === "string").slice(0, 100)
		: [];
	return unwrap(c, c.var.hub.onboard(c.var.epoch, ids));
});

function parseSources(v: unknown): StationSource[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out: StationSource[] = [];
	for (const s of v.slice(0, 50)) {
		const o = s as Record<string, unknown>;
		if (o?.type === "liked") out.push({ type: "liked" });
		else if (
			o?.type === "playlist" &&
			typeof o.id === "string" &&
			/^[A-Za-z0-9]{1,64}$/.test(o.id)
		) {
			out.push({ type: "playlist", id: o.id });
		}
	}
	return out;
}

app.post("/api/stations", async (c) => {
	const b = await body<{ name?: string; sources?: unknown; rules?: Partial<StationRules> }>(c);
	const sources = parseSources(b.sources) ?? [];
	if (sources.length === 0)
		return c.json(
			{ error: { code: "no_sources", message: "Wähle mindestens eine Playlist." } },
			400,
		);
	return unwrap(
		c,
		c.var.hub.createStation(c.var.epoch, {
			name: String(b.name ?? "Neuer Sender"),
			sources,
			rules: b.rules,
		}),
	);
});

app.patch("/api/stations/:id", async (c) => {
	const b = await body<{ name?: string; sources?: unknown; rules?: Partial<StationRules> }>(c);
	return unwrap(
		c,
		c.var.hub.updateStation(c.var.epoch, Number(c.req.param("id")), {
			name: typeof b.name === "string" ? b.name : undefined,
			rules: b.rules && typeof b.rules === "object" ? b.rules : undefined,
			sources: parseSources(b.sources),
		}),
	);
});

app.delete("/api/stations/:id", (c) =>
	unwrap(c, c.var.hub.deleteStation(c.var.epoch, Number(c.req.param("id")))),
);
app.get("/api/stations/:id", (c) =>
	unwrap(c, c.var.hub.stationDetail(c.var.epoch, Number(c.req.param("id")))),
);

app.post("/api/stations/:id/play", async (c) => {
	const b = await body<{ deviceId?: string; newQueue?: boolean; sessionId?: string }>(c);
	return unwrap(
		c,
		c.var.hub.play(
			c.var.epoch,
			Number(c.req.param("id")),
			typeof b.deviceId === "string" ? b.deviceId : null,
			{
				newQueue: b.newQueue === true,
				sessionId: typeof b.sessionId === "string" ? b.sessionId : undefined,
			},
		),
	);
});

app.post("/api/player/:action", async (c) => {
	const expected = await body<{ sessionId?: string; entryId?: string }>(c);
	const action = c.req.param("action");
	if (action !== "pause" && action !== "resume" && action !== "next") {
		return c.json({ error: { code: "bad_action", message: "Unbekannte Aktion" } }, 400);
	}
	return unwrap(
		c,
		c.var.hub.playerAction(c.var.epoch, action, {
			sessionId: typeof expected.sessionId === "string" ? expected.sessionId : undefined,
			entryId: typeof expected.entryId === "string" ? expected.entryId : undefined,
		}),
	);
});

app.get("/api/native/devices", (c) => unwrap(c, c.var.hub.nativeDevices(c.var.epoch, c.var.uid)));
app.post("/api/native/cancel", async (c) => {
	const b = await body<{ sessionId?: string; entryId?: string }>(c);
	return unwrap(
		c,
		c.var.hub.nativeCancel(c.var.epoch, {
			sessionId: typeof b.sessionId === "string" ? b.sessionId : undefined,
			entryId: typeof b.entryId === "string" ? b.entryId : undefined,
		}),
	);
});
app.get("/api/native/state", (c) => unwrap(c, c.var.hub.nativeState(c.var.epoch, c.var.uid)));
app.post("/api/native/play", async (c) => {
	const b = await body<{
		stationId?: number;
		deviceId?: string;
		sessionId?: string;
		entryId?: string;
		orderRevision?: number;
		newQueue?: boolean;
	}>(c);
	if (!Number.isSafeInteger(b.stationId) || typeof b.deviceId !== "string")
		return c.json(
			{ error: { code: "bad_native", message: "Gerät und Warteschlange fehlen." } },
			400,
		);
	return unwrap(
		c,
		c.var.hub.nativePlay(c.var.epoch, c.var.uid, b.stationId!, b.deviceId, "resume", {
			sessionId: typeof b.sessionId === "string" ? b.sessionId : undefined,
			entryId: typeof b.entryId === "string" ? b.entryId : undefined,
			orderRevision: typeof b.orderRevision === "number" ? b.orderRevision : undefined,
			newQueue: b.newQueue === true,
		}),
	);
});
app.post("/api/native/player", async (c) => {
	const b = await body<{
		stationId?: number;
		deviceId?: string;
		action?: string;
		sessionId?: string;
		entryId?: string;
		orderRevision?: number;
	}>(c);
	if (
		!Number.isSafeInteger(b.stationId) ||
		typeof b.deviceId !== "string" ||
		!["resume", "pause", "next"].includes(b.action ?? "")
	)
		return c.json({ error: { code: "bad_native", message: "Ungültiger Native Befehl." } }, 400);
	return unwrap(
		c,
		c.var.hub.nativePlay(
			c.var.epoch,
			c.var.uid,
			b.stationId!,
			b.deviceId,
			b.action as "resume" | "pause" | "next",
			{
				sessionId: typeof b.sessionId === "string" ? b.sessionId : undefined,
				entryId: typeof b.entryId === "string" ? b.entryId : undefined,
				orderRevision: typeof b.orderRevision === "number" ? b.orderRevision : undefined,
			},
		),
	);
});
app.post("/api/spotify/retry", (c) => unwrap(c, c.var.hub.retryQuota(c.var.epoch)));
app.get("/api/spotify/diagnostics", (c) => unwrap(c, c.var.hub.spotifyDiagnostics(c.var.epoch)));

app.get("/api/devices", (c) => unwrap(c, c.var.hub.devices(c.var.epoch)));

app.post("/api/tracks/:id/thumb", async (c) => {
	const b = await body<{ value?: number }>(c);
	const v = b.value === 1 ? 1 : b.value === -1 ? -1 : 0;
	return unwrap(c, c.var.hub.thumb(c.var.epoch, c.req.param("id"), v));
});

async function remoteView(
	c: { env: Env; var: Vars },
	k: { kid: string; createdAt: number; usedAt: number | null } | null,
): Promise<RemoteKeyView> {
	return k
		? {
				key: await remoteKeyFor(c.env.APP_SECRET!, c.var.uid, k.kid),
				createdAt: k.createdAt,
				usedAt: k.usedAt,
			}
		: { key: null, createdAt: null, usedAt: null };
}

app.get("/api/remote", async (c) => {
	const r = (await c.var.hub.remoteKey(c.var.epoch)) as RpcResult<{
		kid: string;
		createdAt: number;
		usedAt: number | null;
	} | null>;
	if (!r.ok) return c.json({ error: r.error }, r.error.status as ContentfulStatusCode);
	return c.json(await remoteView(c, r.value));
});

app.post("/api/remote", async (c) => {
	const r = (await c.var.hub.newRemoteKey(c.var.epoch)) as RpcResult<string>;
	if (!r.ok) return c.json({ error: r.error }, r.error.status as ContentfulStatusCode);
	return c.json(await remoteView(c, { kid: r.value, createdAt: Date.now(), usedAt: null }));
});

app.delete("/api/remote", (c) => unwrap(c, c.var.hub.dropRemoteKey(c.var.epoch)));

app.post("/api/guest", async (c) => {
	const b = await body<{ on?: boolean; hours?: number }>(c);
	return unwrap(
		c,
		c.var.hub.setGuest(
			c.var.epoch,
			b.on === true,
			typeof b.hours === "number" ? b.hours : undefined,
		),
	);
});

app.post("/api/history/import", async (c) => {
	const b = await body<{ rows?: unknown; part?: number; parts?: number }>(c);
	const rows = Array.isArray(b.rows) ? (b.rows as [string, number, number, number][]) : [];
	const part = Number(b.part ?? 0);
	const parts = Number(b.parts ?? 1);
	if (
		!Number.isInteger(part) ||
		!Number.isInteger(parts) ||
		part < 0 ||
		part >= parts ||
		parts > 200
	) {
		return c.json({ error: { code: "bad_import", message: "Ungültiger Import-Block" } }, 400);
	}
	return unwrap(c, c.var.hub.importHistory(c.var.epoch, rows, part, parts));
});

app.get("/api/history", (c) => {
	const before = c.req.query("before");
	return unwrap(
		c,
		c.var.hub.history(
			c.var.epoch,
			Number(c.req.query("limit") ?? 50),
			before ? Number(before) : undefined,
		),
	);
});

app.post("/api/sync", (c) => unwrap(c, c.var.hub.syncNow(c.var.epoch)));

app.delete("/api/account", async (c) => {
	const r = (await c.var.hub.deleteAccount(c.var.epoch)) as RpcResult<{ stuck: string[] }>;
	if (!r.ok) return c.json({ error: r.error }, r.error.status as ContentfulStatusCode);
	// Only a deletion that happened takes the account out of the cron's list.
	await c.env.REGISTRY.get(c.env.REGISTRY.idFromName("registry")).remove(c.var.uid);
	deleteCookie(c, SESSION_COOKIE, { path: "/" });
	return c.json(r.value);
});

app.notFound((c) => c.json({ error: { code: "not_found", message: "Nicht gefunden" } }, 404));
app.onError((err, c) => {
	console.error(err);
	return c.json({ error: { code: "internal", message: "Interner Fehler" } }, 500);
});

export default {
	fetch: app.fetch,
	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
		// Safety net: every listener's hub re-arms its own sync alarm if it lost it.
		// One taken off the allowlist stops working in the background, and one
		// put back on it starts again.
		const uids = await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).list();
		ctx.waitUntil(
			Promise.allSettled(
				uids.map((uid) =>
					allowed(env, uid) ? hubFor(env, uid).allow() : hubFor(env, uid).suspend(),
				),
			),
		);
	},
} satisfies ExportedHandler<Env>;
