/**
 * The release, as the listener reads it: the short notes (Mehr → Über) and
 * the small "Was ist neu?" dialog that opens once per release, into a quiet
 * page (see release-notice.ts for when and what is kept).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { RELEASE, type Release } from "../../shared/release";
import { BUILD_ID } from "../app-update";
import { pendingMutations } from "../pending-mutations";
import { isTyping, type Moment, mayShow, onShowReleaseNotes, releaseSeen } from "../release-notice";
import type { Route } from "../router";
import { store, useStore } from "../store";

const longDay = new Intl.DateTimeFormat("de-DE", {
	day: "numeric",
	month: "long",
	year: "numeric",
	timeZone: "UTC",
});

/** "17. Oktober 2026" for "2026-10-17", the same day everywhere. */
export function releaseDay(date: string): string {
	const [y, m, d] = date.split("-").map(Number);
	return longDay.format(Date.UTC(y!, m! - 1, d!));
}

/** "Diese Seite läuft mit Version 1.2.3 vom 17. Oktober 2026." — this page, not any other tab. */
export function loadedLine(r: Release = RELEASE): string {
	return `Diese Seite läuft mit Version ${r.version} vom ${releaseDay(r.date)}.`;
}

/** "Build 1a2b3c4d5e6f" — the deploy this page came from (P7). */
export function buildLine(build: string = BUILD_ID): string {
	return `Build ${build}`;
}

/** What changed, and the limit that stays. */
export function ReleaseNotes({ release = RELEASE }: { release?: Release }) {
	return (
		<>
			<ul class="release-notes">
				{release.changes.map((c) => (
					<li key={c}>{c}</li>
				))}
			</ul>
			{release.known ? (
				<p class="release-known">
					<strong>Bekannte Grenze:</strong> {release.known}
				</p>
			) : null}
		</>
	);
}

/**
 * Hosts the notice. It opens by itself once the first snapshot is in and
 * nothing else holds the listener — no sheet, no field in use, nothing being
 * saved, no write on its way — and on request from the About page. Closing
 * it (Verstanden or Escape) acknowledges it; another tab's acknowledgement
 * closes one that opened by itself here. Focus goes back where it was, else
 * to the page's heading.
 */
export function ReleaseNotice({ route }: { route: Route }) {
	useStore();
	const ref = useRef<HTMLDialogElement>(null);
	const [shown, setShown] = useState<"auto" | "asked" | null>(null);
	const how = useRef<"auto" | "asked" | null>(null);
	const back = useRef<HTMLElement | null>(null);
	const routeNow = useRef(route);
	routeNow.current = route;

	const moment = (): Moment => {
		const load = store.load;
		return {
			ready: load.kind === "ready" && load.state.onboarded && routeNow.current.name !== "scan",
			visible: document.visibilityState === "visible",
			rating: store.rating !== null,
			sending: store.command?.phase === "sending",
			dialog: [...document.querySelectorAll("dialog[open]")].some((d) => d !== ref.current),
			// Marked on the page, or a write on its way from anywhere (a sheet closed before its answer).
			busy: pendingMutations.busy() || document.querySelector('main [aria-busy="true"]') !== null,
			typing: isTyping(document.activeElement),
		};
	};
	const open = (asked: boolean) => {
		if (how.current) return;
		if (!asked && !(releaseSeen.due() && mayShow(moment()))) return;
		const active = document.activeElement;
		back.current = active instanceof HTMLElement && active !== document.body ? active : null;
		how.current = asked ? "asked" : "auto";
		setShown(how.current);
	};
	const check = useRef(() => open(false));
	check.current = () => open(false);

	// After every render of the app: the first quiet moment, in the frame it arrives.
	useLayoutEffect(() => check.current());
	useLayoutEffect(() => {
		const d = ref.current;
		if (shown && d && !d.open) d.showModal();
	}, [shown]);

	useEffect(() => {
		const later = () => window.setTimeout(() => check.current(), 0);
		const now = () => check.current();
		const heard = (e: StorageEvent) => {
			if (releaseSeen.heard(e) && how.current === "auto") ref.current?.close();
		};
		const asked = onShowReleaseNotes(() => open(true));
		const written = pendingMutations.subscribe(now);
		// A sheet closing, a field let go, the page in front again, a save done.
		document.addEventListener("close", now, true);
		document.addEventListener("focusout", later);
		document.addEventListener("visibilitychange", now);
		window.addEventListener("storage", heard);
		const busy = new MutationObserver(now);
		busy.observe(document.body, {
			subtree: true,
			attributes: true,
			attributeFilter: ["aria-busy"],
		});
		return () => {
			asked();
			written();
			document.removeEventListener("close", now, true);
			document.removeEventListener("focusout", later);
			document.removeEventListener("visibilitychange", now);
			window.removeEventListener("storage", heard);
			busy.disconnect();
		};
	}, []);

	const closed = () => {
		if (!how.current) return;
		how.current = null;
		setShown(null);
		releaseSeen.acknowledge();
		const to = back.current;
		back.current = null;
		if (to?.isConnected) to.focus({ preventScroll: true });
		else {
			const heading = document.querySelector<HTMLElement>("main h1");
			if (heading) {
				heading.tabIndex = -1;
				heading.focus({ preventScroll: true });
			}
		}
	};

	return (
		<dialog ref={ref} class="sheet sheet--release" aria-labelledby="release-title" onClose={closed}>
			{shown ? (
				<div class="sheet__body">
					<h2 id="release-title" class="release-title">
						Neu in Version {RELEASE.version}
					</h2>
					<p class="hint">{loadedLine()}</p>
					<ReleaseNotes />
					<p class="hint">Das steht jederzeit unter Mehr → Über true-shuffle.</p>
					<button type="button" class="key key--lit" onClick={() => ref.current?.close()}>
						Verstanden
					</button>
				</div>
			) : null}
		</dialog>
	);
}
