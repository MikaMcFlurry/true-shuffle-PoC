/**
 * Plain-word tags for a song: why it is in the queue and what the listener's
 * history says about it. Only what was recorded is claimed; nothing is guessed.
 */

import type { SlotKind } from "../../core/types";
import type { SongFacts } from "../../shared/api";
import { ago, num } from "../format";

export type SongFactsView = SongFacts;

export function factsOf(entry: { facts?: SongFacts } | null | undefined): SongFacts | null {
	return entry?.facts ?? null;
}

export type TagTone = "playlist" | "rec" | "fav" | "fact";

/**
 * First where the song comes from (one source tag), then what the history
 * says about it (facts). Two questions, never mixed in one word.
 */
export function songTags(
	kind: SlotKind | null | undefined,
	facts: SongFactsView | null,
	thumb: -1 | 0 | 1 = 0,
	/** An imported Spotify history exists; without one, plays only count from the start of true-shuffle. */
	known = true,
	short = false,
	/** A row in the Verlauf: the song was heard right there, so only the count is news. */
	history = false,
): { text: string; tone: TagTone }[] {
	const k = facts?.kind ?? kind ?? null;
	const tags: { text: string; tone: TagTone }[] = [];
	// Where it comes from.
	if (k === "discovery") tags.push({ text: "Empfehlung", tone: "rec" });
	else if (k === "favorite") tags.push({ text: "Favorit", tone: "fav" });
	// "fresh" is the cassette's own pool (its playlists, liked songs, kept
	// recommendations), so it claims the cassette, never a playlist.
	else if (k === "fresh") tags.push({ text: "Aus der Kassette", tone: "playlist" });
	if (thumb === 1 && k !== "favorite") tags.push({ text: "Favorit", tone: "fav" });
	if (!facts) return tags;
	// What was recorded about it. Only claims the records can carry: no stored
	// play is not proof of never hearing it (an import may be missing or
	// partial), and "not here" holds within the 180 days the plays log keeps.
	if (facts.plays === 0) {
		if (history) return tags;
		tags.push({
			text: known
				? short
					? "nicht im Verlauf"
					: "nicht in deinem Verlauf"
				: short
					? "noch nicht gezählt"
					: "noch nicht gezählt, kein Verlauf importiert",
			tone: "fact",
		});
		return tags;
	}
	if (!facts.inStation && !history)
		tags.push({
			text: short ? "lange nicht hier" : "in den letzten 180 Tagen nicht auf dieser Kassette",
			tone: "fact",
		});
	tags.push({
		text: short
			? `${num(facts.plays)}× gehört`
			: facts.plays === 1
				? `einmal gehört${facts.lastPlayedAt ? `, ${ago(facts.lastPlayedAt)}` : ""}`
				: `${num(facts.plays)}× gehört${facts.lastPlayedAt ? `, zuletzt ${ago(facts.lastPlayedAt)}` : ""}`,
		tone: "fact",
	});
	return tags;
}
