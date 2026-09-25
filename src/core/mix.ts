/**
 * The "Entdecken ↔ Vertraut" slider.
 *
 * One number (0..100) becomes three shares that always sum to 1:
 *   fresh     — songs of this station not heard yet in the current round
 *   favorite  — known favourites whose cooldown has passed
 *   discovery — songs from outside the listener's playlists
 *
 * The anchors are the three presets offered during setup; the owner chose
 * "Entdecker" (≈ 60 / 10 / 30) as the default, which sits at 25.
 */

import type { StationRules } from "./types";

export interface MixShares {
	fresh: number;
	favorite: number;
	discovery: number;
}

interface Anchor extends MixShares {
	at: number;
}

const ANCHORS: readonly Anchor[] = [
	{ at: 0, fresh: 0.55, favorite: 0.05, discovery: 0.4 },
	{ at: 25, fresh: 0.6, favorite: 0.1, discovery: 0.3 }, // Entdecker (default)
	{ at: 60, fresh: 0.65, favorite: 0.25, discovery: 0.1 }, // Ausgewogen
	{ at: 100, fresh: 0.5, favorite: 0.45, discovery: 0.05 }, // Vertraut
];

export const PRESETS = {
	entdecker: 25,
	ausgewogen: 60,
	vertraut: 100,
} as const;

export function sharesForMix(mix: number): MixShares {
	const x = Math.min(100, Math.max(0, mix));
	for (let i = 0; i < ANCHORS.length - 1; i++) {
		const a = ANCHORS[i]!;
		const b = ANCHORS[i + 1]!;
		if (x >= a.at && x <= b.at) {
			const t = b.at === a.at ? 0 : (x - a.at) / (b.at - a.at);
			return normalise({
				fresh: a.fresh + (b.fresh - a.fresh) * t,
				favorite: a.favorite + (b.favorite - a.favorite) * t,
				discovery: a.discovery + (b.discovery - a.discovery) * t,
			});
		}
	}
	const last = ANCHORS[ANCHORS.length - 1]!;
	return normalise(last);
}

/** Shares after applying the rule overrides (favourite share, discovery off). */
export function sharesForRules(rules: StationRules): MixShares {
	const base = sharesForMix(rules.mix);
	let { fresh, favorite, discovery } = base;
	if (rules.favoriteShare !== null) {
		const rest = 1 - rules.favoriteShare;
		const others = fresh + discovery;
		favorite = rules.favoriteShare;
		if (others > 0) {
			fresh = (fresh / others) * rest;
			discovery = (discovery / others) * rest;
		} else {
			fresh = rest;
			discovery = 0;
		}
	}
	if (!rules.discoveryEnabled) {
		fresh += discovery;
		discovery = 0;
	}
	return normalise({ fresh, favorite, discovery });
}

function normalise(s: MixShares): MixShares {
	const sum = s.fresh + s.favorite + s.discovery;
	if (sum <= 0) return { fresh: 1, favorite: 0, discovery: 0 };
	return { fresh: s.fresh / sum, favorite: s.favorite / sum, discovery: s.discovery / sum };
}
