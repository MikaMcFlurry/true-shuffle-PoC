import { useEffect, useState } from "preact/hooks";
import type { AppState, PlaylistView } from "../../shared/api";
import { api } from "../api";
import { Cover, Display, PageBar } from "../components/radio";
import { num } from "../format";
import { navigate } from "../router";
import { store } from "../store";

/**
 * "Sendersuchlauf" — the car radio's auto-store: it finds your playlists and
 * you store the ones you want as stations.
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

	const store_ = () => {
		setBusy(true);
		api
			.onboard([...picked])
			.then(() => {
				store.say(
					`${picked.size} ${picked.size === 1 ? "Sender" : "Sender"} gespeichert — werden jetzt eingelesen`,
					"info",
					6000,
				);
				return store.refresh(false);
			})
			.then(() => navigate("/", true))
			.catch((e: Error) => store.say(e.message, "error"))
			.finally(() => setBusy(false));
	};

	return (
		<div class="page">
			{/* One display per screen: the page head once onboarded, the radio's own on first run. */}
			{state.onboarded ? (
				<PageBar
					title="Sendersuchlauf"
					sub={
						lists
							? `${num(readable.length)} ${readable.length === 1 ? "Playlist" : "Playlists"} gefunden — wähle, welche Sender werden`
							: "true-shuffle sucht deine Playlists …"
					}
					backTo="/menu"
				/>
			) : (
				<Display
					lit={[]}
					name={lists ? "SUCHLAUF" : "SUCHE …"}
					song={
						lists
							? `${num(readable.length)} ${readable.length === 1 ? "Playlist" : "Playlists"} gefunden`
							: "true-shuffle sucht deine Playlists"
					}
					artist={lists ? "Wähle, welche Sender werden" : "Einen Moment"}
					// While searching, the needle sweeps; a found list has nothing left to measure.
					scale={lists ? null : { pos: 0.35, label: "Suchlauf" }}
					tuning={!lists}
					wrap
				/>
			)}
			{!state.onboarded ? (
				<p class="lede">
					Jede gewählte Playlist wird ein Sender. Dazu kommt automatisch „Alles“ — alle Sender und
					deine Lieblingssongs zusammen.
				</p>
			) : null}
			{lists === null ? <div class="skeleton" style={{ height: "280px" }} /> : null}
			{lists && readable.length > 1 ? (
				<div class="row-actions">
					<button
						type="button"
						class="key btn btn--small"
						onClick={() => setPicked(new Set(readable.map((p) => p.id)))}
					>
						Alle wählen
					</button>
					<button type="button" class="key btn btn--small" onClick={() => setPicked(new Set())}>
						Keine
					</button>
				</div>
			) : null}
			{lists ? (
				<ul class="list">
					{fresh.map((p) => (
						<li key={p.id}>
							<label class="row" aria-disabled={!p.readable}>
								<input
									type="checkbox"
									class="check"
									disabled={!p.readable}
									checked={picked.has(p.id)}
									onChange={() => toggle(p.id)}
								/>
								<Cover src={p.imageUrl} class="row__thumb" />
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
				<p class="lede">
					{state.onboarded
						? "Alle deine Playlists sind schon Sender."
						: "Keine Playlists gefunden. Lege in Spotify eine Playlist an oder folge einer — dann hier neu suchen."}
				</p>
			) : null}
			<button
				type="button"
				class="key key--lit btn btn--wide"
				disabled={busy || (picked.size === 0 && state.onboarded)}
				onClick={store_}
			>
				{picked.size > 0
					? `${picked.size} ${picked.size === 1 ? "Sender" : "Sender"} speichern`
					: state.onboarded
						? "Playlists wählen"
						: "Nur mit „Alles“ starten"}
			</button>
		</div>
	);
}
