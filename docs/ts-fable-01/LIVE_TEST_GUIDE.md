# Live-Testanleitung Spotify (redigiert) — Phase 2

Lauf: TS-FABLE-01 · Stand: 2026-08-01 (LT-13/LT-14 ergänzt) · Status des Live-Gates: **BLOCKED** (keine Credentials in der Umgebung)

Diese Anleitung macht die `VERIFIED_LIVE`-Beweise nachholbar, sobald eine Person mit
Premium-Testkonto und realem Gerät zur Verfügung steht. Sie folgt dem
Phase-2-Instrumentierungsplan §3 und `handoffs/TS-FABLE-01/05_SPOTIFY_LIVE_WORK_PACKAGE.md`
(§„Zuerst instrumentiert reproduzieren“, §Live-Testkern). Die simulierten Gegenstücke
(Evidenzklasse `VERIFIED_AUTOMATED`) liegen in `tests/test_queue_regression.py`,
`tests/test_strategy_candidates.py` und `tests/forensics/strategy_bench.py`; jeder
Live-Fall bestätigt oder falsifiziert dort deklarierte Annahmen (AN-1..AN-7,
`tests/sim_spotify.py`). Zuordnung: AN-1→LT-7 · AN-2→LT-1 · AN-3→LT-3/LT-4 ·
AN-4→LT-2 (Queue-Snapshots) · AN-5→LT-10 · AN-6→LT-11 · AN-7→LT-12.

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
  (AN-1 bestätigt) oder sind sie weg (AN-1 falsifiziert → Simulator-Default auf
  `clear_queue_on_play=True` stellen und Suite/Bench neu laufen lassen)? Wann
  spielen sie? Achtung: der Skip-Pfad-Rotbeweis
  (`test_native_skip_reappends`) ist **AN-1-BEDINGT** — bei Falsifikation
  entfällt er (siehe `test_native_skip_dup_proof_is_an1_conditional`), der
  Naturallauf-Beweis bleibt davon unberührt.
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

### LT-10 · Queue-Vorrang vor Kontext (klärt AN-5)

Der gesamte Vervielfachungsmechanismus (SP-008) ruht auf der Annahme, dass die
manuelle Queue **vor** der Kontextfortsetzung spielt. Das ist real-Spotify-plausibel,
steht aber **nicht** in den BASE-05-Dokumenten.

1. In der Spotify-App eine Playlist normal starten (kein True Shuffle nötig);
   Snapshot `T0`.
2. Während Titel 1 läuft **einen fremden Titel** (nicht aus der Playlist) manuell
   in die Queue legen; Snapshot.
3. Titel 1 natürlich zu Ende spielen lassen; Snapshot.
- **AN-5 bestätigt:** der manuell gequeuete Titel spielt VOR dem nächsten
  Playlist-Titel.
- **AN-5 falsifiziert:** der Kontext läuft weiter und die Queue kommt später/nie →
  `tests/sim_spotify.py::_advance` anpassen und Suite + Bench neu laufen lassen —
  Szenario (c)/(g) der Messtabelle und die SP-008-Mechanik hängen an dieser Annahme.

### LT-11 · Kein Dedup identischer URIs in der Queue (klärt AN-6)

Bislang stillschweigend tragend für den Duplikat-Beweis: nimmt
`POST /me/player/queue` denselben URI mehrfach als **getrennte Einträge** an?

1. Wiedergabe läuft (beliebiger Titel); Snapshot `T0`.
2. Denselben Titel **3× hintereinander** per API in die Queue legen:
   ```bash
   for i in 1 2 3; do
     curl -s -X POST -H "Authorization: Bearer $SPOTIFY_TOKEN" \
          "https://api.spotify.com/v1/me/player/queue?uri=spotify:track:<id>"
   done
   ```
3. Queue-Snapshot (§2.2): erscheint der Titel 3× (AN-6 bestätigt) oder 1×
   (AN-6 falsifiziert — Dedup)?
- **Konsequenz bei Falsifikation:** SP-008 schrumpft von „Vervielfachung“ auf
  „Fehlordnung + Command-Verschwendung“; `test_start_then_natural_ends_duplicates_queue`
  und die max.-Queue-Dup-Spalten der Messtabelle sind dann neu zu interpretieren;
  Simulator-`_apply_enqueue` mit Dedup nachrüsten und alles neu messen.

### LT-12 · Player-Commands ohne aktives Gerät (klärt AN-7)

BASE-05 dokumentiert nur `GET /me/player` → 204. Angenommen (AN-7): alle
Player-**Commands** (play, enqueue, next, pause) antworten ohne aktives Gerät mit
**404 NO_ACTIVE_DEVICE**, und `GET /me/player/queue` liefert keinen nutzbaren Body.

1. Alle Spotify-Clients schließen bzw. >5 min warten, bis kein Gerät mehr aktiv ist;
   `GET /me/player` muss 204 liefern (Snapshot).
2. Je einen Command absetzen und Status + Body notieren:
   `PUT /me/player/play`, `POST /me/player/queue?uri=...`, `POST /me/player/next`,
   `PUT /me/player/pause`.
3. `GET /me/player/queue` aufrufen; Status + Body notieren (204? 200 mit leerer
   Queue? Fehler?).
- **AN-7 bestätigt:** alle vier Commands → 404 `NO_ACTIVE_DEVICE`; Queue-Read ohne
  nutzbaren Body.
- **Teilweise/falsifiziert:** exaktes Verhalten je Endpoint dokumentieren →
  Simulator (`play`/`add_to_queue`/`next`/`pause`/`get_queue`) und die
  Szenario-(h)-Interpretation (`device_loss_survived`, `Api.queue_ids`-Mapping
  auf `[]`) entsprechend anpassen.

### LT-13 · uris-Body-Limit messen (ADR-002, vor jeder Erhöhung von N_MAX)

Das dokumentierte Limit für die Größe des `uris`-Arrays in `PUT /me/player/play`
ist unbekannt; der Default `context_window_size = 250` ist eine konservative
Annahme, keine Messung.

1. Eigene Test-Playlist mit ≥ 1 000 Titeln importieren (oder Track-IDs
   synthetisch sammeln — nur öffentliche Katalog-IDs, keine Nutzerdaten).
2. `PUT /me/player/play` mit wachsendem `uris`-Array absetzen: 50 → 100 → 250
   → 500 → 750 → 1 000. Je Stufe notieren: HTTP-Status, Fehlerbody
   (redigiert), Latenz, ob die Wiedergabe startet und `GET /me/player/queue`
   die erwarteten nächsten Titel zeigt.
3. Erste fehlschlagende Stufe binär eingrenzen (z. B. 250 ok, 500 fail →
   375 …), 3 Wiederholungen an der Grenze (Flakes ausschließen).
- **Ergebnisverwendung:** gemessenes Limit < 250 → `context_window_size`
  senken (Config, kein Codeänderungsbedarf) und ADR-002/S4-Abwägung neu
  bewerten; Limit ≥ 500 → optionale Erhöhung dokumentieren, nicht automatisch
  ausrollen.

### LT-14 · Ausschluss/Regeländerung während laufender Wiedergabe (ADR-004; UC-20/21/25/27, RUN-08/09)

Automatisiert belegt (`tests/test_window_reassert.py`, Simulator mit
AN-1…AN-7); live unbestätigt sind das reale Verhalten von `PUT /play` mit
`uris` + `position_ms` mitten im Titel und die Hörbarkeit des Übergangs.

1. Run mit ≥ 15 Titeln starten; Titel 1 bis ca. 1:00 spielen lassen.
2. **Ausschluss:** In True Shuffle den ANGEZEIGTEN nächsten Titel ausschließen.
   Erwartung: API-Antwort `window: "reasserted"`; Command-Log zeigt genau EIN
   `kind=play` mit `position_ms ≈` aktueller Position; der laufende Titel
   läuft hörbar weiter (kein Neustart, allenfalls minimaler Versatz —
   Versatzdauer notieren); `GET /me/player/queue` zeigt den ausgeschlossenen
   Titel NICHT mehr; am Trackende spielt der neue Folgetitel.
3. **Reaktivieren:** denselben Titel wieder aufnehmen → erneut
   `window: "reasserted"`, Titel wieder in der Queue-Vorschau.
4. **Regeländerung:** `min_gap`/`repeat_mode` im laufenden Run ändern.
   Erwartung: `window: "reasserted"` bei geändertem hörbarem Fenster, sonst
   `"unchanged"` (dann KEIN neues Command im Log).
5. **Sync mit include_now** (RUN-09): Playlist in Spotify um 2 Titel
   erweitern, Sync + Anwenden während der Wiedergabe → `window`-Ausgang
   notieren; neue Titel müssen ohne Neustart in der Queue-Vorschau landen.
6. **Manuelle Episode:** Fremden Titel in Spotify starten (Drift), DANN einen
   Titel ausschließen. Erwartung: `window: "not_driving"`, KEIN Command
   (beobachten statt kämpfen, F8); nach Rückkehr gemäß Policy greift der
   neue Plan.
7. **Gerät weg:** aktives Gerät schließen, Titel ausschließen. Erwartung:
   `window: "failed"` oder `"not_driving"` (je nachdem, ob der Playback-Read
   noch antwortet), Event `window_reassert_failed` bzw. kein Command; nach
   Geräte-Rückkehr setzt der nächste Start/Advance das frische Fenster.
8. **Reopen nach Abschluss (UC-24):** einen kleinen Run bis `completed`
   durchhören, dann Wiederholungen erlauben (`repeat_mode: free_repeat`).
   Erwartung: Antwort `reopened: true`/`status: "stopped"`; Fortsetzen +
   Start spielen die neuen Titel; Verlauf des ersten Durchgangs unangetastet.
- **Falsifikationsfolgen:** Startet `PUT /play` mit `position_ms` den Titel
  hörbar neu bzw. ignoriert es die Position, ist der „nahtlose" Sofortpfad
  live wertlos → ADR-004 auf Lazy-Only (nur Anker-Invalidierung) zurückbauen
  und die UI-Erwartung („wirkt ab dem nächsten Titel") entsprechend ehrlich
  umformulieren; die Tests in `tests/test_window_reassert.py` sind dann auf
  die Lazy-Semantik umzuschreiben (dokumentierte Teständerung).

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

1. AN-1/AN-2/AN-5/AN-6/AN-7-Ergebnisse in `tests/sim_spotify.py` (Docstring) und im
   ADR vermerken; falls falsifiziert: Simulator-Default ändern (für AN-1 existiert
   der Schalter `clear_queue_on_play`) und Suite + Bench erneut laufen lassen.
2. SP-Matrix (`handoffs/TS-FABLE-01/08_ACCEPTANCE_TEST_MATRIX.md`, G3) mit
   PASS/FAIL + Evidenzverweis füllen; Evidenzklasse der betroffenen Gates von
   `VERIFIED_AUTOMATED`/`BLOCKED` auf `VERIFIED_LIVE` heben.
3. Policy-Gate beachten (05 §Policy-/Business-Gate): keine „policy compliant“-
   Aussage ohne dokumentierte Prüfung.
