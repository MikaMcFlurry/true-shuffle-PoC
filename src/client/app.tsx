import { History, House, ListMusic, Menu } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { Mark } from "./components/mark";
import { RateSheet } from "./components/rate";
import { useRoute } from "./router";
import { Home } from "./screens/home";
import {
	AboutScreen,
	DevicesScreen,
	HistoryScreen,
	ImportScreen,
	MenuScreen,
} from "./screens/menu";
import { RemoteScreen } from "./screens/remote";
import { Scan } from "./screens/scan";
import { SignIn } from "./screens/signin";
import { NewStation, Station } from "./screens/station";
import { StationsScreen } from "./screens/stations";
import { store, useStore } from "./store";

export function App() {
	const s = useStore();
	const route = useRoute();
	const first = useRef(true);
	useEffect(() => {
		store.start();
		return () => store.stop();
	}, []);
	useEffect(() => {
		if (first.current) {
			first.current = false;
			return;
		}
		const frame = requestAnimationFrame(() => {
			const heading = document.querySelector<HTMLElement>("main h1");
			if (heading) {
				heading.tabIndex = -1;
				heading.focus({ preventScroll: true });
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [route]);
	let content = null;
	if (s.load.kind === "loading")
		content = (
			<div class="loading-view" aria-busy="true">
				<h1>Deine Musik wird geladen</h1>
				<div class="skeleton" />
				<div class="skeleton" />
			</div>
		);
	else if (s.load.kind === "signed-out") content = <SignIn />;
	else if (s.load.kind === "error")
		content = (
			<div class="page">
				<h1>Verbindung unterbrochen</h1>
				<p>{s.load.message}</p>
				<button type="button" class="key key--lit" onClick={() => void store.refresh(true)}>
					Nochmal versuchen
				</button>
			</div>
		);
	else {
		const state = s.load.state;
		if (!state.onboarded) content = <Scan state={state} />;
		else
			switch (route.name) {
				case "station":
					content = <Station key={route.id} id={route.id} state={state} />;
					break;
				case "stations":
					content = <StationsScreen state={state} />;
					break;
				case "new-station":
					content = <NewStation />;
					break;
				case "menu":
					content = <MenuScreen state={state} />;
					break;
				case "history":
					content = <HistoryScreen />;
					break;
				case "import":
					content = <ImportScreen state={state} />;
					break;
				case "devices":
					content = <DevicesScreen />;
					break;
				case "about":
					content = <AboutScreen />;
					break;
				case "remote":
					content = <RemoteScreen />;
					break;
				case "scan":
					content = <Scan state={state} />;
					break;
				default:
					content = <Home key={state.profile.id} state={state} />;
			}
	}
	return (
		<div class="app-shell" data-route={route.name}>
			<a class="skip-link" href="#content">
				Zum Inhalt
			</a>
			<header class="app-header">
				<a class="brand" href="/">
					<Mark />
					<span class="brand__word">true-shuffle</span>
				</a>
			</header>
			{s.stale ? (
				<div class="notice notice--offline" role="status">
					Offline oder nicht erreichbar. Letzter gespeicherter Stand bleibt sichtbar.{" "}
					<button type="button" class="act" onClick={() => void store.refresh(true)}>
						Erneut verbinden
					</button>
				</div>
			) : null}
			<main id="content">{content}</main>
			{s.load.kind === "signed-out" ? null : (
				<nav class="tabbar" aria-label="Hauptnavigation">
					<a href="/" aria-current={route.name === "home" ? "page" : undefined}>
						<House aria-hidden="true" />
						Jetzt
					</a>
					<a
						href="/sender"
						aria-current={
							route.name === "stations"
								? "page"
								: route.name === "station" || route.name === "new-station" || route.name === "scan"
									? "true"
									: undefined
						}
					>
						<ListMusic aria-hidden="true" />
						Sender
					</a>
					<a href="/verlauf" aria-current={route.name === "history" ? "page" : undefined}>
						<History aria-hidden="true" />
						Verlauf
					</a>
					<a
						href="/mehr"
						aria-current={
							route.name === "menu"
								? "page"
								: ["import", "devices", "about", "remote"].includes(route.name)
									? "true"
									: undefined
						}
					>
						<Menu aria-hidden="true" />
						Mehr
					</a>
				</nav>
			)}

			<div class={`flash${s.flash?.tone === "error" ? " flash--error" : ""}`} role="status">
				{s.flash?.text ?? ""}
			</div>
			<RateSheet />
		</div>
	);
}
