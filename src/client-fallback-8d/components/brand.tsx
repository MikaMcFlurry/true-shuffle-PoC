/**
 * The round's heard share as a tape: heard part solid, the rest dashed.
 * Decorative: the numbers it draws are always printed in text beside it.
 * Marks are floored, never rounded up.
 */
export function RoundMeter(props: { progress: number | null; size?: "lg" | "sm" }) {
	const p = Math.min(1, Math.max(0, props.progress ?? 0));
	return (
		<span class={`meter${props.size === "sm" ? " meter--sm" : ""}`} aria-hidden="true">
			<span style={{ width: `${Math.floor(p * 1000) / 10}%` }} />
		</span>
	);
}
