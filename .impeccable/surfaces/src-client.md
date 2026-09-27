---
version: 1
slug: "src-client"
primary_target: "src/client"
related_targets: []
---

# true-shuffle app (all screens)

Scope: the whole signed-in app plus sign-in. Mode: Operate.
Audience/job: see PRODUCT.md. Glance 2–3 s, tap a station, gone.
Owner answers: home = station list + "Jetzt läuft"; no Spotify look, no numbers cockpit, nothing playful, nothing cold; progress subtle per station.
Owner revision 2026-09-27: "Der Aufbau von UI geht in die richtige Richtung aber UX gefällt mir noch nicht so gut sieht irgendwie billig aus." Direction chosen: **Premium-Radio** — "Radio-Idee bleibt, aber edel: Albumcover im Display, feinere Materialien statt grauer Kästen, dezentere LED-Schrift, bessere Typografie und Abstände."
Build path: code-led (no image generation in this environment).

## Direction contract

THESIS: A car radio's station memory, built like a premium head unit. Stations are preset keys, the top of the screen is the radio's display, and the display shows the song's cover. Refuses the category default: cover-art grid as navigation, round green play button, dark streaming chrome.

OWN-WORLD: Faceplate in two illuminations — day: satin silver; night: graphite. The display is black glass in both, lit amber like a vacuum-fluorescent display. One neutral ramp per illumination; amber only for lit state (playing, selected, primary, the station name on the glass). One round-dot dot-matrix line (Doto, ROND axis) for the station name and page titles; everything else Overpass, legends small and tracked. Three materials: machined keys (transport and choice rows as one bar split by seams), inlaid panels for lists and settings, sunk wells for controls. Indicator legends on the glass (UNGEHÖRT, FAVORIT, ENTDECKUNG, GAST, PAUSE). A tuner scale shows a round's progress. Covers: beside the song in the display (with the cover's light on the glass) and beside every song in a list; a drawn stand-in when missing.

STORY: The listener sees what plays and on which station, taps a preset, it plays in Spotify. Settings live behind the radio's MENU and each station's EINSTELLEN, in the radio's menu grammar (balance bar for Entdecken ↔ Vertraut).

FIRST VIEWPORT: Phone: black-glass display across the top third (legend row; station name in round-dot matrix; cover beside song, artist, time · device; status line; tuner scale with needle + "Runde 2 … 1.240 von 9.300 gehört"). Transport bar below (Daumen runter, Pause, Weiter, Daumen hoch). Then a two-column grid of preset keys 1…n, each with its 8-character name, lit LED when playing, a hairline scale of its round. MENU and + SENDER as faceplate keys at the bottom. Desktop: faceplate centred, presets in four columns, station panel beside.

FORM: Autoradio-Senderspeicher — Impeccable's pick (my list #1), chosen by the owner over the assigned Programmzeitschrift; seed key b340f6d5. Raises kept from the round: every number sits next to what it counts; size, not colour, marks the playing station; one neutral ramp; every song carries its reason; the round as a numbered sequence. Signature interaction: pressing a preset tunes — the needle sweeps to the station's position while the name rewrites in the display.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
