# ADR-005 — Ausführung messen statt annehmen: Kontext-Playlist, Modi, Beobachtung

Status: Angenommen · Datum: 2026-08-02 · Ergänzt und korrigiert ADR-002
(uris-Fenster) · Evidenzklasse: `OBSERVED_USER` (Live-Fehlerbericht) +
`VERIFIED_AUTOMATED` (Simulator/Suite) · Live-Bestätigung der neuen Wege:
**BLOCKED** (LT-15…LT-19)

## Kontext

ADR-002 hat das uris-Fenster gewählt und dabei sauber notiert, worauf es sich
stützt: **Annahmen AN-1…AN-7, keine davon live geprüft**, Live-Gate BLOCKED.
Der `ABSCHLUSSBERICHT` sagt denselben Satz noch deutlicher — „Der reale Player
wurde nie mit echten Credentials geprüft."

Der erste echte Betrieb hat zwei dieser Stellen widerlegt:

> „nach dem true-Shuffle den ersten Song gestartet hat bekommt true-Shuffle
> nicht mit wann der Song zu Ende ist und Spotify startet als nächsten Song
> einen unabhängigen. Wenn man danach in true-Shuffle die Fortsetzung des
> Hörvorgangs bestätigt startet true-Shuffle wieder den ersten Song."

Und:

> „wenn ein neuer Hörvorgang konfiguriert wird nimmt es nur 50 Songs aus der
> Playlist obwohl über 9000 vorhanden und importiert wurden."

### Was davon Spotify ist und was wir sind

Recherche gegen `developer.spotify.com` und die Spotify-Issue-Tracker
(Stand August 2026):

1. **Das `uris`-Array ist client-abhängig.** Gemeldet und nie widerlegt
   (`spotify/web-api#1437`, `spotify/web-playback-sdk#95`): Bei mehreren URIs
   spielt mindestens der Web-Player **nur die erste**, verwirft den Rest und
   füllt „Next up" mit eigenen Empfehlungen. Der dort genannte Workaround ist
   genau ADR-002s verworfene Alternative S4 — eine Playlist als `context_uri`.
   Ein Body-Limit ist nicht dokumentiert (~850 URIs → `413`).
2. **Shuffle und Repeat sind steuerbar** (`PUT /me/player/shuffle`,
   `PUT /me/player/repeat`), und `GET /me/player` liefert `shuffle_state`,
   `repeat_state` **und `context.uri`** zurück. true-shuffle hat davon nichts
   benutzt — weder gesetzt noch gelesen. Mit dem Shuffle des Dienstes an wird
   unsere berechnete Reihenfolge erneut zerlegt; auf Desktop und Handy ist das
   die naheliegendste Einzelursache dafür, dass nach *jedem* Titel etwas
   Ungeplantes kam. Der `LIVE_TEST_GUIDE` machte daraus eine **manuelle
   Vorbedingung** statt einer Zusicherung im Code.
3. **Smart Shuffle** erscheint als undokumentiertes Feld `smart_shuffle` in der
   Playback-State-Antwort und ist **per API nicht abschaltbar**; solange es an
   ist, bleibt `shuffle=false` wirkungslos, und Spotify mischt fremde
   Empfehlungen in die Wiedergabe.
4. **Spotify-Autoplay ist per API nicht abschaltbar** — Konto-Einstellung in
   der Desktop-/Mobile-App, im Web-Player nicht einmal dort.
5. **Es gibt keinen Webhook.** Polling von `GET /me/player` ist der einzige
   serverseitige Weg — und er **reicht**. Die Vermutung „Trackende ist über die
   API nicht erkennbar" ist falsch; der Fehler lag in der Klassifikation.

### Und was rein unser Fehler war

`core.engine.reconcile` kannte kein Muster für „unsere Karte ist zu Ende
gelaufen, jetzt läuft etwas Fremdes" und fiel auf `drifted`. Daraus machte die
F8-Maschine eine Manuell-Episode: kein Advance, keine Kommandos, nach
`manual_wait_seconds` PAUSED. Die gespielte Karte wurde **nie gebucht** —
und `runs.start` spielte `order[cursor]` mit der einzigen Schutzbedingung
`cursor >= total`. Daher „wieder der erste Song", beliebig oft.

Verstärkend: `window_anchor` war **prozesslokal**. Nach jedem Neustart war er
`None`, und damit waren beide AN-2-Muster in `reconcile` abgeschaltet.

## Entscheidung

**Die Ausführungsstrategie ist keine Annahme mehr, sondern eine Messung.**

1. **`app/execution.py`** kapselt drei Strategien hinter einem Interface —
   `execution_strategy` stand seit Schema v3 im `run_configs`-CHECK und wurde
   von keiner Zeile gelesen:
   - `uris_window` (Default, unverändert billig, **null Spuren im Konto**),
   - `context_playlist` (private Hilfs-Playlist als `context_uri`),
   - `no_prefetch` (Notmodus, ein Titel je Kommando; `single_uri` fällt
     dokumentiert darauf zusammen — kein vierter Codepfad).
2. **Herabstufen, nie hochstufen.** Zwei Auslöser:
   - eine Queue-Probe direkt nach dem ersten `play` (schwache Evidenz:
     `GET /me/player/queue` liefert ~20 Einträge und füllt bei kürzerer Queue
     auf — sie darf darum ausschließlich herabstufen);
   - das kostenlose, starke Signal `context_lost` aus `reconcile`.
   Ein Zurückstufen auf den billigen Weg gibt es nicht: ein falsches „sieht gut
   aus" würde exakt den Produktionsfehler wiederherstellen.
3. **Spotifys eigene Modi werden erzwungen**: `shuffle=false`, `repeat=off` vor
   jedem Override-Kommando und bei jedem Poll überwacht. Smart Shuffle wird
   **gemeldet**, nicht behauptet — die UI sagt, dass true-shuffle die
   Reihenfolge nicht garantieren kann, solange es an ist.
4. **Der Player-Zustand wird Zustand** (Migration M012): Fensteranker,
   *tatsächlich* gesetzte Kontextgröße, Kontext-URI, die Beobachtung der
   laufenden Karte (`observed_*`, `card_satisfied`) und die effektive Strategie
   stehen in der `runs`-Zeile. Neue Tabelle `run_contexts` für die
   Hilfs-Playlists, damit auch ein abgestürzter Prozess sie wiederfindet.
5. **`reconcile` bekommt den Fall, der gefehlt hat**: unsere Karte ist belegt zu
   Ende gelaufen und der Dienst spielt etwas, das wir ihm nie gegeben haben →
   `TRACK_ENDED` + `context_lost`. Karte verbraucht, nächste sofort gesetzt,
   **keine** F8-Episode. Ebenso: Stille nach belegtem Trackende, und ein
   Kontext, der unsere eigene Karte neu startet.
6. **ADR-003 F4 wird endlich implementiert** (`engine.is_played`):
   `played_threshold` in `on_track_end` / `on_min_seconds` / `on_start`, rein
   aus `progress_ms` — nie aus einer Uhr. Spotify-Policy II.2 verbietet
   künstliche Abspielzahlen; eine Karte, die sich per Timer weiterschaltet,
   wäre genau das.
7. **Fortsetzen verbraucht zuerst**: ist die Karte unter dem Cursor bereits
   erfüllt, wird sie gebucht, bevor irgendetwas startet; sonst wird an der
   beobachteten Position fortgesetzt (< 10 min alt, sonst von vorn).
8. **Der rollierende Horizont rollt** (Fehler 1): `_extend_plan` zieht den Plan
   nach, sobald der Cursor bis auf 20 Karten heran ist — begrenzt auf die
   **Fachgröße**. Ein Lauf ist ein Durchgang über das Fach: nicht 50 Titel,
   aber auch kein Endlosband. Die Oberfläche zeigt `deck_size`, nicht die
   Planlänge.

## Verglichene Alternativen

| Weg | Reihenfolge hält | Spuren im Konto | Lücke je Übergang | Autoplay-Risiko |
|---|---|---|---|---|
| **`uris_window`** (ADR-002-Default) | **client-abhängig** | keine | keine im Fenster | nur an der Fenstergrenze |
| **`context_playlist`** (neu, Fallback) | ja, auf jedem Client | **sichtbare private Playlist** | keine im Chunk | erst am Chunk-Ende |
| `no_prefetch` | ja | keine | ~1–2 s **je Titel** | **bei jedem Titel** |
| Web Playback SDK | ja, kein Autoplay | keine | keine | keins |

`no_prefetch` als Standard wurde verworfen: ein Kommando je Titel heißt eine
hörbare Lücke bei *jedem* Übergang (beobachten-dann-kommandieren ist
unvermeidbar, Timer sind nach Policy II.2 verboten), und in dieser Lücke
gewinnt Autoplay das Rennen — bei jedem Titel. Das ist schlechter als der
gemeldete Fehler, nicht besser. Er bleibt der ehrliche Notmodus.

Das **Web Playback SDK** bleibt verworfen, aus ADR-002s Gründen: es bindet die
Wiedergabe an einen offenen Browser-Tab und widerspricht damit UC-17 und dem
Versprechen „nichts muss offen bleiben". Neu ist nur, dass wir seinen Vorteil
jetzt benennen können — es kennt kein Autoplay.

## Konsequenzen

**Erkauft:** Der `PRODUCT.md`-Anspruch „keine Nebenwirkungen im Konto" gilt für
den Live-Modus auf Spotify nicht mehr uneingeschränkt. Sobald herabgestuft
wird, liegt eine private Playlist `true-shuffle · <Name>` im Konto des Hörers.
Sie wird beim Beenden, Abbrechen und harten Löschen entfernt, ein gestoppter
(fortsetzbarer) Lauf behält sie. Das steht in der UI, im README und in
PRODUCT.md — es wird nicht verschwiegen.

**Nicht erkauft:** Wer den billigen Weg behalten will, kann
`execution_strategy` auf `uris_window` festnageln (dann bleibt der Fehler auf
betroffenen Clients bestehen) oder `no_prefetch` wählen (keine Spuren, dafür
Lücken).

**Quota:** Pro 9 000-Titel-Lauf einmalig 1 create + ~90 add + 1 play + 1
unfollow ≈ 93 Requests. Das Polling desselben Laufs kostet auch nach der
Optimierung Zehntausende — die Schreibkosten sind ein Rundungsfehler. Der
Poll-Takt selbst ist der eigentliche Hebel und wurde repariert: `_next_delay`
hatte mit `min(base, …)` den eigenen Docstring invertiert (der Schlaf konnte
nie *länger* als 4 s werden, ~900 `GET /me/player` je Stunde und Lauf). Mit der
Obergrenze `WATCHER_MAX_POLL_SECONDS=30` sind es ~137/h bei **besserer**
Trackende-Auflösung (Aufwachen bei `remaining + 0,75 s`).

**Watcher-Lebenszyklus:** Ein ACTIVE-Lauf ohne Watcher ist ein Deck, das still
stehen geblieben ist. Watcher werden beim Prozessstart rehydriert und von einem
Supervisor (60 s) nachgezogen; ein Absturz schreibt `watcher_crashed` ins
Ledger, statt still zu enden.

## Was sich dadurch NICHT beheben lässt (ehrlich)

1. **Spotify-Autoplay** — Konto-Einstellung, nicht API-steuerbar. Endet unser
   Kontext wirklich, spielt Spotify eigene Empfehlungen, im Konto und im
   Hörverlauf des Nutzers. Milderung: den Kontext nie unbeabsichtigt enden
   lassen, und bei `completed` sofort pausieren (das fehlte).
2. **Smart Shuffle** — weder abschaltbar noch dokumentiert. Solange es an ist,
   ist die Reihenfolgegarantie nicht haltbar; true-shuffle kann es nur melden.
3. **Eine durch Kontotrennung verwaiste Hilfs-Playlist** — ist das Token weg,
   bevor das Aufräumen lief, können wir dem Nutzer nur noch sagen, welche
   Playlist er von Hand löschen muss.
4. **Development Mode** bleibt die Obergrenze: 5 Nutzer, Quota pro
   Entwicklerkonto, Extended Quota seit Mai 2025 nur für Organisationen ab
   250k MAU.
5. **Kommerzielle Nutzung** bleibt gesperrt (Streaming-SDA, Policy IV.2).

## Offener Live-Nachweis (BLOCKED)

LT-15…LT-19 im `LIVE_TEST_GUIDE.md`, plus die dortigen LT-13/LT-14 gegen den
neuen Weg. Bis dahin gilt für die Kern-Prämisse dieser ADR dasselbe wie für
ADR-002: sie ist **beobachtet und plausibel, aber nicht live falsifiziert** —
mit dem Unterschied, dass true-shuffle jetzt selbst misst und herabstuft,
statt zu glauben.

## Rollback

`execution_strategy` je Lauf auf `uris_window` setzen stellt das alte
Abspielverhalten her. `rollback_m012` (`app/migrations.py`) nimmt Spalten und
Tabelle zurück — kein Index, keine View, kein Fremdschlüssel hängt daran. Die
`reconcile`-Korrekturen und der rollierende Horizont sind davon unabhängig und
sollten **nicht** zurückgenommen werden: sie beheben Fehler, die keine Annahme
je gerechtfertigt hat.
