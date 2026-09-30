import type { SqlDb } from "../lib/sql";
import type { SpotifyCooldown } from "./client";

const methods = new Set(["GET", "POST", "PUT", "DELETE"]);
const segments = new Set([
	"api",
	"token",
	"me",
	"player",
	"devices",
	"recently-played",
	"play",
	"pause",
	"next",
	"shuffle",
	"repeat",
	"seek",
	"playlists",
	"items",
	"tracks",
	"top",
	"artists",
	"albums",
	"search",
	"library",
	":id",
]);
export function safeOperation(method: string, endpoint: string): string {
	const normalized = endpoint
		.split("/")
		.map((part) => (!part || segments.has(part) ? part : ":id"))
		.join("/")
		.slice(0, 120);
	return `${methods.has(method.toUpperCase()) ? method.toUpperCase() : "OTHER"} ${normalized.startsWith("/") ? normalized : "/other"}`;
}
export class SpotifyOperationGates {
	constructor(private readonly sql: SqlDb) {}
	init() {
		this.sql.run(
			"CREATE TABLE IF NOT EXISTS spotify_operation_gates (listener TEXT NOT NULL, operation TEXT NOT NULL, revision INTEGER NOT NULL, cooldown TEXT, PRIMARY KEY(listener,operation)) WITHOUT ROWID",
		);
	}
	snapshot(
		listener: string,
		operation: string,
	): { revision: number; cooldown: SpotifyCooldown | null } {
		this.init();
		const row = this.sql.first<{ revision: number; cooldown: string | null }>(
			"SELECT revision,cooldown FROM spotify_operation_gates WHERE listener=? AND operation=?",
			listener,
			operation,
		);
		return row
			? { revision: row.revision, cooldown: row.cooldown ? JSON.parse(row.cooldown) : null }
			: { revision: 0, cooldown: null };
	}
	block(listener: string, cooldown: SpotifyCooldown): number {
		const operation = cooldown.operation;
		if (
			!operation ||
			operation !== safeOperation(operation.split(" ")[0] ?? "", operation.split(" ")[1] ?? "") ||
			!["rate", "quota"].includes(cooldown.kind) ||
			!Number.isFinite(cooldown.observedAt) ||
			(cooldown.until !== null && !Number.isFinite(cooldown.until))
		)
			throw new Error("Invalid confirmed Spotify operation");
		this.init();
		return this.sql.transaction(() => {
			const current = this.snapshot(listener, operation);
			const previous = current.cooldown;
			// Unknown does not poison a later known deadline. Retain only stronger actual known deadlines.
			const source =
				previous?.until != null && (cooldown.until === null || previous.until > cooldown.until)
					? previous
					: cooldown;
			const safe: SpotifyCooldown = {
				operation,
				endpoint: source.endpoint,
				until: source.until,
				kind: source.kind,
				reason: source.reason,
				retryAfter: source.retryAfter,
				observedAt: source.observedAt,
			};
			const revision = current.revision + 1;
			this.sql.run(
				"INSERT INTO spotify_operation_gates(listener,operation,revision,cooldown) VALUES(?,?,?,?) ON CONFLICT(listener,operation) DO UPDATE SET revision=excluded.revision,cooldown=excluded.cooldown",
				listener,
				operation,
				revision,
				JSON.stringify(safe),
			);
			return revision;
		});
	}
	finish(listener: string, operation: string, revision: number): void {
		this.init();
		this.sql.run(
			"UPDATE spotify_operation_gates SET revision=revision+1,cooldown=NULL WHERE listener=? AND operation=? AND revision=?",
			listener,
			operation,
			revision,
		);
	}
}
