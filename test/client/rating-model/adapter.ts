/**
 * Systems under test behind one interface: the actual store + Verlauf ratings
 * (`realAdapter`), and pure test adapters (`PureAdapter`) — correct, or with
 * one deliberate fault each, to show that the replay finds such faults.
 * Every adapter talks to the synthetic server only through the `Port`.
 */
import type {
	AppState,
	HistoryEntry,
	HistoryRateAnswer,
	HistoryRatingLookup,
	HistoryRatingReceipt,
	TrackView,
} from "../../../src/shared/api";
import { SONGS, type SongIx, type Value } from "./model";

export interface Port {
	state(): Promise<AppState>;
	/** A Verlauf page; which songs it lists is decided by the replay. */
	history(): Promise<HistoryEntry[]>;
	rateFromHistory(r: {
		actionId: string;
		trackId: string;
		value: Value;
		basis: number;
	}): Promise<HistoryRateAnswer>;
	undoHistoryRating(id: string): Promise<{ receipt: HistoryRatingReceipt | null }>;
	historyRatingReceipt(id: string, trackId: string, basis?: number): Promise<HistoryRatingLookup>;
}

export interface Observed {
	/** What the Verlauf shows (value, write number). */
	verlauf: { v: Value; rev: number };
	/** What the store shows everywhere else (`thumbOf`). */
	store: Value;
}

export interface Observation {
	songs: Observed[];
	sheet: { s: SongIx; v: Value } | null;
}

export interface Adapter {
	snapshotAsk(): void;
	listAsk(first: boolean): void;
	thumb(s: SongIx, v: Value): void;
	rate(s: SongIx, v: Value): void;
	undo(s: SongIx): void;
	open(s: SongIx): void;
	close(): void;
	observe(): Observation;
}

const row = (s: SongIx): HistoryEntry => ({
	id: SONGS[s],
	name: SONGS[s],
	artists: "Test Artist",
	album: "Test Album",
	imageUrl: null,
	durationMs: 180_000,
	thumb: 0,
	rated: 0,
	playedAt: 1,
	stationName: null,
	ignored: false,
});

type Store = typeof import("../../../src/client/store").store;
type Ratings = typeof import("../../../src/client/history-ratings");

/** The actual store and Verlauf ratings, driven like the app drives them. */
export function realAdapter(store: Store, ratings: Ratings, port: Port): Adapter {
	return {
		snapshotAsk: () => void store.refresh(true, false, true),
		listAsk(first) {
			// As the Verlauf screen does (menu.tsx): startListRead, then takeListed.
			const read = ratings.startListRead();
			void port.history().then((rows) => ratings.takeListed(rows, read, first));
		},
		thumb: (s, v) => store.setThumb(SONGS[s], v),
		rate: (s, v) => ratings.rate(row(s), v),
		undo: (s) => ratings.undo(row(s)),
		open(s) {
			const st = store.load.kind === "ready" ? store.load.state : null;
			const t = st?.session?.queue.find((e) => e.track.id === SONGS[s])?.track;
			if (t) store.rate(t);
		},
		close: () => store.rate(null),
		observe() {
			const open = store.rating;
			const ix = open ? SONGS.indexOf(open.id as (typeof SONGS)[number]) : -1;
			return {
				songs: SONGS.map((_, i) => {
					const sh = ratings.shown(row(i as SongIx));
					return {
						verlauf: { v: sh.value, rev: sh.seq },
						store: store.thumbOf({ id: SONGS[i]!, thumb: 0 }),
					};
				}),
				sheet: open && ix >= 0 ? { s: ix as SongIx, v: store.thumbOf(open) } : null,
			};
		},
	};
}

export interface Faults {
	/** Forgets which decision a read accounted for. */
	lostSeen?: boolean;
	/** Drops later Verlauf pages. */
	ignoreFollowPage?: boolean;
	/** Takes a lower write number over a higher one. */
	lowerRevision?: boolean;
	/** On an equal write number keeps nothing of what the new read accounts for. */
	wrongTie?: boolean;
}

type Thumb = { v: Value; at: number };

/**
 * A small pure re-implementation of the intended rule (not the product code),
 * with switchable faults. Without faults it must pass every replay.
 */
export class PureAdapter implements Adapter {
	private thumbs = new Map<SongIx, Thumb>();
	private stored = new Map<SongIx, { v: Value; rev: number }>();
	private covered = new WeakMap<Thumb, number>();
	private receipts = new Map<SongIx, HistoryRatingReceipt>();
	private sheet: SongIx | null = null;
	private ids = 0;

	constructor(
		private port: Port,
		private now: () => number,
		private faults: Faults = {},
	) {}

	private note(s: SongIx, v: Value, rev: number, seen?: Thumb): void {
		const cur = this.stored.get(s);
		const tie = !!cur && rev === cur.rev;
		if (seen && !this.faults.lostSeen && !(tie && this.faults.wrongTie)) {
			const was = this.covered.get(seen);
			if (was === undefined || rev < was) this.covered.set(seen, rev);
		}
		if (!cur || rev > cur.rev || (this.faults.lowerRevision && rev < cur.rev))
			this.stored.set(s, { v, rev });
	}

	private shownOf(s: SongIx): Value {
		const own = this.thumbs.get(s);
		const st = this.stored.get(s)!;
		const at = own ? this.covered.get(own) : undefined;
		return own && !(at !== undefined && at <= st.rev) ? own.v : st.v;
	}

	snapshotAsk(): void {
		const asked = this.now();
		void this.port.state().then((st) => {
			for (const e of st.session!.queue) {
				const s = SONGS.indexOf(e.track.id as (typeof SONGS)[number]) as SongIx;
				const own = this.thumbs.get(s);
				if (own && own.at < asked) this.thumbs.delete(s);
				this.note(s, e.track.thumb, e.track.rated!);
			}
		});
	}

	listAsk(first: boolean): void {
		const known = new Map(this.thumbs);
		void this.port.history().then((rows) => {
			if (!first && this.faults.ignoreFollowPage) return;
			for (const r of rows) {
				const s = SONGS.indexOf(r.id as (typeof SONGS)[number]) as SongIx;
				const own = this.thumbs.get(s);
				const seen = own && known.get(s) === own ? own : undefined;
				this.note(s, r.thumb, r.rated!, seen);
				if (first && seen) this.thumbs.delete(s);
			}
		});
	}

	thumb(s: SongIx, v: Value): void {
		this.thumbs.set(s, { v, at: this.now() });
	}

	private take(s: SongIx, v: Value, rev: number): void {
		const t = { v, at: this.now() };
		this.thumbs.set(s, t);
		this.note(s, v, rev, t);
	}

	private async settle(
		s: SongIx,
		asked: Thumb | undefined,
		offered: { v: Value; rev: number },
		id: string,
	) {
		if (this.thumbs.get(s) === asked && offered.rev >= this.stored.get(s)!.rev) {
			this.take(s, offered.v, offered.rev);
			return;
		}
		const { current } = await this.port.historyRatingReceipt(id, SONGS[s]);
		if (current) this.take(s, current.value, current.seq);
	}

	rate(s: SongIx, v: Value): void {
		const actionId = `p${++this.ids}`;
		const asked = this.thumbs.get(s);
		void this.port
			.rateFromHistory({ actionId, trackId: SONGS[s], value: v, basis: this.stored.get(s)!.rev })
			.then(async (a) => {
				if (a.kind === "done") {
					this.receipts.set(s, a.receipt);
					await this.settle(s, asked, { v: a.receipt.value, rev: a.receipt.seq }, actionId);
				} else await this.settle(s, asked, { v: a.current.value, rev: a.current.seq }, actionId);
			});
	}

	undo(s: SongIx): void {
		const r = this.receipts.get(s);
		if (!r) return;
		const asked = this.thumbs.get(s);
		void this.port.undoHistoryRating(r.id).then(async ({ receipt }) => {
			const u = receipt?.undo;
			if (u) await this.settle(s, asked, { v: u.value, rev: u.seq }, r.id);
		});
	}

	open(s: SongIx): void {
		this.sheet = s;
	}

	close(): void {
		this.sheet = null;
	}

	observe(): Observation {
		return {
			songs: SONGS.map((_, i) => {
				const s = i as SongIx;
				const v = this.shownOf(s);
				return { verlauf: { v, rev: this.stored.get(s)!.rev }, store: v };
			}),
			sheet: this.sheet === null ? null : { s: this.sheet, v: this.shownOf(this.sheet) },
		};
	}
}

export type { TrackView };
