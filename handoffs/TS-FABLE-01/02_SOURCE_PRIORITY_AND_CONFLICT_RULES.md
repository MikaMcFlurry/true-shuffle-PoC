# Quellenpriorität und Konfliktregeln

## Verbindliche Reihenfolge

Bei Widersprüchen gilt:

1. die 30 Use Cases und Prioritäten des aktuellen Nutzerauftrags,
2. aktuelle offizielle Spotify-Dokumentation und Developer Policy,
3. überprüfbare Evidenz aus Live-Tests,
4. dieses Handoff mit seinem verifizierten Repo-Audit,
5. aktueller Code und automatisierte Tests,
6. explizit ausgewählte, aktuelle Mika-Library-Spezifikation,
7. bestehende Repository-Dokumente,
8. historische Master-Chat-, Landingpage- und Brand-Artefakte.

Ein älteres Dokument darf eine neuere Anforderung nicht stillschweigend überschreiben.

## Evidenzklassen

Jede relevante Behauptung erhält eine Klasse:

- `VERIFIED_CODE`: direkt im aktuellen Code nachgewiesen,
- `VERIFIED_AUTOMATED`: durch relevante automatisierte Tests nachgewiesen,
- `VERIFIED_LIVE`: mit echtem Providerkonto und realem Gerät nachgewiesen,
- `OBSERVED_USER`: vom Nutzer beobachtet, noch nicht instrumentiert reproduziert,
- `INFERRED`: schlüssige, aber noch nicht bestätigte Erklärung,
- `UNVERIFIED`: Behauptung oder Feature ohne ausreichenden Nachweis,
- `BLOCKED`: Nachweis wegen fehlender Zugangsdaten, Policy oder externer Voraussetzung nicht möglich.

„Test grün“ darf nicht pauschal als `VERIFIED_LIVE` dargestellt werden.

## Entscheidungsprotokoll

Für Architektur-, UX- und Provider-Entscheidungen kurz festhalten:

- Entscheidung,
- Alternativen,
- relevante Evidenz,
- verworfene Optionen und Grund,
- Auswirkungen auf Use Cases,
- Rückfall-/Rollback-Pfad,
- noch offener Live-Nachweis.

## Mika UX Library

Die Library beim Start des UX-Laufs neu lesen. Keine IDs oder Revisionen aus diesem Handoff ungeprüft übernehmen.

Pflichtablauf:

1. aktuelle Index-/Record-Daten abrufen,
2. harte Filter aus Produkt-, Plattform- und Accessibility-Anforderungen ableiten,
3. exakte Library-Quelle, Status und Revision in einem privaten Arbeitsnachweis erfassen,
4. vollständige Spezifikation lesen,
5. genau eine Primärquelle pro Konzept verwenden,
6. bei bewusstem Mix Quelle, Rolle, Gewicht und Konfliktentscheidung dokumentieren,
7. unabhängigen Fidelity-Reviewer einsetzen.

Im öffentlichen Produkt-Repository nur einen freigegebenen Quellalias und die tatsächlich übertragenen Designregeln dokumentieren. Keine internen Library-IDs, privaten Repository-Metadaten oder Hashes veröffentlichen.

Verboten:

- generische Prompts wie „modern, clean, dark cards“ als Designsystem,
- unsichtbares Mischen mehrerer Quellen,
- ein Quality-/Polish-Tool als Ersatz für die gewählte Design-DNA,
- die aktuelle App nur kosmetisch neu einzufärben.

Dieses Handoff gibt bewusst keinen Library-Eintrag vor. Fable soll die aktuelle Library selbst durchsuchen, mindestens drei geeignete Richtungen prüfen und ihre Eignung aus dem Produktproblem ableiten.

## Impeccable und andere UX-Skills

Erlaubt für Audit, Adaptierung, Accessibility, Responsiveness, Optimierung und Polish. Nicht erlaubt als verdeckte visuelle Primärquelle.

## Technische Vorschläge dieses Handoffs

Alle Spotify-Lösungswege in `05_SPOTIFY_LIVE_WORK_PACKAGE.md` sind Prüfkandidaten. Fable muss anhand der Use Cases, aktuellen Spotify-APIs, Policy und Live-Evidenz selbst entscheiden.

## Umgang mit unbekannten oder wechselnden Modellnamen

Die im Nutzerauftrag genannten Modelle sind Präferenzen, keine Erlaubnis, Verfügbarkeit zu erfinden. Der Lead:

- enumeriert die tatsächlich verfügbaren Modelle,
- wählt pro Arbeitspaket das fachlich beste verfügbare Modell,
- dokumentiert Auswahl und Fallback,
- nutzt unterschiedliche Agenten für Erzeugung und unabhängige Abnahme,
- ruft kein Modell nur zur Erfüllung einer Quote auf.
