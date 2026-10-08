/** The true-shuffle mark: two reels joined by a run of tape. Decorative; the name sits beside it. */
export function Mark(props: { class?: string }) {
	return (
		<svg
			class={`brand__mark${props.class ? ` ${props.class}` : ""}`}
			viewBox="0 0 32 32"
			aria-hidden="true"
			focusable="false"
		>
			<path class="bm-band" d="M6 23.5h20" />
			<circle class="bm-reel" cx="9" cy="14" r="6.2" />
			<circle class="bm-reel" cx="23" cy="14" r="6.2" />
			<circle class="bm-hub" cx="9" cy="14" r="2.3" />
			<circle class="bm-hub" cx="23" cy="14" r="2.3" />
		</svg>
	);
}
