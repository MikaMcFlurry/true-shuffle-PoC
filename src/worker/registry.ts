/**
 * Registry — one instance that knows which listeners exist, so the cron
 * safety net can re-arm every UserHub's sync alarm. Holds ids only.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { SpotifyCooldown } from "./spotify/client";
import { SpotifyGate, type SpotifyGateState } from "./spotify/gate";

export class Registry extends DurableObject<Env> {
	private ready = false;

	private init(): void {
		if (this.ready) return;
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, created_at INTEGER NOT NULL) WITHOUT ROWID`,
		);
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS spotify_gate (id INTEGER PRIMARY KEY CHECK(id = 1), state TEXT NOT NULL)`,
		);
		this.ready = true;
	}

	private gate(): SpotifyGate {
		this.init();
		return new SpotifyGate(
			{
				get: () => {
					const row = this.ctx.storage.sql
						.exec<{ state: string }>(`SELECT state FROM spotify_gate WHERE id = 1`)
						.toArray()[0];
					return row ? (JSON.parse(row.state) as SpotifyGateState) : null;
				},
				set: (state) => {
					this.ctx.storage.sql.exec(
						`INSERT INTO spotify_gate (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state`,
						JSON.stringify(state),
					);
				},
			},
			() => Date.now(),
		);
	}

	spotifyCooldown(probeToken?: string | null): SpotifyCooldown | null {
		return this.gate().get(probeToken);
	}
	spotifyGateSnapshot(probeToken?: string | null): {
		revision: number;
		cooldown: SpotifyCooldown | null;
	} {
		return this.gate().snapshot(probeToken);
	}
	spotifyBlocked(cooldown: SpotifyCooldown, probeToken?: string | null): number {
		return this.gate().block(cooldown, probeToken);
	}
	beginSpotifyRecheck(): string | null {
		return this.gate().begin(crypto.randomUUID());
	}
	finishSpotifyRecheck(token: string, success: boolean): void {
		this.gate().finish(token, success);
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
