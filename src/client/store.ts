/**
 * App state: the hub's snapshot, polled while the page is visible, plus the
 * few things the display shows transiently (a tuning station, a message).
 */

import { useEffect, useState } from "preact/hooks";
import type { AppState, PlayResult, TrackView } from "../shared/api";
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

export type PlaybackAction = "play" | "pause" | "next" | "new";

export interface PlaybackCommand {
	id: number;
	profileId: string;
	sessionId: string | null;
	entryId: string | null;
	stationId: number;
	action: PlaybackAction;
	phase: "sending" | "accepted" | "unconfirmed" | "failed";
	observedAt: number | null;
	acceptedAt: number | null;
	newSessionExpected: boolean;
	frozen: {
		entryId: string | null;
		position: number | null;
		track: TrackView | null;
		projected: boolean;
	};
	error?: string;
}

type Listener = () => void;

class Store {
	load: Load = { kind: "loading" };
	flash: Flash | null = null;
	stale = false;
	private tick: (() => void) | null = null;
	private offline = () => {
		this.epoch++;
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
	private followup: Promise<void> | null = null;
	private followupLive = false;
	private followupFresh = false;
	private inflightFresh = false;
	private epoch = 0;
	private commandTimer: number | null = null;
	private commandReads: number[] = [];
	private transportVisible = false;
	command: PlaybackCommand | null = null;

	beginCommand(
		action: PlaybackAction,
		stationId: number,
		frozen: PlaybackCommand["frozen"],
	): number | null {
		if (
			this.load.kind !== "ready" ||
			this.stale ||
			(this.command && this.command.phase !== "failed" && this.command.phase !== "unconfirmed")
		)
			return null;
		const state = this.load.state;
		const id = ++this.epoch;
		this.clearCommand();
		this.command = {
			id,
			action,
			stationId,
			frozen,
			profileId: state.profile.id,
			sessionId: state.session?.sessionId ?? null,
			entryId: state.session?.entryId ?? null,
			observedAt: state.session?.observedAt ?? null,
			acceptedAt: null,
			newSessionExpected: action === "new" || state.session?.stationId !== stationId,
			phase: "sending",
		};
		this.emit();
		return id;
	}

	acceptCommand(id: number, result: PlayResult): boolean {
		if (this.command?.id !== id) return false;
		// Anything already being fetched may predate completion of the transport request.
		this.epoch++;
		if (!result.ok) {
			this.failCommand(
				id,
				result.error?.message ?? "Wiedergabe nicht möglich.",
				result.uncertain === true,
			);
			return false;
		}
		this.command.phase = "accepted";
		this.command.acceptedAt = result.acceptedAt ?? null;
		this.commandReads = (this.transportVisible ? [1500, 4000] : []).map((delay) =>
			window.setTimeout(() => {
				if (this.command?.id === id && this.command.phase === "accepted")
					void this.refresh(false, true);
			}, delay),
		);
		this.commandTimer = window.setTimeout(() => {
			if (this.command?.id !== id || this.command.phase !== "accepted") return;
			this.command.phase = "unconfirmed";
			this.emit();
		}, 20_000);
		this.emit();
		return true;
	}

	failCommand(id: number, message: string, uncertain = false): void {
		if (this.command?.id !== id) return;
		this.epoch++;
		this.command.phase = uncertain ? "unconfirmed" : "failed";
		this.command.error = message;
		this.emit();
	}

	setTransportVisible(visible: boolean): void {
		this.transportVisible = visible;
		if (!visible) {
			for (const timer of this.commandReads) window.clearTimeout(timer);
			this.commandReads = [];
		}
	}

	private clearCommand(): void {
		for (const timer of this.commandReads) window.clearTimeout(timer);
		this.commandReads = [];
		if (this.commandTimer !== null) window.clearTimeout(this.commandTimer);
		this.commandTimer = null;
		this.command = null;
	}

	private reconcileCommand(state: AppState): void {
		const command = this.command;
		if (!command) return;
		if (command.profileId !== state.profile.id) {
			this.clearCommand();
			return;
		}
		const session = state.session;
		if (session?.sessionId !== command.sessionId && !command.newSessionExpected) {
			this.clearCommand();
			return;
		}
		if (command.phase === "failed" && session?.entryId !== command.entryId) {
			this.clearCommand();
			return;
		}
		if (command.phase === "sending" || command.phase === "failed" || !session) return;
		const newer =
			session.observedAt !== null &&
			(command.acceptedAt !== null
				? session.observedAt >= command.acceptedAt
				: session.observedAt > (command.observedAt ?? 0));
		if (!newer || session.pending) return;
		const sameStation = session.stationId === command.stationId;
		const native = session.controller?.kind === "home-assistant";
		const entry = session.queue.find((candidate) => candidate.entryId === session.entryId);
		const ownNow =
			!!state.nowPlaying &&
			state.nowPlaying.stationId === session.stationId &&
			state.nowPlaying.id === entry?.track.id &&
			(command.acceptedAt !== null
				? state.nowPlaying.observedAt >= command.acceptedAt
				: state.nowPlaying.observedAt > (command.observedAt ?? 0));
		const confirmed =
			command.action === "pause"
				? session.status === "paused" && (native || (ownNow && !state.nowPlaying?.isPlaying))
				: command.action === "next"
					? session.entryId !== command.entryId && (native || ownNow)
					: session.status === "active" && (native || (ownNow && !!state.nowPlaying?.isPlaying));
		if (sameStation && confirmed) this.clearCommand();
	}

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

	/** A command can request one serialized read after an older in-flight poll. */
	refresh(live = true, afterInflight = false, fresh = false): Promise<void> {
		if (this.inflight) {
			if (!afterInflight && !fresh) return this.followup ?? this.inflight;
			if (!afterInflight && this.inflightFresh && !this.followup) return this.inflight;
			this.followupLive ||= live;
			this.followupFresh ||= fresh;
			if (!this.followup) {
				this.followup = this.inflight.then(() => {
					const nextLive = this.followupLive;
					const nextFresh = this.followupFresh;
					this.followupLive = false;
					this.followupFresh = false;
					this.followup = null;
					return this.refresh(nextLive, false, nextFresh);
				});
			}
			return this.followup;
		}
		const started = Date.now();
		const epoch = this.epoch;
		this.inflightFresh = fresh;
		this.inflight = api
			.state(live, fresh)
			.then((state) => {
				if (epoch !== this.epoch) return;
				const previous = this.load.kind === "ready" ? this.load.state : null;
				if (previous?.profile.id === state.profile.id) {
					if (state.serverTime < previous.serverTime) return;
					if (
						previous.session?.sessionId === state.session?.sessionId &&
						previous.session &&
						state.session &&
						(state.session.orderRevision < previous.session.orderRevision ||
							(state.session.observedAt !== null &&
								previous.session.observedAt !== null &&
								state.session.observedAt < previous.session.observedAt))
					)
						return;
				} else {
					this.thumbs.clear();
					this.rating = null;
					this.selected = null;
					this.clearCommand();
				}
				this.stale = false;
				this.reconcileCommand(state);
				this.load = { kind: "ready", state };
				if (previous?.profile.id !== state.profile.id || previous.serverTime !== state.serverTime)
					this.receivedAt = Date.now();
				if (state.nowPlaying) this.settleThumbs([state.nowPlaying], started);
				if (state.session)
					this.settleThumbs(
						state.session.queue.map((entry) => entry.track),
						started,
					);
			})
			.catch((err: unknown) => {
				if (epoch !== this.epoch) return;
				this.stale = true;
				if (err instanceof ApiError && err.status === 401) {
					this.stale = false;
					this.load = { kind: "signed-out" };
					this.thumbs.clear();
					this.rating = null;
					this.selected = null;
					this.clearCommand();
				} else if (this.load.kind !== "ready") {
					this.load = { kind: "error", message: err instanceof Error ? err.message : String(err) };
				}
			})
			.finally(() => {
				this.inflight = null;
				this.inflightFresh = false;
				this.emit();
			});
		return this.inflight;
	}

	/** Poll every 15 s while visible; the hub itself syncs in the background. */
	start(): void {
		const tick = () => {
			if (document.visibilityState === "visible") void this.refresh(true);
		};
		const returned = () => {
			if (document.visibilityState === "visible") void this.refresh(true, false, true);
		};
		this.tick = returned;
		void this.refresh(true, false, true);
		this.timer = window.setInterval(tick, 15_000);
		document.addEventListener("visibilitychange", returned);
		window.addEventListener("focus", returned);
		window.addEventListener("online", returned);
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
		for (const timer of this.commandReads) window.clearTimeout(timer);
		this.commandReads = [];
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
