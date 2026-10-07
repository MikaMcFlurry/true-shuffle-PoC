---
name: true-shuffle
description: Spotify-Sender mit Gedächtnis. One shared listening shell, four switchable designs (Kontaktbogen default, Linienplan, Strichliste, Klassisch), each drawn for day and night.
colors:
  # Kontaktbogen (data-design="kontakt", default). Day = contact print on photo paper, night = darkroom.
  kontakt-photo-paper: "#eeedea"
  kontakt-paper-raise: "#f9f8f6"
  kontakt-film-black: "#141210"
  kontakt-film-print: "#f2ede6"
  kontakt-film-print-dim: "#b0a99f"
  kontakt-edge-amber: "#e6b15c"
  kontakt-graphite-quiet: "#5c5853"
  kontakt-paper-hair: "#cfcbc5"
  kontakt-film-line: "#3b3632"
  kontakt-grease-red: "#e2362a"
  kontakt-darkroom: "#0d0b0a"
  kontakt-darkroom-raise: "#161412"
  kontakt-darkroom-film: "#1d1a17"
  kontakt-darkroom-print: "#ece6dd"
  kontakt-darkroom-quiet: "#a69e93"
  kontakt-darkroom-red: "#ff5a3c"
  kontakt-safelight-hole: "#6b2f25"
  kontakt-grease-blue: "#4b86f0"
  kontakt-grease-vermilion: "#ff4b2b"
  kontakt-grease-green: "#33c06d"
  kontakt-grease-magenta: "#e05aa8"
  kontakt-grease-orange: "#ff8a1e"
  kontakt-grease-yellow: "#f2c230"
  # Linienplan (data-design="linie"). Day = white signage on station-wall grey, night = midnight enamel.
  linie-station-wall: "#e9edf1"
  linie-signage-white: "#ffffff"
  linie-navy-ink: "#0f1d33"
  linie-navy-quiet: "#4a586c"
  linie-panel-hair: "#c7d0da"
  linie-signal-red: "#e3001b"
  linie-enamel-midnight: "#0b1424"
  linie-enamel-raise: "#132038"
  linie-enamel-white: "#f2f5f9"
  linie-enamel-quiet: "#a6b2c3"
  linie-enamel-hair: "#283851"
  linie-night-signal-red: "#ff3349"
  linie-line-blue: "#0066b3"
  linie-line-red: "#d6001c"
  linie-line-green: "#2f8a1f"
  linie-line-violet: "#7b4fa6"
  linie-line-turquoise: "#00827e"
  linie-line-yellow: "#f5c400"
  # Strichliste (data-design="strich"). Day = squared school paper, night = slate board.
  strich-squared-paper: "#fbfbf9"
  strich-graphite: "#26292e"
  strich-graphite-quiet: "#5b6169"
  strich-paper-hair: "#cdd6e0"
  strich-grid-blue: "#d9e6f3"
  strich-margin-pink: "#ec8d86"
  strich-correction-red: "#d63a2f"
  strich-slate: "#1d2723"
  strich-slate-raise: "#24302b"
  strich-chalk: "#eef0e9"
  strich-chalk-quiet: "#aab4ad"
  strich-chalk-red: "#ff8f80"
  strich-marker-blue: "#1f5fbf"
  strich-marker-red: "#d63a2f"
  strich-marker-green: "#1d8048"
  strich-marker-violet: "#7a3fb0"
  strich-marker-petrol: "#0e7882"
  strich-marker-ochre: "#e7a600"
  # Klassisch (data-design="klassik"). The familiar player, day and night.
  klassik-ground: "#f5f5f7"
  klassik-card: "#ffffff"
  klassik-label: "#1d1d1f"
  klassik-label-quiet: "#6e6e73"
  klassik-separator: "#d9d9de"
  klassik-violet: "#6a4cff"
  klassik-night: "#121214"
  klassik-night-card: "#1c1c1f"
  klassik-night-label: "#f5f5f7"
  klassik-night-quiet: "#a1a1a6"
  klassik-night-violet: "#8f7bff"
  klassik-accent-blue: "#2f6bff"
  klassik-accent-pink-red: "#ff375f"
  klassik-accent-green: "#1f9d55"
  klassik-accent-violet: "#8e5cff"
  klassik-accent-petrol: "#0a9396"
  klassik-accent-yellow: "#ffb800"
typography:
  kontakt-display:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "clamp(2.3rem, 11vw, 3.7rem)"
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
    fontSize: "0.7rem"
    fontWeight: 500
    letterSpacing: "0.04em"
    fontFeature: "tnum"
  linie-display:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "clamp(2rem, 9.5vw, 3.3rem)"
    fontWeight: 800
    lineHeight: 1.04
    letterSpacing: "-0.015em"
  linie-body:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  linie-line-badge:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1.1rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.01em"
  strich-display:
    fontFamily: "Bricolage Grotesque Variable, Bricolage Grotesque, system-ui, sans-serif"
    fontSize: "clamp(2.3rem, 11vw, 3.9rem)"
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
  headline:
    fontSize: "clamp(1.45rem, 5.4vw, 2rem)"
    lineHeight: 1.08
    letterSpacing: "-0.015em"
  title:
    fontSize: "1.15rem"
    lineHeight: 1.08
    letterSpacing: "-0.01em"
  artist:
    fontSize: "clamp(1.1rem, 4.4vw, 1.5rem)"
    fontWeight: 600
    lineHeight: 1.2
  label:
    fontSize: "0.78rem"
    fontWeight: 650
    lineHeight: 1.3
rounded:
  kontakt-r: "2px"
  kontakt-r-lg: "3px"
  kontakt-r-art: "1px"
  linie-r: "8px"
  linie-r-lg: "14px"
  linie-r-art: "6px"
  linie-badge: "7px"
  strich-r: "10px 4px 12px 5px / 5px 12px 4px 10px"
  strich-r-lg: "16px 6px 18px 8px / 8px 18px 6px 16px"
  strich-r-main: "14px 6px 16px 7px / 7px 16px 6px 14px"
  strich-r-art: "3px"
  klassik-r: "12px"
  klassik-r-lg: "18px"
  klassik-r-art: "12px"
  klassik-panel: "24px"
  pill: "999px"
spacing:
  gutter-narrow: "14px"
  gutter-mobile: "16px"
  gutter-tablet: "24px"
  gutter-desktop: "32px"
  gap: "24px"
  gap-desktop: "32px"
  stage-pad-mobile: "18px"
  stage-pad-tablet: "24px"
  stage-pad-desktop: "28px"
  tap-min: "44px"
  key: "52px"
  key-narrow: "46px"
  main-key: "64px"
components:
  transport-main-kontakt:
    backgroundColor: "{colors.kontakt-film-print}"
    textColor: "{colors.kontakt-film-black}"
    rounded: "{rounded.kontakt-r}"
    height: "64px"
    padding: "10px 16px"
  transport-main-linie:
    backgroundColor: "{colors.linie-line-red}"
    textColor: "{colors.linie-signage-white}"
    rounded: "{rounded.pill}"
    height: "64px"
    padding: "10px 16px"
  transport-main-strich:
    backgroundColor: "{colors.strich-graphite}"
    textColor: "{colors.strich-squared-paper}"
    rounded: "{rounded.strich-r-main}"
    height: "64px"
    padding: "10px 16px"
  transport-main-klassik:
    backgroundColor: "{colors.klassik-label}"
    textColor: "{colors.klassik-ground}"
    rounded: "{rounded.pill}"
    size: "76px"
  icon-key:
    size: "52px"
    height: "64px"
  key-kontakt:
    textColor: "{colors.kontakt-film-black}"
    rounded: "{rounded.kontakt-r}"
    height: "48px"
    padding: "10px 18px"
  key-linie:
    backgroundColor: "{colors.linie-signage-white}"
    textColor: "{colors.linie-navy-ink}"
    rounded: "{rounded.linie-r}"
    height: "48px"
    padding: "10px 18px"
  key-strich:
    textColor: "{colors.strich-graphite}"
    rounded: "{rounded.strich-r}"
    height: "48px"
    padding: "10px 18px"
  key-klassik:
    textColor: "{colors.klassik-label}"
    rounded: "{rounded.klassik-r}"
    height: "48px"
    padding: "10px 18px"
  line-badge-linie:
    backgroundColor: "{colors.linie-line-red}"
    textColor: "{colors.linie-signage-white}"
    typography: "{typography.linie-line-badge}"
    rounded: "{rounded.linie-badge}"
    height: "34px"
    padding: "0 8px"
  station-card-kontakt:
    backgroundColor: "{colors.kontakt-film-black}"
    textColor: "{colors.kontakt-film-print}"
    rounded: "{rounded.kontakt-r-lg}"
    padding: "14px 14px 10px"
  station-card-linie:
    backgroundColor: "{colors.linie-signage-white}"
    textColor: "{colors.linie-navy-ink}"
    rounded: "{rounded.linie-r-lg}"
    padding: "14px 14px 10px"
  station-card-strich:
    backgroundColor: "{colors.strich-squared-paper}"
    textColor: "{colors.strich-graphite}"
    rounded: "{rounded.strich-r-lg}"
    padding: "14px 14px 10px"
  station-card-klassik:
    backgroundColor: "{colors.klassik-card}"
    textColor: "{colors.klassik-label}"
    rounded: "{rounded.klassik-r-lg}"
    padding: "14px 14px 10px"
  device-select:
    height: "52px"
    padding: "10px 44px 10px 14px"
---

# Design System: true-shuffle

## Overview

**Creative North Star: "One Player, Four Papers"**

true-shuffle is one standard listening shell (header with mark, lowercase wordmark and Hören / Verlauf / Menü; the stage with Sender, song, progress, signal and transport; the device select; *Als Nächstes* in stored order; the Sender grid; menu pages) that carries four complete visual worlds. The listener picks one under Menü › Gestaltung; the choice is a per-device convenience (localStorage `ts-design`, also `?design=<id>`) painted as the root attribute `data-design`, plus the matching favicon, touch icon and browser-bar colour. Nothing functional depends on it. Kontaktbogen is the default; Linienplan, Strichliste and Klassisch are full alternatives, not skins of it.

Each world lends exactly four things: type, palette, density and one signature move. Layout, controls, tap targets and every honest-state distinction stay shared, so a song, a Sender and a command state read the same way whichever world is on. Day and night are fully drawn for every world: they follow `prefers-color-scheme` unless Menü pins `data-illumination="day"` or `"night"` (localStorage `ts-illumination`). The brand guide in `docs/BRAND.md` owns name, voice, the slot table and icon pipeline; this file owns the visual system as built.

The screen is open for seconds while music runs for hours: song and Fortsetzen / Pause always come first, and nothing unconfirmed is ever printed like a fact.

**Key Characteristics:**
- One shell, four worlds: `kontakt` Kontaktbogen (default), `linie` Linienplan, `strich` Strichliste, `klassik` Klassisch.
- A single token vocabulary (`--bg --fg --fg-2 --hair --rule --raise --sunk --brand`, station `--st`/`--on-st`, radii `--r --r-lg --r-art --r-main`, line weights `--bw --rule-w`, key and stage tokens, six ink slots) that every world fills.
- Every Sender owns one of six ink slots and keeps that slot in every world.
- One signature per world: film strip with grease-pencil box; line badges and the queue as stops; five-bundle tally and marker underline; big centred cover with round play key.
- Requested, accepted and confirmed are three visibly different states; held and estimated never render solid.
- Display-scale song title, 52px+ transport keys, 44px minimum targets.

## Colors

Every world is a two-tone ground-and-ink palette plus one brand red or violet and six Sender inks; the token values above are normative for day, the night counterparts are listed with the night-prefixed names.

### Primary
- **Grease-Pencil Red** (`kontakt-grease-red`; night `kontakt-darkroom-red`): Kontaktbogen's brand: the box stroke in the mark, the active-nav underline, the caret, the first queue number.
- **Signal Red** (`linie-signal-red`; night `linie-night-signal-red`): Linienplan's brand: the line in the mark, the 4px active-nav bar.
- **Correction Red** (`strich-correction-red`; night `strich-chalk-red`): Strichliste's brand: the fifth cross stroke of each tally bundle, the hand-drawn nav underline, first queue number.
- **Player Violet** (`klassik-violet`; night `klassik-night-violet`): Klassisch's brand: the mark tile, menu links on Sender cards, switches when on.

### Secondary (Sender inks)
Six slots per world, mapped by Sender ID: `ultra`, `verm`, `green`, `violet`, `petrol`, `yellow` (`--ink-*`, consumed as `--st` / `--on-st` via the `.ink-*` classes). Kontaktbogen's are grease pencils that read on black film and on paper (`kontakt-grease-*`, with dark `--on-ink`); Linienplan's are transit line colours (`linie-line-*`, brightened at night); Strichliste's are marker pens (`strich-marker-*`, pastel chalks at night); Klassisch's are accent colours (`klassik-accent-*`). The station colour drives the progress fill, the signal, the round meter, the selected Sender outline, the station masthead and pressed favourite. "Alles" takes the page ink (`--fg`), or grease-white `kontakt-film-print` on the film.

### Tertiary (world materials)
- **Film Black / Film Print** (`kontakt-film-black`, `kontakt-film-print`, `kontakt-film-print-dim`): the stage strip, Sender cards and station masthead in Kontaktbogen, in day and night alike (night film lifts to `kontakt-darkroom-film`). The day browser bar is film black too.
- **Edge Amber** (`kontakt-edge-amber`): edge print on film: frame numbers, station round line, scan text.
- **Safelight Hole** (`kontakt-safelight-hole`): sprocket holes at night; by day the holes cut through to the paper (`--hole: var(--bg)`).
- **Grid Blue / Margin Pink** (`strich-grid-blue`, `strich-margin-pink`): the 20px squared ground and, from 900px, the 2px fixed margin line. At night both become faint chalk (7% grid, 35% red margin).

### Neutral
- **Grounds**: `kontakt-photo-paper` / `kontakt-darkroom`, `linie-station-wall` / `linie-enamel-midnight`, `strich-squared-paper` / `strich-slate`, `klassik-ground` / `klassik-night`.
- **Raised panels**: `kontakt-paper-raise`, `linie-signage-white` / `linie-enamel-raise`, white / `strich-slate-raise`, `klassik-card` / `klassik-night-card`.
- **Ink and quiet ink**: `*-film-black`/`*-navy-ink`/`*-graphite`/`*-label` for text, the `*-quiet` tokens for secondary text.
- **Hairlines**: `kontakt-paper-hair`, `linie-panel-hair`, `strich-paper-hair`, `klassik-separator`; `--sunk` is the ink at 5 to 8% for hover wash and Klassisch key fill.
- Each world also sets its own `--danger`, `--warn-bg`/`--warn-fg`, `--focus`, `--select` (see the world's stylesheet); focus is always a 3px outline offset 3px.

### Named Rules
**The Fixed Slot Rule.** A Sender keeps the same ink slot in all four worlds (same ID, same slot); only the hue changes with the world. "Alles" never takes an ink slot; it takes the page ink.

**The One Brand Colour Rule.** Each world has exactly one brand colour, used for the mark, the active navigation bar and the caret. Sender identity is carried by `--st`, never by `--brand`.

## Typography

**Kontaktbogen:** Hanken Grotesk (variable), with Martian Mono as edge print.
**Linienplan:** Atkinson Hyperlegible Next (variable), one face for every job.
**Strichliste:** Bricolage Grotesque (variable, optical sizing), one face for every job.
**Klassisch:** the platform face (`-apple-system` / SF Pro Display and Text / Segoe UI / Roboto).

**Character:** each world sets the same hierarchy in its own voice: Kontaktbogen tight and heavy like a contact-sheet caption, Linienplan open and signage-legible, Strichliste hand-lettered-adjacent and squat, Klassisch the quiet system player. Faces are self-hosted via `@fontsource-variable`.

### Hierarchy
- **Display** (song title and masthead title; per-world weight, size, leading and tracking in the frontmatter, via `--display-weight`, `--display-lh`, `--display-tracking`). Base size `clamp(2.2rem, 10.5vw, 3.6rem)`, from 560px `clamp(2.4rem, 6.5vw, 3.8rem)`, from 1100px `clamp(2.8rem, 4.4vw, 4.6rem)`; worlds override (Klassisch deliberately small at up to 2.1rem, under the cover).
- **Headline** (`--head-weight`, 760 to 780, Klassisch 700): section heads *Als Nächstes*, *Deine Sender*, with an inline icon.
- **Title** (1.15 to 1.25rem): station name on the stage head and Sender cards (cards grow to `clamp(1.35rem, 1.8vw, 1.8rem)` at desktop).
- **Artist** (600, `clamp(1.1rem, 4.4vw, 1.5rem)`): under the title; album at 0.95rem in quiet ink.
- **Body** (400, 1rem / 1.5): notes and hints capped at 62 to 68ch.
- **Label** (`--label-weight` 650 to 700, 0.78rem): signal steps, reasons, tags, nav. Sentence case, never tracked capitals.
- **Numbers** (`--font-num`, tabular figures): queue numbers, durations, progress times, history times.

### Named Rules
**The Edge Print Rule.** Martian Mono exists only in Kontaktbogen, as edge print on and around the film: frame numbers, times, queue numbers, round and count lines, Sender-card meta and signal step labels. It never sets a title, a key label or body copy.

**The Utility Mono Rule.** The system monospace stack (`ui-monospace, "SF Mono", Menlo, monospace`) is a utility fallback for code and diagnostic fields only (remote key input, `.code`, diagnostic data). It is not a type role and no world styles with it.

**The Lowercase Name Rule.** The name is always "true-shuffle": lowercase, hyphenated, set in the active world's display face after its mark. Never capitalised, spaced, or abbreviated.

## Layout

Single column on phones; content max 1440px with safe-area-aware gutters (14px under 380px, 16px, 24px from 560px, 32px from 900px). Section gap 24px, 32px from 900px. The header is a 64px row (56px in Klassisch) with the mark plus wordmark left and three nav links right, each a 44px target.

Stage order is fixed in every world: Sender line with round meter, cover (film strip in Kontaktbogen), title at display scale, artist and album, progress with times, status line and three-step signal, transport (main key plus Weiter, Favorit, nie wieder at the key size), saved note. The device select sits directly below the stage, then *Als Nächstes*, then *Deine Sender*.

Breakpoints: under 380px keys shrink to 46px and the queue drops its thumbs column; from 560px the cover and copy sit side by side (cover 200px) and stage padding grows to 24px; from 900px Sender cards go to 190px minimum columns and stage padding 28px; from 1100px a 12-column grid puts the stage on 7 columns and the queue on 5 with the Sender grid full width below (240px minimum cards, 148px tall). Kontaktbogen and Klassisch keep the cover stacked above the copy at every width; Klassisch centres the copy from 560px.

Density per world: Kontaktbogen and Linienplan pad the stage as a panel; Strichliste and Klassisch zero `--stage-pad` and sit the stage directly on the ground (Klassisch wraps player and queue in 24px-radius cards with 32px / 24px padding from 1100px).

## Elevation & Depth

The shell is flat and draws depth with ink, rules and material, not light. Two worlds add measured shadow because their material has it: Linienplan's signage panels sit on the wall, and Klassisch's cover floats like an album sleeve. Kontaktbogen and Strichliste stay flat; their depth is the film strip on paper and the drawn box on squared paper. Shared overlays (rating sheet, toast) carry one diffuse shadow each.

### Shadow Vocabulary
- **Signage panel** (`box-shadow: 0 1px 0 var(--hair), 0 10px 30px -18px rgb(15 29 51 / 0.35)`): Linienplan stage only; queue panel and Sender cards use the 1px hair ledge alone.
- **Sleeve** (`box-shadow: 0 22px 48px -22px rgb(0 0 0 / 0.55)`): Klassisch's large cover.
- **Card lift** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.06)`): Klassisch Sender cards.
- **Sheet** (`box-shadow: 0 24px 60px -20px rgb(0 0 0 / 0.5)`, backdrop `rgb(0 0 0 / 0.55)`): the rating sheet in every world.
- **Toast** (`box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.45)`): the feedback flash in every world.

### Named Rules
**The Material Depth Rule.** A world earns a shadow only if its material casts one. Selection, focus and pressed states are shown with outlines, ink fills and inset rings, never with lift.

## Shapes

Radius is a world token, not a component decision: components read `--r` (keys, fields, notices), `--r-lg` (stage, cards, mastheads, sheet), `--r-art` (covers) and `--r-main` (the main transport key). Border weight is `--bw` (2px; 0 in Klassisch) and the header and section rule is `--rule-w` (2px; 0 in Linienplan and Klassisch).

- **Kontaktbogen:** near-square cut film (2px / 3px / 1px). The stage has 10px sprocket rows masked top and bottom (10px holes on a 24px repeat). The grease box is a hand-drawn SVG path, 4px round-capped, overshooting the frame by 9px.
- **Linienplan:** signage corners (8px / 14px / 6px), pills for the main key, "Weitere Songs" and switches, 7px line badges, 50% stop rings. Lines bend only at 45° and 90°.
- **Strichliste:** drawn boxes whose corners do not agree (asymmetric elliptical radii, frontmatter `strich-*`), the cover tilted -1.2° (-1.6° from 560px), every second and third Sender card rotated +0.5° / -0.6°, dashed row dividers.
- **Klassisch:** soft continuous rounding (12px / 18px / 12px), a 76px circular play key, 52px circular icon keys, pill nav highlights, no borders (inset 1px hair rings instead).

## Components

### Buttons
- **Shape:** `--r` per world; the main transport key uses `--r-main` (pill in Linienplan, drawn box in Strichliste, circle in Klassisch).
- **Key:** 48px minimum, 10px 18px padding, 700 weight, `--bw` border in `--key-line` on a transparent ground. Hover fills with `--key-hover-bg` (ink in Kontaktbogen and Strichliste, `--sunk` in Linienplan, 12% ink in Klassisch). Press scales to 0.97. Disabled at 42% opacity.
- **Main transport key (Fortsetzen / Pause):** 64px high, 1.15rem 800, icon 26px. Kontaktbogen: film-print key on the film. Linienplan: pill in the Sender's line colour (shown: line red; "Alles" prints navy, night enamel white). Strichliste: graphite drawn box. Klassisch: 76px round key, icon only.
- **Icon keys (Weiter, Favorit, nie wieder):** `--key` wide (52px, 46px narrow), 64px tall, 24px icons. Pressed: station ink fill in Kontaktbogen and Strichliste, lit navy in Linienplan, station-coloured icon on transparent in Klassisch.
- **Quiet / danger / stage keys:** quiet uses a hair border; danger a danger border that fills on hover; `key--stage` (56px) inverts the station colour on mastheads and the welcome stage.
- **Text action:** underlined word, 1.5px at 55% ink, 2.5px full ink on hover, 44px target.

### Chips
- **Reason:** 0.78rem 700, 1.5px ink border, `--r`. Favourite is solid ink; Neuentdeckung is dashed.
- **Line badge (Linienplan only):** S1, S2 … per own Sender in list order, "A" for Alles; 34px tall, 46px minimum, station fill. Hidden in every other world.

### Cards / Containers
- **Sender card:** `--r-lg`, `--bw` hair border, `--raise` ground, 112px minimum (148px desktop), round meter in the card, a 44px "Mix & Regeln" footer link. Selected shows " · ausgewählt" after the name plus the world's mark: Kontaktbogen a 4px station outline offset 4px on a black film card with a 6px station top edge and 56/72px art; Linienplan a station border plus inset ring and the line badge; Strichliste a 2px station ring and a 30% marker highlight behind the name; Klassisch a 2px station ring around a white card with 64px art.
- **Notices:** `--r`, `--bw` ink border (Linienplan and Klassisch use inset rings); warn and offline on `--warn-bg`; error in danger; estimate dashed.
- **Station masthead:** the Sender's ink as ground with `--on-st` text (Kontaktbogen keeps the black film with a 6px station top edge).

### Inputs / Fields
- **Style:** 52px minimum, `--bw` border in `--key-line`, `--r`, `--raise` ground; the device select carries a drawn chevron. Klassisch drops the border for a 1px inset hair ring.
- **Focus:** 3px `--focus` outline offset 3px, in every world; on the Kontaktbogen film it switches to film print.
- **Switch:** 56 × 32px, `--switch-r` (pill in Linienplan and Klassisch, else `--r`), brand fill when on.
- **Segmented:** 48px options, checked option takes `--lit-bg`/`--lit-fg`. Kontaktbogen joins options in one ink frame with hair dividers; Strichliste spaces drawn boxes 8px apart.

### Navigation
Three text links (Hören, Verlauf, Menü), 44px tall, `--label-weight`, quiet ink at rest and full ink when current. The current page carries a 3 to 4px bar under the word: square brand red in Kontaktbogen, 4px brand red in Linienplan (hair for a non-page current), a hand-drawn 4px correction-red stroke in Strichliste, and in Klassisch a pill `--sunk` highlight instead of a bar. Linienplan sets the header as a full-bleed white signage bar.

### Round meter
The round's heard share drawn per world (all `aria-hidden`, the figure is always printed beside it, marks floored): Kontaktbogen a 56-bar barcode in station ink; Linienplan a line with a terminus tick; Strichliste 20 five-bundles with the fifth stroke crossing in red; Klassisch a 44px ring.

### Signature moves
- **Kontaktbogen film strip:** the current cover is a frame on black film, boxed in the Sender's grease pencil, with up to three next queue frames beside it at 62% opacity and 70% saturation (two on phones), each with edge print ("jetzt", 01, 02, 03).
- **Linienplan queue as stops:** *Als Nächstes* runs down an 8px line in the station colour, each song a 28px stop ring (the next one 7px heavy), the line ending at the last stop. The signal becomes three stops on a short line.
- **Strichliste tally and scribble:** the round counted in five-bundles; the current title underlined by a 7px marker stroke at 85% opacity; the signal as three tick boxes.
- **Klassisch big cover:** cover up to 420px / 44vh centred, round play key leading a centred transport row.

### Honest state (shared doctrine, per-world rendering)
- **Signal (Angefordert → Angenommen → Bestätigt):** three steps, each lit only when reached. Shared: 4px bars in station ink; waiting steps dashed, an estimated confirmation dotted, an error double in danger. Kontaktbogen: 3px bars, mono labels. Linienplan: stops on a line; waiting segments dashed 8/5, estimate dotted 3/4, only the furthest reached stop filled, error a double danger ring. Strichliste: boxes ticked in station ink; waiting or estimated boxes dashed with a 45% tick, error a danger slash. Klassisch: 3px bars.
- **Progress:** confirmed is a solid fill in station ink (Kontaktbogen 6px square, Linienplan 10px pill, Klassisch 5px pill in ink). Held while a command is out, or only estimated, it becomes a 135° hatch (3px ink, 4px gap). Strichliste's confirmed fill is already a dense pencil hatch (2/2px at 100°), so held and estimated thin it to 1px strokes on 7px.
- **Pending title:** a requested or estimated song's title prints as a 1.25px outline with no fill (quiet ink where text-stroke is unsupported). Kontaktbogen also dashes the grease box 7/7; Strichliste dashes the marker underline 4/10 at 60%. Klassisch renders it in quiet ink italic with the cover at 55% instead of the outline.
- **Unavailable main key:** transparent with a dashed ink outline, never the solid key.

## Do's and Don'ts

### Do:
- **Do** build every new surface in the shared shell and read only tokens (`--bg --fg --fg-2 --hair --rule --raise --sunk --brand --st --on-st --r --r-lg --r-art --r-main --bw --rule-w --key* --stage-* --ink-*`), then check it in all four worlds by day and by night.
- **Do** give a new world-specific detail to one world only, scoped under `[data-design="…"]`, and keep it to type, palette, density or that world's existing signature.
- **Do** keep requested, accepted and confirmed visibly distinct, and render held or estimated values as hatch, dash or outline: never solid.
- **Do** print every fact a decorative signature draws (round share, queue position, song) as text beside it, and mark the drawing `aria-hidden`.
- **Do** floor counts and meters; never round up.
- **Do** keep transport keys at 52px or more and every target at 44px or more.
- **Do** write the name as "true-shuffle", lowercase, after the active world's mark.

### Don't:
- **Don't** fill an unconfirmed state solid: no solid progress while held or estimated, no filled title while pending, no solid main key while unavailable.
- **Don't** let a world change layout, stage order, controls or copy; worlds differ in look only.
- **Don't** put a Sender's identity in `--brand` or move a Sender to a different ink slot in another world.
- **Don't** use Martian Mono outside Kontaktbogen, or the system monospace stack anywhere but code and diagnostic fields.
- **Don't** add shadows to Kontaktbogen or Strichliste beyond the shared sheet and toast; their depth is film and paper.
- **Don't** set labels in tracked capitals or add small labels above headings; section heads and labels stay sentence case.
- **Don't** write "True Shuffle", "TRUE-SHUFFLE", "Trueshuffle" or "TS" as the name.
