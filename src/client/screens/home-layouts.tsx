/**
 * Six ways to arrange the listening screen. Every layout places the same
 * parts built in home.tsx (same buttons, labels, handlers and honest states);
 * only their order, grouping and surroundings differ. Nothing here talks to
 * the player except the read-only "zuletzt gehört" stops in Fahrt.
 */

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { HistoryEntry, StationSummary } from "../../shared/api";
import { api } from "../api";
import type { Design } from "../design";
import { clock } from "../format";

export interface HomeParts {
	head: ComponentChildren;
	art: ComponentChildren;
	copy: ComponentChildren;
	nowShelf: ComponentChildren;
	progress: ComponentChildren;
	signalBlock: ComponentChildren;
	transport: ComponentChildren;
	savedNote: ComponentChildren;
	notices: ComponentChildren;
	devicePanel: ComponentChildren;
	lateNotices: ComponentChildren;
	queueSection: ComponentChildren;
	libraryHead: ComponentChildren;
	stationList: ComponentChildren;
	stationActions: ComponentChildren;
	libraryLinks: ComponentChildren;
	stageClass: string;
	inkClass: string;
	posterStation: StationSummary | null;
	/** Title of the next saved stop, for display only. */
	nextTitle: string | null;
}

export function HomeLayout(props: {
	design: Design;
	parts: HomeParts;
	/** The saved occurrence; a display-only estimate never changes it. */
	confirmedEntry: string | null;
	confirmedTrackId: string | null;
}) {
	const p = props.parts;
	const side = (
		<div class="player-side">
			{p.notices}
			{p.devicePanel}
			{p.lateNotices}
		</div>
	);
	switch (props.design) {
		case "kontakt":
			// Leuchttisch: the current frame large, the Sender as film tabs under it, the queue as
			// a sheet of frames, transport in a dock under the thumb.
			return (
				<div class="listening-workspace lw lw--kontakt">
					<section class="player" aria-labelledby="listen-title">
						<div class={p.stageClass}>
							{p.head}
							{p.nowShelf}
							{p.savedNote}
						</div>
						<Dock ink={p.inkClass}>
							{p.progress}
							{p.signalBlock}
							{p.transport}
						</Dock>
						{side}
					</section>
					<aside class="library library--strip" aria-labelledby="stations-title">
						{p.libraryHead}
						{p.stationList}
						{p.stationActions}
					</aside>
					{p.queueSection}
					<div class="home-tail">{p.libraryLinks}</div>
				</div>
			);
		case "linie":
			// Fahrt: one unbroken line through the screen, heard stops above, the current stop as the
			// interchange, next stops below; the device stands beside the line and the keys sit on a
			// departure board that names the next stop.
			return (
				<div class="listening-workspace lw lw--linie">
					<section class="player ride-grid" aria-labelledby="listen-title">
						<div class={`ride ${p.inkClass}`}>
							<div class={p.stageClass}>
								{p.head}
								<button
									type="button"
									class="act ride-switch"
									onClick={() =>
										document
											.getElementById("stations-title")
											?.scrollIntoView({ behavior: "smooth", block: "start" })
									}
								>
									Linie wechseln
								</button>
								<RidePast entry={props.confirmedEntry} trackId={props.confirmedTrackId} />
								<div class="ride-now">
									{p.nowShelf}
									{p.progress}
									{p.signalBlock}
								</div>
							</div>
							<div class="ride-notices">
								{p.notices}
								{p.lateNotices}
							</div>
							{p.queueSection}
						</div>
						<div class="player-side ride-side">
							{p.devicePanel}
							{p.savedNote}
						</div>
						<Dock ink={p.inkClass} board>
							<p class="board-next">
								<span class="board-next__label">Nächster Halt</span>
								<span class="board-next__song">
									{p.nextTitle ?? "Ende der gespeicherten Strecke"}
								</span>
							</p>
							{p.transport}
						</Dock>
					</section>
					<aside class="library library--network" aria-labelledby="stations-title">
						{p.libraryHead}
						{p.stationList}
						{p.stationActions}
						{p.libraryLinks}
					</aside>
				</div>
			);
		case "strich":
			// Notizblock: register tabs for the Sender, the round as a tally on the page, the song as
			// today's entry and the queue as a list to tick off.
			return (
				<div class="listening-workspace lw lw--strich">
					<section class="player" aria-labelledby="listen-title">
						<div class={p.stageClass}>
							{p.head}
							<div class="entry">
								{p.nowShelf}
								{p.progress}
								{p.signalBlock}
								{p.transport}
							</div>
							{p.savedNote}
						</div>
						{side}
					</section>
					<aside class="library library--tabs" aria-labelledby="stations-title">
						{p.libraryHead}
						{p.stationList}
					</aside>
					{p.queueSection}
					<div class="home-tail">
						{p.stationActions}
						{p.libraryLinks}
					</div>
				</div>
			);
		case "klassik":
			// Player: a full now-playing screen, the queue as a sheet underneath, the Sender as a
			// cover shelf; navigation sits in a tab bar.
			return (
				<div class="listening-workspace lw lw--klassik">
					<section class="player" aria-labelledby="listen-title">
						<div class={p.stageClass}>
							{p.head}
							{p.nowShelf}
							{p.progress}
							{p.signalBlock}
							{p.transport}
							{p.savedNote}
						</div>
						<div class="player-side">
							{p.notices}
							{p.devicePanel}
							{p.lateNotices}
						</div>
					</section>
					<div class="up-sheet">{p.queueSection}</div>
					<aside class="library library--covers" aria-labelledby="stations-title">
						{p.libraryHead}
						{p.stationList}
						{p.stationActions}
						{p.libraryLinks}
					</aside>
				</div>
			);
		case "umlauf":
			// Umlauf: the round is an orbit around the cover; every Sender is its own small orbit.
			return (
				<div class="listening-workspace lw lw--umlauf">
					<section class="player" aria-labelledby="listen-title">
						<div class={p.stageClass}>
							<div class="orbit">
								<OrbitRing progress={p.posterStation?.progress ?? null} />
								{p.art}
							</div>
							{p.head}
							{p.copy}
							{p.progress}
							{p.signalBlock}
							{p.transport}
							{p.savedNote}
						</div>
						{side}
					</section>
					<aside class="library library--orbits" aria-labelledby="stations-title">
						{p.libraryHead}
						{p.stationList}
					</aside>
					{p.queueSection}
					<div class="home-tail">
						{p.stationActions}
						{p.libraryLinks}
					</div>
				</div>
			);
		case "fahrmodus":
			// Fahrmodus: one glance, one thumb. The song in huge type, the keys as big tiles,
			// everything else below the fold.
			return (
				<div class="listening-workspace lw lw--fahrmodus">
					<section class="player" aria-labelledby="listen-title">
						<div class={p.stageClass}>
							{p.head}
							{p.nowShelf}
							{p.progress}
							{p.transport}
							{p.signalBlock}
							{p.savedNote}
						</div>
						{side}
					</section>
					<aside class="library library--chips" aria-labelledby="stations-title">
						{p.libraryHead}
						{p.stationList}
						{p.stationActions}
					</aside>
					{p.queueSection}
					<div class="home-tail">{p.libraryLinks}</div>
				</div>
			);
	}
}

/** A panel fixed under the thumb; the page keeps room for it at the bottom. */
function Dock(props: { ink: string; board?: boolean; children: ComponentChildren }) {
	return (
		<div class={`dock ${props.ink}${props.board ? " dock--board" : ""}`}>
			<div class="dock__inner">{props.children}</div>
		</div>
	);
}

/**
 * Fahrt: the last stops this listener actually heard, read from the stored
 * history (no Spotify request). Refreshed only when the saved occurrence
 * changes, never for a display-only estimate.
 */
function RidePast(props: { entry: string | null; trackId: string | null }) {
	const [items, setItems] = useState<HistoryEntry[] | null>(null);
	useEffect(() => {
		let alive = true;
		api
			.history()
			.then((list) => {
				if (alive) setItems(list);
			})
			.catch(() => {
				if (alive) setItems([]);
			});
		return () => {
			alive = false;
		};
	}, [props.entry]);
	const past = (items ?? []).filter((t) => t.id !== props.trackId).slice(0, 3);
	if (!past.length) return null;
	return (
		<ol class="ride-past" aria-label="Zuletzt gehört">
			{[...past].reverse().map((t) => (
				<li class="ride-past__stop" key={`${t.id}-${t.playedAt}`}>
					<span class="ride-past__song">{t.name}</span>
					<span class="ride-past__meta">
						{t.artists} · {clock(t.playedAt)}
						{t.ignored ? " · Gast" : ""}
					</span>
				</li>
			))}
		</ol>
	);
}

/**
 * Umlauf: the round as an orbit of ticks around the cover. Heard ticks are
 * floored from the real share, never rounded up; the numbers sit beside it.
 */
function OrbitRing(props: { progress: number | null }) {
	const n = 96;
	const p = Math.min(1, Math.max(0, props.progress ?? 0));
	const on = Math.floor(p * n);
	return (
		<svg class="orbit__ring" viewBox="0 0 200 200" aria-hidden="true" focusable="false">
			{Array.from({ length: n }, (_, i) => {
				const a = (i / n) * Math.PI * 2 - Math.PI / 2;
				const long = i % 8 === 0;
				const r1 = long ? 86 : 89;
				return (
					<line
						key={a}
						class={i < on ? "orbit__tick orbit__tick--on" : "orbit__tick"}
						x1={100 + Math.cos(a) * r1}
						y1={100 + Math.sin(a) * r1}
						x2={100 + Math.cos(a) * 97}
						y2={100 + Math.sin(a) * 97}
					/>
				);
			})}
			<circle
				class="orbit__now"
				cx={100 + Math.cos((on / n) * Math.PI * 2 - Math.PI / 2) * 92}
				cy={100 + Math.sin((on / n) * Math.PI * 2 - Math.PI / 2) * 92}
				r="5"
			/>
		</svg>
	);
}
