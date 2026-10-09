/**
 * "Dein Hörprofil": what true-shuffle recorded of the listener's music, as
 * figures and small charts. Every number comes from `GET /api/profile`; the
 * page only arranges it. Charts carry hover titles and a table view.
 */

import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ListeningProfile, ProfileTop } from "../../shared/api";
import { api } from "../api";
import { Cover, PageBar, Section } from "../components/ui";
import { num } from "../format";

const DAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const DAYS_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

function hoursWord(minutes: number): string {
	if (minutes < 60) return `${num(minutes)} Minuten`;
	const h = minutes / 60;
	return `${h < 10 ? h.toLocaleString("de-DE", { maximumFractionDigits: 1 }) : num(Math.round(h))} Stunden`;
}

function monthLabel(m: string): string {
	const [y, mm] = m.split("-");
	return `${MONTHS[Number(mm) - 1] ?? mm} ${y?.slice(2)}`;
}

function dateWord(at: number): string {
	return new Date(at).toLocaleDateString("de-DE", {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
}

/** Five steps of one hue, light to dark; 0 stays the bare paper. */
function step(v: number, max: number): number {
	if (v <= 0 || max <= 0) return 0;
	return Math.min(5, 1 + Math.floor((v / max) * 4.999));
}

export function ProfileScreen() {
	const [p, setP] = useState<ListeningProfile | null>(null);
	const [err, setErr] = useState<string | null>(null);
	useEffect(() => {
		api
			.profile()
			.then(setP)
			.catch((e: Error) => setErr(e.message));
	}, []);
	return (
		<div class="page profile">
			<PageBar
				title="Dein Hörprofil"
				sub="Wann und was du hörst, und was true-shuffle daraus über dich weiß. Gezählt wird jeder Song ab 30 Sekunden, Gast-Modus nie."
				backTo="/verlauf"
			/>
			{err ? (
				<p class="notice notice--error" role="alert">
					Hörprofil nicht geladen: {err}
				</p>
			) : null}
			{!p && !err ? <div class="skeleton" style={{ height: "420px" }} /> : null}
			{p && p.plays === 0 && !p.imported ? (
				<p class="empty-state">
					Noch nichts gezählt. Sobald du über Spotify hörst, füllt sich dein Hörprofil, egal ob über
					true-shuffle oder nicht.
				</p>
			) : null}
			{p && (p.plays > 0 || p.imported) ? <Profile p={p} /> : null}
		</div>
	);
}

/** One period's figures, from the import or from true-shuffle's own plays. */
interface View {
	since: number | null;
	plays: number;
	minutes: number;
	/** Real listening time (import) or the songs' lengths added up (live). */
	exact: boolean;
	songs: number;
	artists: number;
	hourWeek: number[];
	months: ListeningProfile["months"];
	topArtists: ProfileTop[];
	topSongs: ProfileTop[];
}

function liveView(p: ListeningProfile): View {
	return { ...p, exact: false };
}

function importedView(i: NonNullable<ListeningProfile["imported"]>): View {
	return {
		since: i.from,
		plays: i.plays,
		minutes: i.minutes,
		exact: true,
		songs: i.songs,
		artists: i.artists,
		hourWeek: i.hourWeek,
		months: i.months,
		topArtists: i.topArtists.slice(0, 10).map((a) => ({
			name: a.name,
			artists: "",
			plays: a.plays,
			imageUrl: null,
		})),
		topSongs: i.topSongs.slice(0, 10).map((x) => ({
			name: x.name,
			artists: x.artist,
			plays: x.plays,
			imageUrl: x.imageUrl,
		})),
	};
}

function Profile({ p }: { p: ListeningProfile }) {
	const [which, setWhich] = useState<"imported" | "live">(p.imported ? "imported" : "live");
	const v = which === "imported" && p.imported ? importedView(p.imported) : liveView(p);
	return (
		<>
			{p.imported ? (
				<fieldset class="segmented segmented--mix profile__which">
					<legend class="sr-only">Welcher Zeitraum</legend>
					<label class="segmented__opt">
						<input
							type="radio"
							name="pf-which"
							checked={which === "imported"}
							onChange={() => setWhich("imported")}
						/>
						<span>Ganzer Verlauf</span>
					</label>
					<label class="segmented__opt">
						<input
							type="radio"
							name="pf-which"
							checked={which === "live"}
							onChange={() => setWhich("live")}
						/>
						<span>Letzte 180 Tage</span>
					</label>
				</fieldset>
			) : null}
			<p class="hint profile__source">
				{which === "imported" && p.imported
					? `Aus deinem importierten Spotify-Verlauf, ${dateWord(p.imported.from)} bis ${dateWord(p.imported.to)}.`
					: "Was true-shuffle selbst gezählt hat, die letzten 180 Tage, auch was du direkt in Spotify gehört hast."}
			</p>
			{v.plays === 0 ? (
				<p class="empty-state">In diesem Zeitraum ist noch nichts gezählt.</p>
			) : (
				<Period v={v} />
			)}
			<Genres p={p} />

			<Section title="Was true-shuffle über dich weiß" id="pf-learned">
				<p class="section__lead">
					Daraus mischt true-shuffle deine Kassetten und wählt Empfehlungen aus.
				</p>
				<ul class="learned">
					{p.plays > 0 ? (
						<li>
							<span class="learned__n">{num(Math.round((p.onCassettes / p.plays) * 100))} %</span>
							<span>
								deiner Songs der letzten 180 Tage liefen auf deinen Kassetten, der Rest direkt in
								Spotify.
							</span>
						</li>
					) : null}
					<li>
						<span class="learned__n">{num(p.learned.favorites)}</span>
						<span>Favoriten mit Daumen hoch. Sie kommen öfter.</span>
					</li>
					<li>
						<span class="learned__n">{num(p.learned.neverAgain)}</span>
						<span>Songs kommen nie wieder, weil du sie aussortiert hast.</span>
					</li>
					<li>
						<span class="learned__n">{num(p.learned.recommendationsKept)}</span>
						<span>Empfehlungen haben dir gefallen und bleiben auf deinen Kassetten.</span>
					</li>
					<li>
						<span class="learned__n">{num(p.learned.recommendationsDropped)}</span>
						<span>
							Empfehlungen hast du aussortiert. Ähnliches schlägt true-shuffle seltener vor.
						</span>
					</li>
					<li>
						<span class="learned__n">{num(p.learned.earlySkips)}</span>
						<span>Mal hast du einen Song in den ersten 30 Sekunden übersprungen.</span>
					</li>
				</ul>
			</Section>
		</>
	);
}

function Period({ v }: { v: View }) {
	return (
		<>
			<section class="figures" aria-label="Auf einen Blick">
				<p class="figure figure--hero">
					<span class="figure__value">{hoursWord(v.minutes)}</span>
					<span class="figure__label">
						Musik seit {v.since ? dateWord(v.since) : "dem ersten Song"}
						{v.exact ? ", so lange lief sie wirklich" : ", höchstens: Songlängen zusammengezählt"}
					</span>
				</p>
				<p class="figure">
					<span class="figure__value">{num(v.plays)}</span>
					<span class="figure__label">Songs gehört</span>
				</p>
				<p class="figure">
					<span class="figure__value">{num(v.songs)}</span>
					<span class="figure__label">verschiedene Songs</span>
				</p>
				<p class="figure">
					<span class="figure__value">{num(v.artists)}</span>
					<span class="figure__label">Künstler</span>
				</p>
			</section>

			<Section title="Wann du hörst" id="pf-when">
				<HourWeek cells={v.hourWeek} />
			</Section>

			{v.months.length > 24 ? (
				<Section title="Pro Jahr" id="pf-months">
					<Months months={byYear(v.months)} unit="year" />
				</Section>
			) : v.months.length > 1 ? (
				<Section title="Pro Monat" id="pf-months">
					<Months months={v.months} unit="month" />
				</Section>
			) : null}

			<Section title="Am meisten gehört" id="pf-top">
				<h3 class="profile__sub">Künstler</h3>
				<Bars rows={v.topArtists} />
				<h3 class="profile__sub">Songs</h3>
				<ol class="list profile-songs">
					{v.topSongs.map((s, i) => (
						<li key={`${s.name}-${i}`} class="profile-song">
							<span class="profile-song__n">{i + 1}</span>
							<Cover src={s.imageUrl} />
							<span class="profile-song__main">
								<span class="profile-song__title">{s.name}</span>
								<span class="profile-song__sub">{s.artists}</span>
							</span>
							<span class="profile-song__plays">{num(s.plays)}×</span>
						</li>
					))}
				</ol>
			</Section>
		</>
	);
}

/** The AI's estimate of the genre mix, clearly marked as one; asked for on demand. */
function Genres({ p }: { p: ListeningProfile }) {
	const [g, setG] = useState(p.genres);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const ask = () => {
		setBusy(true);
		setErr(null);
		api
			.genres()
			.then(setG)
			.catch((e: Error) => setErr(e.message))
			.finally(() => setBusy(false));
	};
	const fresh = g && Date.now() - g.at < 6 * 3_600_000;
	return (
		<Section title="Deine Genres" id="pf-genres">
			{g ? (
				<>
					{g.summary ? <p class="profile__summary">{g.summary}</p> : null}
					<Bars
						rows={g.genres.map((x) => ({
							name: x.name,
							artists: "",
							plays: x.share,
							imageUrl: null,
						}))}
						value={(r) => `${Math.round(r.plays)} %`}
					/>
					<p class="hint">
						Eine Einschätzung der KI ({g.source === "anthropic" ? "Claude" : "Workers AI"}) aus
						deinen {num(g.artists)} meistgehörten Künstlern, gewichtet nach Hörzeit, vom{" "}
						{dateWord(g.at)}. Spotify selbst nennt die Genres nicht; sie sind geschätzt.
					</p>
				</>
			) : (
				<p class="section__lead">
					Welche Genres du hörst, schätzt eine KI aus deinen meistgehörten Künstlern. Daraus wählt
					true-shuffle auch seine Empfehlungen.
				</p>
			)}
			{p.canEstimate ? (
				fresh ? null : (
					<button type="button" class="key key--wide" disabled={busy} onClick={ask}>
						{busy ? "Die KI schätzt …" : g ? "Neu einschätzen" : "Genres einschätzen lassen"}
					</button>
				)
			) : (
				<p class="hint">
					Dafür braucht true-shuffle eine KI. Die richtet der Betreiber auf dem Server ein.
				</p>
			)}
			{err ? (
				<p class="notice notice--error" role="alert">
					Keine Einschätzung: {err}
				</p>
			) : null}
		</Section>
	);
}

/** Weekday × hour as a grid of one hue; darker is more. Hover names the cell. */
function HourWeek({ cells }: { cells: number[] }) {
	const max = Math.max(0, ...cells);
	let best = 0;
	for (let i = 1; i < cells.length; i++) if ((cells[i] ?? 0) > (cells[best] ?? 0)) best = i;
	const byHour = Array.from({ length: 24 }, (_, h) =>
		DAYS.reduce((s, _d, d) => s + (cells[d * 24 + h] ?? 0), 0),
	);
	const byDay = DAYS.map((_d, d) => cells.slice(d * 24, d * 24 + 24).reduce((a, b) => a + b, 0));
	const topHour = byHour.indexOf(Math.max(...byHour));
	const topDay = byDay.indexOf(Math.max(...byDay));
	return (
		<>
			<p class="section__lead">
				Am meisten hörst du {DAYS[topDay]}s, und über die Woche gesehen um {topHour} Uhr. Dein
				dichtester Moment: {DAYS[Math.floor(best / 24)]} um {best % 24} Uhr.
			</p>
			<div class="heat" role="img" aria-label="Songs nach Wochentag und Uhrzeit, Tabelle darunter">
				<span class="heat__corner" />
				{Array.from({ length: 24 }, (_, h) => (
					<span key={`h${h}`} class="heat__hour" aria-hidden="true">
						{h % 6 === 0 ? h : ""}
					</span>
				))}
				{DAYS_SHORT.map((d, di) => (
					<Fragment key={d}>
						<span class="heat__day" aria-hidden="true">
							{d}
						</span>
						{Array.from({ length: 24 }, (_, h) => {
							const v = cells[di * 24 + h] ?? 0;
							return (
								<span
									key={`${d}${h}`}
									class={`heat__cell heat__cell--${step(v, max)}`}
									title={`${DAYS[di]}, ${h}–${h + 1} Uhr: ${num(v)} ${v === 1 ? "Song" : "Songs"}`}
								/>
							);
						})}
					</Fragment>
				))}
			</div>
			<p class="heat__legend" aria-hidden="true">
				weniger
				{[1, 2, 3, 4, 5].map((s) => (
					<span key={s} class={`heat__cell heat__cell--${s}`} />
				))}
				mehr
			</p>
			<details class="fold profile__table">
				<summary>
					<span class="fold__title">Als Tabelle</span>
				</summary>
				<div class="fold__body">
					<table class="table">
						<thead>
							<tr>
								<th scope="col">Uhrzeit</th>
								<th scope="col">Songs</th>
							</tr>
						</thead>
						<tbody>
							{byHour.map((v, h) => (
								<tr key={h}>
									<th scope="row">{`${h}–${h + 1} Uhr`}</th>
									<td class="num">{num(v)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</details>
		</>
	);
}

/** Months summed per calendar year, for a long history. */
function byYear(months: ListeningProfile["months"]): ListeningProfile["months"] {
	const out = new Map<string, { plays: number; minutes: number }>();
	for (const m of months) {
		const y = m.month.slice(0, 4);
		const v = out.get(y) ?? { plays: 0, minutes: 0 };
		v.plays += m.plays;
		v.minutes += m.minutes;
		out.set(y, v);
	}
	return [...out.entries()].map(([month, v]) => ({ month, ...v }));
}

/**
 * Hours per month (or year) as columns, one series; the busiest is labelled.
 * With many columns only every few carry a label, so none overlap.
 */
function Months({ months, unit }: { months: ListeningProfile["months"]; unit: "month" | "year" }) {
	const max = Math.max(1, ...months.map((m) => m.minutes));
	const top = months.reduce((a, b) => (b.minutes > a.minutes ? b : a), months[0]!);
	const name = (m: string) => (unit === "year" ? m : monthLabel(m));
	const every = Math.max(1, Math.ceil(months.length / (unit === "year" ? 6 : 8)));
	return (
		<>
			<p class="section__lead">
				{unit === "year"
					? `Dein stärkstes Jahr war ${top.month} mit ${hoursWord(top.minutes)}.`
					: `Dein stärkster Monat war ${monthLabel(top.month).replace(" ", " 20")} mit ${hoursWord(top.minutes)}.`}
			</p>
			<div
				class="cols"
				role="img"
				aria-label={unit === "year" ? "Stunden pro Jahr" : "Stunden pro Monat"}
			>
				{months.map((m, i) => (
					<span
						key={m.month}
						class="cols__col"
						title={`${name(m.month)}: ${hoursWord(m.minutes)}, ${num(m.plays)} Songs`}
					>
						<span class="cols__bar" style={{ height: `${Math.max(2, (m.minutes / max) * 100)}%` }}>
							{m === top ? (
								<span class="cols__value">{num(Math.round(m.minutes / 60))}</span>
							) : null}
						</span>
						<span class="cols__label">
							{i % every === 0 && i <= months.length - every
								? unit === "year"
									? `’${m.month.slice(2)}`
									: monthLabel(m.month)
								: ""}
						</span>
					</span>
				))}
			</div>
		</>
	);
}

/** Top artists as horizontal bars with the count at the tip. */
function Bars({
	rows,
	value = (r) => num(r.plays),
}: {
	rows: ProfileTop[];
	value?: (r: ProfileTop) => string;
}) {
	const max = Math.max(1, ...rows.map((r) => r.plays));
	return (
		<ol class="hbars">
			{rows.map((r) => (
				<li key={r.name} class="hbars__row">
					<span class="hbars__name">{r.name}</span>
					<span class="hbars__track">
						<span
							class="hbars__bar"
							style={{ width: `calc((100% - 3.5rem) * ${(r.plays / max).toFixed(4)})` }}
						/>
						<span class="hbars__value">{value(r)}</span>
					</span>
				</li>
			))}
		</ol>
	);
}
