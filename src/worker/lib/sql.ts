/**
 * The narrow SQL surface the hub needs, so the same hub code runs on a
 * Durable Object's SQLite (production) and on node:sqlite (tests).
 */

export type SqlValue = string | number | null | ArrayBuffer;

export interface SqlDb {
	/** Run one statement and return its rows (empty for writes). */
	all<T = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): T[];
	/** First row or null. */
	first<T = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): T | null;
	run(query: string, ...params: SqlValue[]): void;
	/** Run `fn` atomically. */
	transaction<R>(fn: () => R): R;
}
