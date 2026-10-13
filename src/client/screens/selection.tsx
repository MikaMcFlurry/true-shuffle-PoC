/**
 * "Hörverlauf auswählen": which parts of the imported Spotify history shape
 * the memory. The listener looks through the import, drafts rules, sees what
 * the draft would count, and only then takes it over — a search, a sort or a
 * draft changes nothing (see core/import-selection). Switching the import off,
 * deleting it and counting songs across own playlists live here too.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { ruleKey } from "../../core/import-selection";
import type {
	HistorySelectionView,
	ImportSelection,
	InspectItem,
	InspectQuery,
	PlaylistCount,
	PlaylistCountsView,
	SelectionCounts,
	SelectionPreview,
	SelectionRule,
} from "../../shared/api";
import { ApiError, api } from "../api";
import { PageBar, Section } from "../components/ui";
import { num } from "../format";
import { store } from "../store";

const fullDate = new Intl.DateTimeFormat("de-DE", {
	day: "numeric",
	month: "long",
	year: "numeric",
});
const date = (at: number) => fullDate.format(at);
const dayWord = (d: string) => fullDate.format(Date.parse(`${d}T12:00:00Z`));

const ZONE = (() => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
})();

const PAGE = 50;

/** A rule in plain words. */
export function ruleText(r: SelectionRule): string {
	switch (r.type) {
		case "period":
			return `Zeitraum ${dayWord(r.from)} bis ${dayWord(r.to)} ausgeschlossen (ganze Tage, Zeitzone ${r.zone})`;
		case "artist":
			return r.kind === "exclude"
				? `Künstler „${r.name}“ ausgeschlossen`
				: `Künstler „${r.name}“ wieder einbezogen, auch in ausgeschlossenen Zeiträumen`;
		case "track":
			return r.kind === "exclude"
				? `Song ${r.label ? `„${r.label}“` : r.id} ausgeschlossen`
				: `Song ${r.label ? `„${r.label}“` : r.id} wieder einbezogen, auch wo Zeitraum oder Künstler ausgeschlossen sind`;
		case "summary":
			return "Songs ohne vollständige einzelne Wiedergaben (nur Summen oder teilweise gespeichert) ausgeschlossen";
	}
}

/** Why an entry counts or not, from the keys of the rules that decided its plays. */
function reasonText(keys: string[], rules: SelectionRule[]): string {
	const byKey = new Map(rules.map((r) => [ruleKey(r), r]));
	return keys
		.map((k) => byKey.get(k))
		.filter((r): r is SelectionRule => !!r)
		.map((r) =>
			r.type === "period"
				? `Zeitraum ${dayWord(r.from)}–${dayWord(r.to)}`
				: r.type === "artist"
					? `Künstler-Regel (${r.kind === "exclude" ? "aus" : "ein"})`
					: r.type === "track"
						? `Song-Regel (${r.kind === "exclude" ? "aus" : "ein"})`
						: "Nur-Summen-Regel",
		)
		.join(", ");
}

function plays(n: number): string {
	return n === 1 ? "1 Wiedergabe" : `${num(n)} Wiedergaben`;
}

export function playlistText(p: PlaylistCount | null | undefined): string | null {
	if (!p) return null;
	if (p.complete)
		return p.count === 0
			? "in keiner eigenen Playlist"
			: p.count === 1
				? "in 1 eigenen Playlist"
				: `in ${num(p.count)} eigenen Playlists`;
	return p.count === 0
		? "eigene Playlists: unbekannt"
		: `in mindestens ${num(p.count)} eigenen Playlist${p.count === 1 ? "" : "s"}`;
}

const STATUS_LABEL: Record<InspectItem["status"], string> = {
	included: "zählt",
	excluded: "ausgeschlossen",
	partial: "zählt teilweise",
	neutral: "ohne Wirkung",
};

function CountsLine({ c, label }: { c: SelectionCounts; label: string }) {
	if (!c.enabled)
		return (
			<p>
				<strong>{label}:</strong> Der Import ist ausgeschaltet — keine seiner {num(c.plays)}{" "}
				Wiedergaben zählt.
			</p>
		);
	return (
		<p>
			<strong>{label}:</strong> {num(c.includedPlays)} von {plays(c.plays)} zählen
			{c.skips > 0 ? `, ${num(c.includedSkips)} von ${num(c.skips)} frühen Skips` : ""}, aus{" "}
			{num(c.includedSongs)} von {num(c.songs)} Songs.
		</p>
	);
}

const draftKey = (d: ImportSelection, revision: number) =>
	`${revision}:${JSON.stringify(normal(d))}`;

const sameDraft = (a: ImportSelection, b: ImportSelection) =>
	JSON.stringify(normal(a)) === JSON.stringify(normal(b));
function normal(s: ImportSelection): ImportSelection {
	const m = new Map(s.rules.map((r) => [ruleKey(r), r]));
	return {
		enabled: s.enabled,
		rules: [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([, r]) => r),
	};
}

export function SelectionScreen() {
	const [view, setView] = useState<HistorySelectionView | null>(null);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [draft, setDraft] = useState<ImportSelection | null>(null);
	const [query, setQuery] = useState<Partial<InspectQuery>>({
		q: "",
		group: "track",
		status: "all",
		sort: "plays",
		offset: 0,
		limit: PAGE,
	});
	const [preview, setPreview] = useState<SelectionPreview | null>(null);
	const [previewErr, setPreviewErr] = useState<string | null>(null);
	// Which draft (and revision) the shown preview counted: only a successful
	// preview of exactly the current draft lets it be taken over.
	const [previewKey, setPreviewKey] = useState<string | null>(null);
	const [busy, setBusy] = useState<null | "apply" | "toggle" | "delete">(null);
	const [message, setMessage] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [periodFrom, setPeriodFrom] = useState("");
	const [periodTo, setPeriodTo] = useState("");
	// The newest look wins: an answer to an older one never replaces it.
	const seq = useRef(0);
	// The newest revision seen: an older answer never shows an older selection as in force.
	const newest = useRef(-1);

	const take = (v: HistorySelectionView, resetDraft: boolean) => {
		if (v.revision < newest.current) return;
		newest.current = v.revision;
		setView(v);
		if (resetDraft) setDraft(v.selection);
	};

	const load = (resetDraft: boolean) =>
		api
			.historySelection()
			.then((v) => {
				setLoadErr(null);
				take(v, resetDraft);
			})
			.catch((e: Error) => setLoadErr(e.message));

	useEffect(() => {
		void load(true);
	}, []);

	useEffect(() => {
		if (!draft) return;
		const mine = ++seq.current;
		const key = draftKey(draft, view?.revision ?? -1);
		const t = setTimeout(() => {
			api
				.previewSelection(draft, query)
				.then((p) => {
					if (mine !== seq.current) return;
					setPreview(p);
					setPreviewKey(key);
					setPreviewErr(null);
				})
				.catch((e: Error) => {
					if (mine !== seq.current) return;
					// The counts shown belong to another draft now: never offered as this one's.
					setPreviewKey(null);
					setPreviewErr(e.message);
				});
		}, 200);
		return () => clearTimeout(t);
	}, [draft, query, view?.revision]);

	if (loadErr && !view)
		return (
			<div class="page">
				<PageBar title="Hörverlauf auswählen" backTo="/mehr" />
				<p class="notice notice--error" role="alert">
					{loadErr}
				</p>
				<button type="button" class="key key--lit" onClick={() => void load(true)}>
					Nochmal versuchen
				</button>
			</div>
		);
	if (!view || !draft)
		return (
			<div class="page" aria-busy="true">
				<PageBar title="Hörverlauf auswählen" backTo="/mehr" />
				<div class="skeleton" />
			</div>
		);

	const applied = view.selection;
	const changed = !sameDraft(draft, applied);
	// The preview counted exactly this draft on this revision, and nothing failed since.
	const previewed = previewKey === draftKey(draft, view.revision) && !previewErr;
	const ds = view.dataset;
	const setRules = (rules: SelectionRule[]) => {
		setMessage(null);
		setDraft({ ...draft, rules });
	};
	const without = (key: string) => draft.rules.filter((r) => ruleKey(r) !== key);

	const apply = (next: ImportSelection, what: "apply" | "toggle") => {
		setBusy(what);
		setMessage(null);
		api
			.applySelection(view.revision, next)
			.then((v) => {
				take(v, false);
				setDraft(what === "toggle" ? { ...draft, enabled: v.selection.enabled } : v.selection);
				setMessage({
					text:
						v.effective.state === "failed"
							? `Gespeichert, aber nicht berechnet: ${v.effective.error ?? "unbekannter Fehler"}. Bis das klappt, zählt der Import nicht.`
							: !v.selection.enabled
								? "Import ausgeschaltet. Er bleibt gespeichert und zählt nicht, bis du ihn wieder einschaltest."
								: `Übernommen (Stand ${v.revision}). Neue Warteschlangen und Empfehlungen planen ab jetzt damit; eine gespeicherte Warteschlange behält ihre Reihenfolge.`,
					tone: v.effective.state === "failed" ? "error" : "ok",
				});
				void store.refresh(false);
			})
			.catch((e: Error) => {
				const conflict = e instanceof ApiError && e.status === 409;
				setMessage({
					text: conflict
						? `${e.message} Deine Änderungen hier bleiben als Entwurf stehen.`
						: `Nicht übernommen: ${e.message}`,
					tone: "error",
				});
				if (conflict) void load(false);
			})
			.finally(() => setBusy(null));
	};

	const remove = () => {
		setBusy("delete");
		setMessage(null);
		api
			.deleteImport(ds.key)
			.then((r) => {
				setConfirmDelete(false);
				setMessage({
					text: `Import gelöscht: ${num(r.deleted.songs)} Songs, ${plays(r.deleted.rows)}. Deine Live-Wiedergaben, Bewertungen, Herzen, Kassetten und die Warteschlange sind unverändert; deine Spotify-Dateien auch.`,
					tone: "ok",
				});
				void load(true);
				void store.refresh(false);
			})
			.catch((e: Error) => {
				setMessage({ text: `Nicht gelöscht: ${e.message}`, tone: "error" });
				void load(false);
			})
			.finally(() => setBusy(null));
	};

	const addPeriod = (e: Event) => {
		e.preventDefault();
		if (!periodFrom || !periodTo || periodFrom > periodTo) return;
		setRules([
			...draft.rules,
			{ type: "period", kind: "exclude", from: periodFrom, to: periodTo, zone: ZONE },
		]);
		setPeriodFrom("");
		setPeriodTo("");
	};

	/** The one switch for an entry: its own rule goes, or one is added against how it counts now. */
	const flip = (it: InspectItem) => {
		const group = preview?.query.group ?? "track";
		if (group === "track") {
			const key = `track:${it.key}`;
			if (draft.rules.some((r) => ruleKey(r) === key)) return setRules(without(key));
			setRules([
				...draft.rules,
				{
					type: "track",
					kind: it.status === "excluded" ? "include" : "exclude",
					id: it.key,
					label: it.name,
				},
			]);
		} else {
			if (!it.key) {
				const has = draft.rules.some((r) => r.type === "summary");
				return setRules(
					has ? without("summary") : [...draft.rules, { type: "summary", kind: "exclude" }],
				);
			}
			const key = `artist:${it.key}`;
			if (draft.rules.some((r) => ruleKey(r) === key)) return setRules(without(key));
			setRules([
				...draft.rules,
				{ type: "artist", kind: it.status === "excluded" ? "include" : "exclude", name: it.name },
			]);
		}
	};
	const ownRule = (it: InspectItem) => {
		const group = preview?.query.group ?? "track";
		const key = group === "track" ? `track:${it.key}` : it.key ? `artist:${it.key}` : "summary";
		return draft.rules.find((r) => ruleKey(r) === key) ?? null;
	};

	const page = preview?.page;
	const from = (query.offset ?? 0) + 1;
	const to = Math.min((query.offset ?? 0) + PAGE, page?.total ?? 0);
	const allMatches = preview?.page.matchIds ?? [];

	return (
		<div class="page selection">
			<PageBar
				title="Hörverlauf auswählen"
				sub="Welche Teile deines importierten Spotify-Verlaufs dein Hörprofil, die Analyse und neue Empfehlungen prägen."
				backTo="/mehr"
			/>

			<Section title="Dein Import" id="sel-import">
				{!ds.hasImport ? (
					<p class="notice">
						Kein Import gespeichert. <a href="/import">Spotify-Verlauf importieren</a>
						{applied.rules.length > 0
							? ` — deine ${num(applied.rules.length)} gespeicherten Regeln gelten dann für den neuen Import.`
							: ""}
					</p>
				) : (
					<div class="selection__facts">
						<p>
							{ds.coverage === "summary"
								? `${num(ds.songs)} Songs, nur als Summen gespeichert (älterer Import): Zeitraum und Künstler lassen sich darauf nicht anwenden. Für eine genaue Auswahl importiere die Dateien noch einmal.`
								: `${plays(ds.rows)} einzeln gespeichert${ds.rowsFrom && ds.rowsTo ? `, ${date(ds.rowsFrom)} bis ${date(ds.rowsTo)}` : ""}; ${num(ds.songs)} Songs mit Summen.`}
							{ds.coverage === "mixed"
								? ` ${num(view.counts?.summarySongs ?? 0)} Songs nur als Summe, ohne einzelne Wiedergaben.`
								: ""}
							{view.counts && view.counts.afterLiveRows > 0
								? ` ${plays(view.counts.afterLiveRows)} liegen ab dem Beginn der Live-Zählung${view.liveSince ? ` am ${date(view.liveSince)}` : ""}: aus dem Import zählen sie nicht. Für diese Zeit zählt nur, was true-shuffle selbst beobachtet hat — das muss nicht jede Wiedergabe sein.`
								: ""}
							{view.counts && view.counts.neutralRows > 0
								? ` ${plays(view.counts.neutralRows)} kürzer als 30 Sekunden ohne Skip (oder übersprungene erste Songs nach einem Start) sind gespeichert und sichtbar, zählen aber für nichts.`
								: ""}
						</p>
						{view.counts ? <CountsLine c={view.counts} label="Jetzt in Kraft" /> : null}
						<p class="hint">
							{view.revision === 0
								? "Bisher nie geändert: alles zählt."
								: `Stand ${view.revision}${view.appliedAt ? `, übernommen am ${date(view.appliedAt)}` : ""}.`}
							{view.uploading ? " Gerade läuft ein Upload eines neuen Imports." : ""}
						</p>
						{view.effective.state === "failed" ? (
							<p class="notice notice--error" role="alert">
								Die Auswahl ließ sich nicht berechnen ({view.effective.error}). Bis das klappt,
								zählt der Import gar nicht — nicht etwa vollständig.
							</p>
						) : null}
						<div class="row-actions">
							<button
								type="button"
								class="key"
								disabled={busy !== null}
								aria-busy={busy === "toggle"}
								onClick={() => apply({ enabled: !applied.enabled, rules: applied.rules }, "toggle")}
							>
								{busy === "toggle"
									? "Wird gespeichert …"
									: applied.enabled
										? "Import ausschalten"
										: "Import wieder einschalten"}
							</button>
						</div>
						<p class="hint">
							{applied.enabled
								? "Ausschalten setzt den Einfluss des Imports auf null. Daten und Regeln bleiben; Live-Wiedergaben, Bewertungen und Herzen zählen weiter."
								: "Ausgeschaltet: der Import zählt nicht. Einschalten verwendet deine gespeicherten Regeln wieder."}
						</p>
					</div>
				)}
			</Section>

			{ds.hasImport ? (
				<>
					<Section title="Regeln" id="sel-rules">
						<p class="section__lead">
							Es entscheidet die genaueste Regel: ein Song vor einem Künstler, ein Künstler vor
							einem Zeitraum. Ein Ausschluss nimmt nur den importierten Wiedergaben ihren Einfluss —
							der Song bleibt spielbar, deine Bewertungen und spätere Live-Wiedergaben zählen
							weiter.
						</p>
						<p class="hint">
							Favoriten: Daumen hoch und Spotify-Herzen bleiben immer Favoriten. Durch dein Hören
							wird ein Song Favorit, wenn du ihn mindestens fünfmal gehört und selten früh
							übersprungen hast — dafür zählen importierte Wiedergaben nur, soweit deine Auswahl sie
							berücksichtigt. Wie oft Favoriten kommen, regelt weiter der Mix jeder Kassette.
						</p>
						{draft.rules.length === 0 ? (
							<p class="muted">Keine Regeln: alles aus dem Import zählt.</p>
						) : (
							<ul class="list selection__rules">
								{draft.rules.map((r) => {
									const key = ruleKey(r);
									const fresh = !applied.rules.some((a) => ruleKey(a) === key);
									const eff = preview?.counts?.rules.find((x) => x.key === key);
									return (
										<li class="row" key={key}>
											<span class="row__main">
												<span class="row__title">{ruleText(r)}</span>
												<span class="row__sub">
													{eff
														? `${r.kind === "exclude" ? "Nimmt" : "Bringt zurück"}: ${plays(eff.plays)}${eff.skips ? `, ${num(eff.skips)} frühe Skips` : ""}, ${num(eff.songs)} Songs`
														: "Betrifft derzeit nichts"}
													{fresh ? " · neu, noch nicht übernommen" : ""}
												</span>
											</span>
											<button
												type="button"
												class="key selection__act"
												aria-label={`Regel entfernen: ${ruleText(r)}`}
												onClick={() => setRules(without(key))}
											>
												Entfernen
											</button>
										</li>
									);
								})}
							</ul>
						)}
						{applied.rules
							.filter((a) => !draft.rules.some((r) => ruleKey(r) === ruleKey(a)))
							.map((a) => (
								<p class="hint" key={ruleKey(a)}>
									Wird entfernt: {ruleText(a)}
								</p>
							))}
						<form class="selection__period" onSubmit={addPeriod}>
							<fieldset>
								<legend class="field__label">Zeitraum ausschließen</legend>
								<div class="selection__dates">
									<label class="field">
										<span>Von (einschließlich)</span>
										<input
											class="input"
											type="date"
											value={periodFrom}
											onInput={(e) => setPeriodFrom(e.currentTarget.value)}
										/>
									</label>
									<label class="field">
										<span>Bis (einschließlich)</span>
										<input
											class="input"
											type="date"
											value={periodTo}
											min={periodFrom || undefined}
											onInput={(e) => setPeriodTo(e.currentTarget.value)}
										/>
									</label>
								</div>
								<p class="hint">
									Ganze Kalendertage in deiner Zeitzone ({ZONE}). Maßgeblich ist, wann eine
									Wiedergabe laut Spotify endete.
								</p>
								<button
									type="submit"
									class="key selection__add"
									disabled={!periodFrom || !periodTo || periodFrom > periodTo}
								>
									Zeitraum hinzufügen
								</button>
							</fieldset>
						</form>
						{ds.coverage !== "events" || (view.counts?.partialSongs ?? 0) > 0 ? (
							<label class="row selection__check">
								<input
									type="checkbox"
									checked={draft.rules.some((r) => r.type === "summary")}
									onChange={(e) =>
										setRules(
											e.currentTarget.checked
												? [...draft.rules, { type: "summary", kind: "exclude" }]
												: without("summary"),
										)
									}
								/>
								<span>
									Songs ohne vollständige einzelne Wiedergaben ausschließen (
									{num((view.counts?.summarySongs ?? 0) + (view.counts?.partialSongs ?? 0))} Songs
									nur als Summe oder teilweise gespeichert)
								</span>
							</label>
						) : null}
					</Section>

					<Section title="Vorschau und übernehmen" id="sel-apply">
						<div class="notice" role="status" aria-live="polite">
							{previewed && preview?.counts ? (
								<CountsLine c={preview.counts} label="Mit deinem Entwurf" />
							) : previewErr ? (
								<p>Für deinen aktuellen Entwurf gibt es noch keine Vorschau.</p>
							) : (
								<p>Wird gezählt …</p>
							)}
							{view.counts ? <CountsLine c={view.counts} label="Jetzt in Kraft" /> : null}
							{previewed && preview?.counts && preview.counts.partialSongs > 0 ? (
								<p>
									{num(preview.counts.partialSongs)} Songs sind nur teilweise als einzelne
									Wiedergaben gespeichert ({plays(preview.counts.partialPlays)} insgesamt):
									Zeitraum- und Künstlerregeln erreichen sie nicht; sie zählen ganz oder gar nicht.
									Für eine genaue Auswahl importiere die Dateien noch einmal.
								</p>
							) : null}
							{previewed && preview?.counts && changed ? (
								<p>
									Ändert die Zahlen von {num(preview.counts.changedSongs)} Songs. Live gezählte
									Wiedergaben, Bewertungen, Herzen, Kassetten und die Warteschlange bleiben, wie sie
									sind.
								</p>
							) : null}
						</div>
						{previewErr ? (
							<p class="notice notice--error" role="alert">
								Vorschau nicht möglich: {previewErr}
							</p>
						) : null}
						<div class="row-actions">
							<button
								type="button"
								class="key"
								disabled={!changed || busy !== null}
								onClick={() => {
									setDraft(applied);
									setMessage(null);
								}}
							>
								Entwurf verwerfen
							</button>
							<button
								type="button"
								class="key key--lit"
								disabled={!changed || busy !== null || !previewed || !preview?.counts}
								aria-busy={busy === "apply"}
								onClick={() => apply(draft, "apply")}
							>
								{busy === "apply" ? "Wird berechnet …" : "Auswahl übernehmen"}
							</button>
						</div>
						{!changed ? <p class="hint">Der Entwurf entspricht dem, was gilt.</p> : null}
					</Section>
				</>
			) : null}

			{message ? (
				<p
					class={message.tone === "error" ? "notice notice--error" : "notice"}
					role={message.tone === "error" ? "alert" : "status"}
				>
					{message.text}
				</p>
			) : null}

			{ds.hasImport ? (
				<Section title="Durchsehen" id="sel-browse">
					<p class="section__lead">
						Suchen, sortieren und filtern ändert nichts. Ausschließen und Einbeziehen ändern nur den
						Entwurf oben, bis du ihn übernimmst.
					</p>
					<div class="selection__filters">
						<label class="field">
							<span class="field__label">Song, Künstler oder Album</span>
							<input
								type="search"
								value={query.q}
								onInput={(e) => setQuery({ ...query, q: e.currentTarget.value, offset: 0 })}
							/>
						</label>
						<label class="field">
							<span class="field__label">Gruppieren</span>
							<select
								value={query.group}
								onChange={(e) =>
									setQuery({
										...query,
										group: e.currentTarget.value as InspectQuery["group"],
										offset: 0,
									})
								}
							>
								<option value="track">Songs</option>
								<option value="artist">Künstler</option>
							</select>
						</label>
						<label class="field">
							<span class="field__label">Zeigen</span>
							<select
								value={query.status}
								onChange={(e) =>
									setQuery({
										...query,
										status: e.currentTarget.value as InspectQuery["status"],
										offset: 0,
									})
								}
							>
								<option value="all">Alle</option>
								<option value="included">Zählt</option>
								<option value="partial">Zählt teilweise</option>
								<option value="excluded">Ausgeschlossen</option>
								<option value="neutral">Ohne Wirkung</option>
							</select>
						</label>
						<label class="field">
							<span class="field__label">Sortieren</span>
							<select
								value={query.sort}
								onChange={(e) =>
									setQuery({
										...query,
										sort: e.currentTarget.value as InspectQuery["sort"],
										offset: 0,
									})
								}
							>
								<option value="plays">Meistgehört</option>
								<option value="recent">Zuletzt gehört</option>
								<option value="name">Name</option>
							</select>
						</label>
					</div>
					{page && !previewed ? (
						<p class="hint">Die Liste zeigt den Stand vor deiner letzten Änderung.</p>
					) : null}
					<p class="hint" role="status">
						{page
							? page.total === 0
								? "Nichts gefunden."
								: `${num(from)}–${num(to)} von ${num(page.total)}. Status nach deinem Entwurf.`
							: "Wird geladen …"}
					</p>
					{query.group === "track" && query.q && allMatches.length > 0 ? (
						<button
							type="button"
							class="key"
							onClick={() =>
								setRules([
									...draft.rules,
									...allMatches.map(
										(id) =>
											({
												type: "track",
												kind: "exclude",
												id,
												label: page?.items.find((x) => x.key === id)?.name,
											}) as SelectionRule,
									),
								])
							}
						>
							Alle {num(allMatches.length)} Treffer ausschließen
						</button>
					) : null}
					<ul class="list selection__items">
						{(page?.items ?? []).map((it) => {
							const own = ownRule(it);
							const pl = playlistText(it.playlists);
							return (
								<li class="row selection__item" key={it.key || "summary"}>
									<span class="row__main">
										<span class="row__title">{it.name}</span>
										<span class="row__sub">
											{[
												it.artist,
												query.group === "artist" && it.songs > 1 ? `${num(it.songs)} Songs` : null,
												it.summaryOnly ? "nur als Summe gespeichert" : null,
												it.partial
													? "nur teilweise einzeln gespeichert: zählt ganz oder gar nicht"
													: null,
												pl,
											]
												.filter(Boolean)
												.join(" · ")}
										</span>
										<span class="row__sub">
											<span class={`selection__status selection__status--${it.status}`}>
												{STATUS_LABEL[it.status]}
											</span>{" "}
											{num(it.includedPlays)} von {plays(it.plays)}
											{it.skips > 0 ? `, ${num(it.includedSkips)} von ${num(it.skips)} Skips` : ""}
											{it.neutral > 0 ? `, ${num(it.neutral)} ohne Wirkung` : ""}
											{it.afterLive > 0
												? `, ${num(it.afterLive)} ab Beginn der Live-Zählung (zählen nicht aus dem Import)`
												: ""}
											{it.lastAt ? ` · zuletzt ${date(it.lastAt)}` : ""}
											{it.rules.length > 0 ? ` · Regel: ${reasonText(it.rules, draft.rules)}` : ""}
										</span>
									</span>
									<button
										type="button"
										class="key selection__act"
										aria-label={`${own ? "Eigene Regel entfernen" : it.status === "excluded" ? "Wieder einbeziehen" : "Ausschließen"}: ${it.name}`}
										onClick={() => flip(it)}
									>
										{own
											? "Regel entfernen"
											: it.status === "excluded"
												? "Wieder einbeziehen"
												: "Ausschließen"}
									</button>
								</li>
							);
						})}
					</ul>
					{page && page.total > PAGE ? (
						<div class="row-actions">
							<button
								type="button"
								class="key"
								disabled={(query.offset ?? 0) === 0}
								onClick={() =>
									setQuery({ ...query, offset: Math.max(0, (query.offset ?? 0) - PAGE) })
								}
							>
								Zurück
							</button>
							<button
								type="button"
								class="key"
								disabled={to >= page.total}
								onClick={() => setQuery({ ...query, offset: (query.offset ?? 0) + PAGE })}
							>
								Weiter
							</button>
						</div>
					) : null}
				</Section>
			) : null}

			<PlaylistCountsSection />

			{ds.hasImport || ds.summaryProfile ? (
				<Section title="Import löschen" id="sel-delete">
					{!confirmDelete ? (
						<button
							type="button"
							class="key key--danger"
							disabled={busy !== null}
							aria-expanded={false}
							onClick={() => setConfirmDelete(true)}
						>
							Import löschen …
						</button>
					) : (
						<div class="notice notice--error" role="alert">
							<p>
								Gelöscht werden nur die in true-shuffle gespeicherten Importdaten: {num(ds.songs)}{" "}
								Songsummen
								{ds.rows > 0 ? `, ${plays(ds.rows)} einzeln` : ""}
								{ds.summaryProfile ? ", die ältere Hörprofil-Zusammenfassung" : ""} und alles, was
								daraus berechnet wurde. Das lässt sich nicht rückgängig machen — nur durch einen
								neuen Import deiner Dateien.
							</p>
							<p>
								Es bleiben: deine Spotify-Dateien, live gezählte Wiedergaben, Bewertungen, Herzen,
								Kassetten, Sperren, Gast-Regeln, die Warteschlange und deine{" "}
								{num(applied.rules.length)} Auswahlregeln (sie gelten für einen späteren Import).
							</p>
							<div class="row-actions">
								<button
									type="button"
									class="key"
									disabled={busy === "delete"}
									onClick={() => setConfirmDelete(false)}
								>
									Abbrechen
								</button>
								<button
									type="button"
									class="key key--danger"
									disabled={busy === "delete"}
									aria-busy={busy === "delete"}
									onClick={remove}
								>
									{busy === "delete" ? "Wird gelöscht …" : "Endgültig löschen"}
								</button>
							</div>
						</div>
					)}
				</Section>
			) : null}
		</div>
	);
}

function PlaylistCountsSection() {
	const [v, setV] = useState<PlaylistCountsView | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const load = () =>
		api
			.playlistCounts()
			.then((x) => {
				setV(x);
				setErr(null);
			})
			.catch((e: Error) => setErr(e.message));
	useEffect(() => {
		void load();
	}, []);
	useEffect(() => {
		if (v?.state !== "running") return;
		const t = setInterval(() => void load(), 5000);
		return () => clearInterval(t);
	}, [v?.state]);
	const start = () => {
		setBusy(true);
		api
			.countPlaylists()
			.then(setV)
			.catch((e: Error) => setErr(e.message))
			.finally(() => setBusy(false));
	};
	return (
		<Section title="In deinen Playlists" id="sel-playlists">
			<p class="section__lead">
				Für jeden Song: in wie vielen deiner eigenen Playlists er steht — jede Playlist zählt
				einmal. Playlists von true-shuffle und von anderen zählen nicht. Unabhängig von der Auswahl
				oben, und es ändert keine Gewichtung.
			</p>
			{err ? (
				<p class="notice notice--error" role="alert">
					{err}
				</p>
			) : null}
			{v ? (
				<div class="notice" role="status" aria-live="polite">
					<p>
						{v.state === "never"
							? "Noch nicht gezählt."
							: v.state === "running"
								? `Wird gezählt … ${num(v.playlists.read)} von ${num(v.playlists.own)} eigenen Playlists gelesen.`
								: v.state === "stopped"
									? `Abgebrochen nach ${num(v.playlists.read)} von ${num(v.playlists.own)} Playlists. Die Zahlen sind unvollständig.`
									: `${num(v.playlists.read)} von ${num(v.playlists.own)} eigenen Playlists gelesen, ${num(v.songs)} verschiedene Songs${v.finishedAt ? `, am ${date(v.finishedAt)}` : ""}.`}
						{v.state !== "never" && !v.complete
							? " Unvollständig: wo ein Song in keiner gelesenen Playlist steht, ist das unbekannt, nicht null."
							: ""}
					</p>
					{v.error ? <p>Spotify: {v.error}</p> : null}
					{v.listIncomplete ? (
						<p>
							Deine Playlist-Liste ließ sich dafür nicht neu lesen: eigene Playlists können fehlen.
						</p>
					) : null}
					{v.playlists.failed.length > 0 ? (
						<p>
							Nicht lesbar: {v.playlists.failed.map((f) => `„${f.name}“ (${f.reason})`).join(", ")}.
						</p>
					) : null}
					{v.playlists.unclear.length > 0 ? (
						<p>
							Nicht gezählt, Herkunft unklar (benannt wie true-shuffle, aber keine bekannte
							Kassette): {v.playlists.unclear.map((f) => `„${f.name}“`).join(", ")}. Deshalb gelten
							die Zahlen nur als „mindestens“.
						</p>
					) : null}
					{v.state !== "never" ? (
						<p class="hint">
							Nicht gezählt: {num(v.playlists.trueShuffle)} Playlists von true-shuffle,{" "}
							{num(v.playlists.foreign)} von anderen (gefolgt oder gemeinsam).
						</p>
					) : null}
				</div>
			) : null}
			<button
				type="button"
				class="key"
				disabled={busy || v?.state === "running"}
				aria-busy={busy}
				onClick={start}
			>
				{v?.state === "running" ? "Zählt …" : v?.state === "never" ? "Jetzt zählen" : "Neu zählen"}
			</button>
			<p class="hint">
				Liest deine Playlist-Liste und jede geänderte eigene Playlist bei Spotify — mit den üblichen
				Wartezeiten, wenn Spotify bremst.
			</p>
			{v && v.top.length > 0 ? (
				<ul class="list selection__items">
					{v.top.map((t) => (
						<li class="row" key={t.id}>
							<span class="row__main">
								<span class="row__title">{t.name}</span>
								<span class="row__sub">
									{t.artists} · {playlistText(t.playlists)}
								</span>
							</span>
						</li>
					))}
				</ul>
			) : null}
		</Section>
	);
}
