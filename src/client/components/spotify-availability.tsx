import type { SpotifyDiagnostics, SpotifyFunction } from "../api";
import { num } from "../format";

const functions: Array<[SpotifyFunction, string]> = [
	["devices", "Geräte"],
	["player", "Wiedergabestatus"],
	["history", "Spotify-Verlauf"],
];
const labels = {
	available: "Abfrage erfolgreich",
	held: "Abfrage zurückgestellt",
	failed: "Abfrage fehlgeschlagen",
	not_tested: "Nicht geprüft",
};

export function SpotifyFunctionStatus({
	diagnostics,
	onRetry,
	busy,
}: {
	diagnostics: SpotifyDiagnostics;
	onRetry: (scope: SpotifyFunction) => void;
	busy: boolean;
}) {
	const experiment = diagnostics.availability;
	const now = Date.now();
	const gates = {
		devices: diagnostics.devicesCooldown,
		player: diagnostics.playerCooldown,
		history: diagnostics.historyCooldown,
	};
	const history = diagnostics.recentRequests;
	const totals = { read: 0, write: 0, refresh: 0, blocked: 0, quota: 0 };
	for (const hour of history?.hours ?? [])
		for (const [key, count] of Object.entries(hour.counts)) {
			if (key.endsWith(":blocked")) totals.blocked += count;
			else {
				if (key.startsWith("read:")) totals.read += count;
				if (key.startsWith("write:")) totals.write += count;
				if (key.startsWith("refresh:")) totals.refresh += count;
				if (key.endsWith(":429:quota")) totals.quota += count;
			}
		}
	const first = history?.hours
		.filter((h) => h.firstQuotaAt != null)
		.sort((a, b) => a.firstQuotaAt! - b.firstQuotaAt!)[0];
	return (
		<>
			<h3>Welche Funktionen antworten?</h3>
			<p class="hint">
				Der Test prüft Geräte, Wiedergabestatus und Verlauf jeweils einmal. Er startet keine Musik.
				Er sichert eine alte lokale Quota-Sperre und lässt Katalogabfragen weiter warten. Neue
				allgemeine Sperren bleiben wirksam. Bekannte Wartefristen werden ausgelassen; Wiederholungen
				innerhalb einer Minute nutzen das gespeicherte Ergebnis.
			</p>
			{experiment ? (
				<>
					<p class="hint">
						Letzter Test: {new Date(experiment.testedAt).toLocaleString("de-DE")}. Erfolge gelten
						für diese Abfrage; spätere Freigaben sind damit nicht garantiert.
					</p>

					{experiment.stopped ? (
						<p class="note">
							Der Test wurde nach einer Fehlermeldung gestoppt. Weitere Abfragen wurden nicht
							gesendet. Die Einzelwerte zeigen den Grund.
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
				{functions.map(([key, name]) => {
					const outcome = experiment?.outcomes[key];
					const global = diagnostics.cooldown;
					const gate =
						global && (global.until === null || global.until > now) ? global : gates[key];
					const held = gate && (gate.until === null || gate.until > now);
					return (
						<li key={key} class="row">
							<span class="row__main">
								<span class="row__title">{name}</span>
								<span class="row__sub">
									{held ? "Abfrage zurückgestellt" : labels[outcome?.state ?? "not_tested"]}
									{!held && outcome?.status != null
										? outcome.status === 0
											? " · keine Antwort"
											: ` · ${outcome.status}`
										: ""}
									{(held ? gate.reason : outcome?.reason)
										? ` · ${held ? gate.reason : outcome?.reason}`
										: ""}
								</span>
								{held ? (
									<span class="row__sub">
										{gate.until === null
											? "Keine Freigabezeit von Spotify angegeben."
											: `Frühestens erneut: ${new Date(gate.until).toLocaleString("de-DE")}`}
									</span>
								) : null}
								{gates[key] ? (
									<button
										type="button"
										class="key"
										disabled={
											busy ||
											!!(
												diagnostics.cooldown &&
												(diagnostics.cooldown.until === null || diagnostics.cooldown.until > now)
											) ||
											(gates[key]!.until !== null && gates[key]!.until! > now)
										}
										onClick={() => onRetry(key)}
									>
										{name}-Freigabe prüfen
									</button>
								) : null}
							</span>
						</li>
					);
				})}
			</ul>
			{diagnostics.catalogQuarantine ? (
				<p class="hint">
					{diagnostics.catalogQuarantine.until === null || diagnostics.catalogQuarantine.until > now
						? "Die alte Sperre bleibt für ungetestete Katalog- und Steuerungsabfragen erhalten."
						: "Die gespeicherte Wartefrist für Katalog- und Steuerungsabfragen ist abgelaufen; eine Freigabe durch Spotify ist damit nicht garantiert."}{" "}
					{diagnostics.catalogQuarantine.until === null
						? "Spotify hat keine Freigabezeit angegeben."
						: `Gespeicherte Frist: ${new Date(diagnostics.catalogQuarantine.until).toLocaleString("de-DE")}.`}{" "}
					Gespeicherte Sender, Verlauf und Warteschlangen bleiben erhalten.
				</p>
			) : null}
			{history ? (
				<>
					<h3>Anfragen im Messzeitraum</h3>
					<p class="hint">
						Aufzeichnung seit {new Date(history.startedAt).toLocaleString("de-DE")}. Gespeichert
						werden bis zu 24 Stundenblöcke; das ist noch keine vollständige Tagesmessung.
					</p>
					<dl>
						<dt>An Spotify gesendete Leseversuche</dt>
						<dd>{num(totals.read)}</dd>
						<dt>Gesendete Schreibversuche</dt>
						<dd>{num(totals.write)}</dd>
						<dt>Token-Erneuerungen, separat</dt>
						<dd>{num(totals.refresh)}</dd>
						<dt>Echte Quota-Antworten</dt>
						<dd>{num(totals.quota)}</dd>
						<dt>Lokal zurückgehalten</dt>
						<dd>{num(totals.blocked)}</dd>
					</dl>
					{first ? (
						<p class="hint">
							Erste aufgezeichnete Quota-Antwort:{" "}
							{new Date(first.firstQuotaAt!).toLocaleString("de-DE")}
							{first.firstQuotaEndpoint ? ` · ${first.firstQuotaEndpoint}` : ""}. Das verbleibende
							Spotify-Budget und die Zuordnung gemeinsamer Kontingente sind unbekannt.
						</p>
					) : (
						<p class="hint">
							Im Messzeitraum wurde noch keine echte Quota-Antwort aufgezeichnet. Daraus lässt sich
							das verbleibende Budget nicht bestimmen.
						</p>
					)}
					<details>
						<summary>Stunden und Endpunkte anzeigen</summary>
						<pre class="diagnostic-data">{JSON.stringify(history.hours, null, 2)}</pre>
					</details>
				</>
			) : null}
		</>
	);
}
