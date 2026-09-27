---
name: true-shuffle
description: The front of a 1950s German tube radio, in two illuminations. Stations are printed on its lit glass dial.
colors:
  # Day illumination (default): the radio on a sideboard by a light wall
  wall: "#dddecf"
  wall-2: "#cfd1c1"
  wall-ink: "#2f2b24"
  walnut: "#5e371d"
  walnut-deep: "#3d2312"
  brass-hi: "#f5e2a6"
  brass: "#c89c48"
  brass-lo: "#7c5719"
  cloth: "#b4965c"
  wood-ink: "#f4e3b6"
  wood-ink-2: "#ecd6a2"
  glass-hi: "#fbf3d9"
  glass: "#f2e4be"
  glass-lo: "#e4cf9e"
  glass-edge: "#e2c285"
  halo: "#f4e7c4"
  print: "#2b1d12"
  print-2: "#5a4230"
  lit: "#a8221a"
  lit-deep: "#8c1a12"
  eye: "#40cf84"
  eye-lo: "#0d4a2b"
  ivory-hi: "#fdf8ea"
  ivory: "#f0e6cd"
  ivory-lo: "#dccfae"
  ivory-front: "#b9a57f"
  ivory-lip: "#a38e66"
  engrave: "#5a4934"
  slot: "#1a110a"
  bakelite: "#2d1c12"
  key-brass: "#cfa24c"
  key-brass-ink: "#22160a"
  danger-key: "#981e15"
  card: "#f5efe1"
  paper: "#f6eedb"
  paper-2: "#eee3c8"
  ink: "#2a2119"
  ink-2: "#564a3c"
  ink-3: "#655648"
  rule: "rgba(88, 62, 34, 0.24)"
  rule-strong: "rgba(70, 48, 24, 0.6)"
  field: "#fcf8ee"
  lit-ink: "#a3231a"
  board: "#7b5637"
  board-2: "#6b492d"
  board-ink: "#f7ebcf"
  board-field: "#5a3c24"
  board-lit: "#ffd0c4"
  focus-on-light: "#1b4fb3"
  focus-on-dark: "#ffd978"
  # Night illumination: a dark room, dial and magic eye glow (same names, other values)
  wall-night: "#16140f"
  glass-night: "#f6d796"
  lit-night: "#931a12"
  eye-night: "#4cf596"
  ivory-night: "#ddd0b1"
  paper-night: "#cdbb95"
  ink-night: "#231a10"
  board-night: "#3d2a1a"
typography:
  badge:
    fontFamily: "Yellowtail, Brush Script MT, cursive"
    fontSize: "clamp(24px, 7.4vw, 30px)"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.01em"
  dial-title:
    fontFamily: "Barlow Condensed, Jost Variable, Jost, sans-serif"
    fontSize: "25px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "0.05em"
  dial-station:
    fontFamily: "Barlow Condensed, Jost Variable, Jost, sans-serif"
    fontSize: "18px"
    fontWeight: 500
    lineHeight: 1.06
    letterSpacing: "0.05em"
  display:
    fontFamily: "Jost Variable, Jost, Futura, Century Gothic, system-ui, sans-serif"
    fontSize: "clamp(28px, 8.4vw, 36px)"
    fontWeight: 600
    lineHeight: 1.06
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Jost Variable, Jost, Futura, Century Gothic, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.005em"
  title:
    fontFamily: "Jost Variable, Jost, Futura, Century Gothic, system-ui, sans-serif"
    fontSize: "17.5px"
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "Jost Variable, Jost, Futura, Century Gothic, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  lede:
    fontFamily: "Jost Variable, Jost, Futura, Century Gothic, system-ui, sans-serif"
    fontSize: "15.5px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Barlow Condensed, Jost Variable, Jost, sans-serif"
    fontSize: "14.5px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "0.08em"
  label-small:
    fontFamily: "Barlow Condensed, Jost Variable, Jost, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.18em"
rounded:
  hairline: "1px"
  sheet: "2px"
  paper: "3px"
  plate: "6px"
  window: "8px"
  glass: "9px"
  bezel: "14px"
  cabinet: "30px 30px 16px 16px / 24px 24px 14px 14px"
  round: "50%"
spacing:
  xs: "6px"
  sm: "10px"
  md: "12px"
  lg: "20px"
  xl: "26px"
  page: "18px"
components:
  key:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.engrave}"
    typography: "{typography.label}"
    rounded: "{rounded.sheet}"
    padding: "0 16px 9px"
    height: "50px"
  key-pressed:
    backgroundColor: "{colors.ivory-lo}"
    textColor: "{colors.engrave}"
  key-danger:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.danger-key}"
  piano-key:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.engrave}"
    rounded: "2px 2px 0 0"
    padding: "6px 2px 16px"
    height: "60px"
  piano-key-latched:
    backgroundColor: "{colors.ivory-lo}"
    textColor: "{colors.lit-deep}"
  dial-glass:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.print}"
    rounded: "{rounded.glass}"
  station-lit:
    textColor: "{colors.lit}"
    typography: "{typography.dial-station}"
  program-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.paper}"
    padding: "10px 12px 4px"
  program-sheet:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    padding: "18px 18px 30px"
  back-panel:
    backgroundColor: "{colors.board}"
    textColor: "{colors.board-ink}"
    rounded: "5px"
    padding: "58px 18px 30px"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    rounded: "3px 3px 1px 1px"
    padding: "0 12px"
    height: "48px"
  status-strip:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.print}"
    rounded: "10px"
    padding: "11px 16px 12px"
---

# Design System: true-shuffle

## Overview

**Creative North Star: "The Radio on the Sideboard"**

The phone screen is the front of a 1950s German tube radio, and nothing else. One walnut cabinet under lacquer with rounded, lit shoulders and a thin brass trim; a golden speaker cloth carrying the brass badge and the green magic eye; a cream glass dial lit from behind with every station printed on it; the program card behind a brass-framed window; two bakelite knobs; one slot of ivory piano keys. Everything the listener touches is a physical part of that cabinet. Pages that do not fit on the front are printed program sheets (Programmheft paper) or the radio's own back panel (hardboard with vent holes, screws and a riveted brass type plate).

Density is that of a real appliance: a glance of two or three seconds reads the lit station on the dial and the song on the card; a tap on a printed station name sends the red pointer gliding there. All options are always present at once. Every station stays printed on the glass, the playing one struck forward and lit, the others printed and quiet. The world has two illuminations, same token names, other values: **Day** (a pale plaster wall, the radio lit by the room) and **Night** (a dark room where wood, cloth and paper fall into shadow and only the dial lamp, the magic eye and the paper glow carry light). Night follows `prefers-color-scheme: dark` unless the user pins `data-illumination`.

Confirmed rejections (owner, 2026-09-27): app cards, streaming-app chrome, a numbers cockpit, anything playful or cold, and the previous car head-unit world (black VFD glass, machined keys, dot-matrix type), which is now an anti-reference.

**Key Characteristics:**
- One object: the cabinet is a single walnut body; dial, window, knobs and keys are seated in it, never floating tiles.
- Real material: walnut and cloth are sourced CC0 rasters; paper grain, brushed brass, plaster and hardboard are small inline SVG noise filters.
- Print, not UI: dial lettering is condensed caps printed on glass; lists are set like a printed running order with rules and leaders.
- One signal red for "this is the one": the pointer, the lit station, pilot lamps, the latched key's legend.
- One living light: the green magic eye.

## Colors

A warm, lamp-lit palette of walnut, brass, cream glass, ivory and paper, with a single signal red and a single phosphor green.

### Primary
- **Dial Signal Red** (`lit`): the pointer needle, the lit and held station name, its number box and frequency, the round mark on the card's scale. Reserved for "the one that plays".
- **Deep Signal Red** (`lit-deep`, `lit-ink`): red set as ink: the latched piano key's legend, lit wave-band lamps' text, danger actions and error notes on paper. On the back panel it becomes `board-lit` (a pale coral) to hold contrast on hardboard.

### Secondary
- **Lacquered Brass** (`brass-hi`, `brass`, `brass-lo`): trim inlay round the cabinet, the rings round the cloth, dial bezel and window, knob rings, the magic-eye bezel, the brass borders of the status strip and the rating slip. Always a gradient of the three stops, never a flat fill.
- **Key Brass** (`key-brass`, `key-brass-ink`): the back panel's riveted type plate and the toggle lever's nut.

### Tertiary
- **Magic Eye Green** (`eye`, `eye-lo`, `eye-hi`): only the EM-tube fan in the cloth. It is the radio's one living light; it opens when playing, closes while tuning, dims when off.

### Neutral
- **Plaster Wall** (`wall`, `wall-2`, `wall-ink`): the room behind the radio; the page background under a plaster-noise texture.
- **Walnut** (`walnut`, `walnut-deep`): the cabinet colour under the walnut raster; `wood-ink` and `wood-ink-2` are the pale legends printed on wood (knob names, detents).
- **Speaker Cloth Gold** (`cloth`): the base under the cloth raster.
- **Backlit Dial Glass** (`glass-hi` → `glass` → `glass-lo` → `glass-edge`): a radial lamp falloff, brightest at the centre; `halo` is the soft glow behind printed dial letters. `print` and `print-2` are the brown-black dial inks.
- **Ivory** (`ivory-hi`, `ivory`, `ivory-lo`, `ivory-front`, `ivory-lip`): piano-key faces, front lips and pressed faces; `engrave` is the cut legend.
- **Key Slot** (`slot`) and **Bakelite** (`bakelite`): the dark slot keys sit in and the knob caps.
- **Programmheft Paper** (`paper`, `paper-2`, `card`, `field`): program sheets, the program card, form fields. Inks `ink`, `ink-2`, `ink-3`; hairlines `rule`, `rule-strong`.
- **Hardboard** (`board`, `board-2`, `board-ink`, `board-field`): the back panel (menu). A page switches to it by re-pointing the paper ink and rule tokens, so every sheet component works on it unchanged.
- **Focus** (`focus-on-light` blue, `focus-on-dark` pale gold): the only non-period colours, used solely for the 3px focus outline. Each surface sets `--focus` for its own ground (dial and keys: blue; cabinet and back panel: gold).

### Named Rules
**The One Signal Rule.** Red means "the station that plays" or "this key is down"; it never decorates. Pilot lamps (a red radial bulb), the pointer, the lit station and the latched legend are its only homes, plus error and danger text.

**The Two Illuminations Rule.** Every colour exists for Day and Night under the same name. New surfaces use tokens, never literal hex, so that Night comes for free. Night lowers wood, cloth and paper and raises the dial glow (`spill`), the eye glow and a warm `paper-glow`.

## Typography

**Badge Font:** Yellowtail (with Brush Script MT, cursive)
**Body Font:** Jost Variable (with Jost, Futura, Century Gothic, system-ui)
**Dial / Label Font:** Barlow Condensed 500 and 600 (with Jost)

All three are self-hosted through @fontsource (`@fontsource-variable/jost`, `@fontsource/barlow-condensed` latin 500/600, `@fontsource/yellowtail` latin 400).

**Character:** A period geometric sans for everything printed on paper, a narrow condensed face for everything printed on glass, ivory or brass, and one chrome-script signature on the badge. It reads like a 1950s radio and its program booklet.

### Hierarchy
- **Badge** (Yellowtail 400, clamp(24px, 7.4vw, 30px), 1): only the brand badge on the cloth, "true-shuffle", dark brown engraved into brushed brass.
- **Dial title** (Barlow Condensed 600, 25px, 1.1, 0.05em, uppercase): words on the dial (sign-in, switching on, Suchlauf, faults).
- **Dial station** (Barlow Condensed 500, 18px, 1.06, 0.05em, uppercase; 16px under 360px): station names printed on the glass; lit and selected go to 600. Frequency line 13px, number box 12px.
- **Display** (Jost 600, clamp(28px, 8.4vw, 36px), 1.06, -0.01em): program-sheet masthead titles. On the back panel's plate: 26px, 0.02em.
- **Headline** (Jost 650, 18px, 1.3): run-in section heads, set inline with their text followed by ". ".
- **Title** (Jost 600, 17.5px, 1.2): song title on the program card, two lines max.
- **Body** (Jost 400, 16px, 1.45); **Lede** (15.5px, 1.6, max 62ch); **Hint** (13.5px, 1.5).
- **Label** (Barlow Condensed 600, 14.5px, 0.08em, uppercase): key legends on sheet keys; piano-key legends 11.5px, 0.04em (13px, 0.08em on desktop); terminal legends 16px.
- **Label small** (Barlow Condensed 600, 12px, 0.18em, uppercase): knob names (KLANG, SENDERWAHL), band legends, wave-band lamps, detents.

### Named Rules
**The Name Rule.** The name is always "true-shuffle", lower case with a hyphen, never "True Shuffle" and never set in capitals. It must never sit inside an uppercase-transformed element (dial lettering, key legends, terminal legends, tags). On the badge it is set in Yellowtail.

**The Printed-Where-It-Lives Rule.** Condensed uppercase belongs to glass, ivory, brass and printed legends; running text on paper is Jost in sentence case. Don't set paragraphs in Barlow Condensed or legends in Jost.

## Layout

Phone first: a single column `shell` (max 560px, 10px side padding, 16px from 420px, safe-area aware), gap 20px. The cabinet is a grid of five stacked areas: cloth (badge and eye), dial, window (program card), extra (knobs and keys), base; gap 10px, padding 10px. The phone dial is a vertical scale down the right edge with the string and pointer on it; station rows sit on their own short strip of printed scale, each at least 44px tall.

Desktop (from 980px): the radio becomes landscape, max 1360px; the dial turns horizontal with stations in bands (auto-fit columns, min 118px) under printed band legends and the pointer running across. Station pages use a split: the radio (max 860px, sticky at 24px) and the station's program sheet beside it (360–440px), gap 36px; the radio stands on a walnut sideboard edge drawn under it.

Program sheets: padding 18px 18px 30px, sections 26px apart, section inner gap 10px, stacks 12px. Rows are 56px minimum; terminals 58px; keys 50px (back key 44px); every tap target is at least 44px.

## Elevation & Depth

Depth is physical and lit from above: highlights on top edges (inset white or cream 1px lines), shade under lips and in slots (inset dark shadows), and a cast shadow on the wall below the cabinet. Nothing floats on a neutral drop shadow; every shadow belongs to a material (lacquer, brass edge, key lip, slot, paper lying on a surface). Night deepens `cast` and dims wood via `wood-dim`.

### Shadow Vocabulary
- **Cabinet on the wall** (`inset 0 2px 1px rgba(255,238,208,.55), inset 0 12px 16px -10px rgba(255,230,190,.3), inset 0 -6px 10px rgba(0,0,0,.42), 0 2px 2px rgba(0,0,0,.35), 0 30px 40px -22px var(--cast)`): the one cabinet.
- **Brass ring** (`0 0 0 2px var(--brass), 0 0 0 3px rgba(30,16,4,.55–.6)`): cloth and dial bezel.
- **Slot** (`inset 0 4px 8px rgba(0,0,0,.9)` over a `#050201 → slot → #24160c` gradient): the keyboard and any shared key row.
- **Ivory key joint** (inset 1px lit left edge, shaded right edge); **key pressed** (`inset 0 5px 7px rgba(30,18,4,.55)` plus a 7px sink).
- **Window paper** (`inset 0 4px 9px rgba(40,20,5,.42)`): the card seen through the brass window.
- **Sheet on a surface** (`0 1px 1px rgba(30,20,5,.2), 0 14px 30px -16px rgba(30,20,5,.55)`); desktop side sheet adds a second page edge.
- **Glow** (`0 0 38px var(--spill)` dial, `0 0 22px var(--eye-glow)` eye, `0 0 7px rgba(230,70,40,.65)` pilot lamp): light, not elevation; zero or faint by day, visible by night.

### Named Rules
**The Lit-From-Above Rule.** Every raised part has a light top edge and a shaded foot; every recessed part has its shadow at the top. If a shadow does not name a material and a light source, it does not belong.

## Shapes

Soft period forms. The cabinet has rounded shoulders and a flatter foot (30px 30px 16px 16px / 24px 24px 14px 14px), the cloth follows it inset (22px/16px top, 5px foot); the dial bezel is 14px with 9px glass; the brass window 8px with 3px paper; the badge plate 6px. Paper is nearly square (2px), keys are 2px with square feet where they meet the slot (2px 2px 0 0). Everything round is truly round: knobs, eye, screws, pilot lamps, detent dots (50%). Screws are small radial-gradient brass heads with a rotated slot, each at a different angle.

## Components

### Piano keys (the cabinet keyboard)
Ivory keys touching in one continuous dark slot; the slot's upper lip shades them.
- **Shape:** 2px 2px 0 0, min height 60px, legend cut just above an 8px front lip.
- **Colour:** ivory gradient face, `ivory-front`/`ivory-lip` lip, `engrave` legend with a shaded top edge and a lit lower edge.
- **Hover / Focus:** brightness 1.04; focus outline inset -6px.
- **Pressed / Latched:** sinks 7px, lip disappears below the slot edge, the slot's shadow falls on its face; a latched key (pause) stays down and its legend turns `lit-deep`. The pause key is a latching toggle named by its engraving.
- **Power key:** larger (64px) with a red pilot lamp beside a 16px legend.

### Sheet keys
The same ivory key family on paper, each seated in a slot of its own (a 3px `slot` rim drawn by shadows); Barlow Condensed 600 14.5px uppercase legend.
- **Primary:** same ivory, with a lit red pilot lamp (8px) before the legend. There is no coloured button fill anywhere.
- **Danger:** `danger-key` legend. **Back:** 44px. **Small:** 46px.
- **Shared slot:** keys side by side touch in one slot (`row-actions`).

### Printed actions
What should not look like a key is printed: a full-width line of Jost 600 16px ruled above and below with a dotted leader running to the margin; hover tints the row with `row-hover`; danger in `lit-ink`.

### The dial (signature)
A brass-ringed dark bezel holding the backlit glass with a bright top edge and a diagonal reflection band. Stations are rows of number box, condensed uppercase name and a small frequency-style count. States: waiting (print-2), selected with the knob (600), lit (red, scale 1.05, red glow), held in pause (red, not glowing). Hover underlines the name. Along the foot of the glass a row of wave-band lamps (7px dots, lit red when on).
- **Pointer:** a red needle with a dark rider on a thin string, gliding to the lit station over 1150ms with `--ease-string` (`cubic-bezier(0.34, 1.26, 0.5, 1)`), a slight string overshoot. While switching on (Suchlauf) it sweeps the scale, 3.4s ease-in-out alternate.

### Magic eye
A 52px brass-ringed lens with two green half-disc fans. States: open (playing), weak, tuned, tuning (closes and reopens during a pointer glide), off. Transitions 900ms `--ease`.

### Knobs and detents
Bakelite caps (66px, 60px under 380px) in a brass conic ring with an inlaid ivory pointer line and printed ticks round them; names in label small, `wood-ink` on wood, `ink` on paper. Klang has three detents printed round it, each a 44px button with a dot that lights red when chosen. Knobs turn by drag (`--turn`).

### Program card
The card behind the brass window: paper texture on `card`, cover art 64px (2px radius, fades in 420ms), song in title style, artist, reason, and the round as a printed tick scale with a red 3px mark at the position.

### Program sheets and back panel
- **Sheet:** paper gradient with grain and a double-rule masthead (3px double `rule-strong`), title in display style.
- **Back panel:** hardboard texture, a row of vent holes, four corner screws, and a riveted key-brass type plate as the masthead. It re-points ink and rule tokens so every sheet component renders on it.
- **Lists:** printed running order: rows ruled with `rule`, framed by `rule-strong`; reasons as small condensed uppercase marks with a ring bullet, favourites and discoveries in `lit-ink`. Tables (`ledger`) follow the same ruling.
- **Terminals (menu entries):** a 16px brass screw head, a condensed uppercase legend, a Jost sub-line, a line under it.

### Inputs and switches
- **Field:** `field` fill, 1.5px `rule-strong` border with a 2.5px `ink-2` underline, 3px 3px 1px 1px, min height 48px, 16px text; caret in `lit-ink`.
- **Checks and radios:** a printed box on the sheet, ticked in ink with an SVG tick mask.
- **Toggle lever:** a bakelite bat on a brass nut thrown from -34deg (Aus) to 34deg (An), legends either side, the active one bold.
- **Selectors:** positions with a pilot lamp over each; the chosen lamp lit red.

### Status strip and rating slip
- **Strip:** a fixed message at the foot in dial glass with a 3px brass gradient border, 10px radius; slides up 12px and fades in over 220ms.
- **Slip:** a paper dialog with a brass border (7px radius), dimmed backdrop `rgba(20,12,4,.55)`, actions as sheet keys.

### Icons and rasters
- **Icons:** Lucide line icons via `lucide-preact` (ThumbsUp/ThumbsDown, Disc3, Music2, Speaker, Minus, Plus), 20px at 1.9 stroke by default; small marks (ticks, scale, holes) are inline SVG data URIs or masks. No emoji or Unicode glyphs as icons.
- **Rasters:** `/tex/walnut.webp`, Poly Haven "Smoked Walnut Veneer", CC0 1.0, scaled 2048 to 1600px and graded as lacquered walnut; `/tex/cloth.webp`, Poly Haven "Hessian 380", CC0 1.0, 900px crop graded golden. Each carries its origin, licence and processing in a `.json` beside it. Any new shipping raster must carry the same provenance file.

## Do's and Don'ts

### Do:
- **Do** build every control as a physical part of the radio: an ivory key in a slot, a bakelite knob in a brass ring, a lever, a printed station on the glass, a screw-terminal on the back panel.
- **Do** keep every station printed on the dial at all times; mark the playing one by striking it forward and lighting it red, not by hiding the others.
- **Do** use tokens for every colour so Day and Night both work; set `--focus` for the surface's ground.
- **Do** mark a primary key with a red pilot lamp beside its legend, never with a coloured fill.
- **Do** set lists and settings as a printed Programmheft: rules, run-in heads, dotted leaders, condensed legends.
- **Do** keep tap targets at least 44px.
- **Do** keep `--ease-string` (`cubic-bezier(0.34, 1.26, 0.5, 1)`) on the dial pointer's glide: it is the one sanctioned exception to the no-bounce rule (recorded in `.impeccable/config.json` `detector.ignoreValues`), and reduced motion reduces it to 1ms.
- **Do** give every shipping raster a provenance `.json` beside it (origin, licence, processing).

### Don't:
- **Don't** write the name as "True Shuffle" or set it in capitals, or place it inside an uppercase-transformed element.
- **Don't** use overshoot or bounce easing anywhere except the dial pointer; everything else moves on `--ease` (`cubic-bezier(0.16, 1, 0.3, 1)`) at 120ms or 220ms, the eye at 900ms.
- **Don't** bring back the car head-unit world: black VFD glass, machined silver keys, dot-matrix display type.
- **Don't** use app cards, floating tiles, streaming-app chrome or a numbers cockpit; progress is a small printed scale with a red mark.
- **Don't** introduce a second accent hue; red is the signal, green is only the magic eye, brass is metal.
- **Don't** use flat brass; brass is always a lit gradient.
- **Don't** add emoji, Unicode glyphs as icons, or generic drop shadows that name no material.
