/**
 * The radio's parts: the walnut cabinet with its speaker cloth, badge and
 * magic eye; the backlit glass dial with its pointer; the program card; and
 * the printed pieces the pages are made of (sheet head, sections, covers,
 * the printed round scale).
 */

import { ChevronLeft, Disc3, Music2, Speaker } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { num, SEP } from "../format";
import { back } from "../router";

/** A round on the scale: which one, how far, out of how many songs. */
export interface RoundReading {
	round: number;
	heard: number | null;
	total: number | null;
}

// ------------------------------------------------------------ magic eye

/**
 * The magic eye (an EM tube): a green fan with a dark shadow. The shadow
 * closes when a station is tuned in, opens wide when nothing is received.
 * `tuning` plays the tuning sweep once: it opens, closes on the station,
 * opens a little as the pointer overshoots, and settles.
 */
export type Eye = "off" | "open" | "weak" | "tuned" | "tuning";

export function MagicEye({ state }: { state: Eye }) {
	return (
		<span class={`eye eye--${state}`} aria-hidden="true">
			<span class="eye__lens">
				<span class="eye__fan eye__fan--a" />
				<span class="eye__fan eye__fan--b" />
				<span class="eye__cap" />
			</span>
		</span>
	);
}

// -------------------------------------------------------------- cabinet

/**
 * The cabinet: walnut, a brass trim, the speaker cloth with the badge and
 * the magic eye, and the front with whatever the screen needs below it.
 */
export function Cabinet(props: {
	eye: Eye;
	/** Changes on every new tuning, so the eye plays its sweep again. */
	eyeKey?: string | number;
	children: ComponentChildren;
}) {
	return (
		<div class="cabinet">
			<div class="cabinet__cloth">
				<h1 class="badge">true-shuffle</h1>
				<MagicEye key={props.eyeKey} state={props.eye} />
			</div>
			<div class="cabinet__front">{props.children}</div>
		</div>
	);
}

// ----------------------------------------------------------------- dial

export type Indicator = "Ungehört" | "Favorit" | "Entdeckung" | "Gast" | "Pause";

const LAMPS: Indicator[] = ["Ungehört", "Favorit", "Entdeckung", "Gast", "Pause"];

/** Where the pointer rests when no station is tuned: the dial's left end. */
const REST = 18;

/**
 * The glass dial. Whatever is printed on it goes in `children`; stations
 * carry `data-at` and a `.station__name`, and the pointer stands on the one
 * named by `at`, gliding there on its string when it changes.
 */
export function Dial(props: {
	label: string;
	at: string | null;
	/** Sweep across the whole dial (Suchlauf, switching on). */
	sweep?: boolean;
	lamps?: Indicator[] | null;
	children: ComponentChildren;
}) {
	const field = useRef<HTMLDivElement>(null);
	const at = useRef(props.at);
	at.current = props.at;
	const [ready, setReady] = useState(false);

	const place = useRef(() => {});
	place.current = () => {
		const f = field.current;
		if (!f) return;
		const target = at.current
			? f.querySelector<HTMLElement>(`[data-at="${at.current}"] .station__name`)
			: null;
		let x = REST;
		if (target) {
			const box = f.getBoundingClientRect();
			const r = target.getBoundingClientRect();
			x = r.left + r.width / 2 - box.left;
		}
		f.style.setProperty("--x", `${Math.round(x)}px`);
	};

	// Every render may move the names (a lit name is set heavier): measure again.
	useLayoutEffect(() => place.current());

	useEffect(() => {
		const f = field.current;
		if (!f) return;
		const ro = new ResizeObserver(() => place.current());
		ro.observe(f);
		void document.fonts?.ready.then(() => place.current());
		// The first placement is where the pointer already stands; later ones glide.
		const t = window.setTimeout(() => setReady(true), 120);
		return () => {
			ro.disconnect();
			window.clearTimeout(t);
		};
	}, []);

	return (
		<section
			class={`dial${ready ? " dial--ready" : ""}${props.sweep ? " dial--sweep" : ""}`}
			aria-label={props.label}
		>
			<div class="dial__glass">
				<div class="dial__field" ref={field}>
					<span class="dial__string" aria-hidden="true" />
					<span class="dial__pointer" aria-hidden="true" />
					{props.children}
				</div>
				{props.lamps ? (
					<p class="dial__lamps">
						{LAMPS.map((i) => {
							const on = props.lamps?.includes(i) ?? false;
							return (
								<span key={i} class={`seg${on ? " on" : ""}`} aria-hidden={!on}>
									{i}
								</span>
							);
						})}
					</p>
				) : null}
			</div>
		</section>
	);
}

/** Words printed on the dial instead of stations: sign-in, switching on, a fault, Suchlauf. */
export function DialText(props: {
	title: ComponentChildren;
	sub?: ComponentChildren;
	message?: { text: string; tone: "info" | "warn" | "error" } | null;
}) {
	return (
		<div class="dial__text">
			<p class="dial__title">{props.title}</p>
			{props.sub ? <p class="dial__sub">{props.sub}</p> : null}
			{props.message ? (
				<p
					class={`dial__msg${props.message.tone === "error" ? " dial__msg--error" : ""}`}
					role="status"
				>
					{props.message.text}
				</p>
			) : null}
			<span class="dial__scale" aria-hidden="true" />
		</div>
	);
}

/** A station name may break after a slash ("Rock/Metall"), never inside a word. */
export function Breakable({ text }: { text: string }) {
	const parts = text.split("/");
	return (
		<>
			{parts.map((p, i) => (
				<span key={i}>
					{p}
					{i < parts.length - 1 ? (
						<>
							/<wbr />
						</>
					) : null}
				</span>
			))}
		</>
	);
}

// --------------------------------------------------------- program card

/** The song's cover on the program card, or a drawn record when there is none. */
function CardArt({ src }: { src: string | null }) {
	const [failed, setFailed] = useState<string | null>(null);
	if (src === null || failed === src) {
		return (
			<span class="card__art card__art--empty" aria-hidden="true">
				<Disc3 class="card__disc" aria-hidden="true" />
			</span>
		);
	}
	return (
		<img
			key={src}
			class="card__art"
			src={src}
			alt=""
			decoding="async"
			onError={() => setFailed(src)}
		/>
	);
}

/**
 * The program card behind its brass frame: which station, what song, why it
 * plays, and how far the round is. It is the radio's "Anzeige".
 */
export function ProgramCard(props: {
	station: string | null;
	/** A name that is not a station (idle, Spotify outside a station) prints quieter. */
	quiet?: boolean;
	song?: ComponentChildren;
	artist?: ComponentChildren;
	time?: string | null;
	device?: string | null;
	line?: ComponentChildren;
	message?: { text: string; tone: "info" | "warn" | "error" } | null;
	reading?: RoundReading | null;
	pos?: number | null;
	art?: { src: string | null } | null;
	live?: boolean;
}) {
	const r = props.reading;
	const pos = Math.min(1, Math.max(0, props.pos ?? 0));
	return (
		<section
			class={`card${props.art ? " card--art" : ""}`}
			aria-label="Anzeige"
			aria-live={props.live ? "polite" : undefined}
		>
			<div class="card__paper">
				{props.station ? (
					<p class={`card__station${props.quiet ? " card__station--quiet" : ""}`}>
						{props.station}
					</p>
				) : null}
				{props.art ? <CardArt src={props.art.src} /> : null}
				<div class="card__text">
					{props.song ? <p class="card__song">{props.song}</p> : null}
					{props.artist ? <p class="card__artist">{props.artist}</p> : null}
					{props.time || props.device ? (
						<p class="card__meta">
							{props.time ? (
								// Ticks every second: never announced.
								<span class="num card__time" aria-live="off">
									{props.time}
								</span>
							) : null}
							{props.device ? (
								<span class="card__device">
									<Speaker class="card__devicon" aria-hidden="true" />
									<span>{props.device}</span>
								</span>
							) : null}
						</p>
					) : null}
				</div>
				{props.message ? (
					<p
						class={`card__msg${props.message.tone === "error" ? " card__msg--error" : ""}`}
						role="status"
					>
						{props.message.text}
					</p>
				) : props.line ? (
					<p class="card__line">{props.line}</p>
				) : null}
				{r ? (
					<div class="card__round">
						<p class="num">
							Runde {r.round}
							{r.heard !== null && r.total !== null
								? `${SEP}${num(r.heard)} von ${num(r.total)} gehört`
								: `${SEP}zählt ab dem ersten Song`}
						</p>
						<span class="card__rule" style={{ "--pos": String(pos) }} aria-hidden="true" />
					</div>
				) : null}
			</div>
		</section>
	);
}

// ------------------------------------------------------ printed scale

// The graduation, drawn once: minor ticks every 2 %, majors every 10 %.
const MINOR = Array.from({ length: 51 }, (_, i) => i)
	.filter((i) => i % 5 !== 0)
	.map((i) => `M${i * 2} 12V8`)
	.join("");
const MAJOR = Array.from({ length: 11 }, (_, i) => `M${i * 10} 12V3`).join("");

/** A round printed as a tuning scale on the program sheet, with a red needle. */
export function Scale(props: {
	pos: number;
	label?: string;
	/** Numbered majors (0 … total) and the round's readout under the band. */
	reading?: RoundReading | null;
}) {
	const pos = Math.min(1, Math.max(0, Number.isFinite(props.pos) ? props.pos : 0));
	const r = props.reading;
	const total = r?.total ?? null;
	return (
		<div class="scale-unit">
			<div class="scale" style={{ "--pos": String(pos) }} role="img" aria-label={props.label}>
				<svg
					class="scale__ticks"
					viewBox="0 0 100 12"
					preserveAspectRatio="none"
					aria-hidden="true"
				>
					<path class="scale__minor" d={MINOR} />
					<path class="scale__major" d={MAJOR} />
				</svg>
				<div class="scale__track">
					<div class="scale__needle" />
				</div>
			</div>
			{r && total !== null && total > 0 ? (
				<div class="scale__majors num" aria-hidden="true">
					{[0, 0.25, 0.5, 0.75, 1].map((f) => (
						<span key={f}>{num(Math.round(total * f))}</span>
					))}
				</div>
			) : null}
			{r ? (
				<div class="scale__reading" aria-hidden="true">
					<span>Runde {r.round}</span>
					{r.heard !== null && total !== null ? (
						<span class="num">
							{num(r.heard)} von {num(total)} gehört
						</span>
					) : (
						<span>zählt ab dem ersten Song</span>
					)}
				</div>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------- covers

/**
 * A song's cover, or a drawn stand-in when there is none or it fails to
 * load. Always decorative: title and artist sit right beside it.
 */
export function Cover(props: { src: string | null | undefined; class?: string }) {
	const [failed, setFailed] = useState<string | null>(null);
	const cls = props.class ? `cover ${props.class}` : "cover";
	const src = props.src;
	if (!src || failed === src) {
		return (
			<span class={`${cls} cover--empty`} aria-hidden="true">
				<Music2 class="cover__icon" aria-hidden="true" />
			</span>
		);
	}
	return (
		<img
			class={cls}
			src={src}
			alt=""
			loading="lazy"
			decoding="async"
			onError={() => setFailed(src)}
		/>
	);
}

// ------------------------------------------------------- program sheets

/**
 * A page's head, printed at the top of its sheet: a small key back to where
 * the listener came from, the title, a line under it.
 */
export function PageBar(props: {
	title: ComponentChildren;
	sub?: ComponentChildren;
	backTo?: string;
	action?: ComponentChildren;
	/** Shown beside the radio on a desktop, where there is nothing to go back to. */
	noBack?: boolean;
	children?: ComponentChildren;
}) {
	return (
		<header class="masthead">
			{props.noBack ? null : (
				<button
					type="button"
					class="key key--back"
					onClick={() => back(props.backTo ?? "/")}
					aria-label="Zurück"
				>
					<ChevronLeft class="icon" aria-hidden="true" />
					<span aria-hidden="true">Zurück</span>
				</button>
			)}
			<div class="masthead__plate">
				<h1 class="masthead__title">{props.title}</h1>
				{props.sub ? <p class="masthead__sub">{props.sub}</p> : null}
			</div>
			{props.action}
			{props.children}
		</header>
	);
}

export function Section(props: { title: string; children: ComponentChildren; id?: string }) {
	return (
		<section class="section" aria-labelledby={props.id}>
			<h2 class="section__head" id={props.id}>
				{props.title}
			</h2>
			{props.children}
		</section>
	);
}
