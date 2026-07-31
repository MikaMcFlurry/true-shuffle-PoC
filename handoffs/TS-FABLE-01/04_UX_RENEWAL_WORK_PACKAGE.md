# UX-Erneuerung – verpflichtender erster Lauf

## Ziel

Nicht „schönere Screens“, sondern ein neues, kohärentes Produktinterface, das die komplexe Trennung zwischen True-Shuffle-Run und Spotify-Wiedergabe verständlich macht.

Die neue UX muss vor der Spotify-Funktionsausweitung abgeschlossen und unabhängig geprüft werden. Funktionslogik darf für UX-Mocks simuliert werden; der Spotify-Fix darf die UX-Phase nicht verdrängen.

## Verbindlicher Prozess

### 1. Ist-Inventar

- alle Screens, Zustände, Modals, Fehler, Breakpoints und Texte erfassen,
- kritische Nutzerpfade und redundante/fehlende Zustände markieren,
- funktionale Semantik von visueller Altlast trennen,
- aktuelle Accessibility- und Browsertests als Regression-Input sichern.

### 2. Mika-Library-Retrieval

- aktuelle Library-Revision abrufen,
- Produktanforderungen als harte Filter formulieren,
- mindestens drei voneinander unterscheidbare **Single-Source-Konzepte** ausarbeiten,
- jedes Konzept intern mit exakter Library-Quelle und Revision sowie öffentlich nur mit freigegebenem Quellalias, transferierbaren Regeln und bewusst nicht übernommenen Elementen dokumentieren,
- erst danach eine Richtung auswählen.

Falls eine Mischung einen klaren Produktnutzen bietet, ein Source Manifest mit freigegebenen Quellaliasen, Primärquelle, Sekundärrolle, Gewichtung und Konfliktauflösung anlegen. Kein automatisches Mitteln. Interne Library-IDs, private Repository-Metadaten und Hashes bleiben außerhalb des öffentlichen Produkt-Repositories.

### 3. UX-Architektur

Mindestens diese Flows abbilden:

- Einstieg und Spotify-Verbindung,
- Playlist-Bibliothek, Import und Sync,
- Run-Übersicht mit mehreren Hörständen,
- Run-Erstellung mit Preset und fortgeschrittenen Regeln,
- Player/Run-Control-Center,
- manuelle Spotify-Übernahme und Wiederaufnahmeentscheidung,
- Fortschritt, Historie, Skips, Ausschlüsse und Favoriten,
- Konfigurationen verwalten, duplizieren und übertragen,
- Abschluss, Reset, Stop und Löschen,
- leere, ladende, offline/degraded, auth-abgelaufene und fehlerhafte Zustände.

### 4. Prototyp und Auswahl

Vor flächiger Implementierung:

- die kritischen Flows in Mobile und Desktop darstellen,
- echte deutsche Produkttexte statt Lorem Ipsum verwenden,
- lange Playlists, lange Tracknamen, fehlende Cover und Edge Cases zeigen,
- Zustände „True Shuffle aktiv“, „Spotify manuell übernommen“, „wartet auf Entscheidung“ und „kein aktives Gerät“ visuell klar trennen,
- Konzept durch einen anderen Agenten/Modelllauf auf Fidelity, Verständlichkeit und Accessibility prüfen lassen.

### 5. Umsetzung

Die technische Frontend-Basis darf beibehalten oder begründet verändert werden. Kein Frameworkwechsel nur aus Geschmacksgründen. Wenn Jinja/Vanilla die Produktqualität oder Testbarkeit real begrenzt, Entscheidung als ADR mit Migrationskosten und Rollback dokumentieren.

### 6. Browser- und Qualitätsabnahme

- kritische Flows mit Browserautomation,
- visuelle Screenshots bei festgelegten Viewports,
- Tastaturbedienung,
- sichtbare Focus States,
- Kontrast,
- Reduced Motion,
- Touch-Ziele,
- Screenreader-Semantik der wichtigsten Controls,
- keine horizontale Überläufe,
- robuste lange Texte und Übersetzungsausdehnung.

## Experience-Prinzipien

- **Vertrauen vor Magie:** Nutzer sehen, warum ein Track als gespielt, offen, übersprungen oder wiederholt gilt.
- **Run und Spotify trennen:** Der Zustand von True Shuffle und die aktuelle Spotify-Wiedergabe dürfen nicht wie dasselbe Objekt aussehen.
- **Schneller Einstieg, tiefe Kontrolle:** Presets zuerst; komplexe Regeln progressiv offenlegen.
- **Wiederaufnahme ist ein Hauptfall:** Ein Run nach Tagen oder Wochen darf sich nicht wie ein neuer Start anfühlen.
- **Mobile zuerst:** Hauptnutzung unterwegs; keine gefährliche Interaktion während der Fahrt fördern.
- **Ehrliche Grenzen:** Kein aktives Gerät, fehlendes Premium, Provider-Drift oder nicht kontrollierbare Queue klar erklären.
- **Deutsche Primärsprache:** Deutsch vollständig und natürlich; Englisch als strukturierte spätere Parität.

## Pflicht-Screen-Set

| Screen/Flow | Kernaussage |
|---|---|
| Connect | Was True Shuffle steuert, was Spotify bleibt und welche Berechtigungen gebraucht werden |
| Library | Import-/Sync-Status und verfügbare Playlists |
| Run Dashboard | mehrere unabhängige Hörstände derselben Playlist |
| Run Builder | Presets, Wiederholungsregeln, Favoriten, Skip- und Manual-Use-Policy |
| Player | aktueller Titel, Run-Status, nächste regelkonforme Aktion, Providerzustand |
| Manual Takeover | automatisch fortsetzen, pausieren oder nachfragen |
| Progress | gespielt/offen/übersprungen/ausgeschlossen/Wiederholungen |
| History | nachvollziehbare Ereignis- und Trackfolge |
| Config Library | speichern, bearbeiten, duplizieren, auf andere Playlist anwenden |
| Completion | beenden, neuer Durchlauf, Reset, Regeln ändern |

## UX-Akzeptanz

PASS nur wenn:

- die visuelle Richtung auf eine dokumentierte Mika-Quelle zurückführbar ist,
- die Anwendung nicht mehr wie die bestehende „Plattenschrank“-UI wirkt,
- alle Pflichtflows in Mobile und Desktop existieren,
- mindestens ein unabhängiger Reviewer keine kritische Fidelity-/Accessibility-Lücke offen lässt,
- Browsertests die Hauptpfade abdecken,
- der Nutzer jederzeit erkennt, ob Spotify oder True Shuffle gerade die Wiedergabe bestimmt.
