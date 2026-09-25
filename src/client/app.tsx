import { useEffect, useState } from "preact/hooks";
import { Display } from "./components/radio";
import { useRoute } from "./router";
import { Home } from "./screens/home";
import {
	AboutScreen,
	DevicesScreen,
	HistoryScreen,
	ImportScreen,
	MenuScreen,
} from "./screens/menu";
import { Scan } from "./screens/scan";
import { SignIn } from "./screens/signin";
import { NewStation, Station } from "./screens/station";
import { store, useStore } from "./store";

const DESK = "(min-width: 980px)";

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

	if (s.load.kind === "loading") {
		return (
			<div class="shell" aria-busy="true">
				<Display
					lit={[]}
					name="TRUE SHUFFLE"
					nameGhost
					song="Schaltet ein …"
					scale={{ pos: 0, label: "" }}
					tuning
				/>
				<div class="skeleton" style={{ height: "58px" }} />
				<div class="skeleton" style={{ height: "220px" }} />
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
				<Display
					lit={[]}
					name="STÖRUNG"
					song="True Shuffle ist gerade nicht erreichbar"
					message={{ text: s.load.message, tone: "error" }}
				/>
				<button type="button" class="key btn btn--wide" onClick={() => void store.refresh(true)}>
					Nochmal versuchen
				</button>
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

	// Phone: one screen at a time. Desktop: the radio stays, pages open beside it.
	return (
		<div class={`shell${side ? " shell--split" : ""}`} data-route={route.name}>
			<div class={side ? "main main--home desk-only" : "main"}>
				<Home state={state} />
			</div>
			{side ? <aside class="side">{side}</aside> : null}
		</div>
	);
}
