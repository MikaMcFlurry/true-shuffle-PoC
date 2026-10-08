/**
 * A station drawn as a mixtape cassette. Decorative: every fact it shows
 * (station name, how much of it was heard) is also printed as text nearby.
 *
 * The reels carry the station's real progress: the left reel holds what was
 * heard in this round, the right one what is still to come.
 */

import { useId } from "preact/hooks";
import type { StationSummary } from "../../shared/api";
import { type LabelLine, labelLayout } from "./cassette-label";

/** Label stripe colours, one per station; "Alles" gets the classic red stripes too, in black. */
const SHELLS = ["red", "blue", "green", "orange", "teal", "violet"] as const;
export type Shell = (typeof SHELLS)[number] | "smoke";

export function shellOf(s: Pick<StationSummary, "id" | "kind"> | null | undefined): Shell {
	if (!s || s.kind === "all") return "smoke";
	return SHELLS[Math.abs(s.id) % SHELLS.length] ?? "red";
}

const R_MIN = 15;
const R_MAX = 33;

function reel(share: number): number {
	// Tape is an area: the radius grows with the square root of what it holds.
	return Math.sqrt(R_MIN * R_MIN + (R_MAX * R_MAX - R_MIN * R_MIN) * share);
}

function LabelText(props: { line: LabelLine | undefined; size: number; y: number | undefined }) {
	if (!props.line || props.y === undefined) return null;
	return (
		<tspan
			x="160"
			y={props.y}
			font-size={props.size}
			{...(props.line.squeeze
				? { textLength: props.line.width, lengthAdjust: "spacingAndGlyphs" }
				: {})}
		>
			{props.line.text}
		</tspan>
	);
}

export type ReelState = "still" | "running" | "waiting";

export function Cassette(props: {
	name: string;
	shell: Shell;
	/** Heard share of the round, 0..1, or null before the first song. */
	heard: number | null;
	reels?: ReelState;
	class?: string;
}) {
	const h = props.heard === null ? 0 : Math.max(0, Math.min(1, props.heard));
	const left = reel(h);
	const right = reel(1 - h);
	const state = props.reels ?? "still";
	const label = labelLayout(props.name);
	const clip = `cw${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
	return (
		<svg
			class={`cassette cassette--${props.shell} cassette--${state}${props.class ? ` ${props.class}` : ""}`}
			viewBox="0 0 320 200"
			aria-hidden="true"
			focusable="false"
		>
			<rect class="cassette__shell" x="2" y="2" width="316" height="196" rx="14" />
			<circle class="cassette__screw" cx="16" cy="16" r="4" />
			<circle class="cassette__screw" cx="304" cy="16" r="4" />
			<circle class="cassette__screw" cx="16" cy="184" r="4" />
			<circle class="cassette__screw" cx="304" cy="184" r="4" />
			<rect class="cassette__label" x="22" y="14" width="276" height="124" rx="6" />
			<g class="cassette__stripes">
				<rect x="22" y="70" width="276" height="5" />
				<rect x="22" y="81" width="276" height="5" />
				<rect x="22" y="92" width="276" height="5" />
				<rect x="22" y="103" width="276" height="5" />
				<rect class="cassette__band" x="22" y="114" width="276" height="14" />
			</g>
			<text class="cassette__name" transform="rotate(-1 160 40)" text-anchor="middle">
				<LabelText line={label.lines[0]} size={label.size} y={label.baselines[0]} />
				<LabelText line={label.lines[1]} size={label.size} y={label.baselines[1]} />
			</text>
			<clipPath id={clip}>
				<rect x="78" y="62" width="164" height="68" rx="10" />
			</clipPath>
			<rect class="cassette__window" x="78" y="62" width="164" height="68" rx="10" />
			<g class="cassette__tape" clip-path={`url(#${clip})`}>
				<circle cx="122" cy="96" r={left} />
				<circle cx="198" cy="96" r={right} />
			</g>
			<g class="cassette__hub cassette__hub--l">
				<circle cx="122" cy="96" r="11" />
				<path d="M122.0 91.0L122.0 87.0M126.3 93.5L129.8 91.5M126.3 98.5L129.8 100.5M122.0 101.0L122.0 105.0M117.7 98.5L114.2 100.5M117.7 93.5L114.2 91.5" />
			</g>
			<g class="cassette__hub cassette__hub--r">
				<circle cx="198" cy="96" r="11" />
				<path d="M198.0 91.0L198.0 87.0M202.3 93.5L205.8 91.5M202.3 98.5L205.8 100.5M198.0 101.0L198.0 105.0M193.7 98.5L190.2 100.5M193.7 93.5L190.2 91.5" />
			</g>
			<path class="cassette__foot" d="M66 198l14-40h160l14 40" />
			<path class="cassette__spine" d="M88 172H232" />
			<circle class="cassette__roller" cx="88" cy="176" r="4" />
			<circle class="cassette__roller" cx="232" cy="176" r="4" />
			<circle class="cassette__hole" cx="104" cy="182" r="5" />
			<circle class="cassette__hole" cx="216" cy="182" r="5" />
		</svg>
	);
}
