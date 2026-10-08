import { Cassette } from "../components/cassette";
import { DECK_PREFIX } from "../format";

const LOGIN_MESSAGES: Record<string, string> = {
	denied: "Anmeldung abgebrochen. Tippe nochmal, wenn du magst.",
	expired: "Die Anmeldung hat zu lange gedauert. Bitte nochmal.",
	failed: "Spotify hat die Anmeldung nicht bestätigt. Bitte nochmal versuchen.",
	not_allowed:
		"Dieses Spotify-Konto ist für true-shuffle nicht freigeschaltet. Spotify erlaubt privaten Apps nur fünf Konten. Frag den Besitzer der App.",
};

/** Signed out: what this is in three lines, then one key that signs in. */
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
		<section class="signin" aria-labelledby="signin-title">
			<div class="signin__deck">
				<Cassette name="Deine Playlist" shell="orange" heard={null} />
			</div>
			<div class="signin__copy">
				<h1 id="signin-title" class="signin__title">
					Shuffle, das sich merkt, was du gehört hast
				</h1>
				<ul class="promise-list signin__points">
					<li>
						<strong>Jeder Song kommt dran.</strong> Erst wenn alle einmal liefen, geht es von vorn
						los.
					</li>
					<li>
						<strong>Keine schnellen Wiederholungen.</strong> Favoriten öfter, Neues dazwischen.
					</li>
					<li>
						<strong>Deine Stelle bleibt.</strong> Auch wenn du zwischendurch anderes hörst.
					</li>
				</ul>
				{message ? (
					<p class="notice notice--warn" role="status">
						{message}
					</p>
				) : null}
				<a class="key key--lit key--wide signin__go" href="/auth/login">
					Mit Spotify anmelden
				</a>
				<p class="hint">
					Braucht Spotify Premium. Spotify spielt die Musik; true-shuffle legt dafür pro Sender eine
					private Playlist „{DECK_PREFIX}…“ in deinem Konto an.
				</p>
			</div>
		</section>
	);
}
