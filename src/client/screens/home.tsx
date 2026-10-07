import {
	ChevronDown,
	Heart,
	ListMusic,
	Music2,
	Pause,
	Play,
	Plus,
	RefreshCw,
	Settings2,
	SkipForward,
	Speaker,
	ThumbsDown,
	Upload,
} from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { sharesForRules } from "../../core/mix";
import type { AppState, DeviceView, StationSummary, TrackView } from "../../shared/api";
import { ApiError, api, type NativeDevice } from "../api";
import { LineBadge, RoundMeter, Scribble, StageArt } from "../components/brand";
import { RateHit, ThumbMark } from "../components/rate";
import { SongProgress } from "../components/song-progress";
import { Cover, inkOf, roundText } from "../components/ui";
import { useDesign } from "../design";
import { duration, pct } from "../format";
import { playbackView } from "../playback-view";
import { type PlaybackAction, store, useStore } from "../store";
import { HomeLayout, type HomeParts } from "./home-layouts";

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
	const design = useDesign();
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
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	const command = s.command;
	const busy = command?.phase === "sending" || command?.phase === "accepted";
	const unsettled = !!command && command.phase !== "failed";
	const deviceNames = useRef(new Map<string, string>());
	const deviceRequest = useRef(0);
	const [confirm, setConfirm] = useState(false);
	/** Progressive reveal of the stored plan; presentation only, no extra requests. */
	const [shown, setShown] = useState(12);
	const refreshDevices = () => {
		setDeviceError("");
		const request = ++deviceRequest.current;
		void api
			.nativeDevices()
			.then((result) => {
				if (request !== deviceRequest.current) return;
				for (const d of result.devices) deviceNames.current.set(`native:${d.id}`, d.name);
				setNativeDevices(result.devices);
				setNativeConfigured(result.configured);
				setNativeError("");
			})
			.catch((e: Error) => {
				if (request === deviceRequest.current) setNativeError(e.message);
			});
		void api
			.devices()
			.then((list) => {
				if (request !== deviceRequest.current) return;
				for (const d of list) deviceNames.current.set(d.id, d.name);
				setDevices(list);
			})
			.catch((e: Error) => {
				if (request === deviceRequest.current) setDeviceError(e.message);
			});
	};
	useEffect(() => {
		refreshDevices();
		return () => {
			deviceRequest.current++;
		};
	}, []);
	const savedTrack =
		session?.queue.find((e) => e.entryId === session.entryId)?.track ?? session?.queue[0]?.track;
	const ownNow =
		state.nowPlaying &&
		state.nowPlaying.stationId === session?.stationId &&
		(!savedTrack || state.nowPlaying.id === savedTrack.id)
			? state.nowPlaying
			: null;
	const view = playbackView(state, s.receivedAt, now, s.stale, unsettled ? command?.frozen : null);
	const track = view.track;
	const chooseDevice = (value: string) => {
		setDevice(value);
		try {
			if (value) localStorage.setItem("ts-device", value);
			else localStorage.removeItem("ts-device");
			const name = deviceNames.current.get(value);
			if (name) localStorage.setItem("ts-device-name", name);
			else localStorage.removeItem("ts-device-name");
		} catch {
			/* Keep this selection for the current page in private mode. */
		}
	};
	const missingDevice =
		device &&
		device !== "spotify" &&
		!devices?.some((d) => d.id === device) &&
		!nativeDevices.some((d) => `native:${d.id}` === device);
	let savedDeviceName = deviceNames.current.get(device);
	if (!savedDeviceName) {
		try {
			savedDeviceName = localStorage.getItem("ts-device-name") ?? undefined;
		} catch {
			/* private mode */
		}
	}
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
	const act = async (action: PlaybackAction, retry = false) => {
		const targetStation =
			action === "pause" || action === "next"
				? state.stations.find((candidate) => candidate.id === session?.stationId)
				: retry && command
					? state.stations.find((candidate) => candidate.id === command.stationId)
					: station;
		if (
			busy ||
			s.stale ||
			!targetStation ||
			(view.projected && action === "next") ||
			(unsettled && !retry)
		)
			return;
		const commandId = store.beginCommand(action, targetStation.id, {
			entryId: view.entryId,
			position: view.position,
			track: view.track,
			projected: view.projected,
		});
		if (commandId === null) return;
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
			else if (targetStation && device.startsWith("native:"))
				result = await api.nativePlay(targetStation.id, device.slice("native:".length), {
					...expected,
					newQueue: action === "new",
				});
			else if (targetStation && nativeController && !device && action === "new")
				result = await api.nativePlay(targetStation.id, nativeController.deviceId, {
					...expected,
					newQueue: true,
				});
			else if (
				targetStation &&
				nativeController &&
				!device &&
				action === "play" &&
				targetStation.id === session?.stationId
			)
				result = await api.nativePlayer(
					targetStation.id,
					nativeController.deviceId,
					"resume",
					expected,
				);
			else if (targetStation)
				result = await api.play(
					targetStation.id,
					device === "spotify" ? undefined : device || undefined,
					{
						newQueue: action === "new",
						sessionId: targetStation.id === session?.stationId ? session.sessionId : undefined,
					},
				);

			if (!result) throw new Error("Wähle einen Sender und versuche es erneut.");
			const accepted = store.acceptCommand(commandId, result);
			if (accepted && action === "new") setConfirm(false);
			// Do not reuse a poll that started before this command. This read is not UI busy time.
			void store.refresh(true, true);
		} catch (e) {
			store.failCommand(
				commandId,
				e instanceof Error ? e.message : String(e),
				!(e instanceof ApiError) ||
					e.status === 0 ||
					e.status >= 500 ||
					e.code === "invalid_response",
			);
			void store.refresh(false, true);
		}
	};
	const retrySaved = () => act("play", true);
	const commandLabel =
		command?.phase === "failed"
			? "Befehl fehlgeschlagen"
			: command?.phase === "unconfirmed"
				? "Bestätigung steht aus"
				: command?.phase === "accepted"
					? command.action === "pause"
						? "Pause angenommen …"
						: command.action === "next"
							? "Songwechsel angenommen …"
							: "Start angenommen …"
					: command?.action === "pause"
						? "Pause angefordert …"
						: command?.action === "next"
							? "Songwechsel angefordert …"
							: "Start angefordert …";

	const thumb = async (value: -1 | 1) => {
		if (!track || view.projected || view.awaitingObservation || unsettled) return;
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
	// Presentation only: which station the stage prints, and how far the command signal has come.
	const posterStation = state.stations.find((x) => x.id === session?.stationId) ?? station ?? null;
	const startsOther = !!station && !!session && station.id !== session.stationId;
	const statusText = command
		? commandLabel
		: view.projected
			? "Nächster Song · geschätzt"
			: view.awaitingObservation ||
					session?.pending ||
					(session?.status === "active" && !view.playing) ||
					(session?.status === "paused" && !nativeController && ownNow?.isPlaying)
				? "Gerätebestätigung steht aus"
				: session
					? SESSION_LABELS[session.status]
					: "Bereit für deine Musik";
	// 1 requested, 2 accepted by Spotify/device, 3 confirmed by a fresh observation.
	const signal: { level: 0 | 1 | 2 | 3; tone: "ok" | "wait" | "estimate" | "error" } = command
		? command.phase === "sending"
			? { level: 1, tone: "wait" }
			: command.phase === "accepted"
				? { level: 2, tone: "wait" }
				: command.phase === "unconfirmed"
					? { level: 2, tone: "error" }
					: { level: 1, tone: "error" }
		: !session
			? { level: 0, tone: "ok" }
			: view.projected
				? { level: 3, tone: "estimate" }
				: statusText === "Gerätebestätigung steht aus"
					? { level: 2, tone: "wait" }
					: { level: 3, tone: "ok" };
	const successors = session?.queue.length
		? session.queue
				.slice(Math.max(0, session.queue.findIndex((e) => e.entryId === view.entryId) + 1))
				.slice(0, 50)
		: [];
	// ------------------------------------------------------------ parts
	// Every design arranges the same parts; their markup, labels and handlers are shared.
	const head = (
		<header class="player-heading stage__head">
			<LineBadge stations={state.stations} s={posterStation} />
			<div class="stage__station">
				<h1 id="listen-title">{posterStation?.name ?? "Deine Sender"}</h1>
				<p>
					{posterStation
						? roundText(posterStation)
						: "Entdecken, wiederfinden, in Ruhe weiterhören."}
				</p>
				{state.guest.active ? (
					<p class="stage__guest">Gast-Modus · zählt nicht ins Gedächtnis</p>
				) : null}
			</div>
			<RoundMeter progress={posterStation?.progress ?? null} />
		</header>
	);
	const art = <StageArt src={track?.imageUrl ?? posterStation?.imageUrl} label="jetzt" />;
	const copy = (
		<div class="now-copy">
			<h2>{posterTitle(track?.name ?? "Dein nächster Lieblingssong")}</h2>
			<Scribble />
			<p class="artist">{track?.artists ?? "Wähle einen Sender und starte deine Warteschlange."}</p>
			{track?.album ? <p class="album">{track.album}</p> : null}
		</div>
	);
	const progress = (
		<>
			{track ? (
				<SongProgress
					position={view.position}
					estimating={view.estimating}
					pending={unsettled}
					projected={view.projected}
					durationMs={track.durationMs}
				/>
			) : null}
		</>
	);
	const signalBlock = (
		<div class="signal-block">
			<p class="session-status" role="status">
				{statusText}
			</p>
			<ol class={`signal signal--${signal.tone}`} aria-hidden="true">
				{(["Angefordert", "Angenommen", "Bestätigt"] as const).map((label, i) => (
					<li
						key={label}
						class={i < signal.level ? "signal__step signal__step--on" : "signal__step"}
					>
						{label}
					</li>
				))}
			</ol>
		</div>
	);
	const transport = (
		<div class="transport-shelf">
			<div class="transport">
				<button
					type="button"
					class="primary transport-main"
					disabled={
						unsettled ||
						s.stale ||
						!station?.ready ||
						session?.pending ||
						(playing && !!nativeController && !activeNative?.pause)
					}
					onClick={() => void act(playing ? "pause" : "play")}
				>
					{playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
					{unsettled
						? keyLabel(commandLabel)
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
						unsettled ||
						s.stale ||
						!session ||
						view.projected ||
						view.awaitingObservation ||
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
					disabled={!track || s.stale || view.projected || view.awaitingObservation || unsettled}
					onClick={() => void thumb(1)}
				>
					<Heart aria-hidden="true" />
				</button>
				<button
					type="button"
					class="icon-button"
					aria-label="Daumen runter: diesen Song nie wieder"
					aria-pressed={!!track && store.thumbOf(track) === -1}
					disabled={!track || s.stale || view.projected || view.awaitingObservation || unsettled}
					onClick={() => void thumb(-1)}
				>
					<ThumbsDown aria-hidden="true" />
				</button>
			</div>
			{startsOther && !playing && !unsettled ? (
				<p class="stage__note">Startet {station.name}. Der gespeicherte Song bleibt erhalten.</p>
			) : null}
		</div>
	);
	const savedNote = (
		<p class="saved-note">
			{session
				? "Song und Reihenfolge bleiben gespeichert — auch wenn du die App schließt."
				: "Deine Playlists, mit einem Gedächtnis für jeden Song."}
		</p>
	);
	const notices = (
		<>
			{view.awaitingObservation ? (
				<p class="notice">Letzter bestätigter Song. Eine aktuelle Gerätebeobachtung fehlt noch.</p>
			) : null}
			{view.projected ? (
				<p class="notice notice--estimate" role="status">
					Geschätzter Songwechsel aus deiner Warteschlange. Spotify hat diesen Song noch nicht
					bestätigt.
				</p>
			) : null}
			{command ? (
				<div
					class={`notice${command.phase === "failed" ? " notice--error" : command.phase === "unconfirmed" ? " notice--warn" : ""}`}
					role={command.phase === "failed" ? "alert" : "status"}
				>
					<p>
						{command.phase === "failed"
							? `${command.error} Bitte erneut versuchen.`
							: command.phase === "sending"
								? "Befehl wird gesendet. Die Anzeige wartet auf die Bestätigung des Geräts."
								: command.phase === "accepted"
									? "Befehl angenommen. Das Gerät hat die Wiedergabe noch nicht bestätigt."
									: `${command.error ? `${command.error} ` : ""}Die Gerätebestätigung fehlt noch. Der gespeicherte Song bleibt erhalten. Erneutes Fortsetzen kann zur gespeicherten Position zurückspringen.`}
					</p>
					{command.phase === "failed" || command.phase === "unconfirmed" ? (
						<div class="row-actions">
							{command.phase === "unconfirmed" && command.action === "pause" ? (
								<button
									type="button"
									class="key"
									disabled={s.stale}
									onClick={() => void act("play", true)}
								>
									Gespeicherten Song fortsetzen
								</button>
							) : null}
							<button
								type="button"
								class="key"
								disabled={s.stale}
								onClick={() =>
									void act(
										command.action === "new" ||
											(command.phase === "unconfirmed" && command.action === "next")
											? "play"
											: command.action,
										true,
									)
								}
							>
								{command.phase === "unconfirmed"
									? command.action === "pause"
										? "Pause erneut versuchen"
										: "Gespeicherten Befehl erneut versuchen"
									: "Befehl erneut versuchen"}
							</button>
						</div>
					) : null}
				</div>
			) : null}
			{session?.pending && !command ? (
				<p class="notice">
					Das Gerät bestätigt den Wechsel noch. Der bisherige Song bleibt gesichert.
				</p>
			) : null}
			{session?.pending && !nativeController && !command ? (
				<div class="notice notice--warn">
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
					Deine gespeicherte Warteschlange bleibt erhalten. „Fortsetzen“ wechselt bewusst zurück zu
					true-shuffle.
				</p>
			) : null}
		</>
	);
	const devicePanel = (
		<div class="device-panel">
			<label class="device-select">
				<span class="device-select__label">
					<Speaker size={18} aria-hidden="true" />
					Wiedergabegerät
				</span>
				<select
					aria-label="Wiedergabegerät"
					value={device}
					disabled={busy}
					onChange={(e) => chooseDevice(e.currentTarget.value)}
				>
					<option value="">
						{nativeController
							? `Gespeichert: ${nativeController.deviceName ?? nativeController.deviceId}`
							: "Aktives Spotify-Gerät"}
					</option>
					<option value="spotify">Spotify · aktives Gerät</option>
					{missingDevice ? (
						<option value={device}>
							{savedDeviceName ?? "Gespeichertes Gerät"} · zurzeit nicht sichtbar
						</option>
					) : null}
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
			<div class="device-note">
				<span>
					{ownNow?.deviceName
						? `Zuletzt auf ${ownNow.deviceName}`
						: devices?.length === 0
							? "Kein Spotify-Gerät sichtbar. Öffne Spotify auf deinem Gerät."
							: "Spotify Connect · für in Spotify sichtbare Geräte."}
				</span>
				<button type="button" class="act" onClick={refreshDevices}>
					<RefreshCw size={15} aria-hidden="true" />
					Geräte aktualisieren
				</button>
				<a href="/geraete">Geräte & HA/MA</a>
			</div>
			{selectedNative || nativeController ? (
				<p class="hint">
					Native Home-Assistant-/Music-Assistant-Route ·{" "}
					{(selectedNative ?? activeNative)?.queue
						? "Geordnete Warteschlange unterstützt."
						: "Dieses Gerät spielt einen Song; automatisches Weiterschalten ist nicht verfügbar."}{" "}
					{(selectedNative ?? activeNative)?.seek
						? "Gespeicherte Position wird übernommen."
						: "Ohne Seek startet derselbe Song von vorne."}
				</p>
			) : null}
			{!nativeConfigured ? (
				<p class="hint">
					Native HA/MA ist nicht eingerichtet. In Spotify sichtbare Music-Assistant-Geräte nutzt du
					über Spotify Connect.
				</p>
			) : null}
			{nativeError && !deviceError ? (
				<p class="note note--error">Native Geräte nicht erreichbar: {nativeError}</p>
			) : null}
			{deviceError ? (
				<p class="note note--error" role="alert">
					Geräte nicht geladen: {deviceError}
				</p>
			) : null}
		</div>
	);
	const lateNotices = (
		<>
			{nativeController && session?.pending ? (
				<div class="notice notice--warn">
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
			{state.warnings.map((w) => (
				<p class="notice notice--warn" key={w.code}>
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
		</>
	);
	const queueSection = (
		<section class={`queue ink-${inkOf(posterStation)}`} aria-labelledby="queue-title">
			<div class="section__head">
				<h2 id="queue-title">
					<ListMusic size={22} aria-hidden="true" />
					Als Nächstes
				</h2>
				<span class="section__lead">
					{successors.length
						? `${successors.length} ${successors.length === 1 ? "Song" : "Songs"} aus dem gespeicherten Plan`
						: "Gespeicherte Reihenfolge"}
				</span>
			</div>
			{successors.length ? (
				<>
					<ol class="queue-list">
						{successors.slice(0, shown).map((e, i) => (
							<QueueRow key={e.entryId} track={e.track} index={i + 1} />
						))}
					</ol>
					{successors.length > shown ? (
						<button
							type="button"
							class="key key--wide"
							onClick={() => setShown((n) => Math.min(successors.length, n + 20))}
						>
							<ChevronDown size={18} aria-hidden="true" />
							Weitere {Math.min(20, successors.length - shown)} Songs zeigen
						</button>
					) : null}
				</>
			) : (
				<p class="empty-state">
					Starte einen Sender. Deine nächsten Songs erscheinen hier in ihrer festen Reihenfolge.
				</p>
			)}
			<p class="hint">
				Die Warteschlange wächst automatisch weiter. Normales Fortsetzen mischt sie nicht neu. Was
				Spotify außerhalb von true-shuffle einreiht, zeigt diese Liste nicht.
			</p>
		</section>
	);
	const libraryHead = (
		<div class="section__head">
			<h2 id="stations-title">Deine Sender</h2>
			<a class="act" href="/sender/neu">
				<Plus size={16} aria-hidden="true" />
				Neuer Sender
			</a>
		</div>
	);
	const stationList = (
		<ul class="station-list">
			{state.stations.map((x) => (
				<li
					class={`station-choice ink-${inkOf(x)}${station?.id === x.id ? " station-choice--selected" : ""}${session?.stationId === x.id ? " station-choice--saved" : ""}`}
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
						<Cover src={x.imageUrl} class="station-choice__art" />
						<LineBadge stations={state.stations} s={x} />
						<span class="station-choice__name">{x.name}</span>
						<span class="station-choice__meta">
							{x.importing ? "Wird eingelesen …" : `${x.poolSize ?? "–"} Songs · ${roundLabel(x)}`}
							{session?.stationId === x.id ? " · gespeicherter Lauf" : ""}
						</span>
						<RoundMeter progress={x.progress} size="sm" />
					</button>
					<a href={`/sender/${x.id}`} aria-label={`${x.name}: Mix und Regeln`}>
						Mix & Regeln
					</a>
				</li>
			))}
		</ul>
	);
	const stationActions = (
		<>
			{station ? (
				<div class="station-actions">
					<p>
						Ausgewählt: <strong>{station.name}</strong>
					</p>
					<div class="row-actions">
						<a class="key" href={`/sender/${station.id}`}>
							Mix & Regeln anpassen
						</a>
						{confirm ? null : (
							<button
								type="button"
								class="key key--quiet"
								disabled={unsettled || s.stale || session?.pending}
								onClick={() => setConfirm(true)}
							>
								Neue Warteschlange
							</button>
						)}
					</div>
					{confirm ? (
						<div class="new-queue-confirm">
							<p>Neue Warteschlange für {station.name} beginnen? Der aktuelle Lauf wird ersetzt.</p>
							<div class="row-actions">
								<button type="button" class="key" onClick={() => setConfirm(false)}>
									Abbrechen
								</button>
								<button
									type="button"
									class="key key--lit"
									disabled={unsettled || s.stale || session?.pending}
									onClick={() => void act("new")}
								>
									Neue Warteschlange beginnen
								</button>
							</div>
						</div>
					) : null}
				</div>
			) : (
				<a href="/suchlauf">Playlists als Sender speichern</a>
			)}
		</>
	);
	const libraryLinks = (
		<nav class="library-links" aria-label="Mehr zu deinen Sendern">
			<a href="/suchlauf">
				<Music2 size={18} aria-hidden="true" />
				Playlists hinzufügen
			</a>
			<a href="/import">
				<Upload size={18} aria-hidden="true" />
				Hörverlauf importieren
			</a>
			<a href="/menu">
				<Settings2 size={18} aria-hidden="true" />
				Gast-Modus & Einstellungen
			</a>
		</nav>
	);
	const stageClass = `stage ink-${inkOf(posterStation)}${unsettled ? " stage--pending" : ""}${view.projected ? " stage--estimate" : ""}`;
	const nowShelf = (
		<div class="now-shelf">
			{art}
			{copy}
		</div>
	);
	const parts: HomeParts = {
		head,
		art,
		copy,
		nowShelf,
		progress,
		signalBlock,
		transport,
		savedNote,
		notices,
		devicePanel,
		lateNotices,
		queueSection,
		libraryHead,
		stationList,
		stationActions,
		libraryLinks,
		stageClass,
		inkClass: `ink-${inkOf(posterStation)}`,
		posterStation,
		nextTitle: successors[0]?.track.name ?? null,
	};
	return (
		<HomeLayout
			design={design}
			parts={parts}
			confirmedEntry={session?.entryId ?? null}
			confirmedTrackId={savedTrack?.id ?? null}
		/>
	);
}

/** Keep the last word and its ellipsis together on a held key. */
function keyLabel(label: string) {
	const cut = label.lastIndexOf(" ", label.length - 3);
	if (!label.endsWith(" …") || cut < 0) return label;
	return (
		<span>
			{label.slice(0, cut + 1)}
			<span class="nowrap">{label.slice(cut + 1)}</span>
		</span>
	);
}

/** Keep a title's dash with the word before it, so no title line opens with "–". */
function posterTitle(name: string): string {
	return name.replace(/ ([–—-]) /g, "\u00a0$1 ");
}

function QueueRow({ track, index }: { track: TrackView; index: number }) {
	return (
		<li class="queue-row track--rate">
			<span class="queue-number" aria-hidden="true">
				{String(index).padStart(2, "0")}
			</span>
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
