/**
 * When the "Was ist neu?" notice is owed, and what it keeps (TS-RELEASE-NOTICE-261017):
 * one key of its own in local storage, written only once the notice is
 * closed; a first, the same and a newer release; unreadable, invalid and
 * failing storage; another tab's acknowledgement; no other key touched.
 */
import { expect, it } from "vitest";
import {
	isTyping,
	type Moment,
	mayShow,
	onShowReleaseNotes,
	RELEASE_SEEN_KEY,
	ReleaseSeen,
	showReleaseNotes,
} from "../../src/client/release-notice";
import { RELEASE } from "../../src/shared/release";

/** A local storage that records every key it is asked about. */
function storage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	const calls: string[] = [];
	return {
		data,
		calls,
		getItem(k: string) {
			calls.push(`get ${k}`);
			return data.get(k) ?? null;
		},
		setItem(k: string, v: string) {
			calls.push(`set ${k}=${v}`);
			data.set(k, v);
		},
	};
}

const failing = (calls: string[] = []) => ({
	getItem(k: string): string | null {
		calls.push(`get ${k}`);
		throw new DOMException("blocked", "SecurityError");
	},
	setItem(k: string): void {
		calls.push(`set ${k}`);
		throw new DOMException("full", "QuotaExceededError");
	},
});

it("is owed on a first release, kept only after closing, and not owed again for it", () => {
	const s = storage({ "ts-illumination": "night", "ts-device": "abc" });
	const page = new ReleaseSeen("1.4.0", () => s);
	expect(page.due()).toBe(true);
	// Shown, not yet closed: nothing written.
	expect(page.due()).toBe(true);
	expect(s.calls.filter((c) => c.startsWith("set"))).toEqual([]);
	page.acknowledge();
	expect(page.due()).toBe(false);
	expect(s.data.get(RELEASE_SEEN_KEY)).toBe("1.4.0");
	// Another page load of the same release.
	expect(new ReleaseSeen("1.4.0", () => s).due()).toBe(false);
	// No other key read or written, and the others stay as they were.
	expect(new Set(s.calls.map((c) => c.split(/[ =]/)[1]))).toEqual(new Set([RELEASE_SEEN_KEY]));
	expect(s.data.get("ts-illumination")).toBe("night");
	expect(s.data.get("ts-device")).toBe("abc");
	expect(s.data.size).toBe(3);
});

it("is owed again for a newer release; an older one acknowledged on a later version is not", () => {
	const s = storage({ [RELEASE_SEEN_KEY]: "1.4.0" });
	const next = new ReleaseSeen("1.5.0", () => s);
	expect(next.due()).toBe(true);
	next.acknowledge();
	expect(s.data.get(RELEASE_SEEN_KEY)).toBe("1.5.0");
	// A rolled-back page (or an older tab) finds a later acknowledgement: nothing to say.
	expect(new ReleaseSeen("1.4.0", () => s).due()).toBe(false);
	expect(new ReleaseSeen("1.10.0", () => s).due()).toBe(true);
});

it("treats an invalid stored value as not acknowledged and replaces it on closing", () => {
	for (const bad of ["", "on", "1.4", "{}", "1.4.0 ", "v1.4.0", "999999999.0.0"]) {
		const s = storage({ [RELEASE_SEEN_KEY]: bad });
		const page = new ReleaseSeen("1.4.0", () => s);
		expect(page.due()).toBe(true);
		page.acknowledge();
		expect(s.data.get(RELEASE_SEEN_KEY)).toBe("1.4.0");
	}
});

it("never blocks on failing storage: closes, and this page does not ask again; the next may", () => {
	const calls: string[] = [];
	const page = new ReleaseSeen("1.4.0", () => failing(calls));
	expect(page.due()).toBe(true);
	expect(() => page.acknowledge()).not.toThrow();
	expect(page.due()).toBe(false);
	expect(calls.every((c) => c.endsWith(RELEASE_SEEN_KEY))).toBe(true);
	expect(new ReleaseSeen("1.4.0", () => failing()).due()).toBe(true);
	// No storage at all (the browser keeps it from the page), or a throwing getter.
	const none = new ReleaseSeen("1.4.0", () => null);
	expect(none.due()).toBe(true);
	none.acknowledge();
	expect(none.due()).toBe(false);
	const throwing = new ReleaseSeen("1.4.0", () => {
		throw new DOMException("denied", "SecurityError");
	});
	expect(throwing.due()).toBe(true);
	expect(() => throwing.acknowledge()).not.toThrow();
	expect(throwing.due()).toBe(false);
});

it("takes over another tab's acknowledgement of this release (or a later one) only", () => {
	const s = storage();
	const page = new ReleaseSeen("1.4.0", () => s);
	expect(page.heard({ key: "ts-illumination", newValue: "1.4.0" })).toBe(false);
	expect(page.heard({ key: RELEASE_SEEN_KEY, newValue: null })).toBe(false);
	expect(page.heard({ key: RELEASE_SEEN_KEY, newValue: "1.3.9" })).toBe(false);
	expect(page.heard({ key: RELEASE_SEEN_KEY, newValue: "garbage" })).toBe(false);
	expect(page.heard({ key: null, newValue: null })).toBe(false);
	expect(page.due()).toBe(true);
	expect(page.heard({ key: RELEASE_SEEN_KEY, newValue: "1.4.0" })).toBe(true);
	expect(page.due()).toBe(false);
	const other = new ReleaseSeen("1.4.0", () => storage());
	expect(other.heard({ key: RELEASE_SEEN_KEY, newValue: "1.5.0" })).toBe(true);
	expect(other.due()).toBe(false);
});

it("does not write again what another tab already stored", () => {
	const s = storage();
	const a = new ReleaseSeen("1.4.0", () => s);
	const b = new ReleaseSeen("1.4.0", () => s);
	expect(a.due() && b.due()).toBe(true);
	a.acknowledge();
	b.heard({ key: RELEASE_SEEN_KEY, newValue: "1.4.0" });
	b.acknowledge();
	expect(s.calls.filter((c) => c.startsWith("set"))).toEqual([`set ${RELEASE_SEEN_KEY}=1.4.0`]);
});

it("knows no account: a change of sign-in leaves the acknowledgement as it is", () => {
	// The record holds only the version; nothing in it or its key names a listener.
	const s = storage();
	new ReleaseSeen(RELEASE.version, () => s).acknowledge();
	expect([...s.data.entries()]).toEqual([[RELEASE_SEEN_KEY, RELEASE.version]]);
	expect(new ReleaseSeen(RELEASE.version, () => s).due()).toBe(false);
});

it("defaults to the shared release", () => {
	expect(new ReleaseSeen().version).toBe(RELEASE.version);
});

const quiet: Moment = {
	ready: true,
	visible: true,
	rating: false,
	sending: false,
	dialog: false,
	busy: false,
	typing: false,
};

it("appears only into a quiet page", () => {
	expect(mayShow(quiet)).toBe(true);
	for (const k of ["ready", "visible"] as const)
		expect(mayShow({ ...quiet, [k]: false })).toBe(false);
	for (const k of ["rating", "sending", "dialog", "busy", "typing"] as const)
		expect(mayShow({ ...quiet, [k]: true })).toBe(false);
});

it("counts fields being typed or chosen in, not keys and boxes", () => {
	const el = (tagName: string, extra: Record<string, unknown> = {}) =>
		({ tagName, isContentEditable: false, ...extra }) as unknown as Element;
	expect(isTyping(null)).toBe(false);
	expect(isTyping(el("BUTTON"))).toBe(false);
	expect(isTyping(el("A"))).toBe(false);
	expect(isTyping(el("TEXTAREA"))).toBe(true);
	expect(isTyping(el("SELECT"))).toBe(true);
	expect(isTyping(el("DIV", { isContentEditable: true }))).toBe(true);
	expect(isTyping(el("INPUT", { type: "text" }))).toBe(true);
	expect(isTyping(el("INPUT", { type: "search" }))).toBe(true);
	expect(isTyping(el("INPUT", { type: "range" }))).toBe(true);
	expect(isTyping(el("INPUT", { type: "checkbox" }))).toBe(false);
	expect(isTyping(el("INPUT", { type: "radio" }))).toBe(false);
	expect(isTyping(el("INPUT", { type: "button" }))).toBe(false);
});

it("opens on request through its host, and stops listening when the host goes", () => {
	let opened = 0;
	const stop = onShowReleaseNotes(() => opened++);
	showReleaseNotes();
	expect(opened).toBe(1);
	stop();
	showReleaseNotes();
	expect(opened).toBe(1);
});
