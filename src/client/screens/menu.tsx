import { ChevronRight, LogOut } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import {
	aggregateHistory,
	detectHistoryFile,
	type ExtendedEntry,
	emptyAggregate,
	toRows,
} from "../../core/history";
import type { AppState, DeviceView, HistoryEntry } from "../../shared/api";
import type { SpotifyUsageReport } from "../../shared/spotify-usage";
import { api, type SpotifyDiagnostics } from "../api";
import { RateHit, ThumbMark } from "../components/rate";
import { SpotifyFunctionStatus, SpotifyUsageTracker } from "../components/spotify-availability";
import { Detents, PageBar, Section } from "../components/ui";
import { clock, DECK_PREFIX, day, num, SEP } from "../format";

const DEVICE_TYPES: Record<string, string> = {
	Smartphone: "Handy",
	Computer: "Computer",
	Tablet: "Tablet",
	Speaker: "Lautsprecher",
	TV: "Fernseher",
	AVR: "Receiver",
	STB: "TV-Box",
	AudioDongle: "Audio-Stick",
	GameConsole: "Konsole",
	CastVideo: "Chromecast",
	CastAudio: "Cast-Lautsprecher",
	Automobile: "Auto",
};

function deviceType(t: string): string {
	return DEVICE_TYPES[t] ?? t;
}

import { navigate } from "../router";
import { getIllumination, type Illumination, setIllumination, store } from "../store";
import { roundLabel } from "./home";

const GUEST_HOURS = [2, 4, 6, 12, 24].map((h) => [String(h), `${h} Std.`] as const);

const ILLUMINATIONS = [
	["day", "Tag"],
	["auto", "Automatisch"],
	["night", "Nacht"],
] as const;

/** One menu entry: the whole row is the link. */
function Terminal(props: {
	href: string;
	legend: string;
	sub: string;
	n?: number;
	act?: string;
	label?: string;
}) {
	return (
		<li>
			<a class="terminal" href={props.href} aria-label={props.label}>
				<span class="terminal__plate">
					<span class="terminal__legend">{props.legend}</span>
					<span class="terminal__sub">{props.sub}</span>
				</span>
				{props.act ? <span class="terminal__act">{props.act}</span> : null}
				<ChevronRight class="terminal__chev" size={20} aria-hidden="true" />
			</a>
		</li>
	);
}

export function MenuScreen({ state }: { state: AppState }) {
	const [illum, setIllum] = useState<Illumination>(getIllumination());
	const [hours, setHours] = useState(6);
	const [confirm, setConfirm] = useState(false);
	const guest = state.guest;

	const toggleGuest = (on: boolean) =>
		api
			.guest(on, hours)
			.then(() => {
				store.say(
					on
						? `Gast-Modus an — ${hours} Stunden lang zählt nichts`
						: "Gast-Modus aus — was du ab jetzt hörst, zählt wieder",
					"info",
					4000,
				);
				void store.refresh(false);
			})
			.catch((e: Error) => store.say(e.message, "error"));

	return (
		<div class="page">
			<PageBar title="Menü" sub={state.profile.name} backTo="/" />

			<Section title="Gäste" id="guest">
				<div class="keyunit">
					<label class="row">
						<span class="row__main">
							<span class="row__title">Gast-Modus</span>
							<span class="row__sub">
								{guest.active && guest.until
									? `An bis ${clock(guest.until)} — was jetzt läuft, zählt nicht`
									: "Hört jemand anderes über dein Konto? Dann zählt nichts davon."}
							</span>
						</span>
						<span class="lever">
							<input
								type="checkbox"
								role="switch"
								class="switch"
								aria-checked={guest.active}
								checked={guest.active}
								onChange={(e) => toggleGuest((e.target as HTMLInputElement).checked)}
							/>
						</span>
					</label>
					{!guest.active ? (
						<div class="row row--detents">
							<Detents
								name="guest-hours"
								legend="Schaltet sich aus nach"
								options={GUEST_HOURS}
								value={String(hours)}
								onChange={(v) => setHours(Number(v))}
							/>
						</div>
					) : (
						<button type="button" class="row" onClick={() => toggleGuest(true)}>
							<span class="row__main">
								<span class="row__title">Verlängern</span>
								<span class="row__sub">Noch einmal {hours} Stunden ab jetzt</span>
							</span>
						</button>
					)}
				</div>
			</Section>
			<Section title="Sender" id="stations">
				<ul class="strip-list">
					{state.stations.map((x, i) => (
						<Terminal
							key={x.id}
							href={`/sender/${x.id}`}
							n={i + 1}
							legend={x.name}
							sub={roundLabel(x)}
							act="einstellen"
							label={`${x.name} einstellen`}
						/>
					))}
					<Terminal href="/sender/neu" legend="Sender anlegen" sub="Playlists kombinieren" />
					<Terminal href="/suchlauf" legend="Suchlauf" sub="Weitere Playlists speichern" />
				</ul>
			</Section>

			<Section title="Anschlüsse" id="connections">
				<ul class="strip-list">
					<Terminal href="/geraete" legend="Gerät" sub="Wo true-shuffle startet" />
					<Terminal href="/fernbedienung" legend="Fernbedienung" sub="Siri, CarPlay, Uhr, Widget" />
				</ul>
			</Section>

			<Section title="Gedächtnis" id="memory">
				<ul class="strip-list">
					<Terminal href="/verlauf" legend="Verlauf" sub="Was zuletzt lief" />
					<Terminal
						href="/import"
						legend="Import"
						sub={
							state.history.importedTracks > 0
								? `${num(state.history.importedTracks)} Songs mit Vorgeschichte`
								: "Hörverlauf aus Spotify"
						}
					/>
				</ul>
			</Section>
			<Section title="Darstellung" id="illum">
				<fieldset class="segmented" aria-labelledby="illum">
					<div class="segmented__row">
						{ILLUMINATIONS.map(([v, label]) => (
							<button
								key={v}
								type="button"
								aria-pressed={illum === v}
								class="segmented__opt segmented__opt--button"
								onClick={() => {
									setIllumination(v);
									setIllum(v);
								}}
							>
								{label}
							</button>
						))}
					</div>
				</fieldset>
			</Section>

			<Section title="Konto" id="account">
				<ul class="strip-list">
					<Terminal href="/info" legend="Info" sub="Wie true-shuffle arbeitet" />
					<li>
						<button
							type="button"
							class="terminal"
							onClick={() =>
								api.logout().finally(() => {
									store.load = { kind: "signed-out" };
									store.emit();
									navigate("/", true);
								})
							}
						>
							<span class="terminal__plate">
								<span class="terminal__legend">Abmelden</span>
								<span class="terminal__sub">Gedächtnis bleibt</span>
							</span>
							<LogOut class="terminal__chev" size={20} aria-hidden="true" />
						</button>
					</li>
				</ul>
				{confirm ? (
					<div class="stack">
						<p class="note note--error">
							Alles löschen? Dein Gedächtnis, alle Sender und ihre Spotify-Playlists „{DECK_PREFIX}
							…“ werden entfernt. Das lässt sich nicht rückgängig machen.
						</p>
						<div class="row-actions">
							<button type="button" class="key btn" onClick={() => setConfirm(false)}>
								Behalten
							</button>
							<button
								type="button"
								class="key btn key--danger"
								onClick={() =>
									api
										.deleteAccount()
										.then((r) => {
											store.load = { kind: "signed-out" };
											store.emit();
											if (r.stuck.length) {
												store.say(
													`${r.stuck.length} Playlist(s) „${DECK_PREFIX}…“ bitte in Spotify selbst löschen — sie ließen sich nicht entfernen.`,
													"warn",
													20000,
												);
											}
											navigate("/", true);
										})
										.catch((e: Error) => store.say(e.message, "error"))
								}
							>
								Endgültig löschen
							</button>
						</div>
					</div>
				) : (
					<button type="button" class="act act--danger" onClick={() => setConfirm(true)}>
						Konto und Daten löschen
					</button>
				)}
			</Section>
		</div>
	);
}

export function HistoryScreen() {
	const [items, setItems] = useState<HistoryEntry[] | null>(null);
	const [more, setMore] = useState(true);
	const [err, setErr] = useState<string | null>(null);
	useEffect(() => {
		const started = Date.now();
		api
			.history()
			.then((x) => {
				store.settleThumbs(x, started);
				setItems(x);
				setMore(x.length >= 60);
			})
			.catch((e: Error) => setErr(e.message));
	}, []);
	const loadMore = () => {
		const last = items?.[items.length - 1];
		if (!last) return;
		api.history(last.playedAt).then((x) => {
			setItems([...(items ?? []), ...x]);
			setMore(x.length >= 60);
		});
	};
	const groups: [string, HistoryEntry[]][] = [];
	for (const it of items ?? []) {
		const d = day(it.playedAt);
		const g = groups[groups.length - 1];
		if (g && g[0] === d) g[1].push(it);
		else groups.push([d, [it]]);
	}
	return (
		<div class="page">
			<PageBar title="Verlauf" sub="Jeder Song ab 30 Sekunden — so zählt Spotify" backTo="/menu" />
			{err ? <p class="note note--error">{err}</p> : null}
			{!items && !err ? <div class="skeleton" style={{ height: "300px" }} /> : null}
			{items && items.length === 0 ? (
				<p class="lede">
					Noch nichts gehört. Sobald du etwas in Spotify hörst, steht es hier — egal ob über
					true-shuffle oder nicht.
				</p>
			) : null}
			{groups.map(([d, list]) => (
				<Section key={d} title={d} id={`d-${d}`}>
					<ol class="order">
						{list.map((t) => (
							<li key={`${t.id}-${t.playedAt}`} class="order__row track--rate">
								<RateHit t={t} />
								<span class="order__when num">{clock(t.playedAt)}</span>
								<span class="order__title">
									<span class="order__song">{t.name}</span>
									<span class="order__artist">
										{t.artists}
										{t.stationName ? `${SEP}${t.stationName}` : ""}
									</span>
								</span>
								<ThumbMark t={t} />
								{t.ignored ? <span class="tag">Gast</span> : null}
							</li>
						))}
					</ol>
				</Section>
			))}
			{items && more ? (
				<button type="button" class="key btn btn--wide" onClick={loadMore}>
					Ältere laden
				</button>
			) : null}
		</div>
	);
}

export function DevicesScreen() {
	const [testing, setTesting] = useState(false);
	const [diagnostics, setDiagnostics] = useState<SpotifyDiagnostics | null>(null);
	const [diagnosticError, setDiagnosticError] = useState("");
	const [usage, setUsage] = useState<SpotifyUsageReport | null>(null);
	const [usageError, setUsageError] = useState("");
	const loadDiagnostics = async (): Promise<void> => {
		setDiagnosticError("");
		setUsageError("");
		await Promise.allSettled([
			api
				.spotifyUsage()
				.then(setUsage)
				.catch((e: Error) => setUsageError(e.message)),
			api
				.spotifyDiagnostics()
				.then(setDiagnostics)
				.catch((e: Error) => setDiagnosticError(e.message)),
		]);
	};
	useEffect(() => {
		void loadDiagnostics();
	}, []);
	const [devices, setDevices] = useState<DeviceView[] | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [chosen, setChosen] = useState<string | null>(() => {
		try {
			return localStorage.getItem("ts-device");
		} catch {
			return null;
		}
	});
	const load = () => {
		setErr(null);
		api
			.devices()
			.then(setDevices)
			.catch((e: Error) => setErr(e.message));
	};
	useEffect(load, []);
	const choose = (id: string | null) => {
		setChosen(id);
		try {
			if (id) localStorage.setItem("ts-device", id);
			else localStorage.removeItem("ts-device");
			const name = devices?.find((device) => device.id === id)?.name;
			if (name) localStorage.setItem("ts-device-name", name);
			else localStorage.removeItem("ts-device-name");
		} catch {
			/* ignore */
		}
	};
	return (
		<div class="page">
			<PageBar title="Wiedergabegerät" sub="Wo ein Tipp auf einen Sender abspielt" backTo="/menu" />
			<p class="lede">
				Spotify zeigt nur Geräte, auf denen die Spotify-App gerade offen ist. Siehst du deins nicht,
				öffne dort kurz Spotify und lade neu.
			</p>
			{err ? <p class="note note--error">Letzte Geräteabfrage: {err}</p> : null}
			<ul class="list">
				<li>
					<label class="row">
						<input
							type="radio"
							class="check"
							name="dev"
							checked={!chosen}
							onChange={() => choose(null)}
						/>
						<span class="row__main">
							<span class="row__title">Automatisch</span>
							<span class="row__sub">Das gerade aktive Gerät, sonst dein Handy</span>
						</span>
					</label>
				</li>
				{chosen && !devices?.some((device) => device.id === chosen) ? (
					<li>
						<p class="row">
							<span class="row__main">
								<span class="row__title">
									{chosen === "spotify"
										? "Spotify · aktives Gerät"
										: chosen.startsWith("native:")
											? "Gespeichertes HA/MA-Gerät"
											: "Gespeichertes Spotify-Gerät"}
								</span>
								<span class="row__sub">
									Auswahl bleibt erhalten ·{" "}
									{chosen === "spotify"
										? "automatische Spotify-Auswahl"
										: "zurzeit nicht in der Spotify-Geräteliste"}
								</span>
							</span>
						</p>
					</li>
				) : null}
				{(devices ?? []).map((d) => (
					<li key={d.id}>
						<label class="row" aria-disabled={d.restricted}>
							<input
								type="radio"
								class="check"
								name="dev"
								disabled={d.restricted}
								checked={chosen === d.id}
								onChange={() => choose(d.id)}
							/>
							<span class="row__main">
								<span class="row__title">{d.name}</span>
								<span class="row__sub">
									{deviceType(d.type)}
									{d.active ? `${SEP}aktiv` : ""}
									{d.restricted ? `${SEP}nimmt keine Befehle an` : ""}
								</span>
							</span>
						</label>
					</li>
				))}
			</ul>
			<details class="more">
				<summary>Spotify-Freigabe & Anfragestatus</summary>
				<div class="more__body">
					<p>
						Hier siehst du bestätigte Antworten von Spotify. Eine 429 betrifft zunächst nur die
						Operation, für die Spotify sie tatsächlich gemeldet hat. Gespeicherter Verlauf und
						Warteschlangen bleiben erhalten.
					</p>

					{diagnostics ? (
						<>
							<SpotifyFunctionStatus
								diagnostics={diagnostics}
								busy={testing}
								onRetry={(scope) => {
									setTesting(true);
									setDiagnosticError("");
									void api
										.retrySpotify(scope)
										.then(loadDiagnostics)
										.catch((e: Error) => setDiagnosticError(e.message))
										.finally(() => setTesting(false));
								}}
							/>
							<button
								type="button"
								class="key btn"
								disabled={testing}
								onClick={() => {
									setTesting(true);
									setDiagnosticError("");
									void api
										.testSpotifyAvailability()
										.then((result) => {
											if (result.devices) {
												setDevices(result.devices);
												setErr(null);
											}
											return loadDiagnostics();
										})
										.catch((e: Error) => setDiagnosticError(e.message))
										.finally(() => setTesting(false));
								}}
							>
								{testing ? "Funktionen werden geprüft …" : "Funktionen gezielt testen"}
							</button>
							<h3>Gespeicherte Anfrageversuche pro Stunde</h3>
							<p class="hint">
								Einträge mit „blocked“ wurden lokal zurückgehalten und nicht an Spotify gesendet.
							</p>
							<pre class="diagnostic-data">
								{JSON.stringify(diagnostics.requests?.counts ?? {}, null, 2)}
							</pre>
							<h3>Letzter Anfrageversuch</h3>
							<pre class="diagnostic-data">
								{JSON.stringify(diagnostics.requests?.latest ?? null, null, 2)}
							</pre>
						</>
					) : null}
					{usageError ? (
						<p class="note note--error" role="alert">
							Gemeinsame Nutzung nicht aktualisiert: {usageError}
							{usage ? " Der letzte erfolgreiche Stand bleibt sichtbar." : ""}
						</p>
					) : null}
					{usage ? (
						<SpotifyUsageTracker report={usage} />
					) : !usageError ? (
						<p class="hint" aria-busy="true">
							Gemeinsame Spotify-Nutzung wird geladen …
						</p>
					) : null}

					{diagnosticError ? <p class="note note--error">{diagnosticError}</p> : null}
					<div class="row-actions">
						<button type="button" class="key" onClick={loadDiagnostics}>
							Status aktualisieren
						</button>
					</div>
				</div>
			</details>

			<button type="button" class="key btn btn--wide" onClick={load}>
				Geräte neu suchen
			</button>
		</div>
	);
}

export function AboutScreen() {
	return (
		<div class="page">
			<PageBar title="Info" sub="Wie true-shuffle arbeitet" backTo="/menu" />
			<Section title="Wie es funktioniert" id="how">
				<p class="lede">
					Jeder Sender nutzt eine private Playlist „{DECK_PREFIX}…“ in deinem Spotify. Darin steht
					deine geordnete Warteschlange. „Fortsetzen“ führt denselben Lauf weiter: derselbe
					unvollendete Song, an der zuletzt beobachteten Position. Ist die Position unbekannt,
					beginnt dieser Song von vorne. Nur „Neue Warteschlange“ ersetzt den Lauf bewusst. Die
					Reihenfolge wächst automatisch weiter, auch über Pausen, App-Schließungen und
					Gerätewechsel hinweg.
				</p>
				<p class="lede">
					Alle paar Minuten liest true-shuffle, was du gehört hast. Jeder Song ab 30 Sekunden kommt
					ins Gedächtnis, egal wo er lief. Was du früh überspringst, kommt später und seltener
					wieder.
				</p>
			</Section>
			<Section title="Wiedergabe auf deinen Geräten" id="playback-routes">
				<p>
					Music-Assistant-Geräte, die in Spotify sichtbar sind, nutzt du über Spotify Connect. Die
					separate native HA/MA-Route zeigt nur konfigurierte Geräte und deren tatsächliche
					Fähigkeiten. Ohne Seek beginnt derselbe Song von vorne; ohne Warteschlangen-Unterstützung
					spielt das Gerät nur einen Song.
				</p>
				<a class="act" href="/geraete">
					Geräte & Provider-Status ansehen
				</a>
			</Section>

			<Section title="Was Spotify nicht zulässt" id="limits">
				<ul class="list">
					<li class="row">
						<span class="row__main">
							<span class="row__title">Autoplay</span>
							<span class="row__sub">
								Kann true-shuffle die Warteschlange gerade nicht erweitern, etwa bei einer
								Spotify-Sperre, kann Spotify am Ende eigene Empfehlungen spielen. Dein gespeicherter
								Lauf bleibt erhalten.
							</span>
						</span>
					</li>
					<li class="row">
						<span class="row__main">
							<span class="row__title">Smart Shuffle</span>
							<span class="row__sub">
								Lässt sich per Schnittstelle nicht abschalten und mischt fremde Songs dazu.
								true-shuffle sagt dir, wenn es an ist.
							</span>
						</span>
					</li>
					<li class="row">
						<span class="row__main">
							<span class="row__title">Premium</span>
							<span class="row__sub">
								Starten und Überspringen aus der App geht nur mit Spotify Premium.
							</span>
						</span>
					</li>
					<li class="row">
						<span class="row__main">
							<span class="row__title">Höchstens fünf Konten</span>
							<span class="row__sub">
								Spotify erlaubt privaten Apps nur fünf freigeschaltete Nutzer.
							</span>
						</span>
					</li>
				</ul>
			</Section>
			<Section title="Quellen für Neuentdeckungen" id="sources">
				<p class="lede">
					Weitere Songs deiner Künstler und ihre Neuerscheinungen (Spotify), ähnliche Künstler
					(Last.fm, Deezer), die Genre-Suche von Spotify und KI-Vorschläge. Jeder Vorschlag wird bei
					Spotify geprüft, bevor er in einen Sender darf.
				</p>
			</Section>
		</div>
	);
}

export function ImportScreen({ state }: { state: AppState }) {
	const [phase, setPhase] = useState<"idle" | "reading" | "ready" | "upload" | "done">("idle");
	const [summary, setSummary] = useState<{
		files: number;
		plays: number;
		skips: number;
		tracks: number;
		from: number | null;
		to: number | null;
	} | null>(null);
	const [rows, setRows] = useState<[string, number, number, number][]>([]);
	const [err, setErr] = useState<string | null>(null);
	const [sent, setSent] = useState(0);

	const read = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setErr(null);
		setPhase("reading");
		const agg = emptyAggregate();
		let used = 0;
		for (const f of Array.from(files)) {
			try {
				const data = JSON.parse(await f.text()) as unknown;
				const kind = detectHistoryFile(data);
				if (kind === "account") {
					setErr(
						`„${f.name}“ ist der einfache Datenexport ohne Song-IDs. Bitte den erweiterten Streamingverlauf anfordern (Dateien „Streaming_History_Audio_…“).`,
					);
					continue;
				}
				if (kind !== "extended") continue;
				// What came after the first sign-in, true-shuffle already counted live.
				aggregateHistory(data as ExtendedEntry[], agg, { before: state.history.liveSince });
				used++;
			} catch {
				setErr(`„${f.name}“ konnte nicht gelesen werden.`);
			}
		}
		const r = toRows(agg);
		setRows(r);
		setSummary({
			files: used,
			plays: agg.counted,
			skips: agg.skipped,
			tracks: r.length,
			from: agg.firstAt,
			to: agg.lastAt,
		});
		setPhase(r.length > 0 ? "ready" : "idle");
	};

	const upload = async () => {
		setPhase("upload");
		const size = 2000;
		const parts = Math.max(1, Math.ceil(rows.length / size));
		try {
			for (let i = 0; i < parts; i++) {
				await api.importHistory(rows.slice(i * size, (i + 1) * size), i, parts);
				setSent(Math.min(rows.length, (i + 1) * size));
			}
			setPhase("done");
			void store.refresh(false);
		} catch (e) {
			setErr((e as Error).message);
			setPhase("ready");
		}
	};

	return (
		<div class="page">
			<PageBar
				title="Hörverlauf importieren"
				sub="Startwissen für dein Gedächtnis"
				backTo="/menu"
			/>
			<p class="lede">
				Mit deinem Spotify-Hörverlauf weiß true-shuffle vom ersten Tag an, was du oft gehört, früh
				übersprungen oder nie gehört hast. Die Dateien werden hier im Browser ausgewertet —
				hochgeladen wird nur, wie oft du welchen Song gehört hast. Es zählt nur, was vor deiner
				ersten Anmeldung lief; alles danach hat true-shuffle schon selbst mitgezählt.
			</p>
			<ol class="list">
				<li class="row">
					<span class="row__main">
						<span class="row__title">1. In Spotify anfordern</span>
						<span class="row__sub">
							spotify.com → Konto → Datenschutz → „Erweiterter Streamingverlauf“. Spotify schickt
							die Dateien per Mail (bis zu 30 Tage).
						</span>
					</span>
				</li>
				<li class="row">
					<span class="row__main">
						<span class="row__title">2. Hier auswählen</span>
						<span class="row__sub">Alle Dateien „Streaming_History_Audio_…json“ auf einmal.</span>
					</span>
				</li>
			</ol>
			{state.history.importedTracks > 0 ? (
				<p class="note">
					Bereits importiert: {num(state.history.importedTracks)} Songs. Ein neuer Import ersetzt
					den alten.
				</p>
			) : null}
			{err ? <p class="note note--error">{err}</p> : null}
			{phase === "idle" || phase === "reading" ? (
				<label class="drop">
					<input
						type="file"
						accept="application/json,.json"
						multiple
						onChange={(e) => void read((e.target as HTMLInputElement).files)}
					/>
					{phase === "reading" ? "Werte aus …" : "Dateien auswählen"}
				</label>
			) : null}
			{summary && (phase === "ready" || phase === "upload" || phase === "done") ? (
				<div class="meter">
					<div class="meter__legend num">
						<strong>
							{num(summary.tracks)} <span>Songs</span>
						</strong>
						<strong>
							{num(summary.plays)} <span>mal gehört</span>
						</strong>
						<strong>
							{num(summary.skips)} <span>früh übersprungen</span>
						</strong>
					</div>
					{summary.from && summary.to ? (
						<p class="hint">
							Aus {summary.files} {summary.files === 1 ? "Datei" : "Dateien"}, {day(summary.from)}{" "}
							bis {day(summary.to)}
						</p>
					) : null}
					{phase === "upload" ? (
						<div
							class="progress"
							role="progressbar"
							aria-valuemin={0}
							aria-valuemax={rows.length}
							aria-valuenow={sent}
						>
							<span style={{ "--done": String(sent / Math.max(1, rows.length)) }} />
						</div>
					) : null}
				</div>
			) : null}
			{phase === "ready" ? (
				<button type="button" class="key key--lit btn btn--wide" onClick={() => void upload()}>
					Ins Gedächtnis übernehmen
				</button>
			) : null}
			{phase === "done" ? (
				<>
					<p class="note">
						Übernommen. Deine Sender werden beim nächsten Mal mit diesem Wissen neu befüllt.
					</p>
					<a class="key btn btn--wide" href="/">
						Zu den Sendern
					</a>
				</>
			) : null}
		</div>
	);
}
