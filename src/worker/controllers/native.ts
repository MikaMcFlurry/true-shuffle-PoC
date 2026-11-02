/** Explicit per-account HTTPS bridge; never derive a LAN destination from user input. */
export interface NativeBinding {
	url: string;
	token: string;
}
export interface NativeDevice {
	id: string;
	name: string;
	provider: "home-assistant";
	seek: boolean;
	resume: boolean;
	pause: boolean;
	queue: boolean;
}
export interface NativeContext {
	sessionId: string;
	entryId: string;
	playbackEpoch: number;
	orderRevision: number;
}
export interface NativeObservation extends NativeContext {
	sequence: number;
	progressMs: number | null;
	isPlaying: boolean;
	state: "playing" | "paused" | "disconnected" | "external" | "ambiguous";
	deviceId: string;
}
export interface NativeCommand extends NativeContext {
	operationId: string;
	action: "play" | "pause" | "append";
	deviceId: string;
	mediaId?: string;
	positionMs?: number;
	queue?: { entryId: string; mediaId: string }[];
}
export class NativeError extends Error {
	constructor(
		public code: string,
		message: string,
		public status = 502,
	) {
		super(message);
	}
}
export function nativeBinding(raw: string | undefined, accountId: string): NativeBinding | null {
	if (!raw) return null;
	let bindings: Record<string, NativeBinding>;
	try {
		bindings = JSON.parse(raw);
	} catch {
		throw new NativeError("native_setup", "Native Bridge ist falsch eingerichtet.", 503);
	}
	const b = Object.hasOwn(bindings, accountId) ? bindings[accountId] : null;
	if (!b) return null;
	let u: URL;
	try {
		u = new URL(b.url);
	} catch {
		throw new NativeError("native_setup", "Native Bridge URL ist ungültig.", 503);
	}
	if (
		u.protocol !== "https:" ||
		u.username ||
		u.password ||
		u.search ||
		u.hash ||
		!b.token ||
		b.token.length < 32
	)
		throw new NativeError(
			"native_setup",
			"Native Bridge benötigt HTTPS und einen sicheren Schlüssel.",
			503,
		);
	return { url: u.href.replace(/\/$/, ""), token: b.token };
}
export class NativeController {
	constructor(
		private binding: NativeBinding,
		private send: (request: Request) => Promise<Response> = fetch,
	) {}
	private async request<T>(path: string, body?: unknown): Promise<T> {
		let response: Response;
		try {
			response = await this.send(
				new Request(`${this.binding.url}${path}`, {
					method: body ? "POST" : "GET",
					headers: {
						authorization: `Bearer ${this.binding.token}`,
						"content-type": "application/json",
					},
					body: body ? JSON.stringify(body) : undefined,
					redirect: "error",
					signal: AbortSignal.timeout(15000),
				}),
			);
		} catch {
			throw new NativeError(
				"native_disconnected",
				"Native Bridge ist nicht erreichbar. Warteschlange bleibt gespeichert.",
			);
		}
		if (!response.ok)
			throw new NativeError(
				response.status === 401 || response.status === 403 ? "native_revoked" : "native_failed",
				"Native Bridge hat den Befehl abgelehnt. Warteschlange bleibt gespeichert.",
				response.status,
			);
		try {
			return (await response.json()) as T;
		} catch {
			throw new NativeError("native_protocol", "Ungültige Antwort der Native Bridge.");
		}
	}
	async devices(): Promise<NativeDevice[]> {
		const value = await this.request<unknown>("/v1/devices");
		if (!Array.isArray(value)) throw new NativeError("native_protocol", "Ungültige Geräteantwort.");
		return value.filter(
			(d): d is NativeDevice =>
				!!d &&
				typeof d.id === "string" &&
				/^media_player\.[a-z0-9_]+$/.test(d.id) &&
				typeof d.name === "string" &&
				d.provider === "home-assistant" &&
				typeof d.seek === "boolean" &&
				typeof d.resume === "boolean" &&
				typeof d.pause === "boolean" &&
				typeof d.queue === "boolean",
		);
	}
	async command(command: NativeCommand) {
		const result = await this.request<{ accepted: boolean }>("/v1/command", command);
		if (result.accepted !== true)
			throw new NativeError("native_rejected", "Native Befehl wurde nicht bestätigt.");
		return result;
	}
	async observe(deviceId: string): Promise<NativeObservation | null> {
		const v = await this.request<NativeObservation | null>(
			`/v1/state?deviceId=${encodeURIComponent(deviceId)}`,
		);
		if (v === null) return null;
		if (
			!v ||
			v.deviceId !== deviceId ||
			!["playing", "paused", "disconnected", "external", "ambiguous"].includes(v.state) ||
			typeof v.sessionId !== "string" ||
			typeof v.entryId !== "string" ||
			!Number.isSafeInteger(v.sequence) ||
			v.sequence < 0 ||
			!Number.isSafeInteger(v.playbackEpoch) ||
			v.playbackEpoch < 0 ||
			typeof v.isPlaying !== "boolean" ||
			!Number.isSafeInteger(v.orderRevision) ||
			v.orderRevision < 0 ||
			(v.progressMs !== null && (!Number.isFinite(v.progressMs) || v.progressMs < 0))
		)
			throw new NativeError("native_protocol", "Ungültige Wiedergabebeobachtung.");
		return v;
	}
}

/** A pending command may execute only while its account-owned native epoch is still current. */
export function nativeIntentCurrent(
	session: {
		stationId: number;
		controller?: string;
		sessionId: string;
		playbackEpoch: number;
		sequence?: number;
	} | null,
	transport: {
		stationId: number;
		pending: NativeCommand | null;
		prepared?: { sessionId: string; playbackEpoch: number; sequence?: number };
	},
): boolean {
	if (!session || session.stationId !== transport.stationId || session.controller !== "native")
		return false;
	const intended = transport.pending || transport.prepared;
	if (!intended) return true;
	return (
		session.sessionId === intended.sessionId &&
		session.playbackEpoch === intended.playbackEpoch &&
		(!transport.pending ||
			transport.pending.action === "append" ||
			(session.sequence ?? -1) <= (transport.prepared?.sequence ?? -1))
	);
}
