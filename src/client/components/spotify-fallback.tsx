/**
 * P3: when Deezer has no sample, two deliberate ways on — never automatic:
 * step 2 plays the song in Spotify on the named device after the listener
 * confirmed that it replaces what plays there; step 3 opens it in Spotify.
 */

import { ExternalLink, Play } from "lucide-preact";
import { useState } from "preact/hooks";
import type { HistoryEntry } from "../../shared/api";
import { api } from "../api";
import { store } from "../store";

export function SpotifyFallback({ t }: { t: HistoryEntry }) {
	const [asking, setAsking] = useState(false);
	const [busy, setBusy] = useState(false);
	const state = store.load.kind === "ready" ? store.load.state : null;
	const seen = state?.observed?.device ?? null;
	const device = seen?.id ? { id: seen.id, name: seen.name ?? "dem Gerät" } : null;
	const link = `https://open.spotify.com/track/${t.id}`;
	const play = async () => {
		if (!device) return;
		setBusy(true);
		try {
			const r = await api.playFromHistory(t.id, t.playedAt, device.id);
			store.say(`„${t.name}“ läuft auf ${r.deviceName ?? device.name}.`, "info");
			setAsking(false);
			await store.refresh(true, true);
		} catch (e) {
			store.say(e instanceof Error ? e.message : String(e), "error");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div class="spotify-fallback">
			{asking && device ? (
				<div class="stack" role="group" aria-label="In Spotify abspielen?">
					<p>
						Spielt „{t.name}“ in Spotify auf <strong>{device.name}</strong>. Was dort gerade läuft,
						wird unterbrochen; deine TrueShuffle-Stelle bleibt gespeichert.
					</p>
					<div class="row-actions">
						<button type="button" class="key" disabled={busy} onClick={() => setAsking(false)}>
							Abbrechen
						</button>
						<button type="button" class="key key--lit" disabled={busy} onClick={() => void play()}>
							Auf {device.name} abspielen
						</button>
					</div>
				</div>
			) : (
				<div class="row-actions">
					{device ? (
						<button type="button" class="key" onClick={() => setAsking(true)}>
							<Play size={18} aria-hidden="true" />
							In Spotify abspielen …
						</button>
					) : null}
					<a class="key" href={link} target="_blank" rel="noopener noreferrer">
						<ExternalLink size={18} aria-hidden="true" />
						In Spotify öffnen
					</a>
				</div>
			)}
		</div>
	);
}
