/**
 * The radio's parts: display, tuner scale, keys.
 */

import { ChevronLeft } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { back } from "../router";

export function Scale(props: { pos: number; tuning?: boolean; label?: string }) {
	const pos = Math.min(1, Math.max(0, Number.isFinite(props.pos) ? props.pos : 0));
	return (
		<div
			class={`scale${props.tuning ? " scale--tuning" : ""}`}
			style={{ "--pos": String(pos) }}
			role="img"
			aria-label={props.label}
		>
			<div class="scale__ticks" />
			<div class="scale__base" />
			<div class="scale__fill" />
			<div class="scale__needle" />
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
	line?: ComponentChildren;
	lineRight?: ComponentChildren;
	message?: { text: string; tone: "info" | "warn" | "error" } | null;
	scale?: { pos: number; label: string } | null;
	tuning?: boolean;
	live?: boolean;
}) {
	return (
		<section
			class={`display${props.tuning ? " display--tuning" : ""}`}
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
			<p class={`display__name${props.nameGhost ? " ghost" : ""}`}>
				<span class={props.nameGhost ? "ghost" : ""}>{props.name}</span>
			</p>
			{props.song ? <div class="display__song">{props.song}</div> : null}
			{props.artist ? <div class="display__artist">{props.artist}</div> : null}
			{props.message ? (
				<div
					class={`display__msg${props.message.tone === "error" ? " display__msg--error" : ""}`}
					role="status"
				>
					{props.message.text}
				</div>
			) : props.line || props.lineRight ? (
				<div class="display__line">
					<span>{props.line}</span>
					{props.lineRight ? <span class="num">{props.lineRight}</span> : null}
				</div>
			) : null}
			{props.scale ? (
				<Scale pos={props.scale.pos} tuning={props.tuning} label={props.scale.label} />
			) : null}
		</section>
	);
}

export function PageBar(props: {
	title: ComponentChildren;
	sub?: ComponentChildren;
	backTo?: string;
	action?: ComponentChildren;
	/** Shown beside the radio on a desktop, where there is nothing to go back to. */
	noBack?: boolean;
}) {
	return (
		<header class="page__bar">
			{props.noBack ? null : (
				<button
					type="button"
					class="key"
					onClick={() => back(props.backTo ?? "/")}
					aria-label="Zurück"
				>
					<ChevronLeft class="icon" aria-hidden="true" />
				</button>
			)}
			<div style={{ minWidth: 0, flex: 1 }}>
				<h1 class="page__title">{props.title}</h1>
				{props.sub ? <p class="page__sub">{props.sub}</p> : null}
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
