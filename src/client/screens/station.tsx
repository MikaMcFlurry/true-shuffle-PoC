import { ChevronDown, ExternalLink, Minus, Play, Plus, Trash2 } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { PRESETS, sharesForRules } from "../../core/mix";
import type { SlotKind, StationRules } from "../../core/types";
import type { AppState, PlaylistView, StationDetail, StationSource } from "../../shared/api";
import { api } from "../api";
import { PageBar, Scale, Section } from "../components/radio";
import { ago, DECK_PREFIX, num, pct, SEP } from "../format";
import { navigate } from "../router";
import { store } from "../store";
import { playStation } from "./home";

const KIND: Record<SlotKind, string> = {
	fresh: "Neu",
	favorite: "Favorit",
	discovery: "Entdeckung",
};

function Balance(props: { value: number; onChange: (v: number) => void; rules: StationRules }) {
	const segs = 21;
	const pos = Math.round((props.value / 100) * (segs - 1));
	const shares = sharesForRules({ ...props.rules, mix: props.value });
	return (
		<div class="balance">
			<div class="balance__ends" aria-hidden="true">
				<span>ENTDECKEN</span>
				<span>VERTRAUT</span>
			</div>
			<div class="balance__track">
				<div class="balance__segs" aria-hidden="true">
					{Array.from({ length: segs }, (_, i) => (
						<span key={i} class={i === pos ? "on" : ""} />
					))}
				</div>
				<input
					type="range"
					min={0}
					max={100}
					step={5}
					value={props.value}
					aria-label="Entdecken oder Vertraut"
					aria-valuetext={`${pct(shares.fresh)} ungehört, ${pct(shares.favorite)} Favoriten, ${pct(shares.discovery)} Neuentdeckungen`}
					onInput={(e) => props.onChange(Number((e.target as HTMLInputElement).value))}
				/>
				<span class="balance__focus" />
			</div>
			<div class="balance__shares num">
				≈ {pct(shares.fresh)} ungehört{SEP}
				{pct(shares.favorite)} Favoriten{SEP}
				{pct(shares.discovery)} Neuentdeckungen
			</div>
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

	const load = () =>
		api
			.station(id)
			.then((x) => {
				setD(x);
				setName(x.name);
				setMix((m) => (m === null ? x.rules.mix : m));
			})
			.catch((e: Error) => setErr(e.message));

	useEffect(() => {
		setD(null);
		setMix(null);
		void load();
		const t = window.setInterval(() => {
			if (document.visibilityState === "visible") void load();
		}, 15_000);
		return () => window.clearInterval(t);
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

	const onMix = (v: number) => {
		setMix(v);
		if (saveTimer.current) window.clearTimeout(saveTimer.current);
		saveTimer.current = window.setTimeout(() => void patch({ rules: { mix: v } }, true), 700);
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
	const heard =
		d.poolSize !== null && d.freshRemaining !== null ? d.poolSize - d.freshRemaining : null;
	const rules = d.rules;
	const value = mix ?? rules.mix;

	return (
		<div class="page">
			<PageBar
				title={d.name}
				sub={
					d.kind === "all"
						? "Alle deine Sender und Lieblingssongs"
						: d.playing
							? "Läuft gerade"
							: undefined
				}
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

			<div class="row-actions">
				<button
					type="button"
					class="key key--lit btn"
					disabled={!summary.ready || !!store.tuning}
					onClick={() => playStation(summary)}
				>
					<Play class="icon" aria-hidden="true" />
					Spielen
				</button>
				{d.playlistId ? (
					<a
						class="key btn"
						href={`https://open.spotify.com/playlist/${d.playlistId}`}
						target="_blank"
						rel="noopener"
					>
						<ExternalLink class="icon" aria-hidden="true" />
						In Spotify
					</a>
				) : (
					<span class="key btn" aria-disabled="true">
						wird vorbereitet
					</span>
				)}
			</div>

			<Section title="Mischung" id="mix">
				<Balance value={value} rules={rules} onChange={onMix} />
				<div class="presetrow">
					{(
						[
							["Entdecker", PRESETS.entdecker],
							["Ausgewogen", PRESETS.ausgewogen],
							["Vertraut", PRESETS.vertraut],
						] as const
					).map(([label, v]) => (
						<button
							key={label}
							type="button"
							class="key btn btn--small"
							aria-pressed={value === v}
							onClick={() => onMix(v)}
						>
							{label}
						</button>
					))}
				</div>
			</Section>

			<Section title="Als Nächstes" id="next">
				{d.upcoming.length === 0 ? (
					<p class="hint">
						Noch keine Reihenfolge — sie entsteht, sobald der Sender eingelesen ist.
					</p>
				) : (
					// The queue as the display shows it: numbered, each song with its reason.
					<ol class="glass glasslist">
						{d.upcoming.map((t, i) => (
							<li key={t.id} class="glasslist__row">
								<span class="glasslist__n num" aria-hidden="true">
									{String(i + 1).padStart(2, "0")}
								</span>
								<span class="glasslist__main">
									<span class="glasslist__title">{t.name}</span>
									<span class="glasslist__sub">{t.artists}</span>
								</span>
								<span class={`seg${t.kind !== "fresh" ? " on" : " dim"}`}>{KIND[t.kind]}</span>
							</li>
						))}
					</ol>
				)}
			</Section>

			{d.recent.length > 0 ? (
				<Section title="Zuletzt auf diesem Sender" id="recent">
					<ul class="glass glasslist">
						{d.recent.slice(0, 8).map((t) => (
							<li key={`${t.id}-${t.playedAt}`} class="glasslist__row">
								<span class="glasslist__main">
									<span class="glasslist__title">{t.name}</span>
									<span class="glasslist__sub">{t.artists}</span>
								</span>
								<span class="glasslist__value">{ago(t.playedAt)}</span>
							</li>
						))}
					</ul>
				</Section>
			) : null}

			<Section title="Neuentdeckungen" id="disc">
				<ul class="glass glasslist">
					<li class="glasslist__row">
						<span class="glasslist__main">
							<span class="glasslist__title">Warten auf dich</span>
							<span class="glasslist__sub">Geprüfte Vorschläge für diesen Sender</span>
						</span>
						<span class="glasslist__count num">{num(d.discoveries.pending)}</span>
					</li>
					<li class="glasslist__row">
						<span class="glasslist__main">
							<span class="glasslist__title">Behalten</span>
							<span class="glasslist__sub">Stehen in „{DECK_PREFIX}Entdeckungen“</span>
						</span>
						<span class="glasslist__count num">{num(d.discoveries.kept)}</span>
					</li>
					<li class="glasslist__row">
						<span class="glasslist__main">
							<span class="glasslist__title">Aussortiert</span>
							<span class="glasslist__sub">Früh übersprungen oder Daumen runter</span>
						</span>
						<span class="glasslist__count num">{num(d.discoveries.rejected)}</span>
					</li>
				</ul>
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
				<summary>
					Erweitert
					<ChevronDown class="icon" aria-hidden="true" />
				</summary>
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
					<div class="field">
						<label for="st-fav">Anteil Favoriten</label>
						<select
							id="st-fav"
							class="input"
							value={rules.favoriteShare === null ? "auto" : String(rules.favoriteShare)}
							onChange={(e) => {
								const v = (e.target as HTMLSelectElement).value;
								setRule({ favoriteShare: v === "auto" ? null : Number(v) });
							}}
						>
							<option value="auto">Wie die Mischung</option>
							{[0, 0.05, 0.1, 0.15, 0.25, 0.35, 0.5].map((v) => (
								<option key={v} value={String(v)}>
									{pct(v)}
								</option>
							))}
						</select>
					</div>
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
									["ban", "Nie wieder auf diesem Sender", "Rückgängig über Daumen hoch."],
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
										<span>{sub}</span>
									</span>
								</label>
							))}
						</div>
					</fieldset>
					<label class="row" style={{ padding: 0, minHeight: 44 }}>
						<span class="row__main">
							<span class="row__title">Neuentdeckungen</span>
							<span class="row__sub">Songs, die nicht in deinen Playlists stehen</span>
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
				<button
					type="button"
					class="key btn btn--wide key--danger"
					onClick={() => setConfirm(true)}
				>
					<Trash2 class="icon" aria-hidden="true" />
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
