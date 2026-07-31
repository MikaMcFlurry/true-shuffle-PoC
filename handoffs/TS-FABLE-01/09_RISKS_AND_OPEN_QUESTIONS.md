# Risiken und offene Fragen

| Priorität | Risiko | Aktueller Befund | Gate/Antwort |
|---|---|---|---|
| Kritisch | Spotify-Queue nicht kontrollierbar | Add ist vorhanden, Clear/Replace einzelner Queue-Einträge nicht; gemischte Player-Requests haben keine garantierte Reihenfolge | Live-Strategievergleich und ADR vor Implementierung |
| Kritisch | Kommerzielle Spotify-Nutzung | aktuelle Policy enthält erhebliche Einschränkungen für Streaming-SDAs | Fach-/Rechtsprüfung vor Pricing/Launch |
| Kritisch | Falscher Basisbranch | `main` ist älter als der Multi-Provider-MVP | immer von `d626505…`/Handoff-Branch starten |
| Hoch | Keine Live-Evidenz | Provider-Tests arbeiten überwiegend mit Fakes/Stubs | dedizierter Credential-/Device-Gate |
| Hoch | Mehrere Runs blockiert | aktuelles Schema begrenzt aktive Runs pro Nutzer/Provider/Playlist/Mode | Datenmodell und Migration für UC16 |
| Hoch | Event-Doppelverarbeitung | Polling, Overrides und Skips können dasselbe Ereignis mehrfach erzeugen | idempotentes Event-/Command-Modell |
| Hoch | Manuelle Spotify-Nutzung | fremde Tracks/Queues sind nicht eindeutig True Shuffle zuordenbar | explizite Manual-Use-State-Machine |
| Hoch | Ein-Prozess-Annahme | Watcher/Locks können bei Skalierung oder Restart brechen | Laufzeitmodell, Lease/Locking und Recovery prüfen |
| Hoch | UX-Scope | 30 Use Cases können zu einer überladenen Regeloberfläche führen | Presets + Progressive Disclosure + Nutzbarkeitsreview |
| Mittel | Track-Identität | gleiche Songs, Duplikate, Re-Uploads, lokale/unverfügbare Tracks | fachliches Identity-Modell und Testfixtures |
| Mittel | Playlist-Sync | Removes/Adds kollidieren mit historischem Run-Zustand | versionierte Snapshots und Nutzerentscheidung |
| Mittel | Regeländerung im Lauf | bestehende Reihenfolge kann neue Regeln verletzen | klarer Effective-From-/Replan-Vertrag |
| Mittel | Provider-Parität | Apple/YouTube-Verhalten kann Spotify nicht nachbilden | Capability Matrix und ehrliche Degraded Modes |
| Mittel | Library-Drift | private Library-Einträge und Revisionen können sich ändern | beim Lauf neu abrufen und intern verifizieren |
| Mittel | Daten-/Tokenlöschung | Disconnect ist Produkt- und Policy-Anforderung | Retention-/Deletion-Test |

## Offene Produktentscheidungen, die Fable auflösen soll

Diese Fragen sollen anhand Use Cases, Prototypen und Plattformrealität beantwortet und als ADR/Produktentscheidung dokumentiert werden:

1. Was bedeutet „Stop“ technisch und visuell im Unterschied zu Pause und Cancel?
2. Bleibt die Historie nach Reset erhalten oder wird sie verworfen?
3. Wie werden identische Tracks behandelt, die mehrfach in derselben Playlist stehen?
4. Wann gilt ein Track als „gespielt“: Start, Mindesthördauer, Trackende oder konfigurierbares Ereignis?
5. Wie verhält sich ein Skip bei sehr frühem/verspätetem Watcher-Signal?
6. Was geschieht, wenn ein Mindestabstand bei kleiner Kandidatenmenge unmöglich ist?
7. Wie werden trackbezogene Favoriten beim Übertragen einer Config auf eine andere Playlist behandelt?
8. Wie lange wartet „automatisch fortsetzen“ auf eine manuelle Spotify-Queue, wenn die API deren Ende nicht sicher signalisiert?
9. Soll True Shuffle einen sichtbaren Ausführungskontext/Playlist in Spotify erzeugen dürfen?
10. Welche Daten werden beim Spotify-Disconnect gelöscht, exportiert oder anonymisiert?

Fable soll diese Entscheidungen nicht unnötig an den Nutzer zurückgeben. Wo die Use Cases eine klare Richtung erlauben, eine begründete, reversible Entscheidung treffen und implementieren. Nur echte Produkt-/Policy-Blocker eskalieren.

## Release-Stopper

- Queue-Duplikate reproduzierbar oder nicht verstanden
- Use Case 6 nicht live bestanden
- Ledger kann durch manuelle Spotify-Nutzung beschädigt werden
- Security-/Tokenproblem
- Datenmigration ohne Rollback/Test
- kritische Accessibility-Lücke in Hauptflows
- Spotify-Policy-/Commercial-Gate ungeklärt für einen kommerziellen Launch
- Providerfunktion als fertig beworben, obwohl sie nur Stub-/Fake-Evidenz besitzt
