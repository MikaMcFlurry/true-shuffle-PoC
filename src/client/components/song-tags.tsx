/**
 * Plain-word tags for a song: why it is in the queue and what the listener's
 * history says about it. Only what was recorded is claimed; nothing is guessed.
 */

import type { SlotKind } from "../../core/types";
import { type SongFactsView, songTags } from "./song-tags-text";

export { factsOf, type SongFactsView, songTags } from "./song-tags-text";

export function SongTags(props: {
	kind?: SlotKind | null;
	facts?: SongFactsView | null;
	thumb?: -1 | 0 | 1;
	/** An imported Spotify history exists, so "never heard" is known, not guessed. */
	known?: boolean;
	class?: string;
}) {
	const tags = songTags(
		props.kind,
		props.facts ?? null,
		props.thumb ?? 0,
		props.known ?? true,
		props.class?.includes("tags--row") ?? false,
	);
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
