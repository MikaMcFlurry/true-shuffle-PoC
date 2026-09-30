import { useEffect, useRef } from "preact/hooks";
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
					content = <Home state={state} />;
			}
	}
	return (
		<div class="app-shell" data-route={route.name}>
			<a class="skip-link" href="#content">
				Zum Inhalt
			</a>
			<header class="app-header">
				<a class="brand" href="/">
					true-shuffle
				</a>
				<nav aria-label="Hauptnavigation">
					<a href="/" aria-current={route.name === "home" ? "page" : undefined}>
						Hören
					</a>
					<a href="/verlauf" aria-current={route.name === "history" ? "page" : undefined}>
						Verlauf
					</a>
					<a href="/menu" aria-current={route.name === "menu" ? "page" : undefined}>
						Menü
					</a>
				</nav>
			</header>
			{s.stale ? (
				<div class="notice" role="status">
					Offline oder nicht erreichbar. Letzter gespeicherter Stand bleibt sichtbar.{" "}
					<button type="button" class="act" onClick={() => void store.refresh(true)}>
						Erneut verbinden
					</button>
				</div>
			) : null}
			<main id="content">{content}</main>
			<div class={`flash${s.flash?.tone === "error" ? " flash--error" : ""}`} role="status">
				{s.flash?.text ?? ""}
			</div>
			<RateSheet />
		</div>
	);
}
