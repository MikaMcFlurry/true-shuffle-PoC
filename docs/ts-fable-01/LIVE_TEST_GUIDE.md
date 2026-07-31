# Live-Testanleitung Spotify (redigiert) — Phase 2

Lauf: TS-FABLE-01 · Stand: 2026-07-31 · Status des Live-Gates: **BLOCKED** (keine Credentials in der Umgebung)

Diese Anleitung macht die `VERIFIED_LIVE`-Beweise nachholbar, sobald eine Person mit
Premium-Testkonto und realem Gerät zur Verfügung steht. Sie folgt dem
Phase-2-Instrumentierungsplan §3 und `handoffs/TS-FABLE-01/05_SPOTIFY_LIVE_WORK_PACKAGE.md`
(§„Zuerst instrumentiert reproduzieren“, §Live-Testkern). Die simulierten Gegenstücke
(Evidenzklasse `VERIFIED_AUTOMATED`) liegen in `tests/test_queue_regression.py`,
`tests/test_strategy_candidates.py` und `tests/forensics/strategy_bench.py`; jeder
Live-Fall bestätigt oder falsifiziert dort deklarierte Annahmen (AN-1..AN-4,
`tests/sim_spotify.py`).

## 1. Voraussetzungen

1. **Spotify-Developer-App** (Development Mode) im Dashboard anlegen.
   - Seit Februar 2026: Der **Owner der App braucht Premium**, sonst funktioniert die
     App im Entwicklungsmodus gar nicht; **höchstens 5 Nutzerkonten** können je App
     im Dashboard freigeschaltet werden; seit Juli 2026 gilt die Quota **pro
     Developer-Account** (max. 25 Client-IDs), nicht pro App.
   - Redirect-URI **zeichengenau** eintragen: `<BASE_URL>/auth/spotify/callback`.
2. **Dediziertes Premium-Testkonto**, im Dashboard der App als Nutzer eingetragen.
   Kein privates Hauptkonto verwenden (Redaktionsregeln, §3).
3. **Mindestens ein reales aktives Gerät** (Smartphone/Desktop-App). Vor jedem Test:
   Spotify öffnen und kurz etwas abspielen, damit ein Gerät „aktiv“ ist.
4. **`.env`** nach `.env.example`: `SPOTIFY_CLIENT_ID`, `BASE_URL`, `SECRET_KEY`
   (32+ Zufallszeichen). Kein Client-Secret nötig (PKCE).
5. Scopes werden vom Code angefordert (`providers/spotify.py::SCOPES`); beim ersten
   Connect alle bestätigen (`user-read-playback-state`, `user-modify-playback-state`,
   `user-read-currently-playing`, `user-read-recently-played`, Playlist-Scopes).
6. Testplaylisten im Testkonto anlegen (eigene Playlists — fremde sind seit
   Februar 2026 nicht mehr lesbar): **6 Tracks**, **20 Tracks**, **100+ Tracks**.
   Kurze Titel (~2–3 min) beschleunigen jeden Durchlauf.

## 2. Instrumentierung einschalten

1. `LOG_LEVEL=INFO` — der Logger **`ts.provider.command`** schreibt je Command eine
   Zeile `corr=<kurz-uuid> run=<id> kind=<play|enqueue> target=<track_id> cursor=<n>`.
   Eine `corr`-Id klammert ein Play mit seinen Prefetch-Appends.
2. Snapshots vor/nach jedem Schritt (die beiden Lese-Endpunkte sind die gesamte
   Queue-Werkzeugkiste — es gibt kein Remove/Clear/Reorder):
   ```bash
   # $SPOTIFY_TOKEN nur als Shell-Variable, niemals ins Protokoll kopieren
   curl -s -H "Authorization: Bearer $SPOTIFY_TOKEN" \
        "https://api.spotify.com/v1/me/player" | jq '{is_playing, progress_ms, item: .item.id, device: .device.type}'
   curl -s -H "Authorization: Bearer $SPOTIFY_TOKEN" \
        "https://api.spotify.com/v1/me/player/queue" | jq '{now: .currently_playing.id, queue: [.queue[].id]}'
   ```
   Alternativ programmgesteuert: `SpotifyProvider.get_queue()` (neu in Phase 2)
   liefert `{currently_playing_id, queue_ids}`.
3. Vor jedem Fall: **Shuffle und Repeat in der Spotify-App kontrolliert AUS**
   (05 §Zuerst instrumentiert reproduzieren, Schritte 1–3) und initialen
   Player-/Queue-Zustand als Snapshot `T0` erfassen.
4. Run-Ledger auslesen: `run_events`-Tabelle (`data/true_shuffle.db`) oder API —
   je realem Übergang darf höchstens **ein** `advanced`-Event existieren.

## 3. Redaktionsregeln (verbindlich)

- **Niemals** ins Protokoll: Access-/Refresh-Tokens, `Authorization`-Header,
  Client-ID, Account-IDs/-Namen/E-Mail, Gerätenamen oder Geräte-IDs.
- Gerät nur als Typ nennen („Smartphone“, „Desktop“).
- Track-IDs sind öffentliche Katalogdaten und bleiben drin — sie sind der Beweis.
- Snapshots vor Ablage durch die `jq`-Filter oben redigieren (sie enthalten dann
  keine Geräte-IDs/-Namen mehr).
- Screenshots: Kontoname/Avatar schwärzen.

## 4. Testfälle

Notation: „Snapshot“ = beide Reads aus §2.2 mit Zeitstempel. Jeder Fall beginnt bei
Snapshot `T0` (frischer Zustand, Shuffle/Repeat aus) und endet mit dem ausgefüllten
Formular aus §5.

### LT-1 · „Titel 6 = Titel 1“ beweisen oder falsifizieren (SP-001, klärt AN-2)

1. Run über die UI mit der **6-Track-Playlist** starten (Live-Modus).
2. Snapshot direkt nach Start: erwartet `now = Titel 1`, `queue = [Titel 2..6]`
   (genau 5 Appends, Log zeigt 1×`play` + 5×`enqueue` unter einer `corr`).
3. **Nicht eingreifen**; alle 6 Titel durchlaufen lassen. Nach jedem Titelende
   Snapshot (mindestens: nach Titel 5 und nach Titel 6). *Für den reinen
   AN-2-Beweis den Watcher/Prozess nach Schritt 2 stoppen, damit keine weiteren
   Appends die Beobachtung überlagern.*
4. Beobachten, was **nach Titel 6** passiert:
   - Spielt Titel 1 erneut → AN-2 = `replay_context` **bestätigt** (Mechanismus aus
     `test_sixth_title_hypothesis`),
   - Stille/Player stoppt → AN-2 = `stop`,
   - anderes Verhalten → exakt dokumentieren (AN-2 neu fassen).
- **PASS (nach Fix):** kein ungewollter Neustart von Titel 1 im Run-Verlauf; das
  rohe Spotify-Verhalten nach Erschöpfung ist dokumentiert.

### LT-2 · 20-Track-Start und natürliche Ends (SP-002, SP-008-Repro)

1. Run mit der **20-Track-Playlist** starten; Snapshot: Queue exakt `[t2..t6]`-Fenster,
   keine Mehrfacheinträge.
2. Zwei Titel natürlich zu Ende spielen lassen; nach jedem Ende Snapshot + Logzeilen
   sichern.
- **Erwartung mit aktuellem Code (Repro, „rot“):** nach jedem Advance werden 5 Titel
  erneut angehängt; die Queue enthält Duplikate (Sim-Vorhersage: max. 3× nach zwei
  Ends — vgl. `test_start_then_natural_ends_duplicates_queue`).
- **PASS (nach Fix, „grün“):** kein Titel mehr als 1× in der Queue; Ledger: je Ende
  genau ein `advanced`-Event mit `reason=track_ended`.

### LT-3 · Zehn native Skips (SP-003)

1. Run mit der 20-Track-Playlist starten.
2. **In der Spotify-App** 10× „Weiter“ drücken, zwischen den Skips ~5 s warten;
   nach jedem Skip Snapshot.
- **Erwartung mit aktuellem Code:** Play-Override startet den bereits laufenden
  Titel hörbar neu; Queue wächst je Skip um ein weiteres 5er-Fenster
  (vgl. `test_native_skip_reappends`).
- **PASS (nach Fix):** je Skip genau 1 Karten-Verbrauch im Ledger, keine
  Queue-Vervielfachung, kein hörbarer Titel-Neustart.

### LT-4 · Doppelter Watcher-Tick (SP-004)

1. Run starten; zusätzlich ein zweites Browser-Fenster mit derselben Run-Ansicht
   öffnen (bzw. `POST /api/runs/{id}/event` für dasselbe Trackende doppelt senden).
2. Ein Titelende passieren lassen; Snapshots + Ledger.
- **PASS:** derselbe reale Übergang wird höchstens 1× angewendet (Advance-Lock);
  keine zusätzlichen Queue-Einträge durch die Doppel-Lieferung.

### LT-5 · Retry nach Timeout (SP-005)

1. Während eines laufenden Runs die Netzverbindung des Servers kurz trennen
   (oder per Firewall blocken), bis ein Provider-Call fehlschlägt; wieder verbinden.
- **PASS:** der Watcher überlebt (Retry-Pfad), es entsteht **kein doppelter
  fachlicher Advance**; Ledger und Queue konsistent.

### LT-6 · Prozessneustart mitten im Run (SP-006)

1. Run starten, 3 Titel durchlaufen lassen; Snapshot.
2. App-Prozess beenden; 30 s warten (Spotify spielt weiter); Prozess neu starten,
   Run fortsetzen.
- **Erwartung mit aktuellem Code:** Resume re-appendiert das volle Fenster auf den
  Bestand (Sim: max. Dup steigt auf 6 — `test_status_quo_restart_makes_the_queue_worse`).
- **PASS (nach Fix):** Cursor unverändert aus der DB, Reconciliation gegen
  Player/Queue-Snapshot, keine neuen Duplikate.

### LT-7 · Play-Override vs. manuelle Queue (klärt AN-1, UC-17/18)

1. Run starten; in der Spotify-App **2 Titel manuell in die Queue** legen
   (Titel, die nicht im Run sind); Snapshot: manuelle Titel sichtbar.
2. In True Shuffle „Weiter“ drücken (löst `PUT /me/player/play` aus); Snapshot.
- **Ergebnis dokumentieren:** Überleben die manuellen Titel den Override
  (AN-1 bestätigt) oder sind sie weg (AN-1 falsifiziert → Simulator und
  Strategiebewertung anpassen)? Wann spielen sie?
- **PASS (nach Fix):** manuelle Titel werden nicht überfahren; Verhalten entspricht
  der dokumentierten Manual-Use-Policy.

### LT-8 · Drift durch manuelle Nutzung (Pflichtzustände aus 05)

1. Run starten; in der Spotify-App **einen fremden Song**, dann **ein Album**
   manuell starten.
- **PASS:** True Shuffle erkennt Drift, kämpft nicht um den Player, Cursor bleibt
  stehen; `drift`-/`drift_resolved`-Events im Ledger.

### LT-9 · Randbedingungen (Auszug Live-Testkern 05)

Je ein Kurzprotokoll für: kein aktives Gerät (Erwartung: 204 → `is_idle`, klare
UI-Meldung), Pause in Spotify und in True Shuffle, Gerätewechsel während des Runs,
Tokenrefresh nach >1 h, 100+-Track-Playlist (Quota/429 beobachten: `Retry-After`
notieren, strukturierter Body `reason: QUOTA_EXCEEDED` seit Juli 2026), Ende eines
No-Repeat-Durchlaufs, Resume nach mehrstündigem Unterbruch.

## 5. Ergebnisformular (je Testfall kopieren)

```
Testfall:        LT-_  (SP-___ / AN-_)
Datum/Zeit:      ____-__-__ __:__ (UTC__)
Commit:          ________  (git rev-parse --short HEAD)
Gerätetyp:       ________  (kein Name, keine ID)
Playlist:        __ Tracks (eigene Test-Playlist)
Snapshots:       T0 __:__ · T1 __:__ · ... (redigiert, als Anhang)
corr-Ids:        ________________________
Beobachtung:     ______________________________________________
Erwartung lt. Anleitung erfüllt:  PASS / FAIL / TEILWEISE
Annahmen-Update: AN-_ bestätigt / falsifiziert / offen
Abweichungen / Notizen: _______________________________________
```

Ablage: redigierte Protokolle unter `docs/ts-fable-01/live-runs/<datum>-LT-<n>.md`;
Rohdaten (falls Token-berührt) verbleiben lokal und werden **nicht** eingecheckt.

## 6. Nach dem Lauf

1. AN-1/AN-2-Ergebnisse in `tests/sim_spotify.py` (Docstring) und im ADR vermerken;
   falls falsifiziert: Simulator-Default ändern und Suite erneut laufen lassen.
2. SP-Matrix (`handoffs/TS-FABLE-01/08_ACCEPTANCE_TEST_MATRIX.md`, G3) mit
   PASS/FAIL + Evidenzverweis füllen; Evidenzklasse der betroffenen Gates von
   `VERIFIED_AUTOMATED`/`BLOCKED` auf `VERIFIED_LIVE` heben.
3. Policy-Gate beachten (05 §Policy-/Business-Gate): keine „policy compliant“-
   Aussage ohne dokumentierte Prüfung.
