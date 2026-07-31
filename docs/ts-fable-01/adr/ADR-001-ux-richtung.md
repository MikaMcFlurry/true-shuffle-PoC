# ADR-001 — UX-Richtung „Nachtpult"

Status: Entschieden (Lead), 2026-07-31 · Gate G1

## Kontext

Die bestehende „Plattenschrank/Laufzettel"-UI ist laut Handoff visuell verworfen. Aus der aktuellen privaten Mika UX Library (Revision am 2026-07-31 verifiziert, 123 aktive Einträge vollständig gelesen) wurden nach acht harten Produktfiltern (funktionales Produkt-UI, WCAG-AA, 4-Zustands-Klarheit, Cover-Pflicht gemäß Spotify-Policy II.5, robuste deutsche Typografie, Jinja/Vanilla ohne Build-Step, klare Abgrenzung zur Alt-UI, Fahrtauglichkeit) drei klar verschiedene Single-Source-Konzepte unabhängig ausgearbeitet:

- **A „Leitstand"** — dunkles, zustandsbewusstes Produktsystem (Quellalias „Signalraum")
- **B „Nachtpult"** — dunkler Workspace mit Aurora-Bogen und Zustands-Textur (Quellalias „Aurora-Workspace")
- **C „Cobalt-Kabinett"** — helles Präzisions-/Exponat-System (Quellalias „Instrument")

Alle drei wurden von einem unabhängigen Reviewer (anderes Modell als die Erzeuger) auf Fidelity, Usability, Accessibility, Vertragsabdeckung, Alt-UI-Abgrenzung und Policy geprüft; sämtliche Kontrastbehauptungen wurden nachgerechnet, ergänzt um Browser-Audit und Farbfehlsichtigkeits-/Graustufen-Simulation.

## Entscheidung

**Konzept B „Nachtpult" wird die Produktrichtung.**

Ausschlaggebend (Produktnutzen, nicht Geschmack):

1. **Zustandskodierung funktioniert auf einen Blick.** Die vier Systemzustände (True Shuffle steuert / Spotify manuell / wartet auf Entscheidung / kein Gerät) sind als Textur kodiert — gefüllte Pille, Vollrand, Punktrand, Strichrand — und überleben Graustufen und alle Farbfehlsichtigkeiten. Das ist für die Fahr-Nutzung die robusteste Lösung im Feld.
2. **Beste Fahr-Ergonomie:** Transport 56–72px, Chips 13px Mischschreibung, keine Unterschreitung der 44px-Touch-Ziele bei Primäraktionen.
3. **Wiederaufnahme als Hauptfall** ist am stärksten erzählt („Weiterhören", „Sobald du zurückkommst, geht es beim 204. Titel weiter", „Zuletzt gesichert: heute, 14:32").
4. **Einziges Konzept mit vollständig ausgemessenem zweitem Theme** (Dark+Light-Leitplanke des Flow-Vertrags).

## Alternativen und Gründe der Ablehnung

- **A „Leitstand"** (knapp zweiter): systemisch am saubersten (beste Quellenableitung, bester Builder, korrekteste ARIA-Muster), verlor an drei Ergonomie-Defekten (40px-Primäraktionen, 11px-Versalien-Mono als Träger der Kernaussage, fehlendes Light-Theme). Seine Builder-/ARIA-Muster werden als **funktionale Muster** offen übernommen (siehe Source Manifest) — keine visuelle Quellvermischung.
- **C „Cobalt-Kabinett"** (dritter): atmosphärisch eigenständig, aber strukturell nicht implementierbar ohne Überarbeitung: Zustandsfarben auf identischer Leuchtdichte (Graustufen-/CVD-Kollaps), Signatur-Fortschrittsbalken renderten nicht, Transport auf Mobil unter der Falz, kein App-Rahmen, schwächste Alt-UI-Abgrenzung. Seine Disziplin der **Zustandsfarben-Reservierung** und das Vertragsvokabular je Karte werden als Regeln übernommen.

## Auflagen aus dem unabhängigen Review (verbindlich vor/mit Implementierung)

1. Fidelity-Deklaration im Source Manifest: Abweichung von den dokumentierten Quell-Tokens (Signal, Canvas-Tönung, Mono-Verzicht) offen ausweisen; Statuspalette ist aus der dokumentierten Kernidee der Quelle abgeleitet, nicht aus deren Token-Tabelle.
2. Deaktivierte Primäraktionen niemals per Opacity unter AA drücken (Review: 1.98:1) — eigener Disabled-Stil, fokussierbar mit Begründung.
3. Run Dashboard zeigt den Kernfall „mehrere Hörvorgänge derselben Playlist"; Playlist-Namen brechen vollständig um (kein line-clamp).
4. Zustandsfarben strikt reserviert: Statistik/Fortschritt nutzen nur Ink-Achse + Signal.
5. Vertragsvokabular (aktiv/pausiert/gestoppt/abgeschlossen) auf jeder Run-Karte zusätzlich zum Systemzustand; Titelposition in der Wiedergabe-Zone.
6. Übernahme der A-Muster: `<details>`-Regelakkordeon, `fieldset`/Radio-Presets, nicht-blockierende Konfliktbox mit Ein-Klick-Auflösungen, `role="progressbar"` mit Geschwister-Label, Aufzählung aller Policy-Varianten.
7. `<main>`-Landmark; Meter-Track-Sichtbarkeit; Spotify-Attribution textlich mit Link (offizielle Logo-Assets erst nach Prüfung der Branding-Guidelines — offener Punkt für Phase 4).

## Konsequenzen

- Frontend-Basis bleibt Jinja2 + Vanilla-CSS + ES-Modules (kein Frameworkwechsel; die Richtung ist ohne Build-Step umsetzbar — statischer Aurora-Verlauf, reine CSS-Token).
- Das Paper-Light-Theme der Quelle wird als zweites Theme implementiert (Umschalter-Mechanik aus dem Ist-Inventar bleibt).
- Alt-Wortschatz (Fach/Karte/Laufzettel/Trennstreifen) wird durch Hörvorgang/Konfiguration/Wiedergabe/Titel ersetzt.
- Rückbau-Pfad: Die Konzepte A und C bleiben als Artefakte im geschützten Arbeitsnachweis; ein Richtungswechsel wäre ein neues ADR, kein stiller Umbau.
