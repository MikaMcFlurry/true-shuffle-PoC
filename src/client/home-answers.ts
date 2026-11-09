/**
 * Answers given on Home about the song playing — "Favorit" / "Nie wieder"
 * and the retest's "Gern wieder" / "Eher nicht" (CTO-01..04, 2026-10-15).
 *
 * One request per song at a time, so the server stores the answers in the
 * order they were given; an answer given while one is on its way waits, and
 * only the newest one is sent after it. A tap repeating the answer on its way
 * changes nothing (a double tap). What is said belongs to one occurrence of
 * the song in the queue (`occurrence`), never to the song alone: the same
 * song played again later is asked again, and an answer about an earlier
 * occurrence that arrives late is not shown on the later one. An answer still
 * waiting when its occurrence is over is not sent (it could reach the song
 * playing again). Pure: the sending and the clock-free notion of "now" come in
 * from outside.
 */

export interface Answer<V, R> {
	trackId: string;
	occurrence: string;
	/** The newest answer given (on its way, stored, or not stored). */
	value: V;
	phase: "saving" | "saved" | "failed";
	/** Why it was not stored. */
	error: string | null;
	/** The server's answer to the request that stored `value`. */
	result: R | null;
}

interface Given<V> {
	value: V;
	occurrence: string;
}

interface Slot<V, R> {
	sending: Given<V> | null;
	queued: Given<V> | null;
	answer: Answer<V, R>;
}

export const NOT_SENT_MOVED_ON = "Nicht gesendet: Der Song ist inzwischen weitergelaufen.";

export class Answers<V, R> {
	private slots = new Map<string, Slot<V, R>>();
	private alive = true;

	constructor(
		private readonly send: (trackId: string, value: V, occurrence: string) => Promise<R>,
		/** The occurrence playing now (null: none). */
		private readonly current: () => string | null,
		private readonly changed: () => void,
		/**
		 * Called for every answer the server stored: `final` when it is the
		 * newest one given; not final when a newer one waited meanwhile (what is
		 * stored then is still this one, until the newer one is stored too).
		 */
		private readonly stored: (a: Answer<V, R>, final: boolean) => void = () => {},
	) {}

	/** After this, answers still arriving change nothing (the page left, another account). */
	close(): void {
		this.alive = false;
	}

	of(trackId: string): Answer<V, R> | null {
		return this.slots.get(trackId)?.answer ?? null;
	}

	/** On its way for this song and occurrence: the newest answer given. */
	pending(trackId: string, occurrence: string): V | undefined {
		const a = this.of(trackId);
		return a?.phase === "saving" && a.occurrence === occurrence ? a.value : undefined;
	}

	/** Gives an answer; false when it changes nothing (the same answer is on its way). */
	give(trackId: string, occurrence: string, value: V): boolean {
		const slot = this.slots.get(trackId);
		if (slot?.sending) {
			const newest = slot.queued ?? slot.sending;
			if (newest.value === value && newest.occurrence === occurrence) return false;
			slot.queued = { value, occurrence };
			slot.answer = { ...this.base(trackId, slot.queued), phase: "saving" };
			this.changed();
			return true;
		}
		this.start(trackId, { value, occurrence });
		return true;
	}

	/** Sends a not stored answer again, while its occurrence still plays. */
	retry(trackId: string): boolean {
		const a = this.of(trackId);
		if (a?.phase !== "failed" || this.slots.get(trackId)?.sending) return false;
		if (this.current() !== a.occurrence) return false;
		this.start(trackId, { value: a.value, occurrence: a.occurrence });
		return true;
	}

	private base(trackId: string, g: Given<V>): Omit<Answer<V, R>, "phase"> {
		return { trackId, occurrence: g.occurrence, value: g.value, error: null, result: null };
	}

	private start(trackId: string, g: Given<V>): void {
		const slot: Slot<V, R> = {
			sending: g,
			queued: null,
			answer: { ...this.base(trackId, g), phase: "saving" },
		};
		this.slots.set(trackId, slot);
		this.changed();
		this.send(trackId, g.value, g.occurrence).then(
			(result) => this.settle(trackId, slot, g, { result }),
			(e: unknown) =>
				this.settle(trackId, slot, g, { error: e instanceof Error ? e.message : String(e) }),
		);
	}

	private settle(
		trackId: string,
		slot: Slot<V, R>,
		sent: Given<V>,
		outcome: { result: R } | { error: string },
	): void {
		if (!this.alive || this.slots.get(trackId) !== slot) return;
		const next = slot.queued;
		slot.sending = null;
		slot.queued = null;
		if (next && (next.value !== sent.value || next.occurrence !== sent.occurrence)) {
			// Stored, though no longer the newest: what holds now until the newer one is stored.
			if ("result" in outcome)
				this.stored({ ...this.base(trackId, sent), phase: "saved", result: outcome.result }, false);
			// A newer answer waited: it goes now, if its occurrence still plays.
			if (this.current() === next.occurrence) {
				this.start(trackId, next);
				return;
			}
			slot.answer = { ...this.base(trackId, next), phase: "failed", error: NOT_SENT_MOVED_ON };
			this.changed();
			return;
		}
		slot.answer =
			"result" in outcome
				? { ...this.base(trackId, sent), phase: "saved", result: outcome.result }
				: { ...this.base(trackId, sent), phase: "failed", error: outcome.error };
		if ("result" in outcome) this.stored(slot.answer, true);
		this.changed();
	}
}
