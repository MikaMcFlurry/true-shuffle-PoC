/**
 * The radio's parts: one walnut cabinet with its speaker cloth and cast
 * brass emblem; the backlit glass dial with the magic eye in its bezel and
 * the pointer on its string; the program window; the knobs; and the printed
 * pieces the pages are made of.
 */

import { Disc3, Music2, Speaker } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { PRESETS } from "../../core/mix";
import { num, SEP } from "../format";
import { back } from "../router";

/** A round on the scale: which one, how far, out of how many songs. */
export interface RoundReading {
	round: number;
	heard: number | null;
	total: number | null;
}

const WIDE = "(min-width: 980px)";

/** True where the radio is laid out as the landscape table radio, its card and sheet beside or below it. */
export function useWide(): boolean {
	const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
	useEffect(() => {
		const mq = window.matchMedia(WIDE);
		const on = () => setWide(mq.matches);
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, []);
	return wide;
}

// ------------------------------------------------------------ magic eye

/**
 * The magic eye (an EM tube): a green fan with a dark shadow. The shadow
 * closes when a station is tuned in, opens wide when nothing is received.
 * `tuning` plays the tuning sweep once: it opens, closes on the station,
 * opens a little as the pointer runs past, and settles.
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
 * The cabinet, one object: walnut under lacquer; the speaker cloth with the
 * maker's emblem in cast brass letters and the trim bars level with its
 * hyphen; the dial with the magic eye seated in its bezel; the program
 * window; one keyboard and the knobs; the plinth it stands on. On a phone
 * the screen is its face in close-up, edge to edge; a desktop shows the
 * whole landscape table radio standing on its feet.
 */
export function Cabinet(props: {
	eye: Eye;
	/** Changes on every new tuning, so the eye plays its sweep again. */
	eyeKey?: string | number;
	dial: ComponentChildren;
	window?: ComponentChildren;
	extra?: ComponentChildren;
	left?: ComponentChildren;
	right?: ComponentChildren;
	keys?: ComponentChildren;
	/** The face fills a phone's screen; spare height goes to the speaker cloth. */
	fill?: boolean;
}) {
	// On a desktop the radio stands on a sideboard that runs from the window's
	// left edge to the sheet beside it (or across the whole window when the
	// sheet lies below): measure how far that is on either side.
	const root = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const el = root.current;
		if (!el) return;
		const measure = () => {
			const r = el.getBoundingClientRect();
			const side = document.querySelector<HTMLElement>(".side")?.getBoundingClientRect();
			const end =
				side && side.left >= r.right - 1 ? side.left : document.documentElement.clientWidth;
			el.style.setProperty("--board-l", `${Math.max(0, Math.ceil(r.left))}px`);
			el.style.setProperty("--board-r", `${Math.max(0, Math.floor(end - r.right))}px`);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		ro.observe(document.documentElement);
		window.addEventListener("resize", measure);
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, []);
	return (
		<div ref={root} class={`cabinet${props.fill ? " cabinet--fill" : ""}`}>
			<div class="cabinet__body">
				<div class="cabinet__cloth">
					{/* Cast brass letters on the cloth; the trim bars run level with the hyphen. */}
					<h1 class="emblem">true-shuffle</h1>
				</div>
				{/* The magic eye is seated in the dial's bezel: at the head of the pointer's scale on a
				    phone, in its own brass-rimmed end cell beside the stations on a desktop. */}
				<div class="cabinet__dial">
					{props.dial}
					<span class="cabinet__eye">
						<MagicEye key={props.eyeKey} state={props.eye} />
					</span>
				</div>
				{props.window ? <div class="cabinet__window">{props.window}</div> : null}
				{props.extra ? <div class="cabinet__extra">{props.extra}</div> : null}
				{props.left || props.right || props.keys ? (
					// Keys first: on a phone they sit above the knobs, and focus follows what the eye sees.
					<div class="cabinet__base">
						{props.keys ? <div class="cabinet__keys">{props.keys}</div> : null}
						{props.left ? <div class="cabinet__knob cabinet__knob--l">{props.left}</div> : null}
						{props.right ? <div class="cabinet__knob cabinet__knob--r">{props.right}</div> : null}
					</div>
				) : null}
			</div>
			<div class="cabinet__plinth" aria-hidden="true">
				<span class="cabinet__foot cabinet__foot--l" />
				<span class="cabinet__foot cabinet__foot--r" />
			</div>
		</div>
	);
}

// ----------------------------------------------------------------- dial

export type Indicator = "Ungehört" | "Favorit" | "Entdeckung" | "Gast" | "Pause";

const LAMPS: Indicator[] = ["Ungehört", "Favorit", "Entdeckung", "Gast", "Pause"];

/**
 * The glass dial. Stations carry `data-at`; the pointer stands on the one
 * named by `at` and glides there on its string when it changes. On a phone
 * the dial is a vertical scale: names down the left, the pointer riding a
 * string on the right beside the lit name. On a desktop it is the wide
 * horizontal dial with the pointer crossing the bands.
 */
export function Dial(props: {
	label: string;
	at: string | null;
	/** Sweep across the whole dial (Suchlauf, switching on). */
	sweep?: boolean;
	lamps?: Indicator[] | null;
	/** Told the glass's printable width, so the stations can be set in bands that fit. */
	onFieldWidth?: (px: number) => void;
	children: ComponentChildren;
}) {
	const field = useRef<HTMLDivElement>(null);
	const at = useRef(props.at);
	at.current = props.at;
	const [ready, setReady] = useState(false);

	const width = useRef(props.onFieldWidth);
	width.current = props.onFieldWidth;
	const place = useRef(() => {});
	place.current = () => {
		const f = field.current;
		if (!f) return;
		const row = at.current ? f.querySelector<HTMLElement>(`[data-at="${at.current}"]`) : null;
		const name = row?.querySelector<HTMLElement>(".station__name") ?? null;
		const band = row?.closest<HTMLElement>(".band") ?? null;
		const box = f.getBoundingClientRect();
		const s = f.style;
		if (row && name) {
			const r = row.getBoundingClientRect();
			const n = name.getBoundingClientRect();
			s.setProperty("--px", `${Math.round(n.left + n.width / 2 - box.left)}px`);
			s.setProperty("--py", `${Math.round(r.top + r.height / 2 - box.top)}px`);
			if (band) {
				const b = band.getBoundingClientRect();
				s.setProperty("--seg-top", `${Math.round(b.top - box.top)}px`);
				s.setProperty("--seg-h", `${Math.round(b.height)}px`);
			}
			s.setProperty("--seg-o", "1");
		} else {
			s.removeProperty("--px");
			s.removeProperty("--py");
			s.setProperty("--seg-o", "0");
		}
	};

	// Every render may move the names (a lit name is set heavier): measure
	// again now, and once more after the browser has laid the frame out.
	useLayoutEffect(() => {
		place.current();
		const r = requestAnimationFrame(() => place.current());
		return () => cancelAnimationFrame(r);
	});

	useEffect(() => {
		const f = field.current;
		if (!f) return;
		const again = () => place.current();
		// Anything that can move a name: a resize, a font arriving, a station lit or dimmed.
		const ro = new ResizeObserver(() => {
			const cs = getComputedStyle(f);
			width.current?.(
				f.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight),
			);
			again();
		});
		ro.observe(f);
		const mo = new MutationObserver(again);
		mo.observe(f, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
		window.addEventListener("resize", again);
		document.fonts?.addEventListener("loadingdone", again);
		void document.fonts?.ready.then(again);
		// The first placement is where the pointer already stands; later ones glide.
		const t = window.setTimeout(() => setReady(true), 150);
		return () => {
			ro.disconnect();
			mo.disconnect();
			window.removeEventListener("resize", again);
			document.fonts?.removeEventListener("loadingdone", again);
			window.clearTimeout(t);
		};
	}, []);

	return (
		<section
			class={`dial${ready ? " dial--ready" : ""}${props.sweep ? " dial--sweep" : ""}`}
			aria-label={props.label}
			data-pointer={props.at ?? undefined}
		>
			<div class="dial__glass">
				<div class="dial__field" ref={field}>
					<span class="dial__string" aria-hidden="true" />
					<span class="dial__pointer" aria-hidden="true">
						<span class="dial__needle" />
					</span>
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

// ------------------------------------------------------ program window

/** The song's cover in the window, or a drawn record when there is none. */
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

/** A window cut into the cabinet: brass bezel, four screws, paper behind it. */
export function Window(props: { label?: string; live?: boolean; children: ComponentChildren }) {
	return (
		<section class="window" aria-label={props.label} aria-live={props.live ? "polite" : undefined}>
			<div class="window__paper">{props.children}</div>
			<span class="screw screw--tl" aria-hidden="true" />
			<span class="screw screw--tr" aria-hidden="true" />
			<span class="screw screw--bl" aria-hidden="true" />
			<span class="screw screw--br" aria-hidden="true" />
		</section>
	);
}

/**
 * The program card seated behind the window: what song, why it plays, how
 * far the round is. It is the radio's "Anzeige". The lit dial already names
 * the station; the card names it once more at its foot, as the way to set it up.
 */
export function ProgramCard(props: {
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
	/** The foot of the card: a way to set the station up, a key to play a selection. */
	foot?: ComponentChildren;
}) {
	const r = props.reading;
	const pos = Math.min(1, Math.max(0, props.pos ?? 0));
	return (
		<Window label="Anzeige" live={props.live}>
			<div class={`card${props.art ? " card--art" : ""}`}>
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
				{r || props.foot ? (
					<div class="card__base">
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
						{props.foot ? <div class="card__foot">{props.foot}</div> : null}
					</div>
				) : null}
			</div>
		</Window>
	);
}

// ---------------------------------------------------------------- knobs

/**
 * A bakelite knob in a brass ring. It is a slider: arrow keys, Page keys,
 * Home and End; a drag turns it a step per notch. Where `tapSteps` is set,
 * a tap on its left or right half turns it one notch that way; otherwise a
 * tap does nothing, so a stray touch never changes anything. Turning never
 * does more than move the value.
 */
export function Knob(props: {
	label: string;
	min: number;
	max: number;
	step: number;
	value: number;
	valueText: string;
	angle: (v: number) => number;
	onChange: (v: number) => void;
	disabled?: boolean;
	/** Printed ticks round the knob, as angles. */
	ticks?: number[];
	/** Pixels of drag per notch. */
	pitch?: number;
	/** A tap on either half turns one notch. */
	tapSteps?: boolean;
	/** Report a turn even to the value it already has (a selection that is not yet made). */
	emitSame?: boolean;
	/** Told when a pointer takes the knob (it holds that pointer) and when it lets go. */
	onGrab?: (on: boolean) => void;
}) {
	const cur = useRef(props.value);
	cur.current = props.value;
	const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
	const pitch = props.pitch ?? 14;
	const set = (v: number) => {
		const c = Math.min(props.max, Math.max(props.min, v));
		if (c === cur.current && !props.emitSame) return;
		cur.current = c;
		props.onChange(c);
	};
	const nudge = (n: number) => set(cur.current + n * props.step);
	const onKeyDown = (e: KeyboardEvent) => {
		if (props.disabled) return;
		const k = e.key;
		if (k === "ArrowRight" || k === "ArrowUp") nudge(1);
		else if (k === "ArrowLeft" || k === "ArrowDown") nudge(-1);
		else if (k === "PageUp") nudge(4);
		else if (k === "PageDown") nudge(-4);
		else if (k === "Home") set(props.min);
		else if (k === "End") set(props.max);
		else return;
		e.preventDefault();
	};
	return (
		<div
			class={`knob${props.disabled ? " knob--off" : ""}`}
			role="slider"
			tabIndex={0}
			aria-label={props.label}
			aria-valuemin={props.min}
			aria-valuemax={props.max}
			aria-valuenow={props.value}
			aria-valuetext={props.valueText}
			aria-disabled={props.disabled || undefined}
			onKeyDown={onKeyDown}
			onPointerDown={(e) => {
				if (props.disabled || e.button !== 0) return;
				(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
				drag.current = { x: e.clientX, y: e.clientY, moved: false };
				props.onGrab?.(true);
			}}
			// Up, cancelled or taken away: the capture ends every way the hand can leave.
			onLostPointerCapture={() => props.onGrab?.(false)}
			onPointerMove={(e) => {
				const d = drag.current;
				if (!d) return;
				const steps = Math.trunc((e.clientX - d.x - (e.clientY - d.y)) / pitch);
				if (steps !== 0) {
					nudge(steps);
					drag.current = { x: e.clientX, y: e.clientY, moved: true };
				}
			}}
			onPointerUp={(e) => {
				const d = drag.current;
				drag.current = null;
				if (!d || d.moved || !props.tapSteps) return;
				const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
				nudge(e.clientX < r.left + r.width / 2 ? -1 : 1);
			}}
			onPointerCancel={() => {
				drag.current = null;
			}}
		>
			{props.ticks ? (
				<svg class="knob__ticks" viewBox="-50 -50 100 100" aria-hidden="true">
					{props.ticks.map((a) => (
						<line key={a} x1="0" y1="-49" x2="0" y2="-43" transform={`rotate(${a})`} />
					))}
				</svg>
			) : null}
			<span class="knob__ring">
				<span class="knob__cap" style={{ "--turn": `${props.angle(props.value)}deg` }} />
			</span>
		</div>
	);
}

const MIX_DETENTS = [
	["Entdecker", PRESETS.entdecker, "l"],
	["Ausgewogen", PRESETS.ausgewogen, "c"],
	["Vertraut", PRESETS.vertraut, "r"],
] as const;

/** The Klang knob turns from -120° (all discovery) to +70°, the presets at -70°, 0° and +70°. */
function mixAngle(v: number): number {
	const e = PRESETS.entdecker;
	const a = PRESETS.ausgewogen;
	if (v <= e) return -120 + (50 * v) / e;
	if (v <= a) return -70 + (70 * (v - e)) / (a - e);
	return (70 * (v - a)) / (100 - a);
}

/**
 * "Klang": the station's Entdecken ↔ Vertraut, as a knob with three
 * printed detents that are keys of their own.
 */
export function MixKnob(props: {
	/** null: no station to turn (the knob rests, no detent lit). */
	value: number | null;
	valueText: string;
	station: string | null;
	onChange: (v: number) => void;
	disabled?: boolean;
	/** Print the station the knob turns under it (on the radio, where it can change). */
	showTarget?: boolean;
	/**
	 * Told when the knob is taken in hand (focused, or turned by a pointer it
	 * holds) and when it is let go again. A touch that only scrolls past never
	 * takes it.
	 */
	onHold?: (on: boolean) => void;
}) {
	const off = props.disabled || props.value === null;
	const focused = useRef(false);
	const grabbed = useRef(false);
	const held = useRef(false);
	const tell = () => {
		const on = focused.current || grabbed.current;
		if (on === held.current) return;
		held.current = on;
		props.onHold?.(on);
	};
	return (
		<div
			class="knob-unit knob-unit--mix"
			onFocusIn={() => {
				focused.current = true;
				tell();
			}}
			onFocusOut={(e) => {
				const to = e.relatedTarget as Node | null;
				if (to && (e.currentTarget as HTMLElement).contains(to)) return;
				focused.current = false;
				tell();
			}}
		>
			<div class="detents">
				{MIX_DETENTS.map(([label, v, pos]) => (
					<button
						key={label}
						type="button"
						class={`detent detent--${pos}`}
						aria-pressed={!off && props.value === v}
						disabled={off}
						onClick={() => props.onChange(v)}
					>
						{label}
					</button>
				))}
			</div>
			<Knob
				label={props.station ? `Klang für ${props.station}: Entdecken oder Vertraut` : "Klang"}
				min={0}
				max={100}
				step={5}
				value={props.value ?? 0}
				valueText={props.valueText}
				angle={(v) => (props.value === null ? -25 : mixAngle(v))}
				onChange={props.onChange}
				disabled={off}
				ticks={[-120, -95, -70, -35, 0, 35, 70]}
				onGrab={(on) => {
					grabbed.current = on;
					tell();
				}}
			/>
			<span class="knob-unit__name" aria-hidden="true">
				Klang
				{props.showTarget && props.station ? (
					<span class="knob-unit__target">{props.station}</span>
				) : null}
			</span>
		</div>
	);
}

/**
 * Klang printed on a program sheet, where no knob belongs: the knob's three
 * detents as a printed scale, Entdecker · Ausgewogen · Vertraut, the chosen
 * one set bold with a short red tick under it. Native radios underneath, so
 * the arrow keys move the choice. A mix turned between detents on the radio
 * marks no position (the readout above prints it), so any choice here snaps
 * it to that detent's value.
 */
export function MixScale(props: { value: number; station: string; onChange: (v: number) => void }) {
	return (
		<fieldset class="mixscale">
			<legend class="sr-only">Klang für {props.station}: Entdecken oder Vertraut</legend>
			{MIX_DETENTS.map(([label, v]) => (
				<label key={label} class="mixscale__opt">
					<input
						type="radio"
						name={`mix-${props.station}`}
						value={String(v)}
						checked={props.value === v}
						onChange={() => props.onChange(v)}
					/>
					<span class="mixscale__label">{label}</span>
					<span class="mixscale__tick" aria-hidden="true" />
				</label>
			))}
		</fieldset>
	);
}

/**
 * A detent selector: printed positions, a lamp lit over the one that is
 * set. Radio inputs underneath, so arrow keys and screen readers work.
 */
export function Detents<T extends string>(props: {
	name: string;
	legend: string;
	options: readonly (readonly [T, string])[];
	value: T;
	onChange: (v: T) => void;
}) {
	return (
		<fieldset class="detentsel">
			<legend class="detentsel__legend">{props.legend}</legend>
			<div class="detentsel__row">
				{props.options.map(([v, label]) => (
					<label key={v} class="detentsel__opt">
						<input
							type="radio"
							name={props.name}
							value={v}
							checked={props.value === v}
							onChange={() => props.onChange(v)}
						/>
						<span class="detentsel__lamp" aria-hidden="true" />
						<span class="detentsel__label">{label}</span>
					</label>
				))}
			</div>
		</fieldset>
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
				<button type="button" class="key key--back" onClick={() => back(props.backTo ?? "/")}>
					Zurück
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

/**
 * A section of a program sheet: its head runs into the first line, the way
 * a printed program sets "Mischung. ≈ 60 % ungehört …".
 */
export function Section(props: {
	title: string;
	children?: ComponentChildren;
	id?: string;
	/** Text that follows the run-in head on its line. */
	lead?: ComponentChildren;
}) {
	return (
		<section class="section" aria-labelledby={props.id}>
			<div class="runin">
				<h2 class="runin__head" id={props.id}>
					{props.title}
				</h2>
				{props.lead ? <span class="runin__lead">{props.lead}</span> : null}
			</div>
			{props.children}
		</section>
	);
}
