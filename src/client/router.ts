import { useEffect, useState } from "preact/hooks";

export type Route =
	| { name: "home" }
	| { name: "station"; id: number }
	| { name: "new-station" }
	| { name: "menu" }
	| { name: "history" }
	| { name: "import" }
	| { name: "devices" }
	| { name: "about" }
	| { name: "scan" };

export function parse(path: string): Route {
	const p = path.replace(/\/+$/, "") || "/";
	if (p === "/sender/neu") return { name: "new-station" };
	const m = /^\/sender\/(\d+)$/.exec(p);
	if (m) return { name: "station", id: Number(m[1]) };
	switch (p) {
		case "/menu":
			return { name: "menu" };
		case "/verlauf":
			return { name: "history" };
		case "/import":
			return { name: "import" };
		case "/geraete":
			return { name: "devices" };
		case "/info":
			return { name: "about" };
		case "/suchlauf":
			return { name: "scan" };
		default:
			return { name: "home" };
	}
}

const listeners = new Set<() => void>();

export function navigate(path: string, replace = false): void {
	if (path === location.pathname + location.search) return;
	if (replace) history.replaceState(null, "", path);
	else history.pushState(null, "", path);
	for (const l of listeners) l();
	window.scrollTo({ top: 0 });
}

export function back(fallback = "/"): void {
	if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
	else navigate(fallback);
}

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
