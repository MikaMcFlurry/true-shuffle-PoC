/**
 * The replay: a synthetic server (one account, three songs), held answers
 * given by command, the model fed with the same requests, and after every
 * command the system under test compared with the model under the eight
 * contracts. The trace is normalised (no random ids, no wall time) so the same
 * commands always give the same bytes.
 */
import { createHash } from "node:crypto";
import type {
	AppState,
	HistoryEntry,
	HistoryRateAnswer,
	HistoryRatingReceipt,
} from "../../../src/shared/api";
import type { Adapter, Observation, Port } from "./adapter";
import { type Command, show } from "./commands";
import { type ContractId, type Rated, RatingModel, SONGS, type SongIx, type Value } from "./model";

/** Initial server ratings: A 0 at 1, B +1 at 3, C −1 at 2. */
export const INITIAL: Rated[] = [
	{ v: 0, rev: 1 },
	{ v: 1, rev: 3 },
	{ v: -1, rev: 2 },
];

class Server {
	songs: Rated[] = INITIAL.map((r) => ({ ...r }));
	receipts = new Map<string, { s: SongIx; r: HistoryRatingReceipt }>();
	time = 100;

	write(s: SongIx, v: Value): void {
		const cur = this.songs[s]!;
		this.songs[s] = { v, rev: cur.rev + 1 };
	}

	rate(id: string, s: SongIx, v: Value, basis: number): HistoryRateAnswer {
		const known = this.receipts.get(id);
		if (known) return { kind: "done", receipt: { ...known.r } };
		const cur = this.songs[s]!;
		if (basis !== cur.rev) return { kind: "changed", current: { value: cur.v, seq: cur.rev } };
		this.write(s, v);
		const r: HistoryRatingReceipt = {
			id,
			trackId: SONGS[s],
			value: v,
			prev: cur.v,
			at: 1,
			seq: this.songs[s]!.rev,
			skip: "none",
			skipError: null,
			superseded: false,
			undo: null,
			lasting: [],
		};
		this.receipts.set(id, { s, r });
		return { kind: "done", receipt: { ...r } };
	}

	undo(id: string): HistoryRatingReceipt | null {
		const k = this.receipts.get(id);
		if (!k) return null;
		if (k.r.undo) return { ...k.r };
		const cur = this.songs[k.s]!;
		if (cur.rev !== k.r.seq) {
			k.r = { ...k.r, undo: { at: 2, outcome: "conflict", notes: [], value: cur.v, seq: cur.rev } };
		} else {
			this.write(k.s, k.r.prev);
			const now = this.songs[k.s]!;
			k.r = { ...k.r, undo: { at: 2, outcome: "undone", notes: [], value: now.v, seq: now.rev } };
		}
		return { ...k.r };
	}

	track(s: SongIx) {
		return {
			id: SONGS[s],
			name: SONGS[s],
			artists: "Test Artist",
			album: "Test Album",
			imageUrl: null,
			durationMs: 180_000,
			thumb: this.songs[s]!.v,
			rated: this.songs[s]!.rev,
		};
	}

	snapshot(): AppState {
		return {
			profile: { id: "listener-a", name: "listener-a", imageUrl: null },
			onboarded: true,
			stations: [],
			session: {
				sessionId: "S",
				stationId: 1,
				entryId: "S:0",
				orderRevision: 1,
				progressMs: 0,
				observedAt: 100,
				status: "active",
				pending: false,
				queue: SONGS.map((_, i) => ({ entryId: `S:${i}`, track: this.track(i as SongIx) })),
			},
			nowPlaying: null,
			guest: { active: false, until: null },
			warnings: [],
			jobs: [],
			history: { importedTracks: 0, importedAt: null, liveSince: null },
			aiSource: "off",
			serverTime: ++this.time,
		} as unknown as AppState;
	}
}

type Held<T> = { value: T; resolve: (v: T) => void };

/** The port: requests answered by the server at once, the answers held until a command gives them. */
class HeldPort implements Port {
	snap: Held<AppState> | null = null;
	list: Held<HistoryEntry[]> | null = null;
	ops = new Map<SongIx, Held<unknown> & { basis?: number }>();
	nextList: SongIx[] = [];
	lastBasis: number | undefined;
	lastOpSong: SongIx | null = null;

	constructor(private server: Server) {}

	private hold<T>(value: T, set: (h: Held<T>) => void): Promise<T> {
		return new Promise<T>((resolve) => set({ value, resolve }));
	}

	state(): Promise<AppState> {
		return this.hold(this.server.snapshot(), (h) => {
			this.snap = h;
		});
	}

	history(): Promise<HistoryEntry[]> {
		const rows = this.nextList.map((s) => ({
			...this.server.track(s),
			playedAt: 1,
			stationName: null,
			ignored: false,
		}));
		return this.hold(rows as HistoryEntry[], (h) => {
			this.list = h;
		});
	}

	rateFromHistory(r: { actionId: string; trackId: string; value: Value; basis: number }) {
		const s = SONGS.indexOf(r.trackId as (typeof SONGS)[number]) as SongIx;
		this.lastBasis = r.basis;
		this.lastOpSong = s;
		const answer = this.server.rate(r.actionId, s, r.value, r.basis);
		return this.hold(answer, (h) => this.ops.set(s, h as Held<unknown>));
	}

	undoHistoryRating(id: string) {
		const k = this.server.receipts.get(id);
		const receipt = this.server.undo(id);
		if (k) this.lastOpSong = k.s;
		return this.hold({ receipt }, (h) => {
			if (k) this.ops.set(k.s, h as Held<unknown>);
		});
	}

	historyRatingReceipt(id: string, trackId: string) {
		const s = SONGS.indexOf(trackId as (typeof SONGS)[number]) as SongIx;
		const k = this.server.receipts.get(id);
		const cur = this.server.songs[s]!;
		return Promise.resolve({
			receipt: k ? { ...k.r, superseded: k.r.seq !== cur.rev } : null,
			stored: "yes" as const,
			current: { value: cur.v, seq: cur.rev },
		});
	}
}

export interface Violation {
	step: number;
	contract: ContractId;
	song: string;
	detail: string;
}

export interface Step {
	i: number;
	cmd: string;
	applied: boolean;
	server: string;
	expected: string;
	observed: string;
}

/**
 * One Verlauf rate/undo request sent (`asked`) or its answer given and fed to
 * the system under test (`answered`), with what the answer offered and the
 * newest write number known just before it. Kept beside the trace, not in it,
 * so the normalised trace bytes (and their sha256) stay as they were.
 */
export interface OpRecord {
	step: number;
	song: string;
	kind: "rate" | "undo";
	phase: "asked" | "answered";
	/** Answer only: done / changed (rate), undone / conflict (undo). */
	outcome?: string;
	offered?: Rated;
	knownBefore?: number;
	/** Answer only: its write number is below the newest known before it. */
	late?: boolean;
}

export interface ReplayResult {
	steps: Step[];
	violations: Violation[];
	/** Every Verlauf rate/undo request and answer, in order (not hashed). */
	ops: OpRecord[];
	trace: string;
	sha256: string;
}

export interface Env {
	/** Lets every pending promise run (answers, `.then` chains). */
	flush(): Promise<void>;
	/** Moves the frozen clock on one millisecond. */
	tick(): void;
	now(): number;
}

const fmt = (o: Observation) =>
	`${o.songs.map((x, i) => `${"ABC"[i]}=${x.verlauf.v}@${x.verlauf.rev}/${x.store}`).join(" ")}${
		o.sheet ? ` sheet:${"ABC"[o.sheet.s]}=${o.sheet.v}` : ""
	}`;

/**
 * Replays `commands` against the adapter made by `make` (given the port).
 * Stops checking further after `stopAtFirst` violations only to keep shrunk
 * counterexamples short; the trace always covers every command.
 */
export async function replay(
	commands: Command[],
	make: (port: Port) => Adapter | Promise<Adapter>,
	env: Env,
): Promise<ReplayResult> {
	const server = new Server();
	const port = new HeldPort(server);
	const model = new RatingModel(INITIAL);
	const sut = await make(port);
	const steps: Step[] = [];
	const violations: Violation[] = [];
	let token = 0;
	let snapToken: number | null = null;
	let listToken: number | null = null;
	let listFirst = true;
	let firstAnswered = false;
	let listRows: (Rated | null)[] = [];
	const opPending = new Map<SongIx, "rate" | "undo">();
	const lastDone = new Map<SongIx, boolean>();
	const ops: OpRecord[] = [];
	let prev: Observation | null = null;

	const ask = async () => {
		snapToken = ++token;
		sut.snapshotAsk();
		await env.flush();
		const st = port.snap?.value;
		model.snapshotAsked(
			snapToken,
			env.now(),
			(st?.session?.queue ?? []).map((e) => ({ v: e.track.thumb, rev: e.track.rated! })),
		);
	};
	const answerSnap = async () => {
		const h = port.snap;
		port.snap = null;
		model.snapshotAnswered(snapToken!);
		snapToken = null;
		h?.resolve(h.value);
		await env.flush();
	};

	// The app starts with one accepted snapshot, then the clock moves on.
	await ask();
	await answerSnap();
	env.tick();

	const check = (
		i: number,
		cmd: Command | null,
		before: Rated[],
		late: (Rated | null)[] | null,
	) => {
		const o = sut.observe();
		SONGS.forEach((name, ix) => {
			const s = ix as SongIx;
			const e = model.expected(s);
			const got = o.songs[s]!;
			const add = (contract: ContractId, detail: string) =>
				violations.push({ step: i, contract, song: name, detail });
			const wasRev = before[s]!.rev;
			const offered = late?.[s] ?? null;
			if (got.verlauf.rev < e.rev) {
				if (cmd?.k === "listAnswer" && !listFirstOfToken && offered && offered.rev > wasRev)
					add("C6", `later page at ${offered.rev} not counted (shown ${got.verlauf.rev})`);
				add("C1", `shown write ${got.verlauf.rev} below newest ${e.rev}`);
			} else if (got.verlauf.rev > e.rev)
				add("C2", `shown write ${got.verlauf.rev} above newest ${e.rev}`);
			if (prev && got.verlauf.rev < prev.songs[s]!.verlauf.rev)
				add("C1", `shown write fell ${prev.songs[s]!.verlauf.rev} → ${got.verlauf.rev}`);
			for (const [where, v] of [
				["verlauf", got.verlauf.v],
				["store", got.store],
			] as const) {
				if (v === e.v) continue;
				const d = `${where} shows ${v}, expected ${e.v} (${e.byDecision ? "local decision" : `write ${e.rev}`})`;
				if (offered && offered.rev < wasRev) add("C7", `late answer at ${offered.rev}: ${d}`);
				else if (offered && offered.rev === wasRev && (e.accountedDecision || e.byDecision))
					add("C8", `equal write ${offered.rev}: ${d}`);
				else if (cmd?.k === "listAnswer" && !listFirstOfToken && offered) add("C6", d);
				else if (e.byDecision) add("C3", d);
				else if (e.accountedDecision) add("C4", d);
				else add("C2", d);
			}
			if (o.sheet?.s === s && (o.sheet.v !== got.verlauf.v || o.sheet.v !== got.store))
				add("C5", `sheet ${o.sheet.v}, Verlauf ${got.verlauf.v}, store ${got.store}`);
			else if (got.store !== got.verlauf.v)
				add("C5", `store ${got.store}, Verlauf ${got.verlauf.v}`);
			if (model.sheet === s && !(o.sheet?.s === s)) add("C5", "sheet not open on this song");
		});
		prev = o;
		return o;
	};
	let listFirstOfToken = false;

	check(
		-1,
		null,
		model.known.map((r) => ({ ...r })),
		null,
	);

	for (let i = 0; i < commands.length; i++) {
		const c = commands[i]!;
		const before = model.known.map((r) => ({ ...r }));
		let applied = true;
		let late: (Rated | null)[] | null = null;
		switch (c.k) {
			case "tick":
				env.tick();
				break;
			case "ext":
				server.write(c.s, c.v);
				break;
			case "thumb":
				server.write(c.s, c.v);
				sut.thumb(c.s, c.v);
				model.localDecision(c.s, c.v, env.now());
				break;
			case "snapAsk":
				if (snapToken !== null) applied = false;
				else await ask();
				break;
			case "snapAnswer":
				if (snapToken === null) applied = false;
				else {
					late = (port.snap?.value.session?.queue ?? []).map((e) => ({
						v: e.track.thumb,
						rev: e.track.rated!,
					}));
					await answerSnap();
				}
				break;
			case "listAsk":
				if (listToken !== null || (!listFirst && !firstAnswered)) applied = false;
				else {
					const songs = listFirst ? [0, 1, 2] : [0, 1, 2].filter((s) => c.songs[s]);
					port.nextList = songs as SongIx[];
					listRows = SONGS.map((_, s) =>
						songs.includes(s) ? { ...server.songs[s as SongIx]! } : null,
					);
					listToken = ++token;
					listFirstOfToken = listFirst;
					model.listAsked(listToken, listRows);
					sut.listAsk(listFirst);
					listFirst = false;
					await env.flush();
				}
				break;
			case "listAnswer":
				if (listToken === null) applied = false;
				else {
					const h = port.list;
					port.list = null;
					late = listRows.map((r) => (r ? { ...r } : null));
					model.listAnswered(listToken);
					if (listFirstOfToken) firstAnswered = true;
					listToken = null;
					h?.resolve(h.value);
					await env.flush();
				}
				break;
			case "rate":
				if (!firstAnswered || opPending.has(c.s)) applied = false;
				else {
					port.lastBasis = undefined;
					port.lastOpSong = null;
					model.opAsked(c.s);
					sut.rate(c.s, c.v);
					await env.flush();
					if (port.lastOpSong !== c.s || !port.ops.has(c.s)) {
						violations.push({
							step: i,
							contract: "C1",
							song: SONGS[c.s]!,
							detail: "no rate request sent",
						});
						applied = false;
					} else {
						if (port.lastBasis !== before[c.s]!.rev)
							violations.push({
								step: i,
								contract: "C1",
								song: SONGS[c.s]!,
								detail: `rate sent basis ${port.lastBasis}, newest known ${before[c.s]!.rev}`,
							});
						opPending.set(c.s, "rate");
						lastDone.set(c.s, false);
						ops.push({ step: i, song: SONGS[c.s]!, kind: "rate", phase: "asked" });
					}
				}
				break;
			case "undo":
				if (!lastDone.get(c.s) || opPending.has(c.s)) applied = false;
				else {
					port.lastOpSong = null;
					model.opAsked(c.s);
					sut.undo(c.s);
					await env.flush();
					if (!port.ops.has(c.s)) {
						violations.push({
							step: i,
							contract: "C1",
							song: SONGS[c.s]!,
							detail: "no undo request sent",
						});
						applied = false;
					} else {
						opPending.set(c.s, "undo");
						lastDone.set(c.s, false);
						ops.push({ step: i, song: SONGS[c.s]!, kind: "undo", phase: "asked" });
					}
				}
				break;
			case "opAnswer": {
				const s = opPending.has(c.s) ? c.s : ([0, 1, 2] as SongIx[]).find((x) => opPending.has(x));
				if (s === undefined) {
					applied = false;
					break;
				}
				const h = port.ops.get(s);
				const kind = opPending.get(s);
				if (!h || !kind) {
					applied = false;
					break;
				}
				port.ops.delete(s);
				opPending.delete(s);
				const v = h.value as HistoryRateAnswer | { receipt: HistoryRatingReceipt | null };
				let offered: Rated;
				let outcome: string;
				if ("kind" in v) {
					offered =
						v.kind === "done"
							? { v: v.receipt.value, rev: v.receipt.seq }
							: { v: v.current.value, rev: v.current.seq };
					outcome = v.kind;
					lastDone.set(s, v.kind === "done");
				} else {
					const u = v.receipt!.undo!;
					offered = { v: u.value, rev: u.seq };
					outcome = u.outcome;
				}
				ops.push({
					step: i,
					song: SONGS[s]!,
					kind,
					phase: "answered",
					outcome,
					offered: { ...offered },
					knownBefore: before[s]!.rev,
					late: offered.rev < before[s]!.rev,
				});
				const now = { ...server.songs[s]! };
				late = before.map((_, x) => (x === s ? offered : null));
				model.opAnswered(s, offered, now, env.now());
				h.resolve(h.value);
				await env.flush();
				break;
			}
			case "open":
				sut.open(c.s);
				model.openSheet(c.s);
				break;
			case "close":
				sut.close();
				model.openSheet(null);
				break;
		}
		await env.flush();
		const o = check(i, c, before, late);
		steps.push({
			i,
			cmd: show(c),
			applied,
			server: server.songs.map((r, s) => `${"ABC"[s]}=${r.v}@${r.rev}`).join(" "),
			expected: SONGS.map((_, s) => {
				const e = model.expected(s as SongIx);
				return `${"ABC"[s]}=${e.v}@${e.rev}${e.byDecision ? "*" : ""}`;
			}).join(" "),
			observed: fmt(o),
		});
	}
	const trace = JSON.stringify({ commands: commands.map(show), steps, violations }, null, 1);
	return {
		steps,
		violations,
		ops,
		trace,
		sha256: createHash("sha256").update(trace).digest("hex"),
	};
}
