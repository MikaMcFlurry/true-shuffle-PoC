/**
 * A local stand-in for Cloudflare's "rows read" meter on Durable Object SQLite.
 *
 * node:sqlite has no `cursor.rowsRead`, so every statement is costed from its
 * query plan, the way the meter counts: a SCAN reads every row of the table,
 * a json_each scan every element of its array, a SEARCH the rows it matched
 * (one lookup per outer row inside a join). Schema statements cost one row.
 * It is a model, not Cloudflare's number: good for before/after comparisons
 * of the same scenario, never for a claim about the account's daily limit.
 */

import type { SqlDb, SqlValue } from "../../src/worker/lib/sql";
import type { nodeSql } from "./harness";

type Inner = ReturnType<typeof nodeSql>;

export interface RowsMeter {
	total: number;
	byQuery: Map<string, { calls: number; rows: number }>;
	reset(): void;
	top(n?: number): { query: string; calls: number; rows: number }[];
}

export function countingSql(inner: Inner): SqlDb & { db: Inner["db"]; meter: RowsMeter } {
	const plans = new Map<string, string[]>();
	const meter: RowsMeter = {
		total: 0,
		byQuery: new Map(),
		reset() {
			this.total = 0;
			this.byQuery.clear();
		},
		top(n = 10) {
			return [...this.byQuery]
				.map(([query, v]) => ({ query, ...v }))
				.sort((a, b) => b.rows - a.rows)
				.slice(0, n);
		},
	};
	const norm = (p: SqlValue[]) =>
		p.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)) as never[];
	const tables = () =>
		new Set(
			(
				inner.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
					name: string;
				}[]
			).map((r) => r.name),
		);
	const plan = (q: string, p: SqlValue[]): string[] => {
		const cached = plans.get(q);
		if (cached) return cached;
		let lines: string[] = [];
		try {
			lines = (
				inner.db.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...norm(p)) as { detail: string }[]
			).map((r) => r.detail);
		} catch {
			lines = [];
		}
		plans.set(q, lines);
		return lines;
	};
	const resolve = (name: string, q: string, known: Set<string>): string | null => {
		if (known.has(name)) return name;
		const m = new RegExp(`(\\w+)\\s+(?:AS\\s+)?${name}\\b`, "i").exec(q);
		return m && known.has(m[1]!) ? m[1]! : null;
	};
	const jsonLength = (p: SqlValue[]): number => {
		for (const v of p)
			if (typeof v === "string" && v.startsWith("[")) {
				try {
					return (JSON.parse(v) as unknown[]).length;
				} catch {
					/* not an array */
				}
			}
		return 0;
	};
	const cost = (q: string, p: SqlValue[], resultRows: number, changes: number): number => {
		const head = q.trim().slice(0, 12).toUpperCase();
		if (head.startsWith("CREATE") || head.startsWith("ALTER") || head.startsWith("DROP")) return 1;
		if (head.startsWith("PRAGMA")) return Math.max(1, resultRows);
		const lines = plan(q, p);
		if (lines.length === 0) return 0;
		const known = tables();
		let rows = 0;
		let outer = 0;
		for (const line of lines) {
			const scan = /^SCAN (\w+)/.exec(line);
			const search = /^SEARCH (\w+)/.exec(line);
			if (scan) {
				if (/VIRTUAL TABLE/.test(line)) {
					outer = jsonLength(p);
					rows += outer;
					continue;
				}
				const t = resolve(scan[1]!, q, known);
				if (!t) continue;
				const n = (inner.db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
				rows += n;
				outer = n;
			} else if (search) {
				const matched = Math.max(1, resultRows, changes);
				rows += outer > 0 ? Math.max(outer, matched) : matched;
			}
		}
		return rows;
	};
	const note = (q: string, n: number) => {
		meter.total += n;
		const key = q.replace(/\s+/g, " ").trim().slice(0, 140);
		const e = meter.byQuery.get(key) ?? { calls: 0, rows: 0 };
		e.calls++;
		e.rows += n;
		meter.byQuery.set(key, e);
	};
	return {
		db: inner.db,
		meter,
		all<T>(q: string, ...p: SqlValue[]): T[] {
			const r = inner.all<T>(q, ...p);
			note(q, cost(q, p, r.length, 0));
			return r;
		},
		first<T>(q: string, ...p: SqlValue[]): T | null {
			const r = inner.first<T>(q, ...p);
			note(q, cost(q, p, r ? 1 : 0, 0));
			return r;
		},
		run(q: string, ...p: SqlValue[]): void {
			const before = inner.db.prepare("SELECT total_changes() AS n").get() as { n: number };
			inner.run(q, ...p);
			const after = inner.db.prepare("SELECT total_changes() AS n").get() as { n: number };
			note(q, cost(q, p, 0, after.n - before.n));
		},
		transaction<R>(fn: () => R): R {
			return inner.transaction(fn);
		},
	};
}
