/**
 * P8: louder and quieter for the device Spotify plays on, e.g.
 * „Wohnzimmer · 35 %“. One step of five per tap; a device Spotify does not
 * let the app control says so instead of failing silently.
 */

import { Minus, Plus } from "lucide-preact";
import { useState } from "preact/hooks";
import { api } from "../api";
import { store } from "../store";

export function VolumeKeys({
	device,
	disabled,
}: {
	device: { id: string | null; name: string; volume?: number | null; volumeControl?: boolean };
	disabled: boolean;
}) {
	const [busy, setBusy] = useState(false);
	const [shown, setShown] = useState<number | null>(null);
	const volume = shown ?? device.volume ?? null;
	if (!device.id || device.volume === undefined) return null;
	const step = async (s: 1 | -1) => {
		setBusy(true);
		try {
			const r = await api.changeVolume(device.id!, s);
			setShown(r.volume);
			void store.refresh(true).finally(() => setShown(null));
		} catch (e) {
			store.say(e instanceof Error ? e.message : String(e), "error");
		} finally {
			setBusy(false);
		}
	};
	if (device.volumeControl === false)
		return (
			<p class="transport-note volume volume--fixed">
				{device.name}: Lautstärke nur am Gerät selbst einstellbar.
			</p>
		);
	return (
		<fieldset class="volume">
			<legend class="sr-only">Lautstärke von {device.name}</legend>
			<button
				type="button"
				class="volume__key"
				aria-label="Leiser"
				disabled={busy || disabled || volume === 0}
				onClick={() => void step(-1)}
			>
				<Minus aria-hidden="true" />
			</button>
			<span class="volume__value" aria-live="polite">
				{device.name} · {volume === null ? "?" : `${volume} %`}
			</span>
			<button
				type="button"
				class="volume__key"
				aria-label="Lauter"
				disabled={busy || disabled || volume === 100}
				onClick={() => void step(1)}
			>
				<Plus aria-hidden="true" />
			</button>
		</fieldset>
	);
}
