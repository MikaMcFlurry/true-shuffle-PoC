/**
 * Registry — one instance that knows which listeners exist, so the cron
 * safety net can re-arm every UserHub's sync alarm. Holds ids only.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export class Registry extends DurableObject<Env> {
	private ready = false;

	private init(): void {
		if (this.ready) return;
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, created_at INTEGER NOT NULL) WITHOUT ROWID`,
		);
		this.ready = true;
	}

	register(uid: string): void {
		this.init();
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO users (uid, created_at) VALUES (?, ?)`,
			uid,
			Date.now(),
		);
	}

	remove(uid: string): void {
		this.init();
		this.ctx.storage.sql.exec(`DELETE FROM users WHERE uid = ?`, uid);
	}

	list(): string[] {
		this.init();
		return this.ctx.storage.sql
			.exec(`SELECT uid FROM users ORDER BY created_at`)
			.toArray()
			.map((r) => String(r.uid));
	}
}
