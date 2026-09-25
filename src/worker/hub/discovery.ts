/**
 * Discovery — songs from outside the listener's playlists.
 *
 * Six sources, chosen with the owner, each verified against Spotify before a
 * song may enter a station (so nothing invented or unplayable gets through):
 *
 *  1. deep cuts:     other album tracks of artists the listener likes
 *  2. new releases:  those artists' releases of the last 90 days
 *  3. Last.fm:       similar artists (real listening data) → their top tracks
 *  4. Deezer:        related artists → their top tracks
 *  5. genre search:  Spotify search inside the seed artists' genres
 *  6. AI:            Claude (if a key is set) or Workers AI suggests songs
 *
 * Work is split into phases that each fit the free plan's request budget
 * and resume on the next invocation.
 */

import Anthropic from "@anthropic-ai/sdk";
import { type Rng, weightedShuffle } from "../../core/random";
import type { TrackId } from "../../core/types";
import {
	type Fetcher,
	type RequestBudget,
	type SpotifyClient,
	SpotifyError,
} from "../spotify/client";
import type { SpTrack } from "../spotify/types";
import type { HubEnv } from "./hub";
import { type PackedTrack, packTrack } from "./library";

export interface AiRunner {
	run(
		model: string,
		input: { messages: { role: string; content: string }[]; max_tokens?: number },
	): Promise<unknown>;
}

export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface DiscoveryContext {
	client: SpotifyClient;
	budget: RequestBudget;
	fetch: Fetcher;
	env: HubEnv;
	ai: AiRunner | null;
	rng: Rng;
	now: () => number;
	seeds: () => { id: string; name: string; weight: number }[];
	known: (id: TrackId) => boolean;
	stationName: string;
	add: (t: PackedTrack, source: string, score: number) => boolean;
}

export interface DiscoveryState {
	stationId?: number;
	phase?: number;
	cursor?: number;
	seeds?: { id: string; name: string }[];
	added?: number;
	suggestions?: { artist: string; title: string }[];
}

type Result = { done: true } | { done: false; state: DiscoveryState };

const RESERVE = 4;
const NEW_RELEASE_MS = 90 * 86_400_000;

export async function discoverStep(ctx: DiscoveryContext, state: DiscoveryState): Promise<Result> {
	const s: DiscoveryState = { phase: 0, cursor: 0, added: 0, ...state };
	for (let guard = 0; guard < 20; guard++) {
		if (ctx.budget.left <= RESERVE) return { done: false, state: s };
		switch (s.phase) {
			case 0: {
				const seeds = ctx.seeds();
				if (seeds.length === 0) return { done: true };
				// A different handful each run, biased towards what is loved most.
				s.seeds = weightedShuffle(seeds, (x) => x.weight + 0.2, ctx.rng)
					.slice(0, 8)
					.map((x) => ({ id: x.id, name: x.name }));
				s.phase = 1;
				s.cursor = 0;
				break;
			}
			case 1: {
				// Deep cuts and new releases of the seed artists.
				const seeds = s.seeds ?? [];
				while ((s.cursor ?? 0) < seeds.length && ctx.budget.left > RESERVE + 3) {
					const seed = seeds[s.cursor ?? 0]!;
					s.cursor = (s.cursor ?? 0) + 1;
					await guarded(() => artistDeepCuts(ctx, s, seed.id));
				}
				if ((s.cursor ?? 0) >= seeds.length) {
					s.phase = 2;
					s.cursor = 0;
				}
				break;
			}
			case 2: {
				if (ctx.env.lastfmKey) {
					const seeds = (s.seeds ?? []).slice(0, 2);
					while ((s.cursor ?? 0) < seeds.length && ctx.budget.left > RESERVE + 9) {
						const seed = seeds[s.cursor ?? 0]!;
						s.cursor = (s.cursor ?? 0) + 1;
						await guarded(() => lastfmSimilar(ctx, s, seed.name));
					}
					if ((s.cursor ?? 0) < seeds.length) break;
				}
				s.phase = 3;
				s.cursor = 0;
				break;
			}
			case 3: {
				const seeds = (s.seeds ?? []).slice(2, 4);
				while ((s.cursor ?? 0) < seeds.length && ctx.budget.left > RESERVE + 8) {
					const seed = seeds[s.cursor ?? 0]!;
					s.cursor = (s.cursor ?? 0) + 1;
					await guarded(() => deezerRelated(ctx, s, seed.name));
				}
				if ((s.cursor ?? 0) >= seeds.length) {
					s.phase = 4;
					s.cursor = 0;
				}
				break;
			}
			case 4: {
				const seeds = (s.seeds ?? []).slice(0, 2);
				while ((s.cursor ?? 0) < seeds.length && ctx.budget.left > RESERVE + 2) {
					const seed = seeds[s.cursor ?? 0]!;
					s.cursor = (s.cursor ?? 0) + 1;
					await guarded(() => genreSearch(ctx, s, seed.id));
				}
				if ((s.cursor ?? 0) >= seeds.length) {
					s.phase = 5;
					s.cursor = 0;
				}
				break;
			}
			case 5: {
				if (!s.suggestions) {
					s.suggestions = (await guarded(() => aiSuggestions(ctx), [])) ?? [];
					s.cursor = 0;
				}
				const list = s.suggestions;
				while ((s.cursor ?? 0) < list.length && ctx.budget.left > RESERVE) {
					const sug = list[s.cursor ?? 0]!;
					s.cursor = (s.cursor ?? 0) + 1;
					await guarded(() => verifyAndAdd(ctx, s, sug.artist, sug.title, "ai", 0.7));
				}
				if ((s.cursor ?? 0) >= list.length) return { done: true };
				break;
			}
			default:
				return { done: true };
		}
	}
	return { done: false, state: s };
}

/** Run a source; an individual source failing must not stop discovery. */
async function guarded<T>(fn: () => Promise<T>, fallback?: T): Promise<T | undefined> {
	try {
		return await fn();
	} catch (err) {
		if (
			err instanceof SpotifyError &&
			(err.kind === "budget" || err.kind === "rate" || err.kind === "quota" || err.kind === "auth")
		) {
			throw err;
		}
		return fallback;
	}
}

function consider(
	ctx: DiscoveryContext,
	s: DiscoveryState,
	t: SpTrack | null | undefined,
	source: string,
	score: number,
): void {
	if (!t) return;
	const p = packTrack(t);
	if (!p || ctx.known(p[0])) return;
	if (ctx.add(p, source, score)) s.added = (s.added ?? 0) + 1;
}

async function artistDeepCuts(
	ctx: DiscoveryContext,
	s: DiscoveryState,
	artistId: string,
): Promise<void> {
	const albums = (await ctx.client.artistAlbums(artistId, 20))?.items ?? [];
	if (albums.length === 0) return;
	const now = ctx.now();
	const recent = albums.filter((a) => {
		const t = Date.parse(
			a.release_date?.length === 4 ? `${a.release_date}-01-01` : (a.release_date ?? ""),
		);
		return Number.isFinite(t) && now - t < NEW_RELEASE_MS;
	});
	const picks = [
		...recent.slice(0, 1).map((a) => ({ a, source: "new", score: 0.85 })),
		...weightedShuffle(
			albums.filter((a) => !recent.includes(a)),
			() => 1,
			ctx.rng,
		)
			.slice(0, 1)
			.map((a) => ({ a, source: "artist", score: 0.65 })),
	];
	for (const { a, source, score } of picks) {
		if (!a.id || ctx.budget.left <= RESERVE) continue;
		const album = await ctx.client.album(a.id);
		const tracks = weightedShuffle(album?.tracks?.items ?? [], () => 1, ctx.rng).slice(0, 3);
		for (const t of tracks) {
			if (!t.album && album) t.album = { id: album.id, name: album.name, images: album.images };
			consider(ctx, s, t, source, score);
		}
	}
}

async function externalJson<T>(ctx: DiscoveryContext, url: string): Promise<T | null> {
	ctx.budget.take();
	const res = await ctx.fetch(new Request(url, { headers: { "user-agent": "true-shuffle/1.0" } }));
	if (!res.ok) return null;
	return (await res.json()) as T;
}

async function lastfmSimilar(
	ctx: DiscoveryContext,
	s: DiscoveryState,
	artist: string,
): Promise<void> {
	const base = ctx.env.lastfmBase;
	const key = ctx.env.lastfmKey!;
	const q = (method: string, extra: Record<string, string>) => {
		const u = new URL(`${base}/2.0/`);
		u.searchParams.set("method", method);
		u.searchParams.set("api_key", key);
		u.searchParams.set("format", "json");
		for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
		return u.toString();
	};
	const sim = await externalJson<{
		similarartists?: { artist?: { name: string; match: string }[] };
	}>(ctx, q("artist.getsimilar", { artist, limit: "15", autocorrect: "1" }));
	const similar = weightedShuffle(
		sim?.similarartists?.artist ?? [],
		(a) => Number(a.match) + 0.1,
		ctx.rng,
	).slice(0, 2);
	for (const a of similar) {
		if (ctx.budget.left <= RESERVE + 2) return;
		const top = await externalJson<{
			toptracks?: { track?: { name: string; artist: { name: string } }[] };
		}>(ctx, q("artist.gettoptracks", { artist: a.name, limit: "8", autocorrect: "1" }));
		const tracks = weightedShuffle(top?.toptracks?.track ?? [], () => 1, ctx.rng).slice(0, 2);
		for (const t of tracks) await verifyAndAdd(ctx, s, t.artist.name, t.name, "lastfm", 0.8);
	}
}

async function deezerRelated(
	ctx: DiscoveryContext,
	s: DiscoveryState,
	artist: string,
): Promise<void> {
	const base = ctx.env.deezerBase;
	const found = await externalJson<{ data?: { id: number; name: string }[] }>(
		ctx,
		`${base}/search/artist?q=${encodeURIComponent(artist)}&limit=1`,
	);
	const id = found?.data?.[0]?.id;
	if (!id) return;
	const rel = await externalJson<{ data?: { id: number; name: string }[] }>(
		ctx,
		`${base}/artist/${id}/related?limit=12`,
	);
	const related = weightedShuffle(rel?.data ?? [], () => 1, ctx.rng).slice(0, 2);
	for (const r of related) {
		if (ctx.budget.left <= RESERVE + 2) return;
		const top = await externalJson<{ data?: { title: string; artist: { name: string } }[] }>(
			ctx,
			`${base}/artist/${r.id}/top?limit=8`,
		);
		const tracks = weightedShuffle(top?.data ?? [], () => 1, ctx.rng).slice(0, 2);
		for (const t of tracks) await verifyAndAdd(ctx, s, t.artist.name, t.title, "deezer", 0.75);
	}
}

async function genreSearch(
	ctx: DiscoveryContext,
	s: DiscoveryState,
	artistId: string,
): Promise<void> {
	const artist = await ctx.client.artist(artistId);
	const genres = artist?.genres ?? [];
	if (genres.length === 0) return;
	const genre = genres[Math.floor(ctx.rng() * genres.length)]!;
	const offset = Math.floor(ctx.rng() * 20) * 10;
	const tracks = await ctx.client.searchTracks(`genre:"${genre}"`, 10, offset);
	for (const t of tracks.slice(0, 4)) consider(ctx, s, t, "genre", 0.5);
}

/** Look a suggestion up on Spotify and keep it only if the artist matches. */
async function verifyAndAdd(
	ctx: DiscoveryContext,
	s: DiscoveryState,
	artist: string,
	title: string,
	source: string,
	score: number,
): Promise<void> {
	if (!artist || !title || ctx.budget.left <= RESERVE) return;
	const q = `track:"${clean(title)}" artist:"${clean(artist)}"`;
	const hits = await ctx.client.searchTracks(q, 3);
	const want = norm(artist);
	const hit = hits.find((t) =>
		t.artists?.some(
			(a) => norm(a.name) === want || norm(a.name).includes(want) || want.includes(norm(a.name)),
		),
	);
	consider(ctx, s, hit, source, score);
}

function clean(s: string): string {
	return s.replace(/["\\]/g, "").slice(0, 100);
}

function norm(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

// ---------------------------------------------------------------------------
// AI suggestions
// ---------------------------------------------------------------------------

const SUGGESTION_SCHEMA = {
	type: "object",
	properties: {
		songs: {
			type: "array",
			items: {
				type: "object",
				properties: { artist: { type: "string" }, title: { type: "string" } },
				required: ["artist", "title"],
				additionalProperties: false,
			},
		},
	},
	required: ["songs"],
	additionalProperties: false,
} as const;

function prompt(ctx: DiscoveryContext): string {
	const seeds = ctx
		.seeds()
		.slice(0, 25)
		.map((x) => x.name);
	return [
		`A listener's radio station is called "${ctx.stationName}".`,
		`Artists they love on it, most loved first: ${seeds.join(", ")}.`,
		"Suggest 20 real, existing songs (studio versions) this listener probably does NOT know yet but would enjoy on this station.",
		"Mix well-known deep cuts, adjacent artists and a few newer releases. Do not suggest songs by the listed artists' most famous hits.",
		"Answer only with the JSON object.",
	].join("\n");
}

async function aiSuggestions(ctx: DiscoveryContext): Promise<{ artist: string; title: string }[]> {
	if (ctx.seeds().length === 0) return [];
	if (ctx.env.anthropicKey) {
		const client = new Anthropic({
			apiKey: ctx.env.anthropicKey,
			fetch: (input, init) => ctx.fetch(new Request(input, init)),
		});
		ctx.budget.take();
		const res = await client.messages.create({
			model: ctx.env.anthropicModel,
			max_tokens: 4000,
			messages: [{ role: "user", content: prompt(ctx) }],
			output_config: { effort: "low", format: { type: "json_schema", schema: SUGGESTION_SCHEMA } },
		} as Anthropic.MessageCreateParamsNonStreaming);
		for (const block of res.content) {
			if (block.type === "text") return parseSuggestions(block.text);
		}
		return [];
	}
	if (ctx.ai) {
		const out = (await ctx.ai.run(WORKERS_AI_MODEL, {
			messages: [
				{
					role: "system",
					content:
						'You recommend music. Reply with JSON only: {"songs":[{"artist":"...","title":"..."}]}',
				},
				{ role: "user", content: prompt(ctx) },
			],
			max_tokens: 1500,
		})) as { response?: unknown };
		const text =
			typeof out?.response === "string" ? out.response : JSON.stringify(out?.response ?? "");
		return parseSuggestions(text);
	}
	return [];
}

export function parseSuggestions(text: string): { artist: string; title: string }[] {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return [];
	try {
		const data = JSON.parse(text.slice(start, end + 1)) as { songs?: unknown };
		if (!Array.isArray(data.songs)) return [];
		return data.songs
			.filter((x): x is { artist: string; title: string } => {
				const o = x as Record<string, unknown>;
				return typeof o?.artist === "string" && typeof o?.title === "string";
			})
			.slice(0, 25)
			.map((x) => ({ artist: x.artist.slice(0, 120), title: x.title.slice(0, 160) }));
	} catch {
		return [];
	}
}
