# Listening Room — approved direction

The owner selected a calm, dark music-player interface on 2026-09-29. This replaces the previous Nachtpult / Laufzettel visual identity. The implementation is code-led: no generated-image comp is authoritative.

## Product and first viewport

The user returns to the same saved listening session. Current song, transport, and output device are the primary task. Queue and progress explain continuity, not a decorative metric. Desktop uses a permanent left navigation and adjacent listening / queue regions. Phone uses a compact song row and full-width controls before queue content. No aurora, gradients, glowing panels or record-crate metaphor.

## System

Warm near-black with soft mint accent; Archivo is self-hosted. Explicit light theme remains available. Colour never asserts that audio plays: provider observations do. Track name is the dominant player typography. Cover art is secondary; unavailable art is stated honestly. Buttons and focus stay recognisable, with 44px minimum targets and reduced-motion support.

## Signature interaction

Return to an old tab: reload persisted session state and available devices, preserving an explicitly selected device only while it still exists. Play resumes the existing run. The UI does not create a new run to recover an expired device or an API failure.

## Preserved capabilities

Provider attribution, user rules, recommendations, favourites, exclusions, import/export, history and run lifecycle remain accessible. There is no newly claimed Home Assistant adapter, cross-browser identity or infinite queue implementation in this design.

## Quality bar / honest risk

Transport and the selected output must be easy to find on 390×844 and desktop. Long content must wrap; both themes must retain text contrast. This direction deliberately uses familiar player controls. It must not confuse a live watcher with audible playback, nor claim that all supported services work without an open tab.
