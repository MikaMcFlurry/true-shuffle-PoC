# Live-Test mit echtem Spotify

Automatisch getestet ist alles gegen eine Spotify-Attrappe. Diese Liste prüft, was nur das echte Spotify zeigen kann. Sie dauert einen Abend und einen Tag normales Hören. Hake ab, was stimmt, und notiere, was nicht stimmt (mit Uhrzeit, dann findet es sich in den Logs).

**Vorher:** Einrichtung nach [SETUP.md](SETUP.md) fertig, Spotify-App auf dem Handy offen.

## A. Anmelden und Sender

- [ ] Anmeldung mit Spotify klappt und landet im Sendersuchlauf.
- [ ] Deine Playlists erscheinen. Fremde Spotify-Playlists (z. B. „Today's Top Hits") sind ausgegraut und begründet.
- [ ] Nach dem Speichern: Die Sender lesen ein („liest ein · x / y"), danach sind alle Tasten bereit.
- [ ] In Spotify gibt es pro Sender eine **private** Playlist „True Shuffle · <Sender>".

## B. Abspielen

- [ ] Sender antippen: Spotify spielt innerhalb weniger Sekunden auf dem Handy.
- [ ] In Spotify sind **Shuffle aus** und **Wiederholen aus**.
- [ ] Die Anzeige zeigt Sender, Song, Künstler, Gerät, Grund und Zeit, dazu die Runde auf der Skala.
- [ ] Pause, Weiter, Daumen hoch und Daumen runter wirken in Spotify. Bei Daumen runter springt Spotify sofort weiter.
- [ ] Wiedergabegerät wechseln (Menü → Gerät → Auto/PC) und Sender antippen: Die Musik läuft dort.

## C. Das Gedächtnis (Kern von True Shuffle)

- [ ] 30 Minuten hören, dann **Verlauf**: Jeder Song ab 30 Sekunden steht da.
- [ ] Einen Song nach 5 Sekunden überspringen. Er taucht beim nächsten Neuschreiben nicht gleich wieder auf.
- [ ] Musik **direkt in Spotify** hören (eine andere Playlist, ein Album). Sie steht im Verlauf (ohne Sendernamen) und zählt trotzdem.
- [ ] Hören beenden und nach mindestens 10 Minuten denselben Sender wieder starten. Die Reihenfolge ist neu, Gehörtes ist nicht wieder vorn.
- [ ] Am nächsten Tag denselben Sender starten: kein Song aus dem Vortag, die Rundenzahl „x von y gehört" ist gestiegen.
- [ ] Die Sender-Playlist **direkt in Spotify** starten (ohne True Shuffle). Die Songs zählen trotzdem.

## D. Auto-Situation (der ursprüngliche Ärger)

- [ ] Im Auto über CarPlay/Android Auto einen Sender starten, fahren, Motor aus, später weiterfahren. Spotify macht dort weiter, wo es war: keine Wiederholung, nicht rückwärts.
- [ ] Nach mehreren Fahrten: kein Song doppelt, außer Favoriten nach frühestens einer Woche.
- [ ] Nach der Weiterfahrt im Cloudflare-Dashboard (Worker → Observability → Logs) nach `Früh übersprungen` suchen: Einträge gibt es nur für Songs, die du wirklich weggedrückt hast, nicht für Songs, die gar nicht liefen.

## E. Gast-Modus

- [ ] Menü → Gast-Modus an (z. B. 2 Stunden). GAST leuchtet in der Anzeige.
- [ ] Was jetzt läuft, steht im Verlauf mit der Markierung „Gast" und verändert keinen Sender.
- [ ] Nach Ablauf schaltet er sich selbst ab. Vorher lässt er sich von Hand ausschalten.

## F. Entdeckungen

- [ ] Nach einigen Stunden: Sender-Seite → Neuentdeckungen → „Warten auf dich" ist größer als 0.
- [ ] Beim Hören leuchtet ENTDECKUNG bei neuen Songs.
- [ ] Daumen hoch auf eine Entdeckung: Sie steht in der Playlist „True Shuffle · Entdeckungen".
- [ ] Mischung auf „Vertraut" stellen: Es kommen kaum noch Entdeckungen, dafür mehr Favoriten.

## G. Hörverlauf-Import

- [ ] Menü → Import → alle `Streaming_History_Audio_…json` wählen. Die Zusammenfassung stimmt grob (Anzahl Songs, Zeitraum).
- [ ] Nach dem Übernehmen kommen lange nicht gehörte Songs zuerst.

## H. Robustheit

- [ ] Handy-App von True Shuffle schließen und eine Stunde normal über Spotify hören, dann öffnen: Alles wurde mitgezählt, denn der Server liest im Hintergrund.
- [ ] Eine Sender-Playlist in Spotify löschen und den Sender antippen: True Shuffle legt sie neu an und spielt.
- [ ] Zweites Konto (Freund/Freundin) anmelden: Die Gedächtnisse sind getrennt.
- [ ] Einen kleinen Sender (unter 300 Songs) im Auto hören, 20 Minuten Pause, weiterhören: Es geht mit dem nächsten Song weiter, kein Autoplay, nichts von vorhin. In Spotify ist die Playlist danach fast so lang wie vorher.
- [ ] Einen Song aus einem laufenden Sender mit Daumen runter ablehnen, während ein anderer Song läuft, dann die App schließen: Kommt der Song im Auto doch noch (aus der geladenen Reihenfolge), springt Spotify nach wenigen Sekunden weiter.
- [ ] Einen Sender auf „Nie wieder auf diesem Sender" stellen, einen Song darin nach 10 Sekunden überspringen, 25 Minuten warten. Im Cloudflare-Dashboard (Worker → Observability → Logs) steht „Früh übersprungen" ohne „(erschlossen)", und der Song kommt auf diesem Sender nicht mehr. Läuft er später woanders, hebt Daumen hoch die Sperre auf.
- [ ] Einen Song aus einer ganz anderen Playlist, der heute schon lief, in die Warteschlange legen, während ein Sender (nicht „Alles“) spielt: Er läuft ganz, True Shuffle greift nicht ein. Die App zeigt kein „Übersprungen“. (Ein heute schon gehörter Song aus einer Version dieses Senders, die das Handy in den letzten 36 Stunden geladen hatte, wird übersprungen, das ist so gewollt.)
- [ ] Nach einer Fahrt mit Autostopp (mindestens 20 Minuten) die Sender-Playlist später am Tag in Spotify selbst von oben starten: Der erste Song ist neu. Kommt danach ein heute schon gehörter, springt Spotify nach wenigen Sekunden weiter, und die App zeigt „Übersprungen …".
- [ ] Über Nacht im Auto pausieren (12 Stunden oder mehr), am Morgen weiterhören: Nichts von gestern kommt gleich wieder. Ein am Abend abgelehnter Song wird innerhalb etwa einer Minute übersprungen.
- [ ] Im Cloudflare-Dashboard (Worker → Observability) keine gehäuften Fehler.
- [ ] Den größten Sender (oder „Alles“) antippen. Unter Worker → Metrics → Errors erscheint kein „Exceeded CPU Time Limits“.

## Wenn etwas nicht stimmt

Notiere Uhrzeit, Sender und was du erwartet hast. Die Logs zeigen dann, was der Hub gesehen und entschieden hat.
