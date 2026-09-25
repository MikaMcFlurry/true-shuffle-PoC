/**
 * The per-listener Durable Object. A thin shell: it owns the storage, the
 * alarm and a mutex, and delegates everything else to HubCore.
 *
 * Why a mutex inside a single-threaded object: a Durable Object delivers the
 * next request while the current one awaits network I/O. Without the lock an
 * app tap could interleave with a background sync mid-deck-rewrite.
 */

import { DurableObject } from "cloudflare:workers";
import { cryptoRng } from "../core/random";
import type { StationRules } from "../core/types";
import type { StationKind, StationSource } from "../shared/api";
import { type Env, hubEnv } from "./env";
import { HubCore, HubError } from "./hub/hub";
import { Keys } from "./lib/crypto";
import type { SqlDb, SqlValue } from "./lib/sql";
import type { SpotifyTokens } from "./spotify/client";

export type RpcResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: string; message: string; status: number } };

export class UserHub extends DurableObject<Env> {
	private core: HubCore | null = null;
	private chain: Promise<unknown> = Promise.resolve();

	private hub(): HubCore {
		if (!this.core) {
			const storage = this.ctx.storage;
			this.core = new HubCore({
				sql: durableObjectSql(storage),
				fetch: (req) => fetch(req),
				now: () => Date.now(),
				rng: cryptoRng(),
				keys: new Keys(this.env.APP_SECRET ?? ""),
				env: hubEnv(this.env),
				alarms: {
					set: (at) => storage.setAlarm(at),
					get: () => storage.getAlarm(),
				},
				ai: this.env.AI
					? { run: (model, input) => this.env.AI!.run(model as never, input as never) }
					: null,
				wipe: async () => {
					await storage.deleteAlarm();
					await storage.deleteAll();
					this.core = null;
				},
			});
		}
		return this.core;
	}

	/** Serialise every operation on this listener's state. */
	private exclusive<T>(fn: () => Promise<T> | T): Promise<RpcResult<T>> {
		const run = this.chain.then(async (): Promise<RpcResult<T>> => {
			try {
				return { ok: true, value: await fn() };
			} catch (err) {
				if (err instanceof HubError)
					return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
				console.error("hub error", err);
				return {
					ok: false,
					error: {
						code: "internal",
						message: "Interner Fehler — bitte nochmal versuchen.",
						status: 500,
					},
				};
			}
		});
		this.chain = run.catch(() => undefined);
		return run;
	}

	attach(profile: { id: string; name: string; imageUrl: string | null }, tokens: SpotifyTokens) {
		return this.exclusive(() => this.hub().connect(profile, tokens));
	}
	isConnected() {
		return this.exclusive(() => this.hub().isConnected());
	}
	state(live: boolean) {
		return this.exclusive(() => this.hub().state({ live }));
	}
	playlists() {
		return this.exclusive(() => this.hub().listPlaylists());
	}
	onboard(ids: string[]) {
		return this.exclusive(() => this.hub().onboard(ids));
	}
	createStation(input: {
		name: string;
		sources: StationSource[];
		rules?: Partial<StationRules>;
		kind?: StationKind;
	}) {
		return this.exclusive(async () => {
			const id = this.hub().createStation({
				...input,
				kind: input.kind === "all" ? "all" : "custom",
			});
			await this.hub().scheduleSoon(500);
			return id;
		});
	}
	updateStation(
		id: number,
		patch: { name?: string; rules?: Partial<StationRules>; sources?: StationSource[] },
	) {
		return this.exclusive(async () => {
			this.hub().updateStation(id, patch);
			await this.hub().scheduleSoon(1000);
		});
	}
	deleteStation(id: number) {
		return this.exclusive(() => this.hub().deleteStation(id));
	}
	stationDetail(id: number) {
		return this.exclusive(() => this.hub().stationDetail(id));
	}
	play(stationId: number, deviceId: string | null) {
		return this.exclusive(() => this.hub().play(stationId, deviceId));
	}
	playerAction(action: "pause" | "resume" | "next") {
		return this.exclusive(() => this.hub().playerAction(action));
	}
	devices() {
		return this.exclusive(() => this.hub().devices());
	}
	thumb(trackId: string, value: -1 | 0 | 1) {
		return this.exclusive(() => this.hub().thumb(trackId, value));
	}
	setGuest(on: boolean, hours?: number) {
		return this.exclusive(() => this.hub().setGuest(on, hours));
	}
	importHistory(rows: [string, number, number, number][], part: number, parts: number) {
		return this.exclusive(() => this.hub().importHistory(rows, part, parts));
	}
	history(limit: number, before?: number) {
		return this.exclusive(() => this.hub().history(limit, before));
	}
	syncNow() {
		return this.exclusive(async () => {
			await this.hub().scheduleSoon(0);
		});
	}
	ensureAlarm() {
		return this.exclusive(() => this.hub().ensureAlarm());
	}
	deleteAccount() {
		return this.exclusive(() => this.hub().deleteAccount());
	}

	override async alarm(): Promise<void> {
		await this.exclusive(() => this.hub().alarm());
	}
}

/** Adapter for `ctx.storage.sql` + `ctx.storage.transactionSync`. */
function durableObjectSql(storage: DurableObjectStorage): SqlDb {
	const sql = storage.sql;
	return {
		all<T>(query: string, ...params: SqlValue[]): T[] {
			return sql.exec(query, ...params).toArray() as T[];
		},
		first<T>(query: string, ...params: SqlValue[]): T | null {
			const rows = sql.exec(query, ...params).toArray();
			return (rows[0] as T | undefined) ?? null;
		},
		run(query: string, ...params: SqlValue[]): void {
			sql.exec(query, ...params);
		},
		transaction<R>(fn: () => R): R {
			return storage.transactionSync(fn);
		},
	};
}
