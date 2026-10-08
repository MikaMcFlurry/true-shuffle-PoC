/**
 * Where a station name goes on the cassette label. Pure, so it can be tested
 * without rendering.
 */

/** The writable part of the label, in the cassette's own units. */
const LABEL_W = 244;
const LABEL_TOP = 17;
const ONE_LINE_MAX = 34;
const TWO_LINE_MAX = 24;
const MIN_SIZE = 16;

/**
 * Width of a marker-pen character, in em, measured in Permanent Marker and
 * rounded up. Generous on purpose: a line
 * is only stretched to the measured width when it comes close to the edge,
 * so an estimate on the wide side keeps every name inside the label.
 */
function em(ch: string): number {
	if (ch === " ") return 0.38;
	if (/[MW]/.test(ch)) return 1.02;
	if (/[mw@%]/.test(ch)) return 0.86;
	if (/[A-ZÄÖÜ]/.test(ch)) return 0.76;
	if (/[iI.,:;'!|]/.test(ch)) return 0.34;
	if (/[0-9]/.test(ch)) return 0.7;
	return 0.6;
}

function ems(text: string): number {
	let w = 0;
	for (const ch of text) w += em(ch);
	return Math.max(w, 0.5);
}

export interface LabelLine {
	text: string;
	/** Estimated width at the chosen size, never more than the label. */
	width: number;
	/** Pinned to `width`, so a wider-than-expected font can never leave the label. */
	squeeze: boolean;
}

/**
 * Lays out a station name on the cassette label: one big line when it fits,
 * otherwise two balanced lines split at a space, never wider than the label.
 */
export function labelLayout(name: string): {
	lines: LabelLine[];
	size: number;
	baselines: number[];
} {
	const text = name.trim().replace(/\s+/g, " ") || "Kassette";
	const one = Math.min(ONE_LINE_MAX, LABEL_W / ems(text));
	const words = text.split(" ");
	let split: [string, string] | null = null;
	if (one < 22 && words.length > 1) {
		let best = Number.POSITIVE_INFINITY;
		for (let i = 1; i < words.length; i++) {
			const a = words.slice(0, i).join(" ");
			const b = words.slice(i).join(" ");
			const widest = Math.max(ems(a), ems(b));
			if (widest < best) {
				best = widest;
				split = [a, b];
			}
		}
	}
	const parts = split ?? [text];
	const widest = Math.max(...parts.map(ems));
	const max = parts.length === 1 ? ONE_LINE_MAX : TWO_LINE_MAX;
	const size = Math.round(Math.max(MIN_SIZE, Math.min(max, LABEL_W / widest)) * 10) / 10;
	const lines = parts.map((t) => {
		const width = Math.min(LABEL_W, ems(t) * size);
		return { text: t, width: Math.round(width), squeeze: width > LABEL_W * 0.78 };
	});
	const baselines =
		lines.length === 1
			? [LABEL_TOP + 21 + size * 0.35]
			: [LABEL_TOP - 2 + size * 0.9, LABEL_TOP - 2 + size * 1.9];
	return { lines, size, baselines: baselines.map((b) => Math.round(b * 10) / 10) };
}
