import { ThumbsDown, ThumbsUp } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import type { TrackView } from "../../shared/api";
import { api } from "../api";
import { store, useStore } from "../store";
import { Cover } from "./radio";

const SAID = {
	1: "Als Favorit gemerkt",
	0: "Bewertung zurückgesetzt",
	"-1": "Kommt nie wieder",
} as const;

/** A song in a list can be rated afterwards: the whole row opens the sheet. */
export function RateHit({ t }: { t: TrackView }) {
	return (
		<button
			type="button"
			class="track__hit"
			aria-label={`${t.name} — ${t.artists} bewerten`}
			onClick={() => store.rate(t)}
		/>
	);
}

/** Its thumb, if it has one. */
export function ThumbMark({ t }: { t: TrackView }) {
	useStore();
	const v = store.thumbOf(t);
	if (v === 1)
		return <ThumbsUp class="track__thumb track__thumb--up" aria-label="Favorit" role="img" />;
	if (v === -1) return <ThumbsDown class="track__thumb" aria-label="Kommt nie wieder" role="img" />;
	return null;
}

/** Thumb up or down for a song from a list: now or long after it played. */
export function RateSheet() {
	const s = useStore();
	const t = s.rating;
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (t && !d.open) d.showModal();
		if (!t && d.open) d.close();
	}, [t]);
	const cur = t ? store.thumbOf(t) : 0;
	const set = (v: -1 | 0 | 1) => {
		if (!t) return;
		api
			.thumb(t.id, v)
			.then(() => {
				store.thumbs.set(t.id, v);
				store.say(SAID[v], "info", 3500);
			})
			.catch((e: Error) => store.say(e.message, "error"))
			.finally(() => {
				store.rate(null);
				window.setTimeout(() => void store.refresh(true), 800);
			});
	};
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes a modal dialog natively; the tap beside it is only a pointer convenience
		<dialog
			ref={ref}
			class="sheet"
			aria-labelledby="rate-title"
			onClose={() => {
				if (store.rating) store.rate(null);
			}}
			onClick={(e) => {
				// A tap beside the sheet closes it.
				if (e.target === ref.current) store.rate(null);
			}}
		>
			{t ? (
				<div class="sheet__body">
					<div class="sheet__song">
						<Cover src={t.imageUrl} class="cover--md" />
						<div class="track__main">
							<p id="rate-title" class="track__title">
								{t.name}
							</p>
							<p class="track__sub">{t.artists}</p>
						</div>
					</div>
					<div class="sheet__actions">
						<button
							type="button"
							class="key btn"
							aria-pressed={cur === 1}
							onClick={() => set(cur === 1 ? 0 : 1)}
						>
							<ThumbsUp class="icon" aria-hidden="true" />
							{cur === 1 ? "Kein Favorit mehr" : "Daumen hoch: Favorit"}
						</button>
						<button
							type="button"
							class="key btn"
							aria-pressed={cur === -1}
							onClick={() => set(cur === -1 ? 0 : -1)}
						>
							<ThumbsDown class="icon" aria-hidden="true" />
							{cur === -1 ? "Wieder zulassen" : "Daumen runter: nie wieder"}
						</button>
						<button type="button" class="key btn" onClick={() => store.rate(null)}>
							Abbrechen
						</button>
					</div>
				</div>
			) : null}
		</dialog>
	);
}
