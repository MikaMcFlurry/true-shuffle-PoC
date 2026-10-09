/**
 * "Dein Hörprofil": the listener's music in a chosen period — last week,
 * 30 days, 12 months, a calendar year, everything, or any range — as figures
 * and small charts. Every number comes from `GET /api/profile` for that
 * period; the page only arranges it. Charts carry hover titles and a table.
 */

import { type ComponentChildren, Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ListeningProfile, ProfileItem } from "../../shared/api";
import { api } from "../api";
import { Cover, PageBar, Section } from "../components/ui";
import { num } from "../format";

const DAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const DAYS_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const MONTHS_LONG = [
	"Januar",
	"Februar",
	"März",
	"April",
	"Mai",
	"Juni",
	"Juli",
	"August",
	"September",
	"Oktober",
	"November",
	"Dezember",
];
const DAY = 86_400_000;

function hoursWord(minutes: number): string {
	if (minutes < 60) return `${num(minutes)} ${minutes === 1 ? "Minute" : "Minuten"}`;
	const h = minutes / 60;
	return `${h < 10 ? h.toLocaleString("de-DE", { maximumFractionDigits: 1 }) : num(Math.round(h))} Stunden`;
}

function timeWord(at: number): string {
	return new Date(at).toLocaleString("de-DE", {
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function dateWord(at: number): string {
	return new Date(at).toLocaleDateString("de-DE", {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
}

/** A YYYY-MM-DD key as a German date. */
function keyWord(key: string, withYear = true): string {
	const [y, m, d] = key.split("-").map(Number);
	return `${d}. ${MONTHS_LONG[(m ?? 1) - 1]}${withYear ? ` ${y}` : ""}`;
}

/** Short, for a narrow figure: "22 Min.", "1,5 Std." */
function hoursShort(minutes: number): string {
	if (minutes < 60) return `${num(minutes)} Min.`;
	return `${(minutes / 60).toLocaleString("de-DE", { maximumFractionDigits: 1 })} Std.`;
}

function percent(share: number): string {
	return `${Math.round(share * 100)} %`;
}

/** Five steps of one hue, light to dark; 0 stays the bare paper. */
function step(v: number, max: number): number {
	if (v <= 0 || max <= 0) return 0;
	return Math.min(5, 1 + Math.floor((v / max) * 4.999));
}

// ---------------------------------------------------------------------------
// The period
// ---------------------------------------------------------------------------

type Choice =
	| { kind: "7" | "30" | "365" | "all" }
	| { kind: "year"; year: number }
	| { kind: "custom"; from: string; to: string };

function dayInput(at: number): string {
	const d = new Date(at);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fromInput(v: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
	return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}

/** A local date shifted by days, at its midnight (DST-proof: calendar, not hours). */
function shiftDays(at: number, days: number): number {
	const d = new Date(at);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

/**
 * From inclusive, to exclusive; today counts in full. The period before for
 * the comparison is a calendar one too: the year before, the same number of
 * days before.
 */
export function periodOf(
	c: Choice,
	now = Date.now(),
): { from: number | null; to: number | null; previousFrom: number | null } {
	const end = shiftDays(now, 1);
	switch (c.kind) {
		case "7":
			return { from: shiftDays(end, -7), to: end, previousFrom: shiftDays(end, -14) };
		case "30":
			return { from: shiftDays(end, -30), to: end, previousFrom: shiftDays(end, -60) };
		case "365": {
			const d = new Date(now);
			return {
				from: new Date(d.getFullYear() - 1, d.getMonth(), d.getDate() + 1).getTime(),
				to: end,
				previousFrom: new Date(d.getFullYear() - 2, d.getMonth(), d.getDate() + 1).getTime(),
			};
		}
		case "year":
			return {
				from: new Date(c.year, 0, 1).getTime(),
				to: new Date(c.year + 1, 0, 1).getTime(),
				previousFrom: new Date(c.year - 1, 0, 1).getTime(),
			};
		case "custom": {
			const from = fromInput(c.from);
			const last = fromInput(c.to);
			const to = last === null ? end : shiftDays(last, 1);
			const days = from === null ? 0 : Math.round((to - from) / DAY);
			return { from, to, previousFrom: from === null ? null : shiftDays(from, -days) };
		}
		default:
			return { from: null, to: null, previousFrom: null };
	}
}

/** "in den 30 Tagen davor" etc., for the comparison. */
function beforeWord(c: Choice): string {
	switch (c.kind) {
		case "7":
			return "in den 7 Tagen davor";
		case "30":
			return "in den 30 Tagen davor";
		case "365":
			return "in den 12 Monaten davor";
		case "year":
			return `im Jahr ${c.year - 1}`;
		default:
			return "im gleich langen Zeitraum davor";
	}
}

function periodWord(c: Choice, p: ListeningProfile): string {
	switch (c.kind) {
		case "7":
			return "in den letzten 7 Tagen";
		case "30":
			return "in den letzten 30 Tagen";
		case "365":
			return "in den letzten 12 Monaten";
		case "year":
			return `im Jahr ${c.year}`;
		case "custom":
			return p.period.from !== null
				? `vom ${dateWord(p.period.from)} bis ${dateWord(p.period.to - 1)}`
				: "im gewählten Zeitraum";
		default:
			return p.first ? `seit ${dateWord(p.first)}` : "insgesamt";
	}
}

export function ProfileScreen() {
	const [choice, setChoice] = useState<Choice>({ kind: "30" });
	const [p, setP] = useState<ListeningProfile | null>(null);
	const [shown, setShown] = useState<Choice>(choice);
	const [years, setYears] = useState<number[]>([]);
	const [loading, setLoading] = useState(true);
	const [err, setErr] = useState<string | null>(null);
	const seq = useRef(0);
	useEffect(() => {
		const n = ++seq.current;
		setLoading(true);
		setErr(null);
		api
			.profile(periodOf(choice))
			.then((r) => {
				if (n !== seq.current) return;
				setP(r);
				setShown(choice);
				if (r.years.length > 0) setYears(r.years);
			})
			.catch((e: Error) => n === seq.current && setErr(e.message))
			.finally(() => n === seq.current && setLoading(false));
	}, [choice]);
	return (
		<div class="page profile">
			<PageBar
				title="Dein Hörprofil"
				sub="Wann und was du hörst, und was true-shuffle daraus über dich weiß. Gezählt wird jeder Song ab 30 Sekunden, Gast-Modus nie."
				backTo="/verlauf"
			/>
			<PeriodPicker choice={choice} years={years} onChoose={setChoice} />
			{err ? (
				<p class="notice notice--error" role="alert">
					Hörprofil nicht geladen: {err}
				</p>
			) : null}
			{!p && !err ? <div class="skeleton" style={{ height: "420px" }} /> : null}
			{p ? (
				<div class={`profile__body${loading ? " profile__body--loading" : ""}`} aria-busy={loading}>
					<Coverage p={p} />
					{p.plays === 0 ? (
						<p class="empty-state">
							{periodWord(shown, p)[0]!.toUpperCase() + periodWord(shown, p).slice(1)} ist nichts
							gezählt.
						</p>
					) : (
						<Period p={p} choice={shown} />
					)}
					<Genres p={p} />
					<Learned p={p} />
				</div>
			) : null}
		</div>
	);
}

function PeriodPicker({
	choice,
	years,
	onChoose,
}: {
	choice: Choice;
	years: number[];
	onChoose: (c: Choice) => void;
}) {
	const [from, setFrom] = useState(
		choice.kind === "custom" ? choice.from : dayInput(Date.now() - 90 * DAY),
	);
	const [to, setTo] = useState(choice.kind === "custom" ? choice.to : dayInput(Date.now()));
	const presets: { kind: "7" | "30" | "365" | "all" | "custom"; label: string }[] = [
		{ kind: "7", label: "7 Tage" },
		{ kind: "30", label: "30 Tage" },
		{ kind: "365", label: "12 Monate" },
		{ kind: "all", label: "Alles" },
		{ kind: "custom", label: "Eigener" },
	];
	const pick = (kind: (typeof presets)[number]["kind"]) =>
		onChoose(kind === "custom" ? { kind, from, to } : { kind });
	return (
		<div class="periods">
			<fieldset class="segmented periods__set">
				<legend class="sr-only">Zeitraum</legend>
				<div class="periods__row">
					{presets.map((x) => (
						<label key={x.kind} class="segmented__opt">
							<input
								type="radio"
								name="pf-period"
								checked={choice.kind === x.kind}
								onChange={() => pick(x.kind)}
							/>
							<span>{x.label}</span>
						</label>
					))}
				</div>
			</fieldset>
			{years.length > 0 ? (
				<fieldset class="segmented periods__set">
					<legend class="periods__legend">Jahresrückblick</legend>
					<div class="periods__row periods__row--years">
						{years
							.slice()
							.reverse()
							.map((y) => (
								<label key={y} class="segmented__opt">
									<input
										type="radio"
										name="pf-period"
										checked={choice.kind === "year" && choice.year === y}
										onChange={() => onChoose({ kind: "year", year: y })}
									/>
									<span>{y}</span>
								</label>
							))}
					</div>
				</fieldset>
			) : null}
			{choice.kind === "custom" ? (
				<form
					class="periods__custom"
					onSubmit={(e) => {
						e.preventDefault();
						onChoose({ kind: "custom", from, to });
					}}
				>
					<label class="field">
						<span class="field__label">Von</span>
						<input
							type="date"
							class="input"
							value={from}
							max={to}
							onInput={(e) => setFrom(e.currentTarget.value)}
						/>
					</label>
					<label class="field">
						<span class="field__label">Bis</span>
						<input
							type="date"
							class="input"
							value={to}
							min={from}
							onInput={(e) => setTo(e.currentTarget.value)}
						/>
					</label>
					<button type="submit" class="key key--lit">
						Anzeigen
					</button>
				</form>
			) : null}
		</div>
	);
}

/** Where the numbers come from, and what an import would add. */
function Coverage({ p }: { p: ListeningProfile }) {
	const c = p.coverage;
	if (c.importedPlays > 0 && c.liveSince)
		return (
			<p class="hint profile__source">
				Bis {dateWord(c.liveSince)} aus deinem importierten Spotify-Verlauf, danach von true-shuffle
				selbst gezählt, auch was du direkt in Spotify hörst.
			</p>
		);
	return (
		<p class="hint profile__source">
			{c.liveSince
				? `Gezählt seit ${dateWord(c.liveSince)}, auch was du direkt in Spotify hörst. `
				: "Was true-shuffle selbst gezählt hat. "}
			{c.summaryOnly
				? "Dein Import ist von früher: lade die Dateien noch einmal hoch, dann siehst du auch die Zeit davor in jedem Zeitraum. "
				: "Für die Zeit davor: "}
			<a href="/import">Spotify-Verlauf importieren</a>
		</p>
	);
}

function Change({ now, before }: { now: number; before: number }) {
	if (before <= 0) return null;
	const d = Math.round(((now - before) / before) * 100);
	if (d === 0) return <>genauso viel wie </>;
	return <>{d > 0 ? `${d} % mehr als ` : `${-d} % weniger als `}</>;
}

function Period({ p, choice }: { p: ListeningProfile; choice: Choice }) {
	const perDay = p.activeDays > 0 ? Math.round(p.minutes / p.activeDays) : 0;
	return (
		<>
			<section class="figures" aria-label="Auf einen Blick">
				<p class="figure figure--hero">
					<span class="figure__value">{hoursWord(p.minutes)}</span>
					<span class="figure__label">
						Musik {periodWord(choice, p)}
						{p.minutesExact
							? ", so lange lief sie wirklich"
							: ", höchstens: Songlängen zusammengezählt, wo nur der Song bekannt ist"}
						{p.previous && p.previous.minutes > 0 ? (
							<>
								{". "}
								<Change now={p.minutes} before={p.previous.minutes} />
								{beforeWord(choice)}
							</>
						) : null}
						.
					</span>
				</p>
				<p class="figure">
					<span class="figure__value">{num(p.plays)}</span>
					<span class="figure__label">Songs gehört</span>
				</p>
				<p class="figure">
					<span class="figure__value">{num(p.songs)}</span>
					<span class="figure__label">verschiedene Songs</span>
				</p>
				<p class="figure">
					<span class="figure__value">{num(p.artists)}</span>
					<span class="figure__label">Künstler</span>
				</p>
				<p class="figure">
					<span class="figure__value">{num(p.activeDays)}</span>
					<span class="figure__label">
						{choice.kind === "all" ? "Tage mit Musik" : `von ${num(p.days)} Tagen mit Musik`}
					</span>
				</p>
				<p class="figure">
					<span class="figure__value">{hoursShort(perDay)}</span>
					<span class="figure__label">an einem Tag mit Musik</span>
				</p>
				{p.albums > 0 ? (
					<p class="figure">
						<span class="figure__value">{num(p.albums)}</span>
						<span class="figure__label">Alben</span>
					</p>
				) : null}
			</section>

			<Highlights p={p} />

			{p.series.points.length > 1 ? (
				<Section title="Im Verlauf" id="pf-series">
					<Series p={p} />
				</Section>
			) : null}

			<Section title="Wann du hörst" id="pf-when">
				<HourWeek cells={p.hourWeek} />
				<DayParts cells={p.hourWeek} />
			</Section>

			<Section title="Am meisten gehört" id="pf-top">
				<h3 class="profile__sub">Künstler</h3>
				<Bars
					rows={p.topArtists.slice(0, 10)}
					by={p.minutesExact ? "minutes" : "plays"}
					value={(r) => (p.minutesExact ? hoursWord(r.minutes) : `${num(r.plays)}×`)}
				/>
				<h3 class="profile__sub">Songs</h3>
				<Songs rows={p.topSongs} />
				{p.topAlbums.length > 0 ? (
					<>
						<h3 class="profile__sub">Alben</h3>
						<Bars
							rows={p.topAlbums}
							by={p.minutesExact ? "minutes" : "plays"}
							value={(r) => (p.minutesExact ? hoursWord(r.minutes) : `${num(r.plays)}×`)}
							sub
						/>
					</>
				) : null}
			</Section>

			{choice.kind !== "all" && (p.newSongs > 0 || p.comebacks.length > 0) ? (
				<Section title="Neu und wiederentdeckt" id="pf-new">
					<p class="section__lead">
						{num(p.newSongs)} {p.newSongs === 1 ? "Song" : "Songs"} und {num(p.newArtists)}{" "}
						{p.newArtists === 1 ? "Künstler" : "Künstler"} hast du {periodWord(choice, p)} zum
						ersten Mal gehört.
					</p>
					{p.topNewArtists.length > 0 ? (
						<>
							<h3 class="profile__sub">Neu für dich</h3>
							<Bars rows={p.topNewArtists} by="plays" value={(r) => `${num(r.plays)}×`} />
						</>
					) : null}
					{p.comebacks.length > 0 ? (
						<>
							<h3 class="profile__sub">Nach langer Zeit wieder gehört</h3>
							<Songs
								rows={p.comebacks}
								note={(r) => {
									const gap = (r as ProfileItem & { gapDays: number }).gapDays;
									return gap >= 730
										? `nach ${Math.floor(gap / 365)} Jahren`
										: `nach ${num(Math.round(gap / 30))} Monaten`;
								}}
							/>
						</>
					) : null}
				</Section>
			) : null}

			{p.skips && p.skips.early > 0 ? (
				<Section title="Früh übersprungen" id="pf-skips">
					<p class="section__lead">
						{percent(p.skips.share)} der Songs aus deinem importierten Verlauf hast du in den ersten
						30 Sekunden weitergeschaltet ({num(p.skips.early)}-mal), ohne den ersten Song nach einem
						Start und ohne Überhörtes. Am häufigsten:
					</p>
					<Songs rows={p.skips.top} count={(r) => `${num(r.plays)}× weg`} />
				</Section>
			) : null}

			{p.skips && p.skips.overplayed > 0 ? (
				<Section title="Überhört" id="pf-overplayed">
					<p class="section__lead">
						Diese Songs hast du erst oft ganz gehört und erst danach früh weggeschaltet (
						{num(p.skips.overplayed)}-mal): Sie kamen wohl zu oft, nicht ungern. true-shuffle
						sortiert sie nicht aus, sondern lässt sie nach dem letzten Wegschalten drei Monate
						ruhen. Danach kommen sie wieder wie jeder andere Song.
					</p>
					<Songs rows={p.skips.topOverplayed} count={(r) => `${num(r.plays)}× weg`} />
				</Section>
			) : null}

			{p.skips && p.skips.openers > 0 ? (
				<Section title="Gleich zum Start weg" id="pf-openers">
					<p class="section__lead">
						{num(p.skips.openers)}-mal hast du den ersten Song nach einem Start gleich
						weitergeschaltet. Spotifys Shuffle beginnt gern mit denselben Songs. Das heißt nicht,
						dass du sie nicht magst, deshalb kommen sie bei true-shuffle dadurch nicht seltener. Am
						häufigsten:
					</p>
					<Songs rows={p.skips.topOpeners} count={(r) => `${num(r.plays)}× zum Start`} />
				</Section>
			) : null}

			{p.platforms.length > 0 ? (
				<Section title="Wo du hörst" id="pf-where">
					<Bars
						rows={p.platforms.map((x) => ({ ...x, sub: "", minutes: 0, imageUrl: null }))}
						by="plays"
						value={(r) => `${num(r.plays)}×`}
					/>
					<p class="hint">
						{p.shuffleShare !== null ? `${percent(p.shuffleShare)} im Zufallsmodus` : ""}
						{p.offlineShare !== null ? `, ${percent(p.offlineShare)} offline gehört` : ""}. Nur aus
						deinem importierten Verlauf: was true-shuffle selbst zählt, verrät das Gerät nicht.
					</p>
				</Section>
			) : null}
		</>
	);
}

/** The few facts that make a period its own. */
function Highlights({ p }: { p: ListeningProfile }) {
	const items: { n: string; text: string }[] = [];
	if (p.streak && p.streak.days > 1)
		items.push({
			n: `${num(p.streak.days)} Tage`,
			text: `am Stück mit Musik, vom ${keyWord(p.streak.from, false)} bis ${keyWord(p.streak.to)}.`,
		});
	if (p.longestSession && p.longestSession.minutes >= 30)
		items.push({
			n: hoursWord(p.longestSession.minutes),
			text: `Musik in deiner längsten Session am ${dateWord(p.longestSession.at)}: Song auf Song, keine Lücke über zehn Minuten.`,
		});
	const top = p.topArtists[0];
	if (top && p.plays > 0)
		items.push({
			n: percent(top.plays / p.plays),
			text: `deiner Songs waren von ${top.name}, deinem meistgehörten Künstler.`,
		});
	if (p.plays > 0)
		items.push({
			n: percent(p.songs / p.plays),
			text: "Abwechslung: so viele deiner Wiedergaben waren ein Song, den du in dieser Zeit noch nicht gehört hattest.",
		});
	if (items.length === 0) return null;
	return (
		<ul class="learned profile__highlights" aria-label="Besonderheiten">
			{items.map((x) => (
				<li key={x.text}>
					<span class="learned__n">{x.n}</span>
					<span>{x.text}</span>
				</li>
			))}
		</ul>
	);
}

/** Hours per day, week or month (or year, for a long history) as columns. */
function Series({ p }: { p: ListeningProfile }) {
	let unit: "day" | "week" | "month" | "year" = p.series.unit;
	let points = p.series.points;
	if (unit === "month" && points.length > 36) {
		const years = new Map<string, { plays: number; minutes: number }>();
		for (const x of points) {
			const y = x.key.slice(0, 4);
			const v = years.get(y) ?? { plays: 0, minutes: 0 };
			v.plays += x.plays;
			v.minutes += x.minutes;
			years.set(y, v);
		}
		points = [...years.entries()].map(([key, v]) => ({ key, ...v }));
		unit = "year";
	}
	const label = (key: string, long: boolean) => {
		if (unit === "year") return long ? key : `’${key.slice(2)}`;
		const [y, m, d] = key.split("-").map(Number);
		if (unit === "month")
			return long ? `${MONTHS_LONG[m! - 1]} ${y}` : `${MONTHS[m! - 1]} ${String(y).slice(2)}`;
		if (unit === "week") return long ? `Woche ab ${keyWord(key)}` : `${d}.${m}.`;
		return long ? keyWord(key) : `${d}.${m}.`;
	};
	const unitWord = { day: "Tag", week: "Woche", month: "Monat", year: "Jahr" }[unit];
	const strongest = {
		day: "Dein stärkster Tag",
		week: "Deine stärkste Woche",
		month: "Dein stärkster Monat",
		year: "Dein stärkstes Jahr",
	}[unit];
	const max = Math.max(1, ...points.map((x) => x.minutes));
	const top = points.reduce((a, b) => (b.minutes > a.minutes ? b : a), points[0]!);
	const every = Math.max(1, Math.ceil(points.length / 7));
	return (
		<>
			<p class="section__lead">
				{strongest}: {label(top.key, true)} mit {hoursWord(top.minutes)}.
			</p>
			<div class="cols" role="img" aria-label={`Stunden pro ${unitWord}, Tabelle darunter`}>
				{points.map((x, i) => (
					<span
						key={x.key}
						class="cols__col"
						title={`${label(x.key, true)}: ${hoursWord(x.minutes)}, ${num(x.plays)} Songs`}
					>
						<span class="cols__bar" style={{ height: `${Math.max(2, (x.minutes / max) * 100)}%` }}>
							{x === top ? (
								<span class="cols__value">{num(Math.round(x.minutes / 60))}</span>
							) : null}
						</span>
						<span class="cols__label">
							{i % every === 0 && i <= points.length - every ? label(x.key, false) : ""}
						</span>
					</span>
				))}
			</div>
			<ChartTable caption={`Hören pro ${unitWord}`}>
				<thead>
					<tr>
						<th scope="col">{unitWord}</th>
						<th scope="col">Stunden</th>
						<th scope="col">Songs</th>
					</tr>
				</thead>
				<tbody>
					{points.map((x) => (
						<tr key={x.key}>
							<th scope="row">{label(x.key, true)}</th>
							<td class="num">
								{(x.minutes / 60).toLocaleString("de-DE", { maximumFractionDigits: 1 })}
							</td>
							<td class="num">{num(x.plays)}</td>
						</tr>
					))}
				</tbody>
			</ChartTable>
		</>
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
			<ChartTable caption="Songs nach Uhrzeit (Zeilen) und Wochentag (Spalten)">
				<thead>
					<tr>
						<th scope="col">Uhr</th>
						{DAYS_SHORT.map((d, di) => (
							<th key={d} scope="col">
								<abbr title={DAYS[di]}>{d}</abbr>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{byHour.map((_v, h) => (
						<tr key={h}>
							<th scope="row">{`${h}–${h + 1}`}</th>
							{DAYS.map((d, di) => (
								<td key={d} class="num">
									{num(cells[di * 24 + h] ?? 0)}
								</td>
							))}
						</tr>
					))}
				</tbody>
				<tfoot>
					<tr>
						<th scope="row">Summe</th>
						{byDay.map((v, di) => (
							<td key={DAYS[di]} class="num">
								{num(v)}
							</td>
						))}
					</tr>
				</tfoot>
			</ChartTable>
		</>
	);
}

/** Morning, afternoon, evening and night, as shares of the period's songs. */
function DayParts({ cells }: { cells: number[] }) {
	const parts = [
		{ name: "Morgens", sub: "5–11 Uhr", hours: [5, 6, 7, 8, 9, 10] },
		{ name: "Mittags", sub: "11–17 Uhr", hours: [11, 12, 13, 14, 15, 16] },
		{ name: "Abends", sub: "17–23 Uhr", hours: [17, 18, 19, 20, 21, 22] },
		{ name: "Nachts", sub: "23–5 Uhr", hours: [23, 0, 1, 2, 3, 4] },
	].map((x) => ({
		name: x.name,
		sub: x.sub,
		plays: x.hours.reduce(
			(s, h) => s + DAYS.reduce((t, _d, d) => t + (cells[d * 24 + h] ?? 0), 0),
			0,
		),
		minutes: 0,
		imageUrl: null,
	}));
	const total = parts.reduce((s, x) => s + x.plays, 0);
	if (total === 0) return null;
	return (
		<>
			<h3 class="profile__sub">Tageszeit</h3>
			<Bars rows={parts} by="plays" value={(r) => percent(r.plays / total)} sub />
		</>
	);
}

/** Every value a chart draws, as a folded table for screen readers and exact reading. */
function ChartTable({ caption, children }: { caption: string; children: ComponentChildren }) {
	return (
		<details class="fold profile__table">
			<summary>
				<span class="fold__title">Als Tabelle</span>
			</summary>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a wide table scrolls here and must be reachable by keyboard */}
			<section class="fold__body table-wrap" tabIndex={0} aria-label={caption}>
				<table class="table">
					<caption class="sr-only">{caption}</caption>
					{children}
				</table>
			</section>
		</details>
	);
}

/** Songs with cover, numbered; ten shown, the rest one tap away. */
function Songs({
	rows,
	note,
	count = (r) => `${num(r.plays)}×`,
}: {
	rows: ProfileItem[];
	note?: (r: ProfileItem) => string;
	count?: (r: ProfileItem) => string;
}) {
	const [all, setAll] = useState(false);
	const shown = all ? rows : rows.slice(0, 10);
	return (
		<>
			<ol class="list profile-songs">
				{shown.map((s, i) => (
					<li key={`${s.id ?? s.name}-${i}`} class="profile-song">
						<span class="profile-song__n">{i + 1}</span>
						<Cover src={s.imageUrl} />
						<span class="profile-song__main">
							<span class="profile-song__title">{s.name}</span>
							<span class="profile-song__sub">
								{s.sub}
								{note ? ` · ${note(s)}` : ""}
							</span>
						</span>
						<span class="profile-song__plays">{count(s)}</span>
					</li>
				))}
			</ol>
			{rows.length > 10 && !all ? (
				<button type="button" class="key key--wide profile__more" onClick={() => setAll(true)}>
					Alle {rows.length} zeigen
				</button>
			) : null}
		</>
	);
}

/** Horizontal bars with the value at the tip. */
function Bars({
	rows,
	by,
	value,
	sub = false,
}: {
	rows: ProfileItem[];
	by: "plays" | "minutes";
	value: (r: ProfileItem) => string;
	sub?: boolean;
}) {
	const max = Math.max(1, ...rows.map((r) => r[by]));
	return (
		<ol class="hbars">
			{rows.map((r) => (
				<li key={`${r.name}\u0000${r.sub}`} class="hbars__row">
					<span class="hbars__name">
						{r.name}
						{sub && r.sub ? <span class="hbars__sub"> · {r.sub}</span> : null}
					</span>
					<span class="hbars__track">
						<span
							class="hbars__bar"
							style={{ width: `calc((100% - 4.5rem) * ${(r[by] / max).toFixed(4)})` }}
						/>
						<span class="hbars__value">{value(r)}</span>
					</span>
				</li>
			))}
		</ol>
	);
}

/** The AI's estimate of the genre mix, clearly marked as one; asked for on demand. */
function Genres({ p }: { p: ListeningProfile }) {
	const [g, setG] = useState(p.genres);
	const [retryAt, setRetryAt] = useState(p.genresRetryAt);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const ask = () => {
		setBusy(true);
		setErr(null);
		api
			.genres()
			.then((a) => {
				setG(a.estimate);
				setRetryAt(a.retryAt);
				if (a.failed) setErr("Die KI hat diesmal nichts Brauchbares geliefert.");
			})
			.catch((e: Error) => setErr(e.message))
			.finally(() => setBusy(false));
	};
	const waiting = retryAt !== null && retryAt > Date.now();
	return (
		<Section title="Deine Genres" id="pf-genres">
			{g ? (
				<>
					{g.summary ? <p class="profile__summary">{g.summary}</p> : null}
					<Bars
						rows={g.genres.map((x) => ({
							name: x.name,
							sub: "",
							plays: x.share,
							minutes: 0,
							imageUrl: null,
						}))}
						by="plays"
						value={(r) => `${Math.round(r.plays)} %`}
					/>
					<p class="hint">
						Eine Einschätzung der KI ({g.source === "anthropic" ? "Claude" : "Workers AI"}) aus
						deinen {num(g.artists)} meistgehörten Künstlern über deinen ganzen Verlauf, gewichtet
						nach Hörzeit, vom {dateWord(g.at)}. Spotify selbst nennt die Genres nicht; sie sind
						geschätzt.
					</p>
				</>
			) : (
				<p class="section__lead">
					Welche Genres du hörst, schätzt eine KI aus deinen meistgehörten Künstlern. Daraus wählt
					true-shuffle auch seine Empfehlungen.
				</p>
			)}
			{p.canEstimate ? (
				waiting ? (
					<p class="hint">
						Eine neue Einschätzung geht wieder ab {timeWord(retryAt!)}: höchstens alle sechs
						Stunden, auch wenn eine nicht geklappt hat.
					</p>
				) : (
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

function Learned({ p }: { p: ListeningProfile }) {
	return (
		<Section title="Was true-shuffle über dich weiß" id="pf-learned">
			<p class="section__lead">
				Daraus mischt true-shuffle deine Kassetten und wählt Empfehlungen aus. Das gilt immer, egal
				welcher Zeitraum oben gewählt ist.
			</p>
			<ul class="learned">
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
	);
}
