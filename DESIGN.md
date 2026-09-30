---
name: true-shuffle
description: A quiet album-library desk with a persistent listening shelf.
colors:
  bg: "#f6f5f1"
  surface: "#fffefa"
  layer: "#eeede7"
  ink: "#202b28"
  muted: "#626c66"
  line: "#d7dbd3"
  accent: "#245c49"
  on-accent: "#ffffff"
  danger: "#a13232"
  focus: "#197752"
  bg-night: "#151b19"
  surface-night: "#1c2420"
  layer-night: "#242e28"
  ink-night: "#f0f2e9"
  muted-night: "#b0bbae"
  line-night: "#39463c"
  accent-night: "#b5d6a6"
  on-accent-night: "#172719"
  danger-night: "#f4aaa2"
  focus-night: "#c0e5ae"
typography:
  headline:
    fontFamily: "Jost Variable, system-ui, sans-serif"
    fontSize: "1.9rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Jost Variable, system-ui, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Jost Variable, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  action:
    fontFamily: "Jost Variable, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
rounded:
  artwork: "5px"
  control: "6px"
  player-art: "8px"
  dialog: "10px"
spacing:
  small: "8px"
  row: "14px"
  medium: "16px"
  mobile-page: "20px"
  section: "24px"
  large: "28px"
  wide: "32px"
  page: "40px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "10px 18px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "10px 18px"
  icon-button:
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    width: "44px"
    height: "44px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.artwork}"
    padding: "10px 12px"
  notice:
    backgroundColor: "{colors.layer}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "13px 16px"
---

# Design System: true-shuffle

## Overview

**Creative North Star: "The Persistent Listening Shelf"**

A quiet album-library desk gives the unfinished song, observed position and ordered queue a stable home. Album artwork, self-hosted Jost and fine separators carry the character; the German controls serve brief visits between long listening sessions.

Warm off-white and deep forest neutral themes share the same structure. Lower-case true-shuffle remains the name. This records the built Preact interface, replacing the rejected radio documentation; surface-specific composition and direction evidence live in `.impeccable/surfaces/src-client.md`.

**Key Characteristics:**
- Album artwork anchors the current song.
- Fine rules organize continuous lists.
- Muted green marks actions and selected state.
- Saved listening remains visible through interruption.

## Colors

### Primary

Green `accent` carries the primary action, progress, status and selected feedback; `on-accent` supplies its paired text. `focus` supplies keyboard outlines. `danger` identifies errors and destructive actions.

### Neutral

`bg` is the page ground; `surface` supports fields and secondary controls; `layer` supports selected navigation, notices and station selection. `ink`, `muted` and `line` separate content, supporting text and rules. Frontmatter holds the exact day and night values; runtime CSS uses the same semantic names in each theme.

**The Paired Theme Rule.** Use the semantic CSS properties for every new surface. System dark preference applies unless day is pinned; `data-illumination="night"` pins night.

## Typography

Self-hosted Jost Variable is the only shipped type family, with system-ui and sans-serif fallbacks. The root size is 16px. Paragraphs use body line height; controls inherit the font rather than inventing a display face.

Page and section headings use the frontmatter hierarchy. The current song is 1.85rem/1.25 on desktop, 1.5rem at 1050px and 1.35rem at 780px; artist text is 1.12rem. The brand is 1.55rem, weight 600, tracking -0.035em, reducing to 1.35rem on mobile. Queue titles use weight 500; supporting text typically uses 0.9rem; timing uses 0.82–0.85rem and tabular numerals. Mobile timing reduces to 0.78–0.8rem.

**The Name Rule.** Keep true-shuffle lower case with its hyphen and German interface labels in sentence case.

## Layout

The centered app shell is at most 1280px including 40px side padding. Playback and library form a flexible column plus 320px column with 56px gap. At 1050px, padding becomes 28px, library 270px and gap 32px. At 780px, padding becomes 20px and the library follows playback and queue, separated by a rule and 40px grid gap. At 360px, side padding becomes 14px and station choices become a single column. Secondary pages center within 820px.

Current artwork steps from 210px square to 160px, 130px and 105px at those breakpoints. Queue rows use 14px vertical padding, 14px gaps and 48px artwork; mobile uses 10px gaps and 42px artwork. Station choices use two columns on mobile above 360px. Long titles and device/status text wrap rather than forcing horizontal overflow.

**The Continuous List Rule.** Group content with spacing and fine rules; use the ordered queue's sequence as its hierarchy.

## Elevation & Depth

Most surfaces are flat. Artwork alone receives `0 10px 28px #00000016`; the feedback toast uses `0 6px 20px #00000024`; the dialog uses `0 12px 40px #00000030` over a `#0008` backdrop. Depth supports imagery and temporary overlays, without ornamental material simulation.

## Shapes

Small rounded controls and artwork sit among straight separators. Controls and notices use the control radius; covers and fields use the artwork radius; large player artwork and dialogs have their own larger radii. SVG icons accompany actions; album imagery is content, and missing artwork uses a neutral placeholder.

## Components

Buttons have a 44px minimum height and 10px 18px padding. Primary buttons pair accent and on-accent; secondary buttons pair surface and ink with a one-pixel rule. Icon buttons remain 44px square, including at 320px; pressed feedback uses layer and accent. Primary hover brightens by 1.06; secondary and icon hover use layer. Disabled actions use 0.5 opacity and a default cursor.

Fields have a 48px minimum height and 10px 12px padding. Device choice is a native select, full-width with a 44px minimum height and bottom rule on mobile. Native radios and checkboxes are 19px controls inside larger labeled options; checked options use layer and accent borders. Navigation uses plain links; current page uses layer and ink. Keyboard focus on buttons, links, inputs, selects and summaries is a three-pixel focus outline with four-pixel offset.

Notices use layer, a one-pixel rule and 13px 16px padding (12px on mobile). Loading uses static layer skeletons. Offline keeps the last saved song and queue visible, disables dependent actions and offers “Erneut verbinden”. Errors remain plain text with danger color; transient feedback appears in the status toast.

**The Observed Position Rule.** Progress displays the last observed position, without fabricated ticking. Unknown position says the same song starts from the beginning. Fortsetzen becomes Pause only for the associated active session. Station selection preserves saved content while playback is unresolved. “Neue Warteschlange” asks inline before replacement and sends an explicit newQueue request on both Spotify Connect and native HA/MA transports.

Native device copy distinguishes ordered-queue support from single-song playback and seek support from starting the same song again. Pause and next are capability-gated; a pending command offers cancellation while retaining position. These are interface and API facts, not a claim of live Spotify or HA/MA acceptance.

Button background state transitions use 160ms ease-out. Reduced motion disables transitions and animations and restores automatic scroll behavior; there is no staged entrance.

## Do's and Don'ts

### Do:
- **Do** preserve the saved song, observed position and ordered queue through interrupted states.
- **Do** use semantic theme colors, visible focus and 44px transport targets.
- **Do** show device capabilities and pending or unavailable states in plain German.

### Don't:
- **Don't** replace ordinary resume with a new queue or silently imply unsupported seek or automatic next.
- **Don't** reintroduce the rejected wood, knobs, grilles or radio ornament.
- **Don't** invent listening progress, metrics or successful live-device verification.
