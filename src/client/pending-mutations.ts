/**
 * Writes on their way from this page: every request of api.ts that is not a
 * read, from before it is sent until its answer was read and judged, whatever
 * the outcome. Only for the page's own sense of "something is being saved";
 * it sends, delays, cancels or changes nothing.
 *
 * The end of the last write is not yet a quiet moment: what its answer starts
 * (a second answer that waited for the first) comes in the same task. Quiet
 * is told only from the next task on, when nothing started meanwhile.
 */

export class PendingMutations {
	private open = 0;
	/** The last write ended; quiet once the task it ended in is over. */
	private settling = false;
	/** Every start and every last end: a quiet moment queued before no longer counts. */
	private turn = 0;
	private readonly listeners = new Set<() => void>();

	/** A write starts now; the returned end counts once, however often called. */
	begin(): () => void {
		const was = this.busy();
		this.open++;
		this.turn++;
		this.settling = false;
		if (!was) this.changed();
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			this.open--;
			if (this.open > 0) return;
			this.settling = true;
			const turn = ++this.turn;
			setTimeout(() => {
				if (turn !== this.turn) return;
				this.settling = false;
				this.changed();
			}, 0);
		};
	}

	/** A write on its way, or the last one's answer still being handled. */
	busy(): boolean {
		return this.open > 0 || this.settling;
	}

	/** Writes on their way now. */
	get count(): number {
		return this.open;
	}

	/** Told when the page becomes busy and when it is quiet again. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private changed(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// A listener's failure is its own: never a request's, never the count's.
			}
		}
	}
}

/** This page's writes. */
export const pendingMutations = new PendingMutations();
