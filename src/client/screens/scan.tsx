import { useEffect, useState } from "preact/hooks";
import type { AppState, PlaylistView } from "../../shared/api";
import { api } from "../api";
import { Cassette } from "../components/cassette";
import { Cover, PageBar } from "../components/ui";
import { num } from "../format";
import { navigate } from "../router";
import { store } from "../store";

/**
 * "Playlists hinzufügen": the listener ticks playlists, and each one becomes
 * a cassette (a station). On first run this is the welcome as well.
 */
export function Scan({ state }: { state: AppState }) {
	const [lists, setLists] = useState<PlaylistView[] | null>(null);
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const existing = new Set(
		state.stations.flatMap((s) => s.sources.flatMap((x) => (x.type === "playlist" ? [x.id] : []))),
	);

	useEffect(() => {
		let alive = true;
		let tries = 0;
		const load = () =>
			api
				.playlists()
				.then((l) => {
					if (!alive) return;
					// Right after sign-in the list may still be on its way from Spotify.
					if (l.length === 0 && tries++ < 20) {
						window.setTimeout(load, 1500);
						return;
					}
					setLists(l);
				})
				.catch(() => alive && setLists([]));
		void load();
		return () => {
			alive = false;
		};
	}, []);

	const fresh = (lists ?? []).filter((p) => !existing.has(p.id));
	const readable = fresh.filter((p) => p.readable);
	const toggle = (id: string) => {
		const next = new Set(picked);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		setPicked(next);
	};

	const save = () => {
		setBusy(true);
		api
			.onboard([...picked])
			.then(() => {
				store.say(
					picked.size > 0
						? `${picked.size} ${picked.size === 1 ? "Kassette" : "Kassetten"} angelegt. Die Songs werden jetzt eingelesen.`
						: "„Alles“ ist angelegt. Die Songs werden jetzt eingelesen.",
					"info",
					6000,
				);
				return store.refresh(false);
			})
			.then(() => navigate(state.onboarded ? "/sender" : "/", true))
			.catch((e: Error) => store.say(e.message, "error"))
			.finally(() => setBusy(false));
	};

	const found = lists
		? `${num(readable.length)} ${readable.length === 1 ? "Playlist" : "Playlists"} gefunden`
		: "true-shuffle sucht deine Playlists …";

	return (
		<div class="page scan-page" aria-busy={lists ? undefined : "true"}>
			{state.onboarded ? (
				<PageBar
					title="Playlists hinzufügen"
					sub="Jede Playlist, die du anhakst, wird eine eigene Kassette mit fester Reihenfolge."
					backTo="/sender"
				/>
			) : (
				<header class="masthead welcome">
					<div class="welcome__tape">
						<Cassette name="Alles" shell="smoke" heard={0} />
					</div>
					<h1 class="masthead__title">Willkommen bei true-shuffle</h1>
					<ol class="welcome__steps">
						<li>Jede Playlist wird eine Kassette mit fester Reihenfolge.</li>
						<li>
							Jeder Song kommt einmal dran, ohne schnelle Wiederholungen. Erst dann geht es von vorn
							los.
						</li>
						<li>
							Dazwischen kommen neue Songs, die zu dir passen. Deine Stelle bleibt immer
							gespeichert.
						</li>
					</ol>
				</header>
			)}

			<section class="section" aria-labelledby="scan-pick">
				<div class="section__head">
					<h2 id="scan-pick">
						{state.onboarded ? found : "Wähle, welche Playlists Kassetten werden"}
					</h2>
				</div>
				{state.onboarded ? null : (
					<p class="section__lead">
						{found}. Hak die an, die du als eigene Kassette hören willst. Dazu kommt automatisch
						„Alles“: alle Playlists und deine Lieblingssongs zusammen.
					</p>
				)}

				{lists === null ? <div class="skeleton" style={{ height: "280px" }} /> : null}

				{lists && readable.length > 1 ? (
					<div class="row-actions scan-all">
						<button
							type="button"
							class="key"
							onClick={() => setPicked(new Set(readable.map((p) => p.id)))}
						>
							Alle anhaken
						</button>
						<button
							type="button"
							class="key"
							disabled={picked.size === 0}
							onClick={() => setPicked(new Set())}
						>
							Keine
						</button>
					</div>
				) : null}

				{lists && fresh.length > 0 ? (
					<ul class="list picklist">
						{fresh.map((p) => (
							<li key={p.id}>
								<label class="row" aria-disabled={!p.readable}>
									<input
										type="checkbox"
										disabled={!p.readable}
										checked={picked.has(p.id)}
										onChange={() => toggle(p.id)}
									/>
									<Cover src={p.imageUrl} />
									<span class="row__main">
										<span class="row__title">{p.name}</span>
										<span class="row__sub">
											{p.readable
												? p.total !== null
													? `${num(p.total)} Songs`
													: "Playlist"
												: `von ${p.ownerName ?? "jemand anderem"} — Spotify gibt die Songs nicht heraus`}
										</span>
									</span>
								</label>
							</li>
						))}
					</ul>
				) : null}

				{lists && fresh.length === 0 ? (
					<p class="empty-state">
						{state.onboarded
							? "Alle deine Playlists sind schon Kassetten. Neue Playlists aus Spotify erscheinen hier."
							: "Keine Playlists gefunden. Leg in Spotify eine Playlist an oder folge einer, dann lade diese Seite neu. Du kannst auch gleich mit „Alles“ starten: deinen Lieblingssongs."}
					</p>
				) : null}
			</section>

			<div class="savebar">
				<button
					type="button"
					class="key key--lit key--wide"
					disabled={busy || (picked.size === 0 && state.onboarded)}
					onClick={save}
				>
					{picked.size > 0
						? `${picked.size} ${picked.size === 1 ? "Kassette" : "Kassetten"} anlegen`
						: state.onboarded
							? "Playlists anhaken"
							: "Nur mit „Alles“ starten"}
				</button>
			</div>
		</div>
	);
}
