/**
 * Shared presentation parts: covers, page heads, sections, choice scales and
 * the station colour. Each design styles them; none of them holds state.
 */

import { ArrowLeft, Music2 } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { PRESETS } from "../../core/mix";
import type { StationSummary } from "../../shared/api";
import { num } from "../format";
import { back } from "../router";

// ---------------------------------------------------------------- inks

/** One colour slot per station; "Alles" takes the page's own colour. Each design fills the slots. */
const INKS = ["ultra", "verm", "green", "violet", "petrol", "yellow"] as const;
export type Ink = (typeof INKS)[number] | "all";

export function inkOf(s: Pick<StationSummary, "id" | "kind"> | null | undefined): Ink {
	if (!s) return "all";
	if (s.kind === "all") return "all";
	return INKS[Math.abs(s.id) % INKS.length] ?? "ultra";
}

/** "Runde 2 · 212 von 400 gehört", or that the round counts from its first song. */
export function roundText(s: Pick<StationSummary, "roundNo" | "poolSize" | "freshRemaining">) {
	const heard =
		s.poolSize !== null && s.freshRemaining !== null ? s.poolSize - s.freshRemaining : null;
	return heard !== null && s.poolSize !== null
		? `Runde ${s.roundNo || 1} · ${num(heard)} von ${num(s.poolSize)} gehört`
		: `Runde ${s.roundNo || 1} · zählt ab dem ersten Song`;
}

// ---------------------------------------------------------------- covers

/**
 * A song's cover, or a printed stand-in when there is none or it fails to
 * load. Always decorative: title and artist sit right beside it.
 */
export function Cover(props: { src: string | null | undefined; class?: string; eager?: boolean }) {
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
			loading={props.eager ? "eager" : "lazy"}
			decoding="async"
			onError={() => setFailed(src)}
		/>
	);
}

// ------------------------------------------------------------- page head

/** A page's head: a key back to where the listener came from, the title, a line under it. */
export function PageBar(props: {
	title: ComponentChildren;
	sub?: ComponentChildren;
	backTo?: string;
	action?: ComponentChildren;
	noBack?: boolean;
	/** Print the head as a band in this station's colour. */
	ink?: Ink;
	children?: ComponentChildren;
}) {
	return (
		<header class={props.ink ? `masthead masthead--station ink-${props.ink}` : "masthead"}>
			{props.noBack ? null : (
				<button type="button" class="back-key" onClick={() => back(props.backTo ?? "/")}>
					<ArrowLeft aria-hidden="true" size={18} />
					Zurück
				</button>
			)}
			<h1 class="masthead__title">{props.title}</h1>
			{props.sub ? <p class="masthead__sub">{props.sub}</p> : null}
			{props.action}
			{props.children}
		</header>
	);
}

/** A section of a page: its heading, an optional line beside it, then content. */
export function Section(props: {
	title: string;
	children?: ComponentChildren;
	id?: string;
	lead?: ComponentChildren;
}) {
	return (
		<section class="section" aria-labelledby={props.id}>
			<div class="section__head">
				<h2 id={props.id}>{props.title}</h2>
				{props.lead ? <span class="section__lead">{props.lead}</span> : null}
			</div>
			{props.children}
		</section>
	);
}

// ---------------------------------------------------------------- scales

const MIX_DETENTS = [
	["Entdecker", PRESETS.entdecker],
	["Ausgewogen", PRESETS.ausgewogen],
	["Vertraut", PRESETS.vertraut],
] as const;

/**
 * Entdecken ↔ Vertraut as three printed positions. A mix set between
 * positions marks none (the readout prints it); any choice snaps to that value.
 */
export function MixScale(props: { value: number; station: string; onChange: (v: number) => void }) {
	return (
		<fieldset class="segmented segmented--mix">
			<legend class="sr-only">Mischung für {props.station}: Entdecken oder Vertraut</legend>
			{MIX_DETENTS.map(([label, v]) => (
				<label key={label} class="segmented__opt">
					<input
						type="radio"
						name={`mix-${props.station}`}
						value={String(v)}
						checked={props.value === v}
						onChange={() => props.onChange(v)}
					/>
					<span>{label}</span>
				</label>
			))}
		</fieldset>
	);
}

/** A row of printed positions over native radios, so arrow keys and screen readers work. */
export function Detents<T extends string>(props: {
	name: string;
	legend: string;
	options: readonly (readonly [T, string])[];
	value: T;
	onChange: (v: T) => void;
}) {
	return (
		<fieldset class="segmented">
			<legend class="segmented__legend">{props.legend}</legend>
			<div class="segmented__row">
				{props.options.map(([v, label]) => (
					<label key={v} class="segmented__opt">
						<input
							type="radio"
							name={props.name}
							value={v}
							checked={props.value === v}
							onChange={() => props.onChange(v)}
						/>
						<span>{label}</span>
					</label>
				))}
			</div>
		</fieldset>
	);
}
