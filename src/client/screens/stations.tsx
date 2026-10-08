import { ListPlus, Plus, SlidersHorizontal } from "lucide-preact";
import type { AppState, StationSummary } from "../../shared/api";
import { Cassette, shellOf } from "../components/cassette";
import { ago, num } from "../format";
import { navigate } from "../router";

/** How far a cassette is in its current pass, in plain words. Only API numbers. */
export function heardLine(s: StationSummary): string {
	if (s.importing) return "Wird gerade eingelesen …";
	const heard =
		s.poolSize !== null && s.freshRemaining !== null ? s.poolSize - s.freshRemaining : null;
	if (heard !== null && s.poolSize !== null)
		return `${num(heard)} von ${num(s.poolSize)} Songs gehört`;
	if (s.poolSize !== null) return `${num(s.poolSize)} Songs`;
	return s.ready ? "Zählt ab dem ersten Song" : "Wird vorbereitet …";
}

/** The shelf: every station as a cassette, ready to put into the Walkman. */
export function StationsScreen({ state }: { state: AppState }) {
	const inserted = state.session?.stationId ?? null;
	return (
		<div class="page page--wide shelf-page">
			<header class="masthead">
				<h1 class="masthead__title">Deine Kassetten</h1>
				<p class="lede">
					Jede Kassette spielt ihre Songs in fester Reihenfolge. Jeder Song kommt einmal dran, erst
					danach beginnt sie von vorn.
				</p>
				<div class="shelf-actions">
					<a class="key" href="/sender/neu">
						<Plus size={18} aria-hidden="true" />
						Neue Kassette
					</a>
					<a class="key" href="/suchlauf">
						<ListPlus size={18} aria-hidden="true" />
						Playlists hinzufügen
					</a>
				</div>
			</header>

			{state.stations.length === 0 ? (
				<div class="empty-state shelf-empty">
					<p>
						Noch keine Kassetten. Wähle Playlists aus Spotify, und jede wird eine eigene Kassette.
					</p>
					<a class="key key--lit" href="/suchlauf">
						<ListPlus size={18} aria-hidden="true" />
						Playlists hinzufügen
					</a>
				</div>
			) : (
				<ul class="shelf" aria-label="Kassetten">
					{state.stations.map((s) => (
						<TapeCard key={s.id} s={s} inserted={inserted === s.id} />
					))}
				</ul>
			)}
		</div>
	);
}

function TapeCard({ s, inserted }: { s: StationSummary; inserted: boolean }) {
	return (
		<li class={`tapecard${inserted ? " tapecard--in" : ""}`}>
			<div class="tapecard__tape">
				<Cassette
					name={s.name}
					shell={shellOf(s)}
					heard={s.progress}
					reels={inserted && s.playing ? "running" : "still"}
				/>
			</div>
			<div class="tapecard__text">
				<h2 class="tapecard__name">{s.name}</h2>
				{inserted ? <p class="tapecard__in">Eingelegt</p> : null}
				<p class="tapecard__fact">{heardLine(s)}</p>
				<span class="meter" aria-hidden="true">
					<span style={{ width: `${Math.round((s.progress ?? 0) * 100)}%` }} />
				</span>
				<p class="tapecard__when">
					{s.lastPlayedAt ? `Zuletzt gehört ${ago(s.lastPlayedAt)}` : "Noch nie gespielt"}
				</p>
			</div>
			<div class="tapecard__actions">
				<button
					type="button"
					class="key"
					aria-label={inserted ? `${s.name}: zum Walkman` : `${s.name} einlegen`}
					onClick={() => navigate(`/?sender=${s.id}`)}
				>
					{inserted ? "Zum Walkman" : "Einlegen"}
				</button>
				<a class="key" href={`/sender/${s.id}`} aria-label={`${s.name} einstellen`}>
					<SlidersHorizontal size={18} aria-hidden="true" />
					Einstellen
				</a>
			</div>
		</li>
	);
}
