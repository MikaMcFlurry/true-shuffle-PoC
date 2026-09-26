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
- **Hält ein Player die Playlist noch (pausiert, etwa beim Autostopp, oder zuletzt darin und gerade unsichtbar), setzt ein Hintergrund-Neuschreiben sie fort** (`continueLayout` in `src/core/deck.ts`). Die Songs nach der gehaltenen Stelle bleiben genau an ihren Plätzen. Dadurch spielt ein Player dasselbe, egal ob er nach Position weitermacht oder die geladene Reihenfolge fortsetzt.
  - Ein Song darunter, der inzwischen woanders lief, abgelehnt oder gesperrt wurde, macht an seinem Platz einem neuen Song Platz. Gibt es keinen, fällt er heraus. Ein Player, der an der gehaltenen Stelle weitermacht, trifft dann einfach den nächsten.
  - Der pausierte Song selbst fällt aus der Version heraus. An seine Stelle kommt ein neuer Song, denn wer nach Position weitermacht, spielt diese Stelle zuerst.
  - Davor stehen neue Songs, damit ein Neustart von oben in Spotify nichts wiederholt. Neu heißt: nicht gehört, nicht kürzlich übersprungen, und nichts, was der Player in dieser Version schon erreicht hat.
  - **Kleine Sender** (die Playlist enthält schon fast alles): Reichen die neuen Songs nicht, wandern die letzten der behaltenen Songs nach vorn, höchstens die Hälfte. Reicht auch das nicht, bleiben vorn die alten Songs stehen. Dann würde nur ein Neustart von oben etwas wiederholen, und wer dort weitermacht, wo er aufgehört hat, behält jeden Song vor sich. Sind neue Songs knapp, kommen zuerst bis zu 25 hinter die gehaltene Stelle. Die Playlist schrumpft nie auf wenige Songs, und kein Song steht zweimal darin, sonst wären die Positionen mehrdeutig.
  - Lässt sich die gehaltene Version nicht verbessern, bleibt sie, wie sie ist, und True Shuffle schaut stündlich wieder nach.
- **Daumen runter** heißt nie wieder. Taucht ein abgelehnter Song trotzdem in einem Sender auf, etwa aus einer Reihenfolge, die ein Player noch geladen hat, springt True Shuffle nach wenigen Sekunden weiter. Das gilt auch bei geschlossener App, weil True Shuffle direkt nach jedem Songende nachsieht.
- **Startet True Shuffle den Sender selbst,** plant es frisch und spielt von oben. Geänderte Einstellungen (Mischung, Regeln) gelten ab diesem Start, und bei jedem Neuschreiben, während kein Player die Playlist hält.
- **Quell-Playlists, die in Spotify gelöscht wurden,** gelten als weg, nicht als „wird noch eingelesen". Das gilt erst, wenn sie in zwei vollständigen Abrufen der Playlist-Liste fehlen, denn eine einmal lückenhafte Antwort darf keinem Sender die Musik nehmen. Der Sender spielt mit den übrigen Quellen weiter, „Alles" wird nie blockiert, und die App sagt, welche Playlist fehlt. Der Sendersuchlauf holt die Liste frisch.
- **Angehängt** wird, wenn beim Hören weniger als 25 Songs vor der aktuellen Position übrig sind. Anhängen stört die laufende Wiedergabe nicht.
- **Schaltet jemand Spotifys Shuffle ein,** stellt True Shuffle ihn höchstens alle 10 Minuten wieder ab.

### 2. Das Gedächtnis ist global und liest alles mit

Pro Song werden gespeichert: letzte Wiedergabe, Anzahl Wiedergaben, frühe Skips, Herz in Spotify und Daumen. Quelle ist `recently-played` (≥30 s = gehört), egal wo gehört wurde. Wiedergaben, die dort verspätet auftauchen (offline gehört, später synchronisiert), zählen innerhalb von 24 Stunden nachträglich, und zwar genau einmal, aber nie aus der Zeit vor der ersten Anmeldung. Die deckt der Hörverlauf-Import ab. Er zählt seinerseits nur, was vor der ersten Anmeldung lief, damit nichts doppelt zählt. Fehlt Spotify der Kontext einer Wiedergabe, ordnet True Shuffle sie dem Sender zu, in dessen Deck der Song als Einziges stand.

Frühe Skips leitet True Shuffle vorsichtig aus der Player-Position ab. Die Regel lautet: lieber einen Skip verpassen als einen erfinden.

- True Shuffle sieht direkt nach jedem Songende nach. So wird fast jeder Song in seinen ersten Sekunden gesehen.
- Ein Song gilt als verlassen, wenn er zuletzt **laufend** gesehen wurde und danach ein anderer im selben Sender läuft. Ein pausierter Song, den Spotify später durch einen anderen ersetzt, wurde nicht übersprungen.
- Taucht innerhalb von 20 Minuten keine Wiedergabe auf, ist er früh übersprungen.
- Lücken zwischen zwei Beobachtungen zählen nur in einem Deck, dessen Reihenfolge sicher ist. Das ist der Fall, wenn True Shuffle es selbst gestartet hat oder wenn es eine solche Version an Ort und Stelle fortsetzt. Solche nur erschlossenen Skips wirken lediglich weich („nicht jetzt, seltener"). Sperren (Regel „ban") und Verbrauchen der Runde (Regel „consume", eigenes Feld `consumed_at`) gibt es nur für einen Song, der tatsächlich laufend gesehen und verlassen wurde. Daumen hoch hebt eine Sperre auf allen Sendern auf.
- Ein Song, der im Sender läuft, aber nicht in der aktuellen Deck-Version steht, wird einzeln beobachtet.
- Stellt sich ein „Skip" doch als Wiedergabe heraus, wird er genau einmal und vollständig zurückgenommen: Zähler, Pause und Sperre. Das gilt auch, wenn die Wiedergabe erst nach der Wartezeit ankommt.
- Geprüft wird das gegen die Wahrheit des Simulators (`test/hub/skips-truth.test.ts`, mit allen Argumenten der Buchung): kein einziger Skip für einen Song, der nicht früh übersprungen wurde, und keine falsche Sperre. Das gilt bei normalem Hören und nach einem Autostopp, und zwar für jede Art, wie Spotify weitermachen könnte:
  - die geladene Reihenfolge,
  - der neue Inhalt ab der alten Position,
  - der Song gesucht,
  - von oben.

  Dazu kommen alle drei Skip-Regeln. Unabhängige Prüfungen kamen zum selben Ergebnis, zuletzt mit 360 Autostopp-Läufen (sechs Arten weiterzumachen, fünf Pausenlängen, drei Regeln): keine erfundene Buchung, keine falsche Sperre, keine fehlende oder doppelte Wiedergabe. Erkannt werden bei normalem Hören mindestens 90 % der echten Skips, nach einem Autostopp mindestens 80 %. Wenn Spotify nach dem Halt anders weitermacht als geladen, sind es weniger, dann lieber verpasst als erfunden.

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

- direkt nach jedem Songende (bei langen Songs spätestens alle 4 Minuten), solange ein Deck spielt,
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
- Ein Abgleich schreibt nur, was sich geändert hat. Uhrzeiten, die sich um weniger als eine Minute verschoben haben, werden nicht gespeichert. Eine offene App fragt Spotify nach einem Tipp, am erwarteten Songende und sonst alle 45 Sekunden. Dazwischen läuft die Anzeige von selbst weiter.
- Gemessen (`test/hub/budget.test.ts`, mit einem Durable Object, das nach einer Minute Ruhe alles vergisst), für einen Hörer-Tag mit einem Jahr Verlauf:

  | Konto | gelesene Zeilen | geschriebene Zeilen | 5 solche Konten vom Tageskontingent |
  |---|---|---|---|
  | typisch: 9 Sender, 10.000 Songs, 15.000 im Gedächtnis, 1 h offene App | ~75.000 | ~1.500 | ~8 % / ~8 % |
  | an der Grenze: 30 Sender, 25.000 im Gedächtnis, 300 gefolgte Playlists, 1 h offene App | ~125.000 | ~1.800 | ~13 % / ~9 % |
  | an der Grenze, App 8 h offen | ~305.000 | ~5.100 | ~31 % / ~26 % |
  | extrem (Messung der unabhängigen Prüfung): 30 Sender mit je 10.000 Songs | ~320.000 | ~2.400 | ~32 % / ~12 % |

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
- Optionale Allowlist `ALLOWED_SPOTIFY_IDS`. Sie gilt bei jeder Anfrage: Wer von der Liste genommen wird, ist sofort abgemeldet.
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
- **Die Reihenfolge in einem laufenden oder gehaltenen Deck steht fest.** Regeländerungen wirken beim nächsten Start aus der App oder beim nächsten Neuschreiben, während kein Player die Playlist hält.
- **Den Song, der beim Autostopp pausiert war,** nimmt die fortgesetzte Version heraus. Lief er schon mindestens 30 Sekunden, ist er ohnehin gehört und kommt nicht gleich wieder. Ausnahme: Wechselte der Song kurz vor dem Stopp, ohne dass True Shuffle es sah (ein Skip in den ersten Sekunden), kennt es den pausierten Song nicht. Startet der Hörer danach in Spotify von oben, kann dieser Song am selben Tag noch einmal kommen. In der unabhängigen Prüfung waren das 3 Wiederholungen in 180 Läufen, alle bei einem 60-Song-Sender.
- **Hält ein Handy tagelang eine alte, geladene Reihenfolge,** spielt es diese ab, egal was in der Playlist steht. Das kann True Shuffle nicht ändern. Abgelehnte Songs überspringt es auch dort.
- **Wer einen Sender wochenlang nur im Auto fortsetzt,** ohne ihn in der App anzutippen, hört ihn einmal ganz durch. Danach hängt jede Fortsetzung Songs der nächsten Runde an, die lange genug nicht liefen. Hört jemand ohne Pause über das Ende der Playlist hinaus, übernimmt Spotifys Autoplay, bis der nächste Halt oder der nächste Start aus der App die Playlist wieder füllt.
- **Das Planen eines Senders mit 10.000 Songs** braucht in Node etwa 20–45 ms CPU. Das läuft im Durable Object, das laut Cloudflare-Doku (Durable Objects → Limits) auch im kostenlosen Plan 30 s CPU pro Anfrage hat. Die 10 ms des kostenlosen Plans gelten für den vorgelagerten Worker, der nur prüft und weiterleitet. Gemessen ist das im echten Betrieb noch nicht ([LIVE_TEST.md](../LIVE_TEST.md), Abschnitt H).
- **Nachweis:** Unit-, Eigenschafts-, Szenario- und End-to-End-Tests gegen eine Spotify-Attrappe mit Player-Simulation. Der Live-Nachweis mit echtem Spotify steht aus ([LIVE_TEST.md](../LIVE_TEST.md)).
