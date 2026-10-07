/**
 * Brand marks and each design's signature parts. Everything here is
 * decorative: the facts it draws (round share, song, stop number) are always
 * printed in text beside it.
 */

import type { StationSummary, TrackView } from "../../shared/api";
import { type Design, useDesign } from "../design";
import { Cover } from "./ui";

// ------------------------------------------------------------ brand marks

/** The mark for a design, drawn in currentColor plus the design's --brand. */
export function BrandMark(props: { design?: Design; class?: string }) {
	const active = useDesign();
	const d = props.design ?? active;
	const cls = `brand__mark brand__mark--${d}${props.class ? ` ${props.class}` : ""}`;
	if (d === "kontakt")
		return (
			<svg class={cls} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
				<rect class="bm-film" x="2" y="5" width="28" height="22" rx="1.5" />
				{[5, 10.5, 16, 21.5].map((x) => (
					<g key={x} class="bm-hole">
						<rect x={x} y="7" width="3" height="2.4" rx="0.5" />
						<rect x={x} y="22.6" width="3" height="2.4" rx="0.5" />
					</g>
				))}
				<rect class="bm-window" x="5" y="11.2" width="22" height="9.6" />
				<path
					class="bm-grease"
					d="M6.6 12.6c4.6-.7 13.4-.9 19 .1.4 2.2.3 4.4-.2 6.6-5.6.6-13.6.6-18.6-.2-.5-2-.6-4.5-.2-6.3"
				/>
			</svg>
		);
	if (d === "linie")
		return (
			<svg class={cls} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
				<path class="bm-line" d="M2 23h8l12-12h8" />
				<circle class="bm-stop" cx="16" cy="17" r="4.6" />
			</svg>
		);
	if (d === "strich")
		return (
			<svg class={cls} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
				<path class="bm-tally" d="M7 6.5v19M12.2 5.8v19.6M17.4 6.4v19M22.6 5.9v19.4" />
				<path class="bm-cross" d="M3.6 22.4 28.4 9.1" />
			</svg>
		);
	return (
		<svg class={cls} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
			<rect class="bm-tile" x="1" y="1" width="30" height="30" rx="8" />
			<path class="bm-arc" d="M23.4 10.2A9.6 9.6 0 1 0 25.6 17" />
			<path class="bm-head" d="m25.9 6.4-.5 5.6-5.5-1.2" />
			<path class="bm-play" d="M13.4 11.6v8.8l7-4.4z" />
		</svg>
	);
}

// ----------------------------------------------------------- round meter

/**
 * The round's heard share in the design's own idiom: a barcode, a line,
 * a tally or a ring. Marks are floored, never rounded up.
 */
export function RoundMeter(props: { progress: number | null; size?: "lg" | "sm" }) {
	const d = useDesign();
	const p = Math.min(1, Math.max(0, props.progress ?? 0));
	const sm = props.size === "sm";
	if (d === "kontakt") {
		const n = sm ? 28 : 56;
		const on = Math.floor(p * n);
		return (
			<svg
				class={`meter-code${sm ? " meter-code--sm" : ""}`}
				viewBox={`0 0 ${n * 4} 20`}
				preserveAspectRatio="none"
				aria-hidden="true"
				focusable="false"
			>
				{Array.from({ length: n }, (_, i) => (
					<rect
						key={i}
						class={i < on ? "meter-code__bar meter-code__bar--on" : "meter-code__bar"}
						x={i * 4}
						y="0"
						width={i % 7 === 3 ? 2.6 : i % 3 === 0 ? 1.8 : 1.2}
						height="20"
					/>
				))}
			</svg>
		);
	}
	if (d === "linie") {
		const x = 6 + p * 188;
		return (
			<svg
				class={`meter-line${sm ? " meter-line--sm" : ""}`}
				viewBox="0 0 200 16"
				preserveAspectRatio="none"
				aria-hidden="true"
				focusable="false"
			>
				<line class="meter-line__rest" x1="6" y1="8" x2="194" y2="8" />
				<line class="meter-line__done" x1="6" y1="8" x2={x} y2="8" />
				<line class="meter-line__end" x1="194" y1="2" x2="194" y2="14" />
			</svg>
		);
	}
	if (d === "strich") {
		const bundles = sm ? 10 : 20;
		const marks = Math.floor(p * bundles * 5);
		return (
			<svg
				class={`meter-tally${sm ? " meter-tally--sm" : ""}`}
				viewBox={`0 0 ${bundles * 22} 24`}
				aria-hidden="true"
				focusable="false"
			>
				{Array.from({ length: bundles }, (_, b) => {
					const here = Math.max(0, Math.min(5, marks - b * 5));
					return (
						<g key={b} transform={`translate(${b * 22} 0)`}>
							{[0, 1, 2, 3].map((m) => (
								<line
									key={m}
									class={m < here ? "tally tally--on" : "tally"}
									x1={3 + m * 4}
									y1={4 + ((b + m) % 3) * 0.5}
									x2={3.4 + m * 4}
									y2={21 - ((b * 3 + m) % 2) * 0.6}
								/>
							))}
							<line
								class={here === 5 ? "tally tally--on tally--x" : "tally tally--x"}
								x1="0.5"
								y1="18"
								x2="17.5"
								y2="7"
							/>
						</g>
					);
				})}
			</svg>
		);
	}
	const r = 15;
	const c = 2 * Math.PI * r;
	return (
		<svg
			class={`meter-ring${sm ? " meter-ring--sm" : ""}`}
			viewBox="0 0 40 40"
			aria-hidden="true"
			focusable="false"
		>
			<circle class="meter-ring__rest" cx="20" cy="20" r={r} />
			<circle
				class="meter-ring__done"
				cx="20"
				cy="20"
				r={r}
				stroke-dasharray={`${(c * p).toFixed(2)} ${c.toFixed(2)}`}
				transform="rotate(-90 20 20)"
			/>
		</svg>
	);
}

// ------------------------------------------------------------- line badge

/** Linienplan: each Sender is a line, "S1", "S2" …; "Alles" is the ring line "A". */
export function lineName(stations: readonly StationSummary[], s: StationSummary | null): string {
	if (!s) return "S";
	if (s.kind === "all") return "A";
	const own = stations.filter((x) => x.kind !== "all");
	const i = own.findIndex((x) => x.id === s.id);
	return `S${i < 0 ? 1 : i + 1}`;
}

export function LineBadge(props: {
	stations: readonly StationSummary[];
	s: StationSummary | null;
}) {
	const d = useDesign();
	if (d !== "linie") return null;
	return (
		<span class="line-badge" aria-hidden="true">
			{lineName(props.stations, props.s)}
		</span>
	);
}

// ------------------------------------------------------------- stage art

/**
 * The current cover. Kontaktbogen prints it as a frame on a film strip with
 * the next frames from the saved queue beside it, the current one boxed in
 * grease pencil; the other designs print the cover alone.
 */
export function StageArt(props: {
	src: string | null | undefined;
	next: readonly TrackView[];
	label: string;
}) {
	const d = useDesign();
	if (d !== "kontakt") return <Cover src={props.src} class="player-art" eager />;
	return (
		<div class="filmstrip" aria-hidden="true">
			<div class="filmstrip__frame filmstrip__frame--now">
				<Cover src={props.src} class="player-art" eager />
				<GreaseBox />
				<span class="filmstrip__edge">{props.label}</span>
			</div>
			{props.next.slice(0, 3).map((t, i) => (
				<div class="filmstrip__frame" key={`${t.id}-${i}`}>
					<Cover src={t.imageUrl} class="filmstrip__next" />
					<span class="filmstrip__edge">{String(i + 1).padStart(2, "0")}</span>
				</div>
			))}
		</div>
	);
}

/** A grease-pencil box, drawn once by hand and scaled to the frame. */
export function GreaseBox(props: { class?: string }) {
	return (
		<svg
			class={`grease${props.class ? ` ${props.class}` : ""}`}
			viewBox="0 0 100 100"
			preserveAspectRatio="none"
			aria-hidden="true"
			focusable="false"
		>
			<path d="M3.5 6.2C30 3.1 68 2.6 96.4 4.9c1.4 28 1.6 58.6-.6 89.7-29.2 1.8-63.8 1.6-91.6-.9C2.5 66 2.2 33.6 4.7 3.1" />
		</svg>
	);
}

/** Strichliste: a marker stroke under the current title. */
export function Scribble() {
	const d = useDesign();
	if (d !== "strich") return null;
	return (
		<svg
			class="scribble"
			viewBox="0 0 300 14"
			preserveAspectRatio="none"
			aria-hidden="true"
			focusable="false"
		>
			<path d="M2 9.5C52 5.4 118 4.2 176 6.1c38 1.2 80 3.4 122 1.9" />
		</svg>
	);
}
