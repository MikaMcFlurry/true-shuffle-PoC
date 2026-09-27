import { ChevronRight, Pause, Play, Plus, SkipForward, ThumbsDown, ThumbsUp } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import type { AppState, NowPlaying, StationSummary } from "../../shared/api";
import { api } from "../api";
import {
	Breakable,
	Cabinet,
	Dial,
	type Eye,
	type Indicator,
	ProgramCard,
	type RoundReading,
} from "../components/radio";
import { duration, num, SEP } from "../format";
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

/** The round in small print under a station's name, like its frequency. */
function freq(s: StationSummary): string {
	const heard = heardOf(s);
	const count = heard !== null && s.poolSize !== null ? `${num(heard)}/${num(s.poolSize)}` : "";
	if (s.roundNo > 1) return count ? `Runde ${s.roundNo}${SEP}${count}` : `Runde ${s.roundNo}`;
	return count || `Runde ${s.roundNo}`;
}

/** The same, spelled out for a screen reader. */
function roundLabel(s: StationSummary): string {
	const heard = heardOf(s);
	if (heard === null || s.poolSize === null) return `Runde ${s.roundNo}`;
	return `Runde ${s.roundNo}, ${num(heard)} von ${num(s.poolSize)} gehört`;
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
	api
		.player("resume")
		.then((r) => {
			if (!r.ok) store.say(r.error?.message ?? "Das hat nicht geklappt.", "error");
		})
		.catch((e: Error) => store.say(e.message, "error"))
		.finally(() => window.setTimeout(() => void store.refresh(true), 1200));
}

/** The station the pointer stands on: tuning, then playing or held, then the last one played. */
function pointedStation(state: AppState, tuningId: number | null): StationSummary | null {
	if (tuningId !== null) {
		const t = state.stations.find((x) => x.id === tuningId);
		if (t) return t;
	}
	const np = state.nowPlaying;
	if (np?.stationId != null) {
		const s = state.stations.find((x) => x.id === np.stationId);
		if (s) return s;
	}
	return (
		state.stations
			.filter((x) => x.lastPlayedAt !== null)
			.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))[0] ?? null
	);
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
function DialStation({ s, state }: { s: StationSummary; state: AppState }) {
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
	return (
		<li
			class={`station${lit ? " station--lit" : held ? " station--held" : ""}${s.ready ? "" : " station--wait"}`}
			data-at={String(s.id)}
		>
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

function StationDial({ state }: { state: AppState }) {
	const s = useStore();
	const at = pointedStation(state, s.tuning?.stationId ?? null);
	return (
		<Dial label="Senderskala" at={at ? String(at.id) : null} lamps={lampsFor(state)}>
			{state.stations.length > 0 ? (
				<ul class="dial__band">
					{state.stations.map((x) => (
						<DialStation key={x.id} s={x} state={state} />
					))}
				</ul>
			) : (
				<p class="dial__empty">Noch kein Sender — lege unten einen an.</p>
			)}
		</Dial>
	);
}

// -------------------------------------------------------- program card

function NowCard({ state }: { state: AppState }) {
	const s = useStore();
	const np = state.nowPlaying;
	const now = useTick(!!np?.isPlaying);
	const tuning = s.tuning ? state.stations.find((x) => x.id === s.tuning?.stationId) : null;
	const flash = s.flash && s.flash.until > Date.now() ? s.flash : null;
	const warning = state.warnings[0];
	const message = flash ?? (warning ? { text: warning.message, tone: "warn" as const } : null);
	const guest = state.guest.active;

	if (tuning) {
		return (
			<ProgramCard
				station={tuning.name}
				song="Sender wird eingestellt …"
				artist="true-shuffle bereitet deine Playlist in Spotify vor"
				reading={reading(tuning)}
				pos={tuning.progress}
				art={{ src: tuning.imageUrl }}
				live
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
				station={station ? station.name : "Spotify"}
				quiet={!station}
				song={np.name}
				artist={np.artists}
				time={`${duration(elapsed)} / ${duration(np.durationMs)}`}
				device={np.deviceName}
				message={message}
				line={
					station
						? np.kind
							? KIND_TEXT[np.kind](station.roundNo)
							: "Aus deiner Warteschlange"
						: guest
							? "Gast-Modus: zählt nicht ins Gedächtnis"
							: "Außerhalb von true-shuffle — zählt trotzdem"
				}
				reading={station ? reading(station) : null}
				pos={station?.progress}
				art={{ src: np.imageUrl }}
				live
			/>
		);
	}

	const last = state.stations
		.filter((x) => x.lastPlayedAt !== null)
		.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))[0];
	return (
		<ProgramCard
			station={last ? last.name : "Bereit"}
			quiet={!last}
			song={last ? "Tippe den Sender, um weiterzuhören" : "Tippe einen Sender"}
			artist="Spotify spielt, true-shuffle merkt sich alles"
			message={message}
			reading={last ? reading(last) : null}
			pos={last?.progress}
			art={{ src: last?.imageUrl ?? null }}
		/>
	);
}

// ---------------------------------------------------------- piano keys

function Transport({ np }: { np: NowPlaying | null }) {
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
			.then(() => {
				store.setThumb(np.id, next);
				if (next === -1) store.say("Kommt nie wieder — wird übersprungen", "info", 4000);
				else if (next === 1) store.say("Als Favorit gemerkt", "info", 3000);
			})
			.catch((e: Error) => store.say(e.message, "error"))
			.finally(() => window.setTimeout(() => void store.refresh(true), 800));
	};
	// Paused, the pause key stays down, like a tape deck's.
	const paused = !!np && !np.isPlaying;
	return (
		<fieldset class={`keys${disabled ? " keys--off" : ""}`}>
			<legend class="sr-only">Wiedergabe</legend>
			<button
				type="button"
				class={`pkey${thumbNow === -1 ? " pkey--down" : ""}`}
				disabled={disabled}
				aria-pressed={thumbNow === -1}
				aria-label="Daumen runter: diesen Song nie wieder"
				onClick={() => thumb(-1)}
			>
				<ThumbsDown class="pkey__icon" aria-hidden="true" />
				<span class="pkey__legend" aria-hidden="true">
					nie wieder
				</span>
			</button>
			<button
				type="button"
				class={`pkey${paused ? " pkey--down" : ""}`}
				disabled={disabled}
				aria-label={np?.isPlaying ? "Pause" : "Weiter abspielen"}
				onClick={() => act(np?.isPlaying ? "pause" : "resume")}
			>
				{np?.isPlaying || !np ? (
					<Pause class="pkey__icon" aria-hidden="true" />
				) : (
					<Play class="pkey__icon" aria-hidden="true" />
				)}
				<span class="pkey__legend" aria-hidden="true">
					{paused ? "Weiter" : "Pause"}
				</span>
			</button>
			<button
				type="button"
				class="pkey"
				disabled={disabled}
				aria-label="Nächster Song"
				onClick={() => act("next")}
			>
				<SkipForward class="pkey__icon" aria-hidden="true" />
				<span class="pkey__legend" aria-hidden="true">
					Nächster
				</span>
			</button>
			<button
				type="button"
				class={`pkey${thumbNow === 1 ? " pkey--down" : ""}`}
				disabled={disabled}
				aria-pressed={thumbNow === 1}
				aria-label="Daumen hoch: Favorit"
				onClick={() => thumb(1)}
			>
				<ThumbsUp class="pkey__icon" aria-hidden="true" />
				<span class="pkey__legend" aria-hidden="true">
					Favorit
				</span>
			</button>
		</fieldset>
	);
}

// ------------------------------------------------------- station index

/**
 * The station index, printed on a sheet under the radio: every station
 * with its round, each leading to its page to set it up.
 */
function StationIndex({ state }: { state: AppState }) {
	return (
		<section class="index" aria-labelledby="index-head">
			<h2 class="index__head" id="index-head">
				Sender einstellen
			</h2>
			<ol class="index__list">
				{state.stations.map((s, i) => (
					<li key={s.id}>
						<a class="index__row" href={`/sender/${s.id}`} aria-label={`${s.name} einstellen`}>
							<span class="index__n num" aria-hidden="true">
								{i + 1}
							</span>
							<span class="index__name">{s.name}</span>
							<span class="index__lead" aria-hidden="true" />
							<span class="index__freq num" aria-hidden="true">
								{freq(s)}
							</span>
							<ChevronRight class="index__go" aria-hidden="true" />
						</a>
					</li>
				))}
			</ol>
			<a class="index__row index__row--add" href="/sender/neu">
				<Plus class="index__plus" aria-hidden="true" />
				<span class="index__name">Sender anlegen</span>
			</a>
		</section>
	);
}

export function Home({ state }: { state: AppState }) {
	const s = useStore();
	return (
		<>
			<Cabinet eye={eyeFor(state, !!s.tuning)} eyeKey={s.tuning?.since ?? "steady"}>
				<StationDial state={state} />
				<NowCard state={state} />
				{state.warnings.slice(1).map((w) => (
					<p key={w.code} class="slip">
						{w.message}
					</p>
				))}
				<Transport np={state.nowPlaying} />
				<nav class="keys keys--small" aria-label="Radio">
					<a class="pkey pkey--dark" href="/menu">
						Menü
					</a>
					<a class="pkey pkey--dark" href="/verlauf">
						Verlauf
					</a>
				</nav>
			</Cabinet>
			<StationIndex state={state} />
		</>
	);
}
