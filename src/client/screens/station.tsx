import { ArrowLeft, ChevronDown, ExternalLink, Minus, Play, Plus } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { type MixShares, PRESETS, sharesForRules } from "../../core/mix";
import type { StationRules } from "../../core/types";
import type {
	AppState,
	PlaylistView,
	StationDetail,
	StationSource,
	StationSummary,
} from "../../shared/api";
import { api } from "../api";
import { Cassette, shellOf } from "../components/cassette";
import { RateHit, ThumbMark } from "../components/rate";
import { factsOf, SongTags } from "../components/song-tags";
import { Cover, MixFine, MixScale, PageBar, Section } from "../components/ui";
import { ago, DECK_PREFIX, num, pct } from "../format";
import { back, navigate } from "../router";
import { store } from "../store";
import { playStation } from "./home";

/** What a mix value gives, in one line for screen readers. */
function sharesWords(rules: StationRules, mix: number): string {
	const s = sharesForRules({ ...rules, mix });
	return `${pct(s.fresh)} ungehört, ${pct(s.favorite)} Favoriten, ${pct(s.discovery)} Entdeckungen`;
}

/**
 * The favourite share as a slider: "like the mix" or a fixed share from 0 to
 * 100 %. Every step is saved, one after another so the last one chosen is the
 * one kept; the page shows the chosen value until the saved one comes back.
 */
function FavShare(props: {
	value: number | null;
	/** Saves; resolves true when the server took it. */
	onChange: (v: number | null) => Promise<boolean>;
	children?: ComponentChildren;
}) {
	const [pending, setPending] = useState<number | null>(null);
	const queue = useRef<Promise<unknown>>(Promise.resolve());
	const latest = useRef(0);
	const saved = props.value === null ? null : Math.round(props.value * 100);
	useEffect(() => {
		if (pending !== null && saved === pending) setPending(null);
	}, [saved, pending]);
	const auto = props.value === null;
	const shown = pending ?? saved ?? 10;
	const choose = (v: number | null) => {
		const n = ++latest.current;
		if (v !== null) setPending(Math.round(v * 100));
		queue.current = queue.current.then(async () => {
			const ok = await props.onChange(v);
			// Refused: the page goes back to what the station has.
			if (!ok && n === latest.current) setPending(null);
		});
	};
	return (
		<div class="rule">
			<span class="rule__label" id="r-share-l">
				Anteil Favoriten
			</span>
			<label class="check">
				<input
					type="checkbox"
					checked={auto}
					onChange={(e) => choose(e.currentTarget.checked ? null : Math.round(shown / 5) * 0.05)}
				/>
				Wie die Mischung
			</label>
			{auto ? null : (
				<div class="fine">
					<label class="fine__label" for="r-share">
						Fester Anteil <span class="fine__value">{shown} %</span>
					</label>
					<input
						id="r-share"
						class="fine__range"
						type="range"
						min={0}
						max={100}
						step={1}
						value={shown}
						aria-valuetext={`${shown} Prozent Favoriten`}
						onInput={(e) => setPending(Number(e.currentTarget.value))}
						onChange={(e) => choose(Number(e.currentTarget.value) / 100)}
					/>
				</div>
			)}
			{props.children}
		</div>
	);
}

const SKIP_RULES = [
	[
		"later_less",
		"Später nochmal, dann seltener",
		"Der Song kommt in diesem Durchgang noch einmal, aber seltener. Nach drei frühen Sprüngen kommt er kaum noch. Nach einer Weile fragt true-shuffle nach: Hörst du ihn dann, zählen die Sprünge nicht mehr. Hast du ihn vorher oft ganz gehört, ruht er nur eine Weile: Er kam wohl zu oft, nicht ungern.",
	],
	[
		"consume",
		"Zählt als gehört",
		"Der Song ist für diesen Durchgang erledigt. Was du magst, ändert sich dadurch nicht.",
	],
	[
		"ban",
		"Nie wieder auf dieser Kassette",
		"Der Song kommt hier nicht mehr, sobald true-shuffle den Sprung sieht. Rückgängig: Daumen hoch, auch später im Verlauf.",
	],
] as const;

/** Rounds shares to whole songs out of ten that still add up to ten. */
export function outOfTen(s: MixShares): { fresh: number; favorite: number; discovery: number } {
	const keys = ["fresh", "favorite", "discovery"] as const;
	const raw = keys.map((k) => s[k] * 10);
	const out = raw.map(Math.floor);
	let left = 10 - out.reduce((a, b) => a + b, 0);
	const order = raw.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0]);
	for (const [, i] of order) {
		if (left <= 0) break;
		out[i] = (out[i] ?? 0) + 1;
		left--;
	}
	return { fresh: out[0] ?? 0, favorite: out[1] ?? 0, discovery: out[2] ?? 0 };
}

function joinWords(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	return `${parts.slice(0, -1).join(", ")} und ${parts[parts.length - 1]}`;
}

/**
 * The mix in plain words and as a bar. Every number comes from
 * `sharesForRules`, so the readout is exactly what the planner uses.
 */
export function MixExplained({ rules, mix }: { rules: StationRules; mix: number }) {
	const shares = sharesForRules({ ...rules, mix });
	const ten = outOfTen(shares);
	const parts: string[] = [];
	if (ten.fresh > 0)
		parts.push(
			ten.fresh === 1
				? "1 Song aus deinen Playlists, der in diesem Durchgang noch nicht dran war"
				: `${ten.fresh} Songs aus deinen Playlists, die in diesem Durchgang noch nicht dran waren`,
		);
	if (ten.favorite > 0)
		parts.push(`${ten.favorite} ${ten.favorite === 1 ? "Favorit" : "Favoriten"}`);
	if (ten.discovery > 0)
		parts.push(
			`${ten.discovery} neue ${ten.discovery === 1 ? "Song, der" : "Songs, die"} nicht in deinen Playlists ${ten.discovery === 1 ? "steht" : "stehen"}`,
		);
	const rare: string[] = [];
	if (ten.favorite === 0 && shares.favorite > 0) rare.push("ein Favorit");
	if (ten.discovery === 0 && shares.discovery > 0) rare.push("ein neuer Song");
	const custom = rules.favoriteShare !== null || !rules.discoveryEnabled;
	return (
		<div class="mixread">
			<p class="mixread__words" aria-live="polite">
				Von 10 Songs sind ungefähr {joinWords(parts)}.
				{rare.length ? ` Nur selten kommt ${joinWords(rare).replace(" und ", " oder ")}.` : ""}
			</p>
			<span class="mixbar" aria-hidden="true">
				{shares.fresh > 0 ? (
					<span class="mixbar__fresh" style={{ flexGrow: shares.fresh }} />
				) : null}
				{shares.favorite > 0 ? (
					<span class="mixbar__fav" style={{ flexGrow: shares.favorite }} />
				) : null}
				{shares.discovery > 0 ? (
					<span class="mixbar__disc" style={{ flexGrow: shares.discovery }} />
				) : null}
			</span>
			<p class="mixlegend">
				<span class="mixlegend__item mixlegend__item--fresh">{pct(shares.fresh)} ungehört</span>
				<span class="mixlegend__item mixlegend__item--fav">{pct(shares.favorite)} Favoriten</span>
				<span class="mixlegend__item mixlegend__item--disc">
					{pct(shares.discovery)} Entdeckungen
				</span>
			</p>
			{custom ? (
				<p class="hint">Deine Regeln unter „Erweitert“ sind hier schon eingerechnet.</p>
			) : null}
		</div>
	);
}

function Stepper(props: {
	label: string;
	value: number;
	min: number;
	max: number;
	unit: (n: number) => string;
	onChange: (n: number) => void;
}) {
	return (
		<div class="stepper">
			<button
				type="button"
				class="key"
				aria-label={`${props.label}: weniger`}
				disabled={props.value <= props.min}
				onClick={() => props.onChange(Math.max(props.min, props.value - 1))}
			>
				<Minus size={20} aria-hidden="true" />
			</button>
			<output class="stepper__value" aria-live="polite">
				{props.unit(props.value)}
			</output>
			<button
				type="button"
				class="key"
				aria-label={`${props.label}: mehr`}
				disabled={props.value >= props.max}
				onClick={() => props.onChange(Math.min(props.max, props.value + 1))}
			>
				<Plus size={20} aria-hidden="true" />
			</button>
		</div>
	);
}

const sameSource = (a: StationSource, b: StationSource) =>
	a.type === b.type && (a.type === "liked" || (b.type === "playlist" && a.id === b.id));

/** Tick the playlists (and/or Lieblingssongs) a cassette plays from. */
export function SourcePicker(props: {
	value: StationSource[];
	onChange: (v: StationSource[]) => void;
}) {
	const [lists, setLists] = useState<PlaylistView[] | null>(null);
	useEffect(() => {
		api
			.playlists()
			.then(setLists)
			.catch(() => setLists([]));
	}, []);
	const has = (s: StationSource) => props.value.some((v) => sameSource(v, s));
	const toggle = (s: StationSource) =>
		props.onChange(has(s) ? props.value.filter((v) => !sameSource(v, s)) : [...props.value, s]);
	if (!lists) return <div class="skeleton" style={{ height: "168px" }} />;
	return (
		<ul class="list picklist">
			<li>
				<label class="row">
					<input
						type="checkbox"
						checked={has({ type: "liked" })}
						onChange={() => toggle({ type: "liked" })}
					/>
					<span class="row__main">
						<span class="row__title">Lieblingssongs</span>
						<span class="row__sub">Alle Songs, die du in Spotify mit Herz gespeichert hast</span>
					</span>
				</label>
			</li>
			{lists.map((p) => (
				<li key={p.id}>
					<label class="row" aria-disabled={!p.readable}>
						<input
							type="checkbox"
							disabled={!p.readable}
							checked={has({ type: "playlist", id: p.id })}
							onChange={() => toggle({ type: "playlist", id: p.id })}
						/>
						<span class="row__main">
							<span class="row__title">{p.name}</span>
							<span class="row__sub">
								{p.readable
									? p.total !== null
										? `${num(p.total)} Songs`
										: "Playlist"
									: `von ${p.ownerName ?? "jemand anderem"} — Spotify gibt die Songs nicht heraus`}
							</span>
						</span>
					</label>
				</li>
			))}
		</ul>
	);
}

/** One song in a list on this page: its title wraps, never cut off. */
function SongRow(props: {
	t:
		| StationDetail["upcoming"][number]
		| StationDetail["recent"][number]
		| NonNullable<AppState["nowPlaying"]>;
	lead: string;
	kind?: StationDetail["upcoming"][number]["kind"] | null;
	facts?: ReturnType<typeof factsOf>;
}) {
	const { t } = props;
	return (
		<li class="songrow track--rate">
			<span class="songrow__lead" aria-hidden="true">
				{props.lead}
			</span>
			<Cover src={t.imageUrl} class="songrow__cover" />
			<span class="songrow__main">
				<strong class="songrow__title">{t.name}</strong>
				<span class="songrow__artist">{t.artists}</span>
				<SongTags
					kind={props.kind ?? null}
					facts={props.facts ?? null}
					thumb={store.thumbOf(t)}
					known={store.load.kind === "ready" && store.load.state.history.importedTracks > 0}
					class="tags--row"
				/>
			</span>
			<ThumbMark t={t} />
			<RateHit t={t} />
		</li>
	);
}

function sourceWords(sources: StationSource[]): string {
	const lists = sources.filter((s) => s.type === "playlist").length;
	const liked = sources.some((s) => s.type === "liked");
	const parts: string[] = [];
	if (lists > 0) parts.push(`${lists} ${lists === 1 ? "Playlist" : "Playlists"}`);
	if (liked) parts.push("deine Lieblingssongs");
	return parts.length ? `Spielt aus ${joinWords(parts)}.` : "Noch keine Playlist gewählt.";
}

export function Station({
	id,
	state,
	embedded,
}: {
	id: number;
	state: AppState;
	embedded?: boolean;
}) {
	const [d, setD] = useState<StationDetail | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [mix, setMix] = useState<number | null>(null);
	const [name, setName] = useState("");
	const [confirm, setConfirm] = useState(false);
	const [editSources, setEditSources] = useState<StationSource[] | null>(null);
	const [names, setNames] = useState<Map<string, PlaylistView> | null>(null);
	const [shown, setShown] = useState(6);
	const saveTimer = useRef<number | null>(null);
	const flushMix = useRef(() => {});

	// Only the newest answer is shown: an older one may come back last.
	const loadSeq = useRef(0);
	const load = () => {
		const started = Date.now();
		const seq = ++loadSeq.current;
		return api
			.station(id)
			.then((x) => {
				if (seq !== loadSeq.current) return;
				store.settleThumbs([...x.upcoming, ...x.recent], started);
				setD(x);
				setName((current) => current || x.name);
			})
			.catch((e: Error) => setErr(e.message));
	};

	useEffect(() => {
		setD(null);
		setMix(null);
		setName("");
		void load();
		const t = window.setInterval(() => {
			if (document.visibilityState === "visible") void load();
		}, 15_000);
		// Leaving before the mix was saved: save it now, not never.
		const onHide = () => flushMix.current();
		window.addEventListener("pagehide", onHide);
		return () => {
			window.clearInterval(t);
			window.removeEventListener("pagehide", onHide);
			flushMix.current();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id]);

	// Playlist names for the sources list; only read when this cassette has playlists.
	const hasPlaylists = !!d?.sources.some((s) => s.type === "playlist");
	useEffect(() => {
		if (!hasPlaylists || names) return;
		api
			.playlists()
			.then((l) => setNames(new Map(l.map((p) => [p.id, p]))))
			.catch(() => setNames(new Map()));
	}, [hasPlaylists, names]);

	const patch = (p: Parameters<typeof api.updateStation>[1], said?: string) =>
		api
			.updateStation(id, p)
			.then(() => {
				store.say(
					said ?? "Gespeichert. Gilt, sobald du die Kassette das nächste Mal startest.",
					"info",
					4000,
				);
				void load();
				void store.refresh(false);
			})
			.catch((e: Error) => store.say(e.message, "error"));

	// While the listener chooses, the page shows the chosen mix; once saved, it
	// follows the station again.
	const pendingMix = useRef<number | null>(null);
	const saveMix = (v: number) => {
		pendingMix.current = null;
		saveTimer.current = null;
		api
			.updateStation(id, { rules: { mix: v } })
			.then(() => store.refresh(false))
			.then(() => {
				if (pendingMix.current === null) setMix(null);
				void load();
			})
			.catch((e: Error) => {
				// Not saved: back to what the station really has.
				if (pendingMix.current === null) setMix(null);
				store.say(`Mischung nicht gespeichert: ${e.message}`, "error");
				void store.refresh(false);
			});
	};
	flushMix.current = () => {
		if (saveTimer.current === null || pendingMix.current === null) return;
		window.clearTimeout(saveTimer.current);
		saveMix(pendingMix.current);
	};
	const onMix = (v: number) => {
		setMix(v);
		pendingMix.current = v;
		if (saveTimer.current) window.clearTimeout(saveTimer.current);
		saveTimer.current = window.setTimeout(() => saveMix(v), 700);
	};

	const setRule = (r: Partial<StationRules>) => void patch({ rules: r });

	if (err && !d) {
		return (
			<div class="page">
				<PageBar title="Kassette" backTo="/sender" />
				<p class="notice notice--error" role="alert">
					{err}
				</p>
				<a class="key" href="/sender">
					Zu deinen Kassetten
				</a>
			</div>
		);
	}
	if (!d) {
		return (
			<div class="page" aria-busy="true">
				<PageBar title="Kassette" backTo="/sender" />
				<div class="skeleton" style={{ height: "200px" }} />
				<div class="skeleton" style={{ height: "160px" }} />
			</div>
		);
	}

	const summary: StationSummary = state.stations.find((s) => s.id === id) ?? d;
	const np = state.nowPlaying;
	const session = state.session;
	const here = np && np.stationId === id ? np : null;
	const playingHere = !!here?.isPlaying;
	const heard =
		d.poolSize !== null && d.freshRemaining !== null ? d.poolSize - d.freshRemaining : null;
	const rules = d.rules;
	const value = mix ?? summary.rules.mix;
	const preset = (Object.values(PRESETS) as number[]).includes(value);
	const live = sharesForRules({ ...rules, mix: value });
	const favTen = outOfTen(live).favorite;
	const discTen = outOfTen(live).discovery;
	const upcoming = d.upcoming.slice(0, shown);

	return (
		<div class="page deck-page">
			<header class="masthead deck-hero">
				{embedded ? null : <BackKey />}
				<div class="deck-hero__tape">
					<Cassette
						name={d.name}
						shell={shellOf(summary)}
						heard={summary.progress}
						reels={playingHere ? "running" : "still"}
					/>
				</div>
				<div class="deck-hero__text">
					<h1 class="masthead__title">{d.name}</h1>
					<p class="masthead__sub">
						{d.kind === "all"
							? "Alle deine Kassetten und Lieblingssongs auf einer."
							: sourceWords(d.sources)}
					</p>
					<div class="deck-hero__acts">
						{playingHere && session?.stationId === id ? (
							<a class="key deck-hero__live" href="/">
								<span class="led led--running" aria-hidden="true" />
								Läuft · zum Walkman
							</a>
						) : (
							<button
								type="button"
								class="key key--lit"
								disabled={!summary.ready || !!store.tuning}
								onClick={() => void playStation(summary)}
							>
								<Play size={18} aria-hidden="true" />
								{session?.stationId === id ? "Fortsetzen" : "Abspielen"}
							</button>
						)}
						{d.playlistId ? (
							<a
								class="key"
								href={`https://open.spotify.com/playlist/${d.playlistId}`}
								target="_blank"
								rel="noopener"
							>
								<ExternalLink size={18} aria-hidden="true" />
								In Spotify öffnen
							</a>
						) : null}
					</div>
					{!summary.ready ? (
						<p class="hint">
							{summary.importing
								? "Die Songs werden gerade eingelesen. Danach kannst du abspielen."
								: "Die Kassette wird vorbereitet. Danach kannst du abspielen."}
						</p>
					) : session?.stationId === id && !playingHere ? (
						<p class="hint">Fortsetzen spielt genau an deiner gespeicherten Stelle weiter.</p>
					) : null}
				</div>
			</header>

			<Section title="So läuft diese Kassette" id="run" class="deck-run">
				<div class="pass">
					<p class="pass__count">
						{heard !== null && d.poolSize !== null
							? `${num(heard)} von ${num(d.poolSize)} Songs gehört`
							: "Zählt ab dem ersten Song"}
					</p>
					<span class="meter pass__meter" aria-hidden="true">
						<span style={{ width: `${Math.round((d.progress ?? 0) * 100)}%` }} />
					</span>
					<p class="pass__words">
						{d.freshRemaining !== null && d.freshRemaining > 0
							? `Noch ${num(d.freshRemaining)} ${d.freshRemaining === 1 ? "Song" : "Songs"}, dann ist der ${d.roundNo || 1}. Durchgang komplett. `
							: `Du hörst den ${d.roundNo || 1}. Durchgang. `}
						Ein Durchgang heißt: jeder Song dieser Kassette kommt einmal, erst danach beginnt sie
						von vorn.
						{d.roundNo > 1
							? ` Du hast sie schon ${d.roundNo - 1 === 1 ? "einmal" : `${num(d.roundNo - 1)}-mal`} komplett gehört.`
							: ""}
					</p>
				</div>

				{here ? (
					<section class="deck-sub" aria-labelledby="deck-now">
						<h3 id="deck-now">{here.isPlaying ? "Läuft gerade" : "Pausiert"}</h3>
						<ul class="songlist">
							<SongRow t={here} lead={here.isPlaying ? "▶" : "Ⅱ"} kind={here.kind} />
						</ul>
					</section>
				) : null}

				<section class="deck-sub" aria-labelledby="deck-next">
					<h3 id="deck-next">Als Nächstes</h3>
					{d.upcoming.length === 0 ? (
						<p class="hint">
							Noch keine Reihenfolge. Sie steht fest, sobald die Kassette eingelesen ist.
						</p>
					) : (
						<>
							<p class="hint deck-sub__lead">
								Diese Reihenfolge steht fest. Tippe einen Song an, um ihn zu bewerten.
							</p>
							<ol class="songlist">
								{upcoming.map((t, i) => (
									<SongRow key={t.id} t={t} lead={String(i + 1)} kind={t.kind} facts={factsOf(t)} />
								))}
							</ol>
							{d.upcoming.length > shown ? (
								<button
									type="button"
									class="key key--wide"
									onClick={() => setShown(d.upcoming.length)}
								>
									<ChevronDown size={18} aria-hidden="true" />
									{d.upcoming.length - shown} weitere Songs zeigen
								</button>
							) : null}
						</>
					)}
				</section>

				{d.recent.length > 0 ? (
					<section class="deck-sub" aria-labelledby="deck-recent">
						<h3 id="deck-recent">Zuletzt gehört</h3>
						<ul class="songlist songlist--recent">
							{d.recent.slice(0, 8).map((t) => (
								<SongRow key={`${t.id}-${t.playedAt}`} t={t} lead={ago(t.playedAt)} />
							))}
						</ul>
					</section>
				) : null}
			</Section>

			<Section title="Mischung" id="mix">
				<p class="section__lead">
					Wie viel Neues zwischen deinen Songs kommt. Gilt, sobald du die Kassette das nächste Mal
					startest.
				</p>
				<MixScale value={value} station={d.name} onChange={onMix} />
				<MixFine
					value={value}
					station={d.name}
					onChange={onMix}
					describe={(v) => sharesWords(rules, v)}
				/>
				{preset ? null : <p class="hint">Eigene Mischung zwischen den Stufen.</p>}
				<MixExplained rules={rules} mix={value} />
			</Section>

			{d.kind !== "all" ? (
				<Section title="Playlists auf dieser Kassette" id="src">
					{editSources ? (
						<div class="stack">
							<p class="section__lead">
								Hak an, woraus diese Kassette spielt. Was du schon gehört hast, bleibt gezählt.
							</p>
							<SourcePicker value={editSources} onChange={setEditSources} />
							<div class="row-actions">
								<button type="button" class="key" onClick={() => setEditSources(null)}>
									Abbrechen
								</button>
								<button
									type="button"
									class="key key--lit"
									disabled={editSources.length === 0}
									onClick={() => {
										void patch({ sources: editSources });
										setNames(null);
										setEditSources(null);
									}}
								>
									Übernehmen
								</button>
							</div>
						</div>
					) : (
						<>
							<ul class="list">
								{d.sources.map((s) => {
									const p = s.type === "playlist" ? names?.get(s.id) : null;
									return (
										<li key={s.type === "playlist" ? s.id : "liked"} class="row">
											<span class="row__main">
												<span class="row__title">
													{s.type === "liked"
														? "Lieblingssongs"
														: (p?.name ?? (names ? "Playlist nicht mehr da" : "Playlist"))}
												</span>
												<span class="row__sub">
													{s.type === "liked"
														? "Deine Herzen in Spotify"
														: p && p.total !== null
															? `${num(p.total)} Songs`
															: "Playlist aus Spotify"}
												</span>
											</span>
										</li>
									);
								})}
							</ul>
							<button type="button" class="key" onClick={() => setEditSources(d.sources)}>
								Playlists ändern
							</button>
						</>
					)}
				</Section>
			) : (
				<Section title="Playlists auf dieser Kassette" id="src">
					<p class="section__lead">
						„{d.name}“ nimmt automatisch alles zusammen: jede deiner Kassetten und deine
						Lieblingssongs. Neue Kassetten kommen von selbst dazu.
					</p>
				</Section>
			)}

			<Section title="Neue Entdeckungen" id="disc">
				<p class="section__lead">
					Songs, die nicht in deinen Playlists stehen: mehr von Künstlern, die du magst, ihre neuen
					Veröffentlichungen, Vorschläge von Last.fm und Deezer
					{state.aiSource === "off" ? "" : " und von einer KI"}. Jeder Vorschlag wird vorher bei
					Spotify geprüft.
				</p>
				{rules.discoveryEnabled ? null : (
					<p class="notice">
						Entdeckungen sind für diese Kassette ausgeschaltet. Einschalten kannst du sie unter
						„Erweitert“.
					</p>
				)}
				<ul class="tally">
					<li>
						<span class="tally__n">{num(d.discoveries.pending)}</span>
						<span>
							<strong>{d.discoveries.pending === 1 ? "kommt noch" : "kommen noch"}</strong>
							<span class="tally__sub">Geprüfte Vorschläge, die diese Kassette noch spielt.</span>
						</span>
					</li>
					<li>
						<span class="tally__n">{num(d.discoveries.kept)}</span>
						<span>
							<strong>{d.discoveries.kept === 1 ? "gefällt dir" : "gefallen dir"}</strong>
							<span class="tally__sub">
								Zweimal gehört oder Daumen hoch. Sie bleiben auf der Kassette und stehen in deiner
								Spotify-Playlist „{DECK_PREFIX}Entdeckungen“.
							</span>
						</span>
					</li>
					<li>
						<span class="tally__n">{num(d.discoveries.rejected)}</span>
						<span>
							<strong>aussortiert</strong>
							<span class="tally__sub">
								Früh übersprungen oder Daumen runter. Sie kommen nicht wieder.
							</span>
						</span>
					</li>
				</ul>
			</Section>

			<details class="fold">
				<summary>
					<span class="fold__title">Erweitert</span>
					<span class="fold__sub">Favoriten, Überspringen, Künstler-Abstand, Entdeckungen</span>
					<ChevronDown class="fold__chev" size={20} aria-hidden="true" />
				</summary>
				<div class="fold__body">
					<fieldset class="rule rule--set">
						<legend class="rule__label">Pause für Favoriten</legend>
						<Stepper
							label="Pause für Favoriten"
							value={rules.favoriteCooldownDays}
							min={1}
							max={60}
							unit={(n) => `${n} ${n === 1 ? "Tag" : "Tage"}`}
							onChange={(n) => setRule({ favoriteCooldownDays: n })}
						/>
						<p class="rule__then">
							Ein Favorit kommt frühestens nach {rules.favoriteCooldownDays}{" "}
							{rules.favoriteCooldownDays === 1 ? "Tag" : "Tagen"} wieder.
						</p>
					</fieldset>

					<FavShare
						value={rules.favoriteShare}
						onChange={(v) =>
							api
								.updateStation(id, { rules: { favoriteShare: v } })
								.then(() => {
									store.say(
										"Gespeichert. Gilt, sobald du die Kassette das nächste Mal startest.",
										"info",
										4000,
									);
									void load();
									void store.refresh(false);
									return true;
								})
								.catch((e: Error) => {
									store.say(`Nicht gespeichert: ${e.message}`, "error");
									void load();
									return false;
								})
						}
					>
						<p class="rule__then">
							{favTen === 0
								? "Favoriten kommen nur noch, wenn sie ohnehin dran sind."
								: `Ungefähr ${favTen} von 10 Songs ${favTen === 1 ? "ist ein Favorit" : "sind Favoriten"}${rules.favoriteShare === null ? ", so wie die Mischung es vorgibt" : ""}.`}
						</p>
					</FavShare>

					<fieldset class="rule rule--set">
						<legend class="rule__label">Wenn du einen Song früh überspringst</legend>
						<p class="rule__then">„Früh“ heißt: in den ersten 30 Sekunden. Was dann passiert:</p>
						{SKIP_RULES.map(([v, t, sub]) => (
							<label key={v} class="radio">
								<input
									type="radio"
									name="skip"
									checked={rules.skipPolicy === v}
									onChange={() => setRule({ skipPolicy: v })}
								/>
								<span>
									<strong>{t}</strong>
									<span class="radio__sub">{sub}</span>
								</span>
							</label>
						))}
					</fieldset>

					<fieldset class="rule rule--set">
						<legend class="rule__label">Abstand bei gleichen Künstlern</legend>
						<Stepper
							label="Abstand bei gleichen Künstlern"
							value={rules.artistSpacing}
							min={0}
							max={10}
							unit={(n) => (n === 0 ? "Kein Abstand" : `${n} ${n === 1 ? "Song" : "Songs"}`)}
							onChange={(n) => setRule({ artistSpacing: n })}
						/>
						<p class="rule__then">
							{rules.artistSpacing === 0
								? "Songs desselben Künstlers dürfen direkt hintereinander kommen."
								: `Zwischen zwei Songs desselben Künstlers liegen mindestens ${rules.artistSpacing} andere ${rules.artistSpacing === 1 ? "Song" : "Songs"}.`}
						</p>
					</fieldset>

					<div class="rule">
						<label class="rule__switch">
							<span class="rule__label">Neue Entdeckungen</span>
							<input
								type="checkbox"
								role="switch"
								class="switch"
								aria-checked={rules.discoveryEnabled}
								checked={rules.discoveryEnabled}
								onChange={(e) => setRule({ discoveryEnabled: e.currentTarget.checked })}
							/>
						</label>
						<p class="rule__then">
							{rules.discoveryEnabled
								? discTen === 0
									? "An: Ab und zu kommt ein neuer Song, der nicht in deinen Playlists steht."
									: `An: ungefähr ${discTen} von 10 Songs ${discTen === 1 ? "ist ein neuer Song, der" : "sind neue Songs, die"} nicht in deinen Playlists ${discTen === 1 ? "steht" : "stehen"}.`
								: "Aus: Es kommen nur Songs aus deinen Playlists."}
						</p>
					</div>
				</div>
			</details>

			<Section title="Name" id="name">
				<form
					class="rename"
					onSubmit={(e) => {
						e.preventDefault();
						const next = name.trim();
						if (next && next !== d.name) void patch({ name: next }, `Heißt jetzt „${next}“`);
					}}
				>
					<label class="field">
						<span class="field__label">Name der Kassette</span>
						<input
							class="input"
							value={name}
							maxLength={80}
							onInput={(e) => setName(e.currentTarget.value)}
						/>
					</label>
					<button type="submit" class="key" disabled={!name.trim() || name.trim() === d.name}>
						Umbenennen
					</button>
				</form>
				<p class="hint">
					In Spotify heißt die Playlist dazu „{DECK_PREFIX}
					{d.name}“.
				</p>
			</Section>

			<Section title="Kassette löschen" id="del">
				{confirm ? (
					<div class="notice notice--error" role="alert">
						<p>
							„{d.name}“ wirklich löschen? Die Spotify-Playlist „{DECK_PREFIX}
							{d.name}“ verschwindet. Was du gehört hast, bleibt gezählt.
						</p>
						<div class="row-actions">
							<button type="button" class="key" onClick={() => setConfirm(false)}>
								Behalten
							</button>
							<button
								type="button"
								class="key key--danger"
								onClick={() =>
									api
										.deleteStation(id)
										.then(() => {
											store.say(`„${d.name}“ gelöscht`, "info", 4000);
											void store.refresh(false);
											navigate("/sender", true);
										})
										.catch((e: Error) => store.say(e.message, "error"))
								}
							>
								Endgültig löschen
							</button>
						</div>
					</div>
				) : (
					<>
						<p class="section__lead">
							Die Kassette verschwindet. Was du gehört hast, bleibt gezählt und gilt auf allen
							anderen Kassetten weiter.
						</p>
						<button type="button" class="key key--danger" onClick={() => setConfirm(true)}>
							Kassette löschen …
						</button>
					</>
				)}
			</Section>
		</div>
	);
}

function BackKey() {
	return (
		<button type="button" class="back-key" onClick={() => back("/sender")}>
			<ArrowLeft size={18} aria-hidden="true" />
			Zurück
		</button>
	);
}

/** /sender/neu: a new cassette from playlists the listener ticks. */
export function NewStation() {
	const [name, setName] = useState("");
	const [sources, setSources] = useState<StationSource[]>([]);
	const [mix, setMix] = useState<number>(PRESETS.entdecker);
	const [busy, setBusy] = useState(false);
	const ready = !busy && sources.length > 0 && !!name.trim();
	return (
		<div class="page">
			<PageBar
				title="Neue Kassette"
				sub="Gib ihr einen Namen und hak an, woraus sie spielen soll. Die Songs kommen in fester Reihenfolge, jeder einmal."
				backTo="/sender"
			/>
			<label class="field">
				<span class="field__label">Name der Kassette</span>
				<input
					class="input"
					placeholder="z. B. Autofahrt"
					value={name}
					maxLength={80}
					onInput={(e) => setName(e.currentTarget.value)}
				/>
			</label>
			<Section title="Woraus sie spielt" id="ns-src">
				<SourcePicker value={sources} onChange={setSources} />
			</Section>
			<Section title="Mischung" id="ns-mix">
				<MixScale value={mix} station="neue Kassette" onChange={setMix} />
				<MixFine
					value={mix}
					station="neue Kassette"
					onChange={setMix}
					describe={(v) =>
						sharesWords(
							{
								mix: v,
								favoriteCooldownDays: 7,
								favoriteShare: null,
								skipPolicy: "later_less",
								discoveryEnabled: true,
								artistSpacing: 4,
							},
							v,
						)
					}
				/>
				<MixExplained
					rules={{
						mix,
						favoriteCooldownDays: 7,
						favoriteShare: null,
						skipPolicy: "later_less",
						discoveryEnabled: true,
						artistSpacing: 4,
					}}
					mix={mix}
				/>
				<p class="hint">Alles andere kannst du später unter „Einstellen“ ändern.</p>
			</Section>
			<div class="savebar">
				<button
					type="button"
					class="key key--lit key--wide"
					disabled={!ready}
					onClick={() => {
						setBusy(true);
						api
							.createStation({ name: name.trim(), sources, rules: { mix } })
							.then(() => {
								store.say(`„${name.trim()}“ wird eingerichtet`, "info", 4000);
								void store.refresh(false);
								navigate("/sender");
							})
							.catch((e: Error) => store.say(e.message, "error"))
							.finally(() => setBusy(false));
					}}
				>
					Kassette anlegen
				</button>
				{ready ? null : (
					<p class="hint savebar__why">
						{!name.trim()
							? "Gib der Kassette zuerst einen Namen."
							: "Hak mindestens eine Playlist oder deine Lieblingssongs an."}
					</p>
				)}
			</div>
		</div>
	);
}
