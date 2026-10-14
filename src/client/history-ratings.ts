/**
 * Ratings right in the Verlauf (see docs/HISTORY_RATINGS.md): an option of
 * this device, for one Spotify account, off unless switched on — and, while
 * on, one change at a time per song, said honestly: being stored, stored,
 * not stored (and why), unclear after a lost answer, rated elsewhere since,
 * taken back. Nothing here changes a rating without a deliberate tap.
 *
 * A receipt proves that its own action happened — not that its value holds
 * now. What holds now comes only from what can tell it: a receipt that is
 * neither taken back nor overtaken (by number, by a newer list, or by a
 * rating given meanwhile elsewhere in this app), or the server's rating read
 * now. A value is always shown with the write number of the same source.
 */

import { useEffect, useState } from "preact/hooks";
import type { HistoryEntry, HistoryRatingReceipt } from "../shared/api";
import { ApiError, api } from "./api";
import { store } from "./store";

type Value = -1 | 0 | 1;
/** A rating given elsewhere in this app (sheet, player keys), as the store holds it. */
type Override = ReturnType<typeof store.thumbOverride>;

// ---------------------------------------------------------------------------
// The option: this device, this account; missing or unreadable means off.

const KEY = "ts-history-ratings:";

export function historyRatingsOn(account: string | null | undefined): boolean {
	if (!account) return false;
	try {
		return localStorage.getItem(KEY + account) === "on";
	} catch {
		return false;
	}
}

/** Switched on or off for this account on this device; true when it is kept. */
export function setHistoryRatings(account: string, on: boolean): boolean {
	try {
		if (on) localStorage.setItem(KEY + account, "on");
		else localStorage.removeItem(KEY + account);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Per song: what is known, and the one change on its way.

export type Phase =
	/** Nothing asked here yet. */
	| "idle"
	| "saving"
	| "saved"
	/** Refused, or surely not stored: can be sent again. */
	| "failed"
	/** The answer got lost: looking at the receipt. */
	| "checking"
	/** The answer got lost, and whether it was stored cannot be told (yet). */
	| "unclear"
	/** Rated again elsewhere since the page read it: nothing stored. */
	| "changed"
	| "undoing"
	| "undone"
	/** Taking back was refused, or surely did not happen: can be asked again. */
	| "undo-failed"
	/** The answer to taking back got lost, and it cannot be told whether it happened. */
	| "undo-unclear";

export interface SongRating {
	phase: Phase;
	/** The rating known to hold now, and the write number of the same source. */
	value: Value;
	seq: number;
	/**
	 * The change on its way or to send again: same id, never a second decision.
	 * `mayStillArrive`: it ran out of time — it can still reach the server, so
	 * no receipt is only "not yet", for as long as the page looks.
	 */
	intent: { actionId: string; value: Value; basis: number; mayStillArrive?: boolean } | null;
	/** The receipt of the action this song's last operation was about. */
	receipt: HistoryRatingReceipt | null;
	error: string | null;
	/** Stored, but the song was rated again since: what the action set no longer holds. */
	overtaken: boolean;
	/** Stored, and taken back already before this page learned of it. */
	alreadyUndone: boolean;
	/** The rating given elsewhere in this app that `value` already accounts for. */
	seen: Override;
	/** Counts every operation on the song: an answer to an older one changes nothing. */
	op: number;
}

let account: string | null = null;
let generation = 0;
const songs = new Map<string, SongRating>();
/** The newest rating each song was listed with (several pages, several occurrences). */
const listed = new Map<string, { value: Value; seq: number; seen: Override }>();
const listeners = new Set<() => void>();
let said = "";

function emit(): void {
	for (const l of listeners) l();
}

/** The signed-in account: another one (or none) starts from nothing, and late answers count for nothing. */
export function ratingsFor(id: string | null, quiet = false): void {
	if (id === account) return;
	account = id;
	generation++;
	songs.clear();
	listed.clear();
	said = "";
	if (!quiet) emit();
}

/**
 * Wherever the app is (the Verlauf need not be open): signing out, or
 * another account signed in, starts from nothing, and answers on their way
 * count for nothing. Loading, a failed refresh or being offline change
 * nothing: the session is still the same.
 */
store.subscribe(() => {
	const l = store.load;
	if (l.kind === "signed-out") ratingsFor(null);
	else if (l.kind === "ready") ratingsFor(l.state.profile.id);
});

/**
 * Only a rating known to hold now reaches the rest of the app, and only
 * while the same account is signed in. Returns what the app now holds.
 */
function tell(trackId: string, value: Value): Override {
	const s = store.load;
	if (s.kind === "ready" && s.state.profile.id === account) store.setThumb(trackId, value);
	return store.thumbOverride(trackId);
}

/** The account's generation now: a list read under an older one is no longer this page's. */
export function ratingsGeneration(): number {
	return generation;
}

/** A Verlauf list on its way: the account's generation, and the ratings this app had given when it was asked for. */
export interface ListRead {
	gen: number;
	known: ReadonlyMap<string, NonNullable<Override>>;
}

/** Call when asking for a Verlauf list; hand the result to `takeListed`. */
export function startListRead(): ListRead {
	return { gen: generation, known: store.thumbsNow() };
}

/**
 * A Verlauf list arrived: false when it is no longer this session's.
 * `settle` (the first page) lets the ratings it knows give way in the whole
 * app, as the Verlauf did before (`settleThumbs`) — by identity, not by clock.
 */
export function takeListed(rows: HistoryEntry[], read: ListRead, settle: boolean): boolean {
	if (read.gen !== generation) return false;
	if (settle) store.settleKnownThumbs(rows, read.known);
	noteListed(rows, read.gen, read.known);
	return true;
}

/**
 * Songs as a list just read them: a newer rating there (made elsewhere) wins
 * over an older one here. A list read for another account (or before signing
 * out and in again) counts for nothing. A rating given in this app before the
 * list was asked for is in it; one given while it was on its way is not —
 * told apart by the very rating object standing when it was asked for
 * (`known`), never by the clock: both can fall in one millisecond. Without
 * `known`, the list counts as asked for now.
 */
export function noteListed(
	rows: HistoryEntry[],
	gen = generation,
	known?: ReadonlyMap<string, NonNullable<Override>>,
): void {
	if (gen !== generation) return;
	const asked = known instanceof Map ? known : null;
	for (const r of rows) {
		const seq = r.rated ?? 0;
		const cur = listed.get(r.id);
		const o = store.thumbOverride(r.id);
		const seen = o && (!asked || asked.get(r.id) === o) ? o : undefined;
		if (!cur || seq >= cur.seq) listed.set(r.id, { value: r.thumb, seq, seen });
	}
	emit();
}

/** The newest write number known for a song here (a list read or a confirmation). */
function knownSeq(t: HistoryEntry): number {
	return Math.max(listed.get(t.id)?.seq ?? t.rated ?? 0, songs.get(t.id)?.seq ?? 0);
}

/**
 * What the page shows for a song: the newer (by write number) of what a list
 * said and what was confirmed here — value and number from the same source —
 * unless a rating was given since elsewhere in this app (the sheet, the
 * player keys): that one is shown. Its number is not known here, so a change
 * made on top of it is checked by the server and answered as "rated since".
 */
export function shown(t: HistoryEntry): { value: Value; seq: number; s: SongRating | null } {
	const s = songs.get(t.id) ?? null;
	const b = known(t);
	const o = store.thumbOverride(t.id);
	return { value: o && o !== b.seen ? o.v : b.value, seq: b.seq, s };
}

/** The newer (by write number) of a list read and a confirmation here: value and number of one source. */
function known(t: HistoryEntry): { value: Value; seq: number; seen: Override } {
	const s = songs.get(t.id);
	const l = listed.get(t.id) ?? { value: t.thumb, seq: t.rated ?? 0, seen: undefined };
	return s && s.seq >= l.seq ? { value: s.value, seq: s.seq, seen: s.seen } : l;
}

export function busy(s: SongRating | null): boolean {
	return !!s && (s.phase === "saving" || s.phase === "checking" || s.phase === "undoing");
}

/** The last thing said, for the page's live region. */
export function lastSaid(): string {
	return said;
}

export function useHistoryRatings(): void {
	const [, force] = useState(0);
	useEffect(() => {
		const l = () => force((n) => n + 1);
		listeners.add(l);
		return () => {
			listeners.delete(l);
		};
	}, []);
}

const NAMES: Record<string, string> = {
	"1": "Favorit",
	"-1": "Nie wieder",
	"0": "keine Bewertung",
};
export const ratingName = (v: Value) => NAMES[String(v)]!;

function newId(): string {
	const a = new Uint8Array(12);
	crypto.getRandomValues(a);
	return `h${Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Starts an operation on a song; its answer counts only while it is still the newest. */
function begin(t: HistoryEntry, patch: Partial<SongRating>) {
	const base = known(t);
	const prev = songs.get(t.id);
	const op = (prev?.op ?? 0) + 1;
	// What this operation starts from; a rating given elsewhere in this app
	// while it runs shows as a different override object.
	const startOverride = store.thumbOverride(t.id);
	songs.set(t.id, {
		phase: "idle",
		intent: null,
		receipt: null,
		error: null,
		overtaken: false,
		alreadyUndone: false,
		...prev,
		value: base.value,
		seq: base.seq,
		seen: base.seen,
		...patch,
		op,
	});
	emit();
	const gen = generation;
	return {
		startOverride,
		/** Still this account and this operation. */
		live: () => gen === generation && songs.get(t.id)?.op === op,
		set: (p: Partial<SongRating>, say?: string) => {
			if (gen !== generation || songs.get(t.id)?.op !== op) return;
			songs.set(t.id, { ...songs.get(t.id)!, ...p });
			if (say) said = say;
			emit();
		},
	};
}
type Run = ReturnType<typeof begin>;

/** Whether an error leaves open that the server stored it (no answer, or a failure on its side). */
const lost = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 500;

/**
 * Takes a rating as holding now — only when it is not older (by number) than
 * what is known here, and nothing was rated in this app while it was asked
 * for; otherwise the newer known state stays. Returns whether it was taken.
 */
function holdsNow(
	t: HistoryEntry,
	value: Value,
	seq: number,
	askedWith: Override,
): Partial<SongRating> | null {
	if (seq < knownSeq(t)) return null;
	if (store.thumbOverride(t.id) !== askedWith) return null;
	return { value, seq, seen: tell(t.id, value) };
}

/**
 * The song's rating now, read from the server (after a stale, overtaken or
 * taken-back receipt). The read holds over what was known before it was asked
 * for; a list read or a rating given meanwhile keeps the newer state.
 */
async function readNow(
	t: HistoryEntry,
	run: Run,
	actionId: string,
): Promise<Partial<SongRating> | null> {
	const askedWith = store.thumbOverride(t.id);
	try {
		const { current } = await api.historyRatingReceipt(actionId, t.id);
		if (!run.live() || !current) return null;
		return holdsNow(t, current.value, current.seq, askedWith);
	} catch {
		return null;
	}
}

/**
 * A stored action, by its receipt: what holds now, and what is said. A
 * receipt neither taken back nor overtaken, as new as anything known here,
 * with nothing rated in this app meanwhile, holds; any other is the proof of
 * its action only, and what holds now is read.
 */
async function settleStored(
	t: HistoryEntry,
	run: Run,
	r: HistoryRatingReceipt,
	askedWith: Override,
	current?: { value: Value; seq: number },
): Promise<void> {
	const own = !r.superseded && !r.undo ? holdsNow(t, r.value, r.seq, askedWith) : null;
	if (own) {
		run.set(
			{ phase: "saved", receipt: r, error: null, intent: null, overtaken: false, ...own },
			`${t.name}: gespeichert — ${ratingName(r.value)}.`,
		);
		return;
	}
	if (r.undo) {
		// Taken back already (from another tab, or before the answer came).
		const now =
			(current ? holdsNow(t, current.value, current.seq, askedWith) : null) ??
			(await readNow(t, run, r.id));
		if (!run.live()) return;
		run.set(
			{
				phase: "undone",
				receipt: r,
				error: now ? null : "Der aktuelle Stand ließ sich nicht lesen; lade den Verlauf neu.",
				intent: null,
				overtaken: false,
				alreadyUndone: true,
				...(now ?? {}),
			},
			`${t.name}: gespeichert, aber schon zurückgenommen.`,
		);
		return;
	}
	const now =
		(current ? holdsNow(t, current.value, current.seq, askedWith) : null) ??
		(await readNow(t, run, r.id));
	if (!run.live()) return;
	const same = !!now && now.value === r.value && now.seq === r.seq;
	run.set(
		{
			phase: "saved",
			receipt: same ? r : { ...r, superseded: true },
			error: now ? null : "Der aktuelle Stand ließ sich nicht lesen; lade den Verlauf neu.",
			intent: null,
			overtaken: !same,
			...(now ?? {}),
		},
		same
			? `${t.name}: gespeichert — ${ratingName(r.value)}.`
			: now
				? `${t.name}: ${ratingName(r.value)} war gespeichert — inzwischen anders bewertet (jetzt: ${ratingName(now.value!)}).`
				: `${t.name}: ${ratingName(r.value)} war gespeichert; der aktuelle Stand ließ sich nicht lesen.`,
	);
}

/** Rate a song (the same intent again, after a failure, keeps its id: stored at most once). */
export function rate(t: HistoryEntry, value: Value, again = false): void {
	const cur = shown(t);
	if (busy(cur.s)) return;
	const intent =
		again && cur.s?.intent ? cur.s.intent : { actionId: newId(), value, basis: cur.seq };
	const run = begin(t, {
		phase: "saving",
		intent,
		error: null,
		overtaken: false,
		alreadyUndone: false,
	});
	const askedWith = run.startOverride;
	said = `${t.name}: wird gespeichert …`;
	api
		.rateFromHistory({
			actionId: intent.actionId,
			trackId: t.id,
			value: intent.value,
			basis: intent.basis,
		})
		.then(async (a) => {
			if (!run.live()) return;
			if (a.kind === "done") {
				await settleStored(t, run, a.receipt, askedWith);
				return;
			}
			// Nothing stored: the song was rated since the page read it. Its rating
			// then — unless something newer is known here, or was rated meanwhile.
			const now =
				holdsNow(t, a.current.value, a.current.seq, askedWith) ??
				(await readNow(t, run, intent.actionId));
			if (!run.live()) return;
			run.set(
				{ phase: "changed", intent: null, ...(now ?? {}) },
				`${t.name}: inzwischen anders bewertet. Nichts geändert.`,
			);
		})
		.catch((e: Error) => {
			if (!run.live()) return;
			if (!lost(e) && intent.mayStillArrive) {
				// This attempt was refused — an earlier one of the same decision ran
				// out of time and may still arrive: the refusal says nothing about it.
				// Still unclear, the same decision kept; nothing sent by itself.
				run.set(
					{
						phase: "unclear",
						intent,
						error: `Dieser Versuch wurde abgelehnt (${e.message}); der frühere kann aber noch ankommen. Nachsehen fragt erneut nach; gespeichert wird höchstens einmal.`,
					},
					`${t.name}: unklar, ob gespeichert.`,
				);
				return;
			}
			if (!lost(e)) {
				run.set(
					{ phase: "failed", error: e.message, intent: { ...intent, mayStillArrive: false } },
					`${t.name}: nicht gespeichert.`,
				);
				return;
			}
			// No answer in time: the request may still be on its way to the server —
			// and stays so for every later look (until a receipt or a new decision).
			const timedOut = e instanceof ApiError && e.code === "timeout";
			const kept = { ...intent, mayStillArrive: intent.mayStillArrive || timedOut };
			run.set({ intent: kept });
			check(t, run, e.message);
		});
}

/**
 * After a lost answer: the receipt says whether it was stored. Only the
 * last receipts are kept, so "none" means "not stored" only when the server
 * can prove it (no rating of the song since) and no request can still arrive;
 * otherwise it stays unclear. Never a second write by itself.
 */
function check(t: HistoryEntry, run: Run, why: string): void {
	const intent = songs.get(t.id)?.intent;
	if (!intent) return;
	const askedWith = store.thumbOverride(t.id);
	run.set({ phase: "checking", error: why });
	api
		.historyRatingReceipt(intent.actionId, t.id, intent.basis)
		.then(async ({ receipt, stored, current }) => {
			if (!run.live()) return;
			if (receipt) {
				await settleStored(t, run, receipt, askedWith, current);
				return;
			}
			if (stored === "no" && intent.mayStillArrive)
				run.set(
					{
						phase: "unclear",
						error:
							"Bisher nicht angekommen, kann aber noch ankommen. Nachsehen fragt erneut nach; Nochmal speichern schickt dieselbe Entscheidung — gespeichert wird höchstens einmal.",
					},
					`${t.name}: unklar, ob gespeichert.`,
				);
			else if (stored === "no")
				run.set({ phase: "failed", error: why }, `${t.name}: nicht gespeichert.`);
			else
				run.set(
					{
						phase: "unclear",
						error:
							"Der Song wurde inzwischen bewertet, vielleicht durch diesen Tipp. Lade den Verlauf neu, um den Stand zu sehen.",
					},
					`${t.name}: unklar, ob gespeichert.`,
				);
		})
		.catch((e: Error) => {
			if (!run.live()) return;
			run.set({ phase: "unclear", error: e.message }, `${t.name}: unklar, ob gespeichert.`);
		});
}

/** Look again whether the change on its way was stored (after "unklar"). */
export function recheck(t: HistoryEntry): void {
	const cur = shown(t);
	if (busy(cur.s) || !cur.s?.intent) return;
	const run = begin(t, {});
	check(t, run, cur.s.error ?? "");
}

const UNKNOWN_UNDO =
	"Diese Bewertung ist nicht mehr bekannt (nur die letzten werden aufgehoben); ob sie zurückgenommen wurde, lässt sich nicht mehr sagen. Lade den Verlauf neu, um den Stand zu sehen.";

/**
 * What a receipt says about taking back: done (or a conflict) — shown, with
 * what holds now; not done — said for sure; no receipt any more — unknown.
 * Never a second write by itself.
 */
async function tookBack(
	t: HistoryEntry,
	run: Run,
	r: HistoryRatingReceipt | null,
	notDone: string,
	askedWith: Override,
	current?: { value: Value; seq: number },
): Promise<void> {
	if (!r) {
		run.set(
			{ phase: "undo-unclear", error: UNKNOWN_UNDO },
			`${t.name}: unklar, ob zurückgenommen.`,
		);
		return;
	}
	if (!r.undo) {
		run.set(
			{ phase: "undo-failed", error: notDone, receipt: r },
			`${t.name}: nicht zurückgenommen.`,
		);
		return;
	}
	const u = r.undo;
	const now =
		(current ? holdsNow(t, current.value, current.seq, askedWith) : null) ??
		holdsNow(t, u.value, u.seq, askedWith) ??
		(await readNow(t, run, r.id));
	if (!run.live()) return;
	run.set(
		{
			phase: "undone",
			receipt: r,
			error: null,
			overtaken: false,
			alreadyUndone: false,
			...(now ?? {}),
		},
		u.outcome === "conflict"
			? `${t.name}: nicht zurückgenommen — inzwischen anders bewertet.`
			: `${t.name}: zurückgenommen — wieder ${ratingName(u.value)}.`,
	);
}

/** After a lost answer to taking back: the receipt says whether it happened. */
function checkUndo(t: HistoryEntry, run: Run, id: string, why: string): void {
	const askedWith = store.thumbOverride(t.id);
	run.set({ phase: "undoing", error: null });
	api
		.historyRatingReceipt(id, t.id)
		.then(async ({ receipt, current }) => {
			if (run.live()) await tookBack(t, run, receipt, why, askedWith, current);
		})
		.catch((e: Error) => {
			if (run.live())
				run.set(
					{ phase: "undo-unclear", error: `${e.message} Ob zurückgenommen wurde, ist unklar.` },
					`${t.name}: unklar, ob zurückgenommen.`,
				);
		});
}

/** Take back the rating confirmed here last (see docs/HISTORY_RATINGS.md for what stays). */
export function undo(t: HistoryEntry): void {
	const cur = shown(t);
	const receipt = cur.s?.receipt;
	if (busy(cur.s) || !receipt) return;
	const run = begin(t, { phase: "undoing", error: null });
	const askedWith = run.startOverride;
	said = `${t.name}: wird zurückgenommen …`;
	api
		.undoHistoryRating(receipt.id)
		.then(async ({ receipt: r }) => {
			if (run.live()) await tookBack(t, run, r, "Nicht zurückgenommen.", askedWith);
		})
		.catch((e: Error) => {
			if (!run.live()) return;
			if (!lost(e)) {
				run.set({ phase: "undo-failed", error: e.message }, `${t.name}: nicht zurückgenommen.`);
				return;
			}
			checkUndo(t, run, receipt.id, e.message);
		});
}

/** Look again whether taking back happened (after "unklar"). */
export function recheckUndo(t: HistoryEntry): void {
	const cur = shown(t);
	const receipt = cur.s?.receipt;
	if (busy(cur.s) || !receipt) return;
	const run = begin(t, {});
	checkUndo(t, run, receipt.id, cur.s?.error ?? "");
}
