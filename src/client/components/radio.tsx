/**
 * The radio's parts: display, tuner scale, keys.
 */

import { ChevronLeft } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { num } from "../format";
import { back } from "../router";

/** A round on the scale: which one, how far, out of how many songs. */
export interface RoundReading {
	round: number;
	heard: number | null;
	total: number | null;
}

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
				<div class="scale__ticks" />
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

export type Indicator = "NEU" | "FAVORIT" | "ENTDECKUNG" | "GAST" | "PAUSE";

const ALL: Indicator[] = ["NEU", "FAVORIT", "ENTDECKUNG", "GAST", "PAUSE"];

export function Display(props: {
	lit: Indicator[];
	device?: string | null;
	name: string;
	nameGhost?: boolean;
	song?: ComponentChildren;
	artist?: ComponentChildren;
	/** Song time, shown beside the artist — not beside the round's scale. */
	time?: string | null;
	line?: ComponentChildren;
	message?: { text: string; tone: "info" | "warn" | "error" } | null;
	scale?: { pos: number; label: string; reading?: RoundReading | null } | null;
	tuning?: boolean;
	live?: boolean;
	/** Let song and artist wrap (sign-in copy), instead of one line each. */
	wrap?: boolean;
}) {
	return (
		<section
			class={`display${props.tuning ? " display--tuning" : ""}${props.wrap ? " display--wrap" : ""}`}
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
				{props.device ? <span class="display__device">{props.device}</span> : null}
			</div>
			<p class="display__name">
				<span class={props.nameGhost ? "ghost" : ""}>{props.name}</span>
			</p>
			{props.song ? <div class="display__song">{props.song}</div> : null}
			{props.artist || props.time ? (
				<div class="display__artist">
					<span>{props.artist}</span>
					{props.time ? (
						// Ticks every second: never announced.
						<span class="num display__time" aria-live="off">
							{props.time}
						</span>
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
 * the way a radio's menu shows where you are on its LCD.
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
