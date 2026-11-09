/**
 * P5: „Nach diesem Song fortsetzen“ while Spotify plays a song outside the
 * true-shuffle order. Nothing is sent to Spotify now: the song plays out,
 * true-shuffle goes on only once a look saw it end, and „Abbrechen“ has no
 * effect beyond forgetting the wish.
 */

import { useState } from "preact/hooks";
import type { ContinueAfterView } from "../../shared/api";
import { api } from "../api";
import { store } from "../store";

export function ContinueAfter({
	trackId,
	armed,
	disabled,
}: {
	trackId: string;
	armed: ContinueAfterView | null;
	disabled: boolean;
}) {
	const [busy, setBusy] = useState(false);
	const waiting = armed?.trackId === trackId;
	const act = async (fn: () => Promise<unknown>, said: string) => {
		setBusy(true);
		try {
			await fn();
			store.say(said, "info");
			await store.refresh(true, true);
		} catch (e) {
			store.say(e instanceof Error ? e.message : String(e), "error");
		} finally {
			setBusy(false);
		}
	};
	return waiting ? (
		<div class="stack continue-after" role="status">
			<p>
				<strong>Gemerkt: Nach diesem Song soll es mit TrueShuffle weitergehen.</strong> Der Song
				läuft ganz zu Ende. Fortgesetzt wird nur, wenn Spotify ihn angehalten an seinem Ende zeigt.
				Läuft danach etwas anderes oder steht die Wiedergabe, startet true-shuffle nichts und sagt
				dir Bescheid.
			</p>
			<button
				type="button"
				class="key"
				disabled={busy}
				onClick={() =>
					void act(
						() => api.cancelContinueAfter(),
						"Abgebrochen. Spotify spielt weiter wie bisher.",
					)
				}
			>
				Abbrechen
			</button>
		</div>
	) : (
		<button
			type="button"
			class="key key--lit"
			disabled={busy || disabled}
			onClick={() =>
				void act(
					() => api.continueAfter(trackId),
					"Gemerkt: Nach diesem Song soll es mit TrueShuffle weitergehen.",
				)
			}
		>
			Nach diesem Song fortsetzen
		</button>
	);
}
