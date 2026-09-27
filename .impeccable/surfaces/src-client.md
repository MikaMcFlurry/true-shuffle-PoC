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
Owner revision 2026-09-27 (1): "sieht irgendwie billig aus" → Premium-Radio (car head unit). Owner revision 2026-09-27 (2): the head-unit keys and tiles looked "KI-Slop"; after a refinement still: "Neues UX gefällt mir immer noch nicht, es muss wie echte Schalter an einem echten Radio aussehen … lieber ein schönes altes Radio, und alle Tasten usw. sehen so aus, als wären sie Teil des Radios." Structured answers: **50er Röhrenradio**; stations are chosen as **names on the illuminated glass dial**, a pointer travels there. The head-unit world (black VFD glass, machined keys, Doto) is now an anti-reference.
Build path: code-led (no image generation in this environment).

## Direction contract

THESIS: The phone screen is the front of a 1950s German tube radio. Stations are printed on its warm, backlit glass dial like Hilversum and Beromünster; tapping one sends the red pointer gliding there on its string, and Spotify plays it. Every control is a physical part of the cabinet: ivory piano keys in their slot, brass-ringed knobs, a woven speaker cloth. Refuses app cards, streaming chrome and the head-unit look.

OWN-WORLD: Walnut veneer cabinet with rounded shoulders and a thin brass trim; golden woven speaker cloth with a brass "true-shuffle" badge (lower case); a cream glass dial lit from behind, printed in brown-black with one signal red for the pointer and the lit station; ivory piano keys with engraved legends, seated in a dark key slot, a pressed key stays down; bakelite knobs with brass rings; a green magic eye (EM-tube fan) as the one living light. Paper for lists: a program card behind a brass frame, and printed program-sheet pages ("Programmheft") for station pages, history and menu. Two illuminations: day (radio on a sideboard by a light wall) and night (dark room, dial and magic eye glow).

STORY: The listener sees on the dial which station plays and on the program card what song, taps a station name, the pointer glides, it plays. Keys below do thumb down, pause, next, thumb up. Settings live on the back of the radio and in the program sheet pages.

FIRST VIEWPORT: Phone: brand badge on the cloth at the top; the glass dial across the width, all stations printed on it (rows like wave bands), the playing one lit, pointer on it, each name with its round count in small print like a frequency; the magic eye beside the dial; the program card (cover, song, artist, reason, "Runde n · x von y gehört"); the four piano keys; MENÜ and VERLAUF as smaller keys. Desktop: the whole radio centred, the program sheet of the station beside it.

FORM: 50er Röhrenradio — pinned by the owner (structured answers above); seed key 6e6030b2 rolled after the pin, the pin beats the roll. Raise kept from the dealt challenger "struck cathode gauze" (declined, loses on audience identification): every option is present at once — all stations always printed on the dial, the chosen one struck forward and lit, the others printed and quiet. Signature interaction: tuning — tapping a station glides the pointer along the dial with a slight string overshoot while the magic eye closes and reopens.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
