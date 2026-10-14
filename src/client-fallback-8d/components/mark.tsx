/** The true-shuffle mark: a cassette, two reels and the tape between them. Decorative; the name sits beside it. */
export function Mark(props: { class?: string }) {
	return (
		<svg
			class={`brand__mark${props.class ? ` ${props.class}` : ""}`}
			viewBox="0 0 32 32"
			aria-hidden="true"
			focusable="false"
		>
			<rect class="bm-shell" x="2.5" y="6.5" width="27" height="19" rx="3" />
			<path class="bm-band" d="M10.5 15h11" />
			<circle class="bm-reel" cx="10.5" cy="15" r="3.6" />
			<circle class="bm-reel" cx="21.5" cy="15" r="3.6" />
			<circle class="bm-hub" cx="10.5" cy="15" r="1.3" />
			<circle class="bm-hub" cx="21.5" cy="15" r="1.3" />
			<path class="bm-shell" d="M8 25.5l2-4h12l2 4" />
		</svg>
	);
}
