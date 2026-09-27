import { useEffect, useRef, useState } from "preact/hooks";
import { sharesForRules } from "../../core/mix";
import type { AppState, NowPlaying, StationSummary } from "../../shared/api";
import { api } from "../api";
import {
	Breakable,
	Cabinet,
	Dial,
	type Eye,
	type Indicator,
	Knob,
	MixKnob,
	ProgramCard,
	type RoundReading,
	useWide,
} from "../components/radio";
import { duration, num, pct, SEP } from "../format";
import { navigate } from "../router";
import { store, useStore } from "../store";

const KIND_TEXT = {
	fresh: (round: number) => `Noch nicht gehört in Runde ${round}`,
	favorite: () => "Favorit — kommt höchstens einmal pro Woche",
	discovery: () => "Neuentdeckung",
} as const;

function heardOf(s: StationSummary): number | null {
	return s.poolSize !== null && s.freshRemaining !== null
		? Math.max(0, s.poolSize - s.freshRemaining)
		: null;
}

function reading(s: StationSummary): RoundReading {
	return { round: s.roundNo, heard: heardOf(s), total: s.poolSize };
}

/** The round in small print beside a station's name, like its frequency. */
export function freq(s: StationSummary): string {
	const heard = heardOf(s);
	const count = heard !== null && s.poolSize !== null ? `${num(heard)}/${num(s.poolSize)}` : "";
	if (s.roundNo > 1) return count ? `R${s.roundNo}${SEP}${count}` : `Runde ${s.roundNo}`;
	return count || `Runde ${s.roundNo}`;
}

/** The same, spelled out for a screen reader. */
export function roundLabel(s: StationSummary): string {
	const heard = heardOf(s);
	if (heard === null || s.poolSize === null) return `Runde ${s.roundNo}`;
	return `Runde ${s.roundNo}, ${num(heard)} von ${num(s.poolSize)} gehört`;
}

/** "≈ 60 % ungehört · 10 % Favoriten · 30 % Neuentdeckungen" for a mix. */
export function mixText(s: StationSummary, mix: number, sep = SEP): string {
	const sh = sharesForRules({ ...s.rules, mix });
	return `≈ ${pct(sh.fresh)} ungehört${sep}${pct(sh.favorite)} Favoriten${sep}${pct(sh.discovery)} Neuentdeckungen`;
}

/** The same, printed: a share and its name never break apart. */
export function MixReadout({ s, mix }: { s: StationSummary; mix: number }) {
	const sh = sharesForRules({ ...s.rules, mix });
	return (
		<>
			<span class="nowrap">≈ {pct(sh.fresh)} ungehört</span>
			{SEP}
			<span class="nowrap">{pct(sh.favorite)} Favoriten</span>
			{SEP}
			<span class="nowrap">{pct(sh.discovery)} Neuentdeckungen</span>
		</>
	);
}

function useTick(active: boolean): number {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!active) return;
		const t = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(t);
	}, [active]);
	return now;
}

export function playStation(s: StationSummary): void {
	if (store.tuning) return;
	store.tuning = { stationId: s.id, since: Date.now() };
	store.selected = null;
	store.flash = null;
	store.emit();
	let deviceId: string | undefined;
	try {
		deviceId = localStorage.getItem("ts-device") ?? undefined;
	} catch {
		deviceId = undefined;
	}
	api
		.play(s.id, deviceId)
		.then((r) => {
			if (r.ok) store.say(`Läuft auf ${r.deviceName ?? "deinem Gerät"}`, "info", 5000);
			else store.say(r.error?.message ?? "Das hat nicht geklappt.", "error", 12000);
		})
		.catch((e: Error) => store.say(e.message, "error", 10000))
		.finally(() => {
			window.setTimeout(() => {
				store.tuning = null;
				void store.refresh(true);
			}, 900);
		});
}

function resumePlayback(): void {
	store.selected = null;
	api
		.player("resume")
		.then((r) => {
			if (!r.ok) store.say(r.error?.message ?? "Das hat nicht geklappt.", "error");
		})
		.catch((e: Error) => store.say(e.message, "error"))
		.finally(() => window.setTimeout(() => void store.refresh(true), 1200));
}

function lastPlayed(state: AppState): StationSummary | null {
	return (
		state.stations
			.filter((x) => x.lastPlayedAt !== null)
			.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))[0] ?? null
	);
}

/** The station that plays or is held, else the one that played last. */
export function currentStation(state: AppState): StationSummary | null {
	const np = state.nowPlaying;
	if (np?.stationId != null) {
		const s = state.stations.find((x) => x.id === np.stationId);
		if (s) return s;
	}
	return lastPlayed(state);
}

/** Where the pointer stands: tuning, then the knob's selection, then the current station. */
export function pointedStation(
	state: AppState,
	tuningId: number | null,
	selected: number | null,
): StationSummary | null {
	for (const id of [tuningId, selected]) {
		if (id === null) continue;
		const s = state.stations.find((x) => x.id === id);
		if (s) return s;
	}
	return currentStation(state);
}

function eyeFor(state: AppState, tuning: boolean): Eye {
	if (tuning) return "tuning";
	const np = state.nowPlaying;
	if (!np) return "open";
	if (!np.isPlaying) return "weak";
	return np.stationId !== null ? "tuned" : "weak";
}

function lampsFor(state: AppState): Indicator[] {
	const np = state.nowPlaying;
	const lit: Indicator[] = [];
	if (np?.kind === "fresh") lit.push("Ungehört");
	if (np && (np.kind === "favorite" || np.thumb === 1)) lit.push("Favorit");
	if (np?.kind === "discovery") lit.push("Entdeckung");
	if (state.guest.active) lit.push("Gast");
	if (np && !np.isPlaying) lit.push("Pause");
	return lit;
}

// ------------------------------------------------------------- the dial

function jobFor(state: AppState, s: StationSummary) {
	return (
		state.jobs.find((j) => j.key.startsWith("import:") && j.total !== null) ??
		state.jobs.find((j) => j.key === `deck:${s.id}`)
	);
}

/** One station printed on the dial. Tapping it tunes in. */
function DialStation({
	s,
	n,
	state,
	selected,
}: {
	s: StationSummary;
	n: number;
	state: AppState;
	selected: boolean;
}) {
	const store = useStore();
	const tuning = store.tuning?.stationId === s.id;
	const held = state.nowPlaying?.stationId === s.id;
	const job = !s.ready ? jobFor(state, s) : undefined;
	const status = s.importing
		? job?.total
			? `liest ein${SEP}${num(job.done ?? 0)}/${num(job.total)}`
			: "liest ein …"
		: !s.ready
			? "wird vorbereitet …"
			: null;
	const lit = s.playing || tuning;
	const freqId = `freq-${s.id}`;
	const cls = lit ? " station--lit" : held ? " station--held" : selected ? " station--sel" : "";
	return (
		<li class={`station${cls}${s.ready ? "" : " station--wait"}`} data-at={String(s.id)}>
			<button
				type="button"
				class="station__tune"
				disabled={!s.ready || !!store.tuning}
				aria-label={
					s.playing
						? `${s.name} öffnen (läuft gerade)`
						: held
							? `${s.name} weiterspielen`
							: `${s.name} starten`
				}
				aria-describedby={freqId}
				// Already playing: open it; paused in it: play on — never start it over.
				onClick={() =>
					s.playing ? navigate(`/sender/${s.id}`) : held ? resumePlayback() : playStation(s)
				}
			>
				<span class="station__no num" aria-hidden="true">
					{n}
				</span>
				<span class="station__name">
					<Breakable text={s.name} />
				</span>
				<span class="station__freq num" id={freqId}>
					<span aria-hidden="true">{status ?? freq(s)}</span>
					<span class="sr-only">{status ?? roundLabel(s)}</span>
				</span>
			</button>
		</li>
	);
}

/** The narrowest column a station name is printed in on the wide dial, and its band legend. */
const COLUMN_PX = 100;
const DENSE_COLUMN_PX = 84;
const LEGEND_PX = 40;
/** More rows than this, and the dial is printed denser: smaller lettering, the count under the name. */
const DENSE_ROWS = 2;

/** How wide a column must be to print the longest word of any name whole (roughly, per letter). */
function columnFor(stations: StationSummary[], dense: boolean): number {
	let longest = 0;
	for (const x of stations)
		for (const w of x.name.split(/[\s/-]+/)) longest = Math.max(longest, w.length);
	const need = Math.round(longest * (dense ? 6.4 : 8.8) + (dense ? 10 : 12));
	return Math.min(150, Math.max(dense ? DENSE_COLUMN_PX : COLUMN_PX, need));
}

/**
 * How many stations share a wave band: as many as the glass has room for,
 * at most `most`, and the bands evened out, so twelve read as two of six.
 */
function bandSize(n: number, fieldPx: number | null, columnPx: number, most: number): number {
	const fits = fieldPx === null ? 3 : Math.floor((fieldPx - LEGEND_PX) / columnPx);
	const room = Math.max(3, Math.min(most, fits));
	const bands = Math.max(1, Math.ceil(n / room));
	return Math.max(1, Math.ceil(n / bands));
}

function StationDial({ state }: { state: AppState }) {
	const s = useStore();
	const wide = useWide();
	const [fieldPx, setFieldPx] = useState<number | null>(null);
	const at = pointedStation(state, s.tuning?.stationId ?? null, s.selected);
	// A phone prints one station per line; the wide dial prints bands across.
	const n = state.stations.length;
	let per = wide ? bandSize(n, fieldPx, columnFor(state.stations, false), 8) : 3;
	// Past two rows the dial is printed denser, with up to eight columns on a wide glass.
	const dense = wide && Math.ceil(n / per) > DENSE_ROWS;
	if (dense)
		per = bandSize(
			n,
			fieldPx,
			columnFor(state.stations, true),
			fieldPx !== null && fieldPx >= 760 ? 8 : 6,
		);
	const bands: StationSummary[][] = [];
	state.stations.forEach((x, i) => {
		if (i % per === 0) bands.push([]);
		bands[bands.length - 1]!.push(x);
	});
	return (
		<Dial
			label="Senderskala"
			at={at ? String(at.id) : null}
			lamps={lampsFor(state)}
			onFieldWidth={(px) => setFieldPx(Math.round(px))}
		>
			{bands.length > 0 ? (
				<ol
					class={`dial__bands${dense ? " dial__bands--dense" : ""}`}
					style={{ "--per": String(per) }}
				>
					{bands.map((band, b) => {
						const first = b * per + 1;
						const last = first + band.length - 1;
						return (
							<li key={band[0]!.id} class="band">
								<span class="band__legend num" aria-hidden="true">
									{first === last ? first : `${first}–${last}`}
								</span>
								<ul class="band__stations">
									{band.map((x, i) => (
										<DialStation
											key={x.id}
											s={x}
											n={first + i}
											state={state}
											selected={s.selected === x.id}
										/>
									))}
								</ul>
							</li>
						);
					})}
				</ol>
			) : (
				<p class="dial__empty">Noch kein Sender — lege im Menü einen an.</p>
			)}
		</Dial>
	);
}

// -------------------------------------------------------- program card

function SetUp({ s }: { s: StationSummary }) {
	return (
		<a class="card__setup" href={`/sender/${s.id}`}>
			{s.name} einstellen
		</a>
	);
}

/** The program card: what plays, why, how far the round is. On a desktop it heads the sheet beside the radio. */
export function NowCard({ state }: { state: AppState }) {
	const s = useStore();
	const np = state.nowPlaying;
	const now = useTick(!!np?.isPlaying);
	const tuning = s.tuning ? state.stations.find((x) => x.id === s.tuning?.stationId) : null;
	const flash = s.flash && s.flash.until > Date.now() ? s.flash : null;
	const warning = state.warnings[0];
	const message = flash ?? (warning ? { text: warning.message, tone: "warn" as const } : null);
	const guest = state.guest.active;
	const current = currentStation(state);
	const picked =
		s.selected !== null && s.selected !== current?.id
			? state.stations.find((x) => x.id === s.selected)
			: s.selected !== null && np && !np.isPlaying
				? state.stations.find((x) => x.id === s.selected)
				: null;

	if (tuning) {
		return (
			<ProgramCard
				song="Sender wird eingestellt …"
				artist="true-shuffle bereitet deine Playlist in Spotify vor"
				reading={reading(tuning)}
				pos={tuning.progress}
				art={{ src: tuning.imageUrl }}
				live
				foot={<SetUp s={tuning} />}
			/>
		);
	}

	// The tuning knob has turned the pointer to a station: the card offers it, nothing plays yet.
	if (picked) {
		const held = np?.stationId === picked.id;
		return (
			<ProgramCard
				song={picked.name}
				artist={held ? "Eingestellt — hier pausiert" : "Eingestellt — spielt erst auf Tastendruck"}
				message={message}
				reading={reading(picked)}
				pos={picked.progress}
				art={{ src: picked.imageUrl }}
				live
				foot={
					<>
						<button
							type="button"
							class="key key--lit btn--small"
							disabled={!picked.ready || !!s.tuning}
							aria-label={`${held ? "Eingestellten Sender weiterspielen" : "Eingestellten Sender spielen"}: ${picked.name}`}
							onClick={() => (held ? resumePlayback() : playStation(picked))}
						>
							{held ? "Weiterspielen" : "Spielen"}
						</button>
						<SetUp s={picked} />
					</>
				}
			/>
		);
	}

	if (np) {
		const station =
			np.stationId !== null ? state.stations.find((x) => x.id === np.stationId) : null;
		// The hub reports progress as of its answer; count on from when it arrived.
		const elapsed = Math.min(
			np.durationMs,
			np.progressMs + (np.isPlaying ? Math.max(0, now - s.receivedAt) : 0),
		);
		return (
			<ProgramCard
				song={np.name}
				artist={np.artists}
				time={`${duration(elapsed)} / ${duration(np.durationMs)}`}
				device={np.deviceName}
				message={message}
				line={
					station
						? np.kind
							? KIND_TEXT[np.kind](station.roundNo)
							: "Nicht aus der Reihenfolge dieses Senders"
						: guest
							? "Gast-Modus: zählt nicht ins Gedächtnis"
							: "Außerhalb von true-shuffle — zählt trotzdem"
				}
				reading={station ? reading(station) : null}
				pos={station?.progress}
				art={{ src: np.imageUrl }}
				live
				foot={station ? <SetUp s={station} /> : null}
			/>
		);
	}

	const last = lastPlayed(state);
	return (
		<ProgramCard
			song={last ? "Tippe den Sender, um weiterzuhören" : "Tippe einen Sender"}
			artist="Spotify spielt, true-shuffle merkt sich alles"
			message={message}
			reading={last ? reading(last) : null}
			pos={last?.progress}
			art={{ src: last?.imageUrl ?? null }}
			foot={last ? <SetUp s={last} /> : null}
		/>
	);
}

// ---------------------------------------------------------------- knobs

/**
 * Klang: Entdecken ↔ Vertraut of the station the pointer stands on (the one
 * the card shows), saved a moment after the last turn, and at once when
 * the listener leaves the radio before that.
 */
function KlangKnob({ state }: { state: AppState }) {
	const s = useStore();
	// In hand, the knob keeps the station it was taken up on, whatever the pointer does.
	const [pinned, setPinned] = useState<number | null>(null);
	const station = s.tuning
		? null
		: ((pinned !== null ? state.stations.find((x) => x.id === pinned) : undefined) ??
			pointedStation(state, null, s.selected));
	const [local, setLocal] = useState<{ id: number; mix: number } | null>(null);
	const pending = useRef<{ id: number; mix: number; timer: number } | null>(null);
	const save = (id: number, mix: number) =>
		api
			.updateStation(id, { rules: { mix } })
			.then(() => store.refresh(false))
			.catch((e: Error) => {
				// Not saved: the knob goes back to what the station really has.
				if (pending.current?.id !== id) setLocal((l) => (l?.id === id ? null : l));
				store.say(`Klang nicht gespeichert: ${e.message}`, "error");
				void store.refresh(false);
			});
	const hold = (on: boolean) => {
		if (on && !station) return;
		setPinned(on ? (station?.id ?? null) : null);
		store.holdSelection(on);
	};
	const flush = useRef(() => {});
	flush.current = () => {
		const p = pending.current;
		if (!p) return;
		window.clearTimeout(p.timer);
		pending.current = null;
		void save(p.id, p.mix);
	};
	useEffect(() => {
		const onHide = () => flush.current();
		window.addEventListener("pagehide", onHide);
		return () => {
			window.removeEventListener("pagehide", onHide);
			flush.current();
			store.holdSelection(false);
		};
	}, []);
	// Once the hub has the value turned here, its word counts again.
	useEffect(() => {
		if (local && !pending.current && station?.id === local.id && station.rules.mix === local.mix)
			setLocal(null);
	});
	const value = station ? (local?.id === station.id ? local.mix : station.rules.mix) : null;
	const change = (v: number) => {
		if (!station) return;
		setLocal({ id: station.id, mix: v });
		store.say(
			`Klang für ${station.name} ${mixText(station, v)}. Gilt, sobald du den Sender das nächste Mal startest.`,
			"info",
			4500,
		);
		if (pending.current && pending.current.id !== station.id) flush.current();
		if (pending.current) window.clearTimeout(pending.current.timer);
		const id = station.id;
		pending.current = {
			id,
			mix: v,
			timer: window.setTimeout(() => {
				pending.current = null;
				void save(id, v);
			}, 700),
		};
	};
	return (
		<MixKnob
			value={value}
			valueText={
				station && value !== null
					? `${station.name}: ${mixText(station, value, ", ")}`
					: "kein Sender"
			}
			station={station?.name ?? null}
			onChange={change}
			disabled={!station}
			showTarget
			onHold={hold}
		/>
	);
}

/** The tuning knob: it moves the pointer from station to station. Playing is a separate press. */
function TuneKnob({ state }: { state: AppState }) {
	const s = useStore();
	const list = state.stations;
	const n = list.length;
	// It stands where the pointer stands; with nothing tuned yet, on the first station.
	const at = pointedStation(state, s.tuning?.stationId ?? null, s.selected) ?? list[0] ?? null;
	const idx = at
		? Math.max(
				0,
				list.findIndex((x) => x.id === at.id),
			)
		: 0;
	const angle = (i: number) => (n > 1 ? -120 + (240 * i) / (n - 1) : 0);
	return (
		<div class="knob-unit knob-unit--tune">
			<Knob
				label="Senderwahl"
				min={0}
				max={Math.max(0, n - 1)}
				step={1}
				value={idx}
				valueText={at ? `${idx + 1} von ${n}: ${at.name}` : "kein Sender"}
				angle={angle}
				onChange={(i) => {
					const next = list[i];
					if (next) store.select(next.id);
				}}
				disabled={n === 0 || !!s.tuning}
				ticks={list.map((_, i) => angle(i))}
				pitch={22}
				tapSteps
				emitSame
			/>
			<span class="knob-unit__name" aria-hidden="true">
				Senderwahl
			</span>
		</div>
	);
}

// ---------------------------------------------------------- the keyboard

/**
 * One keyboard in one slot: the four ivory keys that act on the song, and
 * either side of them the smaller bakelite keys Menü and Verlauf. A latched
 * key stays down.
 */
function Keyboard({ np }: { np: NowPlaying | null }) {
	const disabled = !np;
	const thumbNow = np?.thumb ?? 0;
	const act = (a: "pause" | "resume" | "next") => {
		api
			.player(a)
			.then((r) => {
				if (!r.ok) store.say(r.error?.message ?? "Das hat nicht geklappt.", "error");
			})
			.catch((e: Error) => store.say(e.message, "error"))
			.finally(() => window.setTimeout(() => void store.refresh(true), 1200));
	};
	const thumb = (v: -1 | 1) => {
		if (!np) return;
		const next = np.thumb === v ? 0 : v;
		api
			.thumb(np.id, next)
			.then((r) => {
				store.setThumb(np.id, next);
				// Say what happened: skipped on only when Spotify actually moved on.
				if (next === -1)
					store.say(
						r?.skipped ? "Kommt nie wieder — übersprungen" : "Kommt nie wieder",
						"info",
						4000,
					);
				else if (next === 1) store.say("Als Favorit gemerkt", "info", 3000);
			})
			.catch((e: Error) => store.say(e.message, "error"))
			.finally(() => window.setTimeout(() => void store.refresh(true), 800));
	};
	// Paused, the pause key stays down, like a tape deck's.
	const paused = !!np && !np.isPlaying;
	return (
		<div class={`keyboard${disabled ? " keyboard--off" : ""}`}>
			<a class="pkey pkey--end pkey--bakelite" href="/menu">
				<span class="pkey__legend">Menü</span>
			</a>
			<fieldset class="keyboard__play">
				<legend class="sr-only">Wiedergabe</legend>
				<button
					type="button"
					class={`pkey${thumbNow === -1 ? " pkey--down" : ""}`}
					disabled={disabled}
					aria-pressed={thumbNow === -1}
					aria-label="Daumen runter: diesen Song nie wieder"
					onClick={() => thumb(-1)}
				>
					<span class="pkey__legend">nie wieder</span>
				</button>
				<button
					type="button"
					class={`pkey${paused ? " pkey--down" : ""}`}
					disabled={disabled}
					// A latching key: "Pause", pressed while paused; pressing it again plays on.
					aria-label="Pause"
					aria-pressed={paused}
					onClick={() => act(np?.isPlaying ? "pause" : "resume")}
				>
					{/* Engraved once: the key sinks and its legend reddens while paused. */}
					<span class="pkey__legend">Pause</span>
				</button>
				<button
					type="button"
					class="pkey"
					disabled={disabled}
					aria-label="Weiter: Nächster Song"
					onClick={() => act("next")}
				>
					<span class="pkey__legend">Weiter</span>
				</button>
				<button
					type="button"
					class={`pkey${thumbNow === 1 ? " pkey--down" : ""}`}
					disabled={disabled}
					aria-pressed={thumbNow === 1}
					aria-label="Daumen hoch: Favorit"
					onClick={() => thumb(1)}
				>
					<span class="pkey__legend">Favorit</span>
				</button>
			</fieldset>
			<a class="pkey pkey--end pkey--bakelite" href="/verlauf">
				<span class="pkey__legend">Verlauf</span>
			</a>
		</div>
	);
}

export function Home({ state }: { state: AppState }) {
	const s = useStore();
	// On a desktop the card leaves the cabinet and heads the program sheet beside it.
	const wide = useWide();
	return (
		<Cabinet
			fill
			eye={eyeFor(state, !!s.tuning)}
			eyeKey={s.tuning?.since ?? "steady"}
			dial={<StationDial state={state} />}
			window={wide ? undefined : <NowCard state={state} />}
			extra={
				state.warnings.length > 1
					? state.warnings.slice(1).map((w) => (
							<p key={w.code} class="slip">
								{w.message}
							</p>
						))
					: null
			}
			left={<KlangKnob state={state} />}
			right={<TuneKnob state={state} />}
			keys={<Keyboard np={state.nowPlaying} />}
		/>
	);
}
