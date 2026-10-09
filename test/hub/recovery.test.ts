import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { seededRng } from "../../src/core/random";
import { HubCore } from "../../src/worker/hub/hub";
import { migrate } from "../../src/worker/hub/schema";
import { Keys } from "../../src/worker/lib/crypto";
import { RequestBudget } from "../../src/worker/spotify/client";
import { nodeSql, onboarded } from "./harness";

describe("SQLite recovery NN-02–04", () => {
	it("reopens a disk snapshot with the exact unfinished occurrence and progress", async () => {
		const h = await onboarded({ tracks: 60 });
		const id = h.stationIds[0]!;
		await h.hub.play(id);
		h.fake.user().player.progressMs = 97_000;
		h.fake.pause();
		await h.hub.sync(new RequestBudget(25), { force: true });
		const expected = h.hub.savedSession(id)!;
		const directory = mkdtempSync(join(tmpdir(), "true-shuffle-recovery-"));
		const path = join(directory, "backup.sqlite");
		try {
			h.sql.db.exec(`VACUUM INTO '${path}'`);
			const snapshot = new DatabaseSync(path);
			const sql = nodeSql(snapshot);
			const count = sql.first<{ n: number }>("SELECT COUNT(*) AS n FROM memory")!.n;
			snapshot.close();
			const recovered = new DatabaseSync(path);
			const hub = new HubCore({
				sql: nodeSql(recovered),
				fetch: (request) => h.fake.handle(request),
				now: () => h.clock.t,
				rng: seededRng(7),
				keys: new Keys("test-secret-test-secret-test-secret-42"),
				env: h.env,
				ai: null,
				alarms: { set: async () => {}, get: async () => null },
			});
			expect(hub.savedSession(id)).toEqual(expected);
			expect(await hub.play(id)).toMatchObject({ ok: true });
			expect(h.fake.user().player.progressMs).toBe(97_000);
			expect(hub.savedSession(id)!.entryIds).toEqual(expected.entryIds);
			expect(nodeSql(recovered).first<{ n: number }>("SELECT COUNT(*) AS n FROM memory")!.n).toBe(
				count,
			);
			recovered.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rolls back a failed additive migration before advancing its version", async () => {
		const h = await onboarded({ tracks: 40 });
		h.sql.run("DROP TABLE playback_sessions");
		// A store at version 3 has none of the later columns either.
		h.sql.run("ALTER TABLE plays DROP COLUMN lane");
		h.sql.run("UPDATE kv SET v = '3' WHERE k = 'schema_version'");
		const before = h.sql.all("SELECT * FROM stations");
		expect(() =>
			migrate({
				...h.sql,
				run: (query, ...parameters) => {
					h.sql.run(query, ...parameters);
					if (query.includes("CREATE TABLE IF NOT EXISTS playback_sessions"))
						throw new Error("fixture crash before schema-version commit");
				},
			}),
		).toThrow("fixture crash");
		expect(h.sql.first<{ v: string }>("SELECT v FROM kv WHERE k = 'schema_version'")!.v).toBe("3");
		expect(h.sql.all("SELECT * FROM stations")).toEqual(before);
		expect(
			h.sql.first("SELECT name FROM sqlite_master WHERE name = 'playback_sessions'"),
		).toBeNull();
		migrate(h.sql);
		expect(
			h.sql.first("SELECT name FROM sqlite_master WHERE name = 'playback_sessions'"),
		).not.toBeNull();
	});
});
