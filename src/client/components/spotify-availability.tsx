import { useEffect, useState } from "preact/hooks";
import type { SpotifyUsageReport, SpotifyUsageTotals } from "../../shared/spotify-usage";
import {
	api,
	type SpotifyCooldownView,
	type SpotifyDiagnostics,
	type SpotifyFunction,
} from "../api";
import { num } from "../format";

const functions: Array<[SpotifyFunction, string, string]> = [
	["devices", "Geräte", "GET /me/player/devices"],
	["player", "Wiedergabestatus", "GET /me/player"],
	["history", "Spotify-Verlauf", "GET /me/player/recently-played"],
];
const labels = {
	available: "Abfrage erfolgreich",
	held: "Letzte Abfrage zurückgestellt",
	failed: "Abfrage fehlgeschlagen",
	not_tested: "Nicht geprüft",
};
function wait(seconds: number): string {
	const whole = Math.ceil(seconds);
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole % 3600) / 60);
	const remaining = whole % 60;
	return [
		hours ? `${hours} ${hours === 1 ? "Stunde" : "Stunden"}` : null,
		minutes ? `${minutes} ${minutes === 1 ? "Minute" : "Minuten"}` : null,
		remaining || whole === 0 ? `${remaining} ${remaining === 1 ? "Sekunde" : "Sekunden"}` : null,
	]
		.filter(Boolean)
		.join(", ");
}
export function ProviderWait({ gate }: { gate: SpotifyCooldownView }) {
	const seconds =
		gate.retryAfter !== null && /^\d+(?:\.\d+)?$/.test(gate.retryAfter)
			? Number(gate.retryAfter)
			: null;
	return (
		<dl class="diag-facts">
			<dt>Provider-Grund</dt>
			<dd>{gate.reason ?? "Kein Grund angegeben"}</dd>
			<dt>Von Spotify gemeldete Wartezeit</dt>
			<dd>
				{seconds !== null
					? `${wait(seconds)} (${num(seconds)} Sekunden)`
					: (gate.retryAfter ?? "Nicht von Spotify angegeben")}
			</dd>
			<dt>Gespeicherter Wert, kein Countdown</dt>
			<dd>Die gemeldete Wartezeit bleibt gleich. Maßgeblich ist die Frist unten.</dd>
			<dt>Früheste erneute Prüfung</dt>
			<dd>
				{gate.until === null
					? "Unbekannt · keine Reset-Zeit von Spotify angegeben"
					: `${new Date(gate.until).toLocaleString("de-DE")} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`}
			</dd>
		</dl>
	);
}

export function SpotifyFunctionStatus({
	diagnostics,
	onRetry,
	busy,
}: {
	diagnostics: SpotifyDiagnostics;
	onRetry: (scope: SpotifyFunction | "artist-albums") => void;
	busy: boolean;
}) {
	const experiment = diagnostics.availability;
	const gates = Object.fromEntries(
		(diagnostics.operationCooldowns ?? []).map((gate) => [gate.operation, gate]),
	);
	const now = Date.now();
	return (
		<>
			<h3 class="diag__h">Welche Funktionen antworten?</h3>
			<p class="hint">
				Der Test fragt Geräte, Wiedergabestatus und Verlauf jeweils einmal ab. Er startet keine
				Musik. Nur eine von Spotify bestätigte 429 hält dieselbe betroffene Operation zurück; aus
				einer Sperre wird keine Sperre anderer Funktionen abgeleitet. Wiederholungen innerhalb einer
				Minute nutzen das gespeicherte Testergebnis.
			</p>
			{experiment ? (
				<>
					<p class="hint">
						Letzter Test: {new Date(experiment.testedAt).toLocaleString("de-DE")}. Eine erfolgreiche
						Abfrage bestätigt diesen Versuch, keine dauerhafte Freigabe.
					</p>
					{experiment.stopped ? (
						<p class="note">
							Der Test wurde nach einer Fehlermeldung gestoppt. Weitere Abfragen wurden nicht
							gesendet.
						</p>
					) : null}
					<p class="hint">
						Starten, Pausieren und Übertragen wurden nicht geprüft. Eine erfolgreiche Statusabfrage
						bestätigt diese Steuerung nicht.
					</p>
				</>
			) : (
				<p class="hint">Noch kein gezielter Test gespeichert.</p>
			)}
			<ul class="list">
				{functions.map(([key, name, operation]) => {
					const gate = gates[operation];
					const outcome = experiment?.outcomes[key];
					const held = !!gate && (gate.until === null || gate.until > now);
					return (
						<li key={key} class="row">
							<span class="row__main">
								<span class="row__title">{name}</span>
								<span class="row__sub">
									{held
										? "Bestätigte 429 · diese Abfrage wartet"
										: labels[outcome?.state ?? "not_tested"]}
									{!held && outcome?.status != null
										? outcome.status === 0
											? " · keine Antwort"
											: ` · ${outcome.status}`
										: ""}
									{(held ? gate?.reason : outcome?.reason)
										? ` · ${held ? gate?.reason : outcome?.reason}`
										: ""}
								</span>
								{gate ? (
									<>
										<ProviderWait gate={gate} />
										<p class="hint">
											{gate.until !== null && gate.until <= now
												? "Die gespeicherte Wartefrist ist abgelaufen. Eine Freigabe durch Spotify ist damit nicht garantiert."
												: "Die Wartefrist betrifft nur diese bestätigte Operation."}
										</p>
										<button
											type="button"
											class="key"
											disabled={busy || (gate.until !== null && gate.until > now)}
											onClick={() => onRetry(key)}
										>
											{name}-Freigabe prüfen
										</button>
									</>
								) : null}
							</span>
						</li>
					);
				})}
			</ul>
			{Object.entries(gates)
				.filter(([operation]) => !functions.some(([, , known]) => known === operation))
				.map(([operation, gate]) => (
					<details class="more" key={operation}>
						<summary>Bestätigte 429: {operation}</summary>
						<ProviderWait gate={gate} />
						<p class="hint">
							Nur diese Operation wartet. Andere Funktionen werden daraus nicht als gesperrt
							behandelt.
						</p>
						{operation === "GET /artists/:id/albums" ? (
							<button
								type="button"
								class="key"
								disabled={busy || (gate.until !== null && gate.until > now)}
								onClick={() => onRetry("artist-albums")}
							>
								Künstleralben-Freigabe prüfen
							</button>
						) : null}
					</details>
				))}
			{!Object.keys(gates).length ? (
				<p class="hint">
					Keine bestätigte 429-Sperre gespeichert. Das verbleibende Spotify-Budget ist unbekannt.
				</p>
			) : null}
		</>
	);
}

function counted(value: number, singular: string, plural: string): string {
	return `${num(value)} ${value === 1 ? singular : plural}`;
}
function totalsText(t: SpotifyUsageTotals): string {
	return `${counted(t.read, "Leseversuch", "Leseversuche")} · ${counted(t.write, "Schreibversuch", "Schreibversuche")} · ${counted(t.refresh, "Token-Erneuerung", "Token-Erneuerungen")} · ${num(t.blocked)} lokal zurückgehalten · ${counted(t.quota + t.rate, "echte 429-Antwort", "echte 429-Antworten")} (${num(t.quota)} Quota, ${num(t.rate)} Rate) · ${num(t.network)} ohne Antwort`;
}

function date(at: number | null): string {
	return at === null ? "Nicht beobachtet" : new Date(at).toLocaleString("de-DE");
}
export function SpotifyUsageTracker({ report }: { report: SpotifyUsageReport }) {
	const boundary = Math.floor(report.generatedAt / 3600_000) - 23;
	const day: SpotifyUsageTotals = {
		sent: 0,
		read: 0,
		write: 0,
		refresh: 0,
		blocked: 0,
		quota: 0,
		rate: 0,
		network: 0,
	};
	for (const hour of report.hours.filter((h) => h.hour >= boundary))
		for (const key of Object.keys(day) as Array<keyof SpotifyUsageTotals>)
			day[key] += hour.totals[key];
	return (
		<section aria-labelledby="shared-usage-title" class="diag">
			<h3 class="diag__h" id="shared-usage-title">
				Gemeinsame Spotify-Nutzung
			</h3>
			<p class="hint">
				Alle App-Konten zusammen. {counted(report.observedListeners, "Konto", "Konten")} mit
				beobachteten Anfragen im gespeicherten Zeitraum;{" "}
				{counted(report.registeredListeners, "angemeldetes Konto", "angemeldete Konten")}. Bis zu{" "}
				{num(report.listenerCapacity)} Konten werden einzeln anonym angezeigt.
				{report.overflowObserved ? " Weitere beobachtete Konten sind zusammengefasst." : ""}
			</p>
			<p class="hint">
				Das verbleibende Spotify-Budget ist unbekannt. Andere Apps und deren Anfragen sind hier
				nicht sichtbar. Diese Anzeige erzeugt keine zusätzlichen Spotify-Anfragen.
			</p>
			<dl class="diag-facts">
				<dt>Letzte 24 Stundenblöcke</dt>
				<dd>{totalsText(day)}</dd>
				<dt>Gespeicherte 30-Tage-Beobachtung</dt>
				<dd>{totalsText(report.totals)}</dd>
			</dl>
			<p class="hint">
				{report.startedAt === null
					? "Noch keine Anfrageaufzeichnung."
					: `Aufzeichnung seit ${date(report.startedAt)}.`}{" "}
				Stand: {date(report.generatedAt)} ({Intl.DateTimeFormat().resolvedOptions().timeZone}). Bis
				zu {num(report.retentionHours)} Stundenblöcke bleiben gespeichert; ältere Daten fehlen.
				Begann die Aufzeichnung später, sind 24 Stunden und 30 Tage noch nicht vollständig
				abgedeckt. Lokal zurückgehaltene Versuche wurden nicht an Spotify gesendet. „Ohne Antwort“
				zählt gesendete Versuche, keine bestätigten Spotify-Antworten.
			</p>
			<details class="more">
				<summary>Operationen und anonyme Konten</summary>
				<h3 class="diag__h">Anfragen nach Operation</h3>
				{report.operations.length ? (
					<ul class="list">
						{report.operations.map((o) => (
							<li class="row" key={o.operation}>
								<span class="row__main">
									<span class="row__title">{o.operation}</span>
									<span class="row__sub">{totalsText(o.totals)}</span>
									<span class="row__sub">
										Antworten:{" "}
										{Object.entries(o.responses)
											.map(([status, count]) => `${status}: ${num(count)}`)
											.join(" · ") || "Keine Antwort aufgezeichnet"}
									</span>
								</span>
							</li>
						))}
					</ul>
				) : (
					<p class="hint">Noch keine Operationen aufgezeichnet.</p>
				)}
				<h3 class="diag__h">Anfragen je anonymem Konto</h3>
				{report.listeners.length ? (
					<ul class="list">
						{report.listeners.map((l) => (
							<li class="row" key={l.listener}>
								<span class="row__main">
									<span class="row__title">{l.listener}</span>
									<span class="row__sub">{totalsText(l.totals)}</span>
								</span>
							</li>
						))}
					</ul>
				) : (
					<p class="hint">Noch keine Konten mit Anfragen aufgezeichnet.</p>
				)}
			</details>
			<details class="more">
				<summary>Bestätigte 429 und beobachtete Erholung</summary>
				<p class="hint">
					Die Liste enthält nur gespeicherte Episoden; ältere Episoden können fehlen. Die erste
					erfolgreiche Antwort danach bestätigt die Erholung dieser Operation für dieses Konto bei
					diesem Versuch. Sie verrät nicht den genauen Reset-Zeitpunkt und bestätigt keine Freigabe
					anderer Operationen.
				</p>
				{report.episodes.length ? (
					report.episodes.map((e) => (
						<details class="more" key={e.id}>
							<summary>
								{e.listener} · {e.operation} ·{" "}
								{e.firstSuccessAt === null
									? "Noch kein anschließender Erfolg"
									: "Erfolg danach beobachtet"}
							</summary>
							<dl class="diag-facts">
								<dt>Erste bestätigte 429</dt>
								<dd>{date(e.firstFailureAt)}</dd>
								<dt>Letzte bestätigte 429</dt>
								<dd>{date(e.lastFailureAt)}</dd>
								<dt>Provider-Grund</dt>
								<dd>{e.reason ?? "Nicht angegeben"}</dd>
								<dt>Retry-After</dt>
								<dd>{e.retryAfter ?? "Nicht von Spotify angegeben"}</dd>
								<dt>Früheste erneute Prüfung</dt>
								<dd>
									{e.earliestRetryAt === null
										? "Unbekannt · keine Reset-Zeit von Spotify angegeben"
										: date(e.earliestRetryAt)}
								</dd>
								<dt>Letzter Anfrageversuch</dt>
								<dd>
									{date(e.lastAttemptAt)} ·{" "}
									{e.lastStatus === 0 ? "keine Antwort" : `HTTP ${e.lastStatus}`} ·{" "}
									{num(e.attempts)} Versuche
								</dd>
								<dt>Erster anschließender Erfolg</dt>
								<dd>{date(e.firstSuccessAt)}</dd>
							</dl>
						</details>
					))
				) : (
					<p class="hint">Noch keine bestätigte 429-Episode aufgezeichnet.</p>
				)}
			</details>
		</section>
	);
}

/**
 * Spotify's confirmed answers and the shared request record, folded away.
 * Nothing is loaded until it is opened; loading it sends nothing to Spotify.
 */
export function SpotifyStatus() {
	const [open, setOpen] = useState(false);
	return (
		<details class="more more--status" onToggle={(e) => setOpen(e.currentTarget.open)}>
			<summary class="more__summary">
				<span class="row__main">
					<span class="row__title">Spotify-Freigabe & Anfragestatus</span>
					<span class="row__sub">
						Nur nötig, wenn etwas nicht startet: was Spotify zuletzt geantwortet hat.
					</span>
				</span>
			</summary>
			{open ? <SpotifyStatusBody /> : null}
		</details>
	);
}

function SpotifyStatusBody() {
	const [testing, setTesting] = useState(false);
	const [diagnostics, setDiagnostics] = useState<SpotifyDiagnostics | null>(null);
	const [diagnosticError, setDiagnosticError] = useState("");
	const [usage, setUsage] = useState<SpotifyUsageReport | null>(null);
	const [usageError, setUsageError] = useState("");
	const load = async (): Promise<void> => {
		setDiagnosticError("");
		setUsageError("");
		await Promise.allSettled([
			api
				.spotifyUsage()
				.then(setUsage)
				.catch((e: Error) => setUsageError(e.message)),
			api
				.spotifyDiagnostics()
				.then(setDiagnostics)
				.catch((e: Error) => setDiagnosticError(e.message)),
		]);
	};
	// Load once when the panel opens.
	useEffect(() => {
		void load();
	}, []);
	return (
		<div class="more__body">
			<p>
				Hier siehst du bestätigte Antworten von Spotify. Eine 429 („zu viele Anfragen“) betrifft
				zunächst nur die Operation, für die Spotify sie tatsächlich gemeldet hat. Gespeicherter
				Verlauf und Warteschlangen bleiben erhalten.
			</p>
			{diagnostics ? (
				<>
					<SpotifyFunctionStatus
						diagnostics={diagnostics}
						busy={testing}
						onRetry={(scope) => {
							setTesting(true);
							setDiagnosticError("");
							void api
								.retrySpotify(scope)
								.then(load)
								.catch((e: Error) => setDiagnosticError(e.message))
								.finally(() => setTesting(false));
						}}
					/>
					<button
						type="button"
						class="key"
						disabled={testing}
						onClick={() => {
							setTesting(true);
							setDiagnosticError("");
							void api
								.testSpotifyAvailability()
								.then(load)
								.catch((e: Error) => setDiagnosticError(e.message))
								.finally(() => setTesting(false));
						}}
					>
						{testing ? "Funktionen werden geprüft …" : "Funktionen gezielt testen"}
					</button>
					<h3 class="diag__h">Gespeicherte Anfrageversuche pro Stunde</h3>
					<p class="hint">
						Einträge mit „blocked“ wurden lokal zurückgehalten und nicht an Spotify gesendet.
					</p>
					<pre class="diag-data">{JSON.stringify(diagnostics.requests?.counts ?? {}, null, 2)}</pre>
					<h3 class="diag__h">Letzter Anfrageversuch</h3>
					<pre class="diag-data">
						{JSON.stringify(diagnostics.requests?.latest ?? null, null, 2)}
					</pre>
				</>
			) : null}
			{usageError ? (
				<p class="note note--error" role="alert">
					Gemeinsame Nutzung nicht aktualisiert: {usageError}
					{usage ? " Der letzte erfolgreiche Stand bleibt sichtbar." : ""}
				</p>
			) : null}
			{usage ? (
				<SpotifyUsageTracker report={usage} />
			) : !usageError ? (
				<p class="hint" aria-busy="true">
					Gemeinsame Spotify-Nutzung wird geladen …
				</p>
			) : null}
			{diagnosticError ? <p class="note note--error">{diagnosticError}</p> : null}
			<div class="row-actions">
				<button type="button" class="key" onClick={() => void load()}>
					Status aktualisieren
				</button>
			</div>
		</div>
	);
}
