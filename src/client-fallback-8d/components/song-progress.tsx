import { duration } from "../format";

/**
 * The song's position as a printed rule. Solid ink is only ever the last
 * observed or locally counted position; a held or estimated reading prints
 * as overprint (outline or hatch), never as confirmed ink.
 */
export function SongProgress(props: {
	position: number | null;
	estimating: boolean;
	pending?: boolean;
	projected?: boolean;
	durationMs: number;
}) {
	const { position, estimating } = props;
	const tone = props.pending
		? "held"
		: props.projected
			? "estimate"
			: estimating
				? "live"
				: "saved";
	return (
		<div class={`progress-area progress-area--${tone}`}>
			<progress
				aria-label={
					props.pending
						? "Angehaltene Songanzeige"
						: estimating
							? "Geschätzte Songposition"
							: "Zuletzt beobachtete Songposition"
				}
				max={props.durationMs || 1}
				value={position ?? 0}
			/>
			<div class="progress-labels">
				<span>
					{position === null
						? "Position unbekannt · derselbe Song von vorne"
						: `${duration(position)}${props.pending ? " · Bestätigung ausstehend" : estimating ? "" : " gespeichert"}`}
				</span>
				<span>{duration(props.durationMs)}</span>
			</div>
		</div>
	);
}
