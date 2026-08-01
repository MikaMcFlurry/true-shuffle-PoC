# UX Source Manifest — True Shuffle „Nachtpult"

Stand: 2026-07-31 · Gate G1 · Exakte private Herkunft (Library-Einträge, Revisionen, Hashes) liegt ausschließlich im geschützten Arbeitsnachweis des Laufs; dieses Manifest veröffentlicht nur freigegebene Aliase und Transferregeln.

## Primärquelle

| Feld | Wert |
|---|---|
| Freigegebener Quellalias | **„Aurora-Workspace"** |
| Bezugsart | Single Source (genau eine Primärquelle, kein visuelles Mischen) |
| Library-Revision | aktuelle Revision, am 2026-07-31 abgerufen und integritätsgeprüft |
| Auswahlverfahren | Volltextlektüre aller 123 aktiven Einträge, 8 harte Produktfilter, 3 unabhängige Konzeptläufe, unabhängiger Fremdmodell-Review |

## Übernommene Designregeln (Transfer)

- **Flächenhierarchie statt Schatten:** dunkler Canvas, zwei Surface-Stufen, 1px-Zustandslinien; Karten heben sich über Flächenwerte.
- **Aurora-Bogen als Identitätsmoment:** ein Farbverlauf (Violett→Coral→Gold) ausschließlich in Kopfzonen und als Akzentrand des aktiv gesteuerten Hörvorgangs — nie hinter oder neben Cover-Art.
- **Zustandsreiche Grids:** Systemzustand ist Teil jeder Karte/Zone, nicht nachträgliche Dekoration.
- **Geometrie:** 8–16px Radien für Panels/Medien, 999px für kompakte Aktionen; 8px-Spacing-Skala.
- **Typografie:** ruhige System-Sans, 400/500/600; Display per clamp(); keine Mono-Stimme (siehe Abweichungen).
- **Motion:** 160–280ms Zustandsübergänge; Aurora statisch bei prefers-reduced-motion; keine Autoplay-Simulationen.
- **Dual-Theme:** Night primär, Paper als vollständig ausgemessenes Light-Theme.

## Abgeleitetes Zustandssystem (Ableitungsregel offen dokumentiert)

Die Quelle definiert einen einzelnen Signal-Akzent. True Shuffle braucht vier Systemzustände. Die Statuspalette ist **aus der dokumentierten Kernidee der Quelle** (Aurora-Bogen Violett→Coral→Gold) abgeleitet: alle Statusfarben sind Proben auf diesem Bogen, normalisiert auf ein gemeinsames Leuchtdichteband (OKLCH L≈0.75–0.83); Zustand D ist der „erloschene Bogen" (Chroma≈0). Zustände sind IMMER dreifach kodiert: Farbe + Chip-Textur (gefüllt / Vollrand / Punktrand / Strichrand) + ausgeschriebener Text. Farbfehlsichtigkeits- und Graustufen-Festigkeit wurden simulativ geprüft und unabhängig nachgeprüft.

## Bewusste Abweichungen von der dokumentierten Quelle (deklariert, kein stilles Abweichen)

| Quell-Element | Entscheidung | Grund |
|---|---|---|
| Dokumentierter Signal-Token (Blau) | **nicht übernommen**; Signal ist die Violett-Probe des Aurora-Bogens | Ein blaues Signal neben vier Statusfarben hätte eine sechste Farbrolle erzeugt; die Kernidee der Quelle (Aurora als Identität) trägt die Signalrolle konsistenter. |
| Neutraler Night-Canvas | leicht violett getönt | Canvas nimmt die Aurora-Temperatur auf; Cover-Art bleibt auf neutralisierten Panels. |
| Mono-/Metadaten-Stimme | **nicht übernommen** | Abgrenzung zur Alt-UI (Mono-Stencil-Grammatik); Zahlen laufen in tabellarischer Sans (font-variant-numeric). |
| Marketing-Hero-Effekte, aufwendige Verlaufs-Animationen | nicht übernommen | No-Build-Stack, Performance-/Reduced-Motion-Budget. |
| Paper-Canvas als gleichrangiger Erzählmodus | reduziert auf Light-Theme | Die App ist zustandsgetrieben, nicht editorial; zwei Erzählmodi würden zwei Systeme erzeugen. |

## Offen übernommene funktionale Muster (keine visuellen Quellanteile)

Aus den unterlegenen Konzeptläufen wurden ausschließlich funktions-/zugänglichkeitsbezogene Muster übernommen und hier deklariert: `<details>`-Regelakkordeon mit Wert-Zusammenfassung, `fieldset`/Radio-Presets, nicht-blockierende Regelkonflikt-Box mit Ein-Klick-Auflösungen, `role="progressbar"` mit Geschwister-Label, strikte Reservierung der Zustandsfarben (Statistik nur Ink+Signal), Vertragsvokabular auf jeder Karte, Titelposition in der Wiedergabe-Zone. Diese Muster sind Interaktions-/A11y-Technik, keine Design-DNA einer zweiten visuellen Quelle.

## Nicht verwendete Kandidatenrichtungen

Zwei weitere Single-Source-Konzepte („Signalraum", „Instrument") wurden vollständig ausgearbeitet, unabhängig geprüft und im Auswahl-ADR (ADR-001) mit Gründen abgelehnt. Sie verbleiben im geschützten Arbeitsnachweis.
