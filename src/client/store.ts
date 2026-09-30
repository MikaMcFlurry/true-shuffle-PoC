/**
 * App state: the hub's snapshot, polled while the page is visible, plus the
 * few things the display shows transiently (a tuning station, a message).
 */

import { useEffect, useState } from "preact/hooks";
import type { AppState, TrackView } from "../shared/api";
import { ApiError, api } from "./api";

export type Load =
	| { kind: "loading" }
	| { kind: "signed-out" }
	| { kind: "error"; message: string }
	| { kind: "ready"; state: AppState };

export interface Flash {
	text: string;
	tone: "info" | "warn" | "error";
	until: number;
}

type Listener = () => void;

class Store {
	load: Load = { kind: "loading" };
	flash: Flash | null = null;
	stale = false;
	private tick: (() => void) | null = null;
	private offline = () => {
		this.stale = true;
		this.emit();
	};
	tuning: { stationId: number; since: number } | null = null;
	/**
	 * The station the tuning knob has turned the pointer to. Turning only
	 * selects; playing it takes a separate, deliberate press.
	 */
	selected: number | null = null;
	private selectTimer: number | null = null;
	/** The song whose rating sheet is open. */
	rating: TrackView | null = null;
	/** Thumbs given here, shown at once in every list until a later load has them. */
	private thumbs = new Map<string, { v: -1 | 0 | 1; at: number }>();
	/** When the last snapshot arrived (for counting song progress locally). */
	receivedAt = Date.now();
	private listeners = new Set<Listener>();
	private timer: number | null = null;
	private inflight: Promise<void> | null = null;

	subscribe(l: Listener): () => void {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}

	emit(): void {
		for (const l of this.listeners) l();
	}

	/** Point the dial at a station without playing it; it falls back after a while untouched. */
	select(stationId: number | null): void {
		this.selected = stationId;
		this.armSelection();
		this.emit();
	}

	/**
	 * While the Klang knob is in hand, the selection it turns stays put;
	 * let go, and the usual while untouched starts again.
	 */
	holdSelection(on: boolean): void {
		if (this.selectionHeld === on) return;
		this.selectionHeld = on;
		this.armSelection();
	}

	private selectionHeld = false;

	private armSelection(): void {
		if (this.selectTimer !== null) window.clearTimeout(this.selectTimer);
		this.selectTimer =
			this.selected === null || this.selectionHeld
				? null
				: window.setTimeout(() => {
						this.selected = null;
						this.selectTimer = null;
						this.emit();
					}, 20_000);
	}

	rate(t: TrackView | null): void {
		this.rating = t;
		this.emit();
	}

	thumbOf(t: { id: string; thumb: -1 | 0 | 1 }): -1 | 0 | 1 {
		return this.thumbs.get(t.id)?.v ?? t.thumb;
	}

	setThumb(id: string, v: -1 | 0 | 1): void {
		this.thumbs.set(id, { v, at: Date.now() });
		this.emit();
	}

	/**
	 * A list loaded after a thumb was given here knows it, and knows any change
	 * made elsewhere since (Siri, the display's key): its word wins again.
	 */
	settleThumbs(songs: { id: string }[], loadStartedAt: number): void {
		for (const s of songs) {
			const own = this.thumbs.get(s.id);
			if (own && own.at < loadStartedAt) this.thumbs.delete(s.id);
		}
	}

	refresh(live = true): Promise<void> {
		if (this.inflight) return this.inflight;
		const started = Date.now();
		this.inflight = api
			.state(live)
			.then((state) => {
				this.stale = false;
				const previousIdentity = this.load.kind === "ready" ? this.load.state.profile.id : null;
				if (previousIdentity !== state.profile.id) {
					this.thumbs.clear();
					this.rating = null;
					this.selected = null;
				}
				this.load = { kind: "ready", state };
				this.receivedAt = Date.now();
				if (state.nowPlaying) this.settleThumbs([state.nowPlaying], started);
				if (state.session)
					this.settleThumbs(
						state.session.queue.map((entry) => entry.track),
						started,
					);
			})
			.catch((err: unknown) => {
				this.stale = true;
				if (err instanceof ApiError && err.status === 401) {
					this.load = { kind: "signed-out" };
					this.thumbs.clear();
					this.rating = null;
					this.selected = null;
				} else if (this.load.kind !== "ready") {
					this.load = { kind: "error", message: err instanceof Error ? err.message : String(err) };
				}
			})
			.finally(() => {
				this.inflight = null;
				this.emit();
			});
		return this.inflight;
	}

	/** Poll every 15 s while visible; the hub itself syncs in the background. */
	start(): void {
		const tick = () => {
			if (document.visibilityState === "visible") void this.refresh(true);
		};
		this.tick = tick;
		void this.refresh(true);
		this.timer = window.setInterval(tick, 15_000);
		document.addEventListener("visibilitychange", tick);
		window.addEventListener("focus", tick);
		window.addEventListener("online", tick);
		window.addEventListener("offline", this.offline);
	}

	say(text: string, tone: Flash["tone"] = "info", ms = 7000): void {
		this.flash = { text, tone, until: Date.now() + ms };
		this.emit();
		window.setTimeout(() => {
			if (this.flash && this.flash.until <= Date.now()) {
				this.flash = null;
				this.emit();
			}
		}, ms + 50);
	}

	stop(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		if (this.tick) {
			document.removeEventListener("visibilitychange", this.tick);
			window.removeEventListener("focus", this.tick);
			window.removeEventListener("online", this.tick);
		}
		this.tick = null;
		window.removeEventListener("offline", this.offline);
	}
}

export const store = new Store();

export function useStore(): Store {
	const [, force] = useState(0);
	useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
	return store;
}

// ---------------------------------------------------------------------------
// Illumination (day / night), like a car radio's dimmer.

export type Illumination = "auto" | "day" | "night";

export function getIllumination(): Illumination {
	try {
		const v = localStorage.getItem("ts-illumination");
		return v === "day" || v === "night" ? v : "auto";
	} catch {
		return "auto";
	}
}

export function setIllumination(v: Illumination): void {
	try {
		if (v === "auto") localStorage.removeItem("ts-illumination");
		else localStorage.setItem("ts-illumination", v);
	} catch {
		/* private mode: just this session */
	}
	applyIllumination(v);
}

export function applyIllumination(v = getIllumination()): void {
	const root = document.documentElement;
	if (v === "auto") root.removeAttribute("data-illumination");
	else root.setAttribute("data-illumination", v);
}
