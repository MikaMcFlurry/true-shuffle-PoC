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
import type { RemoteAction, StationKind, StationSource } from "../shared/api";
import {
	type NativeCommand,
	NativeController,
	NativeError,
	nativeBinding,
	nativeIntentCurrent,
} from "./controllers/native";
import { type Env, hubEnv } from "./env";
import { type GenreAnswer, requestGenres } from "./hub/genres";
import { HubCore, HubError } from "./hub/hub";
import { Keys } from "./lib/crypto";
import type { SqlDb, SqlValue } from "./lib/sql";
import { type SpotifyCooldownScope, SpotifyError, type SpotifyTokens } from "./spotify/client";
import { boundedSpotifyRpc } from "./spotify/rpc";

export type RpcResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: string; message: string; status: number } };

export class UserHub extends DurableObject<Env> {
	private core: HubCore | null = null;
	private chain: Promise<unknown> = Promise.resolve();

	private hub(): HubCore {
		if (!this.core) {
			const storage = this.ctx.storage;
			const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
			const probeTokens = new Map<SpotifyCooldownScope | undefined, string>();
			this.core = new HubCore({
				sql: durableObjectSql(storage),
				sharedSpotify: {
					getOperationSnapshot: (operation) =>
						boundedSpotifyRpc(registry.spotifyOperationSnapshot(this.ctx.id.toString(), operation)),
					setOperationCooldown: (cooldown) =>
						boundedSpotifyRpc(registry.spotifyOperationBlocked(this.ctx.id.toString(), cooldown)),
					finishOperation: (operation, revision) =>
						boundedSpotifyRpc(
							registry.finishSpotifyOperation(this.ctx.id.toString(), operation, revision),
						),
					recordRequest: (metric) =>
						boundedSpotifyRpc(registry.recordSpotifyUsage(this.ctx.id.toString(), metric)),
					getCooldown: (scope) =>
						boundedSpotifyRpc(registry.spotifyCooldown(probeTokens.get(scope), scope)),
					getSnapshot: (scope) =>
						boundedSpotifyRpc(registry.spotifyGateSnapshot(probeTokens.get(scope), scope)),
					setCooldown: (cooldown) =>
						boundedSpotifyRpc(registry.spotifyBlocked(cooldown, probeTokens.get(cooldown.scope))),
					quarantineLegacyGlobal: (expected, revision) =>
						boundedSpotifyRpc(registry.quarantineSpotifyLegacy(expected, revision)),
					beginRecheck: async (scope) => {
						const token = await boundedSpotifyRpc(registry.beginSpotifyRecheck(scope));
						if (token) probeTokens.set(scope, token);
						return token !== null;
					},
					finishRecheck: async (success, scope) => {
						const token = probeTokens.get(scope);
						probeTokens.delete(scope);
						if (token)
							await boundedSpotifyRpc(registry.finishSpotifyRecheck(token, success, scope));
					},
				},
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
				if (err instanceof NativeError)
					return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
				if (err instanceof HubError)
					return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
				if (err instanceof SpotifyError)
					return {
						ok: false,
						error: { code: err.kind, message: err.message, status: err.status || 502 },
					};
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

	/** Like exclusive, for calls made on behalf of a signed-in session. */
	private session<T>(epoch: number, fn: () => Promise<T> | T): Promise<RpcResult<T>> {
		return this.exclusive(() => {
			this.hub().checkSession(epoch);
			return fn();
		});
	}

	logout(epoch: number) {
		return this.session(epoch, () => this.hub().endSessions());
	}

	attach(profile: { id: string; name: string; imageUrl: string | null }, tokens: SpotifyTokens) {
		return this.exclusive(() => this.hub().connect(profile, tokens));
	}
	isConnected() {
		return this.exclusive(() => this.hub().isConnected());
	}
	state(epoch: number, live: boolean, refresh = false) {
		return this.session(epoch, async () => {
			const state = await this.hub().state({ live, refresh });
			const transport = await this.ctx.storage.get<{
				stationId: number;
				deviceId: string;
				deviceName?: string;
				pending: NativeCommand | null;
			}>("native_transport");
			if (
				state.session &&
				transport?.stationId === state.session.stationId &&
				this.hub().savedSession()?.controller === "native"
			)
				state.session = {
					...state.session,
					controller: {
						kind: "home-assistant",
						deviceId: transport.deviceId,
						deviceName: transport.deviceName,
					},
					pending: state.session.pending || !!transport.pending,
				};
			return state;
		});
	}
	playlists(epoch: number) {
		return this.session(epoch, async () => {
			// Opening the station search is a good moment to look again.
			await this.hub().refreshPlaylistsSoon();
			return this.hub().listPlaylists();
		});
	}
	onboard(epoch: number, ids: string[]) {
		return this.session(epoch, () => this.hub().onboard(ids));
	}
	createStation(
		epoch: number,
		input: {
			name: string;
			sources: StationSource[];
			rules?: Partial<StationRules>;
			kind?: StationKind;
		},
	) {
		return this.session(epoch, async () => {
			const id = this.hub().createStation({
				...input,
				kind: input.kind === "all" ? "all" : "custom",
			});
			await this.hub().scheduleSoon(500);
			return id;
		});
	}
	updateStation(
		epoch: number,
		id: number,
		patch: { name?: string; rules?: Partial<StationRules>; sources?: StationSource[] },
	) {
		return this.session(epoch, async () => {
			this.hub().updateStation(id, patch);
			await this.hub().scheduleSoon(1000);
		});
	}
	deleteStation(epoch: number, id: number) {
		return this.session(epoch, () => this.hub().deleteStation(id));
	}
	stationDetail(epoch: number, id: number) {
		return this.session(epoch, () => this.hub().stationDetail(id));
	}
	play(
		epoch: number,
		stationId: number,
		deviceId: string | null,
		opts: { newQueue?: boolean; sessionId?: string } = {},
	) {
		return this.session(epoch, () => this.hub().play(stationId, deviceId, opts));
	}
	playerAction(
		epoch: number,
		action: "pause" | "resume" | "next",
		expected: { sessionId?: string; entryId?: string } = {},
	) {
		return this.session(epoch, () => this.hub().playerAction(action, expected));
	}

	private async nativeController(uid: string): Promise<NativeController | null> {
		const allowed = (this.env.ALLOWED_SPOTIFY_IDS ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean);
		if (allowed.length && !allowed.includes(uid))
			throw new NativeError("native_revoked", "Native Zugriff wurde widerrufen.", 403);
		const state = await this.hub().state({ live: false });
		if (state.profile.id !== uid || state.guest.active)
			throw new NativeError(
				"native_denied",
				"Native Wiedergabe ist nur für das eigene Konto verfügbar.",
				403,
			);
		const binding = nativeBinding(this.env.NATIVE_BRIDGES, uid);
		return binding ? new NativeController(binding) : null;
	}
	nativeDevices(epoch: number, uid: string) {
		return this.session(epoch, async () => {
			const controller = await this.nativeController(uid);
			return { configured: !!controller, devices: controller ? await controller.devices() : [] };
		});
	}
	nativePlay(
		epoch: number,
		uid: string,
		stationId: number,
		deviceId: string,
		action: "resume" | "pause" | "next" = "resume",
		expected: {
			sessionId?: string;
			entryId?: string;
			orderRevision?: number;
			newQueue?: boolean;
		} = {},
	) {
		return this.session(epoch, async () => {
			const current = this.hub().savedSession(stationId);
			if (
				expected.newQueue &&
				(action !== "resume" || (current && (!expected.sessionId || !expected.entryId)))
			)
				throw new NativeError(
					"native_stale",
					"Bitte die Warteschlange vor einem Neustart aktualisieren.",
					409,
				);
			if (action === "next" && (!expected.sessionId || !expected.entryId))
				throw new NativeError(
					"native_stale",
					"Bitte vor dem Überspringen die Warteschlange aktualisieren.",
					409,
				);
			if (
				(expected.sessionId && current?.sessionId !== expected.sessionId) ||
				(expected.entryId && current?.entryIds[current.currentIndex] !== expected.entryId) ||
				(expected.orderRevision !== undefined && current?.orderRevision !== expected.orderRevision)
			)
				throw new NativeError(
					"native_stale",
					"Die Warteschlangenansicht ist veraltet. Bitte aktualisieren.",
					409,
				);
			const controller = await this.nativeController(uid);
			if (!controller)
				throw new NativeError(
					"native_setup",
					"Für dieses Konto ist keine Native Bridge eingerichtet.",
					503,
				);
			const device = (await controller.devices()).find((d) => d.id === deviceId);
			if (!device || (action === "pause" && !device.pause))
				throw new NativeError(
					"native_capability",
					"Dieses Gerät unterstützt den Befehl nicht.",
					409,
				);
			const key = "native_transport";
			let previous = await this.ctx.storage.get<{
				stationId: number;
				deviceId: string;
				pending: NativeCommand | null;
				prepared?: NonNullable<ReturnType<HubCore["savedSession"]>>;
			}>(key);
			if (previous && !nativeIntentCurrent(this.hub().savedSession(), previous)) {
				await this.ctx.storage.delete(key);
				previous = undefined;
			}
			if (
				previous?.pending &&
				(previous.stationId !== stationId ||
					previous.deviceId !== deviceId ||
					previous.pending.action !== (action === "pause" ? "pause" : "play"))
			)
				throw new NativeError("native_pending", "Ein Native Befehl wartet auf Bestätigung.", 409);
			if (expected.newQueue && previous?.pending)
				throw new NativeError(
					"native_pending",
					"Bitte den offenen Native Auftrag zuerst abbrechen.",
					409,
				);
			let command = previous?.pending;
			const original = this.hub().savedSession(stationId);
			let prepared = original;
			if (!command) {
				const session =
					action === "pause"
						? this.hub().savedSession(stationId)
						: expected.newQueue
							? this.hub().newNativeQueue(stationId)
							: this.hub().nativeSession(stationId, action === "next");
				prepared = session;
				const view = this.hub().sessionView(stationId, 1000);
				if (!session || !view?.queue[0])
					throw new NativeError("native_empty", "Keine gespeicherte Warteschlange verfügbar.", 409);
				command = {
					operationId: crypto.randomUUID(),
					action: action === "pause" ? "pause" : "play",
					deviceId,
					sessionId: session.sessionId,
					entryId: session.entryIds[session.currentIndex]!,
					playbackEpoch: session.playbackEpoch,
					orderRevision: session.orderRevision,
					mediaId: view.queue[0].track.id,
					positionMs: device.seek ? (session.progressMs ?? 0) : 0,
					queue: device.queue
						? view.queue.map((entry) => ({ entryId: entry.entryId, mediaId: entry.track.id }))
						: undefined,
				};
				await this.ctx.storage.put(key, {
					uid,
					stationId,
					deviceId,
					deviceName: device.name,
					queue: device.queue,
					pending: command,
					original,
					prepared,
				});
			}
			try {
				await controller.command(command);
			} catch (error) {
				if (original && prepared && action === "next")
					this.hub().commitNativeSession(original, prepared.playbackEpoch);
				throw error;
			}
			if (previous?.pending && previous.prepared)
				this.hub().commitNativeSession(previous.prepared, previous.prepared.playbackEpoch);
			await this.ctx.storage.put(key, {
				uid,
				stationId,
				deviceId,
				deviceName: device.name,
				queue: device.queue,
				pending: null,
			});
			if (device.queue && command.action === "play" && command.queue?.length) {
				const acknowledged = this.hub().savedSession(stationId);
				if (
					acknowledged?.sessionId === command.sessionId &&
					acknowledged.playbackEpoch === command.playbackEpoch
				)
					this.hub().acknowledgeNativeTail(stationId, command.orderRevision);
			}
			await this.ctx.storage.setAlarm(Date.now() + 30000);
			await this.observeNative(uid);
			return { accepted: true, session: this.hub().sessionView(stationId) };
		});
	}
	private async observeNative(uid: string) {
		const transport = await this.ctx.storage.get<{
			stationId: number;
			deviceId: string;
			pending: NativeCommand | null;
			queue?: boolean;
			cancelled?: boolean;
			prepared?: NonNullable<ReturnType<HubCore["savedSession"]>>;
		}>("native_transport");
		if (!transport || transport.cancelled) return null;
		const active = this.hub().savedSession();
		if (!nativeIntentCurrent(active, transport)) {
			await this.ctx.storage.delete("native_transport");
			return null;
		}
		const controller = await this.nativeController(uid);
		if (!controller) return null;
		if (transport.pending) {
			if (transport.pending.action === "play")
				throw new NativeError(
					"native_pending",
					"Ein Native Start wartet auf Bestätigung. Bitte bewusst erneut fortsetzen oder den Auftrag abbrechen.",
					409,
				);
			await controller.command(transport.pending);
			if (transport.pending.action === "append")
				this.hub().acknowledgeNativeTail(transport.stationId, transport.pending.orderRevision);
			if (transport.prepared)
				this.hub().commitNativeSession(transport.prepared, transport.prepared.playbackEpoch);
			transport.pending = null;
			await this.ctx.storage.put("native_transport", { ...transport, uid });
		}
		const observation = await controller.observe(transport.deviceId);
		if (observation && (observation.state === "playing" || observation.state === "paused"))
			this.hub().acceptSessionObservation(transport.stationId, {
				...observation,
				progressMs: observation.progressMs,
			});
		if (
			observation &&
			(observation.state === "disconnected" ||
				observation.state === "external" ||
				observation.state === "ambiguous")
		)
			this.hub().nativeObservationStatus(
				transport.stationId,
				observation.sessionId,
				observation.playbackEpoch,
				observation.state,
				observation.sequence,
			);
		if (
			observation?.state === "playing" &&
			transport.queue &&
			this.hub().savedSession(transport.stationId)?.sequence === observation.sequence
		) {
			const tail = this.hub().prepareNativeTail(transport.stationId);
			const session = this.hub().savedSession(transport.stationId);
			if (tail && session) {
				const command: NativeCommand = {
					operationId: crypto.randomUUID(),
					action: "append",
					deviceId: transport.deviceId,
					sessionId: session.sessionId,
					entryId: session.entryIds[session.currentIndex]!,
					playbackEpoch: session.playbackEpoch,
					orderRevision: tail.orderRevision,
					queue: tail.entries,
				};
				await this.ctx.storage.put("native_transport", { ...transport, uid, pending: command });
				await controller.command(command);
				this.hub().acknowledgeNativeTail(transport.stationId, tail.orderRevision);
				await this.ctx.storage.put("native_transport", { ...transport, uid, pending: null });
			}
		}
		return { observation, session: this.hub().sessionView(transport.stationId) };
	}
	nativeCancel(epoch: number, expected: { sessionId?: string; entryId?: string } = {}) {
		return this.session(epoch, async () => {
			const current = this.hub().savedSession();
			if (
				(expected.sessionId && current?.sessionId !== expected.sessionId) ||
				(expected.entryId && current?.entryIds[current.currentIndex] !== expected.entryId)
			)
				throw new NativeError("native_stale", "Die Warteschlangenansicht ist veraltet.", 409);
			const transport = await this.ctx.storage.get<{
				pending: NativeCommand | null;
				original?: NonNullable<ReturnType<HubCore["savedSession"]>>;
				prepared?: NonNullable<ReturnType<HubCore["savedSession"]>>;
			}>("native_transport");
			if (transport?.pending && transport.original && transport.prepared)
				this.hub().commitNativeSession(transport.original, transport.prepared.playbackEpoch);
			if (transport)
				await this.ctx.storage.put("native_transport", {
					...transport,
					pending: null,
					cancelled: true,
				});
			return { cancelled: true };
		});
	}

	nativeState(epoch: number, uid: string) {
		return this.session(epoch, () => this.observeNative(uid));
	}
	testSpotifyAvailability(epoch: number) {
		return this.session(epoch, () => this.hub().testSpotifyAvailability());
	}
	retryQuota(epoch: number, scope?: Exclude<SpotifyCooldownScope, "legacy-catalog">) {
		return this.session(epoch, () => this.hub().retryQuota(scope));
	}
	spotifyUsage(epoch: number) {
		return this.session(epoch, () =>
			boundedSpotifyRpc(
				this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry")).spotifyUsage(),
			),
		);
	}
	spotifyDiagnostics(epoch: number) {
		return this.session(epoch, () => this.hub().spotifyDiagnostics());
	}

	devices(epoch: number) {
		return this.session(epoch, () => this.hub().devices());
	}
	thumb(epoch: number, trackId: string, value: -1 | 0 | 1) {
		return this.session(epoch, () => this.hub().thumb(trackId, value));
	}
	remoteKey(epoch: number) {
		return this.session(epoch, () => this.hub().remoteKey());
	}
	newRemoteKey(epoch: number) {
		return this.session(epoch, () => this.hub().newRemoteKey());
	}
	dropRemoteKey(epoch: number) {
		return this.session(epoch, () => this.hub().dropRemoteKey());
	}
	/** A command from a personal key: no session, the key's id is the proof. */
	remote(kid: string, action: RemoteAction) {
		return this.exclusive(() => this.hub().remote(kid, action));
	}
	setGuest(epoch: number, on: boolean, hours?: number) {
		return this.session(epoch, () => this.hub().setGuest(on, hours));
	}
	setGuestDevices(epoch: number, devices: { id: string; name: string }[]) {
		return this.session(epoch, async () => this.hub().setGuestDevices(devices));
	}
	importHistory(
		epoch: number,
		rows: [string, number, number, number][],
		part: number,
		parts: number,
	) {
		return this.session(epoch, () => this.hub().importHistory(rows, part, parts));
	}
	history(epoch: number, limit: number, before?: number) {
		return this.session(epoch, () => this.hub().history(limit, before));
	}
	setImportedProfile(epoch: number, profile: unknown) {
		return this.session(epoch, async () => this.hub().setImportedProfile(profile));
	}
	/** One genre estimate at a time; requests of the same session epoch while it runs share its answer. */
	private genreFlight: { epoch: number; answer: Promise<RpcResult<GenreAnswer>> } | null = null;
	async estimateGenres(epoch: number): Promise<RpcResult<GenreAnswer>> {
		// Every caller proves its own session before sharing a running estimate, and again
		// before it reads the answer: a revoked cookie neither joins nor learns the result.
		const before = await this.session(epoch, () => null);
		if (!before.ok) return before;
		let flight = this.genreFlight;
		if (flight?.epoch !== epoch) {
			const started: { epoch: number; answer: Promise<RpcResult<GenreAnswer>> } = {
				epoch,
				answer: requestGenres<{ code: string; message: string; status: number }>(
					(fn) => this.session(epoch, fn),
					() => this.hub().prepareGenres(),
					(artists) => this.hub().runGenreEstimate(artists),
					(attempt, est) => this.hub().storeGenres(attempt, est),
				).finally(() => {
					if (this.genreFlight === started) this.genreFlight = null;
				}),
			};
			this.genreFlight = flight = started;
		}
		const answer = await flight.answer;
		const after = await this.session(epoch, () => null);
		return after.ok ? answer : after;
	}
	importListens(
		epoch: number,
		input: { part: unknown; parts: unknown; tracks: unknown; kind: unknown; data: unknown },
	) {
		return this.session(epoch, () => this.hub().importListens(input));
	}
	listeningProfile(
		epoch: number,
		timeZone: string,
		period: { from: number | null; to: number | null } = { from: null, to: null },
	) {
		return this.session(epoch, () => this.hub().listeningProfile(timeZone, period));
	}
	syncNow(epoch: number) {
		return this.session(epoch, async () => {
			await this.hub().requestSync();
		});
	}
	ensureAlarm() {
		return this.exclusive(() => this.hub().ensureAlarm());
	}
	suspend() {
		return this.exclusive(async () => this.hub().suspend());
	}
	allow() {
		return this.exclusive(() => this.hub().allow());
	}
	deleteAccount(epoch: number) {
		return this.session(epoch, () => this.hub().deleteAccount());
	}

	override async alarm(): Promise<void> {
		await this.exclusive(async () => {
			await this.hub().alarm();
			const transport = await this.ctx.storage.get<{ uid: string; cancelled?: boolean }>(
				"native_transport",
			);
			if (
				transport &&
				!transport.cancelled &&
				nativeBinding(this.env.NATIVE_BRIDGES, transport.uid)
			) {
				try {
					await this.observeNative(transport.uid);
				} catch {
					/* Saved occurrence and pending intent survive disconnect. */
				}
				const next = await this.ctx.storage.getAlarm();
				if (next === null || next > Date.now() + 30000)
					await this.ctx.storage.setAlarm(Date.now() + 30000);
			}
		});
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
