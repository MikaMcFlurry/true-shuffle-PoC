/**
 * P4: the Likes and their private Spotify playlist „TrueShuffle Likes“.
 * Says plainly whether Spotify has the newest state, and offers to write it
 * again when it failed — the Kassette plays either way.
 */

import { useState } from "preact/hooks";
import type { LikesView } from "../../shared/api";
import { api } from "../api";
import { ago, num } from "../format";
import { store } from "../store";

export function likesLine(likes: LikesView, now = Date.now()): string {
	const songs = likes.count === 1 ? "1 Song" : `${num(likes.count)} Songs`;
	const s = likes.sync;
	if (s.error)
		return `${songs}. Die Spotify-Playlist „TrueShuffle Likes“ ist nicht auf dem neuesten Stand.`;
	if (s.pending)
		return `${songs}. Die Spotify-Playlist „TrueShuffle Likes“ wird gleich abgeglichen.`;
	if (s.syncedAt !== null)
		return `${songs}, genauso in deiner privaten Spotify-Playlist „TrueShuffle Likes“ (abgeglichen ${ago(s.syncedAt, now)}).`;
	return `${songs}. Die private Spotify-Playlist „TrueShuffle Likes“ entsteht beim ersten Daumen hoch.`;
}

export function LikesStatus({ likes }: { likes: LikesView }) {
	const [busy, setBusy] = useState(false);
	const retry = async () => {
		setBusy(true);
		try {
			await api.likesSync();
			store.say("Wird gleich neu abgeglichen.", "info");
			await store.refresh(true, true);
		} catch (e) {
			store.say(e instanceof Error ? e.message : String(e), "error");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div class="stack likes-status" role="status">
			<p class="section__lead">{likesLine(likes)}</p>
			{likes.sync.error ? (
				<>
					<p class="notice notice--warn">Spotify hat die letzte Änderung nicht angenommen.</p>
					<button type="button" class="key" disabled={busy} onClick={() => void retry()}>
						Erneut abgleichen
					</button>
				</>
			) : null}
			{likes.playlistId ? (
				<a
					class="act"
					href={`https://open.spotify.com/playlist/${likes.playlistId}`}
					target="_blank"
					rel="noopener noreferrer"
				>
					In Spotify öffnen
				</a>
			) : null}
		</div>
	);
}
