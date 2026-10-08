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

export function songTags(
	kind: SlotKind | null | undefined,
	facts: SongFactsView | null,
	thumb: -1 | 0 | 1 = 0,
	known = true,
	short = false,
): { text: string; tone: "new" | "fav" | "first" | "known" }[] {
	const k = facts?.kind ?? kind ?? null;
	const tags: { text: string; tone: "new" | "fav" | "first" | "known" }[] = [];
	if (k === "discovery") tags.push({ text: "Neu für dich", tone: "new" });
	if (k === "favorite" || thumb === 1) tags.push({ text: "Favorit", tone: "fav" });
	if (facts) {
		if (facts.plays === 0) {
			// Only what was recorded: an import may be partial, and without one
			// true-shuffle knows only what it counted itself.
			if (k !== "discovery")
				tags.push({
					text: known
						? short
							? "laut Verlauf neu"
							: "Laut deinem Verlauf noch nie gehört"
						: "Bisher nicht gehört",
					tone: "new",
				});
		} else {
			// The plays log keeps at least 180 days: "not here" is only claimed for that span.
			if (!facts.inStation)
				tags.push({
					text: short ? "lange nicht hier" : "In den letzten 180 Tagen nicht auf dieser Kassette",
					tone: "first",
				});
			tags.push({
				text: short
					? `${num(facts.plays)}× gehört`
					: facts.plays === 1
						? `Einmal gehört${facts.lastPlayedAt ? `, ${ago(facts.lastPlayedAt)}` : ""}`
						: `${num(facts.plays)}× gehört${facts.lastPlayedAt ? `, zuletzt ${ago(facts.lastPlayedAt)}` : ""}`,
				tone: "known",
			});
		}
	} else if (k === "fresh") tags.push({ text: "In diesem Durchgang neu", tone: "first" });
	return tags;
}
