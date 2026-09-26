# ADR-006: Neustart auf Cloudflare. Die Playlist ist das Deck, das Gedächtnis ist global

Status: Angenommen · Datum: 2026-09-25 · Ersetzt ADR-002 und ADR-005 des Python-Prototyps (bis `db73bc5`)

## Kontext

Der Prototyp (Python auf Fly.io) steuerte Spotify über ein `uris`-Fenster und die Warteschlange. Im echten Betrieb ging das schief:

- Spotify spielte je nach Client nur die erste URI und füllte dann selbst auf.
- Das Ende eines Songs wurde verpasst.
- Nach einem Autostopp lief die Warteschlange rückwärts oder von vorn.
- Beim Neu-Mischen Tage später kam fast dieselbe Reihenfolge.

Der Besitzer will: Start drücken, und es läuft Musik, die er mag, mit viel Abwechslung. Sein Fortschritt darf nie verloren gehen. Irgendwann soll jeder Song drankommen, Favoriten gelegentlich, dazu Neues. Die Rangfolge (im Grilling bestätigt):

1. Fortschritt geht nie verloren.
2. Keine schnellen Wiederholungen.
3. Jeder Song irgendwann, lange nicht Gehörtes zuerst.
4. Favoriten öfter, mit einer Woche Abstand.
5. Neue Musik.

Hosting: kostenloser Cloudflare-Plan. Bis zu 5 Konten mit Spotify-Anmeldung.

## Entscheidung

### 1. Die Playlist ist das Deck

Jeder Sender ist eine private Spotify-Playlist „True Shuffle · <Sender>" mit bis zu 300 geplanten Songs. Gestartet wird sie mit `context_uri` und `offset`, Shuffle und Wiederholen sind aus. Spotify spielt sie dann selbst ab, auf jedem Gerät, auch offline im Auto und auch ohne True Shuffle. Eine Warteschlange muss niemand am Leben halten. Das behebt die Fehlerklasse des Prototyps an der Wurzel.

- **Neu geschrieben** wird ein Deck nur, wenn seit mindestens 10 Minuten niemand darin hört: Jemandem die laufende Playlist umzuschreiben ist genau der alte Fehler. Das „niemand hört" muss ein frischer Blick auf den Player belegen (höchstens 5 Minuten alt). Kann Spotify nichts sagen, wartet True Shuffle. Anlass ist ein verbrauchtes Deck, ein veraltetes (älter als 20 h) oder ein markiertes (neue Entdeckungen, Daumen runter, Regeländerung).
- **Im Hintergrund neu geschrieben, setzt ein Deck fort.** Wurde es in den letzten 12 Stunden benutzt, kann ein Player es noch geladen haben (Autostopp, Handy ohne Verbindung). Die neue Version beginnt dann mit den noch ungehörten Songs ab der letzten bekannten Position, in ihrer Reihenfolge. Dahinter folgt der neue Plan.
  - Setzt der Player die alte Reihenfolge fort, passt sie zur neuen.
  - Setzt er die neue ab der alten Position fort, passt es auch.
  - Startet jemand in Spotify von oben, kommt zuerst ein ungehörter Song.
- **Startet True Shuffle den Sender selbst,** plant es frisch und spielt von oben. Eine geänderte Mischung wirkt also beim nächsten Start aus der App.
- **Quell-Playlists, die in Spotify gelöscht wurden,** gelten als weg, nicht als „wird noch eingelesen". Das gilt erst, wenn sie in zwei vollständigen Abrufen der Playlist-Liste fehlen, denn eine einmal lückenhafte Antwort darf keinem Sender die Musik nehmen. Der Sender spielt mit den übrigen Quellen weiter, „Alles" wird nie blockiert, und die App sagt, welche Playlist fehlt. Der Sendersuchlauf holt die Liste frisch.
- **Angehängt** wird, wenn beim Hören weniger als 25 Songs vor der aktuellen Position übrig sind. Anhängen stört die laufende Wiedergabe nicht.
- **Schaltet jemand Spotifys Shuffle ein,** stellt True Shuffle ihn höchstens alle 10 Minuten wieder ab.

### 2. Das Gedächtnis ist global und liest alles mit

Pro Song werden gespeichert: letzte Wiedergabe, Anzahl Wiedergaben, frühe Skips, Herz in Spotify und Daumen. Quelle ist `recently-played` (≥30 s = gehört), egal wo gehört wurde. Wiedergaben, die dort verspätet auftauchen (offline gehört, später synchronisiert), zählen innerhalb von 24 Stunden nachträglich, und zwar genau einmal, aber nie aus der Zeit vor der ersten Anmeldung. Die deckt der Hörverlauf-Import ab. Er zählt seinerseits nur, was vor der ersten Anmeldung lief, damit nichts doppelt zählt. Fehlt Spotify der Kontext einer Wiedergabe, ordnet True Shuffle sie dem Sender zu, in dessen Deck der Song als Einziges stand.

Frühe Skips leitet True Shuffle vorsichtig aus der Player-Position ab. Die Regel lautet: lieber einen Skip verpassen als einen erfinden.

- Ein Song gilt als verlassen, wenn er als laufend gesehen wurde und danach ein anderer im selben Sender läuft.
- Taucht innerhalb von 20 Minuten keine Wiedergabe auf, ist er früh übersprungen.
- Lücken zwischen zwei Beobachtungen zählen nur in einem Deck, dessen Reihenfolge sicher ist. Das ist der Fall, wenn True Shuffle es selbst gestartet hat oder wenn es eine solche Version fortsetzt. Eine Version, die niemand von uns gestartet hat, beweist durch Positionen nichts.
- Ein Song, der im Sender läuft, aber nicht in der aktuellen Deck-Version steht, wird einzeln beobachtet.
- Stellt sich ein „Skip" doch als Wiedergabe heraus, wird er genau einmal und vollständig zurückgenommen: Zähler, Pause und Sperre. Das gilt auch, wenn die Wiedergabe erst nach der Wartezeit ankommt.
- Geprüft wird das gegen die Wahrheit des Simulators (`test/hub/skips-truth.test.ts`), mit folgendem Ergebnis:
  - null erfundene Skips bei normalem Hören, nach Autostopp und nach langem Halt ohne sichtbaren Player,
  - mindestens 90 % beziehungsweise 80 % der echten Skips erkannt.

Der Gast-Modus blendet Zeiträume aus. Der Hörverlauf-Import (Spotify-Datenexport) liefert die Vorgeschichte.

### 3. Der Planer

Jeder Sender hat Runden. Gewichtetes Mischen (Efraimidis–Spirakis) über drei Spuren:

- **ungehört in dieser Runde**, lange nicht Gehörtes zuerst, gewichtet nach Geschmack,
- **Favoriten** mit Abstand (Standard: 7 Tage),
- **Entdeckungen**.

Die Anteile kommen vom Regler „Entdecken ↔ Vertraut" (Standard Entdecker: 60 / 10 / 30). Dazu gilt Künstlerabstand, eine 24-Stunden-Sperre für kürzlich Gehörtes und „nicht jetzt" nach einem frühen Skip. Wenn die Runde leer ist, beginnt die nächste automatisch.

### 4. Ein Durable Object pro Hörer

`UserHub` hält den ganzen Zustand eines Kontos in seiner eigenen SQLite-Datenbank. Dazu gehören Bibliothek, Gedächtnis, Sender, Decks, Jobs und Entdeckungen. Alle Operationen laufen in diesem einen Objekt hintereinander (Mutex über I/O-Grenzen). So können sich der Sync im Hintergrund und ein Tipp in der App nicht in die Quere kommen.

Das Objekt weckt sich selbst per Alarm:

- alle 3 Minuten, solange ein Deck spielt,
- alle 10 Minuten bei anderer Wiedergabe,
- alle 20 Minuten im Leerlauf,
- stündlich nach 6 Stunden Stille.

Ein Cron-Trigger (alle 20 Minuten) belebt verlorene Alarmketten über die `Registry` wieder.

### 5. Innerhalb des kostenlosen Plans bleiben

- Höchstens 40 externe Anfragen pro Aufruf (die Grenze liegt bei 50). Größere Arbeiten sind Jobs, die über mehrere Aufrufe fortschreiten: Import, Deck schreiben, Entdecken.
- Bibliothek in Seiten zu 50 Songs, Hörverlauf in Seiten zu 500. Im Sync-Pfad gibt es nur Punktabfragen und indizierte Abfragen, damit die Zeilenkontingente (Lesen/Schreiben pro Tag) auch bei 10.000er-Playlists reichen.
- Einzelne Wiedergaben werden nach 180 Tagen gelöscht, höchstens 500 pro Tag. Das Gedächtnis behält die Summen.
- Für einen Neuaufbau wird nur das Gedächtnis der Songs des Senders gelesen, nicht das ganze. Die Playlist-Liste schreibt nur geänderte Zeilen.
- Höchstens **30 Sender** pro Konto.
- Gemessen (`test/hub/budget.test.ts`, mit einem Durable Object, das nach einer Minute Ruhe alles vergisst), für einen Hörer-Tag mit 10.000 Songs, einem Jahr Verlauf und einer Stunde offener App:

  | Konto | gelesene Zeilen | geschriebene Zeilen | 5 solche Konten vom Tageskontingent |
  |---|---|---|---|
  | typisch: 9 Sender, 15.000 Songs im Gedächtnis | ~110.000 | ~2.300 | ~11 % / ~12 % |
  | an der Grenze: 30 Sender, 25.000 Songs, 300 gefolgte Playlists | ~253.000 | ~3.100 | ~25 % / ~16 % |
- Statische Dateien gehen nie über den Worker, nur `/api/*` und `/auth/*`.

### 6. Entdeckungen werden verifiziert

Quellen sind Deep Cuts und Neuerscheinungen geliebter Künstler, Last.fm, Deezer, Genre-Suche und KI:

- Claude Sonnet 5, wenn ein Schlüssel hinterlegt ist, sonst Workers AI.
- Jeder Vorschlag wird auf Spotify gesucht. Nur echte Treffer kommen in den Sender.
- Wer eine Entdeckung zweimal hört oder mit Daumen hoch markiert, findet sie in „True Shuffle · Entdeckungen". Ein früher Skip oder Daumen runter sortiert sie aus.

### 7. Sicherheit

- Anmeldung per Authorization Code + PKCE, ohne Client-Secret.
- Refresh-Token AES-GCM-verschlüsselt, Sitzungs-Cookie HMAC-signiert, beide Schlüssel per HKDF aus `APP_SECRET`.
- Das Cookie trägt eine Anmelde-Generation. Abmelden erhöht sie im Hub und beendet damit alle bisher ausgegebenen Sitzungen dieses Kontos, auch kopierte Cookies. Sie beginnt zufällig, damit nach dem Löschen und Neuanlegen eines Kontos kein altes Cookie wieder passt.
- Jede Änderung braucht den Header `x-ts: 1` (CSRF).
- Optionale Allowlist `ALLOWED_SPOTIFY_IDS`.
- CSP ohne Inline-Skripte.

## Verworfene Alternativen

- **Warteschlange/`uris` (Prototyp):** nachweislich client-abhängig und bricht bei Gerätewechsel und Autostopp.
- **Vercel + externe Datenbank:** Hintergrund-Sync bräuchte Cron plus Datenbank plus Sperren. Das Durable Object liefert alle drei in einem, kostenlos.
- **Eine globale D1-Datenbank:** Sperren und Alarme pro Hörer müssten nachgebaut werden, und die Kontingente teilten sich alle Konten.
- **Deck bei jeder Änderung sofort umschreiben:** würde laufende Wiedergabe stören, also genau den alten Fehler wiederholen.

## Konsequenzen und bekannte Grenzen

- **Premium ist Pflicht** für das Starten und Steuern. Das ist eine Vorgabe von Spotify.
- **`recently-played` liefert nur die letzten 50 Songs.** Wer sehr lange ohne Verbindung hört (mehr als 50 Songs zwischen zwei Syncs), verliert die ältesten aus dem Gedächtnis. True Shuffle schreibt dann einen Hinweis ins Log.
- **Frühe Skips, die niemand gesehen hat,** bleiben in einem Deck, das True Shuffle nicht selbst gestartet oder fortgesetzt hat (etwa nach über 12 Stunden Pause), unerkannt. Das ist bewusst so: Ein verpasster Skip lässt einen Song höchstens etwas früher wiederkommen. Ein erfundener würde einen nie gehörten Song verdrängen.
- **Der Spotify-Entwicklungsmodus erlaubt höchstens 5 Konten** und hat ein knappes Anfragekontingent. Bei „Kontingent aufgebraucht" pausiert True Shuffle für die gemeldete Zeit und macht dann weiter (getestet).
- **Die Reihenfolge in einem laufenden Deck steht fest.** Regeländerungen wirken ab dem nächsten Neuschreiben, also sobald 10 Minuten niemand hört.
- **Nachweis:** Unit-, Eigenschafts-, Szenario- und End-to-End-Tests gegen eine Spotify-Attrappe mit Player-Simulation. Der Live-Nachweis mit echtem Spotify steht aus ([LIVE_TEST.md](../LIVE_TEST.md)).
