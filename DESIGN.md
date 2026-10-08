---
name: true-shuffle
description: Deine Playlists als Kassetten. One system, a mixtape world - every station is a cassette with a fixed order, Jetzt is the brass tape deck it sits in, everything around it is the cassette's inlay card.
colors:
  # Inlay card (day)
  inlay-ground: "#e7dcc4"
  inlay-paper: "#f4ecda"
  inlay-sunk: "#dccfb2"
  ink: "#2a2017"
  ink-soft: "#57442f"
  ink-quiet: "#6a563f"
  rule: "#cbb994"
  rule-strong: "#8f7a57"
  label-stripe-red: "#c2412a"
  label-stripe-red-deep: "#a5341f"
  label-stripe-red-ink: "#ffffff"
  label-stripe-red-soft: "#f1d3c6"
  ballpoint-blue: "#24448c"
  label-tape: "#1d1b19"
  label-tape-ink: "#f3efe6"
  confirmed-green: "#1d6f44"
  wait-amber: "#7d5200"
  wait-amber-soft: "#f3e3c2"
  error-red: "#a8231b"
  error-red-soft: "#f6d7d1"
  focus-blue: "#1d5bd6"
  # Deck (day: flat warm brass)
  brass: "#d9a75f"
  brass-edge: "#a5732f"
  brass-ink: "#2a1c0a"
  brass-ink-soft: "#573c18"
  deck-key: "#efd09a"
  deck-key-hover: "#f6deb2"
  deck-key-side: "#9a682a"
  deck-key-ink: "#2a1c0a"
  bay: "#2a2116"
  hotline-orange: "#e2622a"
  counter-wheel: "#16130e"
  counter-digit: "#f3ecdc"
  # Night: dark shelf and dark bronze deck
  shelf-ground-night: "#17120d"
  shelf-paper-night: "#221a12"
  shelf-sunk-night: "#0f0b07"
  ink-night: "#f1e6cf"
  ink-soft-night: "#cdb994"
  ink-quiet-night: "#a8956f"
  rule-night: "#3a2e21"
  rule-strong-night: "#6d5a41"
  label-stripe-red-night: "#ef6b4a"
  label-stripe-red-ink-night: "#1c0d07"
  label-stripe-red-soft-night: "#3b1f16"
  ballpoint-blue-night: "#a9bef2"
  label-tape-night: "#b8322a"
  label-tape-ink-night: "#fff4ec"
  confirmed-green-night: "#5fcf8f"
  wait-amber-night: "#e9b85c"
  error-red-night: "#ff8a80"
  focus-blue-night: "#8fb4ff"
  bronze-night: "#5a4329"
  bronze-edge-night: "#2e2114"
  bronze-ink-night: "#f6e7cc"
  deck-key-night: "#7b5e3e"
  deck-key-hover-night: "#664c2f"
  deck-key-side-night: "#2e2113"
  deck-key-ink-night: "#fbefd9"
  bay-night: "#17110b"
typography:
  display:
    fontFamily: "Bricolage Grotesque Variable, Atkinson Hyperlegible Next Variable, sans-serif"
    fontSize: "clamp(1.75rem, 7.4vw, 2.25rem)"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 88"
  headline:
    fontFamily: "Bricolage Grotesque Variable, Atkinson Hyperlegible Next Variable, sans-serif"
    fontSize: "clamp(1.375rem, 6vw, 1.875rem)"
    fontWeight: 800
    lineHeight: 1.12
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 92"
  label-tape:
    fontFamily: "Bricolage Grotesque Variable, Atkinson Hyperlegible Next Variable, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "0.06em"
    fontVariation: "'wdth' 80"
  title:
    fontFamily: "Bricolage Grotesque Variable, Atkinson Hyperlegible Next Variable, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 750
    lineHeight: 1.2
    fontVariation: "'wdth' 92"
  body:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "'tnum'"
  meta:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.4
  counter:
    fontFamily: "Atkinson Hyperlegible Next Variable, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.12em"
    fontFeature: "'tnum'"
  marker:
    fontFamily: "Permanent Marker, Atkinson Hyperlegible Next Variable, cursive"
    fontSize: "0.8125rem"
    fontWeight: 400
    letterSpacing: "0.02em"
rounded:
  label: "2px"
  label-tape: "3px"
  inlay: "4px"
  key: "5px"
  r: "6px"
  r-lg: "10px"
  tabbar-desktop: "14px"
  deck: "18px"
  pill: "999px"
spacing:
  gap-tight: "8px"
  gap-key: "10px"
  gap: "16px"
  page-mobile: "16px"
  page-desktop: "40px"
  now-column-gap: "56px"
  tabbar: "64px"
components:
  key:
    backgroundColor: "{colors.deck-key}"
    textColor: "{colors.deck-key-ink}"
    rounded: "{rounded.key}"
    padding: "0 18px"
    height: "48px"
  key-hover:
    backgroundColor: "{colors.deck-key-hover}"
  key-lit:
    backgroundColor: "{colors.label-stripe-red}"
    textColor: "{colors.label-stripe-red-ink}"
    rounded: "{rounded.key}"
    height: "48px"
  key-lit-hover:
    backgroundColor: "{colors.label-stripe-red-deep}"
  deck-play-key:
    backgroundColor: "{colors.deck-key}"
    textColor: "{colors.deck-key-ink}"
    rounded: "{rounded.r}"
    padding: "6px 4px"
    height: "64px"
  deck:
    backgroundColor: "{colors.brass}"
    textColor: "{colors.brass-ink}"
    rounded: "{rounded.deck}"
    padding: "12px"
  deck-bay:
    backgroundColor: "{colors.bay}"
    rounded: "{rounded.r-lg}"
    padding: "8px"
  tape-counter:
    backgroundColor: "{colors.counter-wheel}"
    textColor: "{colors.counter-digit}"
    typography: "{typography.counter}"
    rounded: "{rounded.inlay}"
    padding: "3px 4px"
  label-tape-heading:
    backgroundColor: "{colors.label-tape}"
    textColor: "{colors.label-tape-ink}"
    typography: "{typography.label-tape}"
    rounded: "{rounded.label-tape}"
    padding: "3px 12px 4px"
  inlay-list:
    backgroundColor: "{colors.inlay-paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.inlay}"
    padding: "14px 0 0"
  tag-note:
    textColor: "{colors.ballpoint-blue}"
    typography: "{typography.marker}"
    rounded: "{rounded.label}"
    padding: "2px 9px"
  tag-note-new:
    backgroundColor: "{colors.label-stripe-red}"
    textColor: "{colors.label-stripe-red-ink}"
    typography: "{typography.marker}"
    rounded: "{rounded.label}"
    padding: "2px 9px"
  tabbar-key:
    backgroundColor: "{colors.deck-key}"
    textColor: "{colors.deck-key-ink}"
    rounded: "{rounded.r}"
    height: "56px"
  notice:
    backgroundColor: "{colors.inlay-paper}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.inlay}"
    padding: "14px 16px"
  notice-warn:
    backgroundColor: "{colors.wait-amber-soft}"
    textColor: "{colors.ink}"
  notice-error:
    backgroundColor: "{colors.error-red-soft}"
    textColor: "{colors.ink}"
  flash:
    backgroundColor: "{colors.label-tape}"
    textColor: "{colors.label-tape-ink}"
    rounded: "{rounded.inlay}"
    padding: "12px 18px"
---

# Design System: true-shuffle

## Overview

**Creative North Star: "The Mixtape on the Deck"**

true-shuffle is one system, not a set of looks. Every station is a mixtape cassette with a fixed order. Jetzt is the tape deck the cassette sits in: a flat, warm brass faceplate (dark bronze by night) with a tape counter, a status lamp, a recessed bay holding a smoked, see-through cassette, and a row of keys with drawn sides and an orange hotline edge on the play key. Everything below and around the deck is the cassette's paper: an inlay-card ground by day, a dark shelf by night, section headings on embossed label tape, lists drawn as the ruled inlay card with the label's stripes along its top, track titles in blue ballpoint, song tags as felt-pen notes, buttons and navigation as deck keys, other cassettes standing on a shelf.

The metaphor carries facts, never decoration: the reels show the share of the round already heard (left reel heard, right reel still to come), the counter shows songs heard, the label carries the station name and says it once. Everything drawn is also printed as text nearby. The deck is drawn as a flat illustration, not as imitated metal: no brushed textures, no gradients on the faceplate. The visual source is the owner's reference of a mixtape-soundtrack sleeve with a brass tape deck; the system takes the material, never the film's name or marks.

State is carried by line form, everywhere: a solid green rule only when playback is confirmed, solid grey when held, dashed while waiting or on error, dotted for estimates. The interface is German, plain-worded, glanceable from a car mount, and readable at a desk.

**Key Characteristics:**
- Flat brass deck with recessed dark bay; dark bronze at night so it does not glare in a car.
- Inlay-card paper ground by day, dark shelf by night; light/dark are illumination of the same world (Hell / Dunkel / Automatisch), never a design picker.
- Three faces with fixed jobs: Bricolage Grotesque for headings, Atkinson Hyperlegible Next for reading, Permanent Marker only for handwritten labels and notes.
- Keys, not buttons: a face plus a drawn side that sinks when pressed.
- Line form (solid, dashed, dotted) is the state language.
- The brand name is always lower-case "true-shuffle".

## Colors

A warm paper-and-brass palette with one red label-stripe accent, blue ballpoint ink and a single orange hotline on the deck.

### Primary
- **Label-Stripe Red** (label-stripe-red; night label-stripe-red-night): the cassette label's stripe. Lit keys, the three-band stripe on inlay lists, the "Empfehlung" tag, the played part of the song tape, the waiting and estimate state lines, text selection.
- **Flat Warm Brass** (brass, brass-edge; night bronze-night, bronze-edge-night): the deck faceplate, the tab bar panel and the shelf board under standing cassettes. Never used for text-bearing paper surfaces.

### Secondary
- **Blue Ballpoint** (ballpoint-blue; night ballpoint-blue-night): handwritten tracklist ink. Track titles in lists and history, felt-pen tag notes, the station name on cassette labels, text actions.
- **Hotline Orange** (hotline-orange): the deck's signal edge. Top edge and icon of the play key, the running status lamp, the current tab's icon, the dashed outline of a pending play key. Only on the deck and its keys.

### Tertiary
- **Confirmed Green** (confirmed-green; night confirmed-green-night): the state line when Spotify confirms playback, and nothing else.
- **Wait Amber** (wait-amber, wait-amber-soft): warning notices and the offline bar; the waiting lamp uses a lighter amber (#e7b552) on the deck.
- **Error Red** (error-red, error-red-soft): errors, the dashed error state line, danger key text.

### Neutral
- **Inlay Ground / Inlay Paper / Inlay Sunk** (inlay-ground, inlay-paper, inlay-sunk; night shelf-*): page ground, lists and panels, skeletons and empty covers.
- **Ink / Ink Soft / Ink Quiet** (ink, ink-soft, ink-quiet): reading text, secondary lines, meta and quiet labels.
- **Rule / Rule Strong** (rule, rule-strong): row dividers and card borders; the dashed unplayed part of tapes and inactive steps.
- **Label Tape** (label-tape, label-tape-ink): embossed heading tape and the flash toast; black tape by day, red tape by night.
- **Deck Keys** (deck-key, deck-key-hover, deck-key-side, deck-key-ink): key faces, hover faces, drawn key sides.
- **Bay** (bay): the recessed well behind the cassette and the key row.

Cassette shells keep their own seven label palettes (red, blue, green, orange, teal, violet, smoke: stripe + band pairs, cream label #efe3c6, ballpoint label ink). They identify cassettes, they are not UI accents.

### Named Rules
**The Green Means Spotify Said So Rule.** Confirmed green appears only on the state line for confirmed playback. Every other "good" state uses ink or label-stripe red.

**The Hotline Lives On The Deck Rule.** Hotline orange belongs to the deck, its keys and the tab bar's current icon. Paper surfaces use label-stripe red.

**The One Illumination Rule.** Night values are the same tokens re-lit (data-illumination day/night, or the system preference under Automatisch). There is no second palette and no design picker.

## Typography

**Display Font:** Bricolage Grotesque Variable (with Atkinson Hyperlegible Next Variable)
**Body Font:** Atkinson Hyperlegible Next Variable (with system-ui)
**Label Font:** Permanent Marker (with Atkinson Hyperlegible Next Variable, cursive)

**Character:** A compressed, punchy grotesque on the label and spine, a hyperlegible reading face for everything a driver or listener must parse at a glance, and one felt-pen hand for what was written on the cassette.

### Hierarchy
- **Display** (800, clamp(1.75rem, 7.4vw, 2.25rem), 1.15, width 88): page titles; on the deck the station title shrinks to clamp(1.375rem, 6vw, 1.75rem).
- **Headline** (800, clamp(1.375rem, 6vw, 1.875rem), 1.12, width 92): the current song title on Jetzt.
- **Label Tape** (700, 1.125rem, 0.06em tracking, width 80): section headings on embossed tape, rotated -0.8deg. Sentence case.
- **Title** (750, 1.125rem, width 92): track and station names in sheets and pickers.
- **Body** (400, 1.0625rem, 1.5, tabular numerals): all reading text; prose capped at 62ch.
- **Meta** (0.8125rem, 1.4): progress times, list sub-lines, tab labels, row tags.
- **Counter** (700, 1.25rem, 0.12em, tabular): the tape counter digits.
- **Marker** (400, 0.8125rem tags; 25px on cassette labels, rotated -1deg): cassette label names and song-tag notes only.

### Named Rules
**The Felt Pen Is For Notes Rule.** Permanent Marker writes cassette labels and song-tag notes. Never body text, buttons, headings or numbers someone must read precisely.

**The Lower-Case Name Rule.** The brand is always written "true-shuffle", lower case, in every heading, label and asset. No capitals, no small caps, no uppercase transforms anywhere.

**The Two Questions Rule.** A song's tags answer two questions in order and never mix them. First where it comes from, one coloured tag: "Aus deiner Playlist" (ballpoint blue), "Empfehlung" (label red, filled on Jetzt), "Favorit" (label red). Then what was recorded, quiet grey notes bounded to the records: "noch nicht gehört", "3× gehört, zuletzt vor 2 Monaten", "lange nicht hier" (180 days of plays log). Lists use the short forms on one line.

## Layout

Phone first. Main column max 1240px, 16px side padding, a fixed four-key tab bar (Jetzt, Kassetten, Verlauf, Mehr) at the bottom with 64px height plus safe area. Base rhythm 16px; key rows and lists use 8-10px gaps, section gaps 32px.

At 960px and wider the shell becomes a two-column grid: a 232px left column holding the brand and the tab bar as a vertical deck panel, and the main area with 28px/40px padding. On Jetzt the deck sits in a sticky left column (340-460px) with 56px column gap, and the queue, promise and shelf flow on the right. The shelf of cassette cards on Kassetten runs one column, two from 640px, three from 1280px.

The first phone viewport on Jetzt is: deck (counter, lamp, bay with spinning reels, key row), then the song with tags, progress tape, the state line and the device line.

## Elevation & Depth

Hybrid: paper is flat with one soft ambient shadow; the deck has drawn, physical depth. The bay is recessed with an inset shadow, the counter wheels are sunk, the status lamp glows when running, label tape is embossed with a 1px light/dark text-shadow, and keys get depth from a drawn bottom side, not from blur.

### Shadow Vocabulary
- **Ambient** (`box-shadow: 0 1px 2px rgb(42 32 23 / 0.1), 0 8px 22px -12px rgb(42 32 23 / 0.35)`; night `0 1px 2px rgb(0 0 0 / 0.5), 0 10px 30px -14px rgb(0 0 0 / 0.8)`): deck, inlay lists, covers, flash.
- **Bay well** (`box-shadow: inset 0 3px 8px rgb(0 0 0 / 0.55)`): the recess behind the cassette.
- **Key contact** (`box-shadow: 0 1px 3px rgb(0 0 0 / 0.25)`; deck keys `0 2px 4px rgb(0 0 0 / 0.35)`): keys resting on the plate.
- **Lamp glow** (`box-shadow: 0 0 0 3px rgb(226 98 42 / 0.2), 0 0 10px rgb(226 98 42 / 0.6)`): running status lamp only.
- **Shelf board** (`border-bottom: 10px solid brass; box-shadow: 0 8px 0 -4px brass-edge`): the board cassettes stand on.

### Named Rules
**The Drawn Side Rule.** A key's depth is its drawn bottom side (4-5px). Pressed or current, the side shrinks to 2px and the face drops 2-3px. No scale, no blur lift.

## Shapes

Soft-cornered physical objects: the deck plate 18px, the bay and cassette windows 10px, keys 5-6px, inlay card and notices 4px, label tape 3px, felt-pen notes 2px. Pills (999px) only for small status chips (guest mode, "Eingelegt"). Cassettes are SVG with a 14px shell radius, a trapezoid foot, screws and toothed hubs.

Line form is shape vocabulary: tapes, progress and step rails draw the done part solid and the rest dashed (6px dash, 5px gap); estimates are dotted; waiting and pending elements wear a 2px dashed outline.

## Components

### Buttons (keys)
Every button is a deck key.
- **Shape:** 5px corners, 48px minimum height, 0 18px padding, 4px drawn side in deck-key-side.
- **Default:** deck-key face with deck-key-ink; hover deck-key-hover.
- **Lit (primary):** label-stripe red face with its ink and a side mixed 55% toward black; hover label-stripe-red-deep.
- **Pressed / aria-pressed:** face drops 2px, side 2px.
- **Danger:** key face with error-red text.
- **Text action:** underlined ballpoint-blue text, 44px tap height.
- **Focus:** 3px focus-blue outline, 2px offset, everywhere.

### Deck (signature)
The brass plate with a 2px brass-edge border, 18px radius, 12px padding. Top row: tape counter (dark wheels, cream digits) with "x von y Songs gehört", the status lamp on the right (grey idle, hotline running, amber waiting). The bay holds the cassette and, below it, the key row: one wide play key (hotline top edge 5px, hotline icon, 64px) and three square keys (Weiter, Favorit, Nie wieder) at 64px with 5px drawn sides. A pending play key sinks and wears a dashed hotline outline. Night: dark bronze plate and keys.

### Cassette (signature)
SVG cassette: smoked see-through shell (rgb(70 62 54 / 0.62)) so the bay or page shows through, cream label with the shell palette's stripes and band, station name in Permanent Marker ballpoint ink rotated -1deg, dark window, tape reels sized from the heard share, toothed hubs that spin only while playing (and not under reduced motion). On insertion it slides into the bay once (520ms ease-out).

### Inlay list
Queue and settings lists: inlay paper with a three-band label-stripe red edge across the top (3px, 2px, 1px with gaps), 4px radius, ambient shadow, 1px rule between rows. Queue numbers in Bricolage 700 ink-quiet, titles in ballpoint blue, row tags as one quiet felt-pen line.

### Section headings (label tape)
Embossed label-tape strip: label-tape face, label-tape-ink text, 3px radius, letter-spaced, rotated -0.8deg, emboss text-shadow. Black tape by day, red tape by night.

### Chips (song tags)
- **Style:** felt-pen notes in Permanent Marker, ballpoint blue, 2px corners, currentColor outline.
- **State:** "new" is a filled label-stripe-red note tilted -1.5deg; "favourite" is label-stripe-red ink; "first in this round / long not here" is dashed. In lists tags collapse to one inline meta line.

### State line and progress
The state sentence leads with an 18px rule: solid confirmed green (confirmed playback), solid ink-quiet (held), dashed label-stripe red (waiting), dashed error red (error), dotted label-stripe red (estimate). The song progress is a tape: unplayed part dashed rule-strong; played part solid red while running, solid ink-soft when saved, dashed when held, dotted when estimated. A signal rail of steps uses dashed for not yet, solid red for reached.

### Notices
4px corners, 1px rule border, 14px 16px padding, inlay paper. Warning and error variants use the soft tint with a 45% tinted border; estimates use a 2px dotted border. The flash toast is a label-tape strip above the tab bar.

### Navigation
The tab bar is a row of deck keys on a brass panel (2px brass-edge top border). Four keys, 56px, 5px drawn sides; the current page is the key held down (side 2px, face dropped 3px, hover face) with a hotline icon. At 960px+ it becomes a vertical deck panel in the left column with 14px radius and 2px edge.

### Shelf
On Jetzt the other cassettes stand on a brass shelf board (horizontal strip); the selected cassette lifts 8px and its name gets a 3px red underline. The Kassetten page lists stations as paper cards (cassette, name, counter, meter, keys) with the inserted one outlined in label-stripe red.

### Inputs / Fields
The device selector reads like a label on the deck's side: inlay paper, rule-strong border, 4px radius. Segmented choices and sliders use the key and rule tokens.

## Do's and Don'ts

### Do:
- **Do** draw every button as a key: face plus a 4-5px drawn side that shrinks to 2px when pressed.
- **Do** carry state by line form: solid confirmed green only for confirmed playback, solid grey held, dashed waiting/error, dotted estimate.
- **Do** print every fact the cassette draws (heard share, counter, station name) as text nearby.
- **Do** write track titles in ballpoint blue and section headings on label tape.
- **Do** keep night as the same world re-lit: dark shelf, dark bronze deck, red label tape.
- **Do** write "true-shuffle" in lower case everywhere.
- **Do** honour reduced motion: reels stand still, the cassette does not slide.

### Don't:
- **Don't** offer a design picker or alternate looks; illumination is Hell, Dunkel or Automatisch only.
- **Don't** use confirmed green for anything other than confirmed playback.
- **Don't** set body text, buttons, headings or numbers in Permanent Marker.
- **Don't** render the deck as photoreal or brushed metal; it is a flat illustration.
- **Don't** name the reference film or use its title, logo or marks.
- **Don't** capitalise or uppercase the brand name or any label.
- **Don't** let song tags claim more than was recorded.
