# Live-Test mit echtem Spotify

Automatisch getestet ist alles gegen eine Spotify-Attrappe. Diese Liste prüft, was nur das echte Spotify zeigen kann. Sie dauert einen Abend und einen Tag normales Hören. Hake ab, was stimmt, und notiere, was nicht stimmt (mit Uhrzeit, dann findet es sich in den Logs).

**Vorher:** Einrichtung nach [SETUP.md](SETUP.md) fertig, Spotify-App auf dem Handy offen.

## A. Anmelden und Sender

- [ ] Anmeldung mit Spotify klappt und landet im Sendersuchlauf.
- [ ] Deine Playlists erscheinen. Fremde Spotify-Playlists (z. B. „Today's Top Hits") sind ausgegraut und begründet.
- [ ] Nach dem Speichern: Die Sender lesen ein („liest ein · x / y"), danach sind alle Tasten bereit.
- [ ] In Spotify gibt es pro Sender eine **private** Playlist „true-shuffle · <Sender>".

## B. Abspielen

- [ ] Sender antippen: Spotify spielt innerhalb weniger Sekunden auf dem Handy.
- [ ] In Spotify sind **Shuffle aus** und **Wiederholen aus**.
- [ ] Die Anzeige zeigt Sender, Song, Künstler, Gerät, Grund und Zeit, dazu die Runde auf der Skala.
- [ ] Pause, Weiter, Daumen hoch und Daumen runter wirken in Spotify. Bei Daumen runter springt Spotify sofort weiter.
- [ ] Wiedergabegerät wechseln (Menü → Gerät → Auto/PC) und Sender antippen: Die Musik läuft dort.

## C. Das Gedächtnis (Kern von true-shuffle)

- [ ] 30 Minuten hören, dann **Verlauf**: Jeder Song ab 30 Sekunden steht da.
- [ ] Einen Song nach 5 Sekunden überspringen. Er taucht beim nächsten Neuschreiben nicht gleich wieder auf.
- [ ] Musik **direkt in Spotify** hören (eine andere Playlist, ein Album). Sie steht im Verlauf (ohne Sendernamen) und zählt trotzdem.
- [ ] Hören beenden und nach mindestens 10 Minuten denselben Sender wieder starten. Die Reihenfolge ist neu, Gehörtes ist nicht wieder vorn.
- [ ] Am nächsten Tag denselben Sender starten: kein Song aus dem Vortag, die Rundenzahl „x von y gehört" ist gestiegen.
- [ ] Die Sender-Playlist **direkt in Spotify** starten (ohne true-shuffle). Die Songs zählen trotzdem.
- [ ] Einen Song eine Minute hören, dann in der App einen anderen Sender starten. Eine halbe Stunde später steht der Song im **Verlauf**, genau einmal, und kommt heute nicht wieder. Dann im **Protokoll** nachsehen, welche Zeile steht: „Spotify meldet ersetzte Songs …“ (Spotify meldet einen so ersetzten Song) oder „… zählt ohne Spotifys Meldung (ersetzt)“ (Spotify meldet ihn nicht, true-shuffle zählt ihn nach 20 Minuten selbst). Notiere, welche.
- [ ] Dasselbe **in Spotify**: einen Song eine Minute hören (App offen), dann in Spotify ein anderes Album oder eine andere Playlist starten. Eine halbe Stunde später steht der Song genau einmal im Verlauf; das Protokoll zeigt wieder, wer ihn gezählt hat.

## D. Auto-Situation (der ursprüngliche Ärger)

- [ ] Im Auto über CarPlay/Android Auto einen Sender starten, fahren, Motor aus, später weiterfahren. Spotify macht dort weiter, wo es war: keine Wiederholung, nicht rückwärts.
- [ ] Nach mehreren Fahrten: kein Song doppelt, außer Favoriten nach frühestens einer Woche.
- [ ] Nach der Weiterfahrt im Cloudflare-Dashboard (Worker → Observability → Logs) nach `Früh übersprungen` suchen: Einträge gibt es nur für Songs, die du wirklich weggedrückt hast, nicht für Songs, die gar nicht liefen.

## E. Gast-Modus

- [ ] Menü → Gast-Modus an (z. B. 2 Stunden). GAST leuchtet in der Anzeige.
- [ ] Was jetzt läuft, steht im Verlauf mit der Markierung „Gast" und verändert keinen Sender.
- [ ] Nach Ablauf schaltet er sich selbst ab. Vorher lässt er sich von Hand ausschalten.
- [ ] Mitten in einem Song von Hand ausschalten und nach wenigen Sekunden weiterspringen. Er steht im Verlauf mit „Gast" (oder gar nicht), der Song danach ohne. Noch einmal, diesmal den Song nach dem Ausschalten mindestens eine Minute bis zu seinem Ende hören: Er steht ohne „Gast" im Verlauf. (Prüft, dass Spotify eine Wiedergabe mit ihrem Ende stempelt.)
- [ ] Im Gast-Modus einen Song nach einer Minute pausieren, Gast-Modus ausschalten, später einen Sender aus der App starten. Der pausierte Song steht, wenn überhaupt, mit „Gast" im Verlauf.

## E2. Unterwegs bewerten

- [ ] In Spotify (Handy, CarPlay, Android Auto oder Uhr) einem laufenden Song ein Herz geben. Binnen etwa zehn Minuten steht in den Logs (Cloudflare-Dashboard → Workers → true-shuffle → Observability) „Herz in Spotify: … ist jetzt Favorit“.
- [ ] Im Verlauf einen Song von gestern antippen → Daumen runter. Er ist markiert und kommt in keinem Sender mehr.
- [ ] Menü → Fernbedienung → Schlüssel erstellen. Auf dem iPhone einen Kurzbefehl „Favorit“ nach der Anleitung dort anlegen. „Hey Siri, Favorit“ (auch in CarPlay): Siri sagt „… ist jetzt Favorit“, der Song ist im Verlauf mit Daumen hoch markiert.
- [ ] Kurzbefehl „Nie wieder“: Spotify springt genau einen Song weiter.
- [ ] Im Auto per CarPlay „Nie wieder“: Spotify springt genau einen Song weiter, der Song danach läuft normal (kein zweiter Sprung ein paar Sekunden später).
- [ ] Apple Watch: den Kurzbefehl „Favorit“ in der Kurzbefehle-App der Uhr antippen und per Siri auf der Uhr sagen. Beide Male antwortet er mit „… ist jetzt Favorit“.
- [ ] Homescreen-Widget (iPhone: Kurzbefehle-Widget; Android: HTTP Shortcuts): „Weiter“ springt einen Song weiter und zeigt die Antwort.
- [ ] Neuen Schlüssel erstellen: Der alte Kurzbefehl antwortet „Kein gültiger Schlüssel …“ oder „Dieser Schlüssel gilt nicht mehr …“. Nach „Abmelden“ ebenso.

## F. Entdeckungen

- [ ] Nach einigen Stunden: Sender-Seite → Neuentdeckungen → „Kommen noch" ist größer als 0.
- [ ] Beim Hören leuchtet ENTDECKUNG bei neuen Songs.
- [ ] Daumen hoch auf eine Entdeckung: Sie steht in der Playlist „true-shuffle · Entdeckungen".
- [ ] Mischung auf „Vertraut" stellen: Es kommen kaum noch Entdeckungen, dafür mehr Favoriten.

## G. Hörverlauf-Import

- [ ] Menü → Import → alle `Streaming_History_Audio_…json` wählen. Die Zusammenfassung stimmt grob (Anzahl Songs, Zeitraum).
- [ ] Nach dem Übernehmen kommen lange nicht gehörte Songs zuerst.

## H. Robustheit

- [ ] Handy-App von true-shuffle schließen und eine Stunde normal über Spotify hören, dann öffnen: Alles wurde mitgezählt, denn der Server liest im Hintergrund.
- [ ] Eine Sender-Playlist in Spotify löschen und den Sender antippen: true-shuffle legt sie neu an und spielt.
- [ ] Zweites Konto (Freund/Freundin) anmelden: Die Gedächtnisse sind getrennt.
- [ ] Einen kleinen Sender (unter 300 Songs) im Auto hören, 20 Minuten Pause, weiterhören: Es geht mit dem nächsten Song weiter, kein Autoplay, nichts von vorhin. In Spotify ist die Playlist danach fast so lang wie vorher.
- [ ] Einen Song aus einem laufenden Sender mit Daumen runter ablehnen, während ein anderer Song läuft, dann die App schließen: Kommt der Song im Auto doch noch (aus der geladenen Reihenfolge), springt Spotify nach wenigen Sekunden weiter.
- [ ] Einen Sender auf „Nie wieder auf diesem Sender" stellen, einen Song darin nach 10 Sekunden überspringen, 25 Minuten warten. Im Cloudflare-Dashboard (Worker → Observability → Logs) steht „Früh übersprungen" ohne „(erschlossen)", und der Song kommt auf diesem Sender nicht mehr. Läuft er später woanders, hebt Daumen hoch die Sperre auf.
- [ ] Während ein Sender spielt, einen Song aus demselben Sender, der ein paar Plätze weiter unten steht, in die Warteschlange legen. Den laufenden Song zu Ende hören, dann den aus der Warteschlange eine Minute lang, dann pausieren. Eine Stunde später im Cloudflare-Dashboard (Worker → Observability → Logs) nach `Früh übersprungen` suchen: für die Songs dazwischen kein Eintrag, oder zu jedem später ein `Zurückgenommen` (wenn Spotify den gehörten Song spät gemeldet hat). (Das prüft, ob Spotifys Zeitangaben so genau sind, wie true-shuffle annimmt. Mit „Überblenden" in den Spotify-Einstellungen gilt es nicht.)
- [ ] In Spotify eine private Sitzung starten, einen Sender hören: Die App zeigt „Private Sitzung in Spotify …". Einen Song nach 10 Sekunden überspringen, die nächsten zwei ganz hören, dann die private Sitzung beenden. Eine Stunde später in den Logs: kein `Früh übersprungen` aus dieser Zeit. Die zwei ganz gehörten Songs kommen heute nicht wieder, auch wenn Spotify private Wiedergaben nicht meldet.
- [ ] Einen Song aus einer ganz anderen Playlist, der heute schon lief, in die Warteschlange legen, während ein Sender (nicht „Alles“) spielt: Er läuft ganz, true-shuffle greift nicht ein. Die App zeigt kein „Übersprungen“. (Ein heute schon gehörter Song aus einer Version dieses Senders, die das Handy in den letzten 36 Stunden geladen hatte, wird übersprungen, das ist so gewollt.)
- [ ] Nach einer Fahrt mit Autostopp (mindestens 20 Minuten) die Sender-Playlist später am Tag in Spotify selbst von oben starten: Der erste Song ist neu. Kommt danach ein heute schon gehörter, springt Spotify nach wenigen Sekunden weiter, und die App zeigt „Übersprungen …".
- [ ] Über Nacht im Auto pausieren (12 Stunden oder mehr), am Morgen weiterhören: Nichts von gestern kommt gleich wieder. Ein am Abend abgelehnter Song wird innerhalb etwa einer Minute übersprungen.
- [ ] Im Cloudflare-Dashboard (Worker → Observability) keine gehäuften Fehler.
- [ ] Den größten Sender (oder „Alles“) antippen. Unter Worker → Metrics → Errors erscheint kein „Exceeded CPU Time Limits“.

## Wenn etwas nicht stimmt

Notiere Uhrzeit, Sender und was du erwartet hast. Die Logs (das „Protokoll“ oben; Cloudflare-Dashboard → Workers → true-shuffle → Observability) zeigen dann, was der Hub gesehen und entschieden hat.
