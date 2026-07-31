# Phase-2-Instrumentierungsplan (Entwurf; wird in Phase 2 finalisiert und ins Repo überführt)

Ziel: Queue-Duplikate und „Titel 6 = Titel 1" beweisbar machen — live (wenn Credentials) und simuliert (immer). Evidenzklassen strikt trennen.

## 1. Leichtgewichtige Instrumentierung im Code (Phase-2-Umfang, vor v3-Schema)

- Korrelation: je Command eine correlation_id (uuid4-Kurzform) + run_id + cursor + Zieltrack in strukturiertem Log (logger "ts.provider.command"), niemals Tokens/Account-IDs.
- Neuer Provider-Call `get_queue()` (GET /me/player/queue) im Spotify-Provider — reines Lesen, für Forensik und spätere Reconciliation.
- Forensik-Recorder (optional aktivierbar, ENABLE_FORENSICS=true): vor/nach play/enqueue/advance/watcher-Tick redigierte Snapshots von /me/player und /me/player/queue (nur track_ids, is_playing, progress_ms, device-Typ ohne IDs) als JSONL in data/forensics/<run_id>.jsonl.
- Timeline-Builder: Skript scripts/forensics_timeline.py baut aus JSONL eine menschenlesbare Timeline (Command → beobachteter Zustand), Grundlage des redigierten Live-Berichts.

## 2. Spotify-Player-Simulator (VERIFIED_AUTOMATED-Rückgrat)

tests/sim_spotify.py: modelliert dokumentierte + zu prüfende Semantik:
- Queue append-only; play(uris=[...]) ersetzt KONTEXT, löscht aber manuelle Queue-Einträge nicht (Annahme AN-1, live zu verifizieren);
- nach Queue-Erschöpfung: Verhalten des Ein-URI-Kontexts (Annahme AN-2: Kontext-Restart/Repeat-Kandidat für „Titel 6 = Titel 1" — als konfigurierbare Simulator-Policy, beide Varianten testbar);
- next() rückt Queue vor; get_queue() liefert currently_playing + queue;
- Latenz/Races injizierbar (Reihenfolge kombinierter Endpunkte nicht garantiert — Annahme AN-3);
- 429/Retry-After injizierbar.
Jede Annahme AN-x wird im Simulator-Docstring + ADR als „live zu bestätigen" geführt. Regressionstest SP-008 läuft gegen den Simulator: aktueller Codepfad ⇒ Duplikate (rot vor Fix), Fix ⇒ keine Duplikate (grün) — ehrlich als VERIFIED_AUTOMATED etikettiert.

## 3. Live-Protokoll (BLOCKED bis Credentials; redigierte Anleitung als Artefakt)

Schrittfolge je 05_SPOTIFY_LIVE_WORK_PACKAGE „Zuerst instrumentiert reproduzieren" 1–8; je Schritt: Command mit correlation_id, danach GET /me/player + /me/player/queue Snapshot; Timeline für Start + 3 native Skips; separater Beweis/Falsifikation „Titel 6 = Titel 1" (Start mit 6-Track-Playlist, Queue-Snapshot nach 5 Appends, dann alle 6 durchlaufen lassen ohne Eingriff).

## 4. Strategiekandidaten für den Vergleich (ADR in Phase 2)

S1 uris-Fenster: PUT play mit uris=[aktuelle..+N] + offset; bei Advance nur bei Drift neu setzen. Prüfen: Fensterende-Verhalten, manuelle Queue-Interaktion (AN-1), N-Wahl, 10k-Playlist (uris-Limit? dokumentiertes Max prüfen — bekannt: Body-Limit, live verifizieren).
S2 Kein Prefetch: play(uris=[genau 1]) je Titel am Trackende/Skip. Prüfen: Lücken-Latenz, Polling-Timing, AN-2-Risiko am Trackende (Kontext-Restart vor Override!).
S3 Ein-Slot-Prefetch idempotent: get_queue lesen, nur fehlenden nächsten Titel appenden; Ownership-Heuristik. Prüfen: Queue nicht kontrollierbar, Race Lesen→Append (AN-3).
S4 Materialisierter Kontext (Run-Playlist) + context_uri/offset. Prüfen: Sichtbarkeit, Schreibquota (50/Page-Writes), Sync bei Regeländerung, Policy-Sauberkeit (Playlist-Erstellung erlaubt), Cleanup.
Bewertung gegen: 30 UCs (bes. UC-17/18 manuelle Nutzung!), Latenz, Gerätewechsel, Resume, 429-Budget, Idempotenz, Prozessneustart. Hypothese aus Phase 0: S1 als Default, S4 als Option — ergebnisoffen prüfen; S2 als Fallback-Modus bei Quota-Druck.
