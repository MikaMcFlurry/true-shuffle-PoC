import { useEffect, useState } from "preact/hooks";
import { duration } from "../format";

import { estimatedProgress } from "../progress";

export function SongProgress(props: {
	position: number | null;
	observedAt: number | null;
	serverTime: number;
	receivedAt: number;
	playing: boolean;
	durationMs: number;
}) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		setNow(Date.now());
		if (!props.playing) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [props.playing, props.receivedAt]);
	const position = estimatedProgress(
		props.position,
		props.observedAt,
		props.serverTime,
		Math.max(0, now - props.receivedAt),
		props.playing,
		props.durationMs,
	);
	const estimating = props.playing && props.observedAt !== null && position !== null;
	return (
		<div class="progress-area">
			<progress
				aria-label={estimating ? "Geschätzte Songposition" : "Zuletzt beobachtete Songposition"}
				max={props.durationMs || 1}
				value={position ?? 0}
			/>
			<div class="progress-labels">
				<span>
					{position === null
						? "Position unbekannt · derselbe Song von vorne"
						: `${duration(position)}${estimating ? "" : " gespeichert"}`}
				</span>
				<span>{duration(props.durationMs)}</span>
			</div>
		</div>
	);
}
