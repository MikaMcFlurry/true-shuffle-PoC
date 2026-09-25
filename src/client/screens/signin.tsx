import { Display } from "../components/radio";
import { DECK_PREFIX } from "../format";

const LOGIN_MESSAGES: Record<string, string> = {
	denied: "Anmeldung abgebrochen — tippe nochmal, wenn du magst.",
	expired: "Die Anmeldung hat zu lange gedauert. Bitte nochmal.",
	failed: "Spotify hat die Anmeldung nicht bestätigt. Bitte nochmal versuchen.",
	not_allowed:
		"Dieses Spotify-Konto ist für True Shuffle nicht freigeschaltet. Spotify erlaubt privaten Apps nur fünf Konten — frag den Besitzer der App.",
};

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
			<div class="main">
				<Display
					lit={[]}
					name="TRUE SHUFFLE"
					song="Deine Sender mit Gedächtnis"
					artist="Keine schnellen Wiederholungen. Alles kommt irgendwann dran."
					message={message}
					scale={{ pos: 0, label: "" }}
					wrap
				/>
				<p class="power__text">
					True Shuffle macht aus deinen Spotify-Playlists Sender, die sich jeden Song merken — auch
					über Tage, Geräte und alles, was du nebenbei hörst.
				</p>
				<a class="key key--lit btn btn--wide" href="/auth/login">
					Mit Spotify anmelden
				</a>
				<p class="power__fine">
					Braucht Spotify Premium. True Shuffle legt pro Sender eine private Playlist „{DECK_PREFIX}
					…“ in deinem Konto an.
				</p>
			</div>
		</div>
	);
}
