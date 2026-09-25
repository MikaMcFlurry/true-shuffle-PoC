import type { Registry } from "./registry";
import type { UserHub } from "./userhub";

export interface Env {
	ASSETS: Fetcher;
	USER_HUB: DurableObjectNamespace<UserHub>;
	REGISTRY: DurableObjectNamespace<Registry>;
	AI?: Ai;

	/** Public client id of the Spotify app (PKCE — no client secret). */
	SPOTIFY_CLIENT_ID: string;
	/** >= 32 characters. Signs cookies and encrypts refresh tokens. Secret. */
	APP_SECRET?: string;
	/** Optional: enables Claude for AI discovery. Secret. */
	ANTHROPIC_API_KEY?: string;
	ANTHROPIC_MODEL?: string;
	/** Optional: enables the Last.fm discovery source. Secret. */
	LASTFM_API_KEY?: string;
	/** Optional comma-separated Spotify user ids allowed to sign in. */
	ALLOWED_SPOTIFY_IDS?: string;
	/** Optional canonical origin, e.g. https://true-shuffle.example.workers.dev */
	PUBLIC_URL?: string;

	// Overridable endpoints (tests point these at the fake).
	SPOTIFY_ACCOUNTS_BASE?: string;
	SPOTIFY_API_BASE?: string;
	LASTFM_API_BASE?: string;
	DEEZER_API_BASE?: string;
}

export function endpoints(env: Env) {
	return {
		accountsBase: env.SPOTIFY_ACCOUNTS_BASE || "https://accounts.spotify.com",
		apiBase: env.SPOTIFY_API_BASE || "https://api.spotify.com/v1",
		clientId: env.SPOTIFY_CLIENT_ID,
	};
}

export function hubEnv(env: Env) {
	return {
		endpoints: endpoints(env),
		lastfmBase: env.LASTFM_API_BASE || "https://ws.audioscrobbler.com",
		lastfmKey: env.LASTFM_API_KEY || null,
		deezerBase: env.DEEZER_API_BASE || "https://api.deezer.com",
		anthropicKey: env.ANTHROPIC_API_KEY || null,
		anthropicModel: env.ANTHROPIC_MODEL || "claude-sonnet-5",
	};
}
