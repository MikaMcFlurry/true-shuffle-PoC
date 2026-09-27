import { LogOut, Trash2 } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import {
	aggregateHistory,
	detectHistoryFile,
	type ExtendedEntry,
	emptyAggregate,
	toRows,
} from "../../core/history";
import type { AppState, DeviceView, HistoryEntry } from "../../shared/api";
import { api } from "../api";
import { Cover, PageBar, Section } from "../components/radio";
import { RateHit, ThumbMark } from "../components/rate";
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

/** A faceplate key with a printed legend and a small line under it. */
function MenuKey(props: { href: string; legend: string; sub: string; value?: string }) {
	return (
		<li>
			<a class="key menukey" href={props.href}>
				<span class="menukey__legend">{props.legend}</span>
				<span class="menukey__sub">{props.value ?? props.sub}</span>
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
						<input
							type="checkbox"
							role="switch"
							class="switch"
							aria-checked={guest.active}
							checked={guest.active}
							onChange={(e) => toggleGuest((e.target as HTMLInputElement).checked)}
						/>
					</label>
					{!guest.active ? (
						<div class="row">
							<span class="row__main">
								<span class="row__title" id="guest-hours">
									Schaltet sich aus nach
								</span>
							</span>
							<select
								class="input input--inline"
								aria-labelledby="guest-hours"
								value={String(hours)}
								onChange={(e) => setHours(Number((e.target as HTMLSelectElement).value))}
							>
								{[2, 4, 6, 12, 24].map((h) => (
									<option key={h} value={String(h)}>
										{h} Stunden
									</option>
								))}
							</select>
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
				<ul class="keygrid">
					<MenuKey href="/sender/neu" legend="Sender anlegen" sub="Playlists kombinieren" />
					<MenuKey href="/suchlauf" legend="Suchlauf" sub="Weitere Playlists speichern" />
					<MenuKey href="/geraete" legend="Gerät" sub="Wo true-shuffle startet" />
					<MenuKey href="/fernbedienung" legend="Fernbedienung" sub="Siri, CarPlay, Uhr, Widget" />
				</ul>
			</Section>

			<Section title="Gedächtnis" id="memory">
				<ul class="keygrid">
					<MenuKey href="/verlauf" legend="Verlauf" sub="Was zuletzt lief" />
					<MenuKey
						href="/import"
						legend="Import"
						sub="Hörverlauf aus Spotify"
						value={
							state.history.importedTracks > 0
								? `${num(state.history.importedTracks)} Songs mit Vorgeschichte`
								: undefined
						}
					/>
				</ul>
			</Section>
			<Section title="Beleuchtung" id="illum">
				<div class="presetrow" role="toolbar" aria-labelledby="illum">
					{(
						[
							["auto", "Automatisch"],
							["day", "Tag"],
							["night", "Nacht"],
						] as const
					).map(([v, label]) => (
						<button
							key={v}
							type="button"
							aria-pressed={illum === v}
							class="key btn btn--small"
							onClick={() => {
								setIllumination(v);
								setIllum(v);
							}}
						>
							{label}
						</button>
					))}
				</div>
			</Section>

			<Section title="Konto" id="account">
				<ul class="keygrid">
					<MenuKey href="/info" legend="Info" sub="Wie true-shuffle arbeitet" />
					<li>
						<button
							type="button"
							class="key menukey"
							onClick={() =>
								api.logout().finally(() => {
									store.load = { kind: "signed-out" };
									store.emit();
									navigate("/", true);
								})
							}
						>
							<span class="menukey__legend">
								<LogOut class="icon" aria-hidden="true" />
								Abmelden
							</span>
							<span class="menukey__sub">Gedächtnis bleibt</span>
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
					<button
						type="button"
						class="key btn btn--wide key--danger"
						onClick={() => setConfirm(true)}
					>
						<Trash2 class="icon" aria-hidden="true" />
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
					Noch nichts gehört. Sobald du etwas in Spotify hörst, steht es hier — egal ob über True
					Shuffle oder nicht.
				</p>
			) : null}
			{groups.map(([d, list]) => (
				<Section key={d} title={d} id={`d-${d}`}>
					<ol class="inlay tracks tracks--covers">
						{list.map((t) => (
							<li key={`${t.id}-${t.playedAt}`} class="track track--rate">
								<RateHit t={t} />
								<Cover src={t.imageUrl} class="cover--md" />
								<span class="track__main">
									<span class="track__title">{t.name}</span>
									<span class="track__sub">
										{t.artists}
										{t.stationName ? `${SEP}${t.stationName}` : ""}
									</span>
								</span>
								<ThumbMark t={t} />
								<span class="track__meta">
									<span class="num">{clock(t.playedAt)}</span>
									{t.ignored ? <span class="tag">Gast</span> : null}
								</span>
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
			{err ? <p class="note note--error">{err}</p> : null}
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
					Jeder Sender ist eine private Playlist „{DECK_PREFIX}…“ in deinem Spotify. Sie enthält
					nicht alle Songs des Senders, sondern die nächsten 300 (rund 17 Stunden), und true-shuffle
					schreibt sie aus deinem Gedächtnis neu, immer dann, wenn gerade niemand sie hört. So kommt
					nach und nach jeder Song des Senders dran. Spotify spielt sie ganz normal ab — auf jedem
					Gerät, auch im Auto, auch wenn du sie direkt in Spotify startest.
				</p>
				<p class="lede">
					Alle paar Minuten liest true-shuffle, was du gehört hast. Jeder Song ab 30 Sekunden kommt
					ins Gedächtnis, egal wo er lief. Was du früh überspringst, kommt später und seltener
					wieder.
				</p>
			</Section>
			<Section title="Was Spotify nicht zulässt" id="limits">
				<ul class="list">
					<li class="row">
						<span class="row__main">
							<span class="row__title">Autoplay</span>
							<span class="row__sub" style={{ whiteSpace: "normal" }}>
								Ist eine Playlist zu Ende, spielt Spotify eigene Empfehlungen. Die Sender sind lang
								genug, dass das kaum passiert.
							</span>
						</span>
					</li>
					<li class="row">
						<span class="row__main">
							<span class="row__title">Smart Shuffle</span>
							<span class="row__sub" style={{ whiteSpace: "normal" }}>
								Lässt sich per Schnittstelle nicht abschalten und mischt fremde Songs dazu. True
								Shuffle sagt dir, wenn es an ist.
							</span>
						</span>
					</li>
					<li class="row">
						<span class="row__main">
							<span class="row__title">Premium</span>
							<span class="row__sub" style={{ whiteSpace: "normal" }}>
								Starten und Überspringen aus der App geht nur mit Spotify Premium.
							</span>
						</span>
					</li>
					<li class="row">
						<span class="row__main">
							<span class="row__title">Höchstens fünf Konten</span>
							<span class="row__sub" style={{ whiteSpace: "normal" }}>
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
						<span class="row__sub" style={{ whiteSpace: "normal" }}>
							spotify.com → Konto → Datenschutz → „Erweiterter Streamingverlauf“. Spotify schickt
							die Dateien per Mail (bis zu 30 Tage).
						</span>
					</span>
				</li>
				<li class="row">
					<span class="row__main">
						<span class="row__title">2. Hier auswählen</span>
						<span class="row__sub" style={{ whiteSpace: "normal" }}>
							Alle Dateien „Streaming_History_Audio_…json“ auf einmal.
						</span>
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
