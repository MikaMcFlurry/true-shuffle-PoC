/**
 * The radio's parts: display, tuner scale, keys, covers.
 */

import { ChevronLeft, Disc3, Music2, Speaker } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { num } from "../format";
import { back } from "../router";

/** A round on the scale: which one, how far, out of how many songs. */
export interface RoundReading {
	round: number;
	heard: number | null;
	total: number | null;
}

// The scale's graduation, drawn once: minor ticks every 2 %, majors every 10 %.
const MINOR = Array.from({ length: 51 }, (_, i) => i)
	.filter((i) => i % 5 !== 0)
	.map((i) => `M${i * 2} 12V7`)
	.join("");
const MAJOR = Array.from({ length: 11 }, (_, i) => `M${i * 10} 12V1`).join("");

export function Scale(props: {
	pos: number;
	tuning?: boolean;
	label?: string;
	/** Numbered majors (0 … total) and the round's readout under the band. */
	reading?: RoundReading | null;
}) {
	const pos = Math.min(1, Math.max(0, Number.isFinite(props.pos) ? props.pos : 0));
	const r = props.reading;
	const total = r?.total ?? null;
	return (
		<div class={`scale-unit${r ? " scale-unit--read" : ""}`}>
			<div
				class={`scale${props.tuning ? " scale--tuning" : ""}`}
				style={{ "--pos": String(pos) }}
				role="img"
				aria-label={props.label}
			>
				<svg
					class="scale__ticks"
					viewBox="0 0 100 12"
					preserveAspectRatio="none"
					aria-hidden="true"
				>
					<path class="scale__minor" d={MINOR} />
					<path class="scale__major" d={MAJOR} />
				</svg>
				<div class="scale__base" />
				<div class="scale__fill" />
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

/** The cover in the display window, with the light it casts onto the glass. */
function DisplayArt({ src }: { src: string | null }) {
	const [failed, setFailed] = useState<string | null>(null);
	if (src === null || failed === src) {
		return (
			<div class="display__art" aria-hidden="true">
				<span class="display__cover display__cover--empty">
					<Disc3 class="display__disc" aria-hidden="true" />
				</span>
			</div>
		);
	}
	return (
		<div class="display__art" aria-hidden="true">
			<img key={`glow-${src}`} class="display__glow" src={src} alt="" decoding="async" />
			<img
				key={src}
				class="display__cover"
				src={src}
				alt=""
				decoding="async"
				onError={() => setFailed(src)}
			/>
		</div>
	);
}

export type Indicator = "UNGEHÖRT" | "FAVORIT" | "ENTDECKUNG" | "GAST" | "PAUSE";

const ALL: Indicator[] = ["UNGEHÖRT", "FAVORIT", "ENTDECKUNG", "GAST", "PAUSE"];

export function Display(props: {
	lit: Indicator[];
	device?: string | null;
	name: string;
	nameGhost?: boolean;
	song?: ComponentChildren;
	artist?: ComponentChildren;
	/** Song time, shown with the song — not beside the round's scale. */
	time?: string | null;
	line?: ComponentChildren;
	message?: { text: string; tone: "info" | "warn" | "error" } | null;
	scale?: { pos: number; label: string; reading?: RoundReading | null } | null;
	/** Cover beside the song. Omitted: not a song, no slot. `src: null`: the drawn stand-in. */
	art?: { src: string | null } | null;
	tuning?: boolean;
	live?: boolean;
	/** Let song and artist wrap (sign-in copy), instead of clamping them. */
	wrap?: boolean;
}) {
	const hasText = !!(props.song || props.artist || props.time || props.device);
	return (
		<section
			class={`display${props.art ? " display--art" : ""}${props.tuning ? " display--tuning" : ""}${props.wrap ? " display--wrap" : ""}`}
			aria-label="Anzeige"
			aria-live={props.live ? "polite" : undefined}
		>
			<div class="display__ind">
				{ALL.map((i) => (
					<span
						key={i}
						class={`seg${props.lit.includes(i) ? " on" : ""}`}
						aria-hidden={!props.lit.includes(i)}
					>
						{i}
					</span>
				))}
			</div>
			<p class="display__name">
				<span class={props.nameGhost ? "ghost" : ""}>{props.name}</span>
			</p>
			{props.art ? <DisplayArt src={props.art.src} /> : null}
			{hasText ? (
				<div class="display__text">
					{props.song ? <div class="display__song">{props.song}</div> : null}
					{props.artist ? <div class="display__artist">{props.artist}</div> : null}
					{props.time || props.device ? (
						<div class="display__meta">
							{props.time ? (
								// Ticks every second: never announced.
								<span class="num display__time" aria-live="off">
									{props.time}
								</span>
							) : null}
							{props.device ? (
								<span class="display__device">
									<Speaker class="display__devicon" aria-hidden="true" />
									<span>{props.device}</span>
								</span>
							) : null}
						</div>
					) : null}
				</div>
			) : null}
			{props.message ? (
				<div
					class={`display__msg${props.message.tone === "error" ? " display__msg--error" : ""}`}
					role="status"
				>
					{props.message.text}
				</div>
			) : props.line ? (
				<div class="display__line">{props.line}</div>
			) : null}
			{props.scale ? (
				<Scale
					pos={props.scale.pos}
					tuning={props.tuning}
					label={props.scale.label}
					reading={props.scale.reading}
				/>
			) : null}
		</section>
	);
}

/**
 * A page's head: the back key and a small display window naming the page,
 * the way a radio's menu shows where you are on its display.
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
		<header class="page__bar">
			{props.noBack ? null : (
				<button
					type="button"
					class="key page__back"
					onClick={() => back(props.backTo ?? "/")}
					aria-label="Zurück"
				>
					<ChevronLeft class="icon" aria-hidden="true" />
				</button>
			)}
			<div class="page__lcd">
				<h1 class="page__title">{props.title}</h1>
				{props.sub ? <p class="page__sub">{props.sub}</p> : null}
				{props.children}
			</div>
			{props.action}
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
