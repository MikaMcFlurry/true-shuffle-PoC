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
Owner revision 2026-09-27 (3): "Das Design ist besser, aber das Logo von true-shuffle sieht nicht gut aus und die Radio-Form ist noch etwas komisch." Decided without a further question (the owner asked to proceed): the script badge on a screwed brass plate reads as a souvenir sign, not a maker's emblem; the tall narrow cabinet on the phone reads as a wooden phone case, and the desktop's flat cloth panel on the left reads as a pinboard. Anti-references added: script plates with screws, a radio silhouette that follows the viewport.
Build path: code-led (no image generation in this environment).

## Direction contract

THESIS: The phone screen is the front of a 1950s German tube radio. Stations are printed on its warm, backlit glass dial like Hilversum and Beromünster; tapping one sends the red pointer gliding there on its string, and Spotify plays it. Every control is a physical part of the cabinet: ivory piano keys in their slot, brass-ringed knobs, a woven speaker cloth. Refuses app cards, streaming chrome and the head-unit look.

OWN-WORLD: Walnut veneer cabinet with rounded shoulders and a thin brass trim; a finely woven golden speaker cloth across the top of the front, crossed by two thin brass trim bars; the maker's emblem "true-shuffle" (always lower case) as cast brass letters in a Futura-like geometric (Jost) mounted straight on the cloth and casting a shadow onto it, the trim bars running level with its hyphen: no plate, no screws, no script; a cream glass dial lit from behind, printed in brown-black with one signal red for the pointer and the lit station; ivory piano keys with engraved legends, seated in a dark key slot, a pressed key stays down; bakelite knobs with brass rings; a green magic eye (EM-tube fan) seated in the dial's bezel as the one living light. Paper for lists: a program card behind a brass frame, and printed program-sheet pages ("Programmheft") for station pages, history and menu. Two illuminations: day (radio on a sideboard by a light wall) and night (dark room, dial and magic eye glow).

STORY: The listener sees on the dial which station plays and on the program card what song, taps a station name, the pointer glides, it plays. Keys below do thumb down, pause, next, thumb up. Settings live on the back of the radio and in the program sheet pages.

FIRST VIEWPORT: Phone: the screen is the radio's face in close-up, edge to edge; the cabinet has no outline of its own at this width. The cloth with the emblem on top, a real speaker area rather than a header strip; the glass dial across the width, all stations printed on it, the playing one lit, pointer on it, each name with its round count in small print like a frequency; the magic eye in the dial's bezel; the program card (cover, song, artist, reason, "Runde n · x von y gehört"); the four piano keys; MENÜ and VERLAUF as smaller keys; the knobs may fall below the fold, the keys may not (390×844, six stations). The face ends in the cabinet's plinth. Desktop: the whole radio in the classic German table-radio silhouette: landscape, softly rounded shoulders and a lit top edge, straight sides, a plinth with two small feet on the sideboard; the cloth across the full width of the upper front with the emblem centred; one wide dial strip under it; along the bottom the Klang knob, the keyboard, the Senderwahl knob. The program card leaves the cabinet on the desktop and heads the program sheet beside the radio, so the song appears once.

FORM: 50er Röhrenradio — pinned by the owner (structured answers above); seed key 6e6030b2 rolled after the pin, the pin beats the roll. Silhouette and emblem pinned by revision (3). Raise kept from the dealt challenger "struck cathode gauze" (declined, loses on audience identification): every option is present at once — all stations always printed on the dial, the chosen one struck forward and lit, the others printed and quiet. Signature interaction: tuning — tapping a station glides the pointer along the dial with a slight string overshoot while the magic eye closes and reopens.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
