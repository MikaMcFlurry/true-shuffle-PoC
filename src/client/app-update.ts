/**
 * "Aktualisieren" when a newer deploy is live (P7, mika-app-version-updates).
 *
 * No service worker: the page asks the static /build.json (never cached,
 * served by Static Assets, so no Durable Object read) on focus and every
 * ten minutes while visible. A different build id means a newer deploy; the
 * listener reloads with one tap — never by surprise.
 */

import { useEffect, useState } from "preact/hooks";

/** The commit this page was built from (vite.config.ts replaces it; tests have none). */
declare const __BUILD_ID__: string | undefined;
export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

export interface LiveBuild {
	version: string;
	build: string;
}

let ready: LiveBuild | null = null;
const listeners = new Set<() => void>();
let started = false;
let last = 0;

export async function checkForUpdate(fetcher: typeof fetch = fetch): Promise<LiveBuild | null> {
	try {
		const res = await fetcher("/build.json", { cache: "no-store" });
		if (!res.ok) return ready;
		const live = (await res.json()) as Partial<LiveBuild>;
		if (typeof live.build === "string" && live.build && live.build !== BUILD_ID) {
			ready = { version: String(live.version ?? ""), build: live.build };
			for (const l of listeners) l();
		}
	} catch {
		/* offline: ask again later */
	}
	return ready;
}

function start(): void {
	if (started) return;
	started = true;
	const look = () => {
		if (document.visibilityState !== "visible") return;
		if (Date.now() - last < 60_000) return;
		last = Date.now();
		void checkForUpdate();
	};
	window.addEventListener("focus", look);
	document.addEventListener("visibilitychange", look);
	window.setInterval(look, 10 * 60_000);
	window.setTimeout(look, 30_000);
}

/** The newer deploy, once one is live (null until then). */
export function useUpdateReady(): LiveBuild | null {
	const [, force] = useState(0);
	useEffect(() => {
		start();
		const l = () => force((n) => n + 1);
		listeners.add(l);
		return () => void listeners.delete(l);
	}, []);
	return ready;
}
