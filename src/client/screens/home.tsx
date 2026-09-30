import {
	Check,
	Heart,
	ListMusic,
	Music2,
	Pause,
	Play,
	SkipForward,
	Speaker,
	ThumbsDown,
} from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { sharesForRules } from "../../core/mix";
import type { AppState, DeviceView, StationSummary, TrackView } from "../../shared/api";
import { api, type NativeDevice } from "../api";
import { Cover } from "../components/radio";
import { RateHit, ThumbMark } from "../components/rate";
import { duration, pct } from "../format";
import { store, useStore } from "../store";

export function roundLabel(s: StationSummary): string {
	return `Runde ${s.roundNo || 1}`;
}

const SESSION_LABELS = {
	active: "Spielt",
	paused: "Pausiert",
	disconnected: "Gerät nicht verbunden",
	external: "Andere Musik spielt",
	ambiguous: "Geräte-Position nicht eindeutig",
	saved: "Zum Fortsetzen gespeichert",
};

export function Home({ state }: { state: AppState }) {
	const s = useStore();
	const session = state.session;
	const [selected, setSelected] = useState<number | null>(null);
	const station =
		state.stations.find((x) => x.id === (selected ?? session?.stationId)) ??
		state.stations.find((x) => x.playing) ??
		state.stations[0];
	const [nativeDevices, setNativeDevices] = useState<NativeDevice[]>([]);
	const [nativeConfigured, setNativeConfigured] = useState(false);
	const [nativeError, setNativeError] = useState("");
	const [devices, setDevices] = useState<DeviceView[] | null>(null);
	const [device, setDevice] = useState(() => {
		try {
			return localStorage.getItem("ts-device") ?? "";
		} catch {
			return "";
		}
	});
	const [deviceError, setDeviceError] = useState("");
	const [busy, setBusy] = useState(false);
	const [confirm, setConfirm] = useState(false);
	const refreshDevices = () => {
		setDeviceError("");
		void api
			.nativeDevices()
			.then((result) => {
				setNativeDevices(result.devices);
				setNativeConfigured(result.configured);
				setNativeError("");
			})
			.catch((e: Error) => setNativeError(e.message));
		void api
			.devices()
			.then((list) => {
				setDevices(list);
				setDevice((current) =>
					current.startsWith("native:") || list.some((d) => d.id === current && !d.restricted)
						? current
						: "",
				);
			})
			.catch((e: Error) => setDeviceError(e.message));
	};
	useEffect(() => {
		refreshDevices();
	}, []);
	const savedTrack =
		session?.queue.find((e) => e.entryId === session.entryId)?.track ?? session?.queue[0]?.track;
	const ownNow =
		state.nowPlaying &&
		state.nowPlaying.stationId === session?.stationId &&
		(!savedTrack || state.nowPlaying.id === savedTrack.id)
			? state.nowPlaying
			: null;
	const track = savedTrack ?? ownNow;
	const progress = session ? session.progressMs : ownNow ? ownNow.progressMs : null;
	const nativeController =
		session?.controller?.kind === "home-assistant" ? session.controller : null;
	const activeNative = nativeDevices.find((d) => d.id === nativeController?.deviceId);
	const selectedNative = nativeDevices.find((d) => `native:${d.id}` === device);
	const playing =
		session?.status === "active" &&
		(!!ownNow?.isPlaying || !!nativeController) &&
		station?.id === session.stationId;
	const expected = session
		? {
				sessionId: session.sessionId,
				entryId: session.entryId,
				orderRevision: session.orderRevision,
			}
		: undefined;
	const act = async (action: "play" | "pause" | "next" | "new") => {
		if (busy || s.stale) return;
		setBusy(true);
		try {
			let result = null;
			if ((action === "pause" || action === "next") && nativeController && session)
				result = await api.nativePlayer(
					session.stationId,
					nativeController.deviceId,
					action,
					expected,
				);
			else if (action === "pause" || action === "next")
				result = await api.player(action, {
					sessionId: session?.sessionId,
					entryId: session?.entryId,
				});
			else if (station && selectedNative)
				result = await api.nativePlay(station.id, selectedNative.id, {
					...expected,
					newQueue: action === "new",
				});
			else if (station && nativeController && !device && action === "new")
				result = await api.nativePlay(station.id, nativeController.deviceId, {
					...expected,
					newQueue: true,
				});
			else if (
				station &&
				nativeController &&
				!device &&
				action === "play" &&
				station.id === session?.stationId
			)
				result = await api.nativePlayer(station.id, nativeController.deviceId, "resume", expected);
			else if (station)
				result = await api.play(
					station.id,
					device === "spotify" ? undefined : device || undefined,
					{
						newQueue: action === "new",
						sessionId: station.id === session?.stationId ? session.sessionId : undefined,
					},
				);

			if (result && !result.ok)
				store.say(result.error?.message ?? "Wiedergabe nicht möglich.", "error");
			else if (action === "new") {
				setConfirm(false);
				store.say("Neue Warteschlange gespeichert");
			}
			await store.refresh(true);
		} catch (e) {
			store.say(e instanceof Error ? e.message : String(e), "error");
		} finally {
			setBusy(false);
		}
	};
	const retrySaved = async () => {
		if (!session || busy || s.stale) return;
		setBusy(true);
		try {
			const spotifyDevice =
				device && device !== "spotify" && !device.startsWith("native:") ? device : undefined;
			const result = await api.play(session.stationId, spotifyDevice, {
				sessionId: session.sessionId,
			});
			if (!result.ok)
				store.say(
					result.error?.message ?? "Der gespeicherte Song konnte noch nicht fortgesetzt werden.",
					"error",
				);
			await store.refresh(true);
		} catch (e) {
			store.say(e instanceof Error ? e.message : String(e), "error");
		} finally {
			setBusy(false);
		}
	};
	const thumb = async (value: -1 | 1) => {
		if (!track) return;
		try {
			const next = store.thumbOf(track) === value ? 0 : value;
			await api.thumb(track.id, next);
			store.setThumb(track.id, next);
			store.say(
				next === 1
					? "Als Favorit gemerkt"
					: next === -1
						? "Kommt nie wieder"
						: "Bewertung zurückgesetzt",
			);
			await store.refresh(true);
		} catch (e) {
			store.say(e instanceof Error ? e.message : String(e), "error");
		}
	};
	return (
		<div class="listening-workspace">
			<section class="player" aria-labelledby="listen-title">
				<div class="player-heading">
					<h1 id="listen-title">Deine Musik. Weiterhören.</h1>
					<p class="muted">
						{state.guest.active
							? "Gast-Modus · zählt nicht ins Gedächtnis"
							: "Entdecken, wiederfinden, in Ruhe weiterhören."}
					</p>
				</div>
				<div class="now-shelf">
					<Cover src={track?.imageUrl ?? station?.imageUrl} class="player-art" />
					<div class="now-copy">
						<p class="session-status">
							<Check size={16} aria-hidden="true" />
							{session ? SESSION_LABELS[session.status] : "Bereit für deine Musik"}
						</p>
						<h2>{track?.name ?? "Dein nächster Lieblingssong"}</h2>
						<p class="artist">
							{track?.artists ?? "Wähle einen Sender und starte deine Warteschlange."}
						</p>
						{track?.album ? <p class="muted">{track.album}</p> : null}
						<p class="saved-note">
							{session
								? "Song und Reihenfolge bleiben gespeichert — auch wenn du die App schließt."
								: "Deine Playlists, mit einem Gedächtnis für jeden Song."}
						</p>
					</div>
				</div>
				{track ? (
					<div class="progress-area">
						<progress
							aria-label="Zuletzt beobachtete Songposition"
							max={track.durationMs || 1}
							value={progress ?? 0}
						/>
						<div class="progress-labels">
							<span>
								{progress === null
									? "Position unbekannt · derselbe Song von vorne"
									: `${duration(progress)} gespeichert`}
							</span>
							<span>{duration(track.durationMs)}</span>
						</div>
					</div>
				) : null}
				{session?.pending ? (
					<p class="notice">
						Das Gerät bestätigt den Wechsel noch. Der bisherige Song bleibt gesichert.
					</p>
				) : null}
				{session?.pending && !nativeController ? (
					<div class="notice">
						<p>
							Es ist unklar, ob Spotify den Befehl ausgeführt hat. Erneutes Fortsetzen spielt
							denselben gespeicherten Song und kann auf die zuletzt gespeicherte Position
							zurückspringen.
						</p>
						<button
							type="button"
							class="key"
							disabled={busy || s.stale}
							onClick={() => void retrySaved()}
						>
							Gespeicherten Song erneut fortsetzen
						</button>
					</div>
				) : null}

				{session?.status === "external" ? (
					<p class="notice">
						Deine gespeicherte Warteschlange bleibt erhalten. „Fortsetzen“ wechselt bewusst zurück
						zu true-shuffle.
					</p>
				) : null}
				<div class="transport-shelf">
					<div class="transport">
						<button
							type="button"
							class="primary transport-main"
							disabled={
								busy ||
								s.stale ||
								!station?.ready ||
								session?.pending ||
								(playing && !!nativeController && !activeNative?.pause)
							}
							onClick={() => void act(playing ? "pause" : "play")}
						>
							{playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
							{busy
								? "Bitte warten …"
								: playing
									? "Pause"
									: session?.stationId === station?.id
										? "Fortsetzen"
										: "Wiedergabe starten"}
						</button>
						<button
							type="button"
							class="icon-button"
							aria-label="Weiter: Nächster Song"
							disabled={
								busy ||
								s.stale ||
								!session ||
								session.pending ||
								session.status === "ambiguous" ||
								(!!nativeController && !activeNative?.queue)
							}
							onClick={() => void act("next")}
						>
							<SkipForward aria-hidden="true" />
						</button>
						<button
							type="button"
							class="icon-button"
							aria-label="Daumen hoch: Favorit"
							aria-pressed={!!track && store.thumbOf(track) === 1}
							disabled={!track || s.stale}
							onClick={() => void thumb(1)}
						>
							<Heart aria-hidden="true" />
						</button>
						<button
							type="button"
							class="icon-button"
							aria-label="Daumen runter: diesen Song nie wieder"
							aria-pressed={!!track && store.thumbOf(track) === -1}
							disabled={!track || s.stale}
							onClick={() => void thumb(-1)}
						>
							<ThumbsDown aria-hidden="true" />
						</button>
					</div>
					<label class="device-select">
						<Speaker size={18} aria-hidden="true" />
						<span>Wiedergabegerät</span>
						<select value={device} onChange={(e) => setDevice(e.currentTarget.value)}>
							<option value="">
								{nativeController
									? `Gespeichert: ${nativeController.deviceName ?? nativeController.deviceId}`
									: "Aktives Spotify-Gerät"}
							</option>
							<option value="spotify">Spotify · aktives Gerät</option>
							{nativeDevices.map((d) => (
								<option key={d.id} value={`native:${d.id}`}>
									{d.name} · HA/MA{d.queue ? " · Warteschlange" : " · ein Song"}
								</option>
							))}
							{devices?.map((d) => (
								<option key={d.id} value={d.id} disabled={d.restricted}>
									{d.name}
									{d.restricted ? " · nicht steuerbar" : d.active ? " · aktiv" : ""}
								</option>
							))}
						</select>
					</label>
				</div>
				<div class="device-note">
					<span>
						{ownNow?.deviceName
							? `Zuletzt auf ${ownNow.deviceName}`
							: devices?.length === 0
								? "Kein Spotify-Gerät sichtbar. Öffne Spotify auf deinem Gerät."
								: "Spotify Connect · für in Spotify sichtbare Geräte."}
					</span>
					<button type="button" class="act" onClick={refreshDevices}>
						Geräte aktualisieren
					</button>
					<a href="/geraete">Geräte & HA/MA</a>
				</div>
				{selectedNative || nativeController ? (
					<div class="notice">
						<p>
							Native Home-Assistant-/Music-Assistant-Route ·{" "}
							{(selectedNative ?? activeNative)?.queue
								? "Geordnete Warteschlange unterstützt."
								: "Dieses Gerät spielt einen Song; automatisches Weiterschalten ist nicht verfügbar."}{" "}
							{(selectedNative ?? activeNative)?.seek
								? "Gespeicherte Position wird übernommen."
								: "Ohne Seek startet derselbe Song von vorne."}
						</p>
					</div>
				) : null}
				{!nativeConfigured ? (
					<p class="hint">
						Native HA/MA ist nicht eingerichtet. In Spotify sichtbare Music-Assistant-Geräte nutzt
						du über Spotify Connect.
					</p>
				) : null}
				{nativeError ? (
					<p class="note note--error">Native Geräte nicht erreichbar: {nativeError}</p>
				) : null}
				{nativeController && session?.pending ? (
					<div class="notice">
						<p>
							Ein Gerätebefehl ist noch ungeklärt. Du kannst ihn verwerfen und die gespeicherte
							Position behalten.
						</p>
						<button
							type="button"
							class="key"
							onClick={() =>
								void api
									.nativeCancel(expected)
									.then(() => store.refresh(false))
									.catch((e: Error) => store.say(e.message, "error"))
							}
						>
							Befehl verwerfen · Position beibehalten
						</button>
					</div>
				) : null}

				{deviceError ? (
					<p class="note note--error" role="alert">
						Geräte nicht geladen: {deviceError}
					</p>
				) : null}
				{state.warnings.map((w) => (
					<p class="notice" key={w.code}>
						{w.message}
						{/quota|rate/.test(w.code) ? (
							<>
								{" "}
								<button
									type="button"
									class="act"
									onClick={() =>
										void api
											.retrySpotify()
											.then(() => store.refresh(true))
											.catch((e: Error) => store.say(e.message, "error"))
									}
								>
									Spotify-Freigabe prüfen
								</button>
							</>
						) : null}
					</p>
				))}
				<section class="queue" aria-labelledby="queue-title">
					<div class="section-heading">
						<h2 id="queue-title">
							<ListMusic size={20} aria-hidden="true" />
							Als Nächstes
						</h2>
						<span class="muted">Gespeicherte Reihenfolge</span>
					</div>
					{session?.queue.length ? (
						<ol class="queue-list">
							{session.queue
								.filter((e) => e.entryId !== session.entryId)
								.slice(0, 12)
								.map((e, i) => (
									<QueueRow key={e.entryId} track={e.track} index={i + 1} />
								))}
						</ol>
					) : (
						<p class="empty-state">
							Starte einen Sender. Deine nächsten Songs erscheinen hier in ihrer festen Reihenfolge.
						</p>
					)}
					<p class="hint">
						Die Warteschlange wächst automatisch weiter. Normales Fortsetzen mischt sie nicht neu.
					</p>
				</section>
			</section>
			<aside class="library" aria-labelledby="stations-title">
				<div class="section-heading">
					<h2 id="stations-title">Deine Sender</h2>
					<a href="/sender/neu">Neuer Sender</a>
				</div>
				<div class="station-list">
					{state.stations.map((x) => (
						<div
							class={`station-choice${station?.id === x.id ? " station-choice--selected" : ""}`}
							key={x.id}
						>
							<button
								type="button"
								aria-pressed={station?.id === x.id}
								onClick={() => {
									setSelected(x.id);
									setConfirm(false);
								}}
							>
								<Cover src={x.imageUrl} />
								<span>
									<strong>{x.name}</strong>
									<small>
										{x.importing
											? "Wird eingelesen …"
											: `${x.poolSize ?? "–"} Songs · ${roundLabel(x)}`}
									</small>
								</span>
							</button>
							<a href={`/sender/${x.id}`} aria-label={`${x.name}: Mix und Regeln`}>
								Mix & Regeln
							</a>
						</div>
					))}
				</div>
				{station ? (
					<div class="station-actions">
						<p>
							Ausgewählt: <strong>{station.name}</strong>
						</p>
						<a class="key" href={`/sender/${station.id}`}>
							Mix & Regeln anpassen
						</a>
						{confirm ? (
							<div class="new-queue-confirm">
								<p>
									Neue Warteschlange für {station.name} beginnen? Der aktuelle Lauf wird ersetzt.
								</p>
								<div class="row-actions">
									<button type="button" class="key" onClick={() => setConfirm(false)}>
										Abbrechen
									</button>
									<button
										type="button"
										class="key key--lit"
										disabled={busy || s.stale || session?.pending}
										onClick={() => void act("new")}
									>
										Neue Warteschlange beginnen
									</button>
								</div>
							</div>
						) : (
							<button
								type="button"
								class="act"
								disabled={busy || s.stale || session?.pending}
								onClick={() => setConfirm(true)}
							>
								Neue Warteschlange
							</button>
						)}
					</div>
				) : (
					<a href="/suchlauf">Playlists als Sender speichern</a>
				)}
				<div class="library-links">
					<a href="/suchlauf">
						<Music2 size={18} aria-hidden="true" />
						Playlists hinzufügen
					</a>
					<a href="/import">Hörverlauf importieren</a>
					<a href="/menu">Gast-Modus & Einstellungen</a>
				</div>
			</aside>
		</div>
	);
}

function QueueRow({ track, index }: { track: TrackView; index: number }) {
	return (
		<li class="queue-row track--rate">
			<span class="queue-number">{index}</span>
			<Cover src={track.imageUrl} />
			<span class="track__main">
				<strong>{track.name}</strong>
				<span class="muted">{track.artists}</span>
			</span>
			<ThumbMark t={track} />
			<span class="queue-duration">{duration(track.durationMs)}</span>
			<RateHit t={track} />
		</li>
	);
}

export function MixReadout({ s, mix }: { s: StationSummary; mix: number }) {
	const shares = sharesForRules({ ...s.rules, mix });
	return (
		<span>
			{pct(shares.fresh)} ungehört · {pct(shares.favorite)} Favoriten · {pct(shares.discovery)}{" "}
			Entdeckungen
		</span>
	);
}
export async function playStation(station: StationSummary) {
	if (!station.ready || store.tuning || store.stale) return;
	store.tuning = { stationId: station.id, since: Date.now() };
	store.emit();
	try {
		const session = store.load.kind === "ready" ? store.load.state.session : null;
		const native =
			session?.stationId === station.id && session.controller?.kind === "home-assistant"
				? session.controller
				: null;
		const result = native
			? await api.nativePlayer(station.id, native.deviceId, "resume", {
					sessionId: session?.sessionId,
					entryId: session?.entryId,
					orderRevision: session?.orderRevision,
				})
			: await api.play(station.id, undefined, {
					sessionId: session?.stationId === station.id ? session.sessionId : undefined,
				});
		if (!result.ok) store.say(result.error?.message ?? "Wiedergabe nicht möglich", "error");
		await store.refresh(true);
	} catch (e) {
		store.say(e instanceof Error ? e.message : String(e), "error");
	} finally {
		store.tuning = null;
		store.emit();
	}
}
