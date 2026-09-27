import { Cabinet, Dial, DialText } from "../components/radio";
import { DECK_PREFIX } from "../format";

const LOGIN_MESSAGES: Record<string, string> = {
	denied: "Anmeldung abgebrochen — tippe nochmal, wenn du magst.",
	expired: "Die Anmeldung hat zu lange gedauert. Bitte nochmal.",
	failed: "Spotify hat die Anmeldung nicht bestätigt. Bitte nochmal versuchen.",
	not_allowed:
		"Dieses Spotify-Konto ist für true-shuffle nicht freigeschaltet. Spotify erlaubt privaten Apps nur fünf Konten — frag den Besitzer der App.",
};

/** The radio, switched off: the dial says what it is, the one key switches it on. */
export function SignIn() {
	const params = new URLSearchParams(location.search);
	const login = params.get("login");
	const setup = params.get("setup");
	const message = setup
		? { text: `Noch nicht eingerichtet: ${setup}`, tone: "error" as const }
		: login
			? { text: LOGIN_MESSAGES[login] ?? LOGIN_MESSAGES.failed!, tone: "error" as const }
			: null;
	return (
		<div class="power">
			<Cabinet eye="off">
				<Dial label="Senderskala" at={null}>
					<DialText
						title="Deine Sender mit Gedächtnis"
						sub="Keine schnellen Wiederholungen. Alles kommt irgendwann dran."
						message={message}
					/>
				</Dial>
				<div class="card">
					<div class="card__paper">
						<p class="power__text">
							true-shuffle macht aus deinen Spotify-Playlists Sender, die sich jeden Song merken —
							auch über Tage, Geräte und alles, was du nebenbei hörst.
						</p>
					</div>
				</div>
				<div class="keys keys--one">
					<a class="pkey pkey--brass" href="/auth/login">
						Mit Spotify anmelden
					</a>
				</div>
			</Cabinet>
			<p class="power__fine">
				Braucht Spotify Premium. true-shuffle legt pro Sender eine private Playlist „{DECK_PREFIX}
				…“ in deinem Konto an.
			</p>
		</div>
	);
}
