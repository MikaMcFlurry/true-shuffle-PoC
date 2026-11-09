import { SpotifyError } from "./client";

/** RPC cannot be aborted; reject boundedly and keep the provider gate closed on failure. */
export function boundedSpotifyRpc<T>(work: Promise<T>, timeoutMs = 15000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() =>
				reject(
					new SpotifyError(
						"network",
						"Die Spotify-Anbietersperre konnte nicht rechtzeitig geprüft werden",
						503,
					),
				),
			timeoutMs,
		);
		work
			.then(resolve, () =>
				reject(new SpotifyError("network", "Die Spotify-Anbietersperre ist nicht erreichbar", 503)),
			)
			.finally(() => clearTimeout(timer));
	});
}
