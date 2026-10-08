# true-shuffle — Marke

Stand 2026-10-08. Gilt für die App (`src/client`) und alles, was nach außen zeigt.
Es gibt **ein** Gestaltungssystem, die Mixtape-Welt. Wählbar ist nur Hell, Dunkel
oder Automatisch (Mehr → App → Darstellung, lokal unter `ts-illumination`). Eine
früher gespeicherte Designwahl (`ts-design`) wird still ignoriert.

## Kern

**Was es ist:** deine Playlists als Kassetten. Jede Kassette spielt in fester
Reihenfolge, jeder Song kommt einmal dran, nichts wiederholt sich schnell, und die
Stelle geht nie verloren.

**Versprechen in einem Satz:** *Kassette einlegen, Fortsetzen drücken. true-shuffle merkt sich den Rest.*

**Haltung**

1. **Das Bild trägt die Fakten.** Die Spulen zeigen den echten Anteil der gehörten Songs, das
   Zählwerk zählt sie, das Etikett trägt den Kassettennamen. Nichts ist nur Dekoration.
2. **Ehrlich.** Angefordert, angenommen und bestätigt sind drei Dinge und sehen verschieden aus.
   Durchgezogen grün nur bei bestätigter Wiedergabe, gestrichelt heißt warten, gepunktet heißt
   geschätzt. Kennzeichen beantworten zwei Fragen getrennt: woher der Song kommt („Aus deiner
   Playlist“, „Empfehlung“, „Favorit“) und was aufgezeichnet ist („noch nicht gehört“, „3× gehört“,
   „lange nicht hier“).
3. **Kurz hinschauen, tippen, weg.** Deck, Song, ein Satz zum Zustand, die Tasten. Alles andere
   steht darunter.
4. **Nie gegen den Hörer.** Was jemand sonst in Spotify macht, bleibt unangetastet.

## Name

- Immer **true-shuffle**: klein, mit Bindestrich. Nie in Großbuchstaben, auch nicht auf Etiketten.
- Das Zeichen ist eine Kassette (Gehäuse, zwei Spulen, Band) links vor dem Namen.

## Sprache

- Deutsch, du-Form, Satzschreibung, Alltagswörter.
- Feste Begriffe: **Kassette** (ein Sender), **Durchgang** (jeder Song einmal, dann von vorn),
  **Einlegen**, **Fortsetzen**, **Neu mischen** (bewusst, mit Bestätigung), **Als Nächstes**,
  **Mischung** (Entdecker · Ausgewogen · Vertraut), **Favorit**, **Nie wieder**, **Gast-Modus**,
  **Lieblingssongs**, **Hörverlauf importieren**.
- Nicht mehr verwenden: „Gedächtnis“, „Runde“, „Suchlauf“, „Sendersuchlauf“, „Bedienflächen“.
- Tasten nennen ihre Handlung. Fehler nennen das Problem und den nächsten Schritt. Sagen, was
  Spotify tut, nichts erfinden, keine Erfolgszahlen ohne Beleg.

## Die Welt

Vorbild (Besitzer, 2026-10-08): ein Mixtape-Soundtrack-Cover mit Messing-Kassettendeck. Name
und Zeichen des Films werden nie verwendet.

| Teil | Gestaltung |
|---|---|
| **Jetzt** | Messing-Deck (nachts dunkle Bronze): Zählwerk, Statuslampe, Fach mit rauchig durchscheinender Kassette, darunter vier Tasten mit gezeichneter Kante; die Fortsetzen/Pause-Taste hat eine orange Kante. |
| **Kassetten** | Kassetten stehen in einem Regal, jede mit eigener Etikettfarbe; „Einlegen“ legt sie ins Deck, gespielt wird erst auf Tastendruck. |
| **Listen** | Die Einlegekarte der Kassette: Papier, Etikettstreifen oben, Songtitel in blauer Kugelschreiber-Tinte, Kennzeichen als Filzstift-Notizen. |
| **Überschriften** | Prägeband-Etiketten. |
| **Knöpfe, Navigation** | Tasten wie am Deck; die aktuelle Seite ist die gedrückte Taste. |

### Farben

| Rolle | Hell | Dunkel |
|---|---|---|
| Grund (Einlegekarte / Regal) | `#e7dcc4` | `#17120d` |
| Papier | `#f4ecda` | `#221a12` |
| Text | `#2a2017` | `#f1e6cf` |
| Etikettrot (Akzent) | `#c2412a` | `#ef6b4a` |
| Kugelschreiber | `#24448c` | `#a9bef2` |
| Deck | `#d9a75f` | `#5a4329` |
| Taste / gedrückt | `#efd09a` / `#f6deb2` | `#7b5e3e` / `#664c2f` |
| Hotline-Kante | `#e2622a` | `#e2622a` |

Etikettfarben der Kassetten: Rot, Blau, Grün, Orange, Petrol, Violett (nach Kassetten-ID);
„Alles“ trägt schwarze Streifen mit rotem Band.

### Schriften

- **Bricolage Grotesque**: Überschriften und Songtitel.
- **Atkinson Hyperlegible Next**: alles zum Lesen.
- **Permanent Marker**: nur Kassettenetiketten und Filzstift-Notizen.

### App-Icon

Quelle ist `src/client/public/icon.svg` (Kassette auf dem Deck). `npm run icons` rendert
daraus 192, 512 und 180 px (Apple). Manifest und `theme-color` folgen den Grundfarben oben.
