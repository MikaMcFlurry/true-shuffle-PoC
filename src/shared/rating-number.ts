/**
 * The one rule for reading a rating's write number (`rated`, see TrackView).
 *
 * The server sends `rated: 0` for a song no rating was written for since its
 * rating clock began (see HubCore.ratedSeq). Question I1 / Annahme A1 (Mika,
 * 02.11.2026, not answered): should 0 count as unrated/unknown — read like an
 * answer without `rated` — instead of a confirmed write 0 (ZERO-FOLLOW, D7)?
 *
 * Measured on 1.3.0 (test/client/rating-legacy, test/shared/rating-number):
 * with 0 as unknown, the open rating sheet and the Verlauf row disagree in
 * twelve ordered-read cases (e.g. sheet 0, Verlauf +1), because rows without
 * a write number are ordered by when they were asked and the store and the
 * Verlauf settle those differently (the open L2/L7 limit). So the release
 * keeps D7 (0 is a confirmed write) until Mika confirms; flipping this one
 * constant switches the whole client to A1.
 */
export const RATED_ZERO_IS_UNKNOWN = false;

/** The known write number under a given rule, or undefined where none is known. */
export function writeNumberUnder(
	zeroIsUnknown: boolean,
	rated: number | undefined | null,
): number | undefined {
	if (rated === undefined || rated === null) return undefined;
	if (rated === 0 && zeroIsUnknown) return undefined;
	return rated;
}

/** The known write number under the rule in force. */
export function writeNumber(rated: number | undefined | null): number | undefined {
	return writeNumberUnder(RATED_ZERO_IS_UNKNOWN, rated);
}
