import { useEffect, useRef, useState } from "preact/hooks";
import { Cabinet, Dial, DialText } from "./components/radio";
import { RateSheet } from "./components/rate";
import { useRoute } from "./router";
import { Home, NowCard } from "./screens/home";
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

const DESK = "(min-width: 1200px)";

function useDesk(): boolean {
	const [desk, setDesk] = useState(() => window.matchMedia(DESK).matches);
	useEffect(() => {
		const mq = window.matchMedia(DESK);
		const on = () => setDesk(mq.matches);
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, []);
	return desk;
}

export function App() {
	const desk = useDesk();
	const s = useStore();
	const route = useRoute();
	useEffect(() => {
		store.start();
		return () => store.stop();
	}, []);

	// After a page change, focus moves to the new page's heading (the radio's badge on home).
	const first = useRef(true);
	useEffect(() => {
		if (first.current) {
			first.current = false;
			return;
		}
		const r = requestAnimationFrame(() => {
			const h =
				document.querySelector<HTMLElement>(".side h1") ??
				document.querySelector<HTMLElement>(".cabinet h1");
			if (!h) return;
			h.tabIndex = -1;
			h.focus({ preventScroll: true });
		});
		return () => cancelAnimationFrame(r);
	}, [route]);

	if (s.load.kind === "loading") {
		return (
			<div class="shell" aria-busy="true">
				<Cabinet
					fill
					eye="off"
					dial={
						<Dial label="Senderskala" at={null} sweep>
							<DialText title="Schaltet ein …" />
						</Dial>
					}
					window={<div class="skeleton skeleton--card" />}
				/>
			</div>
		);
	}
	if (s.load.kind === "signed-out") {
		return (
			<div class="shell">
				<SignIn />
			</div>
		);
	}
	if (s.load.kind === "error") {
		return (
			<div class="shell">
				<Cabinet
					fill
					eye="open"
					dial={
						<Dial label="Senderskala" at={null}>
							<DialText
								title="Störung"
								sub="true-shuffle ist gerade nicht erreichbar"
								message={{ text: s.load.message, tone: "error" }}
							/>
						</Dial>
					}
					keys={
						<div class="keyboard keyboard--one">
							<button type="button" class="pkey" onClick={() => void store.refresh(true)}>
								<span class="pkey__legend">Nochmal versuchen</span>
							</button>
						</div>
					}
				/>
			</div>
		);
	}

	const state = s.load.state;
	if (!state.onboarded && route.name !== "scan") {
		return (
			<div class="shell">
				<Scan state={state} />
			</div>
		);
	}

	const side = (() => {
		switch (route.name) {
			case "station":
				return <Station id={route.id} state={state} />;
			case "new-station":
				return <NewStation />;
			case "menu":
				return <MenuScreen state={state} />;
			case "history":
				return <HistoryScreen />;
			case "import":
				return <ImportScreen state={state} />;
			case "devices":
				return <DevicesScreen />;
			case "about":
				return <AboutScreen />;
			case "remote":
				return <RemoteScreen />;
			case "scan":
				return <Scan state={state} />;
			default: {
				// Desktop: beside the radio, the station that plays (or played last).
				if (!desk || state.stations.length === 0) return null;
				const focus =
					state.stations.find((x) => x.playing) ??
					[...state.stations].sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))[0]!;
				return <Station key={focus.id} id={focus.id} state={state} embedded />;
			}
		}
	})();

	// Phone: one screen at a time. Desktop: the radio stays, pages open beside it,
	// headed by the program card that has left the cabinet.
	if (desk) {
		return (
			<div class="shell shell--split" data-route={route.name}>
				<div class="main main--home">
					<Home state={state} />
				</div>
				<aside class="side">
					<div class="side__card">
						<NowCard state={state} />
					</div>
					{side}
				</aside>
				<RateSheet />
			</div>
		);
	}
	return (
		<div class="shell" data-route={route.name}>
			{side ? null : (
				<div class="main">
					<Home state={state} />
				</div>
			)}
			{side ? <aside class="side">{side}</aside> : null}
			{side ? <FlashStrip /> : null}
			<RateSheet />
		</div>
	);
}

/**
 * On a phone a page covers the radio, and with it the program card that
 * carries messages. They show in a strip of dial glass at the bottom instead.
 */
function FlashStrip() {
	const s = useStore();
	const flash = s.flash && s.flash.until > Date.now() ? s.flash : null;
	return (
		<div
			class={`strip${flash ? " strip--on" : ""}${flash?.tone === "error" ? " strip--error" : ""}`}
			role="status"
		>
			{flash?.text ?? ""}
		</div>
	);
}
