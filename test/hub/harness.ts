/**
 * Runs the real HubCore on node:sqlite against the Spotify fake, with one
 * shared simulated clock. `listen()` lets hours of playback happen and fires
 * the hub's alarms exactly when they are due — the same loop the Durable
 * Object runtime drives in production.
 */

import { DatabaseSync } from "node:sqlite";
import { seededRng } from "../../src/core/random";
import { HubCore, type HubDeps, type HubEnv } from "../../src/worker/hub/hub";
import { Keys } from "../../src/worker/lib/crypto";
import type { SqlDb, SqlValue } from "../../src/worker/lib/sql";
import { FakeSpotify } from "../fakes/fake-spotify";

export const T0 = Date.UTC(2026, 8, 25, 6, 0, 0);

export function nodeSql(db = new DatabaseSync(":memory:")): SqlDb & { db: DatabaseSync } {
	let depth = 0;
	const norm = (p: SqlValue[]) =>
		p.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)) as never[];
	return {
		db,
		all<T>(q: string, ...p: SqlValue[]): T[] {
			return db.prepare(q).all(...norm(p)) as T[];
		},
		first<T>(q: string, ...p: SqlValue[]): T | null {
			return (db.prepare(q).get(...norm(p)) as T | undefined) ?? null;
		},
		run(q: string, ...p: SqlValue[]): void {
			db.prepare(q).run(...norm(p));
		},
		transaction<R>(fn: () => R): R {
			if (depth > 0) return fn();
			depth++;
			db.exec("BEGIN");
			try {
				const r = fn();
				db.exec("COMMIT");
				return r;
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			} finally {
				depth--;
			}
		},
	};
}

export interface Harness {
	hub: HubCore;
	fake: FakeSpotify;
	clock: { t: number };
	sql: ReturnType<typeof nodeSql>;
	alarmAt: () => number | null;
	/** Let `ms` of real time pass: playback advances, due alarms fire. */
	listen(ms: number): Promise<void>;
	/** Fire alarms until no job is due right now. */
	settle(): Promise<void>;
	restart(): void;
	env: HubEnv;
}

export async function makeHarness(
	opts: { fake?: FakeSpotify; env?: Partial<HubEnv>; seed?: number } = {},
): Promise<Harness> {
	const clock = { t: T0 };
	const now = () => clock.t;
	const fake = opts.fake ?? new FakeSpotify({ now });
	fake.now = now;
	const sql = nodeSql();
	let alarm: number | null = null;
	const env: HubEnv = {
		endpoints: {
			accountsBase: "https://fake/accounts",
			apiBase: "https://fake/v1",
			clientId: "cid",
		},
		lastfmBase: "https://fake/lastfm",
		lastfmKey: null,
		deezerBase: "https://fake/deezer",
		anthropicKey: null,
		anthropicModel: "claude-sonnet-5",
		...(opts.env ?? {}),
	};
	const deps = (): HubDeps => ({
		sql,
		fetch: (req) => fake.handle(req),
		now,
		rng: seededRng(opts.seed ?? 7),
		keys: new Keys("test-secret-test-secret-test-secret-42"),
		env,
		alarms: { set: async (at) => void (alarm = at), get: async () => alarm },
		ai: null,
	});
	const h: Harness = {
		hub: new HubCore(deps()),
		fake,
		clock,
		sql,
		env,
		alarmAt: () => alarm,
		async listen(ms: number) {
			const end = clock.t + ms;
			for (let guard = 0; guard < 100_000 && clock.t < end; guard++) {
				const next = alarm !== null && alarm <= end ? Math.max(alarm, clock.t) : end;
				const step = next - clock.t;
				// Advance in small slices so the simulated player moves smoothly.
				let left = step;
				while (left > 0) {
					const slice = Math.min(left, 5_000);
					clock.t += slice;
					for (const u of fake.users.values()) fake.advance(slice, u.id);
					left -= slice;
				}
				if (alarm !== null && alarm <= clock.t) {
					alarm = null;
					await h.hub.alarm();
				}
			}
		},
		async settle() {
			for (let i = 0; i < 200; i++) {
				if (alarm === null || alarm > clock.t + 5_000) return;
				clock.t = Math.max(clock.t, alarm);
				alarm = null;
				await h.hub.alarm();
			}
		},
		restart() {
			h.hub = new HubCore(deps());
		},
	};
	return h;
}

/** A listener with playlists, signed in and onboarded, decks written. */
export async function onboarded(
	opts: {
		tracks?: number;
		playlists?: number[];
		liked?: number;
		premium?: boolean;
		env?: Partial<HubEnv>;
		durationMs?: number;
		fake?: FakeSpotify;
	} = {},
): Promise<Harness & { stationIds: number[]; allId: number }> {
	const fake = opts.fake ?? new FakeSpotify();
	const total = opts.tracks ?? 600;
	const tracks = fake.addTracks(total, { durationMs: opts.durationMs });
	fake.addUser("mika", { premium: opts.premium ?? true });
	const sizes = opts.playlists ?? [total];
	let offset = 0;
	const pls = sizes.map((n, i) => {
		const p = fake.addPlaylist(
			"mika",
			`Playlist ${i + 1}`,
			tracks.slice(offset, offset + n).map((t) => t.id),
		);
		offset = (offset + n) % total;
		return p;
	});
	fake.user("mika").liked = tracks.slice(0, opts.liked ?? 0).map((t) => t.id);
	const h = await makeHarness({ fake, env: opts.env });
	const refresh = "rt-seed";
	fake.refreshTokens.set(refresh, "mika");
	await h.hub.connect(
		{ id: "mika", name: "Mika", imageUrl: null },
		{
			accessToken: fake.issueToken("mika"),
			refreshToken: refresh,
			expiresAt: h.clock.t + 3_600_000,
			scope: "all",
		},
	);
	await h.settle();
	await h.hub.onboard(pls.map((p) => p.id));
	await h.settle();
	await h.listen(60_000);
	await h.settle();
	const st = await h.hub.state();
	const allId = st.stations.find((s) => s.kind === "all")!.id;
	return Object.assign(h, {
		stationIds: st.stations.filter((s) => s.kind === "playlist").map((s) => s.id),
		allId,
	});
}
