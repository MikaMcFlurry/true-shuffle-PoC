/**
 * A station drawn as a mixtape cassette. Decorative: every fact it shows
 * (station name, how much of it was heard) is also printed as text nearby.
 *
 * The reels carry the station's real progress: the left reel holds what was
 * heard in this round, the right one what is still to come.
 */

import { useId } from "preact/hooks";
import type { StationSummary } from "../../shared/api";

/** Shell colours, one per station; "Alles" keeps the smoke shell. */
const SHELLS = ["orange", "blue", "red", "green", "yellow", "white"] as const;
export type Shell = (typeof SHELLS)[number] | "smoke";

export function shellOf(s: Pick<StationSummary, "id" | "kind"> | null | undefined): Shell {
	if (!s || s.kind === "all") return "smoke";
	return SHELLS[Math.abs(s.id) % SHELLS.length] ?? "orange";
}

const R_MIN = 15;
const R_MAX = 33;

function reel(share: number): number {
	// Tape is an area: the radius grows with the square root of what it holds.
	return Math.sqrt(R_MIN * R_MIN + (R_MAX * R_MAX - R_MIN * R_MIN) * share);
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
			<rect class="cassette__band" x="22" y="100" width="276" height="10" />
			<foreignObject x="34" y="20" width="252" height="38">
				<p
					class="cassette__name"
					style={{
						"--label-size": `${Math.min(25, Math.floor(252 / (0.62 * Math.max(1, props.name.length))))}px`,
					}}
				>
					{props.name}
				</p>
			</foreignObject>
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
				<path d="M122 87v5M122 100v5M113 96h5M126 96h5" />
			</g>
			<g class="cassette__hub cassette__hub--r">
				<circle cx="198" cy="96" r="11" />
				<path d="M198 87v5M198 100v5M189 96h5M202 96h5" />
			</g>
			<path class="cassette__foot" d="M66 198l14-40h160l14 40" />
			<circle class="cassette__hole" cx="104" cy="182" r="5" />
			<circle class="cassette__hole" cx="216" cy="182" r="5" />
		</svg>
	);
}
