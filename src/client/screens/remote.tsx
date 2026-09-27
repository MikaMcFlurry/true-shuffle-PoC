import { useEffect, useState } from "preact/hooks";
import type { RemoteAction, RemoteKeyView } from "../../shared/api";
import { api } from "../api";
import { PageBar, Section } from "../components/radio";
import { clock, day, SEP } from "../format";
import { store } from "../store";

const COMMANDS: { action: RemoteAction; name: string; what: string }[] = [
	{ action: "like", name: "Favorit", what: "Daumen hoch für den Song, der gerade läuft" },
	{ action: "dislike", name: "Nie wieder", what: "Daumen runter, und Spotify springt weiter" },
	{
		action: "skip",
		name: "Weiter",
		what: "Nächster Song. In einem Sender zählt das vor 30 Sekunden als früher Skip",
	},
];

/** An address breaks only after a slash, never inside a word. */
function Url({ text }: { text: string }) {
	const parts = text.split("/");
	return (
		<>
			{parts.map((p, i) => (
				<span key={i}>
					{p}
					{i < parts.length - 1 ? (
						<>
							/<wbr />
						</>
					) : null}
				</span>
			))}
		</>
	);
}

function stamp(at: number): string {
	return `${day(at)}, ${clock(at)}`;
}

async function copy(text: string, what: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		store.say(`${what} kopiert`, "info", 2500);
	} catch {
		store.say("Kopieren ging nicht — markiere den Text und kopiere ihn von Hand.", "error", 6000);
	}
}

function CopyButton(props: { text: string; what: string }) {
	return (
		<button
			type="button"
			class="key btn btn--small"
			aria-label={`${props.what} kopieren`}
			onClick={() => void copy(props.text, props.what)}
		>
			Kopieren
		</button>
	);
}

export function RemoteScreen() {
	const [view, setView] = useState<RemoteKeyView | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [confirm, setConfirm] = useState<"new" | "drop" | null>(null);
	useEffect(() => {
		api
			.remoteKey()
			.then(setView)
			.catch((e: Error) => setErr(e.message));
	}, []);
	const run = (p: Promise<RemoteKeyView>, done: string) => {
		setBusy(true);
		setConfirm(null);
		p.then((v) => {
			setView(v);
			store.say(done, "info", 3500);
		})
			.catch((e: Error) => store.say(e.message, "error"))
			.finally(() => setBusy(false));
	};
	const base = `${location.origin}/remote/`;
	const key = view?.key ?? null;

	return (
		<div class="page">
			<PageBar title="Fernbedienung" sub="Siri, CarPlay, Apple Watch, Widgets" backTo="/menu" />
			<p class="lede">
				Mit einem persönlichen Schlüssel sagst du true-shuffle per Kurzbefehl, was du vom laufenden
				Song hältst, ohne die App zu öffnen: mit Siri im Auto, auf der Apple Watch, über ein Widget
				auf dem Homescreen oder unter Android mit einer App wie „HTTP Shortcuts“.
			</p>
			<p class="note">
				Ein Herz in Spotify zählt schon von selbst als Favorit, auch in CarPlay, Android Auto und
				auf der Uhr. true-shuffle sieht es binnen etwa zehn Minuten, solange Musik läuft.
			</p>

			<Section title="Dein Schlüssel" id="remote-key">
				{err ? <p class="note note--error">{err}</p> : null}
				{view === null && !err ? <div class="skeleton" style={{ height: "52px" }} /> : null}
				{view && !key ? (
					<button
						type="button"
						class="key btn btn--wide"
						disabled={busy}
						onClick={() => run(api.newRemoteKey(), "Schlüssel erstellt")}
					>
						Schlüssel erstellen
					</button>
				) : null}
				{key ? (
					<div class="stack">
						<div class="field">
							<span class="field__label" id="remote-key-label">
								Wert für den Header „Authorization“
							</span>
							<div class="copyline">
								<input
									class="input input--code"
									readOnly
									value={`Bearer ${key}`}
									aria-label="Dein Schlüssel"
									aria-describedby="remote-key-label"
									onFocus={(e) => (e.target as HTMLInputElement).select()}
								/>
								<CopyButton text={`Bearer ${key}`} what="Schlüssel" />
							</div>
						</div>
						<p class="hint">
							{view?.createdAt ? `Erstellt: ${stamp(view.createdAt)}` : null}
							{SEP}
							{view?.usedAt ? `Zuletzt benutzt: ${stamp(view.usedAt)}` : "Noch nie benutzt"}
						</p>
						<p class="hint">
							Der Schlüssel kann nur die drei Befehle unten, sonst nichts. Er gilt, bis du ihn
							löschst, einen neuen erstellst oder dich abmeldest. Gib ihn nicht weiter.
						</p>
						{confirm ? (
							<div class="stack">
								<p class="note note--error">
									{confirm === "new"
										? "Neuen Schlüssel erstellen? Der alte hört sofort auf zu gehen; trag den neuen in deine Kurzbefehle ein."
										: "Schlüssel löschen? Deine Kurzbefehle gehen dann nicht mehr."}
								</p>
								<div class="row-actions">
									<button type="button" class="key btn" onClick={() => setConfirm(null)}>
										Abbrechen
									</button>
									<button
										type="button"
										class="key key--danger btn"
										disabled={busy}
										onClick={() =>
											confirm === "new"
												? run(api.newRemoteKey(), "Neuer Schlüssel — der alte gilt nicht mehr")
												: run(
														api.dropRemoteKey().then(() => ({
															key: null,
															createdAt: null,
															usedAt: null,
														})),
														"Schlüssel gelöscht",
													)
										}
									>
										{confirm === "new" ? "Neu erstellen" : "Löschen"}
									</button>
								</div>
							</div>
						) : (
							<div class="row-actions">
								<button type="button" class="key btn" onClick={() => setConfirm("new")}>
									Neuer Schlüssel
								</button>
								<button type="button" class="key btn" onClick={() => setConfirm("drop")}>
									Löschen
								</button>
							</div>
						)}
					</div>
				) : null}
			</Section>

			<Section title="Die Befehle" id="remote-commands">
				<ul class="list">
					{COMMANDS.map((c) => (
						<li key={c.action} class="row row--cmd">
							<span class="row__main">
								<span class="row__title">{c.name}</span>
								<span class="row__sub">{c.what}</span>
							</span>
							<CopyButton text={base + c.action} what={`Adresse für „${c.name}“`} />
							<span class="cmd__url code">
								POST <Url text={base + c.action} />
							</span>
						</li>
					))}
				</ul>
				<p class="hint">
					Jeder Befehl braucht den Header <span class="code">Authorization</span> mit deinem
					Schlüssel als Wert (er beginnt mit <span class="code">Bearer</span>). Die Antwort ist ein
					kurzer Satz zum Vorlesen, etwa dass der Song jetzt Favorit ist. Höchstens 20 Befehle in
					zehn Minuten.
				</p>
			</Section>

			<Section title="iPhone, CarPlay, Apple Watch" id="remote-ios">
				<ol class="steps">
					<li>
						Öffne die App <b>Kurzbefehle</b> und lege einen neuen Kurzbefehl an. Sein Name ist
						später der Siri-Befehl, etwa <b>Favorit</b>.
					</li>
					<li>
						Füge die Aktion <b>Inhalte von URL abrufen</b> hinzu. URL: die Adresse von „Favorit“
						oben. In den Optionen der Aktion: Methode <b>POST</b>, Header <b>Authorization</b> mit
						deinem kopierten Schlüssel als Wert.
					</li>
					<li>
						Füge <b>Text sprechen</b> mit den Inhalten der URL hinzu. Dann sagt Siri dir, was
						passiert ist.
					</li>
					<li>Genauso für „Nie wieder“ und „Weiter“.</li>
				</ol>
				<p class="hint">
					Im Auto mit CarPlay: „Hey Siri, Favorit“. Auf der Apple Watch: In den Details des
					Kurzbefehls die Anzeige auf der Apple Watch einschalten; dann startest du ihn dort per
					Siri, aus der Kurzbefehle-App oder als Komplikation. Auf dem Homescreen: das
					Kurzbefehle-Widget.
				</p>
			</Section>

			<Section title="Android" id="remote-android">
				<ol class="steps">
					<li>
						Installiere eine App, die Web-Anfragen als Knopf ablegt, etwa <b>HTTP Shortcuts</b>{" "}
						(kostenlos).
					</li>
					<li>
						Neuer Shortcut: Methode <b>POST</b>, URL die Adresse von oben, Header{" "}
						<b>Authorization</b> mit deinem kopierten Schlüssel als Wert. Die Antwort als kurze
						Meldung anzeigen lassen.
					</li>
					<li>Leg die Shortcuts als Widget auf den Homescreen.</li>
				</ol>
				<p class="hint">
					Android Auto lässt keine eigenen Knöpfe von Web-Apps zu. Zeigt Spotify im Auto oder auf
					einer Wear-OS-Uhr ein Herz oder Plus zum Speichern, nimm das: true-shuffle zählt es als
					Favorit.
				</p>
			</Section>
		</div>
	);
}
