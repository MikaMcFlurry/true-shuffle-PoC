# Spotify-Use-Cases und aktuelle Abdeckung

## Produktvertrag

Spotify bleibt die Plattform für die Wiedergabe. True Shuffle verwaltet unabhängig davon:

- Hörfortschritt,
- Auswahlregeln,
- Wiederholungen und Abstände,
- Favorisierungen und Ausschlüsse,
- Unterbrechung und Fortsetzung,
- mehrere unabhängige Hörvorgänge,
- Verhalten bei paralleler Spotify-Nutzung.

Für Spotify sind alle 30 Use Cases Zielumfang. Für weitere Provider ist Parität erst nach UX- und Spotify-PASS optional.

Die ungekürzte fachliche Referenz steht in `03A_CANONICAL_USE_CASES.md`. Bei einem Konflikt zwischen Kurzmatrix und Langfassung gilt die Langfassung.

## Statuslegende

- `JA`: im aktuellen Code grundsätzlich vorhanden,
- `TEILWEISE`: Teilmechanismus vorhanden, Use Case nicht vollständig,
- `NEIN`: nicht vorhanden,
- `LIVE OFFEN`: interne Logik vorhanden, Providerverhalten nicht live belegt.

## Coverage-Matrix

| ID | Use Case | Ist-Stand | Mindestakzeptanz |
|---:|---|---|---|
| 1 | Mit Spotify anmelden | JA | OAuth-Login, Refresh, Disconnect und Fehlerzustände live geprüft; keine Secrets in Logs. |
| 2 | Eigene Spotify-Playlists anzeigen | JA/TEILWEISE | Alle laut aktueller Spotify-API für den Nutzer zulässigen Playlists paginiert und verständlich anzeigen; Einschränkungen benennen. |
| 3 | Playlist in True Shuffle importieren | TEILWEISE | Persistierter Playlist-Snapshot unabhängig vom Run; vollständige Trackmenge, stabile Identitäten und Importstatus. |
| 4 | Playlist synchronisieren | NEIN | Additions/Removals erkennen; bestehenden Hörstand soweit möglich erhalten; Ergebnis vor Anwendung anzeigen. |
| 5 | Neuen Hörvorgang erstellen | TEILWEISE | Mehrere benannte Runs pro Playlist mit eigener Konfiguration anlegen. |
| 6 | Vollständig ohne Wiederholung hören | INTERN JA, LIVE OFFEN | Jeder berücksichtigte Track exakt einmal vor Wiederholung; über Tage/Wochen fortsetzbar; Live-Queue erzeugt keine Doppelung. |
| 7 | Kontrollierte Wiederholungen | NEIN | Wiederholungsquote, Gewichtung und Abstand gemeinsam deterministisch/testbar anwenden. |
| 8 | Songs favorisieren | NEIN | Run-spezifische Favoriten beeinflussen Auswahl innerhalb der Regeln. |
| 9 | Wiederholungsabstand festlegen | NEIN | Mindestanzahl anderer Tracks wird immer eingehalten oder verständlich als unmöglich erklärt. |
| 10 | Konfiguration speichern | NEIN | Benannte, wiederverwendbare Presets persistieren. |
| 11 | Hörvorgang starten | JA, LIVE FEHLERHAFT | Zielgerät wählen/erkennen; korrekter erster und nachfolgender Track; keine Queue-Duplikate. |
| 12 | Hörvorgang pausieren | JA | Spotify- und Run-Zustand sauber unterscheiden; Fortschritt bleibt erhalten. |
| 13 | Hörvorgang stoppen | TEILWEISE | Stoppen ohne Fortschrittsverlust ist eigener Zustand; nicht mit destruktivem Cancel verwechseln. |
| 14 | Hörvorgang fortsetzen | JA, LIVE OFFEN | Aus gespeichertem Stand auf gleichem oder anderem Gerät korrekt fortsetzen. |
| 15 | Hörvorgang neu starten | NEIN | Bewusster Reset mit Bestätigung; Historie nach Produktentscheidung archivieren oder löschen. |
| 16 | Mehrere Hörstände je Playlist | TEILWEISE | Mehrere unabhängige Runs auch mit gleicher Playlist und Konfigurationsart; aktueller Unique-Constraint darf das nicht verhindern. |
| 17 | Spotify parallel normal verwenden | TEILWEISE/LIVE OFFEN | True-Shuffle-Ledger bleibt korrekt, während Nutzer andere Inhalte/Queues in Spotify startet. |
| 18 | Verhalten bei manueller Nutzung | NEIN | Pro Run: automatisch fortsetzen, automatisch pausieren oder nachfragen; alle drei live testen. |
| 19 | Songs überspringen | NEIN ALS KONFIGURATION | Pro Run: erledigt, offen, später, ans Durchlaufende; doppelte Provider-Events idempotent verarbeiten. |
| 20 | Songs ausschließen | NEIN | Run-spezifischer Ausschluss ohne Änderung der Spotify-Playlist. |
| 21 | Ausschlüsse reaktivieren | NEIN | Reaktivierter Track wird regelkonform wieder berücksichtigt. |
| 22 | Hörfortschritt ansehen | TEILWEISE | Gespielt/offen/%/übersprungen/ausgeschlossen/Wiederholungen/letzter Track korrekt anzeigen. |
| 23 | Verlauf ansehen | TEILWEISE | Chronologische, verständliche Track-Historie mit Ereignistyp und Zeit; keine Secret-/PII-Leaks. |
| 24 | Abschluss erkennen | JA/TEILWEISE | No-Repeat-Run nach allen berücksichtigten Tracks abgeschlossen; sinnvolle Folgeaktionen. |
| 25 | Neue Songs in laufenden Run | NEIN | Direkt, nach aktuellem Durchlauf oder ignorieren; Entscheidung persistieren. |
| 26 | Hörvorgang löschen | NEIN | Run löschen, Spotify-Playlist unberührt lassen; Bestätigung und sichere Datenbereinigung. |
| 27 | Konfiguration bearbeiten | NEIN | Regeln mit klarer Auswirkung auf laufenden Run bearbeiten; Konflikt-/Migrationsregeln. |
| 28 | Konfiguration duplizieren | NEIN | Kopie mit neuer Identität, unabhängig editierbar. |
| 29 | Konfiguration andere Playlist | NEIN | Preset anwenden; trackbezogene Favoriten/Ausschlüsse sicher neu zuordnen oder auslassen. |
| 30 | Lange Autofahrt | TEILWEISE/LIVE OFFEN | Großer Run, einfache sichere Bedienung vor Fahrt, dauerhafte Fortsetzung, keine unkontrollierten Repeats. |

## Zusätzliche fachliche Invarianten

### Track-Identität

Ein Playlist-Eintrag, ein Musiktitel und eine konkrete Provider-URI sind nicht automatisch dieselbe Identität. Lokale Dateien, entfernte Inhalte, Re-Uploads, Duplikate innerhalb einer Playlist und Marktverfügbarkeit müssen bewusst behandelt werden.

### Run-Isolation

Änderungen an Run A dürfen Run B nicht verändern. Eine Playlist-Synchronisierung darf historischen Fortschritt nicht still überschreiben.

### Ereignis-Idempotenz

Polling, Retries, Netzwerkfehler und Provider-Events können dasselbe reale Ereignis mehrfach melden. Ein realer Skip oder Trackabschluss darf im Ledger nur einmal wirksam werden.

### Regelauflösung

Wenn Regeln nicht gleichzeitig erfüllbar sind, muss das Produkt:

1. den Konflikt vor Start erkennen, oder
2. eine dokumentierte Priorität anwenden und sie dem Nutzer erklären.

Es darf nicht still gegen Mindestabstände oder Ausschlüsse verstoßen.

### Reproduzierbarkeit

Für Debugging und Tests soll jede Auswahl anhand Run-Version, Regelversion, Kandidatenmenge und Zufallsseed nachvollziehbar sein, ohne Zufälligkeit im Nutzererlebnis vorzutäuschen.
