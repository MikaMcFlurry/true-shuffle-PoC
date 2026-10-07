---
version: 1
slug: "src-client"
primary_target: "src/client"
related_targets: []
---

# true-shuffle app
Mode: Operate. Build path: code-led (recorded default). Owner (2026-10-07) asked for all four dealt directions built side by side and switchable in the menu ("Gestaltung"), so the owner can live with each before choosing. Focus: Song + Play/Pause. Theme: automatic (system), day and night fully drawn for every design. The concert-poster world is replaced in full.
## Direction contract
THESIS: One shared, standard listening shell (header nav, stage with song and transport, saved queue, Sender list, menu pages) carries four complete brand worlds. Each world lends only type, palette, density and one signature move; layout, controls and every honest state stay identical. Refuses the dark Spotify clone as the only option and the previous poster.
OWN-WORLD: Kontaktbogen (assigned): photo-paper ground / darkroom night, black film strip with sprockets, grease-pencil colour per Sender, Hanken Grotesk + Martian Mono edge print; signature: current cover boxed in grease pencil on a strip with the next queue frames, round as barcode. Linienplan (challenger, wins): signage white / midnight enamel, one line colour per Sender, Atkinson Hyperlegible Next; signature: queue as stops down the Sender's line, line badges S1…, round as line. Strichliste (pick): Karopapier / Tafel, graphite and marker, Bricolage Grotesque; signature: round counted in five-bundles, marker underline under the title. Klassisch (canon): system face, rounded, big centred cover, circular play key.
STORY: Glance: which song, which Sender, playing or not, confirmed or not. Tap: Fortsetzen/Pause, Weiter, Favorit, nie wieder, device. Scroll: Als Nächstes in stored order, then Sender. Menu: Gestaltung picker with a mark per world.
FIRST VIEWPORT: Header (mark + lowercase wordmark, Hören/Verlauf/Menü). Stage: Sender line with round meter, cover (film strip in Kontaktbogen), title at display scale, artist/album, progress, three-step signal, main transport key plus Weiter/Favorit/nie wieder at 52px+. Device select directly below. Desktop ≥1100px: stage 7 cols, queue 5 cols, Sender full width below.
FORM: four directions shown together; assigned = own list position 5 (Kontaktbogen), challenger rail diagram, pick = position 1 (Strichliste), canon. Seed key 1857f2c8.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
## Verification boundary
Local Worker + FakeSpotify captures with synthetic artwork; live Spotify, physical iPhone and HA/MA remain NOT_RUN. Functional client state machines (store, playbackView, command handling) are carried over unchanged; design choice is a per-device localStorage preference only.
