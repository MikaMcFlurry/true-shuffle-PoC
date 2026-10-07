---
version: 1
slug: "src-client"
primary_target: "src/client"
related_targets: []
---

# true-shuffle app
Mode: Operate. Build path: code-led (recorded default). Owner (2026-10-07) rejected the first round as "the old version with other colours" and asked for genuinely new operating surfaces: the four offered concepts plus two new unique ones, all built and switchable under Menü > Gestaltung, release only on the owner's word. Focus at a glance: Song + Play/Pause. Theme: automatic, day and night drawn for every design.
## Direction contract
THESIS: Six complete operating surfaces over one shared player logic. Each layout owns its structure, control placement and navigation; labels, handlers and honest states (requested/accepted/confirmed, held or estimated progress never solid) are shared and identical. Refuses one layout reskinned six times.
OWN-WORLD: Leuchttisch (kontakt): light table, slide-mounted current frame in grease pencil, queue as a contact-sheet grid, film-black transport dock. Fahrt (linie): one line through the screen, heard stops above (stored history, struck through), "Jetzt hier" interchange, next stops below, departure-board dock, Sender as network. Notizblock (strich): Karopapier, round tally hero, "Jetzt" entry card, tick-off queue, register tabs. Player (klassik): canon full player, queue as sheet, cover shelf, bottom tab bar on phones. Umlauf: round as an orbit of ticks around a circular cover, big round play in the page centre, Sender as small orbits; Lexend, pale sky / indigo night. Fahrmodus: car and one-hand mode, huge title, full-width play tile and three big square keys; Overpass, black on signal yellow / yellow on black.
STORY: Glance: song, Sender, playing or not, confirmed or not. Tap: Fortsetzen/Pause, Weiter, Favorit, nie wieder, device. Scroll: queue in stored order, then Sender. Song and play come first on phones in every design.
FIRST VIEWPORT: Per design as above; on phones the song and the main key are inside the first viewport (docked keys in Leuchttisch and Fahrt, tab bar in Player). Device choice stays inside the player section.
FORM: owner-selected set; original roll seed 1857f2c8 (assigned kontakt, challenger linie, pick strich, canon klassik) plus two owner-requested originals (umlauf, fahrmodus) avoiding the owner-rejected radio metaphor.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
## Verification boundary
Local Worker + FakeSpotify with synthetic artwork; the full Playwright suite (42 tests) passes under each of the six designs via TS_DESIGN. Live Spotify, physical iPhone and HA/MA remain NOT_RUN. Fahrt reads stored history only when the saved occurrence changes, never for a display-only estimate.
