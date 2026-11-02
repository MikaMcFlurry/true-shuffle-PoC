/**
 * Independent model of the shared rating rule (store + Verlauf), written from
 * docs/HISTORY_RATINGS.md and the R5/R6 commit statements, not from the code:
 *
 * - Per song the newest stored rating is the one with the highest server
 *   write number (revision) heard from any accepted read: a snapshot, any
 *   Verlauf page, a taken confirmation or undo. A lower number never replaces
 *   it; an equal number is the same write and keeps the known value.
 * - A rating given here (sheet, player keys) is a new decision, a new
 *   identity. It is shown everywhere until a read accounts for it: a Verlauf
 *   page (first or later) asked while exactly that decision stood, or a
 *   snapshot asked in a strictly later millisecond than the decision (the
 *   unchanged clock rule of `settleThumbs`). A decision given while a read was
 *   on its way, in the same millisecond, is not accounted for by it.
 * - Once accounted for, a decision gives way to the newest stored rating,
 *   also when later ratings arrive without it (R6: "any rating at that number
 *   or later accounts for it").
 * - A Verlauf confirmation or undo answer is taken when nothing was rated here
 *   since it was asked and its number is not below the newest known; else the
 *   song's rating now is read (at answer time) and taken. A taken value is a
 *   new decision that its own number already accounts for.
 */

export type Value = -1 | 0 | 1;
export const SONGS = ["track-a", "track-b", "track-c"] as const;
export type SongIx = 0 | 1 | 2;

export interface Rated {
	v: Value;
	rev: number;
}

/** The eight named contracts every step is checked against. */
export const CONTRACTS = {
	C1: "NO_LOWER_REVISION: the shown write number is the highest accepted, never lower, never decreasing",
	C2: "HIGHEST_REVISION_VALUE: without an open local decision the value of the highest write number is shown",
	C3: "LOCAL_DECISION_SHOWN: a new local decision not yet accounted for is shown at once everywhere",
	C4: "OVERRIDE_IDENTITY: a decision accounted for (by identity / strictly later snapshot) gives way, also to later writes",
	C5: "SHEET_VERLAUF_AGREE: open sheet, store thumbOf and Verlauf show the same value for a song",
	C6: "FOLLOW_PAGE_COUNTS: a later Verlauf page adds its write numbers like the first page",
	C7: "LATE_ANSWER_INERT: a late answer below the newest known write number changes nothing",
	C8: "EQUAL_REVISION_TIE: an equal write number keeps the value and adds what it accounts for",
} as const;
export type ContractId = keyof typeof CONTRACTS;

interface Decision {
	/** Model identity, never shared with the system under test. */
	id: number;
	v: Value;
	at: number;
	accounted: boolean;
}

export interface Expected {
	v: Value;
	rev: number;
	/** Whether an unaccounted local decision is what is shown. */
	byDecision: boolean;
	/** Whether a decision exists that was accounted for. */
	accountedDecision: boolean;
}

export class RatingModel {
	known: Rated[];
	private decisions: (Decision | null)[] = [null, null, null];
	private nextId = 1;
	private snaps = new Map<number, { at: number; rows: Rated[] }>();
	private lists = new Map<number, { standing: (number | null)[]; rows: (Rated | null)[] }>();
	private ops = new Map<number, { standing: number | null }>();
	sheet: SongIx | null = null;

	constructor(initial: Rated[]) {
		this.known = initial.map((r) => ({ ...r }));
	}

	decisionId(s: SongIx): number | null {
		return this.decisions[s]?.id ?? null;
	}

	private hear(s: SongIx, r: Rated): void {
		if (r.rev > this.known[s]!.rev) this.known[s] = { ...r };
	}

	/** A rating given here at `at` (after the server stored it). */
	localDecision(s: SongIx, v: Value, at: number): void {
		this.decisions[s] = { id: this.nextId++, v, at, accounted: false };
	}

	snapshotAsked(token: number, at: number, rows: Rated[]): void {
		this.snaps.set(token, { at, rows: rows.map((r) => ({ ...r })) });
	}

	snapshotAnswered(token: number): void {
		const q = this.snaps.get(token)!;
		this.snaps.delete(token);
		SONGS.forEach((_, i) => {
			const s = i as SongIx;
			const d = this.decisions[s];
			if (d && d.at < q.at) d.accounted = true;
			this.hear(s, q.rows[s]!);
		});
	}

	listAsked(token: number, rows: (Rated | null)[]): void {
		this.lists.set(token, {
			standing: SONGS.map((_, i) => this.decisionId(i as SongIx)),
			rows: rows.map((r) => (r ? { ...r } : null)),
		});
	}

	/** Any page alike: first page and later pages count and account the same. */
	listAnswered(token: number): void {
		const q = this.lists.get(token)!;
		this.lists.delete(token);
		q.rows.forEach((r, i) => {
			if (!r) return;
			const s = i as SongIx;
			const d = this.decisions[s];
			if (d && q.standing[s] === d.id) d.accounted = true;
			this.hear(s, r);
		});
	}

	/** A Verlauf rate or undo asked for on song s. */
	opAsked(s: SongIx): void {
		this.ops.set(s, { standing: this.decisionId(s) });
	}

	/**
	 * Its answer: `offered` (the receipt's / "rated since" rating) is taken when
	 * nothing was rated here since and it is not below the newest known; else
	 * `now` (the song's rating read at answer time) is taken.
	 */
	opAnswered(s: SongIx, offered: Rated, now: Rated, at: number): void {
		const q = this.ops.get(s)!;
		this.ops.delete(s);
		const unchanged = this.decisionId(s) === q.standing;
		const take = unchanged && offered.rev >= this.known[s]!.rev ? offered : now;
		this.hear(s, take);
		this.decisions[s] = { id: this.nextId++, v: take.v, at, accounted: true };
	}

	openSheet(s: SongIx | null): void {
		this.sheet = s;
	}

	expected(s: SongIx): Expected {
		const d = this.decisions[s];
		const k = this.known[s]!;
		if (d && !d.accounted)
			return { v: d.v, rev: k.rev, byDecision: true, accountedDecision: false };
		return { v: k.v, rev: k.rev, byDecision: false, accountedDecision: !!d };
	}
}
