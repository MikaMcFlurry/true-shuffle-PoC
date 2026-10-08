import type { AppState } from "../../shared/api";

/** Der Kassettenregal: all stations as cassettes. */
export function StationsScreen({ state }: { state: AppState }) {
	return (
		<div class="page">
			<h1>Deine Kassetten</h1>
			<p class="lede">{state.stations.length} Sender</p>
		</div>
	);
}
