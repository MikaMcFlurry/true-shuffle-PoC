// Author-owned DO probe (evidence only, not application code): the unchanged UserHub of the
// checkout, its own hub(), durableObjectSql() and exclusive() catch over real local Durable
// Object SQLite / transactionSync. Synthetic data only. The only deviation: a one-shot throw
// in the raw SQL adapter at a chosen write, to test that a failed change leaves nothing behind.
import { UserHub } from "C:/Users/mikah/AppData/Local/Temp/claude/C--Users-mikah-Documents-Codex-2026-10-13-task-work-true-shuffle-PoC/b3717cfc-5a7e-4563-a95d-82405b75acd7/scratchpad/lf/src/worker/userhub";
export { Registry } from "C:/Users/mikah/AppData/Local/Temp/claude/C--Users-mikah-Documents-Codex-2026-10-13-task-work-true-shuffle-PoC/b3717cfc-5a7e-4563-a95d-82405b75acd7/scratchpad/lf/src/worker/registry";

const ids = ["T000000000000000000000", "T000000000000000000001"];
const at = Date.parse("2024-03-01T12:00:00Z");
const summary = {
	from: 0,
	to: 0,
	plays: 0,
	minutes: 0,
	songs: 0,
	artists: 0,
	earlySkips: 0,
	hourWeek: Array(168).fill(0),
	months: [],
	topArtists: [],
	topSongs: [],
};
const points: Record<string, (q: string, p: unknown[]) => boolean> = {
	counter: (_q, p) => p[0] === "history_commit",
	"after-profile": (_q, p) => p[0] === "genre_attempt",
	"mid-events": (q, p) => q.startsWith("DELETE FROM kv") && p[0] === "listens_upload",
	"after-events": (q) => q.startsWith("UPDATE stations SET deck_dirty"),
};

export class AtomicProbe extends UserHub {
	private dump(): string {
		const sql = this.ctx.storage.sql;
		const tables = sql
			.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf%' AND name NOT LIKE 'sqlite%' ORDER BY name`)
			.toArray()
			.map((r) => String(r.name));
		return JSON.stringify(
			tables.map((t) => [
				t,
				sql
					.exec(`SELECT * FROM ${t}`)
					.toArray()
					.map((r) => JSON.stringify(r))
					.sort(),
			]),
		);
	}

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const op = url.searchParams.get("op");
		const kind = url.pathname.includes("profile") ? "profile" : "events";
		// biome-ignore lint/suspicious/noExplicitAny: probe reaches the private parts on purpose
		const self = this as any;
		if (op === "restart") self.core = null;
		const h = self.hub();
		const sql = this.ctx.storage.sql;
		const kv = (k: string) => sql.exec(`SELECT v FROM kv WHERE k = ?`, k).toArray()[0]?.v as string | undefined;
		if (op === "init") {
			const upload = h.importHistory(
				ids.map((id) => [id, 2, 0, at, 0, 2]),
				0,
				1,
				undefined,
				h.startImport().start,
			).upload;
			sql.exec(`INSERT INTO kv (k, v) VALUES ('genre_attempt', ?)`, JSON.stringify({ at: 0, id: "probe-attempt" }));
			if (kind === "events") {
				const u = h.importListens({
					importId: upload,
					part: 0,
					parts: 2,
					tracks: 2,
					kind: "tracks",
					data: ids.map((id, i) => [id, i ? "Beta" : "Alpha", "Synthetic", "Synthetic"]),
				}).upload;
				sql.exec(`INSERT INTO kv (k, v) VALUES ('probe_events', ?)`, JSON.stringify(u));
			}
		}
		const change = () => {
			if (kind === "profile") return h.setImportedProfile(summary);
			const u = JSON.parse(kv("probe_events") ?? "null");
			return h.importListens({
				upload: u,
				part: 1,
				parts: 2,
				tracks: 2,
				kind: "rows",
				data: [at / 1000, at / 1000 + 1].flatMap((t) => [
					[t, 0, 200000, 132, 0],
					[t, 1, 200000, 132, 0],
				]),
			});
		};
		const before = { view: h.selectionView(), stored: this.dump() };
		let result = null;
		let hit = false;
		if (op === "fault" || op === "send") {
			const raw = h.d.sql;
			const run = raw.run;
			const when = op === "fault" ? points[url.searchParams.get("at") ?? ""] : null;
			if (op === "fault" && !when) return new Response("unknown fault point", { status: 400 });
			raw.run = (q: string, ...p: unknown[]) => {
				if (when && !hit && when(q, p)) {
					hit = true;
					throw new Error("Synthetic storage failure");
				}
				return run(q, ...p);
			};
			try {
				result = await self.exclusive(change);
			} finally {
				raw.run = run;
			}
		}
		const after = { view: h.selectionView(), stored: this.dump() };
		return Response.json(
			{ before, after, result, hit },
			{ status: result && result.ok === false ? result.error.status : 200 },
		);
	}
}

export default {
	fetch(req: Request, env: { PROBE: DurableObjectNamespace }) {
		const u = new URL(req.url);
		return env.PROBE.get(env.PROBE.idFromName(u.pathname)).fetch(req);
	},
};
