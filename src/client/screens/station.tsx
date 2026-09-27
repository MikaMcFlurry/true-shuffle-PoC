import { Minus, Plus } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { SlotKind, StationRules } from "../../core/types";
import type { AppState, PlaylistView, StationDetail, StationSource } from "../../shared/api";
import { api } from "../api";
import { Cover, Detents, MixScale, PageBar, Scale, Section, useWide } from "../components/radio";
import { RateHit, ThumbMark } from "../components/rate";
import { ago, DECK_PREFIX, num, pct } from "../format";
import { navigate } from "../router";
import { store, useStore } from "../store";
import { MixReadout, playStation, pointedStation } from "./home";

const KIND: Record<SlotKind, string> = {
	fresh: "Ungehört",
	favorite: "Favorit",
	discovery: "Entdeckung",
};

const FAV_SHARES = [
	["auto", "wie Mischung"],
	...[0, 0.05, 0.1, 0.15, 0.25, 0.35, 0.5].map((v) => [String(v), pct(v)] as const),
] as const;

/** Why a song is here, as a small printed mark. Favourites and discoveries are marked red. */
function Reason({ kind }: { kind: SlotKind }) {
	return <span class={`reason reason--${kind}`}>{KIND[kind]}</span>;
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
		<div class="field">
			<span class="field__label">{props.label}</span>
			<div class="stepper">
				<button
					type="button"
					class="key"
					aria-label={`${props.label} verringern`}
					disabled={props.value <= props.min}
					onClick={() => props.onChange(Math.max(props.min, props.value - 1))}
				>
					<Minus class="icon" aria-hidden="true" />
				</button>
				<output class="num" aria-live="polite">
					{props.unit(props.value)}
				</output>
				<button
					type="button"
					class="key"
					aria-label={`${props.label} erhöhen`}
					disabled={props.value >= props.max}
					onClick={() => props.onChange(Math.min(props.max, props.value + 1))}
				>
					<Plus class="icon" aria-hidden="true" />
				</button>
			</div>
		</div>
	);
}

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
	const has = (s: StationSource) =>
		props.value.some(
			(v) =>
				v.type === s.type &&
				(v.type === "liked" || (s.type === "playlist" && v.type === "playlist" && v.id === s.id)),
		);
	const toggle = (s: StationSource) =>
		props.onChange(
			has(s)
				? props.value.filter(
						(v) =>
							!(
								v.type === s.type &&
								(v.type === "liked" ||
									(s.type === "playlist" && v.type === "playlist" && v.id === s.id))
							),
					)
				: [...props.value, s],
		);
	if (!lists) return <div class="skeleton" style={{ height: "168px" }} />;
	return (
		<ul class="list">
			<li>
				<label class="row">
					<input
						type="checkbox"
						class="check"
						checked={has({ type: "liked" })}
						onChange={() => toggle({ type: "liked" })}
					/>
					<span class="row__main">
						<span class="row__title">Lieblingssongs</span>
						<span class="row__sub">Deine Herzen in Spotify</span>
					</span>
				</label>
			</li>
			{lists.map((p) => (
				<li key={p.id}>
					<label class="row" aria-disabled={!p.readable}>
						<input
							type="checkbox"
							class="check"
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
	const saveTimer = useRef<number | null>(null);
	const flushMix = useRef(() => {});
	const wide = useWide();
	const radio = useStore();

	const load = () => {
		const started = Date.now();
		return api
			.station(id)
			.then((x) => {
				store.settleThumbs([...x.upcoming, ...x.recent], started);
				setD(x);
				setName(x.name);
			})
			.catch((e: Error) => setErr(e.message));
	};

	useEffect(() => {
		setD(null);
		setMix(null);
		void load();
		const t = window.setInterval(() => {
			if (document.visibilityState === "visible") void load();
		}, 15_000);
		// Leaving before the turn was saved: save it now, not never.
		const onHide = () => flushMix.current();
		window.addEventListener("pagehide", onHide);
		return () => {
			window.clearInterval(t);
			window.removeEventListener("pagehide", onHide);
			flushMix.current();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id]);

	const patch = (p: Parameters<typeof api.updateStation>[1], quiet = false) =>
		api
			.updateStation(id, p)
			.then(() => {
				if (!quiet)
					store.say(
						"Gespeichert — gilt, sobald du den Sender das nächste Mal startest",
						"info",
						4000,
					);
				void load();
				void store.refresh(false);
			})
			.catch((e: Error) => store.say(e.message, "error"));

	// While the listener turns the knob, the sheet shows the turned value; once
	// saved, it follows the hub again (also when the radio's own Klang knob turned it).
	const pendingMix = useRef<number | null>(null);
	const saveMix = (v: number) => {
		pendingMix.current = null;
		saveTimer.current = null;
		api
			.updateStation(id, { rules: { mix: v } })
			.then(() => store.refresh(false))
			.then(() => {
				// The hub's word counts again, unless the knob was turned once more meanwhile.
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

	if (err) {
		return (
			<div class="page">
				<PageBar title="Sender" />
				<p class="note note--error">{err}</p>
			</div>
		);
	}
	if (!d) {
		return (
			<div class="page" aria-busy="true">
				<PageBar title="Sender" />
				<div class="skeleton" style={{ height: "120px" }} />
				<div class="skeleton" style={{ height: "160px" }} />
			</div>
		);
	}

	const summary = state.stations.find((s) => s.id === id) ?? d;
	// The radio's Klang knob turns the station its pointer stands on.
	const frontKnob =
		wide && pointedStation(state, radio.tuning?.stationId ?? null, radio.selected)?.id === id;
	const np = state.nowPlaying;
	// Paused in this station: the key plays on, it never starts the station over.
	const held = !!np && np.stationId === id && !np.isPlaying;
	const resume = () =>
		api
			.player("resume")
			.then((r) => {
				if (!r.ok) store.say(r.error?.message ?? "Das hat nicht geklappt.", "error");
			})
			.catch((e: Error) => store.say(e.message, "error"))
			.finally(() => window.setTimeout(() => void store.refresh(true), 1200));
	const heard =
		d.poolSize !== null && d.freshRemaining !== null ? d.poolSize - d.freshRemaining : null;
	const rules = d.rules;
	const value = mix ?? summary.rules.mix;

	return (
		<div class="page">
			<PageBar
				title={d.name}
				sub={d.kind === "all" ? "Alle deine Sender und Lieblingssongs" : undefined}
				backTo="/"
				noBack={embedded}
			>
				<Scale
					pos={d.progress ?? 0}
					label={
						heard !== null && d.poolSize !== null
							? `Runde ${d.roundNo}: ${num(heard)} von ${num(d.poolSize)} gehört, ${num(d.freshRemaining ?? 0)} offen`
							: `Runde ${d.roundNo}`
					}
					reading={{ round: d.roundNo, heard, total: d.poolSize }}
				/>
			</PageBar>

			{/* Printed on the sheet, not keys of the radio: what to do with this station, ruled like a program line. */}
			<div class="acts">
				<button
					type="button"
					class="key key--lit"
					disabled={!summary.ready || !!store.tuning}
					onClick={() => (held ? resume() : playStation(summary))}
				>
					{summary.playing ? "Neu starten" : held ? "Weiterspielen" : "Spielen"}
				</button>
				{d.playlistId ? (
					<a
						class="key"
						href={`https://open.spotify.com/playlist/${d.playlistId}`}
						target="_blank"
						rel="noopener"
					>
						In Spotify
					</a>
				) : (
					<span class="key" aria-disabled="true">
						wird vorbereitet
					</span>
				)}
			</div>

			{/* Beside the radio, its Klang knob already turns this station: the sheet only prints the mix.
			    Elsewhere the sheet prints the knob's three positions to choose from; the knob stays on the radio. */}
			<Section title="Mischung" id="mix" lead={<MixReadout s={summary} mix={value} />}>
				{frontKnob ? (
					<p class="hint">Am Klang-Knopf des Radios einstellbar.</p>
				) : (
					<MixScale value={value} station={d.name} onChange={onMix} />
				)}
			</Section>

			{/* On a desktop the program card heads this sheet and names the song; it is said once. */}
			{np && np.stationId === id && !wide ? (
				<Section title={np.isPlaying ? "Läuft gerade" : "Pausiert"} id="now">
					<ul class="order order--now">
						<li class="order__row track--rate">
							<RateHit t={np} />
							<Cover src={np.imageUrl} class="cover--lg" />
							<span class="order__title">
								<span class="order__song">{np.name}</span>
								<span class="order__artist">{np.artists}</span>
							</span>
							<ThumbMark t={np} />
							{np.kind ? (
								<Reason kind={np.kind} />
							) : (
								<span class="order__meta">{np.isPlaying ? "spielt" : "Pause"}</span>
							)}
						</li>
					</ul>
				</Section>
			) : null}

			<Section
				title="Als Nächstes"
				id="next"
				lead={d.upcoming.length > 0 ? `${d.upcoming.length} Songs in dieser Reihenfolge` : null}
			>
				{d.upcoming.length === 0 ? (
					<p class="hint">
						Noch keine Reihenfolge — sie entsteht, sobald der Sender eingelesen ist.
					</p>
				) : (
					// The running order: number, title — artist, and why it comes.
					<ol class="order">
						{d.upcoming.map((t, i) => (
							<li key={t.id} class="order__row track--rate">
								<RateHit t={t} />
								<span class="order__n num" aria-hidden="true">
									{String(i + 1).padStart(2, "0")}
								</span>
								<span class="order__title">
									<span class="order__song">{t.name}</span>
									<span class="order__artist">{t.artists}</span>
								</span>
								<ThumbMark t={t} />
								<Reason kind={t.kind} />
							</li>
						))}
					</ol>
				)}
			</Section>

			{d.recent.length > 0 ? (
				<Section title="Zuletzt auf diesem Sender" id="recent">
					<ul class="order">
						{d.recent.slice(0, 8).map((t) => (
							<li key={`${t.id}-${t.playedAt}`} class="order__row track--rate">
								<RateHit t={t} />
								<span class="order__when">{ago(t.playedAt)}</span>
								<span class="order__title">
									<span class="order__song">{t.name}</span>
									<span class="order__artist">{t.artists}</span>
								</span>
								<ThumbMark t={t} />
							</li>
						))}
					</ul>
				</Section>
			) : null}

			<Section title="Neuentdeckungen" id="disc">
				<table class="ledger">
					<tbody>
						<tr>
							<th scope="row">
								Kommen noch
								<span class="ledger__note">Geprüfte Vorschläge, die dieser Sender noch spielt</span>
							</th>
							<td class="num">{num(d.discoveries.pending)}</td>
						</tr>
						<tr>
							<th scope="row">
								Gefallen dir
								<span class="ledger__note">
									Zweimal gehört oder Daumen hoch. Sie bleiben im Sender und stehen in deiner
									Spotify-Playlist „{DECK_PREFIX}Entdeckungen“.
								</span>
							</th>
							<td class="num">{num(d.discoveries.kept)}</td>
						</tr>
						<tr>
							<th scope="row">
								Aussortiert
								<span class="ledger__note">
									Früh übersprungen oder Daumen runter. Sie kommen nicht wieder.
								</span>
							</th>
							<td class="num">{num(d.discoveries.rejected)}</td>
						</tr>
					</tbody>
				</table>
			</Section>

			{d.kind !== "all" ? (
				<Section title="Quellen" id="src">
					{editSources ? (
						<div class="stack">
							<SourcePicker value={editSources} onChange={setEditSources} />
							<div class="row-actions">
								<button type="button" class="key btn" onClick={() => setEditSources(null)}>
									Abbrechen
								</button>
								<button
									type="button"
									class="key key--lit btn"
									disabled={editSources.length === 0}
									onClick={() => {
										void patch({ sources: editSources });
										setEditSources(null);
									}}
								>
									Übernehmen
								</button>
							</div>
						</div>
					) : (
						<button
							type="button"
							class="key btn btn--wide"
							onClick={() => setEditSources(d.sources)}
						>
							{d.sources.length} {d.sources.length === 1 ? "Quelle" : "Quellen"} ändern
						</button>
					)}
				</Section>
			) : null}

			<details class="more">
				<summary>Erweitert</summary>
				<div class="more__body">
					<div class="field">
						<label for="st-name">Name</label>
						<input
							id="st-name"
							class="input"
							value={name}
							maxLength={80}
							onInput={(e) => setName((e.target as HTMLInputElement).value)}
							onBlur={() =>
								name.trim() && name.trim() !== d.name && void patch({ name: name.trim() })
							}
						/>
					</div>
					<Stepper
						label="Favoriten frühestens wieder nach"
						value={rules.favoriteCooldownDays}
						min={1}
						max={60}
						unit={(n) => `${n} ${n === 1 ? "Tag" : "Tagen"}`}
						onChange={(n) => setRule({ favoriteCooldownDays: n })}
					/>
					<Detents
						name="st-fav"
						legend="Anteil Favoriten"
						options={FAV_SHARES}
						value={rules.favoriteShare === null ? "auto" : String(rules.favoriteShare)}
						onChange={(v) => setRule({ favoriteShare: v === "auto" ? null : Number(v) })}
					/>
					<fieldset class="field" style={{ border: 0, padding: 0, margin: 0 }}>
						<legend class="field__label">Wenn du einen Song früh überspringst</legend>
						<div class="radios">
							{(
								[
									[
										"later_less",
										"Nicht jetzt, später seltener",
										"Kommt in dieser Runde nochmal, mit weniger Gewicht. Nach drei Mal kaum noch.",
									],
									[
										"consume",
										"Zählt als gehört",
										"Erledigt für diese Runde, ohne Einfluss auf deinen Geschmack.",
									],
									[
										"ban",
										"Nie wieder auf diesem Sender",
										"Gilt, sobald true-shuffle das Überspringen sieht. Aufheben: Daumen hoch, auch später im Verlauf.",
									],
								] as const
							).map(([v, t, sub]) => (
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
						</div>
					</fieldset>
					<label class="row row--switch">
						<span class="row__main">
							<span class="row__title">Neuentdeckungen</span>
							<span class="row__sub">Songs, die nicht in deinen Playlists stehen</span>
						</span>
						<span class="lever">
							<span class="lever__legend" aria-hidden="true">
								Aus
							</span>
							<input
								type="checkbox"
								role="switch"
								class="switch"
								aria-checked={rules.discoveryEnabled}
								checked={rules.discoveryEnabled}
								onChange={(e) =>
									setRule({ discoveryEnabled: (e.target as HTMLInputElement).checked })
								}
							/>
							<span class="lever__legend" aria-hidden="true">
								An
							</span>
						</span>
					</label>
					<Stepper
						label="Abstand zwischen Songs desselben Künstlers"
						value={rules.artistSpacing}
						min={0}
						max={10}
						unit={(n) => (n === 0 ? "egal" : `${n} Songs`)}
						onChange={(n) => setRule({ artistSpacing: n })}
					/>
				</div>
			</details>

			{confirm ? (
				<div class="stack">
					<p class="note note--error">
						„{d.name}“ löschen? Die Spotify-Playlist „{DECK_PREFIX}
						{d.name}“ verschwindet. Dein Gedächtnis bleibt — jeder gehörte Song bleibt gehört.
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
									.deleteStation(id)
									.then(() => {
										store.say(`„${d.name}“ gelöscht`, "info", 4000);
										void store.refresh(false);
										navigate("/");
									})
									.catch((e: Error) => store.say(e.message, "error"))
							}
						>
							Löschen
						</button>
					</div>
				</div>
			) : (
				<button type="button" class="act act--danger" onClick={() => setConfirm(true)}>
					Sender löschen
				</button>
			)}
		</div>
	);
}

export function NewStation() {
	const [name, setName] = useState("");
	const [sources, setSources] = useState<StationSource[]>([]);
	const [busy, setBusy] = useState(false);
	return (
		<div class="page">
			<PageBar title="Sender anlegen" sub="Eine oder mehrere Playlists als Quelle" backTo="/" />
			<div class="field">
				<label for="ns-name">Name</label>
				<input
					id="ns-name"
					class="input"
					placeholder="z. B. Autofahrt"
					value={name}
					maxLength={80}
					onInput={(e) => setName((e.target as HTMLInputElement).value)}
				/>
			</div>
			<Section title="Quellen" id="ns-src">
				<SourcePicker value={sources} onChange={setSources} />
			</Section>
			<button
				type="button"
				class="key key--lit btn btn--wide"
				disabled={busy || sources.length === 0 || !name.trim()}
				onClick={() => {
					setBusy(true);
					api
						.createStation({ name: name.trim(), sources })
						.then(() => {
							store.say(`„${name.trim()}“ wird eingerichtet`, "info", 4000);
							void store.refresh(false);
							navigate("/");
						})
						.catch((e: Error) => store.say(e.message, "error"))
						.finally(() => setBusy(false));
				}}
			>
				Sender speichern
			</button>
		</div>
	);
}
