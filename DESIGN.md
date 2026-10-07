---
name: true-shuffle
description: Spotify-Sender mit Gedächtnis. One shared player logic, six operating surfaces (Leuchttisch default, Fahrt, Notizblock, Player, Umlauf, Fahrmodus), each with its own structure, control placement and navigation, drawn for day and night.
colors:
  # Leuchttisch (data-design="kontakt", default). Day = lit table and photo paper, night = darkroom.
  kontakt-light-table: "#eeedea"
  kontakt-print-paper: "#f9f8f6"
  kontakt-film-black: "#141210"
  kontakt-film-print: "#f2ede6"
  kontakt-film-print-dim: "#b0a99f"
  kontakt-edge-amber: "#e6b15c"
  kontakt-graphite-quiet: "#5c5853"
  kontakt-paper-hair: "#cfcbc5"
  kontakt-grease-red: "#e2362a"
  kontakt-darkroom: "#0d0b0a"
  kontakt-darkroom-raise: "#161412"
  kontakt-darkroom-print: "#ece6dd"
  kontakt-darkroom-red: "#ff5a3c"
  kontakt-grease-blue: "#4b86f0"
  kontakt-grease-vermilion: "#ff4b2b"
  kontakt-grease-green: "#33c06d"
  kontakt-grease-magenta: "#e05aa8"
  kontakt-grease-orange: "#ff8a1e"
  kontakt-grease-yellow: "#f2c230"
  # Fahrt (data-design="linie"). Day = white signage on station-wall grey, night = midnight enamel.
  linie-station-wall: "#e9edf1"
  linie-signage-white: "#ffffff"
  linie-navy-ink: "#0f1d33"
  linie-navy-quiet: "#4a586c"
  linie-panel-hair: "#c7d0da"
  linie-signal-red: "#e3001b"
  linie-board-amber: "#ffc93c"
  linie-board-quiet: "#b9c4d3"
  linie-enamel-midnight: "#0b1424"
  linie-enamel-raise: "#132038"
  linie-enamel-white: "#f2f5f9"
  linie-night-signal-red: "#ff3349"
  linie-line-blue: "#0066b3"
  linie-line-red: "#d6001c"
  linie-line-green: "#2f8a1f"
  linie-line-violet: "#7b4fa6"
  linie-line-turquoise: "#00827e"
  linie-line-yellow: "#f5c400"
  # Notizblock (data-design="strich"). Day = Karopapier, night = Schultafel.
  strich-squared-paper: "#fbfbf9"
  strich-graphite: "#26292e"
  strich-graphite-quiet: "#5b6169"
  strich-paper-hair: "#cdd6e0"
  strich-grid-blue: "#d9e6f3"
  strich-margin-pink: "#ec8d86"
  strich-correction-red: "#d63a2f"
  strich-highlighter: "#fff17a"
  strich-page-white: "#ffffff"
  strich-slate: "#1d2723"
  strich-slate-raise: "#24302b"
  strich-chalk: "#eef0e9"
  strich-chalk-red: "#ff8f80"
  strich-marker-blue: "#1f5fbf"
  strich-marker-green: "#1d8048"
  strich-marker-violet: "#7a3fb0"
  strich-marker-petrol: "#0e7882"
  strich-marker-ochre: "#e7a600"
  # Player (data-design="klassik"). The canon full player, day and night.
  klassik-ground: "#f5f5f7"
  klassik-card: "#ffffff"
  klassik-label: "#1d1d1f"
  klassik-label-quiet: "#6e6e73"
  klassik-separator: "#d9d9de"
  klassik-violet: "#6a4cff"
  klassik-night: "#121214"
  klassik-night-card: "#1c1c1f"
  klassik-night-label: "#f5f5f7"
  klassik-night-violet: "#8f7bff"
  klassik-accent-blue: "#2f6bff"
  klassik-accent-pink-red: "#ff375f"
  klassik-accent-green: "#1f9d55"
  klassik-accent-violet: "#8e5cff"
  klassik-accent-petrol: "#0a9396"
  klassik-accent-yellow: "#ffb800"
  # Umlauf (data-design="umlauf"). Day = pale sky with indigo ink, night = deep indigo with a warm sun.
  umlauf-pale-sky: "#e8eef7"
  umlauf-cloud-white: "#ffffff"
  umlauf-indigo-ink: "#18204a"
  umlauf-indigo-quiet: "#4d5684"
  umlauf-sky-hair: "#c6cfe2"
  umlauf-sun-orange: "#ff6a13"
  umlauf-night-indigo: "#0d1131"
  umlauf-night-raise: "#161c47"
  umlauf-night-starlight: "#eef0ff"
  umlauf-night-sun: "#ff9a4a"
  umlauf-planet-blue: "#3c6cff"
  umlauf-planet-green: "#14a874"
  umlauf-planet-violet: "#8b5cf6"
  umlauf-planet-petrol: "#0aa0b5"
  umlauf-planet-yellow: "#f2b705"
  # Fahrmodus (data-design="fahrmodus"). Day = black on signal yellow, night = signal yellow on black.
  fahrmodus-signal-yellow: "#ffd100"
  fahrmodus-yellow-raise: "#ffe259"
  fahrmodus-road-black: "#0b0b0b"
  fahrmodus-umber-quiet: "#2f2a10"
  fahrmodus-warning-red: "#a10a0a"
  fahrmodus-night-black: "#000000"
  fahrmodus-night-quiet: "#e6c44a"
  fahrmodus-bar-blue: "#0047ab"
  fahrmodus-bar-red: "#c1121f"
  fahrmodus-bar-green: "#006b3c"
  fahrmodus-bar-violet: "#5a189a"
  fahrmodus-bar-petrol: "#00525e"
  # Shared shell utilities (base.css fallbacks every design can override).
  shell-focus-blue: "#1f4fd0"
  shell-danger: "#b3261e"
typography:
  kontakt-display:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "clamp(2.2rem, 10.5vw, 3.6rem)"
    fontWeight: 820
    lineHeight: 0.96
    letterSpacing: "-0.035em"
  kontakt-body:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  kontakt-edge-print:
    fontFamily: "Martian Mono Variable, Martian Mono, ui-monospace, monospace"
    fontSize: "0.66rem"
    fontWeight: 500
    letterSpacing: "0.04em"
  linie-display:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "clamp(1.5rem, 6.4vw, 2.4rem)"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.015em"
  linie-body:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  linie-board-legend:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "0.74rem"
    fontWeight: 800
    letterSpacing: "0.04em"
  strich-display:
    fontFamily: "Bricolage Grotesque Variable, Bricolage Grotesque, system-ui, sans-serif"
    fontSize: "clamp(1.7rem, 7.5vw, 2.8rem)"
    fontWeight: 800
    lineHeight: 0.98
    letterSpacing: "-0.035em"
  strich-body:
    fontFamily: "Bricolage Grotesque Variable, Bricolage Grotesque, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  klassik-display:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Segoe UI, Roboto, system-ui, sans-serif"
    fontSize: "clamp(1.5rem, 6.2vw, 2.1rem)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  klassik-body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Roboto, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  umlauf-display:
    fontFamily: "Lexend Variable, Lexend, system-ui, sans-serif"
    fontSize: "clamp(1.7rem, 7.6vw, 2.8rem)"
    fontWeight: 640
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  umlauf-body:
    fontFamily: "Lexend Variable, Lexend, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  fahrmodus-display:
    fontFamily: "Fahrmodus Dot, Overpass Variable, Overpass, system-ui, sans-serif"
    fontSize: "clamp(2.6rem, 13vw, 5.4rem)"
    fontWeight: 900
    lineHeight: 0.98
    letterSpacing: "-0.03em"
  fahrmodus-body:
    fontFamily: "Fahrmodus Dot, Overpass Variable, Overpass, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  fahrmodus-key-label:
    fontFamily: "Fahrmodus Dot, Overpass Variable, Overpass, system-ui, sans-serif"
    fontSize: "1.8rem"
    fontWeight: 900
  utility-mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.85rem"
rounded:
  kontakt-key: "2px"
  kontakt-panel: "3px"
  kontakt-art: "1px"
  linie-key: "8px"
  linie-panel: "14px"
  linie-art: "6px"
  linie-main: "999px"
  strich-key: "10px 4px 12px 5px / 5px 12px 4px 10px"
  strich-panel: "16px 6px 18px 8px / 8px 18px 6px 16px"
  strich-main: "14px 6px 16px 7px / 7px 16px 6px 14px"
  strich-art: "3px"
  klassik-key: "12px"
  klassik-panel: "18px"
  klassik-sheet: "28px"
  klassik-art: "12px"
  umlauf-panel: "26px"
  umlauf-pill: "999px"
  umlauf-round: "50%"
  fahrmodus-key: "10px"
  fahrmodus-panel: "16px"
  fahrmodus-tile: "18px"
  fahrmodus-art: "8px"
spacing:
  gutter-phone: "16px"
  gutter-compact: "14px"
  gutter-tablet: "24px"
  gutter-desktop: "32px"
  gap: "24px"
  gap-desktop: "32px"
  stage-pad: "18px"
  stage-pad-desktop: "28px"
  key: "52px"
  key-compact: "46px"
  main-key-height: "64px"
  dock-key-height: "56px"
components:
  key:
    padding: "10px 18px"
    height: "48px"
  kontakt-dock-main:
    backgroundColor: "{colors.kontakt-film-print}"
    textColor: "{colors.kontakt-film-black}"
    rounded: "{rounded.kontakt-key}"
    height: "56px"
  kontakt-dock:
    backgroundColor: "{colors.kontakt-film-black}"
    textColor: "{colors.kontakt-film-print}"
    padding: "10px 16px"
  linie-board:
    backgroundColor: "{colors.linie-navy-ink}"
    textColor: "{colors.linie-signage-white}"
    padding: "10px 16px"
  linie-board-main:
    backgroundColor: "{colors.linie-signage-white}"
    textColor: "{colors.linie-navy-ink}"
    rounded: "{rounded.linie-main}"
    height: "56px"
  linie-stop-panel:
    backgroundColor: "{colors.linie-signage-white}"
    rounded: "{rounded.linie-panel}"
    padding: "16px 16px 18px"
  strich-entry:
    backgroundColor: "{colors.strich-page-white}"
    textColor: "{colors.strich-graphite}"
    rounded: "{rounded.strich-panel}"
    padding: "22px 18px 20px"
  strich-main:
    backgroundColor: "{colors.strich-graphite}"
    textColor: "{colors.strich-squared-paper}"
    rounded: "{rounded.strich-main}"
    height: "64px"
  klassik-play:
    backgroundColor: "{colors.klassik-label}"
    textColor: "{colors.klassik-ground}"
    rounded: "50%"
    size: "76px"
  klassik-up-sheet:
    backgroundColor: "{colors.klassik-card}"
    rounded: "{rounded.klassik-sheet}"
    padding: "28px 16px 24px"
  umlauf-play:
    backgroundColor: "{colors.umlauf-sun-orange}"
    textColor: "{colors.umlauf-indigo-ink}"
    rounded: "{rounded.umlauf-round}"
    size: "96px"
  umlauf-key:
    backgroundColor: "{colors.umlauf-cloud-white}"
    textColor: "{colors.umlauf-indigo-ink}"
    rounded: "{rounded.umlauf-round}"
    size: "52px"
  fahrmodus-play-tile:
    backgroundColor: "{colors.fahrmodus-road-black}"
    textColor: "{colors.fahrmodus-signal-yellow}"
    typography: "{typography.fahrmodus-key-label}"
    rounded: "{rounded.fahrmodus-tile}"
    height: "112px"
  fahrmodus-key-tile:
    textColor: "{colors.fahrmodus-road-black}"
    rounded: "{rounded.fahrmodus-tile}"
    height: "92px"
  fahrmodus-sender-card:
    textColor: "{colors.fahrmodus-road-black}"
    rounded: "{rounded.fahrmodus-panel}"
    padding: "16px 18px 12px"
---

# Design System: true-shuffle

## Overview

**Creative North Star: "Six Instruments, One Memory"**

true-shuffle ships one player and six ways to hold it. `src/client/screens/home.tsx` builds every part once (stage head, cover, title copy, progress, the requested/accepted/confirmed signal, the transport keys, device panel, queue, Sender list) with identical labels, handlers and honest states; `src/client/screens/home-layouts.tsx` then arranges those parts into six layouts that each own their structure, control placement and navigation. A design is chosen per device under Menü > Gestaltung (stored as `ts-design` in localStorage, openable by `?design=<id>`, painted as `data-design` on the root together with favicon and browser-bar colour). Day and night follow `prefers-color-scheme` unless `data-illumination` pins one; every design is fully drawn in both. Nothing functional depends on the choice. Name, voice, colour-slot table and icon pipeline live in `docs/BRAND.md`; this file records the visual system as built.

The six are worlds, not skins. **Leuchttisch** (`kontakt`, default) is a lit table: the current song lies large as a slide-mounted frame boxed in grease pencil, the Sender are film tabs, the queue is a contact sheet, and the transport sits in a film-black dock fixed at the bottom. **Fahrt** (`linie`) is one unbroken line: heard stops from stored history struck through above, the current stop as an interchange ring, the device panel beside the line, queue stops below, and a departure-board dock naming "Nächster Halt" in amber. **Notizblock** (`strich`) is Karopapier or Tafel: a big tally of the round, the song as an entry card (title first), a tick-off queue and filled register tabs. **Player** (`klassik`) is the canon full player: big cover, round play key, queue as a sheet with a grabber, cover shelf, bottom tab bar on phones, set in the platform face because that is the canon's native voice. **Umlauf** (`umlauf`) draws the round as an orbit of ticks around a circular cover with a big round play key in the page centre and Sender as small orbits. **Fahrmodus** (`fahrmodus`) is the car and one-hand mode: huge title, full-width play tile, three big square keys, big Sender cards, black on signal yellow.

Density is phone-first and glanceable: in every design the song and the main key are inside the first phone viewport, and the screen is meant to be open for seconds. The rejected direction was one shared layout reskinned in four colourways; the system now refuses any new design that only changes tokens.

**Key Characteristics:**
- One shared part set, six layouts; each layout owns structure, control placement and navigation.
- Every design has a full day and night palette and its own brand mark, favicon and app icon.
- Unconfirmed state is never printed like confirmed state: outlined or dimmed titles, hatched progress, dashed or dotted signal steps, dashed disabled keys.
- The Sender colour (`--st`) is the one accent per screen, applied in each world's own material (grease pencil, line colour, marker, accent, planet, bar).
- Round progress is drawn as a world-native meter (barcode, line, tally, ring, orbit) and always floored, never rounded up.

## Colors

Each design is a closed palette of ground, raised surface, ink, quiet ink, hairline, one brand colour and six Sender inks, with a dedicated night set; designs never borrow each other's colours.

### Primary
- **Grease Red** (kontakt-grease-red): Leuchttisch brand: mark stroke, active nav underline, first contact-sheet number, cursor. Night lifts to Darkroom Red.
- **Signal Red** (linie-signal-red): Fahrt brand: the line in the mark and the nav underline. Night: Night Signal Red.
- **Correction Red** (strich-correction-red): Notizblock brand and the cross-stroke of every fifth tally mark. Night: Chalk Red.
- **Player Violet** (klassik-violet): Player brand tile, focus ring and selection. Night: Night Violet.
- **Sun Orange** (umlauf-sun-orange): Umlauf brand, the main round key, the current-position dot on the orbit. Night: Night Sun.
- **Road Black on Signal Yellow** (fahrmodus-road-black, fahrmodus-signal-yellow): Fahrmodus brand is the inversion itself; the main tile and selected Sender card are ink-filled, and at night the pair swaps.

### Secondary (Sender inks)
- **Six Sender slots per design** (kontakt-grease-*, linie-line-*, strich-marker-* plus Correction Red, klassik-accent-*, umlauf-planet-* plus Sun Orange, fahrmodus-bar-*): a Sender keeps its slot across all designs; "Alles" takes the page ink. The slot table is maintained in `docs/BRAND.md` and the CSS variables `--ink-ultra … --ink-yellow`; night variants are recorded in the sidecar.

### Tertiary (world materials)
- **Film Black / Film Print / Edge Amber** (kontakt-film-black, kontakt-film-print, kontakt-edge-amber): the film strip of the stage, Sender tabs, contact sheet and dock; edge-amber prints frame numbers.
- **Board Navy / Board Amber** (linie-navy-ink, linie-board-amber): the departure-board dock and its next-title line.
- **Grid Blue / Margin Pink / Highlighter** (strich-grid-blue, strich-margin-pink, strich-highlighter): the 20px Karopapier grid, the red margin rule on wide pages, selection.

### Neutral
- **Grounds**: Light Table, Station Wall, Squared Paper, Player Ground, Pale Sky, Signal Yellow (day); Darkroom, Enamel Midnight, Slate, Player Night, Night Indigo, Night Black (night).
- **Raised surfaces**: Print Paper, Signage White, Klassik Card, Cloud White, Yellow Raise; each with its night raise.
- **Ink and quiet ink**: Film Black/Graphite Quiet, Navy Ink/Navy Quiet, Graphite/Graphite Quiet, Label/Label Quiet, Indigo Ink/Indigo Quiet, Road Black/Umber Quiet.
- **Hairlines**: Paper Hair, Panel Hair, Paper Hair (strich), Separator, Sky Hair; Fahrmodus uses 25% black instead of a hair colour.

### Named Rules
**The One Sender Rule.** The only saturated accent on a listening screen besides the brand mark is the current Sender's ink (`--st`); everything else is ground, ink and hairline.

**The Closed Palette Rule.** A design's colours live under its own `:root[data-design="…"]` block with a full night set in both `[data-illumination="night"]` and `prefers-color-scheme: dark`; a new colour is added to all three places or not at all.

**The Bar Not Background Rule.** In Fahrmodus the Sender colour appears only as a thick bar or line, never behind text.

## Typography

**Display/Body Fonts:** one face per design, self-hosted variable fonts imported in `src/client/main.tsx`: Hanken Grotesk (Leuchttisch), Atkinson Hyperlegible Next (Fahrt), Bricolage Grotesque (Notizblock), Lexend (Umlauf), Overpass (Fahrmodus); Player uses the platform face (SF Pro / Segoe UI / Roboto) with no webfont.
**Label/Mono Font:** Martian Mono, Leuchttisch only, for edge print. System monospace as a utility only.

**Character:** each world speaks in one voice and does every job in it: headline, body, keys and numbers share the face. Contrast comes from weight and size, not from a second family.

### Hierarchy
- **Display (song title)**: the largest type on the screen in every design, set at the design's display weight and tight tracking (frontmatter `*-display`). Fahrmodus is the extreme (up to 5.4rem phone, 6rem desktop); Player is the quietest (up to 2.1rem). Desktop steps: Leuchttisch clamp(2.4rem, 3.2vw, 3.4rem), Notizblock clamp(2.2rem, 3vw, 3.2rem), Fahrt clamp(1.9rem, 2.6vw, 2.8rem).
- **Headline (section heads, Sender name on the stage)**: design head weight (700 to 850), roughly 1 to 2.4rem; Notizblock sets the Sender name at clamp(1.6rem, 7vw, 2.4rem) as the page heading.
- **Title (artist)**: 1 to 1.5rem, weight 500 to 800, under or beside the song title.
- **Body** (400, 1rem, line-height 1.5): notes, device panel, settings. Quiet ink for album and saved-note copy (0.8 to 0.95rem).
- **Label** (design label weight 560 to 750, 0.72 to 0.95rem, sentence case): signal steps, progress labels, Sender meta. Fahrmodus enlarges labels (1.1 to 1.25rem, 800+).

### Named Rules
**The One Voice Rule.** A design uses one family for everything except Leuchttisch's Martian Mono edge print (frame numbers, times, counts, signal steps). No design pairs a display face with a separate text face.

**The Utility Mono Rule.** `ui-monospace, "SF Mono", Menlo, monospace` appears only for code input and diagnostics (`.input--code`, `.code`, `.diagnostic-data`); it is never a design voice.

**The Canon Voice Rule.** Player's platform face is a cited choice: the canon is the native music app and SF/Roboto is its voice. It is not a fallback and not a licence to use system faces as display type elsewhere.

**The Dot Fallback Rule.** "Fahrmodus Dot" is an `@font-face` that maps only U+00B7 ("·") to a local system sans because Overpass sets the middle dot hard against the next word. It is a glyph fallback, not a type role; never set text in it on purpose.

## Layout

The shared shell (`base.css`) owns structure and spacing; the six layouts own arrangement. Gutters are 16px on phones (14px under 380px, where keys shrink to 46px), 24px from 560px and 32px from 900px; the section gap is 24px, 32px from 900px. Breakpoints in use: 360, 380, 420, 560, 900 and 1100px; multi-column listening layouts start at 1100px on a 12-column grid.

- **Leuchttisch**: phone order is stage (frame, title), device, film tabs, contact sheet, with the dock fixed at the bottom (reserved height 172px phone, 96px desktop). Desktop: slide left, Sender tabs and contact sheet (auto-fill 150px frames) right; the dock spreads progress, signal and keys into three columns.
- **Fahrt**: one 8px line in the Sender colour runs 14px from the left edge through past stops, the current stop, the device panel and the queue, fading out after the last stop; everything hangs beside it at a fixed indent. The board dock is fixed at the bottom (150px reserved). Desktop: line column, device side column, network column.
- **Notizblock**: Sender tabs across the top on phones, then the tally, entry card and tick-off queue; from 1100px the tabs stand as a sticky side column at the right edge of the page, and a margin rule appears from 900px.
- **Player**: the stage fills the first phone screen (cover capped at min(100%, 420px, 30vh)); the queue sheet and cover shelf follow; the nav becomes a fixed bottom tab bar under 900px. Desktop: player and queue sheet side by side, cover shelf full width below.
- **Umlauf**: everything centred on the page axis; the orbit is min(64vw, 268px). Desktop: player column (7 of 12) with Sender orbits and queue to the right.
- **Fahrmodus**: single column of big rows; the nav becomes a fixed black bottom tab bar under 900px. Desktop: player 8 of 12 with Sender cards 4 of 12.

**The First Viewport Rule.** On a phone, the song title and the main play key are visible without scrolling in every design; docked keys (Leuchttisch, Fahrt) and bottom tab bars (Player, Fahrmodus) reserve bottom padding so nothing hides behind them.

## Elevation & Depth

Depth is world-motivated and mostly soft; most designs are flat with hairlines and tonal surfaces. Shadows appear where a physical object sits on a surface (a slide on a lit table, a signage panel, a cover, a sheet) and as the lift of fixed docks and dialogs. There are no hard offset shadows anywhere.

### Shadow Vocabulary
- **Slide on the table** (`box-shadow: 0 18px 40px -24px rgb(0 0 0 / 0.55)`): Leuchttisch current frame.
- **Signage panel** (`box-shadow: 0 1px 0 var(--hair), 0 14px 34px -22px rgb(15 29 51 / 0.45)`): Fahrt current stop; other Fahrt panels use the hairline step alone.
- **Cover lift** (`box-shadow: 0 22px 48px -22px rgb(0 0 0 / 0.55)`): Player cover; Umlauf uses `0 24px 50px -28px rgb(13 17 49 / 0.65)` on its round cover.
- **Sun glow** (`box-shadow: 0 18px 36px -18px color-mix(in srgb, var(--brand) 70%, transparent)`): Umlauf main key only.
- **Dock lift** (`box-shadow: 0 -12px 32px -20px rgb(0 0 0 / 0.5)`): fixed transport docks; Player's sheet uses `0 -18px 40px -30px`.
- **Dialog** (`box-shadow: 0 24px 60px -20px rgb(0 0 0 / 0.5)` with a 55% black backdrop): rating sheet.
- **Ring** (`box-shadow: 0 0 0 Npx …`): selection and outline rings (Fahrmodus cover 3px, Notizblock and Player selection 2px); a stroke, not elevation.

### Named Rules
**The Object Shadow Rule.** A shadow means a physical object resting on the world's surface or a fixed panel above content; flat list rows, keys and labels carry none.

## Shapes

Every design declares its corner language as tokens (`--r`, `--r-lg`, `--r-art`, `--r-main`) and line weights (`--bw`, `--rule-w`). Leuchttisch is nearly square (1 to 3px), like film and prints. Fahrt uses signage corners (8px keys, 14px panels) with a pill main key and circles for stops; its lines bend only at 45 and 90 degrees. Notizblock draws boxes by hand: elliptical radii whose corners do not quite agree, and a selection circle drawn as an irregular ellipse. Player is the platform's rounded rectangle (12/18px), a 28px sheet top and a circular play key. Umlauf is round throughout: circular cover, circular keys, pill links, 26px panels. Fahrmodus uses heavy outlined tiles (18px corners, 3 to 4px strokes) and square-ended progress.

**The Native Mark Rule.** Each design's brand mark, round meter and stage art come from its own material (film frame with perforation, line with a 45 degree bend, four strokes and a red cross, resume arrow on violet, orbit with moon, yellow play on a black sign); they are SVG and never typed glyphs.

## Components

### Buttons
- **Shape:** the design's `--r`; main key uses `--r-main`.
- **Primary (main key, Fortsetzen/Pause):** ink-filled (`--main-bg`/`--main-fg`), at least 64px tall (56px in docks). Leuchttisch: film-print key in the film dock. Fahrt: white pill on the navy board. Notizblock: graphite fill inside the entry card. Player: 76px circle, icon only. Umlauf: 96px sun-orange circle in the page centre. Fahrmodus: full-width 112px tile with 1.8rem label.
- **Icon keys (Weiter, Favorit, nie wieder):** 52px square or circle with SVG icons; pressed state fills with the lit colour or the Sender ink (Player colours the icon instead of filling). Fahrmodus makes them three 92px square tiles with 4px strokes.
- **Hover / Focus:** hover tints the background (`--key-hover-bg`); focus is a 3px `--focus` outline at 3px offset in every design; transitions run 180ms on `cubic-bezier(0.16, 1, 0.3, 1)`.
- **Disabled main key (held, offline, not ready):** transparent with a dashed outline, never the solid key.

### Chips
- **Line badge:** Fahrt only; the Sender as S1, S2 … ("A" for Alles) on a line-coloured badge.

### Cards / Containers
- **Stage:** design-specific: film strip (Leuchttisch), signage panel beside the line (Fahrt), entry card with 2px graphite border (Notizblock), transparent on the page (Player, Umlauf, Fahrmodus).
- **Sender:** film tabs with a 5px Sender-ink top edge (Leuchttisch), network lines (Fahrt), filled register tabs with the chosen one circled, never struck (Notizblock), cover shelf with a 3px Sender outline when chosen (Player), small orbits with their own progress ring (Umlauf), big outlined cards inverting to black when chosen (Fahrmodus).
- **Queue:** contact-sheet grid of frames with edge-amber numbers (Leuchttisch), stops on the line (Fahrt), numbered rows with a hand-drawn tick box (Notizblock), sheet with a 40×5px grabber (Player), round thumbnails (Umlauf), big rows (Fahrmodus).

### Inputs / Fields
- **Style:** `--raise` fill, design border width and radius; Fahrmodus device select is 64px tall with a 3px stroke. Code inputs use the utility mono.
- **Focus:** the shared 3px outline.

### Navigation
- **Top nav** (Hören, Verlauf, Menü) with a brand-coloured underline on the active item; Player and Fahrmodus move it to a fixed bottom tab bar under 900px (Player translucent with blur, Fahrmodus solid ink with 60px tabs). Fahrt adds "Linie wechseln", which scrolls to the network.

### Honest-state signal (shared doctrine, per-world rendering)
Shared parts carry the state classes (`stage--pending`, `stage--estimate`, `progress-area--held|estimate`, `signal--wait|estimate|error`); each design renders them in its own material:
- **Signal requested → accepted → confirmed:** three steps. Default: top bars, dashed while waiting, dotted when estimated, double in danger on error. Fahrt: three stops on a short line with dashed segments while waiting. Notizblock: three hand-drawn tick boxes. Leuchttisch: Martian Mono steps in the dock.
- **Held or estimated progress:** hatched at 135 degrees, never a solid bar.
- **Pending or estimated title:** outlined glyphs (transparent fill with a stroke; 2px in Fahrmodus); Leuchttisch also dashes the grease box; Umlauf dims the cover with a dashed outline; Player sets the title in quiet italic and dims the cover to 55%.
- **Estimates are display-only:** the clock advances locally; Fahrt reads stored history only when the saved occurrence changes, never for an estimate.

### Departure board (Fahrt signature)
A navy dock with a Sender-coloured "Nächster Halt" legend and the next saved title in Board Amber beside the keys; when nothing is planned it reads "Ende der gespeicherten Strecke".

### Orbit (Umlauf signature)
96 ticks around the round cover (a long tick every eighth), heard ticks lit in the Sender ink and floored, a sun-orange dot at the current position.

## Do's and Don'ts

### Do:
- **Do** build a new screen from the shared parts in `home.tsx` and give each design its own arrangement in `home-layouts.tsx`; labels, handlers and states stay identical.
- **Do** define every new colour per design for day, `[data-illumination="night"]` and `prefers-color-scheme: dark`.
- **Do** render requested, accepted and confirmed differently, and keep held or estimated progress hatched (`repeating-linear-gradient(135deg, …)`).
- **Do** floor round progress in every meter (`Math.floor`), and show the numbers beside it.
- **Do** keep the song and the main key in the first phone viewport and reserve bottom space for docks and tab bars.
- **Do** write the name as lowercase "true-shuffle", set in the active design's face with its mark before it.

### Don't:
- **Don't** ship a design that only swaps tokens over another design's layout; the owner rejected exactly that.
- **Don't** print a pending or estimated title as solid confirmed type, or a disabled main key as a filled key.
- **Don't** let a display-only estimate trigger a request or change the saved occurrence.
- **Don't** set any design's voice in system monospace; it is for code and diagnostics only.
- **Don't** treat "Fahrmodus Dot" as a type role or the Player platform face as a general fallback display face.
- **Don't** put the Sender colour behind text in Fahrmodus.
- **Don't** mark a chosen Sender in Notizblock with a strike; a strike means done on that page, so chosen is circled.
- **Don't** use hard offset shadows; depth is soft object shadow, hairline or ring.
