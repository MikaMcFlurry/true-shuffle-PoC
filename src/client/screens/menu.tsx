import {
	ChevronRight,
	FileUp,
	History,
	House,
	Info,
	LogOut,
	type LucideIcon,
	Speaker,
	Trash2,
	Watch,
} from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
	aggregateHistory,
	detectHistoryFile,
	type ExtendedEntry,
	emptyAggregate,
	type HistoryRow,
	toRows,
} from "../../core/history";
import { FAMILIAR_PLAYS, RARE_AFTER_EARLY_SKIPS } from "../../core/memory";
import { DAY_MS } from "../../core/types";
import type { AppState, DeviceView, HistoryEntry } from "../../shared/api";
import { api, type NativeDevice } from "../api";
import { RateHit, ThumbMark } from "../components/rate";
import { SpotifyStatus } from "../components/spotify-availability";
import { Cover, PageBar, Section } from "../components/ui";
import { clock, DECK_PREFIX, day, num, SEP } from "../format";
import { navigate } from "../router";
import { getIllumination, type Illumination, setIllumination, store } from "../store";

// ------------------------------------------------------------------ shared

const fullDate = new Intl.DateTimeFormat("de-DE", {
	day: "numeric",
	month: "long",
	year: "numeric",
});

/** "12. März 2024": a date that also names its year. */
function date(at: number): string {
	return fullDate.format(at);
}

/** A row that opens another page: the whole row is the link. */
function LinkRow(props: {
	href: string;
	icon: LucideIcon;
	title: string;
	children?: ComponentChildren;
}) {
	const Icon = props.icon;
	return (
		<li>
			<a class="row mehr-row" href={props.href}>
				<Icon class="mehr-row__icon" size={22} aria-hidden="true" />
				<span class="row__main">
					<span class="row__title">{props.title}</span>
					{props.children ? <span class="row__sub">{props.children}</span> : null}
				</span>
				<ChevronRight class="mehr-row__chev" size={20} aria-hidden="true" />
			</a>
		</li>
	);
}

/** Choices printed as segments over native radios (arrow keys, screen readers). */
function Segments<T extends string>(props: {
	name: string;
	legend: string;
	options: readonly (readonly [T, string])[];
	value: T;
	onChange: (v: T) => void;
}) {
	return (
		<fieldset class="segmented">
			<legend class="segmented__legend">{props.legend}</legend>
			<div class="segmented__row">
				{props.options.map(([v, label]) => (
					<label key={v} class="segmented__opt">
						<input
							type="radio"
							name={props.name}
							value={v}
							checked={props.value === v}
							onChange={() => props.onChange(v)}
						/>
						<span>{label}</span>
					</label>
				))}
			</div>
		</fieldset>
	);
}

// -------------------------------------------------------------------- Mehr

const GUEST_HOURS = [2, 4, 6, 12, 24].map((h) => [String(h), `${h} Std.`] as const);

const ILLUMINATIONS = [
	["day", "Hell"],
	["night", "Dunkel"],
	["auto", "Automatisch"],
] as const;

/** "21:30" today, "Morgen, 09:00" or a weekday when it ends on another day. */
function until(at: number): string {
	const d = day(at);
	const tomorrow = new Date();
	tomorrow.setDate(tomorrow.getDate() + 1);
	const label =
		d === "Heute"
			? ""
			: new Date(at).toDateString() === tomorrow.toDateString()
				? "morgen, "
				: `${d}, `;
	return `${label}${clock(at)} Uhr`;
}

export function MenuScreen({ state }: { state: AppState }) {
	const [illum, setIllum] = useState<Illumination>(getIllumination());
	const [hours, setHours] = useState(6);
	const [confirm, setConfirm] = useState(false);
	const [busy, setBusy] = useState(false);
	const guest = state.guest;
	const hist = state.history;

	const toggleGuest = (on: boolean) => {
		setBusy(true);
		api
			.guest(on, hours)
			.then(() => {
				store.say(
					on
						? `Gast-Modus an: ${hours} Stunden lang zählt nichts`
						: "Gast-Modus aus: was du ab jetzt hörst, zählt wieder",
					"info",
					4000,
				);
				void store.refresh(false);
			})
			.catch((e: Error) => store.say(e.message, "error"))
			.finally(() => setBusy(false));
	};

	const signOut = () =>
		api.logout().finally(() => {
			store.load = { kind: "signed-out" };
			store.emit();
			navigate("/", true);
		});

	const deleteAccount = () =>
		api
			.deleteAccount()
			.then((r) => {
				store.load = { kind: "signed-out" };
				store.emit();
				if (r.stuck.length) {
					store.say(
						`${r.stuck.length} Playlist(s) „${DECK_PREFIX}…“ bitte in Spotify selbst löschen. Sie ließen sich nicht entfernen.`,
						"warn",
						20000,
					);
				}
				navigate("/", true);
			})
			.catch((e: Error) => store.say(e.message, "error"));

	return (
		<div class="page mehr">
			<PageBar
				title="Mehr"
				noBack
				sub="Wo die Musik spielt, was true-shuffle über dich weiß, Darstellung und Konto."
			/>

			<Section title="Wiedergabe" id="mehr-play">
				<ul class="list">
					<LinkRow href="/geraete" icon={Speaker} title="Geräte">
						Wo die Musik spielt: Handy, Computer, Lautsprecher, Auto oder Home Assistant.
					</LinkRow>
					<li>
						<label class="row mehr-switch">
							<span class="row__main">
								<span class="row__title">Gast-Modus</span>
								<span class="row__sub">
									{guest.active && guest.until
										? `Läuft bis ${until(guest.until)}. Bis dahin zählt nichts, was du hörst. Danach schaltet er sich selbst aus.`
										: guest.active
											? "Läuft. Bis du ihn ausschaltest, zählt nichts, was du hörst."
											: `Hört jemand anderes über dein Konto? Dann zählt nichts davon. Schaltet sich nach ${hours} Stunden selbst aus.`}
								</span>
							</span>
							<input
								type="checkbox"
								role="switch"
								class="switch"
								aria-checked={guest.active}
								checked={guest.active}
								disabled={busy}
								onChange={(e) => toggleGuest(e.currentTarget.checked)}
							/>
						</label>
					</li>
					{guest.active ? (
						<li>
							<button
								type="button"
								class="row mehr-row"
								disabled={busy}
								onClick={() => toggleGuest(true)}
							>
								<span class="row__main">
									<span class="row__title">Verlängern</span>
									<span class="row__sub">Noch einmal {hours} Stunden ab jetzt</span>
								</span>
							</button>
						</li>
					) : (
						<li class="row mehr-stack">
							<Segments
								name="guest-hours"
								legend="Schaltet sich aus nach"
								options={GUEST_HOURS}
								value={String(hours)}
								onChange={(v) => setHours(Number(v))}
							/>
						</li>
					)}
				</ul>
			</Section>

			<Section title="Was true-shuffle über dich weiß" id="mehr-memory">
				<p class="section__lead">
					Für jeden Song: wie oft du ihn gehört hast, wann zuletzt und ob du ihn früh übersprungen
					hast. Daraus plant es, was als Nächstes kommt.
				</p>
				<ul class="list">
					<LinkRow href="/import" icon={FileUp} title="Hörverlauf importieren">
						{hist.importedTracks > 0
							? `${num(hist.importedTracks)} Songs aus deinem Spotify-Verlauf sind eingerechnet${hist.importedAt ? ` (seit ${date(hist.importedAt)})` : ""}.`
							: "Noch nicht importiert. Mit deinem Spotify-Verlauf weiß true-shuffle sofort, was du schon kennst."}
					</LinkRow>
					<LinkRow href="/verlauf" icon={History} title="Verlauf">
						Jeder Song ab 30 Sekunden, nach Tagen geordnet.
						{hist.liveSince ? ` Selbst mitgezählt seit ${date(hist.liveSince)}.` : ""}
					</LinkRow>
				</ul>
			</Section>

			<Section title="Von außen steuern" id="mehr-remote">
				<ul class="list">
					<LinkRow href="/fernbedienung" icon={Watch} title="Fernbedienung">
						Kurzbefehle für iPhone, CarPlay, Apple Watch und Android: Favorit, Nie wieder, Weiter,
						ohne die App zu öffnen.
					</LinkRow>
					<LinkRow href="/geraete" icon={House} title="Home Assistant">
						Lautsprecher aus Home Assistant und Music Assistant als Wiedergabegerät.
					</LinkRow>
				</ul>
			</Section>

			<Section title="App" id="mehr-app">
				<ul class="list">
					<li class="row mehr-stack">
						<Segments
							name="illumination"
							legend="Darstellung"
							options={ILLUMINATIONS}
							value={illum}
							onChange={(v) => {
								setIllumination(v);
								setIllum(v);
							}}
						/>
						<p class="row__sub">Automatisch folgt deinem Gerät. Gilt nur auf diesem Gerät.</p>
					</li>
					<li>
						<SpotifyStatus />
					</li>
					<LinkRow href="/info" icon={Info} title="Über true-shuffle">
						Was es verspricht und was Spotify nicht zulässt.
					</LinkRow>
				</ul>
			</Section>

			<Section title="Konto" id="mehr-account">
				<ul class="list">
					<li class="row">
						<Cover src={state.profile.imageUrl} class="mehr-avatar" />
						<span class="row__main">
							<span class="row__title">{state.profile.name || "Dein Spotify-Konto"}</span>
							<span class="row__sub">Angemeldet mit Spotify</span>
						</span>
					</li>
					<li>
						<button type="button" class="row mehr-row" onClick={() => void signOut()}>
							<LogOut class="mehr-row__icon" size={22} aria-hidden="true" />
							<span class="row__main">
								<span class="row__title">Abmelden</span>
								<span class="row__sub">Deine Sender und dein Gedächtnis bleiben gespeichert.</span>
							</span>
						</button>
					</li>
					<li>
						<button
							type="button"
							class="row mehr-row mehr-row--danger"
							aria-expanded={confirm}
							onClick={() => setConfirm((c) => !c)}
						>
							<Trash2 class="mehr-row__icon" size={22} aria-hidden="true" />
							<span class="row__main">
								<span class="row__title">Konto löschen</span>
								<span class="row__sub">
									Löscht alles, was true-shuffle über dich gespeichert hat.
								</span>
							</span>
						</button>
					</li>
				</ul>
				{confirm ? (
					<div class="notice notice--error" role="alert">
						<p>
							Wirklich alles löschen? Dein Gedächtnis, alle Sender und ihre Spotify-Playlists „
							{DECK_PREFIX}…“ werden entfernt. Das lässt sich nicht rückgängig machen. Deine eigenen
							Playlists und Lieblingssongs in Spotify bleiben.
						</p>
						<div class="row-actions">
							<button type="button" class="key" onClick={() => setConfirm(false)}>
								Behalten
							</button>
							<button type="button" class="key key--danger" onClick={() => void deleteAccount()}>
								Endgültig löschen
							</button>
						</div>
					</div>
				) : null}
			</Section>
		</div>
	);
}

// ----------------------------------------------------------------- Verlauf

const PAGE = 60;

export function HistoryScreen() {
	const [items, setItems] = useState<HistoryEntry[] | null>(null);
	const [more, setMore] = useState(true);
	const [loading, setLoading] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	useEffect(() => {
		const started = Date.now();
		api
			.history()
			.then((x) => {
				store.settleThumbs(x, started);
				setItems(x);
				setMore(x.length >= PAGE);
			})
			.catch((e: Error) => setErr(e.message));
	}, []);
	const loadMore = () => {
		const last = items?.[items.length - 1];
		if (!last || loading) return;
		setLoading(true);
		setErr(null);
		api
			.history(last.playedAt)
			.then((x) => {
				setItems([...(items ?? []), ...x]);
				setMore(x.length >= PAGE);
			})
			.catch((e: Error) => setErr(e.message))
			.finally(() => setLoading(false));
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
			<PageBar
				title="Verlauf"
				noBack
				sub="Jeder Song, den du mindestens 30 Sekunden gehört hast, auch außerhalb von true-shuffle. Tippe auf einen Song, um ihn zu bewerten."
			/>
			{!items && !err ? <div class="skeleton" style={{ height: "300px" }} /> : null}
			{items && items.length === 0 ? (
				<p class="empty-state">
					Noch nichts gehört. Sobald du etwas in Spotify hörst, steht es hier, egal ob über
					true-shuffle oder nicht.
				</p>
			) : null}
			{groups.map(([d, list], gi) => (
				<Section key={d} title={d} id={`verlauf-${gi}`}>
					<ol class="list hist">
						{list.map((t) => (
							<li key={`${t.id}-${t.playedAt}`} class="hist-row track--rate">
								<time class="hist-row__time" dateTime={new Date(t.playedAt).toISOString()}>
									{clock(t.playedAt)}
								</time>
								<Cover src={t.imageUrl} />
								<span class="hist-row__main">
									<span class="hist-row__title">{t.name}</span>
									<span class="hist-row__sub">{t.artists}</span>
									{t.stationName ? <span class="hist-row__station">{t.stationName}</span> : null}
								</span>
								<span class="hist-row__marks">
									<ThumbMark t={t} />
									{t.ignored ? (
										<span class="tag" title="Lief im Gast-Modus und zählt nicht">
											Gast
										</span>
									) : null}
								</span>
								<RateHit t={t} />
							</li>
						))}
					</ol>
				</Section>
			))}
			{err ? (
				<p class="notice notice--error" role="alert">
					Verlauf nicht geladen: {err}
				</p>
			) : null}
			{items && items.length > 0 && more ? (
				<button type="button" class="key key--wide" disabled={loading} onClick={loadMore}>
					{loading ? "Lädt …" : "Ältere laden"}
				</button>
			) : null}
		</div>
	);
}

// ------------------------------------------------------------------ Geräte

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

export function DevicesScreen() {
	const [devices, setDevices] = useState<DeviceView[] | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [native, setNative] = useState<{ configured: boolean; devices: NativeDevice[] } | null>(
		null,
	);
	const [nativeErr, setNativeErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const request = useRef(0);
	const [chosen, setChosen] = useState<string | null>(() => {
		try {
			return localStorage.getItem("ts-device");
		} catch {
			return null;
		}
	});
	const load = () => {
		const n = ++request.current;
		setErr(null);
		setNativeErr(null);
		setLoading(true);
		void Promise.allSettled([
			api
				.devices()
				.then((list) => n === request.current && setDevices(list))
				.catch((e: Error) => n === request.current && setErr(e.message)),
			api
				.nativeDevices()
				.then((r) => n === request.current && setNative(r))
				.catch((e: Error) => n === request.current && setNativeErr(e.message)),
		]).finally(() => n === request.current && setLoading(false));
	};
	useEffect(() => {
		load();
		return () => {
			request.current++;
		};
	}, []);
	const choose = (id: string | null, name?: string) => {
		setChosen(id);
		try {
			if (id) localStorage.setItem("ts-device", id);
			else localStorage.removeItem("ts-device");
			if (name) localStorage.setItem("ts-device-name", name);
			else localStorage.removeItem("ts-device-name");
		} catch {
			/* private mode: kept for this page only */
		}
	};
	const nativeList = native?.devices ?? [];
	const known =
		!chosen ||
		devices === null ||
		devices?.some((d) => d.id === chosen) ||
		nativeList.some((d) => `native:${d.id}` === chosen);
	const anyActive = devices?.some((d) => d.active) ?? false;
	return (
		<div class="page">
			<PageBar title="Geräte" sub="Wo deine Musik spielt" backTo="/mehr" />
			<p class="lede">
				true-shuffle spielt nicht selbst. Es sagt Spotify oder Home Assistant, wo deine Musik laufen
				soll. Was du hier wählst, gilt auf diesem Gerät für Starten und Fortsetzen.
			</p>

			<Section title="Spotify-Geräte" id="dev-spotify">
				<p class="section__lead">
					Alles, was die Spotify-App unter „Geräte“ zeigt: Handy, Computer, Lautsprecher, Auto. Ein
					Gerät erscheint nur, solange Spotify darauf offen ist.
				</p>
				{devices && !anyActive ? (
					<p class="notice notice--warn">
						{devices.length === 0
							? "Gerade ist kein Spotify-Gerät sichtbar. Öffne Spotify auf dem Gerät, auf dem du hören willst, und tippe dann auf „Geräte aktualisieren“."
							: "Kein Gerät aktiv. Starte true-shuffle mit einem Gerät aus der Liste, oder spiel kurz etwas in Spotify an."}
					</p>
				) : null}
				{err ? (
					<p class="notice notice--error" role="alert">
						Spotify-Geräte nicht geladen: {err}
					</p>
				) : null}
				<ul class="list">
					<li>
						<label class="row mehr-choice">
							<input type="radio" name="dev" checked={!chosen} onChange={() => choose(null)} />
							<span class="row__main">
								<span class="row__title">Automatisch</span>
								<span class="row__sub">Das gerade aktive Gerät, sonst dein Handy</span>
							</span>
						</label>
					</li>
					{!known ? (
						<li class="row">
							<span class="row__main">
								<span class="row__title">
									{chosen === "spotify"
										? "Spotify · aktives Gerät"
										: chosen?.startsWith("native:")
											? "Gespeichertes Home-Assistant-Gerät"
											: "Gespeichertes Spotify-Gerät"}
								</span>
								<span class="row__sub">
									Bleibt ausgewählt.{" "}
									{chosen === "spotify"
										? "Spotify nimmt das gerade aktive Gerät."
										: "Zurzeit nicht sichtbar."}
								</span>
							</span>
						</li>
					) : null}
					{(devices ?? []).map((d) => (
						<li key={d.id}>
							<label class="row mehr-choice" aria-disabled={d.restricted}>
								<input
									type="radio"
									name="dev"
									disabled={d.restricted}
									checked={chosen === d.id}
									onChange={() => choose(d.id, d.name)}
								/>
								<span class="row__main">
									<span class="row__title">{d.name}</span>
									<span class="row__sub">
										{deviceType(d.type)}
										{d.active ? `${SEP}gerade aktiv` : ""}
										{d.restricted ? `${SEP}nimmt keine Befehle an` : ""}
									</span>
								</span>
							</label>
						</li>
					))}
				</ul>
			</Section>

			<Section title="Home Assistant" id="dev-home">
				<p class="section__lead">
					Lautsprecher, die Home Assistant oder Music Assistant steuert, auch wenn Spotify sie nicht
					kennt. true-shuffle schickt ihnen deine Songs direkt. Music-Assistant-Lautsprecher mit
					Spotify Connect stehen oben bei den Spotify-Geräten.
				</p>
				{nativeErr ? (
					<p class="notice notice--error">Home Assistant nicht erreichbar: {nativeErr}</p>
				) : native && !native.configured ? (
					<p class="empty-state">
						Für dein Konto ist keine Verbindung zu Home Assistant eingerichtet. Das richtet der
						Betreiber von true-shuffle auf dem Server ein.
					</p>
				) : native && nativeList.length === 0 ? (
					<p class="empty-state">Home Assistant meldet gerade keinen Lautsprecher.</p>
				) : null}
				{nativeList.length ? (
					<ul class="list">
						{nativeList.map((d) => (
							<li key={d.id}>
								<label class="row mehr-choice">
									<input
										type="radio"
										name="dev"
										checked={chosen === `native:${d.id}`}
										onChange={() => choose(`native:${d.id}`, d.name)}
									/>
									<span class="row__main">
										<span class="row__title">{d.name}</span>
										<span class="row__sub">
											{d.queue
												? "Spielt deine Warteschlange der Reihe nach."
												: "Spielt nur einen Song und schaltet nicht selbst weiter."}{" "}
											{d.seek
												? "Setzt an der gespeicherten Stelle ein."
												: "Beginnt den Song von vorn."}
										</span>
									</span>
								</label>
							</li>
						))}
					</ul>
				) : null}
			</Section>

			<button type="button" class="key key--wide" disabled={loading} onClick={load}>
				{loading ? "Sucht Geräte …" : "Geräte aktualisieren"}
			</button>
		</div>
	);
}

// -------------------------------------------------------------------- Info

export function AboutScreen() {
	return (
		<div class="page mehr-info">
			<PageBar title="Über true-shuffle" sub="Shuffle mit Gedächtnis" backTo="/mehr" />
			<ul class="promise-list mehr-promise">
				<li>
					<strong>Jeder Song kommt dran.</strong> Erst wenn du alle Songs eines Senders gehört hast,
					beginnt er von vorn.
				</li>
				<li>
					<strong>Keine schnellen Wiederholungen.</strong> Was du gehört hast, kommt eine Weile
					nicht wieder. Favoriten öfter, aber höchstens einmal pro Woche.
				</li>
				<li>
					<strong>Deine Stelle bleibt.</strong> Fortsetzen spielt genau dort weiter, auch nach
					Pausen, anderem Hören in Spotify oder einem Gerätewechsel.
				</li>
				<li>
					<strong>Neues dazwischen.</strong> Songs, die du noch nicht kennst, mischt es nach deinem
					Geschmack dazu.
				</li>
			</ul>

			<Section title="Wie es funktioniert" id="info-how">
				<p>
					Jeder Sender ist eine private Playlist „{DECK_PREFIX}…“ in deinem Spotify, wie eine
					Kassette mit fester Reihenfolge. Spotify spielt sie ab, auf jedem Gerät, auch wenn du sie
					direkt in Spotify startest. Nur „neu mischen“ ändert die Reihenfolge.
				</p>
				<p>
					Alle paar Minuten liest true-shuffle, was du gehört hast. Jeder Song ab 30 Sekunden zählt,
					egal wo er lief. Was du früh überspringst, kommt später und seltener wieder.
				</p>
			</Section>

			<Section title="Was Spotify nicht zulässt" id="info-limits">
				<ul class="list">
					<li class="row">
						<span class="row__main">
							<span class="row__title">Nur mit Premium</span>
							<span class="row__sub">
								Starten und Weiterschalten aus der App geht nur mit Spotify Premium.
							</span>
						</span>
					</li>
					<li class="row">
						<span class="row__main">
							<span class="row__title">Autoplay</span>
							<span class="row__sub">
								Am Ende einer Playlist spielt Spotify eigene Empfehlungen, wenn true-shuffle sie
								gerade nicht verlängern konnte. Deine Stelle bleibt gespeichert.
							</span>
						</span>
					</li>
					<li class="row">
						<span class="row__main">
							<span class="row__title">Smart Shuffle</span>
							<span class="row__sub">
								Lässt sich von außen nicht abschalten und mischt fremde Songs dazu. true-shuffle
								sagt dir, wenn es an ist.
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

			<Section title="Woher Neues kommt" id="info-sources">
				<p>
					Weitere Songs deiner Künstler und ihre Neuerscheinungen, ähnliche Künstler (Last.fm,
					Deezer), die Genre-Suche von Spotify und KI-Vorschläge. Jeder Vorschlag wird bei Spotify
					geprüft, bevor er in einen Sender darf.
				</p>
			</Section>
		</div>
	);
}

// ------------------------------------------------------------------ Import

/** What an import changes, counted from the rows that would be (or were) uploaded. */
interface Effects {
	tracks: number;
	plays: number;
	favorites: number;
	rarer: number;
	barely: number;
	longAgo: number;
	files: number;
	from: number | null;
	to: number | null;
}

const LONG_AGO_MS = 180 * DAY_MS;

function effectsOf(
	rows: readonly HistoryRow[],
	agg: { counted: number; firstAt: number | null; lastAt: number | null },
	files: number,
): Effects {
	const now = Date.now();
	let favorites = 0;
	let rarer = 0;
	let barely = 0;
	let longAgo = 0;
	for (const [, plays, skips, last] of rows) {
		// Same rule as the planner's favourite (core/memory isFavorite), from the history alone.
		if (plays >= FAMILIAR_PLAYS && skips <= plays * 0.2) favorites++;
		if (skips >= RARE_AFTER_EARLY_SKIPS) barely++;
		else if (skips > 0) rarer++;
		if (plays > 0 && last > 0 && now - last >= LONG_AGO_MS) longAgo++;
	}
	return {
		tracks: rows.length,
		plays: agg.counted,
		favorites,
		rarer,
		barely,
		longAgo,
		files,
		from: agg.firstAt,
		to: agg.lastAt,
	};
}

function songs(n: number): string {
	return n === 1 ? "1 Song" : `${num(n)} Songs`;
}

function EffectList({ e, done }: { e: Effects; done: boolean }) {
	return (
		<div class="import-result">
			<p class="import-result__lead">
				{done
					? `${songs(e.tracks)} kennt true-shuffle jetzt aus deinem Verlauf.`
					: `${songs(e.tracks)} kennt true-shuffle danach aus deinem Verlauf.`}
			</p>
			<p class="hint">
				{num(e.plays)} Mal gehört
				{e.from && e.to ? `, ${date(e.from)} bis ${date(e.to)}` : ""}
				{SEP}aus {e.files} {e.files === 1 ? "Datei" : "Dateien"}
			</p>
			<ul class="effects">
				<li>
					<strong>Favoriten kommen öfter.</strong> {songs(e.favorites)} hast du mindestens{" "}
					{FAMILIAR_PLAYS}-mal gehört und selten früh übersprungen. Sie gelten als Favoriten und
					kommen öfter, aber höchstens einmal pro Woche.
				</li>
				<li>
					<strong>Früh Übersprungenes kommt seltener.</strong> {songs(e.rarer)} hast du ein- oder
					zweimal in den ersten 30 Sekunden weitergeschaltet: Sie kommen seltener. {songs(e.barely)}{" "}
					hast du dreimal oder öfter früh übersprungen: Sie kommen kaum noch.
				</li>
				<li>
					<strong>Lange nicht Gehörtes kommt eher.</strong> {songs(e.longAgo)} hast du seit über
					einem halben Jahr nicht gehört. Sie kommen eher dran als Songs, die du gerade erst gehört
					hast.
				</li>
				<li>
					<strong>Neues bleibt neu.</strong> Was nicht in deinem Verlauf steht, gilt weiter als
					„noch nie gehört“.
				</li>
			</ul>
			<p class="hint">
				Seltener und kaum noch gilt mit der Voreinstellung „Nicht jetzt, später seltener“. Wie oft
				Favoriten kommen dürfen und was ein früher Skip bewirkt, stellst du pro Sender ein.
			</p>
		</div>
	);
}

export function ImportScreen({ state }: { state: AppState }) {
	const [phase, setPhase] = useState<"idle" | "reading" | "ready" | "upload" | "done">("idle");
	const [effects, setEffects] = useState<Effects | null>(null);
	const [rows, setRows] = useState<HistoryRow[]>([]);
	const [err, setErr] = useState<string | null>(null);
	const [sent, setSent] = useState(0);
	const hist = state.history;

	const read = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setErr(null);
		setEffects(null);
		setPhase("reading");
		const agg = emptyAggregate();
		let used = 0;
		let problem: string | null = null;
		for (const f of Array.from(files)) {
			try {
				const data = JSON.parse(await f.text()) as unknown;
				const kind = detectHistoryFile(data);
				if (kind === "account") {
					problem = `„${f.name}“ ist der einfache Datenexport ohne Song-Kennungen. Fordere den erweiterten Streamingverlauf an (Dateien „Streaming_History_Audio_…“).`;
					continue;
				}
				if (kind !== "extended") continue;
				// What came after the first sign-in, true-shuffle already counted live.
				aggregateHistory(data as ExtendedEntry[], agg, { before: hist.liveSince });
				used++;
			} catch {
				problem = `„${f.name}“ konnte nicht gelesen werden.`;
			}
		}
		const r = toRows(agg);
		setRows(r);
		if (r.length > 0) {
			setEffects(effectsOf(r, agg, used));
			setPhase("ready");
		} else {
			setErr(
				problem ??
					"In diesen Dateien steht kein Song, den true-shuffle übernehmen kann. Wähle die Dateien „Streaming_History_Audio_…json“.",
			);
			setPhase("idle");
		}
		if (problem && r.length > 0) setErr(problem);
	};

	const upload = async () => {
		setPhase("upload");
		setErr(null);
		setSent(0);
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

	const picking = phase === "idle" || phase === "reading" || phase === "ready";

	return (
		<div class="page">
			<PageBar
				title="Hörverlauf importieren"
				sub="Damit true-shuffle vom ersten Tag an weiß, was du kennst, liebst und überspringst."
				backTo="/mehr"
			/>

			{hist.importedTracks > 0 && phase !== "done" ? (
				<p class="notice">
					Eingerechnet sind {songs(hist.importedTracks)} aus deinem Spotify-Verlauf
					{hist.importedAt ? `, importiert am ${date(hist.importedAt)}` : ""}. Ein neuer Import
					ersetzt diesen.
				</p>
			) : null}

			{phase === "done" && effects ? (
				<section class="section import-done" aria-labelledby="import-done-title" role="status">
					<h2 id="import-done-title">Übernommen. Das ist jetzt anders:</h2>
					<EffectList e={effects} done />
					<p>
						Sender ohne gespeicherte Warteschlange planen ab sofort damit. Eine gespeicherte
						Warteschlange behält ihre Reihenfolge, bis du sie neu mischst.
					</p>
					<a class="key key--lit key--wide" href="/">
						Zu Jetzt
					</a>
				</section>
			) : (
				<ol class="steps">
					<li class="step">
						<h2 class="step__title">Verlauf bei Spotify anfordern</h2>
						<p>
							Auf spotify.com unter Konto → Datenschutz den „erweiterten Streamingverlauf“
							anfordern. Spotify schickt dir die Dateien per Mail, das kann bis zu 30 Tage dauern.
						</p>
					</li>
					<li class="step">
						<h2 class="step__title">Dateien auswählen</h2>
						<p>
							Alle Dateien „Streaming_History_Audio_…json“ auf einmal. Sie werden hier im Browser
							gelesen. Zu true-shuffle geht nur, wie oft du welchen Song gehört oder früh
							übersprungen hast und wann zuletzt.
						</p>
						{picking ? (
							<label class={`key file-key${phase === "ready" ? "" : " key--lit"}`}>
								<input
									class="file-key__input"
									type="file"
									accept="application/json,.json"
									multiple
									disabled={phase === "reading"}
									onChange={(e) => void read(e.currentTarget.files)}
								/>
								{phase === "reading"
									? "Wird gelesen …"
									: phase === "ready"
										? "Andere Dateien wählen"
										: "Dateien auswählen"}
							</label>
						) : null}
						{hist.liveSince ? (
							<p class="hint">
								Gezählt wird nur, was vor deiner ersten Anmeldung am {date(hist.liveSince)} lief.
								Danach hat true-shuffle selbst mitgezählt, nichts zählt doppelt.
							</p>
						) : null}
					</li>
					<li class="step">
						<h2 class="step__title">Prüfen und übernehmen</h2>
						{effects && (phase === "ready" || phase === "upload") ? (
							<>
								<EffectList e={effects} done={false} />
								{phase === "upload" ? (
									<div class="import-progress">
										<progress max={Math.max(1, rows.length)} value={sent} aria-label="Übernahme" />
										<p class="hint" role="status">
											Wird übernommen: {num(sent)} von {num(rows.length)} Songs
										</p>
									</div>
								) : (
									<button
										type="button"
										class="key key--lit key--wide"
										onClick={() => void upload()}
									>
										Ins Gedächtnis übernehmen
									</button>
								)}
							</>
						) : (
							<p class="muted">
								Hier steht dann, was sich durch deinen Verlauf ändert, bevor du ihn übernimmst.
							</p>
						)}
					</li>
				</ol>
			)}
			{err ? (
				<p class="notice notice--error" role="alert">
					{err}
				</p>
			) : null}
		</div>
	);
}
