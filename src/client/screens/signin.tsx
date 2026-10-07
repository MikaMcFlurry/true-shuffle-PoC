import { BrandMark } from "../components/brand";
import { DECK_PREFIX } from "../format";

const LOGIN_MESSAGES: Record<string, string> = {
	denied: "Anmeldung abgebrochen — tippe nochmal, wenn du magst.",
	expired: "Die Anmeldung hat zu lange gedauert. Bitte nochmal.",
	failed: "Spotify hat die Anmeldung nicht bestätigt. Bitte nochmal versuchen.",
	not_allowed:
		"Dieses Spotify-Konto ist für true-shuffle nicht freigeschaltet. Spotify erlaubt privaten Apps nur fünf Konten — frag den Besitzer der App.",
};

/** Signed out: the stage says what this is; one key signs in. */
export function SignIn() {
	const params = new URLSearchParams(location.search);
	const login = params.get("login");
	const setup = params.get("setup");
	const message = setup
		? `Noch nicht eingerichtet: ${setup}`
		: login
			? (LOGIN_MESSAGES[login] ?? LOGIN_MESSAGES.failed)
			: null;
	return (
		<div class="welcome">
			<section class="stage stage--welcome ink-ultra" aria-labelledby="welcome-title">
				<BrandMark class="welcome__figure" />
				<h1 id="welcome-title">Deine Sender mit Gedächtnis</h1>
				<p class="welcome__lede">Keine schnellen Wiederholungen. Alles kommt irgendwann dran.</p>
				{message ? (
					<p class="welcome__msg" role="status">
						{message}
					</p>
				) : null}
				<a class="key key--stage" href="/auth/login">
					Mit Spotify anmelden
				</a>
			</section>
			<div class="welcome__copy">
				<p>
					true-shuffle macht aus deinen Spotify-Playlists Sender, die sich jeden Song merken — auch
					über Tage, Geräte und alles, was du nebenbei hörst.
				</p>
				<p class="hint">
					Braucht Spotify Premium. true-shuffle legt pro Sender eine private Playlist „{DECK_PREFIX}
					…“ in deinem Konto an.
				</p>
			</div>
		</div>
	);
}
