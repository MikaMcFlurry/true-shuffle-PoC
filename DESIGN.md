# DESIGN.md — DER LAUFZETTEL

The design record for the true-shuffle interface: what it is, why it is that
and not something else, and which rules a future change is not allowed to break
without deciding to break them on purpose.

---

## 1. The thesis

> A run is a record crate you work through, and a shop divider marks exactly
> where you are. Everything behind the divider is played, everything in front is
> still to come. Moving that divider forward **is** the advance.

The category default for anything that touches music is a cover-art hero with a
round play button in the middle. This interface refuses it, because this product
is not about the current song. It is about the shelf and how much of it is left.

That single sentence decides the type scale:

| Element | Treatment | Why |
|---|---|---|
| Cards remaining | `--t-disp` (4.25rem), mono, tightest tracking | It is the subject |
| Playlist name | `--t-2x`, Archivo 700 | It is the run's identity |
| Current song | `--t-lg`, reading size | It is one card of many |

Inverting those three would be a different product. If a future change makes the
current song the largest thing on the run page, that change has replaced the
thesis, and the rest of this document stops applying.

---

## 2. Where the world came from

The form is a **Plattenschrank** — a record shop's crate and the shop's own
apparatus for tracking work through it.

It got here by a route worth recording, because two of the steps were user
corrections and both were right:

1. Impeccable's derivation produced four grounded candidates from `PRODUCT.md`.
   Candidate 4, a **Zettelkasten** (card index with a travelling divider), fit
   the mechanism exactly: a deck of cards, dealt once each, with a marker at the
   position.
2. The user accepted the *structure* and rejected the *material*: index cards
   are not music. Same interface logic, re-materialised to records.
3. The first record build was still judged "too AI-heavy". A finish review named
   the reason precisely: the world was **carried almost entirely by one 56px
   component**. Everything around that component was a generic product UI —
   rounded cards, floating panels, chips — with record vocabulary on top.
4. The user supplied a reference standard: ten sites, each committing its
   *whole surface* to a domain-derived interface logic — a dimensioned technical
   drawing, a physical radio tuner, a transit operations console, a legal file
   with margin numbering.

Step 4 is what this build answers. The method was never the problem; the
**execution intensity** was.

Seed key `743b623c`.

---

## 3. What "the whole surface commits" means here

Concretely, the things that changed from a generic product UI to this:

**The page is a shopfront, not a nav bar.** `.shopfront` is full-bleed and
sharp, and the sections are `.register` tabs sitting *on* the fascia — one of
them filled with the divider yellow — rather than pills floating above it.

**Every region is a named bay with a reading.** `.bay-head` carries a name on
the left and a measurement on the right: `IM FACH … 5 GESPIELT · 1.477 OFFEN`,
`ALS NÄCHSTES … 8 VON 1.477`, `DEINE PLAYLISTS … 12 PLAYLISTS`. A region with
nothing to read still says so (`wird gelesen`, `nicht geladen`, `—`). This is
the single change that does most of the work: it turns panels into instruments.

**Sections are numbered in the margin.** `.section > .index` prints `01 LAUF`,
`02 DAS FACH` in the left gutter, because a shop's bays are numbered. On narrow
screens the gutter collapses and the number becomes a leading line.

**There is an operating rail.** `.opsrail` sits under the fascia on every page
and states what this installation is: how many connectors have credentials, how
many accounts are connected, and the one fact that never changes —
`TON · IMMER ÜBER DEN DIENST`. true-shuffle never plays audio; it only decides
what comes next. A test pins that string so it cannot quietly disappear.

**The run carries a Laufzettel.** A job ticket in `.ticket` key/value rows:
service, mode, source, position, and whether the server is following playback.
That is where reference data lives, instead of accumulating as badges.

**Nothing is rounded and nothing casts a shadow.** `border-radius: 0`
everywhere, including on form controls; separation is hairlines and bay heads.
There is no `box-shadow` in the stylesheet at all.

---

## 4. The rules

These are enforceable claims, not preferences. Each one can be checked.

### 4.1 Two typefaces, and the split is a rule

Archivo speaks. Space Mono is allowed **only for data** — counts, positions,
catalogue numbers, durations, times, config keys, the section index. If it is a
sentence, it is not mono.

Both are self-hosted from `app/static/fonts/` under the SIL Open Font License
(~67 KB, latin subsets). Not a CDN: this app is meant to run on a laptop that
may be offline, and a webfont request to a third party would leak every page
view. See `app/static/fonts/README.md`.

### 4.2 The accent has a job list

`--tab` (fluorescent divider-card yellow) is spent on exactly three things:

1. the divider in the crate,
2. the current register tab,
3. the primary action.

Nothing else is permitted to be bright. When the watcher state needed a mark it
went onto the Laufzettel as a coloured *value*, not a second filled chip —
because two filled yellow chips mean the accent has stopped meaning anything.

### 4.3 The crate is the largest thing, and it is spines

`.crate-row i` has `max-width: 13px`. Without that ceiling a short deck renders
fat blocks and the element reads as a bar chart — the one thing it must not look
like. A spine is thin.

`.crate-divider` moves on `transform: translateX()`, placed from a **measured
bar offset** (`bar.offsetLeft`), not from a percentage. A percentage resolves
against the row's own box; at 83 bars it drifted several spines away from the
bar it claimed to mark. The bar count is measured from the row's content width —
the row carries no padding, so nothing inflates the count into an overflow.

Bars are rebuilt only when the deck's size changes. An advance moves one
element, because a teleporting divider does not say "moving it forward is the
advance".

### 4.4 What is left is loud; what is played lies down

`--spine` vs `--spine-done`. This ordering was inverted once — played stubs were
rendered *louder* than unplayed bars, which contradicts the thesis — and it is
the regression most likely to reappear. Current measured values against the
crate floor:

| | dark | light |
|---|---|---|
| `--spine` (still to come) | 3.87:1 | 3.08:1 |
| `--spine-done` (played) | 1.53:1 | 1.39:1 |

The played stubs are **deliberately below** the 3:1 non-text threshold. That is
a considered exception, not an oversight: how much is played is carried
redundantly in text on the same screen (`5 GESPIELT · 1.477 OFFEN`,
`1.477 KARTEN ÜBRIG`, and the divider's own position), so the stub is not the
sole carrier of that information. Raising it to 3:1 would re-invert §4.4, which
is a worse outcome than the exception.

### 4.5 The divider never depends on chroma alone

In dark, `--tab` is 16.12:1 against the crate floor and a hairline edge is
enough. In light the fill is 1.03:1 — nearly invisible — and the whole mark
rests on its outline, which is 6.07:1 against the ground and 5.92:1 against its
own fill. That is why `--tab-edge` exists: 1px in dark, **2px in light**. A
future change that removes the outline removes the divider in light mode.

### 4.6 Honesty about state

From `PRODUCT.md`: *the interface must never imply a service is verified working
when it is not.* In practice:

- Planned connectors are labelled `Geplant` and list what is unresolved. They
  are a roadmap, not a claim.
- The unofficial YouTube Music connector states, on its own connect page, that
  it speaks an internal API, can break without notice, and very likely violates
  YouTube's terms.
- Handoff mode says per service whether your **position** can be counted, which
  is a different question from whether anything must stay open. Both are shown
  as separate marks (`.openness`) because users conflate them otherwise.
- A run that fails to load blanks its readings to `—` rather than leaving `0
  Karten übrig` next to dead buttons. An em dash is a smaller lie than a zero.

### 4.7 German interface, English codebase

All user-facing text is German, including provider capability notes, planned
connector entries and API error messages, with German thousands separators
(`_de()` in `providers/youtube.py`). All class names, ids, function names and
comments are English. This split is from `PRODUCT.md` and is deliberate.

---

## 5. Decisions worth defending

**Artist tints were removed.** Earlier the up-next list tinted each row by a
hash of the artist, so a cluster of one artist ahead of you was visible. It said
something true and checkable. It was still cut, because six tints in a list is
the single loudest violation of §4.2 in a world that is otherwise nearly
monochrome. The palette rule was worth more than the feature.

**`alert()` is gone.** The disconnect failure path used a native alert — the one
element on the page that belongs to the browser rather than to this world. It
now writes to a `.note`.

**A failed import no longer wipes the runs table.** It previously rendered the
"could not load runs" empty state, destroying a table that had loaded fine
seconds earlier. A failed import now says the import failed, and nothing else.

**The table head is restored on every load, not hidden once.** It was hidden for
the empty state and never brought back, so the first successful load after an
import showed eight columns of unlabelled data.

**Grid floors are `minmax(min(300px, 100%), 1fr)`.** A hard 300px floor is wider
than a 320px viewport minus padding, and pushed the whole page sideways. Chips
in bay heads wrap for the same reason.

**Below 560px the fascia gives up letter-spacing, then the wordmark text, before
it gives up a tab.** A tab you have to discover by swiping is a tab most people
never find. The link keeps its accessible name via `aria-label`.

---

## 6. Verification

| Check | Command | State |
|---|---|---|
| Tests | `.venv/bin/python -m pytest -q` | 250 passed |
| Lint | `.venv/bin/python -m ruff check .` | clean |
| Anti-patterns | `npx impeccable detect app/` | 0 findings |
| Contrast, both themes | `scratchpad/contrast.py` | all text passes; only §4.4's deliberate exception below threshold |
| Horizontal overflow | 15 widths, 320–1920px | 0 everywhere |

The detector was verified to actually fire (it reports `transition: width` on a
planted sample) before its clean result on this codebase was believed.

---

## 7. What is deliberately not done

- **No cover art anywhere.** It would make the current song the subject.
- **No progress bar for the current track.** The unit of this product is the
  card, not the second.
- **No animation beyond the divider's travel** and two loading indicators. All
  three are disabled under `prefers-reduced-motion`.
- **No visual distinction between a skipped and a completed card** in the crate.
  Both consumed a card; that is the honest reading of §2.2 of the product spec.
