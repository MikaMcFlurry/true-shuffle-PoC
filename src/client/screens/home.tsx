import {
	ChevronDown,
	Heart,
	Pause,
	Play,
	Plus,
	RefreshCw,
	Shuffle,
	SkipForward,
	SlidersHorizontal,
	Speaker,
	ThumbsDown,
	UserRound,
} from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { sharesForRules } from "../../core/mix";
import type { AppState, DeviceView, StationSummary, TrackView } from "../../shared/api";
import { ApiError, api, type NativeDevice } from "../api";
import { Cassette, type ReelState, shellOf } from "../components/cassette";
import { RateHit, ThumbMark } from "../components/rate";
import { SongProgress } from "../components/song-progress";
import { factsOf, type SongFactsView, SongTags } from "../components/song-tags";
import { Cover } from "../components/ui";
import { duration, num, pct } from "../format";
import { playbackView } from "../playback-view";
import { type PlaybackAction, store, useStore } from "../store";

export function roundLabel(s: StationSummary): string {
	return `${s.roundNo || 1}. Durchgang`;
}

const SESSION_LABELS = {
	active: "Spielt",
	paused: "Pausiert",
	disconnected: "Kein Gerät verbunden",
	external: "Wartet auf dich",
	ambiguous: "Stand unklar",
	saved: "Gespeichert",
};

export function Home({ state }: { state: AppState }) {
	const s = useStore();
	const session = state.session;
	// A cassette chosen on the shelf arrives as ?sender=<id>: it is inserted, not played.
	const [selected, setSelected] = useState<number | null>(() => {
		const asked = Number(new URLSearchParams(location.search).get("sender"));
		return Number.isInteger(asked) && asked > 0 ? asked : null;
	});
	useEffect(() => {
		if (!location.search.includes("sender=")) return;
		history.replaceState(history.state, "", location.pathname);
	}, []);
	const station =
		state.stations.find((x) => x.id === (selected ?? session?.stationId)) ??
		state.stations.find((x) => x.playing) ??
		state.stations[0];
	const [nativeDevices, setNativeDevices] = useState<NativeDevice[]>([]);
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
	const [shown, setShown] = useState(5);
	const refreshDevices = () => {
		setDeviceError("");
		const request = ++deviceRequest.current;
		void api
			.nativeDevices()
			.then((result) => {
				if (request !== deviceRequest.current) return;
				for (const d of result.devices) deviceNames.current.set(`native:${d.id}`, d.name);
				setNativeDevices(result.devices);
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

			if (!result) throw new Error("Leg eine Kassette ein und versuche es erneut.");
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
	// Presentation only: which station the screen is about, and how far the command signal has come.
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
					: "Bereit";
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
	const where =
		ownNow?.deviceName ??
		nativeController?.deviceName ??
		(selectedNative ? selectedNative.name : undefined) ??
		(device && device !== "spotify" ? savedDeviceName : undefined);
	// One plain sentence: what is true now and what the next step is.
	const sentence = command
		? command.phase === "sending"
			? "Befehl wird gesendet …"
			: command.phase === "accepted"
				? "Befehl angenommen. Wir warten, bis das Gerät ihn bestätigt."
				: command.phase === "unconfirmed"
					? "Das Gerät hat noch nicht bestätigt. Dein Song bleibt gespeichert."
					: "Das hat nicht geklappt. Dein Song bleibt gespeichert."
		: view.projected
			? "Der nächste Song ist geschätzt. Spotify hat ihn noch nicht bestätigt."
			: statusText === "Gerätebestätigung steht aus"
				? "Wir warten auf eine aktuelle Meldung vom Gerät."
				: !session
					? state.stations.length
						? `${station?.name ?? "Eine Kassette"} ist eingelegt. Tippe auf „Wiedergabe starten“.`
						: "Mach zuerst aus deinen Playlists eine Kassette."
					: session.status === "active"
						? where
							? `Läuft auf ${where}.`
							: "Läuft in Spotify."
						: session.status === "paused"
							? "Fortsetzen spielt genau an dieser Stelle weiter."
							: session.status === "external"
								? "Deine Warteschlange wartet. Fortsetzen holt sie zurück."
								: session.status === "disconnected"
									? "Kein Gerät verbunden. Öffne Spotify auf einem Gerät und tippe auf Fortsetzen."
									: session.status === "ambiguous"
										? "Unklar, wo Spotify gerade steht. Fortsetzen spielt deinen gespeicherten Song."
										: "Fortsetzen spielt genau an dieser Stelle weiter.";
	const heard =
		posterStation && posterStation.poolSize !== null && posterStation.freshRemaining !== null
			? posterStation.poolSize - posterStation.freshRemaining
			: null;
	const mainLabel = unsettled
		? keyLabel(commandLabel)
		: playing
			? "Pause"
			: session?.stationId === station?.id
				? "Fortsetzen"
				: "Wiedergabe starten";
	const inserted = startsOther ? station : (posterStation ?? station ?? null);
	const reels: ReelState =
		unsettled || statusText === "Gerätebestätigung steht aus" || view.projected
			? "waiting"
			: playing
				? "running"
				: "still";
	const counterLabel =
		heard !== null && posterStation?.poolSize
			? `${num(heard)} von ${num(posterStation.poolSize)} Songs gehört`
			: posterStation
				? "Zählt ab dem ersten Song"
				: "Noch keine Kassette eingelegt";
	// The state line's form: solid green only when playback is confirmed.
	const line = !session
		? "held"
		: signal.tone !== "ok"
			? signal.tone
			: session.status === "active"
				? "ok"
				: session.status === "disconnected"
					? "error"
					: session.status === "ambiguous"
						? "wait"
						: "held";
	const stateClass = `now now--${line}${unsettled ? " now--pending" : ""}${view.projected ? " now--estimate" : ""}`;

	return (
		<div class={stateClass}>
			<section class="player" aria-labelledby="listen-title">
				<div class="walkman">
					<header class="player-heading">
						<h1 id="listen-title" class="sr-only">
							{posterStation?.name ?? "Noch keine Kassette eingelegt"}
						</h1>
						<p class="counter">
							<span class="sr-only">{counterLabel}</span>
							<span class="counter__digits" aria-hidden="true">
								{String(heard ?? 0).padStart(
									Math.max(3, String(posterStation?.poolSize ?? 0).length),
									"0",
								)}
							</span>
							<span class="player-heading__span" aria-hidden="true">
								{heard !== null && posterStation?.poolSize
									? `von ${num(posterStation.poolSize)} Songs gehört`
									: posterStation
										? "Zählt ab dem ersten Song"
										: "Noch keine Kassette eingelegt"}
							</span>
						</p>
						<span class={`led led--${reels}`} aria-hidden="true" />
						{state.guest.active ? (
							<p class="player-heading__guest">
								<UserRound size={16} aria-hidden="true" />
								Gast-Modus: was jetzt läuft, zählt nicht
							</p>
						) : null}
					</header>
					<div class="walkman__window">
						{inserted ? (
							<Cassette
								key={inserted.id}
								class="cassette--inserted"
								name={inserted.name}
								shell={shellOf(inserted)}
								heard={inserted.progress}
								reels={startsOther ? "still" : reels}
							/>
						) : (
							<div class="walkman__empty">Leg eine Kassette ein</div>
						)}
					</div>
					<div class="transport">
						<button
							type="button"
							class="transport-main"
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
							{mainLabel}
						</button>
						<div class="transport-keys">
							<button
								type="button"
								class="tkey"
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
								<span aria-hidden="true">Weiter</span>
							</button>
							<button
								type="button"
								class="tkey"
								aria-label="Daumen hoch: Favorit"
								aria-pressed={!!track && store.thumbOf(track) === 1}
								disabled={
									!track || s.stale || view.projected || view.awaitingObservation || unsettled
								}
								onClick={() => void thumb(1)}
							>
								<Heart aria-hidden="true" />
								<span aria-hidden="true">Favorit</span>
							</button>
							<button
								type="button"
								class="tkey"
								aria-label="Daumen runter: diesen Song nie wieder"
								aria-pressed={!!track && store.thumbOf(track) === -1}
								disabled={
									!track || s.stale || view.projected || view.awaitingObservation || unsettled
								}
								onClick={() => void thumb(-1)}
							>
								<ThumbsDown aria-hidden="true" />
								<span aria-hidden="true">Nie wieder</span>
							</button>
						</div>
						{startsOther && !playing && !unsettled ? (
							<p class="transport-note">
								Startet {station.name}. Dein Platz in {posterStation?.name} bleibt gespeichert.
							</p>
						) : null}
					</div>
				</div>

				<div class="player-song">
					<Cover src={track?.imageUrl ?? posterStation?.imageUrl} class="player-song__art" eager />
					<div class="now-copy">
						<h2>{posterTitle(track?.name ?? "Noch kein Song")}</h2>
						<p class="artist">
							{track?.artists ?? "Hier steht dein Song, sobald die Kassette läuft."}
						</p>
						{track ? (
							<SongTags
								kind={view.projected ? null : (ownNow?.kind ?? null)}
								facts={factsOf(session?.queue.find((e) => e.entryId === view.entryId))}
								thumb={store.thumbOf(track)}
								known={state.history.importedTracks > 0}
							/>
						) : null}
					</div>
				</div>

				{track ? (
					<SongProgress
						position={view.position}
						estimating={view.estimating}
						pending={unsettled}
						projected={view.projected}
						durationMs={track.durationMs}
					/>
				) : null}

				<div class="player-state">
					<p class="session-status" role="status">
						{statusText}
					</p>
					<p class="player-state__line">{sentence}</p>
					{state.warnings.map((w) => (
						<div class="notice notice--warn" key={w.code}>
							<p>{w.message}</p>
							{/quota|rate/.test(w.code) ? (
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
							) : null}
						</div>
					))}
					{command ? (
						<ol class={`signal signal--${signal.tone}`} aria-label="Stand des Befehls">
							{(["Angefordert", "Angenommen", "Bestätigt"] as const).map((label, i) => (
								<li
									key={label}
									class={i < signal.level ? "signal__step signal__step--on" : "signal__step"}
									aria-current={i === signal.level - 1 ? "step" : undefined}
								>
									{label}
								</li>
							))}
						</ol>
					) : null}
				</div>

				<div class="device-row">
					<label class="device-select">
						<span class="device-select__label">
							<Speaker size={18} aria-hidden="true" />
							Gerät
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
									{d.name} · Home Assistant{d.queue ? "" : " · nur ein Song"}
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
					<button
						type="button"
						class="icon-key"
						aria-label="Geräte aktualisieren"
						title="Geräte aktualisieren"
						onClick={refreshDevices}
					>
						<RefreshCw size={18} aria-hidden="true" />
					</button>
				</div>
				<p class="device-note">
					{ownNow?.deviceName
						? `Zuletzt auf ${ownNow.deviceName}`
						: devices?.length === 0
							? "Kein Spotify-Gerät sichtbar. Öffne Spotify auf deinem Gerät."
							: "Alle Geräte, die du in Spotify siehst."}
				</p>
				{selectedNative || nativeController ? (
					<p class="hint">
						{(selectedNative ?? activeNative)?.queue
							? "Home Assistant spielt deine Warteschlange der Reihe nach."
							: "Dieses Gerät spielt nur einen Song und schaltet nicht selbst weiter."}{" "}
						{(selectedNative ?? activeNative)?.seek
							? "Es setzt an der gespeicherten Stelle ein."
							: "Es beginnt den Song von vorn."}
					</p>
				) : null}
				{nativeError && !deviceError ? (
					<p class="note note--error">Home-Assistant-Geräte nicht erreichbar: {nativeError}</p>
				) : null}
				{deviceError ? (
					<p class="note note--error" role="alert">
						Geräte nicht geladen: {deviceError}
					</p>
				) : null}
			</section>

			<div class="notices">
				{view.awaitingObservation ? (
					<p class="notice">
						Zuletzt bestätigter Song. Eine aktuelle Meldung vom Gerät fehlt noch.
					</p>
				) : null}
				{view.projected ? (
					<p class="notice notice--estimate">
						Geschätzter Songwechsel aus deiner Warteschlange. Spotify hat diesen Song noch nicht
						bestätigt.
					</p>
				) : null}
				{command && (command.phase === "failed" || command.phase === "unconfirmed") ? (
					<div
						class={`notice${command.phase === "failed" ? " notice--error" : " notice--warn"}`}
						role={command.phase === "failed" ? "alert" : "status"}
					>
						<p>
							{command.phase === "failed"
								? `${command.error} Bitte erneut versuchen.`
								: `${command.error ? `${command.error} ` : ""}Die Gerätebestätigung fehlt noch. Der gespeicherte Song bleibt erhalten. Erneutes Fortsetzen kann zur gespeicherten Position zurückspringen.`}
						</p>
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
			</div>

			<section class="queue" aria-labelledby="queue-title">
				<div class="section-head">
					<h2 id="queue-title">Als Nächstes</h2>
					<p class="section-head__lead">Feste Reihenfolge. Fortsetzen mischt nichts neu.</p>
				</div>
				{successors.length ? (
					<>
						<ol class="queue-list">
							{successors.slice(0, shown).map((e, i) => (
								<QueueRow
									key={e.entryId}
									track={e.track}
									index={i + 1}
									facts={factsOf(e)}
									known={state.history.importedTracks > 0}
								/>
							))}
						</ol>
						{successors.length > shown ? (
							<button
								type="button"
								class="key key--wide"
								onClick={() => setShown((n) => Math.min(successors.length, n + 20))}
							>
								<ChevronDown size={18} aria-hidden="true" />
								{Math.min(20, successors.length - shown)} weitere Songs zeigen
							</button>
						) : null}
					</>
				) : (
					<p class="empty-state">
						Sobald eine Kassette läuft, stehen hier die nächsten Songs in ihrer festen Reihenfolge.
					</p>
				)}
				<p class="hint">
					<strong>Aus deiner Playlist</strong>: kommt aus dem Lauf dieser Kassette.{" "}
					<strong>Empfehlung</strong>: steht nicht in deinen Playlists, true-shuffle schlägt den
					Song vor. <strong>Favorit</strong>: kommt öfter, weil du ihn magst. Was du in Spotify
					selbst einreihst, steht nicht in dieser Liste.
				</p>
			</section>

			<section class="promise" aria-labelledby="promise-title">
				<h2 id="promise-title">Was true-shuffle für dich tut</h2>
				<ul class="promise-list">
					<li>
						<strong>Jeder Song kommt dran.</strong>{" "}
						{heard !== null && posterStation?.poolSize
							? heard === 0
								? `Alle ${num(posterStation.poolSize)} Songs aus ${posterStation.name} kommen der Reihe nach je einmal dran. Erst danach beginnt alles von vorn.`
								: `${num(heard)} von ${num(posterStation.poolSize)} Songs aus ${posterStation.name} hast du schon gehört, ${num(posterStation.poolSize - heard)} kommen noch. Erst danach beginnt alles von vorn.`
							: "Erst wenn du alle Songs einer Kassette gehört hast, beginnt sie von vorn."}
					</li>
					<li>
						<strong>Keine schnellen Wiederholungen.</strong> Was du gehört hast, kommt eine Weile
						nicht wieder. Favoriten kommen öfter, aber erst nach einer Pause von{" "}
						{pause(posterStation?.rules.favoriteCooldownDays ?? 7)}.
					</li>
					<li>
						<strong>Deine Stelle bleibt.</strong> Auch wenn du zwischendurch etwas anderes in
						Spotify hörst oder die App schließt.
					</li>
					<li>
						<strong>Es weiß, was du kennst.</strong>{" "}
						{state.history.importedTracks > 0 ? (
							`Dein Spotify-Hörverlauf mit ${num(state.history.importedTracks)} Songs ist eingerechnet.`
						) : (
							<>
								Mit deinem Spotify-Hörverlauf weiß es sofort, was du schon oft gehört hast.{" "}
								<a href="/import">Hörverlauf importieren</a>
							</>
						)}
					</li>
				</ul>
			</section>

			<section class="switcher" aria-labelledby="stations-title">
				<div class="section-head">
					<h2 id="stations-title">Andere Kassette einlegen</h2>
					<a class="act" href="/sender/neu">
						<Plus size={16} aria-hidden="true" />
						Neue Kassette
					</a>
				</div>
				<ul class="tape-strip">
					{state.stations.map((x) => {
						const xHeard =
							x.poolSize !== null && x.freshRemaining !== null
								? x.poolSize - x.freshRemaining
								: null;
						return (
							<li
								class={`tape-pick${station?.id === x.id ? " tape-pick--selected" : ""}${session?.stationId === x.id ? " tape-pick--saved" : ""}`}
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
									<span class="tape-pick__name">{x.name}</span>
									<Cassette name={x.name} shell={shellOf(x)} heard={x.progress} />
									<span class="tape-pick__meta">
										{x.importing
											? "Wird eingelesen …"
											: xHeard !== null && x.poolSize !== null
												? `${num(xHeard)} von ${num(x.poolSize)} gehört`
												: `${x.poolSize ?? "–"} Songs`}
										{session?.stationId === x.id ? " · eingelegt" : ""}
									</span>
								</button>
								<a href={`/sender/${x.id}`} aria-label={`${x.name}: Mix und Regeln`}>
									<SlidersHorizontal size={16} aria-hidden="true" />
									Einstellen
								</a>
							</li>
						);
					})}
				</ul>
				{station ? (
					<div class="station-actions">
						{confirm ? (
							<div class="new-queue-confirm">
								<p>
									{station.name} neu mischen? Deine bisherige Warteschlange wird ersetzt. Was du
									schon gehört hast, bleibt gezählt.
								</p>
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
										Ja, neu mischen
									</button>
								</div>
							</div>
						) : (
							<button
								type="button"
								class="act"
								disabled={unsettled || s.stale || session?.pending}
								onClick={() => setConfirm(true)}
							>
								<Shuffle size={16} aria-hidden="true" />„{station.name}“ neu mischen …
							</button>
						)}
					</div>
				) : null}
			</section>
		</div>
	);
}

/** Share of a station heard so far, as a tape: heard solid, still to come dashed. */
export function TapeLine({ share }: { share: number | null }) {
	const p = share === null ? 0 : Math.max(0, Math.min(1, share));
	return (
		<span class="tape" aria-hidden="true">
			<span class="tape__heard" style={{ width: `${p * 100}%` }} />
		</span>
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

function QueueRow({
	track,
	index,
	facts,
	known,
}: {
	track: TrackView;
	index: number;
	facts: SongFactsView | null;
	known: boolean;
}) {
	return (
		<li class="queue-row track--rate">
			<span class="queue-number" aria-hidden="true">
				{index}
			</span>
			<Cover src={track.imageUrl} />
			<span class="track__main">
				<strong>{track.name}</strong>
				<span class="muted">{track.artists}</span>
				<SongTags facts={facts} thumb={store.thumbOf(track)} known={known} class="tags--row" />
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

/** "einer Woche", "3 Tagen", or no pause at all. */
function pause(days: number): string {
	if (days <= 0) return "keiner Pause";
	if (days === 7) return "einer Woche";
	if (days === 1) return "einem Tag";
	return `${days} Tagen`;
}
