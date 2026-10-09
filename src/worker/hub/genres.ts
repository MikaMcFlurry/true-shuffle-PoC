/**
 * The listener's genre mix, estimated by an AI from their most-played artists
 * and how much they were heard. An estimate, labelled as one: Spotify is not
 * asked (its genre data costs requests from a shared, tight quota).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Fetcher } from "../spotify/client";
import { type AiRunner, WORKERS_AI_MODEL } from "./discovery";
import type { HubEnv } from "./hub";

export interface GenreEstimate {
	at: number;
	source: "anthropic" | "workers-ai";
	/** How many artists the estimate rests on. */
	artists: number;
	genres: { name: string; share: number }[];
	/** Two or three sentences about the listener's music, in German. */
	summary: string;
}

const GENRE_SCHEMA = {
	type: "object",
	properties: {
		genres: {
			type: "array",
			items: {
				type: "object",
				properties: { name: { type: "string" }, share: { type: "number" } },
				required: ["name", "share"],
				additionalProperties: false,
			},
		},
		summary: { type: "string" },
	},
	required: ["genres", "summary"],
	additionalProperties: false,
} as const;

function prompt(artists: { name: string; share: number }[]): string {
	return [
		"These are a music listener's most-played artists, with each artist's share of their listening time:",
		...artists.map((a) => `- ${a.name}: ${a.share.toFixed(1)} %`),
		"",
		"Estimate the listener's genre mix from this. Give 4 to 10 genres with common German genre names (e.g. Indie-Rock, Deutschrap, Elektro, Pop, Singer-Songwriter), each with its share in percent; the shares add up to 100. Weight each artist by its share.",
		'Then write "summary": two or three short German sentences in du-form describing the listener\'s musical character, concrete and without flattery. Mention only what the list supports.',
		"Answer only with the JSON object.",
	].join("\n");
}

/** Cleans what the model returned: named genres, shares scaled to 100, at most 10. */
export function parseGenres(
	text: string,
): { genres: GenreEstimate["genres"]; summary: string } | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const data = JSON.parse(text.slice(start, end + 1)) as {
			genres?: unknown;
			summary?: unknown;
		};
		if (!Array.isArray(data.genres)) return null;
		const raw = data.genres
			.map((g) => g as { name?: unknown; share?: unknown })
			.filter(
				(g): g is { name: string; share: number } =>
					typeof g.name === "string" &&
					g.name.trim().length > 0 &&
					typeof g.share === "number" &&
					Number.isFinite(g.share) &&
					g.share > 0,
			)
			.slice(0, 10);
		const sum = raw.reduce((a, g) => a + g.share, 0);
		if (raw.length === 0 || sum <= 0) return null;
		return {
			genres: raw
				.map((g) => ({ name: g.name.trim().slice(0, 60), share: (g.share / sum) * 100 }))
				.sort((a, b) => b.share - a.share),
			summary: typeof data.summary === "string" ? data.summary.trim().slice(0, 600) : "",
		};
	} catch {
		return null;
	}
}

/** How long one estimate may take before it counts as failed. */
export const GENRE_TIMEOUT_MS = 20_000;
/** Attempts, failed or not, are at least this far apart. */
export const GENRE_EVERY_MS = 6 * 3_600_000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("genre estimate timed out")), GENRE_TIMEOUT_MS);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}

/** What the page gets back: the estimate kept, and when the next try is allowed. */
export interface GenreAnswer {
	estimate: GenreEstimate | null;
	retryAt: number | null;
	/** This request asked the AI and got nothing usable. */
	failed: boolean;
}

/** A prepared request: the artists to send and the attempt it belongs to. */
export interface GenreRequest {
	attempt: string;
	artists: { name: string; share: number }[];
}

type Locked<T> = Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;

/**
 * One estimate, with the account's lock held only to prepare and to store:
 * the AI call itself runs outside it, so playback commands never wait on it.
 * `store` publishes only for the same attempt and session (it fences).
 */
export async function requestGenres<E>(
	locked: <T>(fn: () => T | Promise<T>) => Locked<T>,
	prepare: () => { answer: GenreAnswer; request: GenreRequest | null },
	run: (artists: GenreRequest["artists"]) => Promise<GenreEstimate | null>,
	store: (attempt: string, est: GenreEstimate | null) => GenreAnswer,
): Promise<{ ok: true; value: GenreAnswer } | { ok: false; error: E }> {
	const prep = await locked(prepare);
	if (!prep.ok) return prep as { ok: false; error: E };
	const { request, answer } = prep.value;
	if (!request) return { ok: true, value: answer };
	let est: GenreEstimate | null = null;
	try {
		est = await run(request.artists);
	} catch {
		est = null;
	}
	const done = await locked(() => store(request.attempt, est));
	return done as { ok: true; value: GenreAnswer } | { ok: false; error: E };
}

export async function estimateGenres(
	env: HubEnv,
	fetch: Fetcher,
	ai: AiRunner | null,
	artists: { name: string; share: number }[],
	now: number,
): Promise<GenreEstimate | null> {
	if (artists.length === 0) return null;
	if (env.anthropicKey) {
		// Optional and never waited on for long: one try, bounded.
		const client = new Anthropic({
			apiKey: env.anthropicKey,
			fetch: (input, init) => fetch(new Request(input, init)),
			timeout: GENRE_TIMEOUT_MS,
			maxRetries: 0,
		});
		const res = await client.messages.create({
			model: env.anthropicModel,
			max_tokens: 4000,
			messages: [{ role: "user", content: prompt(artists) }],
			output_config: { effort: "low", format: { type: "json_schema", schema: GENRE_SCHEMA } },
		} as Anthropic.MessageCreateParamsNonStreaming);
		if (res.stop_reason === "refusal") return null;
		for (const block of res.content) {
			if (block.type !== "text") continue;
			const out = parseGenres(block.text);
			return out ? { at: now, source: "anthropic", artists: artists.length, ...out } : null;
		}
		return null;
	}
	if (ai) {
		const out = (await withTimeout(
			ai.run(WORKERS_AI_MODEL, {
				messages: [
					{
						role: "system",
						content:
							'You describe music taste. Reply with JSON only: {"genres":[{"name":"...","share":0}],"summary":"..."}',
					},
					{ role: "user", content: prompt(artists) },
				],
				max_tokens: 1200,
			}),
		)) as { response?: unknown };
		const text =
			typeof out?.response === "string" ? out.response : JSON.stringify(out?.response ?? "");
		const parsed = parseGenres(text);
		return parsed ? { at: now, source: "workers-ai", artists: artists.length, ...parsed } : null;
	}
	return null;
}
