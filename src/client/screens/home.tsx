import {
	Menu,
	Pause,
	Play,
	Plus,
	SkipForward,
	SlidersHorizontal,
	ThumbsDown,
	ThumbsUp,
} from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import type { AppState, NowPlaying, StationSummary } from "../../shared/api";
import { api } from "../api";
import { Display, type Indicator, type RoundReading, Scale } from "../components/radio";
import { duration, num, rds, SEP } from "../format";
import { navigate } from "../router";
import { store, useStore } from "../store";

const KIND_TEXT = {
	fresh: (round: number) => `Noch nicht gehört in Runde ${round}`,
	favorite: () => "Favorit — kommt höchstens einmal pro Woche",
	discovery: () => "Neuentdeckung",
} as const;

function roundLabel(s: StationSummary): string {
	if (s.poolSize === null || s.freshRemaining === null) return `Runde ${s.roundNo}`;
	const heard = Math.max(0, s.poolSize - s.freshRemaining);
	return `Runde ${s.roundNo}${SEP}${num(heard)} / ${num(s.poolSize)}`;
}

function reading(s: StationSummary): RoundReading {
	return {
		round: s.roundNo,
		heard:
			s.poolSize !== null && s.freshRemaining !== null
				? Math.max(0, s.poolSize - s.freshRemaining)
				: null,
		total: s.poolSize,
	};
}

function stationScale(s: StationSummary) {
	return { pos: s.progress ?? 0, label: roundLabel(s), reading: reading(s) };
}

/** "Runde 2" left, "340 / 1.200" right — one line, never broken inside a number. */
function RoundLine({ s }: { s: StationSummary }) {
	const heard =
		s.poolSize !== null && s.freshRemaining !== null
			? Math.max(0, s.poolSize - s.freshRemaining)
			: null;
	return (
		<span class="preset__round" aria-hidden="true">
			<span>Runde {s.roundNo}</span>
			{heard !== null && s.poolSize !== null ? (
				<span class="num">
					{num(heard)} / {num(s.poolSize)}
				</span>
			) : null}
		</span>
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

function NowDisplay({ state }: { state: AppState }) {
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
			<Display
				lit={guest ? ["GAST"] : []}
				name={rds(tuning.name)}
				song="Sender wird eingestellt …"
				artist="True Shuffle bereitet deine Playlist in Spotify vor"
				scale={stationScale(tuning)}
				art={{ src: tuning.imageUrl }}
				tuning
				live
			/>
		);
	}

	if (np) {
		const station =
			np.stationId !== null ? state.stations.find((x) => x.id === np.stationId) : null;
		const lit: Indicator[] = [];
		if (np.kind === "fresh") lit.push("UNGEHÖRT");
		if (np.kind === "favorite" || np.thumb === 1) lit.push("FAVORIT");
		if (np.kind === "discovery") lit.push("ENTDECKUNG");
		if (guest) lit.push("GAST");
		if (!np.isPlaying) lit.push("PAUSE");
		// The hub reports progress as of its answer; count on from when it arrived.
		const elapsed = Math.min(
			np.durationMs,
			np.progressMs + (np.isPlaying ? Math.max(0, now - s.receivedAt) : 0),
		);
		return (
			<Display
				lit={lit}
				device={np.deviceName}
				name={station ? rds(station.name) : "SPOTIFY"}
				nameGhost={!station}
				song={np.name}
				artist={np.artists}
				time={`${duration(elapsed)} / ${duration(np.durationMs)}`}
				message={message}
				line={
					station
						? np.kind
							? KIND_TEXT[np.kind](station.roundNo)
							: "Aus deiner Warteschlange"
						: guest
							? "Gast-Modus: zählt nicht ins Gedächtnis"
							: "Außerhalb von True Shuffle — zählt trotzdem"
				}
				scale={station ? stationScale(station) : null}
				art={{ src: np.imageUrl }}
				live
			/>
		);
	}

	const last = state.stations
		.filter((x) => x.lastPlayedAt !== null)
		.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))[0];
	return (
		<Display
			lit={guest ? ["GAST"] : []}
			name={last ? rds(last.name) : "BEREIT"}
			nameGhost={!last}
			song={last ? "Tippe den Sender, um weiterzuhören" : "Tippe einen Sender"}
			artist="Spotify spielt, True Shuffle merkt sich alles"
			message={message}
			scale={last ? stationScale(last) : null}
			art={{ src: last?.imageUrl ?? null }}
		/>
	);
}

function Transport({ np }: { np: NowPlaying | null }) {
	const disabled = !np;
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
				if (next === -1) store.say("Kommt nie wieder — wird übersprungen", "info", 4000);
				else if (next === 1) store.say("Als Favorit gemerkt", "info", 3000);
			})
			.catch((e: Error) => store.say(e.message, "error"))
			.finally(() => window.setTimeout(() => void store.refresh(true), 800));
	};
	return (
		<fieldset class={`transport${disabled ? " transport--off" : ""}`}>
			<legend class="sr-only">Wiedergabe</legend>
			<button
				type="button"
				class="key"
				disabled={disabled}
				aria-pressed={np?.thumb === -1}
				aria-label="Daumen runter: diesen Song nie wieder"
				onClick={() => thumb(-1)}
			>
				<ThumbsDown class="icon" aria-hidden="true" />
			</button>
			<button
				type="button"
				class="key"
				disabled={disabled}
				aria-label={np?.isPlaying ? "Pause" : "Weiter abspielen"}
				onClick={() => act(np?.isPlaying ? "pause" : "resume")}
			>
				{np?.isPlaying ? (
					<Pause class="icon" aria-hidden="true" />
				) : (
					<Play class="icon" aria-hidden="true" />
				)}
			</button>
			<button
				type="button"
				class="key"
				disabled={disabled}
				aria-label="Nächster Song"
				onClick={() => act("next")}
			>
				<SkipForward class="icon" aria-hidden="true" />
			</button>
			<button
				type="button"
				class="key"
				disabled={disabled}
				aria-pressed={np?.thumb === 1}
				aria-label="Daumen hoch: Favorit"
				onClick={() => thumb(1)}
			>
				<ThumbsUp class="icon" aria-hidden="true" />
			</button>
		</fieldset>
	);
}

function jobFor(state: AppState, s: StationSummary) {
	return (
		state.jobs.find((j) => j.key.startsWith("import:") && j.total !== null) ??
		state.jobs.find((j) => j.key === `deck:${s.id}`)
	);
}

function Preset({ s, n, state }: { s: StationSummary; n: number; state: AppState }) {
	const store = useStore();
	const tuning = store.tuning?.stationId === s.id;
	const held = state.nowPlaying?.stationId === s.id;
	const resume = () =>
		api
			.player("resume")
			.then((r) => {
				if (!r.ok) store.say(r.error?.message ?? "Das hat nicht geklappt.", "error");
			})
			.catch((e: Error) => store.say(e.message, "error"))
			.finally(() => window.setTimeout(() => void store.refresh(true), 1200));
	const job = !s.ready ? jobFor(state, s) : undefined;
	const status = s.importing
		? job?.total
			? `liest ein${SEP}${num(job.done ?? 0)} / ${num(job.total)}`
			: "liest ein …"
		: !s.ready
			? "wird vorbereitet …"
			: null;
	return (
		<li class={`preset${s.playing ? " preset--playing" : ""}`}>
			<button
				type="button"
				class="preset__play"
				disabled={!s.ready || !!store.tuning}
				aria-label={
					s.playing
						? `${s.name} öffnen (läuft gerade)`
						: held
							? `${s.name} weiterspielen`
							: `${s.name} starten`
				}
				// Already playing: open it; paused in it: play on — never start it over.
				onClick={() => (s.playing ? navigate(`/sender/${s.id}`) : held ? resume() : playStation(s))}
			>
				<span class="preset__num">
					<span class="num">{n}</span>
					<span class={`led${s.playing || tuning ? " on" : ""}`} aria-hidden="true" />
				</span>
				<span class="preset__name">{s.name}</span>
				<span class="preset__meta">
					{status ? (
						<span>{status}</span>
					) : (
						<>
							<Scale pos={s.progress ?? 0} label={roundLabel(s)} />
							<RoundLine s={s} />
						</>
					)}
				</span>
			</button>
			<a class="preset__tune" href={`/sender/${s.id}`} aria-label={`${s.name} einstellen`}>
				<SlidersHorizontal class="icon" aria-hidden="true" />
			</a>
		</li>
	);
}

export function Home({ state }: { state: AppState }) {
	return (
		<>
			<div class="brand">
				<span class="brand__mark">TRUE SHUFFLE</span>
				<span>{state.profile.name}</span>
			</div>
			<NowDisplay state={state} />
			<Transport np={state.nowPlaying} />
			{state.warnings.slice(1).map((w) => (
				<p key={w.code} class="note">
					{w.message}
				</p>
			))}
			<h2 class="sr-only">Sender</h2>
			<ul class="presets">
				{state.stations.map((s, i) => (
					<Preset key={s.id} s={s} n={i + 1} state={state} />
				))}
				<li>
					<a class="preset--add" href="/sender/neu">
						<Plus class="icon" aria-hidden="true" />
						<span>Sender anlegen</span>
					</a>
				</li>
			</ul>
			<nav class="bar" aria-label="Faceplate">
				<a class="key" href="/menu">
					<Menu class="icon" aria-hidden="true" />
					Menü
				</a>
				<a class="key" href="/verlauf">
					Verlauf
				</a>
			</nav>
		</>
	);
}
