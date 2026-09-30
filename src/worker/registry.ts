/**
 * Registry — one instance that knows which listeners exist, so the cron
 * safety net can re-arm every UserHub's sync alarm. Holds ids only.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import {
	SPOTIFY_COOLDOWN_SCOPES,
	type SpotifyCooldown,
	type SpotifyCooldownScope,
} from "./spotify/client";
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
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS spotify_artist_albums_gate (id INTEGER PRIMARY KEY CHECK(id = 1), state TEXT NOT NULL)`,
		);
		for (const scope of SPOTIFY_COOLDOWN_SCOPES)
			this.ctx.storage.sql.exec(
				`CREATE TABLE IF NOT EXISTS spotify_${scope.replaceAll("-", "_")}_gate (id INTEGER PRIMARY KEY CHECK(id = 1), state TEXT NOT NULL)`,
			);
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS spotify_quarantine_backup (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)`,
		);
		this.ready = true;
	}

	private gate(scope?: SpotifyCooldownScope): SpotifyGate {
		this.init();
		if (scope && !SPOTIFY_COOLDOWN_SCOPES.includes(scope))
			throw new Error("Invalid Spotify gate scope");
		const table = scope ? `spotify_${scope.replaceAll("-", "_")}_gate` : "spotify_gate";
		return new SpotifyGate(
			{
				get: () => {
					const row = this.ctx.storage.sql
						.exec<{ state: string }>(`SELECT state FROM ${table} WHERE id = 1`)
						.toArray()[0];
					return row ? (JSON.parse(row.state) as SpotifyGateState) : null;
				},
				set: (state) => {
					this.ctx.storage.sql.exec(
						`INSERT INTO ${table} (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state`,
						JSON.stringify(state),
					);
				},
			},
			() => Date.now(),
		);
	}

	spotifyCooldown(
		probeToken?: string | null,
		scope?: SpotifyCooldownScope,
	): SpotifyCooldown | null {
		return this.gate(scope).get(probeToken);
	}
	spotifyGateSnapshot(
		probeToken?: string | null,
		scope?: SpotifyCooldownScope,
	): {
		revision: number;
		cooldown: SpotifyCooldown | null;
	} {
		return this.gate(scope).snapshot(probeToken);
	}
	spotifyBlocked(cooldown: SpotifyCooldown, probeToken?: string | null): number {
		return this.gate(cooldown.scope).block(cooldown, probeToken);
	}
	beginSpotifyRecheck(scope?: SpotifyCooldownScope): string | null {
		return this.gate(scope).begin(crypto.randomUUID());
	}
	finishSpotifyRecheck(token: string, success: boolean, scope?: SpotifyCooldownScope): void {
		this.gate(scope).finish(token, success);
	}

	quarantineSpotifyLegacy(expected: SpotifyCooldown, revision: number) {
		this.init();
		return this.ctx.storage.transactionSync(() => {
			const quarantined = this.gate().quarantine(expected, revision, this.gate("legacy-catalog"));
			if (quarantined)
				this.ctx.storage.sql.exec(
					`INSERT INTO spotify_quarantine_backup(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
					JSON.stringify({ at: Date.now(), cooldown: expected }),
				);
			return {
				quarantined,
				globalRevision: this.gate().snapshot().revision,
				catalogRevision: this.gate("legacy-catalog").snapshot().revision,
			};
		});
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
