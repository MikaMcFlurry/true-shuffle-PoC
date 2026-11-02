import { Copy } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import type { RemoteAction, RemoteKeyView } from "../../shared/api";
import { api } from "../api";
import { PageBar } from "../components/ui";
import { clock, day } from "../format";
import { store } from "../store";

const COMMANDS: { action: RemoteAction; name: string; what: string }[] = [
	{ action: "like", name: "Favorit", what: "Der laufende Song wird Favorit." },
	{
		action: "dislike",
		name: "Nie wieder",
		what: "Der laufende Song kommt nie wieder, Spotify springt weiter.",
	},
	{
		action: "skip",
		name: "Weiter",
		what: "Nächster Song. Auf einer Kassette zählt das vor 30 Sekunden als früh übersprungen.",
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
		store.say("Kopieren ging nicht. Markiere den Text und kopiere ihn von Hand.", "error", 6000);
	}
}

function CopyButton(props: { text: string; what: string }) {
	return (
		<button
			type="button"
			class="key copy-key"
			aria-label={`${props.what} kopieren`}
			onClick={() => void copy(props.text, props.what)}
		>
			<Copy size={18} aria-hidden="true" />
			Kopieren
		</button>
	);
}

export function RemoteScreen() {
	const [view, setView] = useState<RemoteKeyView | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [confirm, setConfirm] = useState<"new" | "drop" | null>(null);
	const [phone, setPhone] = useState<"ios" | "android">(() =>
		/android/i.test(navigator.userAgent) ? "android" : "ios",
	);
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
			<PageBar
				title="Fernbedienung"
				sub="Favorit, Nie wieder und Weiter per Siri, CarPlay, Apple Watch oder Android-Widget, ohne die App zu öffnen."
				backTo="/mehr"
			/>
			<p class="notice">
				Ganz ohne Einrichtung: Ein Herz in Spotify zählt schon als Favorit, auch in CarPlay, Android
				Auto und auf der Uhr. true-shuffle sieht es nach etwa zehn Minuten, solange Musik läuft.
			</p>

			<ol class="steps">
				<li class="step">
					<h2 class="step__title" id="remote-key">
						Schlüssel erstellen
					</h2>
					<p>
						Ein persönlicher Schlüssel, mit dem deine Kurzbefehle true-shuffle erreichen. Er kann
						nur die drei Befehle unten, sonst nichts.
					</p>
					{err ? (
						<p class="notice notice--error" role="alert">
							{err}
						</p>
					) : null}
					{view === null && !err ? <div class="skeleton" style={{ height: "52px" }} /> : null}
					{view && !key ? (
						<button
							type="button"
							class="key key--lit key--wide"
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
										onFocus={(e) => e.currentTarget.select()}
									/>
									<CopyButton text={`Bearer ${key}`} what="Schlüssel" />
								</div>
							</div>
							<p class="hint">
								{view?.createdAt ? `Erstellt ${stamp(view.createdAt)}. ` : ""}
								{view?.usedAt ? `Zuletzt benutzt ${stamp(view.usedAt)}.` : "Noch nie benutzt."}{" "}
								Gilt, bis du ihn löschst, einen neuen erstellst oder dich abmeldest. Gib ihn nicht
								weiter.
							</p>
							{confirm ? (
								<div class="notice notice--warn">
									<p>
										{confirm === "new"
											? "Neuen Schlüssel erstellen? Der alte geht sofort nicht mehr. Trag den neuen in deine Kurzbefehle ein."
											: "Schlüssel löschen? Deine Kurzbefehle gehen dann nicht mehr."}
									</p>
									<div class="row-actions">
										<button type="button" class="key" onClick={() => setConfirm(null)}>
											Abbrechen
										</button>
										<button
											type="button"
											class="key key--danger"
											disabled={busy}
											onClick={() =>
												confirm === "new"
													? run(api.newRemoteKey(), "Neuer Schlüssel. Der alte gilt nicht mehr.")
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
									<button type="button" class="key" onClick={() => setConfirm("new")}>
										Neuer Schlüssel
									</button>
									<button type="button" class="key" onClick={() => setConfirm("drop")}>
										Löschen
									</button>
								</div>
							)}
						</div>
					) : null}
				</li>

				<li class="step">
					<h2 class="step__title" id="remote-shortcut">
						Kurzbefehl anlegen
					</h2>
					<p>Einer pro Befehl. Jeder braucht die Adresse des Befehls und deinen Schlüssel.</p>
					<ul class="list">
						{COMMANDS.map((c) => (
							<li key={c.action} class="row remote-cmd">
								<span class="row__main">
									<span class="row__title">{c.name}</span>
									<span class="row__sub">{c.what}</span>
									<span class="remote-cmd__url code">
										POST <Url text={base + c.action} />
									</span>
								</span>
								<CopyButton text={base + c.action} what={`Adresse für „${c.name}“`} />
							</li>
						))}
					</ul>
					<fieldset class="segmented">
						<legend class="segmented__legend">Dein Handy</legend>
						<div class="segmented__row">
							{(
								[
									["ios", "iPhone"],
									["android", "Android"],
								] as const
							).map(([v, label]) => (
								<label key={v} class="segmented__opt">
									<input
										type="radio"
										name="remote-phone"
										checked={phone === v}
										onChange={() => setPhone(v)}
									/>
									<span>{label}</span>
								</label>
							))}
						</div>
					</fieldset>
					{phone === "ios" ? (
						<ol class="howto">
							<li>
								Öffne die App <b>Kurzbefehle</b> und tippe auf <b>+</b>. Der Name des Kurzbefehls
								ist später dein Siri-Befehl, etwa <b>Favorit</b>.
							</li>
							<li>
								Füge die Aktion <b>Inhalte von URL abrufen</b> hinzu und setze die kopierte Adresse
								von „Favorit“ ein.
							</li>
							<li>
								Tippe auf den Pfeil der Aktion: Methode <b>POST</b>, unter Header einen neuen
								Eintrag <b>Authorization</b> mit deinem kopierten Schlüssel als Wert.
							</li>
							<li>
								Füge <b>Text sprechen</b> hinzu. Dann sagt Siri dir, was passiert ist.
							</li>
							<li>Dasselbe für „Nie wieder“ und „Weiter“.</li>
						</ol>
					) : (
						<ol class="howto">
							<li>
								Installiere eine App, die Web-Anfragen als Knopf ablegt, etwa <b>HTTP Shortcuts</b>{" "}
								(kostenlos).
							</li>
							<li>
								Neuer Shortcut: Methode <b>POST</b>, als URL die kopierte Adresse, unter Header{" "}
								<b>Authorization</b> mit deinem kopierten Schlüssel als Wert.
							</li>
							<li>Lass die Antwort als kurze Meldung anzeigen.</li>
							<li>Leg die Shortcuts als Widget auf den Homescreen.</li>
						</ol>
					)}
				</li>

				<li class="step">
					<h2 class="step__title" id="remote-use">
						Benutzen
					</h2>
					{phone === "ios" ? (
						<p>
							Im Auto mit CarPlay: „Hey Siri, Favorit“, während Musik läuft. Auf der Apple Watch: in
							den Details des Kurzbefehls „Auf Apple Watch anzeigen“ einschalten, dann per Siri oder
							als Komplikation. Auf dem Homescreen: das Kurzbefehle-Widget.
						</p>
					) : (
						<p>
							Tipp aufs Widget, während Musik läuft. Android Auto lässt keine eigenen Knöpfe von
							Web-Apps zu: Nimm dort das Herz in Spotify, true-shuffle zählt es als Favorit.
						</p>
					)}
					<p class="hint">
						Die Antwort ist ein kurzer Satz zum Vorlesen, etwa dass der Song jetzt Favorit ist.
						Höchstens 20 Befehle in zehn Minuten. Ob es geklappt hat, siehst du oben bei „Zuletzt
						benutzt“.
					</p>
				</li>
			</ol>
		</div>
	);
}
