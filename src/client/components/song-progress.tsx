import { duration } from "../format";

export function SongProgress(props: {
	position: number | null;
	estimating: boolean;
	pending?: boolean;
	durationMs: number;
}) {
	const { position, estimating } = props;
	return (
		<div class="progress-area">
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
