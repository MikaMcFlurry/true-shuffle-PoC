# Verifizierter Ist-Stand

## Repository-Auflösung

| Bereich | Verifizierter Stand |
|---|---|
| Produkt-Repository | `MikaMcFlurry/true-shuffle-PoC` |
| Produkt-Basis | `claude/true-shuffle-mvp-streaming-52jofw` |
| Basis-Commit | `d626505ba63ab5a3a4d884b434bc32d58f9c0edc` |
| Default-Branch | `main`, aber technisch veraltet und **nicht** als Basis verwenden |
| Landingpage-Repository | `MikaMcFlurry/true-shuffle-site` |
| Historischer Landingpage-Commit | `9048f5b35096c1a1f70a947a63656ba3b210ede5` |
| Mika UX Library | angebundene private Mika Website/UX Library; aktuelle Revision beim Lauf neu abfragen |

Das Landingpage-Repository enthält nicht die aktuelle Anwendung. Dessen Assets und Copy sind historische Brand-/Marketing-Referenzen.

## Automatisch verifiziert

Auf dem exakten Basis-Commit:

- `305 passed`
- Ruff: `All checks passed`
- eine Deprecation-Warnung aus Starlette/FastAPI-TestClient/httpx
- keine Live-Credential-Tests

Diese Prüfungen bestätigen internen Codezustand, nicht die semantische Richtigkeit des Spotify-Players.

## Technischer Aufbau

- FastAPI
- Jinja-Templates
- Vanilla CSS und ES Modules
- SQLite
- Run-State-Engine und persistierter Verlauf
- Provider-Abstraktion für Spotify, Apple Music, YouTube Music und Demo
- Watcher für Provider-Zustand und Drift
- Fly.io-Dokumentation
- derzeit ein Prozess als relevante Laufzeitannahme

Der aktuelle Produktbranch ist gegenüber `main` eine große Neufassung mit ungefähr 90 geänderten Dateien, 16.114 Einfügungen und 2.658 Löschungen.

## Bestehende Produktfähigkeiten

Folgendes ist im Code bzw. mit Fakes/Tests belegt:

- OAuth-/Account-Flows und Provider-Abstraktion
- Playlist-Lesen
- deterministischer No-Repeat-Run-State
- Start, Pause, Resume und Cancel
- Basic-Fortschritt und Ereignisverlauf
- Utility-/Controller-Modi
- Drift-Erkennung als Grundmechanismus
- Spotify-HTTP-Requestformen gegen Stubs/Fakes

Nicht durch echte Provider-Konten belegt:

- reale Spotify-Queue-Reihenfolge
- Queue-Kohärenz nach nativen Skips
- Verhalten nach manuellen Queue-Einträgen
- Gerätewechsel und fehlendes aktives Gerät
- zeitliche Reihenfolge gemischter Player-Endpunkte
- Apple-/YouTube-Live-Parität

## Verifizierte Lücke der Tests

Die Spotify-Tests prüfen, ob Enqueue-Aufrufe ausgelöst werden. Sie modellieren jedoch keine langlebige, additive Spotify-Warteschlange und fangen daher die beobachtete Vervielfachung nicht ab.

## Aktueller Spotify-Ablauf

Der Code führt beim Start sinngemäß aus:

1. aktuellen Run-Titel mit `PUT /me/player/play` und einem einzelnen URI starten,
2. fünf kommende Titel nacheinander mit `POST /me/player/queue` anhängen.

Nach einem nativen Skip:

1. Spotify rückt in seiner eigenen Queue vor,
2. der Watcher erkennt den Trackwechsel,
3. True Shuffle startet den erwarteten Titel erneut hart,
4. True Shuffle hängt erneut fünf kommende Titel an.

Da die Spotify-Queue dabei nicht ersetzt, gekürzt oder als Eigentum von True Shuffle identifiziert wird, ist die Queue-Vervielfachung aus dem Codepfad schlüssig erklärbar.

## Beobachtung, Schlussfolgerung und offene Hypothese

| Einstufung | Aussage |
|---|---|
| Beobachtet durch Nutzer | Beim Skippen enthält die Spotify-Warteschlange jeden Song mehrfach. |
| Durch Codepfad gestützt | Jeder Advance kann erneut bis zu fünf Titel an eine bestehende Queue anhängen. |
| Beobachtet durch Nutzer | Beim Start werden fünf Titel vorgemerkt; Titel 6 ist wieder Titel 1. |
| Noch zu prüfen | Der einzelne hart gestartete URI könnte nach den fünf Appends als Playback-Kontext erneut auftauchen. Andere Spotify-Zustände sind ebenfalls möglich. |

Die letzte Zeile ist eine Testhypothese, keine feststehende Root Cause.

## Historischer Projektkontext

Der Master-Chat-Backup vom 22.02.2026 hielt bereits fest:

- Run-State-Engine plus Utility Mode als robuster PoC,
- Controller Mode nur als Closed-Beta-Experiment,
- Spotify-API-/Policy-Limits, Geräteaktivierung und Queue-Vollständigkeit als bekannte Risiken,
- Apple Music erst als späterer Scale-Anker.

Das DOCX wurde für diesen Handoff ausgewertet, aber aus Datenschutz- und Scope-Gründen nicht in das öffentliche Produkt-Repository übernommen.

## Visueller Ist-Stand

Die gegenwärtige Anwendung folgt der Richtung „Der Plattenschrank / Der Laufzettel“. Der Nutzer hat diese UX ausdrücklich verworfen. Deshalb:

- keine visuelle Fidelity zur aktuellen App fordern,
- `DESIGN.md` nicht als bindende visuelle Spezifikation behandeln,
- bestehende Semantik, Zustände, Accessibility-Hilfen und funktionale Tests selektiv erhalten,
- neue Informationsarchitektur und neues Designsystem aus der aktuellen Mika UX Library ableiten.

## Historische Brand-Referenzen

Die vom Nutzer bereitgestellten Logos und Produktmotive sind im Landingpage-Repository unter dem oben genannten Commit auffindbar, insbesondere:

- `assets/logo_dark.png`
- `assets/logo_light.png`
- `assets/brand_logo_loop.gif`
- `assets/brand_logo_loop_light.gif`
- `assets/product_01_one-tap.PNG`
- `assets/product_02_features-card.PNG`
- `assets/product_03_comparison.PNG`
- `assets/product_04_10000-tracks.PNG`

Sie dürfen Brand-Input sein, sind aber keine Vorgabe für die neue App-UX.
