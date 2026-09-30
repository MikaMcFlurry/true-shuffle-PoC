# True Shuffle restart — owner intent

The owner instructs a fresh restart from the current Cloudflare app, with Mika Dev Studio, Impeccable and the relevant Mika workflows, and a complete self-contained Codex implementation handoff. This sentence records the original preparation scope. The downstream implementation and authorized Cloudflare rollout are now complete; current acceptance remains PARTIAL as recorded in EVIDENCE.json. Verdict: ACCEPT_WITH_REDESIGN.

KEEP the effective discovery and forgotten-playlist experience, preferences and accumulated history. IMPROVE recovery, quota behavior and device handling. ADD a stable session/checkpoint contract and explicit HA/MA capabilities. REDESIGN the entire radio interface independently. The latest owner request supersedes old radio design instructions and the old restart-means-reshuffle contract. No automatic new queue on a normal Play.

## Protected requirements

- **NN-01** — Continue the actual Cloudflare application; establish source and deployment identity before live changes.
- **NN-02** — Preserve the existing listener history, memory, stations, preferences and account isolation.
- **NN-03** — Normal Play resumes the same durable session and ordered queue; a new queue requires a distinct explicit action.
- **NN-04** — Preserve the unfinished queue occurrence and latest observed position; if position is unavailable, replay that occurrence from its beginning.
- **NN-05** — Recognize Spotify-side Play of the same session, including after leaving the car; do not commandeer unrelated playback.
- **NN-06** — The same Spotify identity can resume on another browser/device; stale UI and stale device selection cannot replace its session.
- **NN-07** — The ordered queue can continue across rounds, app closure, pauses and restarts without losing its unfinished occurrence.
- **NN-08** — Keep discovery, old playlist resurfacing, history import, mix controls, advanced rules, favourites, bans and guest/private behavior.
- **NN-09** — Handle Spotify rate/quota limits truthfully, respect provider cooldowns on every path, and reduce measured request pressure.
- **NN-10** — Support and verify Spotify Connect through Music Assistant plus a separate capability-based route for native HA/MA players.
- **NN-11** — Build an independent calm music-player UI in German, retaining true-shuffle branding and making resume, device and queue state legible on mobile and desktop.

## Decisions and delegation

- D-01: Cloudflare/Preact/Hono/Durable Objects is the application baseline. Python main and closed PR #7 are historical; none of their verification applies here.
- D-02: Resume unfinished music takes precedence over legacy tests requiring a fresh order after a pause. Keep historical listening/taste accounting independent of queue completion.
- D-03: Preserve all useful discovery/customization and stored user data. Avoid a replacement rewrite.
- D-04: The new calm music-player direction is delegated to Studio/Impeccable within the owner-approved brief. Exact visual tokens are a proposal, not an owner-approved screenshot.
- D-05: Produce a branch and one Codex start prompt now. Codex must implement the product, update truth and collect evidence; another plan alone will not finish the downstream task.

## Design brief — implementation proposal

The first screen answers three questions: What will continue? Where will it play? What comes next? Album artwork, track/artist and an honest progress readout lead. The main action is “Fortsetzen”, with a selected device beside it and the next few songs in order. A persistent saved-session indication explains paused and disconnected states without turning them into errors. Station selection and mix settings remain reachable; advanced controls move into a clearly labelled secondary surface. “Neue Warteschlange” is a separate deliberate action, never the default Play behavior.

Use a quiet music-player visual system: restrained surfaces, strong hierarchy, one accent, readable text, generous transport hit areas, and stable artwork/queue alignment. Keep lower-case hyphenated true-shuffle branding. Support dark and light modes, keyboard focus, reduced motion, touch and screen-reader labels. Do not carry wood, radio knobs, skeuomorphic speaker grilles or the legacy Python Listening Room layout into the new design by default. Loading, empty, quota, no-device, stale/offline, unrelated playback and interrupted-session states belong in the design from the beginning.

Impeccable direction candidates within this fixed product brief (planning only; no UI has been built):
1. Focused artwork player — large artwork with compact ordered list.
2. Editorial listening desk — strong typographic song hierarchy and a fine-lined queue.
3. Soft album canvas — artwork-derived muted field and transport shelf.
4. Queue-led player — dense but calm list with a clear current-song anchor.
5. **Persistent listening shelf** — current artwork/track anchored above a transport shelf, device beside resume, ordered queue below; muted surfaces and a fine persistent progress line. Use as the starting proposal.
6. Split listening workspace — restrained desktop two-column player and settings, collapsing to one column on mobile.
7. Compact listening journal — current playback followed by clearly separate upcoming and recent listening lists.

These span artwork, editorial/list and workspace families. Local Impeccable seed e3d1637a selected candidate 5 in degraded mode. The roll service remained unavailable after an escalated same-seed retry; no challenger or quality-board result exists. The pinned owner brief overrides any roll. Codex must run its context workflow and present/render the real first surface before treating this proposal as a finished visual design. Keep the current DESIGN.md as incumbent evidence until an actual replacement is built, then update design truth and sidecars together.
