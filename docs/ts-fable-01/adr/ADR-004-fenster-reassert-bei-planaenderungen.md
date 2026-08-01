# ADR-004 — Fenster-Re-Assert bei Planänderungen während der Wiedergabe

Status: Angenommen · Datum: 2026-08-01 · Ergänzt ADR-002 (uris-Fenster-Strategie)

## Kontext

Die adversarial verifizierte Evidence-Matrix stufte UC-20, UC-27 und RUN-08 als
**hohes strukturelles Live-Divergenzrisiko** ein: `set_track_exclusion`,
`change_run_rules` und `apply_sync_to_run` replanten nur das Ledger
(`_replan_tail`), sendeten aber nie ein neues Provider-Kommando und ließen den
Fensteranker (`_window_anchors`) unangetastet. Bei Playlists ≤ Fenstergröße
(250, `DEFAULT_WINDOW_SIZE`) wird im ganzen Lauf keine Fenstergrenze erreicht —
ein ausgeschlossener Titel wäre live bis Laufende unverändert weitergespielt
worden. ADR-002 nennt „Regeländerung" selbst als Auslöser für ein neues
Player-Kommando; dieser Auslöser war nicht implementiert.

Verwandtes Restwissen (SP-006/RUN-02): `_window_anchors` ist prozesslokal; nach
einem Prozessneustart wurde das Fenster erst an der nächsten Advance-Grenze
re-asserted — mit hörbarem hartem Titel-Restart (offset 0, Position 0).

## Verglichene Strategien

**S-A — Nur Anker-Invalidierung (lazy):** Nach jedem Replan
`_forget_window(run_id)`; der nächste Advance re-asserted ein frisches Fenster.
+ Kein zusätzliches Kommando, keine neuen Fehlerpfade.
− Der alte Kontext läuft an der Trackgrenze zuerst in den ALTEN Folgetitel
(bis zu ein Poll-Intervall hörbar); ist dieser Titel ausgeschlossen, ist er aus
`order` entfernt → `reconcile` klassifiziert ihn als **Drift** → F8-Episode;
bei `auto_pause`/`ask` pausiert bzw. fragt der Lauf, obwohl der Nutzer nur
einen Titel ausgeschlossen hat. Fachlich falsch.

**S-B — Sofortiger Re-Assert immer:** Jede Planänderung sendet sofort
`PUT /play` mit dem frischen Fenster.
+ Live-Queue stimmt sofort.
− Ein zusätzliches Kommando auch dann, wenn sich das hörbare Fenster gar nicht
geändert hat (deterministischer Redraw, `after_cycle`/`ignore`-Sync); Kommandos
ohne Positionserhalt starten den laufenden Titel hörbar neu; Kommandos während
Drift/Manual-Episoden kämpfen gegen den Nutzer (verletzt F8 „beobachten statt
kämpfen").

**Entscheidung: S-C — Hybrid (Invalidierung + konditionaler nahtloser
Re-Assert + Watcher-Selbstheilung):**

1. **Sicherheitsnetz:** `_replan_tail` vergisst den Anker immer — spätestens
   der nächste Advance re-asserted. Invariante: ein gesetztes Fenster, das dem
   Plan nicht mehr entspricht, gilt nie als gesetzt.
2. **Sofortpfad (Routen exclude/reactivate/rules/apply-sync):**
   `runs.reassert_window` sendet genau dann EIN `play`-Kommando, wenn
   (a) sich das hörbare Fenster (`order[cursor:cursor+window]`) tatsächlich
   geändert hat, (b) der Lauf ACTIVE ist, keine F8-Episode offen ist und
   (c) der Provider nachweislich unseren aktuellen Titel spielt
   (`get_playback_state`). Das Kommando trägt denselben aktuellen Titel als
   `uris[0]` und `position_ms` = beobachtete Position → nahtlose Fortsetzung.
   Ausgänge im API-Payload (`window`): `reasserted` / `unchanged` /
   `not_driving` / `failed` (ehrlich, mit Ledger-Event
   `window_reasserted`/`window_reassert_failed`).
3. **Watcher-Selbstheilung:** Spielt der erwartete Titel, ohne dass ein Fenster
   bekannt ist (Prozessneustart, fehlgeschlagener Sofortpfad), re-asserted der
   Watcher das Fenster positions-erhaltend unter dem Advance-Lock. Damit
   entfällt der dokumentierte hörbare Titel-Restart nach Neustart
   (SP-006-Restnotiz zu UC-14/RUN-02).

## Konsequenzen

- Kosten: je wirksamer Planänderung während aktiver Wiedergabe ein
  `GET /me/player` + ggf. ein `PUT /play`; Planänderungen sind nutzergetrieben
  und selten — quotenneutral gegenüber dem Polling.
- `position_ms` stammt aus dem letzten Poll/Abruf; zwischen GET und PUT
  vergehen ~100 ms → minimaler Rücksprung, kein Neustart.
- Web-Player-Läufe: unverändert — der Browser liest den Plan bei jedem Poll.
- Während F8-Episoden und Drift wird weiterhin nichts gesendet; der Ausgang
  `not_driving` plus vergessener Anker konvergiert über den bestehenden
  F8-/Advance-Weg.

## Live-Vorbehalt (ehrlich)

Simulator-verifiziert (`tests/test_window_reassert.py`, rot vor dem Fix);
live unbestätigt bleiben: reales Verhalten von `PUT /play` mit `uris` +
`position_ms` mitten im Titel (Gapless/Glitch), Latenz des Positionserhalts.
→ `LIVE_TEST_GUIDE.md` Abschnitt „Ausschluss/Regeländerung während laufender
Wiedergabe" (LT-14).

## Rollback

Revert der Commits zu ADR-004 stellt das Verhalten „Replan nur im Ledger"
wieder her; Schema unberührt, keine Migration beteiligt.
