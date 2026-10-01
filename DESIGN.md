---
name: true-shuffle
description: A Swiss concert poster for the current song, one flat printing ink per Sender, with the saved order running beneath like the programme.
colors:
  bg: "#f3f3f1"
  fg: "#111111"
  fg-2: "#55575a"
  rule: "#111111"
  hair: "#c9cbcd"
  grid: "rgb(17 17 17 / 0.08)"
  raise: "#ffffff"
  danger: "#b3261e"
  warn-bg: "#fff3c4"
  warn-fg: "#3b2f00"
  focus: "#1f3bd0"
  select: "#f4c20d"
  bg-night: "#0b0b0c"
  fg-night: "#f2f2ee"
  fg-2-night: "#a3a5a8"
  rule-night: "#f2f2ee"
  hair-night: "#303236"
  grid-night: "rgb(242 242 238 / 0.075)"
  raise-night: "#17181a"
  danger-night: "#ff8a7f"
  warn-bg-night: "#3b2f00"
  warn-fg-night: "#ffe9a3"
  focus-night: "#8fa3ff"
  ink-ultra: "#1f3bd0"
  on-ultra: "#ffffff"
  on-ultra-2: "#dfe4ff"
  ink-verm: "#c8380e"
  on-verm: "#ffffff"
  on-verm-2: "#fff0ea"
  ink-green: "#006e4e"
  on-green: "#ffffff"
  on-green-2: "#dff5ec"
  ink-violet: "#5b30c0"
  on-violet: "#ffffff"
  on-violet-2: "#ece5ff"
  ink-petrol: "#00657a"
  on-petrol: "#ffffff"
  on-petrol-2: "#dcf3f7"
  ink-yellow: "#f4c20d"
  on-yellow: "#111111"
  on-yellow-2: "#3a3000"
  ink-all: "#111111"
  on-all: "#f3f3f1"
  on-all-2: "#c6c6c4"
  ink-all-night: "#f2f2ee"
  on-all-night: "#0b0b0c"
  on-all-2-night: "#393939"
typography:
  display:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "clamp(2.6rem, 12.5vw, 4.25rem)"
    fontWeight: 850
    lineHeight: 0.94
    letterSpacing: "-0.025em"
    fontVariation: "'wdth' 72"
  display-desktop:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "clamp(3.4rem, 5.4vw, 6rem)"
    fontWeight: 850
    lineHeight: 0.94
    letterSpacing: "-0.025em"
    fontVariation: "'wdth' 72"
  masthead:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "clamp(2.2rem, 10vw, 4rem)"
    fontWeight: 850
    lineHeight: 0.96
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 74"
  headline:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "clamp(1.6rem, 6vw, 2.25rem)"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 78"
  title:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.015em"
    fontVariation: "'wdth' 85"
  brand:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "1.45rem"
    fontWeight: 800
    letterSpacing: "-0.03em"
    fontVariation: "'wdth' 82"
  body:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    fontVariation: "'wdth' 100"
  key:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.15
    fontVariation: "'wdth' 92"
  figures:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 750
    fontFeature: "'tnum' 1"
    fontVariation: "'wdth' 85"
  signal:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 650
    fontVariation: "'wdth' 90"
rounded:
  none: "0px"
spacing:
  gutter-narrow: "14px"
  gutter: "16px"
  gutter-tablet: "24px"
  gutter-desktop: "32px"
  gap: "24px"
  gap-desktop: "32px"
  section: "40px"
  key-narrow: "46px"
  key: "52px"
  key-main: "64px"
components:
  key:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    typography: "{typography.key}"
    rounded: "{rounded.none}"
    padding: "10px 18px"
    height: "48px"
  key-hover:
    backgroundColor: "{colors.fg}"
    textColor: "{colors.bg}"
  key-lit:
    backgroundColor: "{colors.fg}"
    textColor: "{colors.bg}"
    rounded: "{rounded.none}"
  key-danger:
    textColor: "{colors.danger}"
    rounded: "{rounded.none}"
  poster:
    backgroundColor: "{colors.ink-verm}"
    textColor: "{colors.on-verm}"
    rounded: "{rounded.none}"
    padding: "20px 16px 22px"
  transport-main:
    backgroundColor: "{colors.on-verm}"
    textColor: "{colors.ink-verm}"
    typography: "{typography.key}"
    rounded: "{rounded.none}"
    padding: "10px 16px"
    height: "64px"
  transport-key:
    backgroundColor: "transparent"
    textColor: "{colors.on-verm}"
    rounded: "{rounded.none}"
    width: "{spacing.key}"
    height: "64px"
  key-poster:
    backgroundColor: "{colors.on-ultra}"
    textColor: "{colors.ink-ultra}"
    typography: "{typography.key}"
    rounded: "{rounded.none}"
    padding: "12px 22px"
    height: "56px"
  station-tile:
    backgroundColor: "{colors.ink-green}"
    textColor: "{colors.on-green}"
    rounded: "{rounded.none}"
    padding: "14px 14px 10px"
    height: "112px"
  input:
    backgroundColor: "{colors.raise}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "10px 14px"
    height: "52px"
  segmented-option:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.none}"
    padding: "8px 12px"
    height: "52px"
  segmented-option-selected:
    backgroundColor: "{colors.fg}"
    textColor: "{colors.bg}"
  notice:
    backgroundColor: "{colors.raise}"
    textColor: "{colors.fg}"
    rounded: "{rounded.none}"
    padding: "14px 16px"
  notice-warn:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn-fg}"
    rounded: "{rounded.none}"
    padding: "14px 16px"
  sheet:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.none}"
    padding: "20px"
---

# Design System: true-shuffle

## Overview

**Creative North Star: "The Concert Poster"**

The current song is a printed concert poster for its Sender. One flat field of printing ink carries the Sender name, the round figure, the cover, the title at poster scale, the progress rule, the command signal and the transport keys. The saved order runs beneath it like the programme, and the other Sender hang as a poster wall. The lineage is the Swiss concert poster (Tonhalle, Musica Viva): flat ink, one grotesk, a visible construction grid, square corners.

Paper-white (`bg`) or black (`bg-night`) ground; hairline grid columns printed behind everything; Archivo Variable as the only family, set condensed and heavy for display and at normal width for text. The ink is honest: solid ink means confirmed. Anything requested, awaited or estimated prints as overprint (outline, dashes, hatch), never in the solid confirmed ink. This world replaces the earlier "quiet album-library desk" in full; nothing of that system (Jost, green accent, rounded controls, artwork shadows) carries over. Surface composition and direction evidence live in `.impeccable/surfaces/src-client.md`.

**Key Characteristics:**
- One flat printing ink per Sender; "Alles" prints in the page's own ink.
- Archivo Variable only: condensed heavy display, normal-width text, tabular figures.
- Visible hairline construction grid: 4 columns on phone, 12 at 1100px and up.
- Square corners everywhere; flat print with no shadows except the rating dialog.
- Overprint means unconfirmed: outline title, hatched progress, dashed keys and signal steps.
- The round figure prints the real heard share of the round, never a rounded-up one.

## Colors

A neutral paper-and-ink ground with six saturated printing inks, each assigned to a Sender and printed as a full flat field with its own type colour.

### Primary
The six station inks. A Sender's ink is chosen deterministically from its id (ultramarine, vermilion, green, violet, petrol, signal yellow, in that cycle); the combined Sender "Alles" prints in the page ink instead. Every ink has an `on-` colour for its type and keys and an `on-…-2` colour for secondary lines (round text, album, notes). All pairs pass AA for body text (lowest: `on-verm-2` on vermilion, 4.69:1).
- **Ultramarine** (`ink-ultra`): also the sign-in and scan posters' ink, and the day theme's focus colour.
- **Vermilion** (`ink-verm`), **Green** (`ink-green`), **Violet** (`ink-violet`), **Petrol** (`ink-petrol`): white type, tinted secondary lines.
- **Signal Yellow** (`ink-yellow`): the only light ink; type flips to near-black (`on-yellow`). The same yellow is the text selection colour (`select`).
- **Alles** (`ink-all` / `ink-all-night`): the page's foreground printed as a field, so black on day and paper-light on night, with the ground colour as its type.

### Neutral
- **Paper** (`bg`) and **Night Black** (`bg-night`): the page ground.
- **Ink Black** (`fg`) and **Night Paper** (`fg-night`): text, key outlines, heavy 3px rules (`rule`), lit and selected states.
- **Graphite** (`fg-2`): supporting text, queue numbers, metadata.
- **Hairline** (`hair`): 1px row separators, quiet key outlines, skeleton hatch.
- **Grid** (`grid`): the construction-grid hairlines behind the page.
- **Raised Sheet** (`raise`): fields, selects, neutral notices, diagnostic blocks.
- **Danger** (`danger`): errors, destructive keys and the "Sender löschen" action.
- **Warning Ink** (`warn-bg` / `warn-fg`): unresolved-command and offline notices, small "warn" tags.
- **Focus** (`focus`): the 3px keyboard outline; on any ink field the outline switches to that ink's `on` colour.

### Named Rules
**The One Ink Per Sender Rule.** A Sender prints in exactly one ink, as a flat field. The poster, the station page band and the station tile share it. Never tint, gradient or mix a second ink into the same field; the only texture allowed on ink is the grid hairline at 13% of its `on` colour.

**The Solid Means Confirmed Rule.** Solid ink states are reserved for what a fresh observation confirmed. Requested, accepted-but-unconfirmed and estimated states print as overprint: outline title, hatched progress fill, dashed key and signal borders. Overprint never edits or replaces the confirmed ink beneath it.

**The Paired Theme Rule.** Use the semantic custom properties (`--bg`, `--fg`, `--fg-2`, `--rule`, `--hair`, `--raise`, …) for every new surface. System dark preference applies unless day is pinned; `data-illumination="night"` and `data-illumination="day"` pin a theme. Station inks are identical in both themes; only "Alles" inverts with the page.

## Typography

**Display Font:** Archivo Variable (self-hosted via Fontsource, weight 100–900, width 62–125%), fallback system-ui, sans-serif
**Body Font:** Archivo Variable at normal width
**Label/Mono Font:** none; figures use Archivo's tabular numerals

**Character:** One grotesk doing every job by width and weight alone: compressed to 70–80% and set at 800–850 for anything printed at poster scale, relaxed to 100% and 400 for reading. Headings balance their lines and hyphenate rather than overflow.

### Hierarchy
- **Display** (850, `clamp(2.6rem, 12.5vw, 4.25rem)` on phone, `clamp(2.8rem, 7.5vw, 4.6rem)` from 560px, `clamp(3.4rem, 5.4vw, 6rem)` from 1100px; line-height 0.94; width 72%): the current song's title on the poster. The welcome poster headline goes one step further (width 70%, up to 5.6rem).
- **Masthead** (850, `clamp(2.2rem, 10vw, 4rem)`, 0.96, width 74%): page titles, including the station page's ink band.
- **Headline** (800, `clamp(1.6rem, 6vw, 2.25rem)`, 1.02, width 78%): section heads such as "Als Nächstes", "Deine Sender", "Mischung", always over a 3px rule.
- **Title** (800, 1.2–1.35rem, width 80–85%): Sender name in the poster head and on tiles (tiles grow to `clamp(1.6rem, 2.2vw, 2.25rem)` on desktop); the brand at 1.45rem, width 82%, tracking -0.03em.
- **Body** (400, 1rem/1.5, width 100%): prose, notices and hints, held to 60–68ch.
- **Key** (700, width 92%): key and button labels; the main transport key at 1.2rem/800.
- **Figures** (750, 1.05rem, width 85%, tabular): progress times, queue numbers ("01", "02" …), ledger counts (1.6rem/850), import meter (2rem/850).
- **Signal** (650, 0.78rem, width 90%): the "Angefordert / Angenommen / Bestätigt" steps and reason chips.

### Named Rules
**The One Family Rule.** Archivo Variable is the only shipped family. Hierarchy comes from width and weight, never from a second face. (Code, URL and diagnostic text fall back to the system monospace; that is a utility, not a type role.)

**The Name Rule.** The product is always "true-shuffle": lower case, hyphenated, never in capitals, never "True Shuffle". German interface labels are in sentence case.

## Layout

A centred shell, at most 1440px wide, with a gutter of 16px (14px at 380px and below, 24px from 560px, 32px from 900px) and a section gap of 24px (32px from 900px). Behind it, `grid` hairlines print the construction grid: four columns on phone and tablet, twelve from 1100px. Posters carry the same four-column hairline inside their ink at 25% steps.

The header is a 64px bar under a 3px rule: brand left, "Hören", "Verlauf", "Menü" right with a 3px underline for the current page.

**Phone (below 560px):** posters print edge to edge (the shell drops its side padding) while header, device panel, queue, wall and page content keep the gutter. The poster stacks the head (round figure plus Sender name and round text), a cover square at `min(34vw, 140px)` beside artist and album, the title across the full width, the 12px progress rule with times, the three-step signal, and the transport row: the main key fills the remaining width, then three 52px keys (46px at 380px and below), all 64px tall. The device select follows directly under the poster.

**From 560px:** cover 200px beside a grouped copy block aligned to the bottom.

**From 1100px:** the listening workspace is a 12-column grid. The poster column spans 7 and is not sticky, because it also carries the device panel and recovery notices, which run taller than a laptop viewport. The queue spans 5. The poster wall runs full width underneath with tiles at `minmax(240px, 1fr)`, followed by station actions (7 columns) and library links (5 columns). The cover grows to 260px.

Secondary pages hold to 860px. Sections sit 40px apart (22px inside a page). Lists separate rows with 1px hairlines and 10–12px vertical padding; no cards.

**The Programme Rule.** The queue reads like a printed programme: numbered rows, the cover at 48px, title and artist, duration in tabular figures, a hairline under each. Its fixed order is its hierarchy; it never reshuffles visually.

## Elevation & Depth

Flat print. Depth comes from ink fields against paper and from rule weight (3px structural rules, 2px key and field outlines, 1px hairlines), not from shadows or tonal layers.

### Shadow Vocabulary
- **Dialog** (`box-shadow: 0 24px 60px -20px rgb(0 0 0 / 0.5)` over a `rgb(0 0 0 / 0.55)` backdrop): the rating sheet only, because it floats over the page.

### Named Rules
**The Flat Print Rule.** Nothing on the page casts a shadow except the dialog. Covers, posters, tiles and keys sit flat on the paper.

## Shapes

Square corners throughout (`rounded.none`, 0px), including keys, fields, selects, the switch, dialog, covers and progress rule. Form comes from rules and fields: thick outlines on keys, heavy rules under heads and sections, full-bleed ink rectangles for posters and tiles. The one round element is the round figure, concentric rings whose outer arc is the real heard share of the round, plus its smaller echo in the brand mark. Covers are always square; a missing cover prints a stand-in square with a music-note glyph.

## Components

### Keys
Printed keys: outlined, square, heavy label.
- **Shape:** square corners (0px), 2px outline in `fg`, minimum 48px tall (44px for small keys), padding 10px 18px.
- **Default:** transparent with `fg` label. **Hover / pressed / lit:** fills solid `fg` with `bg` label; a lit key's hover steps to `fg-2`.
- **Quiet:** hairline outline ("Neue Warteschlange" before confirmation). **Danger:** `danger` outline and label, fills `danger` on hover.
- **Disabled:** 0.42 opacity, default cursor.
- **Text action:** an underlined word with a 44px target ("Geräte aktualisieren", "Erneut verbinden"); underline thickens from 1.5px to 3px on hover.
- **Transitions:** background, colour and border at 180ms on the shared expo-out curve.

### Transport (signature)
The keys printed on the poster. The main key ("Fortsetzen", "Pause", "Wiedergabe starten") is a solid `on` field with ink-coloured label and icon, 64px tall. "Weiter", the heart ("Daumen hoch: Favorit") and the thumbs-down ("Daumen runter: diesen Song nie wieder") are 52px outlined keys in the `on` colour; a pressed rating fills solid `on`. While a command is out or the key is unavailable (held, offline, not ready), the main key prints as overprint: transparent, dashed `on` outline, its label switches to the command text ("Pause angefordert …").

### Command Signal (signature)
A three-step rule under the title: "Angefordert", "Angenommen", "Bestätigt". Each step is a 6px top border at 26% `on` that turns solid `on` when reached. Sending lights step one; the provider's acknowledgment lights step two; only a fresh observation prints "Bestätigt" solid. While waiting, the reached later steps print dashed; an estimated song prints the third step dotted; a failed or unconfirmed command prints double. The status line above it says the same thing in words.

### Progress Rule
A 12px rule outlined 2px in `on`. Its solid fill is only the last observed position, or that position counted forward locally while a fresh observation says it is playing. While a command is held or the song is estimated, the fill turns to a 135° hatch. The time label reads "1:37 gespeichert" for a saved position, "· Bestätigung ausstehend" while held, and "Position unbekannt · derselbe Song von vorne" when no position exists.

### Poster
The ink field: grid hairlines in `on` at 13%, padding 20px gutter 22px (28px 32px 30px from 900px), a 2px `on` rule under the head, a 1px rule above the "Song und Reihenfolge bleiben gespeichert" note. In the pending and estimated states the title prints as outline type (1.5px stroke in `on`, transparent fill). The guest note ("Gast-Modus · zählt nicht ins Gedächtnis") prints reversed, `on` field with ink type.

### Poster Wall (station tiles)
Each Sender as a flat ink tile: name at title size, meta line ("1056 Songs · Runde 1"), round figure top right, "Mix & Regeln" link on a separating rule below. Minimum 112px tall (168px on desktop). The selected tile gains an 8px `on` bar on top and the suffix " · ausgewählt". Selecting a tile chooses a Sender without replacing the saved song.

### Inputs / Fields
- **Style:** 2px `fg` outline, `raise` background, square, minimum 52px tall, padding 10px 14px. Selects use a drawn chevron instead of the native one.
- **Focus:** 3px `focus` outline at 3px offset.
- **Disabled:** 0.5 opacity.

### Choice Controls
- **Segmented positions** (Entdecker / Ausgewogen / Vertraut, and other detents): native radios under printed cells inside a 2px `fg` frame, 2px `fg` gaps between cells, 52px tall. The selected cell fills solid `fg`.
- **Switch:** a 58×32px square outlined lever over a native checkbox; checked fills `fg` with a `bg` thumb, with an "An/Aus" word beside it.
- **Checks and radios:** native, 22px, accent `fg`.

### Notices
Bordered blocks, square, padding 14px 16px. Neutral notices use `raise` and a 2px `fg` outline; warning notices use `warn-bg` / `warn-fg`; errors use a `danger` outline and text; estimated notices use a dashed outline. Inline notes are text over a 2px top rule. Reason chips ("Ungehört", "Favorit", "Entdeckung") are small outlined labels: favourite fills solid, discovery prints dashed.

### Navigation
The header bar: brand with the concentric mark, then three text links with a 3px underline for the current page. Page heads print a "Zurück" key, the masthead title and a 3px rule; on the station page the head prints as an ink band in the Sender's ink. Menu entries are full-width rows at least 60px tall with a hairline under each.

### Rating Sheet and Toast
The rating sheet is a native dialog, square, 3px `fg` outline, at most 560px wide, the one element with a shadow. The status toast is a solid `fg` (or `danger`) block fixed bottom centre.

### Honest States
These are interface rules for the shipped client, not a claim of live Spotify, iPhone or HA/MA verification.

**The Observed Position Rule.** Progress shows the last observed position, counted forward only while a fresh observation says it is playing and stopped the moment it goes stale, is paused or a command is out. Pause freezes the clock and the rule turns to hatch at once. Unknown position says the same song starts from the beginning.

**The Three-Layer Command Rule.** A command is requested, then accepted by Spotify or the device, then confirmed only by a fresh observation. The interface never prints a later layer before it happens. Unresolved commands keep the saved song and position and offer an explicit retry ("Gespeicherten Song erneut fortsetzen", "Pause erneut versuchen") or, on native devices, discarding the command.

**The Estimated Next Song Rule.** When a song should have ended, the poster may show the single known successor from the saved queue as "Nächster Song · geschätzt", with the outline title, dotted third signal step and a dashed notice ("Geschätzter Songwechsel aus deiner Warteschlange. Spotify hat diesen Song noch nicht bestätigt."). It is display only: rating and "Weiter" are disabled, nothing is written, and it never chains past one song.

**The Resume Rule.** "Fortsetzen" keeps the same saved occurrence and position. "Neue Warteschlange" is a separate quiet key that asks inline ("Neue Warteschlange für … beginnen? Der aktuelle Lauf wird ersetzt.") before replacement.

**The Native Capability Rule.** Device copy states what a native Home Assistant / Music Assistant route can actually do: "Geordnete Warteschlange unterstützt." or "Dieses Gerät spielt einen Song; automatisches Weiterschalten ist nicht verfügbar.", and "Gespeicherte Position wird übernommen." or "Ohne Seek startet derselbe Song von vorne." Pause and "Weiter" are disabled where the device lacks them. Without native setup the hint says Music-Assistant devices visible in Spotify run through Spotify Connect.

**The Offline Rule.** Offline keeps the last saved song, queue and wall visible under a warning bar ("Offline oder nicht erreichbar. Letzter gespeicherter Stand bleibt sichtbar.") with "Erneut verbinden"; dependent keys are disabled and print as overprint.

### Motion
State fills on keys, signal steps, header underline and switch take 180ms; the ink field change, round-figure arc and import meter ease over 500ms; both on `cubic-bezier(0.16, 1, 0.3, 1)`. No entrance choreography, no shimmer (skeletons are a static hatch). Reduced motion sets both durations to 0 and turns off smooth scroll.

## Do's and Don'ts

### Do:
- **Do** print each Sender in its single flat ink with its paired `on` and `on-2` colours, in both themes.
- **Do** reserve solid ink for confirmed state and print requested, awaited and estimated state as outline, dashes or hatch.
- **Do** set display type in Archivo Variable at 70–85% width and 800–850 weight, and all times and counts in tabular figures.
- **Do** keep square corners (0px), 2px key outlines, 3px rules under heads and 1px hairlines between rows.
- **Do** keep transport targets at 64px tall and at least 52px wide (46px at 380px and below), and every text action at a 44px target.
- **Do** keep the saved song, observed position and ordered queue visible through pending, offline and estimated states.
- **Do** state device capabilities and Spotify's own behaviour in plain German, quoting what the device can and cannot do.

### Don't:
- **Don't** fill a requested or estimated state with solid confirmed ink, or show "Bestätigt" before a fresh observation.
- **Don't** add a second typeface, rounded corners, gradients across ink fields or shadows outside the rating dialog.
- **Don't** mix two inks in one Sender's field or recolour a Sender between poster, band and tile.
- **Don't** replace ordinary "Fortsetzen" with a new queue, or imply seek or automatic next on a device that lacks them.
- **Don't** let the estimated next song accept ratings, skips or writes, or chain past one song.
- **Don't** set true-shuffle in capitals or title case.
- **Don't** reintroduce the discarded album-library desk (Jost, muted green accent, rounded controls, artwork shadows) or the earlier record-crate world.
