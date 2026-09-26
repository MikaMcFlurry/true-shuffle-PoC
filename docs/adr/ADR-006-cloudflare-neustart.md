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

Jeder Sender ist eine private Spotify-Playlist „True Shuffle · <Sender>" mit 300 geplanten Songs. Eine fortgesetzte Version (siehe unten) wächst mit jedem Halt um bis zu 25 Songs, höchstens auf 2.000; jede Seite zu 100 Songs kostet eine Anfrage, und eine Playlist wird nur geschrieben, wenn sie ganz in den Aufruf passt. Gestartet wird sie mit `context_uri` und `offset`, Shuffle und Wiederholen sind aus. Spotify spielt sie dann selbst ab, auf jedem Gerät, auch offline im Auto und auch ohne True Shuffle. Eine Warteschlange muss niemand am Leben halten. Das behebt die Fehlerklasse des Prototyps an der Wurzel.

- **Neu geschrieben** wird ein Deck nur, wenn niemand darin hört, und zwar 10 Minuten nach dem letzten Blick, bei dem noch Musik lief (also 6 bis 10 Minuten nach der tatsächlichen Pause): Jemandem die laufende Playlist umzuschreiben ist genau der alte Fehler. Das „niemand hört" muss ein frischer Blick auf den Player belegen (höchstens 5 Minuten alt). Kann Spotify nichts sagen, wartet True Shuffle. Anlass ist ein verbrauchtes Deck, ein veraltetes (älter als 20 h) oder ein markiertes (neue Entdeckungen, Daumen runter, Regeländerung).
- **Hält ein Player die Playlist noch (pausiert, etwa beim Autostopp, oder zuletzt darin und gerade unsichtbar), setzt ein Hintergrund-Neuschreiben sie fort** (`continueLayout` in `src/core/deck.ts`). Die Songs nach der gehaltenen Stelle bleiben an ihren Plätzen. Dadurch spielt ein Player dasselbe, egal ob er nach Position weitermacht oder die geladene Reihenfolge fortsetzt. Fehlen in einem kleinen Sender Songs, um den Anfang zu füllen, rücken sie um so viele Plätze vor, und die gehaltene Stelle rückt mit; ein Player, der nach Position weitermacht, überspringt dann ebenso viele Songs, ohne etwas zu wiederholen.
  - Ein Song darunter, der inzwischen woanders lief, abgelehnt oder gesperrt wurde, macht an seinem Platz einem neuen Song Platz. Gibt es keinen, fällt er heraus. Ein Player, der an der gehaltenen Stelle weitermacht, trifft dann einfach den nächsten.
  - Der pausierte Song selbst fällt aus der Version heraus. An seine Stelle kommt ein neuer Song, denn wer nach Position weitermacht, spielt diese Stelle zuerst.
  - Davor stehen neue Songs, damit ein Neustart von oben in Spotify nichts wiederholt. Neu heißt: nicht gehört, nicht kürzlich übersprungen, und nichts, was der Player in dieser Version schon erreicht hat.
  - **Kleine Sender** (die Playlist enthält schon fast alles): Reichen die neuen Songs nicht, wandern die letzten der behaltenen Songs nach vorn, höchstens die Hälfte. Reicht auch das nicht, bleiben vorn die alten Songs stehen. Dann würde nur ein Neustart von oben etwas wiederholen, und wer dort weitermacht, wo er aufgehört hat, behält jeden Song vor sich. Kurz vor dem Ende der Playlist kommen die besten neuen Songs zuerst hinter die gehaltene Stelle (bis 25 voraus), solange die Plätze davor gefüllt bleiben. Die Playlist schrumpft nie auf wenige Songs, und kein Song steht zweimal darin, sonst wären die Positionen mehrdeutig.
  - Lässt sich die gehaltene Version nicht verbessern, bleibt sie, wie sie ist, und True Shuffle schaut stündlich wieder nach.
- **Was True Shuffle nicht gewählt hat, überspringt es selbst** (`guardStation`), sobald es das im Sender sieht:
  - ein Song mit Daumen runter, egal woher und egal wie lange er schon läuft;
  - in seinen ersten 30 Sekunden ein Song, der in den letzten 24 Stunden lief und nicht mehr in der Playlist steht, wohl aber in einer ihrer Versionen der letzten 36 Stunden, die ein Player geladen haben kann: eine, in der True Shuffle ihn gesehen hat, die es selbst gestartet hat, oder was eine Fortsetzung davon behielt;
  - in seinen ersten 30 Sekunden ein heute schon gehörter Song vorn in einer fortgesetzten Version, wenn jemand sie in Spotify von oben startet. Dann springt True Shuffle zum ersten ungehörten Song der Playlist.

  Das gilt auch bei geschlossener App: True Shuffle sieht direkt nach jedem Songende nach, und solange ein Player einen Sender hält (pausiert oder unsichtbar) alle 30 Sekunden bis 2 Minuten (Takt siehe Abschnitt 4). Solche Sprünge zählen nie als Skip des Hörers, und die App zeigt drei Minuten lang, was übersprungen wurde und warum. Im Gast-Modus springt True Shuffle nie. Einen Song, den der Hörer in der aktuellen Playlist selbst antippt oder in die Warteschlange legt, lässt es in Ruhe, außer er steht vorn in einer fortgesetzten Version oder in einer alten Version dieses Senders.
- **Fortgesetzt wird bis 36 Stunden nach dem letzten Hören,** so lange, wie ein Player die Playlist über Nacht halten kann. Danach plant True Shuffle frisch.
- **Beginnt eine fortgesetzte Version vorn mit alten Songs,** steht an erster Stelle trotzdem ein ungehörter. Während er läuft, sieht True Shuffle den Sender und springt hinter ihm über die schon gehörten hinweg.
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
- Lücken zwischen zwei Beobachtungen zählen nur in einem Deck, dessen Reihenfolge sicher ist. Das ist der Fall, wenn True Shuffle es selbst gestartet hat oder wenn es eine solche Version an Ort und Stelle fortsetzt. Vorn in einer fortgesetzten Version, bis zur gehaltenen Stelle, stehen die Songs, die sie nach vorn geholt hat, zwischen alten Songs. Dort landet ein Handy, das noch eine ältere Reihenfolge spielt, sobald es die behaltenen Songs hinter sich hat. Lücken zählen dort deshalb nur, wo jede Reihenfolge, die ein Player noch geladen haben kann, dieselben Songs nacheinander hat, oder wenn feststeht, dass der Player diese Version spielt. Das steht fest, wenn True Shuffle sie gestartet oder an eine Stelle gesprungen hat, oder wenn der Player einen Song spielte, zu dem keine ältere Reihenfolge mehr kommen kann. Eine ältere Reihenfolge läuft nur von ihrer Stelle aus weiter: Songs, die sie schon hinter sich hat, erreicht nur, wer die neue Version spielt. Das gilt auch, wenn der erste Blick nach dem Neuschreiben schon vorn landet (etwa nach Offline-Hören) oder eine Serie schneller Skips zwischen zwei Blicken dorthin führt. Springt der Player in einer fortgesetzten Version vom Ende der an Ort und Stelle behaltenen Songs (höchstens 10 Songs davor oder danach) zurück nach vorn, auf einen Song, den schon eine ältere Version hatte, spielt er womöglich noch eine ältere Reihenfolge. Eine ältere Reihenfolge verlässt die behaltenen Songs nur dort, denn sie spielt sie erst alle ab, und trifft danach auf die Songs, die die neue Version nach vorn geholt hat. Dahinter kann sie zufällig noch einen Song treffen, den eine spätere Version dort neu geplant hat: Lange nicht gehörte Songs kommen zuerst, und das sind oft genau die aus ihrem Rest. Deren restliche Songs stehen in der neuen Version irgendwo. Dann zählen 36 Stunden lang, auch über weitere Fortsetzungen hinweg, nur Songs, die laufend gesehen und verlassen wurden. Das endet früher, wenn True Shuffle den Sender selbst startet oder an eine Stelle springt, oder wenn der Player der Reihe nach auf einen Song weiterläuft, den nur die neue Version hat. Einen neuen Song erreicht nur, wer die neue Reihenfolge spielt: Wer in Spotify von oben startet oder einen neuen Song antippt, verliert nichts. Die Stellen, an denen eine Version von ihrer Vorgängerin abweicht, trägt jede Fortsetzung weiter, ebenso das Ende der behaltenen Songs jeder Vorgängerin (auch von dort aus gilt der Sprung nach vorn wie oben). Fällt der Song an einer solchen Stelle heraus, rückt die Stelle hinter den letzten behaltenen Song davor. Über solche Stellen hinweg wird nichts erschlossen. Solche nur erschlossenen Skips wirken lediglich weich („nicht jetzt, seltener"). Lag zwischen dem letzten Blick davor und dem Blick, der den Song verlassen sah, Gast-Zeit, bleibt der Skip beim Gast und zählt nicht. Beendet ein Skip unter „consume" eine Runde, beginnt die nächste beim Buchen, nicht rückwirkend. Sperren (Regel „ban") und Verbrauchen der Runde (Regel „consume", eigenes Feld `consumed_at`) gibt es nur für einen Song, der tatsächlich laufend gesehen und verlassen wurde. Daumen hoch hebt eine Sperre auf allen Sendern auf.
- Ein Song, der im Sender läuft, aber nicht in der aktuellen Deck-Version steht, wird einzeln beobachtet.
- Legt der Hörer einen Song aus demselben Sender, der ein paar Plätze weiter unten steht, in die Warteschlange, sieht das wie ein Sprung nach vorn aus. Sobald der Player danach wieder zwischen den beiden Stellen gesehen wird, nimmt True Shuffle die dazwischen erschlossenen Skips zurück. Hört der Hörer direkt nach diesem Song auf und kommt innerhalb von 20 Minuten nicht zurück, bleiben sie als weiche Skips stehen.
- Stellt sich ein „Skip" doch als Wiedergabe heraus, wird er genau einmal und vollständig zurückgenommen: Zähler, Pause und Sperre. Das gilt auch, wenn die Wiedergabe erst nach der Wartezeit ankommt.
- Geprüft wird das gegen die Wahrheit des Simulators (`test/hub/skips-truth.test.ts`, mit allen Argumenten der Buchung): kein einziger Skip für einen Song, der nicht früh übersprungen wurde, und keine falsche Sperre. Das gilt bei normalem Hören und nach einem Autostopp, und zwar für jede Art, wie Spotify weitermachen könnte:
  - die geladene Reihenfolge,
  - der neue Inhalt ab der alten Position,
  - der Song gesucht,
  - von oben.

  Dazu kommen alle drei Skip-Regeln. Unabhängige Prüfungen kamen zum selben Ergebnis, zuletzt mit 360 Autostopp-Läufen (sechs Arten weiterzumachen, fünf Pausenlängen, drei Regeln): keine erfundene Buchung, keine falsche Sperre, keine fehlende oder doppelte Wiedergabe. Die letzte Lücke fanden die neunte und zehnte Prüfung bei Handys, die über Tage und viele Fortsetzungen eine alte Reihenfolge behalten: vereinzelt erschlossene, also weiche Skips. Seit die Fortsetzungen die Abweichungsstellen und Enden ihrer Vorgänger mittragen, stehen auch dort null erfundene Buchungen (54 Läufe über drei Tage mit bis zu 42 Fortsetzungen, dazu 100 Läufe mit Ketten in kleinen Sendern). Das ist für diese simulierten Abläufe gezeigt, nicht für jede denkbare Kette. Behält ein Handy seine alte Reihenfolge, erkennt True Shuffle in kleinen Sendern nur rund 60–75 % der echten Skips, weil es dann Lücken nicht mehr auswertet. Erkannt werden bei normalem Hören mindestens 90 % der echten Skips (Test), nach einem Autostopp in der unabhängigen Prüfung rund 91 %: je nach Art des Weitermachens 79 % (von oben) bis 97 % (geladene Reihenfolge). Wenn Spotify nach dem Halt anders weitermacht als geladen, sind es weniger, dann lieber verpasst als erfunden.

Der Gast-Modus blendet Zeiträume aus. Spotify stempelt eine Wiedergabe bei ihrem Ende. Ein Song, der beim Ein- oder Ausschalten des Gast-Modus gerade läuft, gehört deshalb zum Gast und zählt nicht, auch wenn der Hörer ihn zu Ende hört. Beim Ausschalten von Hand sieht True Shuffle dafür nach, was gerade läuft, außer sein letzter Blick ist höchstens 2 Sekunden alt. Klappt das nicht, oder läuft die eingestellte Zeit ab, schätzt es: Eine Wiedergabe gehört zum Gast, wenn sie vor dem Ende begonnen haben kann, also frühestens nach dem Ende der Wiedergabe davor und höchstens ihre Songlänge vor ihrem eigenen Ende. Hat danach jemand einen Song früh übersprungen und hört den nächsten nur teilweise, kann diese eine Wiedergabe beim Gast landen. Eine Wiedergabe in Gast-Zeit nimmt keinen Skip und keine Sperre des Hörers zurück, auch keinen, der noch auf seine Buchung wartet. Der Hörverlauf-Import (Spotify-Datenexport) liefert die Vorgeschichte.

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
- solange ein Player einen Sender hält (pausiert oder unsichtbar): alle 30 Sekunden in den ersten 3 Stunden nach dem letzten Hören und solange vorn in einer fortgesetzten Playlist heute gehörte Songs stehen, sonst jede Minute bis 36 Stunden, danach alle 2 Minuten, solange Spotify den Player pausiert im Sender zeigt oder bis 72 Stunden, wenn der Sender das Letzte war, was lief; ein unveränderter Player-Stand wird dabei nicht jedes Mal gespeichert,
- 15 Sekunden nach einem eigenen Sprung oder einem Tipp in der App,
- alle 30 Sekunden, solange ein Player im Sender einen Song spielt, den die Playlist nicht mehr enthält (eine ältere, geladene Reihenfolge),
- alle 20 Sekunden, wenn 1 bis 3 Songs voraus ein abgelehnter Song steht, eine Stelle, an der ein Player mit der vorigen Version einen gestrichenen Song träfe, oder, vorn in einer fortgesetzten Playlist, ein heute schon gehörter Song,
- alle 20 Sekunden, solange eine ältere Version der Playlist (36 Stunden) einen inzwischen abgelehnten Song noch vor der Stelle des Players hatte,

Die schnellen Takte gelten nur nach einem Blick, der geklappt hat. Kann True Shuffle den Player nicht sehen (Spotify-Zugang entzogen, Spotify bremst), bleibt es beim langsamen Takt.
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
  | typisch: 9 Sender, 10.000 Songs, 15.000 im Gedächtnis, 1 h offene App | ~109.000 | ~1.600 | ~11 % / ~8 % |
  | an der Grenze: 30 Sender, 25.000 im Gedächtnis, 300 gefolgte Playlists, 1 h offene App | ~193.000 | ~1.900 | ~19 % / ~10 % |
  | an der Grenze, App 8 h offen | ~366.000 | ~5.600 | ~37 % / ~28 % |
  | an der Grenze, 12 × Daumen runter am Tag | ~189.000 | ~2.000 | ~19 % / ~10 % |
  | extrem (Messung der unabhängigen Prüfung): 30 Sender mit je 10.000 Songs | ~325.000 | ~2.700 | ~33 % / ~13 % |

  Dazu kommen Durable-Object-Anfragen (100.000 pro Tag im kostenlosen Plan): etwa 20 pro gehörter Stunde (180, solange ein abgelehnter Song einer älteren Version noch kommen kann), 30 bis 120 pro Stunde, in der ein Player einen Sender pausiert hält, sonst 1 bis 3 pro Stunde, dazu 240 pro Stunde für jeden sichtbar offenen App-Tab. Gemessen sind es rund 2.400 pro Konto und Tag; ein Konto, das einen ganzen Tag lang einen Sender pausiert hält, braucht rund 1.600 Weckrufe. Für 5 Konten bleibt es auch dann unter 15.000.

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
- **Frühe Skips, die niemand gesehen hat,** bleiben in einem Deck, das True Shuffle nicht selbst gestartet oder fortgesetzt hat (etwa nach über 36 Stunden Pause), unerkannt. Ebenso bis zu 36 Stunden lang, nachdem ein Player die behaltenen Songs einer fortgesetzten Version verlassen hat und auf einem Song einer älteren Version gelandet ist (siehe oben). Das trifft auch jemanden, der kurz vor diesem Ende in Spotify einen solchen Song weiter vorn antippt oder den Sender von oben startet. In kleinen Sendern stehen vorn eher alte Songs. Und im vorderen Teil einer fortgesetzten Version bleiben Lücken unerkannt, bis der Player dort einen Song spielt, den nur diese Version hat. Das ist bewusst so: Ein verpasster Skip lässt einen Song höchstens etwas früher wiederkommen. Ein erfundener würde einen nie gehörten Song verdrängen.
- **Der Spotify-Entwicklungsmodus erlaubt höchstens 5 Konten** und hat ein knappes Anfragekontingent. Bei „Kontingent aufgebraucht" pausiert True Shuffle für die gemeldete Zeit und macht dann weiter (getestet).
- **Die Reihenfolge in einem laufenden oder gehaltenen Deck steht fest.** Regeländerungen wirken beim nächsten Start aus der App oder beim nächsten Neuschreiben, während kein Player die Playlist hält.
- **Den Song, der beim Autostopp pausiert war,** nimmt die fortgesetzte Version heraus. Lief er schon mindestens 30 Sekunden, ist er ohnehin gehört und kommt nicht gleich wieder. Ausnahme: Wechselte der Song kurz vor dem Stopp, ohne dass True Shuffle es sah (ein Skip in den ersten Sekunden), kennt es den pausierten Song nicht. Startet der Hörer danach in Spotify von oben, kann dieser Song am selben Tag noch einmal kommen. In der unabhängigen Prüfung waren das 3 Wiederholungen in 180 Läufen, alle bei einem 60-Song-Sender.
- **Hält ein Handy eine alte, geladene Reihenfolge,** spielt es diese ab, egal was in der Playlist steht. True Shuffle überspringt darin abgelehnte und in den letzten 24 Stunden gehörte Songs. Direkt nach dem Weiterhören hat es den Player noch nicht wieder gesehen: Ein abgelehnter Song, zu dem der Hörer gleich von Hand springt, läuft bis zum ersten Blick (30 Sekunden in den ersten Stunden nach einem Halt, bis 2 Minuten nach sehr langen Pausen), ein schon gehörter kann dann einmal ganz laufen. Nach mehr als 72 Stunden ohne sichtbaren Player sieht True Shuffle nur noch stündlich nach.
- **Wer einen Song in die Warteschlange legt,** der heute schon lief und in den letzten 36 Stunden in einer Version dieses Senders stand, erlebt, dass True Shuffle ihn überspringt. Spotify sagt nicht, ob ein Song aus der Warteschlange kommt. Frühere Songs einer Playlist merkt sich True Shuffle nur 36 Stunden lang.
- **Spielen zwei Geräte denselben Sender** (etwa das Handy hält eine alte Reihenfolge, der PC startet den Sender neu), kann True Shuffle aus dem Handy-Verlauf Skips erschließen, die keine waren. In der unabhängigen Prüfung waren das 14 bis 23 weiche Skips in je sechs simulierten Läufen mit zwei Geräten. Das wirkt nur weich (seltener, nicht jetzt), nie als Sperre. Ein heute schon gehörter oder abgelehnter Song aus der alten Handy-Reihenfolge kann dann laufen: Spotify zeigt über die Web-API nur das gerade aktive Gerät, ein zweites sieht True Shuffle nicht. Wie Spotify Connect die Geräte dabei wirklich führt, ist ungeprüft; Spotify spielt pro Konto nur auf einem Gerät zugleich.
- **Wer einen Sender wochenlang nur im Auto fortsetzt,** ohne ihn in der App anzutippen, hört die Playlist bis zu ihrem Ende. Steht der ganze Sender schon darin, ist das nach einer Runde erreicht (in der Prüfung mit 600 Songs nach 40 Fahrten ohne eine Wiederholung). Dann übernimmt Spotifys Autoplay, bis ein Start aus der App die nächste Runde beginnt. Bei großen Sendern ist die Grenze die Länge von 2.000 Songs.
- **Ein offener Browser-Tab** fragt alle 15 Sekunden nach dem Stand, solange er sichtbar ist. Das sind bis zu 5.760 Worker-Anfragen pro Tag und Tab, bei 100.000 im kostenlosen Plan.
- **Wer von `ALLOWED_SPOTIFY_IDS` genommen wird,** ist sofort abgemeldet, und spätestens mit dem nächsten Cron (20 Minuten) ruht sein Hub. Seine alten Sitzungen gelten auch dann nicht mehr, wenn er wieder auf die Liste kommt: Er meldet sich neu an. Sein Hub hört schon mit dem nächsten Cron wieder mit, auch vor der Anmeldung.
- **Das Planen eines Senders mit 10.000 Songs** braucht in Node etwa 20–45 ms CPU. Das läuft im Durable Object, das laut Cloudflare-Doku (Durable Objects → Limits) auch im kostenlosen Plan 30 s CPU pro Anfrage hat. Die 10 ms des kostenlosen Plans gelten für den vorgelagerten Worker, der nur prüft und weiterleitet. Gemessen ist das im echten Betrieb noch nicht ([LIVE_TEST.md](../LIVE_TEST.md), Abschnitt H).
- **Nachweis:** Unit-, Eigenschafts-, Szenario- und End-to-End-Tests gegen eine Spotify-Attrappe mit Player-Simulation. Der Live-Nachweis mit echtem Spotify steht aus ([LIVE_TEST.md](../LIVE_TEST.md)).
