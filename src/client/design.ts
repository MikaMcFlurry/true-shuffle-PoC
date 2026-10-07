/**
 * The listener's chosen design. Six operating surfaces share one player:
 * the choice only switches presentation (a root attribute, the favicon and
 * the browser bar colour). It is a per-device convenience kept in
 * localStorage; nothing about stations, queue or history depends on it.
 */

import { useEffect, useState } from "preact/hooks";

export type Design = "kontakt" | "linie" | "strich" | "klassik" | "umlauf" | "fahrmodus";

export const DESIGNS: readonly {
	id: Design;
	name: string;
	line: string;
}[] = [
	{
		id: "kontakt",
		name: "Leuchttisch",
		line: "Die Warteschlange als Bilderbogen, der laufende Song im Fettstift-Rahmen, Tasten unten am Daumen.",
	},
	{
		id: "linie",
		name: "Fahrt",
		line: "Eine Linie durch den Bildschirm: gehörte Stationen oben, jetzt hier, die nächsten Halte darunter.",
	},
	{
		id: "strich",
		name: "Notizblock",
		line: "Sender als Register, die Runde als Strichliste, die Warteschlange zum Abhaken.",
	},
	{
		id: "klassik",
		name: "Player",
		line: "Der vertraute Vollbild-Player mit großem Cover, Warteschlange als Blatt darunter.",
	},
	{
		id: "umlauf",
		name: "Umlauf",
		line: "Die Runde als Kreis um das Cover, jeder Sender ein eigener kleiner Umlauf.",
	},
	{
		id: "fahrmodus",
		name: "Fahrmodus",
		line: "Riesige Schrift und große Tasten für Auto und eine Hand, schwarz auf Signalgelb.",
	},
];

export const DEFAULT_DESIGN: Design = "kontakt";
const KEY = "ts-design";

function isDesign(v: unknown): v is Design {
	return DESIGNS.some((d) => d.id === v);
}

export function getDesign(): Design {
	try {
		const v = localStorage.getItem(KEY);
		return isDesign(v) ? v : DEFAULT_DESIGN;
	} catch {
		return DEFAULT_DESIGN;
	}
}

const listeners = new Set<(d: Design) => void>();

export function setDesign(d: Design): void {
	try {
		if (d === DEFAULT_DESIGN) localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, d);
	} catch {
		/* private mode: just this page */
	}
	applyDesign(d);
}

/** Paint the attribute, favicon and browser bar for this design. */
export function applyDesign(d: Design = getDesign()): void {
	const root = document.documentElement;
	root.setAttribute("data-design", d);
	for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'))
		link.href = `/brand/${d}/icon.svg`;
	const touch = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
	if (touch) touch.href = `/brand/${d}/apple-touch-icon.png`;
	syncThemeColor();
	for (const fn of listeners) fn(d);
}

/** The browser bar takes the page ground of the active design and theme. */
export function syncThemeColor(): void {
	const bg = getComputedStyle(document.documentElement).getPropertyValue("--bar").trim();
	if (!bg) return;
	for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
		meta.content = bg;
}

/** `?design=linie` switches and remembers, so a design can be opened by link. */
export function designFromUrl(): void {
	const params = new URLSearchParams(location.search);
	const asked = params.get("design");
	if (!isDesign(asked)) return;
	setDesign(asked);
	params.delete("design");
	const rest = params.toString();
	history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}`);
}

export function useDesign(): Design {
	const [d, set] = useState<Design>(() => getDesign());
	useEffect(() => {
		listeners.add(set);
		return () => {
			listeners.delete(set);
		};
	}, []);
	return d;
}
