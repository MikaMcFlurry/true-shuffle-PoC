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

/** A draft as counted on one revision of one stored import. */
const draftKey = (d: ImportSelection, revision: number, dataset: string) =>
	`${revision}:${dataset}:${JSON.stringify(normal(d))}`;

/** What the list shows: one search, grouping, filter, order and page of one stored import. */
const listKey = (q: Partial<InspectQuery>, dataset: string) =>
	JSON.stringify([q.q ?? "", q.group, q.status, q.sort, q.offset ?? 0, dataset]);

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
	// Which draft (on which revision and import) the shown preview counted: only
	// a successful preview of exactly the current draft lets it be taken over.
	const [previewKey, setPreviewKey] = useState<string | null>(null);
	// Which list the shown rows belong to: a row or "all matches" acts only on
	// the search, grouping and import it was found in.
	const [previewList, setPreviewList] = useState<string | null>(null);
	// Counts every edit of the draft: an answer to taking over an older draft
	// never replaces edits made while it was on its way.
	const draftGen = useRef(0);
	const [busy, setBusy] = useState<null | "apply" | "toggle" | "delete">(null);
	const [message, setMessage] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [periodFrom, setPeriodFrom] = useState("");
	const [periodTo, setPeriodTo] = useState("");
	// The newest look wins: an answer to an older one never replaces it.
	const seq = useRef(0);
	// Which of two answers holds the later stored state is told by the server's
	// commit number (it counts up with every stored change of the import or the
	// selection, also a new import or a deletion, which keep the revision) — not
	// by the order they were sent or arrive in: a read sent later can be answered
	// before a change sent earlier is stored. A view is shown only if it holds a
	// later stored state than the one shown; of two answers on the same state the
	// one sent later wins (they differ at most in an upload under way). An answer
	// not used changes nothing: not the view, the draft, the message or what is busy.
	// Every request gets the next number when it is sent.
	const life = useRef(0);
	// The number of the newest request whose view was shown.
	const accepted = useRef(0);
	// And a view never goes back to an older revision than one already shown.
	const newest = useRef(-1);
	// The view shown, readable at once by answers arriving later.
	const shown = useRef<HistorySelectionView | null>(null);
	// The view shown stands in for a deleted import until a load tells what is stored.
	const standIn = useRef(false);
	const show = (v: HistorySelectionView, isStandIn = false) => {
		shown.current = v;
		standIn.current = isStandIn;
		setView(v);
	};
	// Failures are ordered by themselves: the failure of a load is shown only if
	// it was sent after every request answered so far and after the failure
	// shown (an older failure never replaces a newer one or a newer answer).
	const answered = useRef(0);
	const failed = useRef(0);
	const succeeded = (n: number) => {
		if (n > answered.current) answered.current = n;
		// A failure of a load sent before this answer no longer describes the page.
		if (n > failed.current) setLoadErr(null);
	};
	// One change at a time (taking over, switching, deleting), checked at once
	// — also against quick double taps — and released only by its own request.
	const inFlight = useRef<number | null>(null);
	const begin = (what: "apply" | "toggle" | "delete") => {
		if (inFlight.current !== null) return null;
		const n = ++life.current;
		inFlight.current = n;
		setBusy(what);
		return n;
	};
	const end = (n: number) => {
		if (inFlight.current !== n) return;
		inFlight.current = null;
		setBusy(null);
	};

	const take = (v: HistorySelectionView, resetDraft: boolean, n: number) => {
		const cur = shown.current;
		if (v.revision < newest.current) return false;
		if (cur && v.commit < cur.commit) return false;
		if (cur && v.commit === cur.commit && n <= accepted.current && !standIn.current) return false;
		if (n > accepted.current) accepted.current = n;
		newest.current = v.revision;
		show(v);
		if (resetDraft) setDraft(v.selection);
		return true;
	};

	const load = (resetDraft: boolean) => {
		const n = ++life.current;
		return api
			.historySelection()
			.then((v) => {
				take(v, resetDraft, n);
				succeeded(n);
			})
			.catch((e: Error) => {
				if (n <= answered.current || n <= failed.current) return;
				failed.current = n;
				setLoadErr(e.message);
			});
	};

	useEffect(() => {
		void load(true);
	}, []);

	useEffect(() => {
		if (!draft || !view) return;
		const mine = ++seq.current;
		const dataset = view.dataset.key;
		const key = draftKey(draft, view.revision, dataset);
		const list = listKey(query, dataset);
		const t = setTimeout(() => {
			api
				.previewSelection(draft, query)
				.then((p) => {
					if (mine !== seq.current) return;
					setPreview(p);
					// Counted on another import than the page knows (replaced meanwhile):
					// neither the counts nor the rows are this page's; it learns the new one.
					if (p.dataset !== dataset) {
						setPreviewKey(null);
						setPreviewList(null);
						void load(false);
						return;
					}
					setPreviewKey(key);
					setPreviewList(list);
					setPreviewErr(null);
				})
				.catch((e: Error) => {
					if (mine !== seq.current) return;
					// The counts and rows shown belong to another draft or search now:
					// never offered as this one's.
					setPreviewKey(null);
					setPreviewList(null);
					setPreviewErr(e.message);
				});
		}, 200);
		return () => clearTimeout(t);
	}, [draft, query, view?.revision, view?.dataset.key]);

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
	const ds = view.dataset;
	// The preview counted exactly this draft on this revision of this import, and nothing failed since.
	const previewed = previewKey === draftKey(draft, view.revision, ds.key) && !previewErr;
	// The rows shown were found by exactly this search, counted under exactly this
	// draft and revision of this import: only then can they (or all matches) be acted on.
	// Rows waiting for a new count are locked; edits already made are never lost.
	const rowsLive = previewList === listKey(query, ds.key) && previewed;
	const pending = busy === "apply" || busy === "toggle";
	/** Every edit of the draft goes through here (see draftGen). */
	const editDraft = (next: ImportSelection) => {
		draftGen.current++;
		if (!pending) setMessage(null);
		setDraft(next);
	};
	const setRules = (rules: SelectionRule[]) => editDraft({ ...draft, rules });
	const without = (key: string) => draft.rules.filter((r) => ruleKey(r) !== key);

	const apply = (next: ImportSelection, what: "apply" | "toggle") => {
		const n = begin(what);
		if (n === null) return;
		setMessage(null);
		const sentGen = draftGen.current;
		// Taking over names the import its preview counted; switching on or off the one the page shows.
		const dataset = what === "apply" ? (preview?.dataset ?? ds.key) : ds.key;
		api
			.applySelection(view.revision, next, dataset)
			.then((v) => {
				// A change stored after this one is shown already (another tab, a
				// deletion): this answer shows and claims nothing.
				const cur = shown.current;
				if (cur && v.commit < cur.commit) return;
				// Shown unless a read after this change shows the same stored state already.
				take(v, false, n);
				succeeded(n);
				// Edits made while this was on its way stay the draft; only an untouched
				// draft becomes what is now in force.
				const newer = draftGen.current !== sentGen;
				if (what === "toggle") setDraft((d) => (d ? { ...d, enabled: v.selection.enabled } : d));
				else if (!newer) setDraft(v.selection);
				const later = newer
					? " Deine Änderungen von danach sind noch nicht übernommen — sie stehen als Entwurf bereit."
					: "";
				setMessage({
					text:
						v.effective.state === "failed"
							? `Gespeichert, aber nicht berechnet: ${v.effective.error ?? "unbekannter Fehler"}. Bis das klappt, zählt der Import nicht.${later}`
							: !v.selection.enabled
								? `Import ausgeschaltet. Er bleibt gespeichert und zählt nicht, bis du ihn wieder einschaltest.${later}`
								: `Übernommen (Stand ${v.revision}). Neue Warteschlangen und Empfehlungen planen ab jetzt damit; eine gespeicherte Warteschlange behält ihre Reihenfolge.${later}`,
					tone: v.effective.state === "failed" ? "error" : "ok",
				});
				void store.refresh(false);
			})
			.catch((e: Error) => {
				if (n <= accepted.current) return;
				const conflict = e instanceof ApiError && e.status === 409;
				setMessage({
					text: conflict
						? `${e.message} Deine Änderungen hier bleiben als Entwurf stehen.`
						: `Nicht übernommen: ${e.message}`,
					tone: "error",
				});
				// The page learns the current revision and import; the draft is counted again on them.
				if (conflict) {
					setPreviewKey(null);
					void load(false);
				}
			})
			.finally(() => end(n));
	};

	const remove = () => {
		const n = begin("delete");
		if (n === null) return;
		setMessage(null);
		api
			.deleteImport(ds.key)
			.then((r) => {
				// The import named was deleted (the server checked it was the stored
				// one). A change stored after the deletion is shown already (a new
				// import): this answer shows and claims nothing.
				const cur = shown.current;
				if (cur && r.commit < cur.commit) return;
				succeeded(n);
				// A view from before the deletion is out of date, whichever request it
				// came from: until the page has loaded what is stored now, nothing of
				// the deleted import is shown as current or can be acted on. (A key no
				// answer has keeps every count and row of it out.) A read from after
				// the deletion may show it already.
				if (cur && r.commit > cur.commit)
					show(
						{
							...cur,
							commit: r.commit,
							counts: null,
							dataset: {
								...cur.dataset,
								key: `deleted:${n}`,
								hasImport: false,
								summaryProfile: false,
								songs: 0,
								rows: 0,
								rowsFrom: null,
								rowsTo: null,
								coverage: "none",
							},
						},
						true,
					);
				setPreviewKey(null);
				setPreviewList(null);
				setConfirmDelete(false);
				setMessage({
					text: `Import gelöscht: ${num(r.deleted.songs)} Songs, ${plays(r.deleted.rows)}. Deine Live-Wiedergaben, Bewertungen, Herzen, Kassetten und die Warteschlange sind unverändert; deine Spotify-Dateien auch.`,
					tone: "ok",
				});
				// The draft stays as it is (its rules apply to a later import).
				void load(false);
				void store.refresh(false);
			})
			.catch((e: Error) => {
				if (n <= accepted.current) return;
				setMessage({ text: `Nicht gelöscht: ${e.message}`, tone: "error" });
				void load(false);
			})
			.finally(() => end(n));
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
		if (!rowsLive) return;
		const group = query.group ?? "track";
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
		const group = query.group ?? "track";
		const key = group === "track" ? `track:${it.key}` : it.key ? `artist:${it.key}` : "summary";
		return draft.rules.find((r) => ruleKey(r) === key) ?? null;
	};

	const page = preview?.page;
	const from = (query.offset ?? 0) + 1;
	const to = Math.min((query.offset ?? 0) + PAGE, page?.total ?? 0);
	const allMatches = rowsLive ? (preview?.page.matchIds ?? []) : [];

	return (
		<div class="page selection">
			<PageBar
				title="Hörverlauf auswählen"
				sub="Welche Teile deines importierten Spotify-Verlaufs dein Hörprofil, die Analyse und neue Empfehlungen prägen."
				backTo="/mehr"
			/>

			{loadErr ? (
				<div class="notice notice--error" role="alert">
					<p>Der aktuelle Stand ließ sich nicht laden: {loadErr} Dein Entwurf bleibt erhalten.</p>
					<button type="button" class="key" onClick={() => void load(false)}>
						Neu laden
					</button>
				</div>
			) : null}

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
								onClick={() => editDraft(applied)}
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
						{pending ? (
							<p class="hint" role="status">
								{busy === "toggle" ? "Wird umgeschaltet …" : "Wird übernommen …"} Was du jetzt
								änderst, bleibt als Entwurf erhalten.
							</p>
						) : !changed ? (
							<p class="hint">Der Entwurf entspricht dem, was gilt.</p>
						) : null}
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
					{page && !rowsLive ? (
						<p class="hint" role="status">
							Die Liste wird für deine Suche und deinen Entwurf aktualisiert — bis dahin lassen sich
							Einträge nicht ausschließen oder einbeziehen. Deine Änderungen bleiben erhalten.
						</p>
					) : null}
					<p class="hint" role="status">
						{page
							? page.total === 0
								? "Nichts gefunden."
								: `${num(from)}–${num(to)} von ${num(page.total)}. Status nach deinem Entwurf.`
							: "Wird geladen …"}
					</p>
					{rowsLive && query.group === "track" && query.q && allMatches.length > 0 ? (
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
										disabled={!rowsLive}
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
									disabled={busy !== null}
									aria-busy={busy === "delete"}
									onClick={remove}
								>
									{busy === "delete" ? "Wird gelöscht …" : "Endgültig löschen"}
								</button>
							</div>
							{busy === "apply" || busy === "toggle" ? (
								<p class="hint" role="status">
									Löschen geht, sobald {busy === "toggle" ? "das Umschalten" : "die Übernahme"}{" "}
									abgeschlossen ist.
								</p>
							) : null}
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
