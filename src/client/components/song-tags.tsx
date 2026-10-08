/**
 * Plain-word tags for a song: why it is in the queue and what the listener's
 * history says about it. Only facts the API delivers are shown; nothing is guessed.
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
): { text: string; tone: "new" | "fav" | "first" | "known" }[] {
	const k = facts?.kind ?? kind ?? null;
	const tags: { text: string; tone: "new" | "fav" | "first" | "known" }[] = [];
	if (k === "discovery") tags.push({ text: "Neu für dich", tone: "new" });
	if (k === "favorite" || thumb === 1) tags.push({ text: "Favorit", tone: "fav" });
	if (facts) {
		if (facts.plays === 0) {
			// Without an imported history, true-shuffle only knows what it counted itself.
			if (k !== "discovery")
				tags.push({ text: known ? "Noch nie gehört" : "Bisher nicht gehört", tone: "new" });
		} else {
			if (!facts.inStation) tags.push({ text: "Zum ersten Mal hier", tone: "first" });
			tags.push({
				text:
					facts.plays === 1
						? `Einmal gehört${facts.lastPlayedAt ? `, ${ago(facts.lastPlayedAt)}` : ""}`
						: `${num(facts.plays)}× gehört${facts.lastPlayedAt ? `, zuletzt ${ago(facts.lastPlayedAt)}` : ""}`,
				tone: "known",
			});
		}
	} else if (k === "fresh") tags.push({ text: "In diesem Durchgang neu", tone: "first" });
	return tags;
}

export function SongTags(props: {
	kind?: SlotKind | null;
	facts?: SongFactsView | null;
	thumb?: -1 | 0 | 1;
	/** An imported Spotify history exists, so "never heard" is known, not guessed. */
	known?: boolean;
	class?: string;
}) {
	const tags = songTags(props.kind, props.facts ?? null, props.thumb ?? 0, props.known ?? true);
	if (!tags.length) return null;
	return (
		<ul class={`tags${props.class ? ` ${props.class}` : ""}`} aria-label="Über diesen Song">
			{tags.map((t) => (
				<li key={t.text} class={`tag tag--${t.tone}`}>
					{t.text}
				</li>
			))}
		</ul>
	);
}
