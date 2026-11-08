/**
 * App state: the hub's snapshot, polled while the page is visible, plus the
 * few things the display shows transiently (a tuning station, a message).
 */

import { useEffect, useState } from "preact/hooks";
import type { AppState, ObservedTarget, PlayResult, TrackView } from "../shared/api";
import { statePollMs } from "../shared/poll-pace";
import { writeNumber } from "../shared/rating-number";
import { ApiError, api } from "./api";
import type { FrozenView } from "./playback-view";
import { syncThemeColor } from "./theme";

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
	frozen: FrozenView;
	/**
	 * A "next" on a song Spotify was seen playing outside true-shuffle (NP06):
	 * the play it named. Spotify's acknowledgement is not its confirmation; only
	 * a later look showing another play is. `observedAt` holds the look it was given on.
	 */
	observed?: { trackId: string; playId: string; deviceId: string | null };
	error?: string;
}

type Listener = () => void;

/** Return signals within this of a fresh read share it (see refresh). */
const FRESH_BURST_MS = 1000;

class Store {
	load: Load = { kind: "loading" };
	flash: Flash | null = null;
	stale = false;
	/** Why the last read failed, said in the offline notice (P1: never just "Interner Fehler"). */
	staleReason: { kind: "offline" | "limit" | "server"; message: string } | null = null;
	private tick: (() => void) | null = null;
	private offline = () => {
		this.epoch++;
		this.stale = true;
		this.staleReason = { kind: "offline", message: "" };
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
	/**
	 * Reads of stored ratings in the order they were asked for: every snapshot
	 * read and every Verlauf list takes the next number. Two reads can begin in
	 * one millisecond, never under one number.
	 */
	private readsAsked = 0;
	/** The newest read the open sheet has heard from (opened: every read asked so far). */
	private ratingHeard = 0;
	/** The number a Verlauf list was asked for under, by the `known` map it was given. */
	private listAsked = new WeakMap<object, number>();
	/**
	 * Counts every opening and closing of the rating sheet, and every change of
	 * account: a late answer acts only on the sheet it was given in.
	 */
	ratingGen = 0;
	/** Counts every sign-out and change of account: answers from before count for nothing. */
	accountGen = 0;
	/** Thumbs given here, shown at once in every list until a later load has them. */
	private thumbs = new Map<string, { v: -1 | 0 | 1; at: number }>();
	/**
	 * The newest stored rating heard per song, by the server's write number
	 * (`rated`): from snapshots, Verlauf lists and confirmations alike, the one
	 * rule the sheet, the lists and the Verlauf share. A read without a number
	 * (older answers) never replaces a known one. `seen`: the thumb given here
	 * that this rating already accounts for (by identity, never by the clock).
	 */
	private stored = new Map<
		string,
		{ v: -1 | 0 | 1; seq: number; seen: { v: -1 | 0 | 1; at: number } | undefined }
	>();
	/**
	 * Per thumb given here (by identity): the lowest write number known to
	 * account for it. Every rating stored at that number or later accounts for
	 * it too — a newer list that never saw it, or an equal one that did. A new
	 * thumb is a new object: nothing accounts for it until a read says so.
	 */
	private covered = new WeakMap<object, number>();
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
	private running = false;
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

	/**
	 * A "next" on an observed play (NP06), for the account it was shown for and
	 * only while no other command is on its way. Never repeated from here: an
	 * unclear answer waits for a new look.
	 */
	beginObserved(target: ObservedTarget, frozen: FrozenView): number | null {
		if (
			this.load.kind !== "ready" ||
			this.stale ||
			this.load.state.profile.id !== target.account ||
			(this.command && this.command.phase !== "failed" && this.command.phase !== "unconfirmed") ||
			// The same play's "next" still unconfirmed: never sent again from here.
			(this.command?.phase === "unconfirmed" &&
				this.command.observed?.trackId === target.trackId &&
				this.command.observed.playId === target.playId)
		)
			return null;
		const state = this.load.state;
		const id = ++this.epoch;
		this.clearCommand();
		this.command = {
			id,
			action: "next",
			stationId: state.session?.stationId ?? 0,
			frozen,
			profileId: state.profile.id,
			sessionId: state.session?.sessionId ?? null,
			entryId: null,
			observedAt: state.observed?.checkedAt ?? null,
			acceptedAt: null,
			newSessionExpected: false,
			phase: "sending",
			observed: { trackId: target.trackId, playId: target.playId, deviceId: target.deviceId },
		};
		this.emit();
		return id;
	}

	acceptCommand(id: number, result: PlayResult): boolean {
		if (this.command?.id !== id) return false;
		// Anything already being fetched may predate completion of the transport request.
		this.epoch++;
		if (!result.ok) {
			// An observed "next" already sent for this play (NP06): unconfirmed, never retried.
			this.failCommand(
				id,
				result.error?.message ?? "Wiedergabe nicht möglich.",
				result.uncertain === true || result.observedPending === true,
			);
			return false;
		}
		this.command.phase = "accepted";
		this.command.acceptedAt = result.acceptedAt ?? null;
		// The accepted command belongs to the visible app, including after a route change.
		this.commandReads = (this.running ? [1500, 4000] : []).map((delay) =>
			window.setTimeout(() => {
				if (
					this.running &&
					document.visibilityState === "visible" &&
					this.command?.id === id &&
					this.command.phase === "accepted"
				)
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
		// A same-account snapshot is not evidence that a rejected command succeeded.
		// Keep its explanation until the listener replaces it with another command.
		if (command.phase === "failed") return;
		if (command.observed) {
			// Only a successful look after Spotify's answer (or, unanswered, after the
			// look it was given on) tells. Another play there: done. The same play:
			// still waiting after an acknowledgement (Spotify can lag), and while the
			// hub still holds a "next" sent for it (nextPending, shared by every tab);
			// otherwise, after an unclear answer, that look is the truth and the key is free.
			const o = state.observed;
			if (command.phase === "sending" || !o || o.checkedAt === null || o.state === "unknown")
				return;
			const after =
				command.acceptedAt !== null
					? o.checkedAt >= command.acceptedAt
					: o.checkedAt > (command.observedAt ?? 0);
			if (!after) return;
			const same =
				o.track?.id === command.observed.trackId && o.target?.playId === command.observed.playId;
			if (!same || (command.phase === "unconfirmed" && !o.nextPending)) this.clearCommand();
			return;
		}
		const session = state.session;
		if (session?.sessionId !== command.sessionId && !command.newSessionExpected) {
			this.clearCommand();
			return;
		}
		if (command.phase === "sending" || !session) return;
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
		this.ratingGen++;
		this.rating = t;
		// What it was opened with stands until a read asked for after this says otherwise.
		this.ratingHeard = this.readsAsked;
		this.emit();
	}

	/**
	 * A read asked for as number `asked` has the open sheet's song stored as
	 * `thumb`: the sheet shows that beneath any thumb given here since, without
	 * being opened again. A read asked for before the sheet opened, or before the
	 * newest one it heard from, is older and tells it nothing.
	 */
	private retell(id: string, thumb: -1 | 0 | 1, asked: number): void {
		const open = this.rating;
		if (!open || open.id !== id || asked <= this.ratingHeard) return;
		this.ratingHeard = asked;
		if (open.thumb !== thumb) this.rating = { ...open, thumb };
	}

	/** A thumb given here gives way to a read that has it: the open sheet keeps showing it. */
	private keepShown(id: string, own: { v: -1 | 0 | 1 }): void {
		const open = this.rating;
		if (open?.id === id && open.thumb !== own.v) this.rating = { ...open, thumb: own.v };
	}

	/** The rating given here last for a song (sheet, player keys, Verlauf), and when. */
	thumbOverride(id: string): { v: -1 | 0 | 1; at: number } | undefined {
		return this.thumbs.get(id);
	}

	/**
	 * A song's rating as shown everywhere: a thumb given here, unless the newest
	 * stored rating heard already accounts for it; else that stored rating; else
	 * what the song came with.
	 */
	thumbOf(t: { id: string; thumb: -1 | 0 | 1 }): -1 | 0 | 1 {
		const own = this.thumbs.get(t.id);
		const st = this.stored.get(t.id);
		if (st) return own && own !== st.seen && !this.covers(own, st.seq) ? own.v : st.v;
		return own?.v ?? t.thumb;
	}

	/** Whether a rating stored at write number `seq` accounts for this thumb given here. */
	covers(own: { v: -1 | 0 | 1; at: number }, seq: number): boolean {
		const at = this.covered.get(own);
		return at !== undefined && at <= seq;
	}

	/** The newest stored rating heard for a song, with its write number. */
	storedOf(
		id: string,
	): { v: -1 | 0 | 1; seq: number; seen: { v: -1 | 0 | 1; at: number } | undefined } | undefined {
		return this.stored.get(id);
	}

	/**
	 * A stored rating heard at write number `seq`: kept when no newer one is
	 * known. The same number is the same write: what is known stays. `seen`, the
	 * thumb given here this read already had, counts as accounted for from `seq`
	 * on, whether or not the rating itself is kept. Without a number it tells
	 * nothing here. Returns whether the rating was kept.
	 */
	noteStored(
		id: string,
		v: -1 | 0 | 1,
		seq: number | undefined,
		seen?: { v: -1 | 0 | 1; at: number },
	): boolean {
		if (seq === undefined) return false;
		const was = seen ? this.covered.get(seen) : undefined;
		const covering = !!seen && (was === undefined || seq < was);
		if (seen && covering) this.covered.set(seen, seq);
		const cur = this.stored.get(id);
		if (cur && seq <= cur.seq) {
			if (covering) this.emit();
			return false;
		}
		this.stored.set(id, { v, seq, seen });
		this.emit();
		return true;
	}

	/**
	 * The rows of an accepted Verlauf list (any page): their stored ratings and
	 * numbers count, with the thumbs given here the list was asked after
	 * (`known`, by identity) as accounted for. No thumb given here gives way for it.
	 */
	noteListedRatings(
		rows: { id: string; thumb: -1 | 0 | 1; rated?: number }[],
		known: ReadonlyMap<string, { v: -1 | 0 | 1; at: number }>,
	): void {
		for (const r of rows) {
			const own = this.thumbs.get(r.id);
			this.noteStored(
				r.id,
				r.thumb,
				writeNumber(r.rated),
				own && known.get(r.id) === own ? own : undefined,
			);
		}
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
		const shown = this.shownOpen();
		for (const s of songs) {
			const own = this.thumbs.get(s.id);
			if (own && own.at < loadStartedAt) {
				this.thumbs.delete(s.id);
				this.keepShown(s.id, own);
			}
		}
		if (this.shownOpen() !== shown) this.emit();
	}

	/** The thumbs given here as they stand now: what a list asked for now knows. */
	thumbsNow(): ReadonlyMap<string, { v: -1 | 0 | 1; at: number }> {
		const known = new Map(this.thumbs);
		this.listAsked.set(known, ++this.readsAsked);
		return known;
	}

	/**
	 * Like `settleThumbs`, by what the list was asked after rather than by the
	 * clock (the Verlauf): a thumb still standing exactly as it stood when the
	 * list was asked for is known to it, and gives way; one given since stays.
	 * The open sheet's song in a list asked for (`thumbsNow`) after the sheet
	 * opened, and after any read it heard from, shows what the list has stored.
	 */
	settleKnownThumbs(
		songs: { id: string; thumb: -1 | 0 | 1; rated?: number }[],
		known: ReadonlyMap<string, { v: -1 | 0 | 1; at: number }>,
	): void {
		const shown = this.shownOpen();
		const asked = this.listAsked.get(known);
		for (const s of songs) {
			const own = this.thumbs.get(s.id);
			if (own && known.get(s.id) === own) {
				this.thumbs.delete(s.id);
				this.keepShown(s.id, own);
			}
			// Only a row without a write number (an older answer) is ordered by when it was asked.
			if (asked !== undefined && writeNumber(s.rated) === undefined)
				this.retell(s.id, s.thumb, asked);
		}
		if (this.shownOpen() !== shown) this.emit();
	}

	/** What the open sheet shows as stored, and for which song (a new value when either changes). */
	private shownOpen(): string | null {
		return this.rating ? `${this.rating.id}:${this.thumbOf(this.rating)}` : null;
	}

	/** A command can request one serialized read after an older in-flight poll. */
	refresh(live = true, afterInflight = false, fresh = false): Promise<void> {
		if (this.inflight) {
			if (!afterInflight && !fresh) return this.followup ?? this.inflight;
			// A burst (focus, visibility, online at once) shares one fresh read; a
			// return later than a fresh read already on its way asks again after it:
			// that read may predate what changed (1.2.0's fixed 15 s tick hid this).
			if (
				!afterInflight &&
				this.inflightFresh &&
				!this.followup &&
				Date.now() - this.inflightAt < FRESH_BURST_MS
			)
				return this.inflight;
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
		this.inflightAt = started;
		const asked = ++this.readsAsked;
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
					this.stored.clear();
					this.accountGen++;
					this.ratingGen++;
					this.rating = null;
					this.selected = null;
					this.clearCommand();
				}
				this.stale = false;
				this.staleReason = null;
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
				// What this accepted snapshot has stored, by write number where it says one;
				// the open sheet's song without one (an older answer) by when it was asked.
				const read = [
					state.nowPlaying,
					...(state.session?.queue.map((entry) => entry.track) ?? []),
				];
				for (const t of read) if (t) this.noteStored(t.id, t.thumb, writeNumber(t.rated));
				const open = this.rating;
				const told = open ? read.find((t) => t?.id === open.id) : undefined;
				if (told && writeNumber(told.rated) === undefined) this.retell(told.id, told.thumb, asked);
			})
			.catch((err: unknown) => {
				if (epoch !== this.epoch) return;
				this.stale = true;
				this.staleReason =
					err instanceof ApiError && (err.code === "storage_limit" || err.code === "storage_full")
						? { kind: "limit", message: err.message }
						: err instanceof ApiError && err.status > 0
							? { kind: "server", message: "" }
							: { kind: "offline", message: "" };
				if (err instanceof ApiError && err.status === 401) {
					this.stale = false;
					this.staleReason = null;
					this.load = { kind: "signed-out" };
					this.thumbs.clear();
					this.stored.clear();
					this.accountGen++;
					this.ratingGen++;
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

	/** When the read on its way was asked. */
	private inflightAt = 0;
	/** When the listener last touched the app (pace of the poll, see statePollMs). */
	private interactedAt = Date.now();
	private readonly touched = () => {
		const quiet = Date.now() - this.interactedAt;
		this.interactedAt = Date.now();
		// Back from a long quiet spell: the next look comes at the quick pace.
		if (quiet > 2 * 60_000) this.schedulePoll();
	};

	/** The next poll at the pace the current state asks for (P1; 1.2.0 asked every 15 s). */
	private schedulePoll(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		if (!this.running) return;
		const state = this.load.kind === "ready" ? this.load.state : null;
		const wait = statePollMs({
			playing: state?.nowPlaying?.isPlaying === true,
			sinceInteractionMs: Date.now() - this.interactedAt,
		});
		this.timer = window.setTimeout(() => {
			this.timer = null;
			if (document.visibilityState === "visible")
				void this.refresh(true).finally(() => this.schedulePoll());
			else this.schedulePoll();
		}, wait);
	}

	/** Poll while visible at an adaptive pace; the hub itself syncs in the background. */
	start(): void {
		this.running = true;
		const returned = () => {
			if (document.visibilityState === "visible") {
				this.interactedAt = Date.now();
				void this.refresh(true, false, true).finally(() => this.schedulePoll());
			}
		};
		this.tick = returned;
		void this.refresh(true, false, true).finally(() => this.schedulePoll());
		document.addEventListener("visibilitychange", returned);
		window.addEventListener("focus", returned);
		window.addEventListener("online", returned);
		window.addEventListener("offline", this.offline);
		window.addEventListener("pointerdown", this.touched, { passive: true });
		window.addEventListener("keydown", this.touched);
	}

	/** The Likes of the last snapshot (P4), null before one or from an older server. */
	loadedLikes(): import("../shared/api").LikesView | null {
		return this.load.kind === "ready" ? (this.load.state.likes ?? null) : null;
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
		this.running = false;
		for (const timer of this.commandReads) window.clearTimeout(timer);
		this.commandReads = [];
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		window.removeEventListener("pointerdown", this.touched);
		window.removeEventListener("keydown", this.touched);
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
	syncThemeColor();
}
