import { useEffect, useState } from "preact/hooks";

export type Route =
	| { name: "home" }
	| { name: "stations" }
	| { name: "station"; id: number }
	| { name: "new-station" }
	| { name: "menu" }
	| { name: "history" }
	| { name: "profile" }
	| { name: "import" }
	| { name: "devices" }
	| { name: "about" }
	| { name: "remote" }
	| { name: "scan" };

export function parse(path: string): Route {
	const p = path.replace(/\/+$/, "") || "/";
	if (p === "/sender/neu") return { name: "new-station" };
	const m = /^\/sender\/(\d+)$/.exec(p);
	if (m) return { name: "station", id: Number(m[1]) };
	switch (p) {
		case "/sender":
			return { name: "stations" };
		case "/mehr":
		case "/menu":
			return { name: "menu" };
		case "/verlauf":
			return { name: "history" };
		case "/profil":
			return { name: "profile" };
		case "/import":
			return { name: "import" };
		case "/geraete":
			return { name: "devices" };
		case "/info":
			return { name: "about" };
		case "/fernbedienung":
			return { name: "remote" };
		case "/suchlauf":
			return { name: "scan" };
		default:
			return { name: "home" };
	}
}

const listeners = new Set<() => void>();

/** How many pages deep the listener went inside the app (so "Zurück" can go back there). */
let depth = 0;

export function navigate(path: string, replace = false): void {
	if (path === location.pathname + location.search) return;
	if (replace) history.replaceState({ depth }, "", path);
	else {
		depth += 1;
		history.pushState({ depth }, "", path);
	}
	for (const l of listeners) l();
	window.scrollTo({ top: 0 });
}

/** Back to where the listener came from inside the app; else to the page's parent. */
export function back(fallback = "/"): void {
	if (depth > 0) history.back();
	else navigate(fallback);
}

window.addEventListener("popstate", (e) => {
	const d = (e.state as { depth?: number } | null)?.depth;
	depth = typeof d === "number" ? d : 0;
});

export function useRoute(): Route {
	const [route, setRoute] = useState(() => parse(location.pathname));
	useEffect(() => {
		const update = () => setRoute(parse(location.pathname));
		listeners.add(update);
		window.addEventListener("popstate", update);
		return () => {
			listeners.delete(update);
			window.removeEventListener("popstate", update);
		};
	}, []);
	return route;
}

/** Intercept same-origin link clicks so navigation stays in the app. */
export function onLink(e: MouseEvent): void {
	const a = (e.target as HTMLElement).closest("a");
	if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
	const href = a.getAttribute("href");
	if (!href?.startsWith("/") || href.startsWith("/auth/") || a.target) return;
	e.preventDefault();
	navigate(href);
}
