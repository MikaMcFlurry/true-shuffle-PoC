# Kanonische Spotify-Use-Cases

Diese Langfassung ist die fachliche Referenz für den nächsten Lauf. Sie beschreibt das gewünschte Verhalten, nicht die technische Umsetzung.

## 1. Mit Spotify anmelden

Der Nutzer meldet sich bei True Shuffle mit seinem Spotify-Account an. Danach kann er seine Spotify-Inhalte innerhalb von True Shuffle verwenden.

## 2. Eigene Spotify-Playlists anzeigen

Der Nutzer sieht alle für ihn verfügbaren Spotify-Playlists und kann eine davon auswählen.

## 3. Playlist in True Shuffle importieren

Der Nutzer importiert eine ausgewählte Spotify-Playlist in True Shuffle.

True Shuffle erfasst alle enthaltenen Songs und speichert die Playlist als Grundlage für zukünftige Hörvorgänge. Zu diesem Zeitpunkt muss noch keine feste Abspielreihenfolge bestehen.

## 4. Playlist synchronisieren

Wenn sich die Playlist später in Spotify verändert, kann der Nutzer die Änderungen in True Shuffle übernehmen.

Neue Songs werden ergänzt, entfernte Songs werden entsprechend berücksichtigt und vorhandene Hörstände bleiben soweit möglich erhalten.

## 5. Neuen Hörvorgang erstellen

Der Nutzer erstellt für eine Playlist einen neuen Hörvorgang.

Dabei wählt er aus, nach welchen Regeln die Songs abgespielt werden sollen. Für dieselbe Playlist können mehrere unterschiedliche Hörvorgänge oder Konfigurationen gespeichert werden.

## 6. Playlist vollständig ohne Wiederholung hören

Der Nutzer startet einen Hörvorgang, bei dem jeder Song der Playlist einmal abgespielt wird, bevor ein Song erneut vorkommen darf.

True Shuffle merkt sich unabhängig von Spotify:

- welche Songs bereits gespielt wurden,
- welche Songs noch offen sind,
- an welcher Stelle der Hörvorgang unterbrochen wurde,
- ob der Hörvorgang aktiv, pausiert oder abgeschlossen ist.

Der Nutzer kann den Hörvorgang über mehrere Tage oder Wochen fortsetzen.

## 7. Playlist mit kontrollierten Wiederholungen hören

Der Nutzer erstellt einen Hörvorgang, bei dem Wiederholungen erlaubt sind.

Er kann beispielsweise festlegen:

- nach wie vielen anderen Songs frühestens eine Wiederholung erfolgen darf,
- wie häufig Wiederholungen grundsätzlich vorkommen sollen,
- welche Songs häufiger gespielt werden dürfen,
- welche Songs bevorzugt behandelt werden,
- welche Songs nicht oder nur selten wiederholt werden sollen.

## 8. Songs favorisieren

Der Nutzer kann einzelne Songs innerhalb einer Playlist für einen Hörvorgang favorisieren.

Favorisierte Songs dürfen innerhalb der gewählten Regeln häufiger ausgewählt werden als andere Songs.

## 9. Wiederholungsabstand festlegen

Der Nutzer legt fest, wie viele Songs mindestens zwischen zwei Wiedergaben desselben Songs liegen müssen.

Beispiele:

- früheste Wiederholung nach 10 Songs,
- früheste Wiederholung nach 30 Songs,
- keine Wiederholung, bis alle Songs einmal gespielt wurden.

## 10. Konfiguration speichern

Der Nutzer kann seine Einstellungen als wiederverwendbare Konfiguration speichern.

Beispiele:

- „Ohne Wiederholungen“
- „Lange Autofahrt“
- „Favoriten häufiger“
- „Training“
- „Hintergrundmusik“

Die gespeicherte Konfiguration kann später erneut für dieselbe Playlist verwendet werden.

## 11. Hörvorgang starten

Der Nutzer wählt eine Playlist und eine gespeicherte oder neu erstellte Konfiguration aus und startet den Hörvorgang.

True Shuffle beginnt mit der Wiedergabe über Spotify und führt den Nutzer anhand der gewählten Regeln durch die Playlist.

## 12. Hörvorgang pausieren

Der Nutzer kann einen laufenden Hörvorgang pausieren.

Der aktuelle Stand bleibt gespeichert. Beim Fortsetzen wird auf Basis des bisherigen Hörstands weitergemacht.

## 13. Hörvorgang stoppen

Der Nutzer kann einen Hörvorgang vollständig stoppen, ohne den bisherigen Fortschritt zu verlieren.

Zu einem späteren Zeitpunkt kann er denselben Hörvorgang erneut öffnen und fortsetzen.

## 14. Hörvorgang fortsetzen

Der Nutzer öffnet einen zuvor gestarteten Hörvorgang und setzt ihn an seinem gespeicherten Stand fort.

Bereits berücksichtigte Songs und bestehende Wiederholungsregeln bleiben erhalten.

## 15. Hörvorgang neu starten

Der Nutzer kann einen bestehenden Hörvorgang zurücksetzen und von vorne beginnen.

Der bisherige Hörstand dieses Vorgangs wird verworfen und alle Songs werden wieder entsprechend der gewählten Konfiguration berücksichtigt.

## 16. Mehrere Hörstände für dieselbe Playlist verwalten

Der Nutzer kann für dieselbe Spotify-Playlist mehrere voneinander unabhängige Hörstände besitzen.

Beispielsweise:

- ein vollständiger Durchlauf ohne Wiederholung,
- ein Autofahrt-Modus mit gelegentlichen Wiederholungen,
- ein Favoriten-Modus,
- ein gemeinsamer Hörvorgang mit einer anderen Konfiguration.

## 17. Spotify parallel normal verwenden

Der Nutzer kann Spotify weiterhin unabhängig von True Shuffle verwenden.

Er kann beispielsweise:

- andere Songs starten,
- andere Playlists hören,
- Alben abspielen,
- Songs überspringen,
- Songs zur Spotify-Warteschlange hinzufügen.

Der gespeicherte Hörstand in True Shuffle bleibt davon unabhängig erhalten.

## 18. Verhalten bei manueller Spotify-Nutzung festlegen

Der Nutzer kann für jeden Hörvorgang bestimmen, wie True Shuffle reagieren soll, wenn er Spotify manuell verwendet.

Mögliche Einstellungen:

### Automatisch fortsetzen

True Shuffle bleibt aktiv und setzt den Hörvorgang nach den manuell gestarteten Songs oder der manuellen Warteschlange automatisch fort.

### Automatisch pausieren

True Shuffle pausiert den Hörvorgang, sobald der Nutzer Spotify manuell übernimmt. Der Nutzer setzt ihn später bewusst fort.

### Vor dem Fortsetzen nachfragen

True Shuffle erkennt die manuelle Nutzung und fragt den Nutzer anschließend, ob der gespeicherte Hörvorgang fortgesetzt werden soll.

## 19. Songs überspringen

Der Nutzer kann einen Song während eines Hörvorgangs überspringen.

Je nach gewählter Konfiguration kann der übersprungene Song:

- als erledigt gelten,
- weiterhin als offen gelten,
- später erneut vorgeschlagen werden,
- ans Ende des aktuellen Durchlaufs verschoben werden.

## 20. Einzelne Songs ausschließen

Der Nutzer kann bestimmte Songs aus einem Hörvorgang ausschließen, ohne sie aus der ursprünglichen Spotify-Playlist entfernen zu müssen.

Diese Songs werden innerhalb dieses Hörvorgangs nicht mehr ausgewählt.

## 21. Ausgeschlossene Songs wieder aktivieren

Der Nutzer kann zuvor ausgeschlossene Songs wieder in den Hörvorgang aufnehmen.

## 22. Hörfortschritt ansehen

Der Nutzer kann jederzeit den aktuellen Stand eines Hörvorgangs einsehen.

Dazu gehören beispielsweise:

- Anzahl bereits gespielter Songs,
- Anzahl noch offener Songs,
- Fortschritt in Prozent,
- übersprungene Songs,
- ausgeschlossene Songs,
- bisherige Wiederholungen,
- zuletzt gespielter Song.

## 23. Verlauf eines Hörvorgangs ansehen

Der Nutzer kann nachvollziehen, welche Songs innerhalb eines Hörvorgangs bereits abgespielt wurden und in welcher Reihenfolge dies geschah.

## 24. Abgeschlossenen Durchlauf erkennen

Ein Hörvorgang ohne Wiederholungen gilt als abgeschlossen, sobald alle berücksichtigten Songs der Playlist einmal abgespielt wurden.

Der Nutzer kann danach:

- den Hörvorgang beenden,
- einen neuen Durchlauf starten,
- den Hörstand zurücksetzen,
- Wiederholungen erlauben,
- mit einer anderen Konfiguration weitermachen.

## 25. Neue Songs in einen laufenden Hörvorgang übernehmen

Wenn einer Spotify-Playlist neue Songs hinzugefügt werden, kann der Nutzer entscheiden, wie diese in einen bereits laufenden Hörvorgang aufgenommen werden.

Mögliche Optionen:

- direkt in den laufenden Hörvorgang aufnehmen,
- erst nach Abschluss des aktuellen Durchlaufs berücksichtigen,
- für diesen Hörvorgang ignorieren.

## 26. Hörvorgang löschen

Der Nutzer kann einen gespeicherten Hörvorgang löschen, ohne die ursprüngliche Spotify-Playlist zu verändern.

## 27. Konfiguration bearbeiten

Der Nutzer kann die Regeln eines gespeicherten Hörvorgangs oder einer gespeicherten Konfiguration anpassen.

Beispielsweise können Favoriten, Wiederholungsabstände oder das Verhalten bei manueller Spotify-Nutzung verändert werden.

## 28. Konfiguration duplizieren

Der Nutzer kann eine bestehende Konfiguration kopieren und auf dieser Grundlage eine leicht veränderte Variante erstellen.

## 29. Konfiguration auf eine andere Playlist anwenden

Der Nutzer kann eine gespeicherte Abspielkonfiguration auch für eine andere Spotify-Playlist verwenden.

## 30. Typischer Anwendungsfall: Lange Autofahrt

Der Nutzer besitzt eine große Spotify-Playlist und möchte während einer langen Autofahrt möglichst viele unterschiedliche Songs hören.

Er öffnet True Shuffle, wählt die Playlist und eine passende Konfiguration aus und startet den Hörvorgang.

True Shuffle speichert den Fortschritt dauerhaft. Bei der nächsten Fahrt kann der Nutzer an seinem bisherigen Stand weitermachen, ohne dass bereits gehörte Songs unkontrolliert erneut abgespielt werden.

## Zusammenfassung des Produktnutzens

True Shuffle ermöglicht es Nutzern, Spotify-Playlists mit einem eigenen, dauerhaft gespeicherten Hörstand und individuell konfigurierbaren Abspielregeln zu hören.

Spotify bleibt die Plattform für die Musikwiedergabe. True Shuffle verwaltet unabhängig davon:

- den Hörfortschritt,
- die Auswahlregeln,
- Wiederholungen,
- Favorisierungen,
- Unterbrechungen,
- das Fortsetzen eines Hörvorgangs,
- das Verhalten bei paralleler Spotify-Nutzung.

