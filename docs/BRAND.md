# true-shuffle — Marke

Stand 2026-10-07. Gilt für die App (`src/client`) und alles, was nach außen zeigt.
Das Aussehen gibt es in vier Gestaltungen, die im Menü unter **Gestaltung**
umschaltbar sind. Eine davon wird die Hausgestaltung, sobald der Besitzer sich
entschieden hat. Name, Haltung und Sprache unten gelten für alle vier.

## Kern

**Was es ist:** Spotify-Sender mit Gedächtnis. Jeder Song wird gemerkt, nichts
wiederholt sich schnell, alles kommt irgendwann dran.

**Versprechen in einem Satz:** *Start drücken und hören. true-shuffle merkt sich den Rest.*

**Haltung**

1. **Erinnern statt mischen.** Das Produkt ist Gedächtnis plus Planer. Die Gestaltung zeigt, wie weit
   eine Runde ist und was als Nächstes kommt.
2. **Ehrlich.** Angefordert, angenommen und bestätigt sind drei verschiedene Dinge und sehen auch
   verschieden aus. Unbestätigtes ist nie massiv gefüllt (gestrichelt, schraffiert, Kontur).
   Zahlen werden nie aufgerundet.
3. **Kurz hinschauen, tippen, weg.** Der Bildschirm ist Sekunden offen, die Musik läuft Stunden.
   Song und Play/Pause stehen immer zuerst.
4. **Nie gegen den Hörer.** Was jemand sonst in Spotify macht, bleibt unangetastet.

## Name

- Immer **true-shuffle**: klein, mit Bindestrich.
- Nie „True Shuffle“, „TRUE-SHUFFLE“, „Trueshuffle“ oder „TS“ als Name.
- Die Wortmarke wird in der Schrift der aktiven Gestaltung gesetzt, mit dem Zeichen links davor.

## Sprache

- Deutsch, du-Form, Satzanfänge groß, sonst Satzschreibung.
- Feste Begriffe: **Sender**, **Runde**, **Als Nächstes**, **Entdecken ↔ Vertraut**,
  **Neuentdeckung**, **Favorit**, **Gast-Modus**, **Lieblingssongs**.
- Tasten nennen ihre Handlung („Fortsetzen“, „Neue Warteschlange beginnen“).
  Fehler nennen das Problem und den nächsten Schritt.
- Sagen, was Spotify tut („Kein Spotify-Gerät sichtbar. Öffne Spotify auf deinem Gerät.“),
  nichts erfinden, keine Erfolgszahlen ohne Beleg.

## Die vier Gestaltungen

Alle vier teilen dieselbe Oberfläche: Kopfzeile mit Hören/Verlauf/Menü, die Bühne mit Song und
Steuerung, das Gerät, *Als Nächstes* und die Sender. Jede Welt bringt nur Schrift, Farben,
Dichte und **ein** Erkennungsmerkmal mit.

| Gestaltung | Welt | Schrift | Erkennungsmerkmal | Zeichen |
|---|---|---|---|---|
| **Kontaktbogen** (Standard) | Fotopapier am Tag, Dunkelkammer in der Nacht | Hanken Grotesk, Martian Mono nur für Bildnummern, Zeiten, Zählungen | Der laufende Song als Bild auf dem Filmstreifen, im Fettstift-Rahmen der Senderfarbe, die nächsten Bilder daneben. Die Runde als Strichcode. | Filmbild mit Perforation und rotem Fettstift-Rahmen |
| **Linienplan** | Weiße Stationsschilder, nachts Emaille-Mitternachtsblau | Atkinson Hyperlegible Next | Jeder Sender ist eine Linie (S1, S2 …, „Alles“ = A). *Als Nächstes* fährt Station für Station die Linie hinunter. | Rote Linie mit 45°-Knick durch einen Umsteigehalt |
| **Strichliste** | Karopapier, nachts Schultafel | Bricolage Grotesque | Die Runde in Fünferbündeln gezählt, ein Markerstrich unter dem Songtitel, Häkchen für den Befehlsstand | Vier Striche, der fünfte rot quer |
| **Klassisch** | Vertrauter Musik-Player | Systemschrift (SF / Segoe / Roboto) | Großes Cover in der Mitte, runde Play-Taste | Weißer Fortsetzen-Pfeil um ein Play-Dreieck auf Violett |

### Farben

Jede Gestaltung hat sechs Senderfarben. Ein Sender behält seinen Platz in allen
Gestaltungen (gleiche ID, gleicher Farbplatz). „Alles“ nimmt die Seitenfarbe.

| Platz | Kontaktbogen (Fettstift) | Linienplan (Linie) | Strichliste (Marker, Tag) | Klassisch (Akzent) |
|---|---|---|---|---|
| 1 | Blau `#4b86f0` | Blau `#0066b3` | Blau `#1f5fbf` | Blau `#2f6bff` |
| 2 | Rot `#ff4b2b` | Rot `#d6001c` | Rot `#d63a2f` | Rosa-Rot `#ff375f` |
| 3 | Grün `#33c06d` | Grün `#2f8a1f` | Grün `#1d8048` | Grün `#1f9d55` |
| 4 | Magenta `#e05aa8` | Violett `#7b4fa6` | Violett `#7a3fb0` | Violett `#8e5cff` |
| 5 | Orange `#ff8a1e` | Türkis `#00827e` | Petrol `#0e7882` | Petrol `#0a9396` |
| 6 | Gelb `#f2c230` | Gelb `#f5c400` | Ocker `#e7a600` | Gelb `#ffb800` |

Markenfarbe (Zeichen, aktive Navigation, Cursor): Kontaktbogen Fettstift-Rot `#e2362a`,
Linienplan Signalrot `#e3001b`, Strichliste Korrekturrot `#d63a2f`, Klassisch Violett `#6a4cff`.
Hell und dunkel sind in jeder Gestaltung vollständig ausgearbeitet und folgen dem Gerät,
außer „Hell & dunkel“ im Menü ist auf Tag oder Nacht gestellt.

### App-Icons

Quelle ist je Gestaltung `src/client/public/brand/<gestaltung>/icon.svg`. `npm run icons`
rendert daraus 192, 512 und 180 px (Apple) und kopiert den Satz der Standardgestaltung
nach `src/client/public/` für das Manifest. Das Favicon im Browser wechselt mit der Gestaltung.
Auf dem Home-Bildschirm bleibt das Icon, das beim Hinzufügen aktiv war.

## Hausgestaltung festlegen

Wenn eine Gestaltung gewinnt:

1. `DEFAULT_DESIGN` in `src/client/design.ts` setzen und `DEFAULT` in `scripts/render-icons.mjs`.
2. `npm run icons`, `manifest.webmanifest` (`theme_color`, `background_color`) und die
   `theme-color`-Metas in `src/client/index.html` anpassen.
3. Optional die anderen drei Gestaltungen entfernen: ihre CSS-Datei unter `src/client/styles/`,
   ihren Eintrag in `DESIGNS` und ihre Zweige in `components/brand.tsx`.
   Funktional hängt nichts an der Gestaltung.
