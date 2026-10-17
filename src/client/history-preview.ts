/**
 * A short listening sample of one Verlauf row (see docs/HISTORY_PREVIEW.md):
 * Deezer's public sample of that recording, played here on the page — never
 * Spotify, which is neither asked nor told anything. Nothing happens without
 * a tap on that row's own key: no request, no audio, no autoplay.
 *
 * One player for the whole app. Another row, the same key again, leaving the
 * page, the tab going to the background, signing out or another account stop
 * it; every answer or play() that belongs to an earlier tap (`gen`) changes
 * nothing. Rows are told apart by song and time, so the same song twice in
 * the Verlauf are two rows.
 */

import { useEffect, useState } from "preact/hooks";
import type { PreviewResult } from "../shared/api";
import { api } from "./api";
import { store } from "./store";

export type PreviewPhase =
	/** Not asked yet ("ungeprüft"). */
	| "idle"
	| "loading"
	/** Found; the browser wants one more tap to start (or it was stopped before it began). */
	| "ready"
	| "playing"
	| "stopped"
	| "unavailable"
	| "error";

export type ReadyPreview = Extract<PreviewResult, { status: "ready" }>;

export interface PreviewView {
	phase: PreviewPhase;
	message: string | null;
	/** What plays, for the attribution: only once Deezer named a recording. */
	found: ReadyPreview | null;
}

/** The part of an HTMLAudioElement used here. */
export interface PreviewAudio {
	src: string;
	preload: string;
	currentTime: number;
	play(): Promise<void>;
	pause(): void;
	load(): void;
	removeAttribute(name: string): void;
	addEventListener(type: "ended" | "error" | "timeupdate", fn: () => void): void;
}

export interface PreviewDeps {
	resolve(trackId: string, playedAt: number): Promise<PreviewResult>;
	/** Made on the first tap only. */
	audio(): PreviewAudio;
	now(): number;
}

/** Provider samples run 30 seconds; never longer here, whatever arrives. */
export const PREVIEW_MAX_SECONDS = 30;
/** A signed address this close to running out is asked for again. */
const EXPIRY_MARGIN_MS = 30_000;

const IDLE: PreviewView = { phase: "idle", message: null, found: null };

export function rowKey(trackId: string, playedAt: number): string {
	return `${trackId}@${playedAt}`;
}

export class PreviewController {
	private key: string | null = null;
	private row: { trackId: string; playedAt: number } | null = null;
	private phase: PreviewPhase = "idle";
	private message: string | null = null;
	private found: ReadyPreview | null = null;
	/** Rows Deezer has no sample for, while this account is signed in. */
	private readonly none = new Map<string, string>();
	private gen = 0;
	/** The tap whose play() has not answered yet. */
	private starting: number | null = null;
	private player: PreviewAudio | null = null;
	private readonly listeners = new Set<() => void>();
	/** For the page's live region. */
	said = "";

	constructor(private readonly deps: PreviewDeps) {}

	subscribe(l: () => void): () => void {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}

	view(trackId: string, playedAt: number): PreviewView {
		const key = rowKey(trackId, playedAt);
		if (key === this.key) return { phase: this.phase, message: this.message, found: this.found };
		const none = this.none.get(key);
		return none ? { phase: "unavailable", message: none, found: null } : IDLE;
	}

	/** The row's key: start, stop, start again, or ask again after an error. */
	tap(trackId: string, playedAt: number): void {
		const key = rowKey(trackId, playedAt);
		if (key !== this.key) {
			if (this.none.has(key)) return; // said already: nothing to ask, nothing to stop
			this.reset(false);
			this.key = key;
			this.row = { trackId, playedAt };
			this.ask();
		} else if (this.phase === "loading") this.reset();
		else if (this.phase === "playing") this.halt("stopped", null);
		else if (this.phase === "ready" || this.phase === "stopped") this.start();
		else if (this.phase === "error") this.ask();
	}

	/** Paused from outside (the tab went to the background): it does not come back by itself. */
	pause(): void {
		if (this.phase === "playing") this.halt("stopped", null);
		else if (this.phase === "loading") this.reset();
	}

	/** Nothing plays, nothing is on its way; the row is "not asked" again. */
	reset(tell = true): void {
		this.gen++;
		this.silence();
		this.key = null;
		this.row = null;
		this.phase = "idle";
		this.message = null;
		this.found = null;
		if (tell) this.emit();
	}

	/** Signed out or another account: nothing of the one before is kept. */
	forget(): void {
		this.none.clear();
		this.reset();
	}

	private ask(): void {
		const row = this.row;
		if (!row) return;
		const gen = ++this.gen;
		this.silence();
		this.phase = "loading";
		this.message = null;
		this.found = null;
		this.say("Hörprobe wird gesucht.");
		this.deps.resolve(row.trackId, row.playedAt).then(
			(r) => {
				if (gen !== this.gen) return;
				if (r.status === "ready") {
					this.found = r;
					this.start();
				} else if (r.status === "unavailable") {
					this.none.set(rowKey(row.trackId, row.playedAt), r.message);
					this.set("unavailable", r.message);
				} else this.set("error", r.message);
			},
			(e: unknown) => {
				if (gen !== this.gen) return;
				this.set("error", reason(e));
			},
		);
	}

	private start(): void {
		const found = this.found;
		// None yet, or the signed address ran out: a new one, on this same tap.
		if (
			!found ||
			(found.expiresAt !== null && found.expiresAt - EXPIRY_MARGIN_MS <= this.deps.now())
		) {
			this.ask();
			return;
		}
		const gen = ++this.gen;
		const a = this.audio();
		a.src = found.url;
		a.currentTime = 0;
		this.phase = "ready";
		this.message = null;
		let p: Promise<void>;
		try {
			p = a.play();
		} catch (e) {
			p = Promise.reject(e);
		}
		this.emit();
		this.starting = gen;
		p.then(
			() => {
				if (gen !== this.gen) {
					// Started after it was stopped or replaced: it must not go on — unless
					// a newer tap is starting or playing it right now.
					if (this.starting === null && this.phase !== "playing") a.pause();
					return;
				}
				this.starting = null;
				this.set("playing", null);
				this.say(`Hörprobe läuft: ${found.title}.`);
			},
			(e: unknown) => {
				if (gen !== this.gen) return;
				this.starting = null;
				const name = (e as { name?: string } | null)?.name;
				if (name === "NotAllowedError")
					// The browser wants its own tap for sound: offered, not forced.
					this.set("ready", "Bereit — zum Abspielen nochmal tippen.");
				else if (name === "AbortError") return;
				else this.set("error", "Die Hörprobe ließ sich nicht abspielen.");
			},
		);
	}

	private audio(): PreviewAudio {
		if (this.player) return this.player;
		const a = this.deps.audio();
		a.preload = "none";
		a.addEventListener("ended", () => {
			if (this.phase === "playing") this.halt("stopped", null);
		});
		a.addEventListener("timeupdate", () => {
			if (this.phase === "playing" && a.currentTime >= PREVIEW_MAX_SECONDS)
				this.halt("stopped", null);
		});
		a.addEventListener("error", () => {
			// Only an error of the sample that is meant to play counts.
			if (
				(this.phase === "playing" || this.phase === "ready") &&
				this.found &&
				a.src === this.found.url
			)
				this.halt(
					"error",
					"Die Hörprobe ließ sich nicht laden. Nochmal tippen fragt neu nach.",
					true,
				);
		});
		this.player = a;
		return a;
	}

	private halt(phase: "stopped" | "error", message: string | null, drop = false): void {
		this.gen++;
		this.silence();
		if (drop) this.found = null;
		this.set(phase, message);
		if (phase === "stopped") this.say("Hörprobe gestoppt.");
	}

	private silence(): void {
		this.starting = null;
		const a = this.player;
		if (!a) return;
		a.pause();
		if (a.src) {
			a.removeAttribute("src");
			a.load();
		}
	}

	private set(phase: PreviewPhase, message: string | null): void {
		this.phase = phase;
		this.message = message;
		if (message) this.said = message;
		this.emit();
	}

	private say(text: string): void {
		this.said = text;
		this.emit();
	}

	private emit(): void {
		for (const l of this.listeners) l();
	}
}

function reason(e: unknown): string {
	const err = e as { code?: string; status?: number; message?: string } | null;
	if (err?.code === "offline") return "Keine Verbindung — Hörprobe nicht geladen.";
	if (err?.code === "timeout") return "Keine rechtzeitige Antwort — Hörprobe nicht geladen.";
	if (err?.status === 401) return "Bitte neu anmelden.";
	return err?.message || "Hörprobe nicht geladen.";
}

/** Re-renders the caller whenever the player's state changes. */
export function usePreview(c: PreviewController): void {
	const [, force] = useState(0);
	useEffect(() => c.subscribe(() => force((n) => n + 1)), [c]);
}

/** The app's one sample player. */
export const historyPreview = new PreviewController({
	resolve: (trackId, playedAt) => api.historyPreview(trackId, playedAt),
	audio: () => new Audio(),
	now: () => Date.now(),
});

let account: string | null | undefined;
/** Signing out or another account stops it, wherever the app is, and forgets every answer. */
store.subscribe(() => {
	const l = store.load;
	const id = l.kind === "ready" ? l.state.profile.id : l.kind === "signed-out" ? null : account;
	if (id === account) return;
	if (account !== undefined) historyPreview.forget();
	account = id;
});
if (typeof document !== "undefined") {
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") historyPreview.pause();
	});
	window.addEventListener("pagehide", () => historyPreview.reset());
}
