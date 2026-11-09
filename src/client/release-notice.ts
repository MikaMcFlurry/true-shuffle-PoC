/**
 * The "Was ist neu?" notice: once per release, on this device. Whether it was
 * seen lives under one key of this app's own in local storage — the version
 * last acknowledged here, nothing else: no account, no server, no counting.
 * Signing in as someone else changes nothing about it.
 *
 * Acknowledged only once the notice is closed (Verstanden or Escape). When
 * storage cannot be read or written, the notice still closes, and this page
 * does not ask again; the next page load may. Another tab's acknowledgement
 * counts here too, as it arrives.
 *
 * It says which version this page was loaded with. It never claims that a
 * page opened earlier was updated: nothing here reloads, polls or asks the
 * Worker.
 */

import { isLater, RELEASE } from "../shared/release";

/** The one key this notice reads and writes. */
export const RELEASE_SEEN_KEY = "ts-release-seen";

type Store = Pick<Storage, "getItem" | "setItem">;

/** This page's local storage, or null where the browser keeps it from the page. */
function pageStorage(): Store | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

export class ReleaseSeen {
	/** Closed or acknowledged elsewhere since this page loaded: not asked again here. */
	private seenHere = false;

	constructor(
		readonly version: string = RELEASE.version,
		private readonly storage: () => Store | null = pageStorage,
	) {}

	/**
	 * Whether this page still owes the listener the notice: not seen here, and
	 * the device has no acknowledgement of this release (or a later one).
	 * Unreadable storage counts as not acknowledged.
	 */
	due(): boolean {
		if (this.seenHere) return false;
		return !this.stored();
	}

	/** The notice was closed: remembered for this page, and stored when storage lets it. */
	acknowledge(): void {
		this.seenHere = true;
		if (this.stored()) return;
		try {
			this.storage()?.setItem(RELEASE_SEEN_KEY, this.version);
		} catch {
			// Full, blocked or private: this page still does not ask again.
		}
	}

	/**
	 * A change in local storage made by another tab (the `storage` event).
	 * Their acknowledgement of this release (or a later one) counts here;
	 * anything else — another key, a removal, an unreadable value — changes
	 * nothing. Returns whether it was taken over.
	 */
	heard(e: { key: string | null; newValue: string | null }): boolean {
		if (e.key !== RELEASE_SEEN_KEY || !this.covers(e.newValue)) return false;
		this.seenHere = true;
		return true;
	}

	/** Whether the device has this release (or a later one) acknowledged. */
	private stored(): boolean {
		try {
			return this.covers(this.storage()?.getItem(RELEASE_SEEN_KEY) ?? null);
		} catch {
			return false;
		}
	}

	private covers(value: string | null): boolean {
		return value === this.version || isLater(value, this.version);
	}
}

/** What the page is doing when the notice could appear. */
export interface Moment {
	/** The first snapshot is here and the listener is set up (not signed out, not loading). */
	ready: boolean;
	/** The page is in front. */
	visible: boolean;
	/** The rating sheet is open. */
	rating: boolean;
	/** A playback command is on its way. */
	sending: boolean;
	/** Another modal dialog is open. */
	dialog: boolean;
	/** The page marks something as being saved or loaded. */
	busy: boolean;
	/** The listener is typing or choosing in a field. */
	typing: boolean;
}

/** Only into a quiet page: never over a sheet, an input or a change on its way. */
export function mayShow(m: Moment): boolean {
	return m.ready && m.visible && !m.rating && !m.sending && !m.dialog && !m.busy && !m.typing;
}

/** A control the listener types or chooses in. */
export function isTyping(el: Element | null): boolean {
	if (!el) return false;
	const tag = el.tagName;
	if (tag === "TEXTAREA" || tag === "SELECT") return true;
	if ((el as HTMLElement).isContentEditable) return true;
	if (tag !== "INPUT") return false;
	const type = (el as HTMLInputElement).type;
	return !["button", "checkbox", "radio", "submit", "reset", "image", "file", "color"].includes(
		type,
	);
}

/** One notice per page; the About page can open it again on request. */
export const releaseSeen = new ReleaseSeen();

const openers = new Set<() => void>();

/** Open the notice now ("Was ist neu?"), whether or not it was seen. */
export function showReleaseNotes(): void {
	for (const open of openers) open();
}

/** The notice's host listens here for a request to open it. */
export function onShowReleaseNotes(open: () => void): () => void {
	openers.add(open);
	return () => openers.delete(open);
}
