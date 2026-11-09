/**
 * S1: the Verlauf search. The Verlauf is read once per app session (and
 * then only what was played since), the search itself runs here — typing
 * never asks the server (P1: no Durable Object read per keystroke).
 */

import type { HistoryEntry, HistorySearchAnswer } from "../shared/api";
import { matches, normalize, queryWords } from "../shared/search";

export interface SearchSong {
	entry: HistoryEntry;
	/** Every play of the song, newest first. */
	plays: number[];
	text: string;
}

export interface SearchIndex {
	account: string;
	through: number;
	complete: boolean;
	songs: Map<string, SearchSong>;
}

type Fetch = (since: number) => Promise<HistorySearchAnswer>;

/** Fold an answer into the index (a newer play of a known song moves it up). */
export function merge(index: SearchIndex, answer: HistorySearchAnswer): SearchIndex {
	for (const { entry, plays } of answer.songs) {
		const known = index.songs.get(entry.id);
		const all = known ? [...new Set([...plays, ...known.plays])].sort((a, b) => b - a) : plays;
		const newer = !known || entry.playedAt >= known.entry.playedAt ? entry : known.entry;
		index.songs.set(entry.id, {
			entry: newer,
			plays: all,
			text: normalize(`${newer.name} ${newer.artists}`),
		});
	}
	index.through = Math.max(index.through, answer.through);
	if (index.songs.size === answer.songs.length) index.complete = answer.complete;
	return index;
}

/** The songs matching a query, the most recently heard first (at most `limit`). */
export function search(index: SearchIndex, query: string, limit = 50): SearchSong[] {
	const words = queryWords(query);
	if (words.length === 0) return [];
	const out: SearchSong[] = [];
	for (const s of index.songs.values()) if (matches(s.text, words)) out.push(s);
	out.sort((a, b) => b.entry.playedAt - a.entry.playedAt);
	return out.slice(0, limit);
}

/**
 * The index of this account: the first call reads the whole Verlauf, later
 * ones (opening the search again) only plays after the newest one known.
 * A request belongs to the account it was sent for: another account never
 * joins it, and an answer arriving after `forget` (signing out) or after
 * another account asked changes nothing.
 */
export class HistorySearch {
	private index: SearchIndex | null = null;
	private loading: { account: string; promise: Promise<SearchIndex> } | null = null;
	/** Counts every `forget` and account change: an older request's answer is dropped. */
	private generation = 0;
	/** Requests sent, for the P1 measurement. */
	requests = 0;
	constructor(private readonly fetcher: Fetch) {}

	load(account: string, again = false): Promise<SearchIndex> {
		if (
			(this.index && this.index.account !== account) ||
			(this.loading && this.loading.account !== account)
		)
			this.forget();
		if (this.loading) return this.loading.promise;
		if (this.index && !again) return Promise.resolve(this.index);
		const gen = this.generation;
		const base: SearchIndex = this.index
			? { ...this.index, songs: new Map(this.index.songs) }
			: { account, through: 0, complete: true, songs: new Map() };
		this.requests++;
		const promise = this.fetcher(base.through)
			.then((answer) => {
				// Only the account that asked gets it; nothing is kept for later.
				const index = merge(base, answer);
				if (gen === this.generation) this.index = index;
				return index;
			})
			.finally(() => {
				if (this.loading?.promise === promise) this.loading = null;
			});
		this.loading = { account, promise };
		return promise;
	}

	/** Signing out, or another account: nothing known or on its way counts any more. */
	forget(): void {
		this.generation++;
		this.index = null;
		this.loading = null;
	}
}
