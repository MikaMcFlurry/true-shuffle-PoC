---
name: True Shuffle
description: The station memory of a car radio, in two illuminations.
colors:
  # Day illumination (default; light-grey moulded faceplate, reflective LCD)
  plate: "#d3d6da"
  plate-deep: "#c4c8cd"
  key: "#e8eaed"
  key-hover: "#f1f2f4"
  key-press: "#dcdfe3"
  seam: "#b4b9bf"
  seam-soft: "#c7cbd0"
  ink: "#15181c"
  ink-2: "#454b53"
  ink-3: "#5f666f"
  lcd: "#b3bb9f"
  lcd-ink: "#161a10"
  lcd-ink-2: "#39402d"
  lcd-ghost: "rgba(22, 26, 16, 0.12)"
  lit: "#c2560c"
  lit-ink: "#ffffff"
  lit-soft: "rgba(194, 86, 12, 0.14)"
  danger: "#a8231a"
  danger-ink-day: "#7d140c"
  danger-soft: "rgba(168, 35, 26, 0.1)"
  focus: "#0b5fd1"
  # Night illumination (anthracite faceplate, backlit amber LCD)
  plate-night: "#16181b"
  plate-deep-night: "#101214"
  key-night: "#23262b"
  key-hover-night: "#2a2e34"
  key-press-night: "#1d2024"
  seam-night: "#33373e"
  seam-soft-night: "#2a2e33"
  ink-night: "#e8eaed"
  ink-2-night: "#aab0b8"
  ink-3-night: "#8b929b"
  lcd-night: "#0b0c0d"
  lcd-ink-night: "#ffb54a"
  lcd-ink-2-night: "#c98b35"
  lcd-ghost-night: "rgba(255, 181, 74, 0.1)"
  lit-night: "#ffab2e"
  lit-ink-night: "#1c1203"
  lit-soft-night: "rgba(255, 171, 46, 0.14)"
  danger-night: "#ff7a66"
  danger-soft-night: "rgba(255, 122, 102, 0.12)"
  focus-night: "#7fb4ff"
typography:
  display:
    fontFamily: "Doto Variable, Doto, ui-monospace, monospace"
    fontSize: "clamp(34px, 11vw, 48px)"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "0.02em"
  display-desk:
    fontFamily: "Doto Variable, Doto, ui-monospace, monospace"
    fontSize: "72px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.02em"
  page-title:
    fontFamily: "Doto Variable, Doto, ui-monospace, monospace"
    fontSize: "26px"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "0.02em"
  indicator:
    fontFamily: "Doto Variable, Doto, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.08em"
  song:
    fontFamily: "Overpass Variable, Overpass, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.25
  preset-name:
    fontFamily: "Overpass Variable, Overpass, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 750
    lineHeight: 1.2
  preset-name-playing:
    fontFamily: "Overpass Variable, Overpass, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 800
    lineHeight: 1.1
  body:
    fontFamily: "Overpass Variable, Overpass, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  row-title:
    fontFamily: "Overpass Variable, Overpass, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.3
  sub:
    fontFamily: "Overpass Variable, Overpass, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
  key-legend:
    fontFamily: "Overpass Variable, Overpass, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 750
    letterSpacing: "0.06em"
  section-head:
    fontFamily: "Overpass Variable, Overpass, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 800
    letterSpacing: "0.12em"
  scale-reading:
    fontFamily: "Overpass Variable, Overpass, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    fontFeature: "tnum"
rounded:
  plate: "22px"
  lcd: "16px"
  key: "14px"
  field: "12px"
  thumb: "8px"
  tag: "5px"
  led: "3px"
spacing:
  gap: "12px"
  pad: "16px"
  key-gap: "10px"
  page-gap: "18px"
  desk-gutter: "28px"
components:
  display:
    backgroundColor: "{colors.lcd}"
    textColor: "{colors.lcd-ink}"
    rounded: "{rounded.lcd}"
    padding: "14px 16px 12px"
    height: "196px"
  page-head-window:
    backgroundColor: "{colors.lcd}"
    textColor: "{colors.lcd-ink}"
    typography: "{typography.page-title}"
    rounded: "{rounded.lcd}"
    padding: "10px 14px"
  key:
    backgroundColor: "{colors.key}"
    textColor: "{colors.ink}"
    rounded: "{rounded.key}"
    padding: "0 20px"
    height: "52px"
  key-hover:
    backgroundColor: "{colors.key-hover}"
  key-press:
    backgroundColor: "{colors.key-press}"
  key-lit:
    backgroundColor: "{colors.lit}"
    textColor: "{colors.lit-ink}"
    rounded: "{rounded.key}"
  key-disabled:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.ink-3}"
  transport-key:
    backgroundColor: "{colors.key}"
    textColor: "{colors.ink}"
    rounded: "{rounded.key}"
    height: "58px"
  faceplate-bar-key:
    backgroundColor: "{colors.key}"
    textColor: "{colors.ink}"
    typography: "{typography.key-legend}"
    rounded: "{rounded.key}"
    height: "52px"
  preset-key:
    backgroundColor: "{colors.key}"
    textColor: "{colors.ink}"
    typography: "{typography.preset-name}"
    rounded: "{rounded.key}"
    padding: "12px 8px 12px 14px"
    height: "104px"
  preset-key-playing:
    backgroundColor: "{colors.key-press}"
    typography: "{typography.preset-name-playing}"
  preset-add:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.key}"
    height: "104px"
  menu-key:
    backgroundColor: "{colors.key}"
    textColor: "{colors.ink}"
    rounded: "{rounded.key}"
    padding: "14px 14px 12px"
    height: "76px"
  glass-list:
    backgroundColor: "{colors.lcd}"
    textColor: "{colors.lcd-ink}"
    rounded: "{rounded.lcd}"
    padding: "6px 14px"
  list:
    backgroundColor: "{colors.key}"
    textColor: "{colors.ink}"
    rounded: "{rounded.key}"
  list-row:
    padding: "10px 14px"
    height: "56px"
  message-strip:
    backgroundColor: "{colors.lcd}"
    textColor: "{colors.lcd-ink}"
    rounded: "{rounded.lcd}"
    padding: "12px 16px"
  input:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "0 14px"
    height: "52px"
  note:
    backgroundColor: "{colors.lit-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "12px 14px"
  tag:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.tag}"
    padding: "2px 6px"
---

# Design System: True Shuffle

## Overview

**Creative North Star: "The Station Memory"**

The interface is a car radio's faceplate: a moulded polymer plate, a recessed display window at the top, chunky rounded keys that physically depress, and a preset bank where each station is a numbered key. Everything a listener needs is readable in a two-second glance and tappable one-handed; the screen serves seconds, the music serves hours.

The world has two illuminations, like a radio's dimmer. Day is cool light-grey polymer with a reflective grey-green LCD and black segments; night is anthracite polymer with a backlit amber LCD. Night follows `prefers-color-scheme: dark` unless the listener forces an illumination from the menu (`data-illumination="day" | "night"` on the root). Both illuminations share every token name; only values change.

Settings live behind the radio's MENU and each preset's tune key, rendered in the radio's own menu grammar: small display windows for page heads, faceplate keys for choices, a segmented balance bar for "Entdecken ↔ Vertraut", and lists shown on display glass. The previous record-crate world ("Plattenschrank") is a confirmed anti-reference.

**Key Characteristics:**
- One neutral ramp per illumination; amber marks only what is lit.
- Dot-matrix type (Doto) appears only on display glass; everything else is Overpass.
- Keys are tactile: top highlight, soft drop shadow, 1px travel on press.
- Display windows are recessed with an inset shadow, a faint pixel-cell grid and a sheen.
- Progress is a tuner scale with a needle, numbered majors and a plain-language readout.

## Colors

A cool neutral polymer ramp plus one amber "lit" accent, restated for day and night; the LCD is its own small palette within each illumination.

### Primary
- **Lamp Amber** (`lit` day / `lit-night`): the only accent. Fills the primary key (Spielen), the playing preset's LED, the tuner needle outside the display, checked switches and check keys, selected radio dots, progress bars, and the outline of a latched choice key. Text on it uses `lit-ink`.

### Neutral
- **Faceplate Polymer** (`plate`): page background and the surface keys sit on; disabled keys sink flush into it. `plate-deep` is the desktop backdrop behind the faceplate.
- **Key Cap** (`key`, `key-hover`, `key-press`): the raised key face and its hover and pressed states; also the surface of settings lists and key units.
- **Seams** (`seam`, `seam-soft`): hairline dividers between list rows and inside split keys, the unlit LED, outlines of the add-station and drop zones.
- **Legend Inks** (`ink`, `ink-2`, `ink-3`): primary text, secondary text and labels, tertiary text (preset numbers, placeholders, disabled legends).

### Display glass
- **Day LCD** (`lcd`, `lcd-ink`, `lcd-ink-2`, `lcd-ghost`): grey-green reflective glass with near-black segments; `lcd-ink-2` for secondary lines, `lcd-ghost` for unlit indicator segments.
- **Night LCD** (`lcd-night`, `lcd-ink-night`, `lcd-ink-2-night`, `lcd-ghost-night`): near-black glass lit in amber from behind.
- Glass also carries a sheen (day: diagonal white reflection; night: amber backlight bleeding from the top) and a 3px dot-cell grid; both are in the sidecar.

### Status
- **Fault Red** (`danger`, `danger-soft`): destructive key legends and error notes. On day surfaces error text uses `danger-ink-day` for contrast; night uses `danger-night`.
- **Focus Blue** (`focus`): the 2px focus ring only, never decoration.

### Named Rules
**The Lit-Only Rule.** Amber appears only on something that is lit: the playing station, the current selection, the primary action. Nothing is amber for decoration.

**The Size-Not-Colour Rule.** The playing preset is marked by being pressed in and by a larger name (22px/800), plus its LED; the key face does not turn amber.

**The Shared-Names Rule.** A new colour must be defined for both illuminations under one custom property name; components never reference a day or night value directly.

## Typography

**Display Font:** Doto (dot-matrix variable, self-hosted via `@fontsource-variable/doto`, fallback `ui-monospace`)
**Body Font:** Overpass (variable, self-hosted via `@fontsource-variable/overpass`, fallback `system-ui`)

**Character:** Doto is the display's segment matrix; Overpass is the printed legend on the plate, highway-sign clear and sturdy at heavy weights.

### Hierarchy
- **Display** (Doto 800, clamp(34px, 11vw, 48px), 1.02; 72px/1 on the desktop faceplate): the station name in the main display.
- **Page title** (Doto 800, 26px, 1.05, uppercase): the page name in a page head window.
- **Indicator** (Doto 700, 12px, 0.08em): the NEU / FAVORIT / ENTDECKUNG / GAST / PAUSE segments, balance-bar ends, reason segments in glass lists (11px, uppercase), sequence numbers in glass lists (17px/800).
- **Song** (Overpass 700, 19px, 1.25): the current song on the display; artist below at 15px/500 in `lcd-ink-2`.
- **Preset name** (Overpass 750, 17px, 1.2, max two lines; playing 800, 22px, 1.1).
- **Body / Row title** (Overpass 400 at 16px/1.45; row titles 700 at 16px/1.3). Ledes cap at 62ch.
- **Sub** (Overpass 500, 13px): row subtitles, menu key descriptions, hints.
- **Key legend** (Overpass 750, 15px, 0.06em, uppercase) on faceplate bar keys; menu key legends 800/14px/0.08em uppercase; section heads 800/13px/0.12em uppercase in `ink-2`.
- **Scale reading** (Overpass 700, 13px, tabular numerals): majors 11px/700.

### Named Rules
**The Glass-Only Doto Rule.** Doto is used only for text on display glass (display, page head window, balance bar, glass lists), and there only for names, indicators, reasons and sequence numbers. Songs, artists, readouts and counts on glass stay Overpass.

**The Tabular Count Rule.** Every number that counts uses Overpass with tabular numerals, and sits next to what it counts ("2 von 1.200 gehört", "Runde 1 0 / 400").

## Layout

Phone first: a single column, max 560px, 16px side padding (safe-area aware), 12px between blocks. Order on home: brand row (maker mark left, listener name right), main display, four transport keys in one row (10px gaps), preset grid, faceplate bar (MENÜ, VERLAUF) at the bottom.

- **Preset grid:** 2 columns on phones, 3 from 700px, 4 inside the desktop faceplate; 10px gaps.
- **Menu pages:** 18px between sections, 10px inside a section; a page head (back key + page head window) on top.
- **Desktop faceplate (≥980px):** the shell becomes a two-column grid, max 1300px, `minmax(0,1fr)` faceplate and a 380–460px side panel, 28px gutter, on `plate-deep`. The faceplate is one moulded plate (22px radius, 22px 24px 24px padding) sticky at top 24px, filling the window height, with the faceplate bar pushed to its bottom. Pages open in the side panel beside the radio (the playing or last-played station by default); the side panel scrolls on its own with its page head sticky. The phone message strip is hidden there because the display stays visible.
- **Touch targets:** keys 52px minimum; transport 58px; list rows 56px; glass rows 48px.

## Elevation & Depth

Depth is physical: raised keys, recessed glass, a plate with a soft cast shadow. There are three directions and no floating cards.

### Shadow Vocabulary
- **Raised key** (`inset 0 1px 0 var(--key-hi), 0 1px 1px var(--key-shadow), 0 6px 12px -8px var(--key-shadow-far)`): keys, preset keys, key units.
- **Pressed key** (`inset 0 1px 0 var(--key-hi), 0 0 0 var(--key-shadow), 0 2px 4px -3px var(--key-shadow-far)` + translateY(1px)): `:active` on keys.
- **Latched preset** (`inset 0 2px 5px var(--key-shadow), inset 0 0 0 1px var(--seam)` + translateY(1px)): the playing preset stays down.
- **Flush** (`inset 0 0 0 1px var(--seam)`): disabled keys sit level with the plate.
- **Recessed glass** (`--lcd-inset`): every display window, balance bar, glass list, message strip.
- **Sunk well** (`inset 0 1px 3px var(--key-shadow)`): inputs, switches, check keys, progress tracks.
- **Plate cast** (`0 24px 48px -28px rgba(0,0,0,0.45)`): the desktop faceplate only; the message strip adds `0 12px 28px -12px rgba(0,0,0,0.45)`.

### Named Rules
**The Three Heights Rule.** Every surface is raised (a key), level (the plate) or recessed (glass and wells). Nothing hovers above the plate except the transient message strip.

## Shapes

Soft moulded rectangles throughout. Faceplate 22px, display glass 16px, keys and lists 14px, fields and notes 12px, thumbnails and check keys 8px, tags 5px, LEDs 3px pills. Switches and radio dots are fully round. Split keys (preset: play area + tune key) share one outer radius and are divided by a `seam-soft` hairline. Glass lists divide rows with a dashed rule in 18% `lcd-ink`.

## Components

### Display
The radio's window. Recessed glass (16px radius, min 196px tall, 14px 16px 12px padding) with sheen and cell grid. Top row: indicator segments, unlit ones in `lcd-ghost`, lit in `lcd-ink`; the output device name right-aligned in Overpass. Then the Doto station name (a non-station name such as an idle state steps back to `lcd-ink-2`), song, artist with elapsed time right-aligned, one status line or message, and the tuner scale. Errors on glass use the danger ink.

### Tuner scale with numbered majors and readout
A round's progress as a frequency band: minor ticks every 2%, majors every 10%, a 1px baseline, a 3px fill and a 3px needle, all `currentColor` inside the display (amber needle outside it). Under the band: five numbered majors (0, ¼, ½, ¾, total) and the readout "Runde n" left, "x von y gehört" right. On a preset key the scale shrinks to a 10px hairline with no majors. **Signature interaction:** pressing a preset tunes; the needle sweeps across and settles at the station's position (900ms) while the station name rewrites from ghost to ink in four steps (520ms). Only transform animates.

### Transport keys
Four equal keys in one row (Daumen runter, Pause/Play, Weiter, Daumen hoch), 58px tall, 26px outline icons (lucide). A latched thumb shows its icon in amber (`aria-pressed`).

### Preset keys
A split key, min 104px: the left play area shows the number (800, 14px, `ink-3`) with an LED pill (18×5px; `seam` off, `lit` on), the name, and a hairline scale with "Runde n  x / y". The right tune key (48px wide, sliders icon) opens the station's settings. **Latched playing state:** the key stays pressed in (`key-press`, inset shadow, 1px down), its name grows to 22px/800, its LED lights. The last cell is an outlined, flat "Sender anlegen" key.

### Faceplate bar
Two keys (MENÜ with icon, VERLAUF) side by side at the foot of the radio, uppercase legends.

### Page head (small display window)
A 48px square back key aligned to the first line, beside a small display window holding the Doto uppercase page title, an optional Overpass sub-line in `lcd-ink-2`, and optionally the station's tuner scale with readout. On desktop the back key is omitted and the head is sticky.

### Lists on display glass
Sequences the display would show (the upcoming queue, recent plays, discovery counts) sit on glass: Doto two-digit sequence numbers, Overpass title and artist, and a Doto reason segment at the right (lit reasons in `lcd-ink`, the plain "NEU" reason in `lcd-ink-2`, never ghost). Counts are Overpass 800, 22px, tabular.

### Faceplate key grid and key unit
Menu choices are keys in a two-column grid (min 76px, uppercase legend over a 13px sub-line). A key unit groups a setting and what belongs to it into one raised key divided by seams. Choice rows (illumination, mix presets) are three keys whose latched choice shows a 2px amber inset outline.

### Balance bar
"Entdecken ↔ Vertraut" as 21 LCD segments on glass (14px radius here), Doto end labels, the chosen segment in `currentColor`; a transparent native range input on top carries interaction and focus.

### Inputs, switches, check keys
Inputs, selects, switches (54×32 rocker) and check keys (26px, amber bar when checked) are sunk wells in `plate`. Focus is the global 2px `focus` outline at 2px offset.

### Message strip
On phones, when a page covers the radio, messages appear in a strip of display glass fixed at the bottom (16px inset), fading and rising 12px in over 220ms. Hidden on the desktop faceplate layout.

### Notes and tags
Notes (warnings the display cannot hold) are `lit-soft` or `danger-soft` panels, 12px radius. Tags are 11px uppercase outlined labels.

### Icons and rasters
UI icons are lucide outline icons at 22px (26px in transport), stroke 2. The app icon's source of truth is `src/client/public/icon.svg` (night faceplate, amber dot-matrix "TS", preset keys with one lit LED); `icon-192.png`, `icon-512.png` and `apple-touch-icon.png` are rendered from it by `scripts/render-icons.mjs` (`npm run icons`). Fonts are self-hosted from `@fontsource-variable/doto` and `@fontsource-variable/overpass`; no remote font requests.

## Do's and Don'ts

### Do:
- **Do** define every new colour for both illuminations under one custom property name.
- **Do** reserve `lit` amber for the playing station, the current selection and the primary action.
- **Do** put Doto only on display glass, and only for names, indicators, reasons and sequence numbers.
- **Do** set counts in Overpass with tabular numerals, next to the thing they count.
- **Do** make every control a key (raised, 14px radius, 1px press travel) or a well (sunk, `plate`).
- **Do** show a sequence or status the radio would display on display glass (display, page head window, glass list, strip).
- **Do** keep touch targets at 52px or more for keys and 48px or more for rows.
- **Do** animate only transform, opacity and colour, with `--ease`; reduced motion collapses all of it to 1ms.

### Don't:
- **Don't** mark the playing station by turning its key amber; it latches down and its name grows.
- **Don't** use Doto for body copy, songs, artists, counts or anything on the plate.
- **Don't** use cover-art grids, a round green play button or dark streaming chrome.
- **Don't** reuse the discarded "Plattenschrank" record-crate world.
- **Don't** float cards above the plate with generic drop shadows; use the three heights.
- **Don't** use unicode glyphs as icons; use lucide outline icons.
