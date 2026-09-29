---
name: true-shuffle — Listening Room
description: A calm listening surface with transport first and the saved queue alongside.
colors:
  canvas: "#101412"
  surface: "#181E1B"
  surface-2: "#222B26"
  line: "#344239"
  line-strong: "#758C7D"
  ink: "#F0F4EF"
  muted: "#A8B9AC"
  signal: "#B1E8C6"
  signal-ink: "#14251B"
  state-b: "#F4B897"
  state-c: "#E8CC85"
  state-d: "#B7C4C0"
  ember: "#FF9A9F"
  light-canvas: "#F4F7F2"
  light-surface: "#FFFFFF"
  light-surface-2: "#E8EFE7"
  light-line: "rgba(34,28,54,.14)"
  light-line-strong: "#6E8273"
  light-ink: "#18291F"
  light-muted: "#4E6455"
  light-signal: "#246242"
  light-signal-ink: "#FFFFFF"
  light-state-b: "#914625"
  light-state-c: "#725814"
  light-state-d: "#4F605A"
  light-ember: "#A92639"
typography:
  track-title:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif'
    fontSize: "clamp(28px, 3.7vw, 46px)"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-.035em"
  body:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif'
    fontSize: "0.9375rem"
    lineHeight: 1.5
  label:
    fontFamily: 'Archivo, system-ui, sans-serif'
    fontSize: "0.75rem"
    fontWeight: 700
rounded:
  button: "6px"
  card: "8px"
  field: "9px"
  full: "999px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  7: "32px"
  8: "40px"
  9: "56px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
    rounded: "{rounded.button}"
    padding: "10px 20px"
  transport-main:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
    rounded: "{rounded.full}"
    width: "72px"
    height: "72px"
  field:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "0 12px"
---

# Design System: true-shuffle — Listening Room

## Overview

**Creative North Star: "Listening Room"**

A calm music-player interface centres the current song, familiar transport and selected output. The saved queue and progress explain the listening session beside it. Cover art is secondary; absent art has an honest fallback. German is the interface language; implementation and documentation remain English.

This is the implemented direction approved on 2026-09-29 in `docs/persistent-queue/DESIGN_DIRECTION.md`. It replaces the previous visual identity. It records the current surface, not a promise that every continuity target in `PRODUCT.md` is delivered.

**Key Characteristics:**

- Warm near-black, soft mint and explicit light mode.
- Archivo, restrained panels and readable song titles.
- Desktop navigation rail; compact phone song row and full-width controls.
- State expressed in words and shape as well as colour.

## Colors

Mint is the primary action and selected-navigation accent. Near-black grounds the dark interface; surface tones organise content without glowing panels. Light mode uses pale green-grey ground, white surfaces and deep green action colour. Coral, gold, slate and error red remain functional state colours; provider identity retains its own attribution.

**The Evidence Rule.** Colour and watcher liveness never establish audible playback. An active run is not necessarily playing. Remote playing state uses provider `is_playing` observations; a freshly loaded web player begins idle. Status chips describe control ownership, not proof that sound is audible.

`app/static/tokens.css` is the executable source of truth for colours, scales, target sizes and theme variants. The frontmatter is a portable snapshot, not a second runtime theme. `app/static/style.css` supplies shared primitives; `app/static/listening-room.css`, loaded last, supplies the current visual overrides. Some legacy comments and unused tokens remain in the CSS; their wording does not supersede the rendered Listening Room system.

The blocking script in `base.html` restores a stored dark/light choice before first paint and defaults to dark. If storage is unavailable, the CSS media-query fallback follows the OS. The theme button offers the other explicit theme.

## Typography

Archivo is self-hosted through `app/static/fonts/archivo-var-latin.woff2`, with variable weights 100–900 and `font-display: swap`; no external font service is required. System sans-serif fallbacks cover loading failure.

The current song uses the largest player type, a tight line-height and modest negative tracking. At phone widths it is 28px; artist text is 16px there and 18px elsewhere. Playlist headings use `clamp(26px, 3vw, 40px)` at weight 600. Body and metadata follow the shared token scale. Numeric time and progress use tabular figures, not a separate decorative mono identity. Long titles wrap rather than forcing a wider page.

## Layout

At 1100px and wider, a fixed 208px left rail contains Start, Hörvorgänge, Bibliothek, Dienste and Konfigurationen, plus connection status and the theme action. The main page offsets by the rail width and has 48px desktop insets. Playback and queue use adjacent columns in a 1.2:1 ratio with a 48px gap and a dividing hairline. Desktop artwork is 160px alongside the song details.

Below that rail breakpoint, navigation returns to a top bar and listening content stacks. Below 640px, navigation wraps visibly and the page has 20px horizontal insets. Artwork becomes an 88px companion to the title and artist. Position, attribution, transport, hint, output selector and device refresh each span the full song-row width. Queue content follows below a divider. Transport is centred on phones; desktop keyboard hints are hidden there.

**The Transport First Rule.** Player notes and state banners follow the song and transport region in DOM order. Errors and manual-control messages remain discoverable without displacing the primary controls above them.

## Elevation & Depth

The Listening Room player is flat, with transparent playback/queue regions, tonal surfaces and hairline separation. Cards, cover artwork and run cards explicitly remove shadows. The shared stylesheet still has a shadow token for other surfaces; do not infer that all application components are shadow-free. Aurora artwork and app-bar decoration are suppressed; gradients and glowing panels are not part of this direction.

## Shapes

Rectangular controls have gently rounded corners: buttons and messages use the frontmatter button radius, cards use the card radius, and fields retain the shared field radius. Transport remains circular. Shared controls have a 44px minimum touch target; secondary transport is 56px and the main transport is 72px. Meaning-bearing borders use the strong line colour; decorative hairlines do not carry essential information alone.

## Components

- **Transport:** previous, start/pause and next rule-compliant title. Disabled controls retain readable text and visible borders; click and shortcut handlers honour `aria-disabled`.
- **Output:** remote providers expose an output selector and Geräte aktualisieren. Returning via visibility, page restore or online refresh reloads persisted run state and available devices; an explicit device selection is retained only while present. Recovery resumes the existing run rather than silently creating a new shuffle.
- **Queue:** progress, next-title preview, per-row favourite/weight/exclusion actions, provider constraints and helper-playlist notices. Expanded details explain provider-specific control. History, export and end-run actions stay accessible, with excluded titles in a separate disclosure.
- **Attribution and feedback:** the provider identity and playback location remain visible. Missing cover art uses a labelled fallback. Notes and state banners explain failures or control handover after the transport region.
- **Keyboard:** Space toggles, Right advances and Left goes back. Shortcuts yield to input/select/textarea fields, focused buttons, links, summaries, contenteditable controls and role buttons, and to Meta/Ctrl/Alt combinations. They do not intercept normal control activation. Focus uses a visible two-pixel accent outline. Reduced-motion preference suppresses inherited animations/transitions and smooth scrolling.

Verification recorded for this change: **752 Python tests passed; 17 browser regression tests plus 3 continuity browser tests passed.** The final combined browser rerun is pending. The independent finish reviewer returned **SHIP** for the reviewed UI with its listed findings resolved; that verdict does not replace the pending combined run. Rendered evidence includes `.impeccable/review/desktop.png`, `mobile.png` and `mobile-light.png`.

Limits: these are local automated and demo-rendered results. No live Spotify playback or Home Assistant / Music Assistant verification was performed. The system does not claim infinite listening sessions, cross-browser account identity, a native HA/MA adapter, or universal playback without an open tab. Provider-specific constraints remain material. The screenshots show tested compositions, not a guarantee that arbitrary long content fits every first viewport.

## Do's and Don'ts

### Do:

- Keep the current song, transport and selected output easy to find on desktop and phone.
- Use runtime tokens and the final Listening Room stylesheet when extending the interface.
- Preserve provider attribution, selection rules, recommendations, favourites, exclusions, import/export, history and run lifecycle.
- Describe known playback and continuity state with words the evidence supports.

### Don't:

- Restore the superseded record-crate, divider or oversized remaining-count hierarchy.
- Turn watcher liveness, a control-ownership chip or an active database run into a claim that sound is playing.
- Hide provider restrictions or claim unverified Spotify, cross-browser or HA/MA continuity.
- Add auroras, gradients or glowing panels to this visual direction.
