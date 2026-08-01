# Phase 0 — Re-Audit (G0)

Lauf: TS-FABLE-01 · Datum: 2026-07-31
Implementierungsbranch: `claude/true-shuffle-fable5-run-z2eqzb` (abgezweigt vom Handoff-Branch `handoff/fable5-true-shuffle-v1`, Tip `1b816d9`)

## BASE-01 — Basis bestätigt · PASS

| Prüfung | Ergebnis |
|---|---|
| `git rev-parse HEAD` | `1b816d940042bc56c1b623febc469deb77940868` |
| Handoff-Branch-Tip | identisch (`1b816d9`) |
| Basis-Commit `d626505b…` in Historie enthalten | ja (direkter Parent von `b8c9337`) |
| Handoff-Artefakte `handoffs/TS-FABLE-01/` | alle 12 SHA256-Hashes gegen `SHA256SUMS.txt` geprüft: OK |

## BASE-02 / BASE-03 — Baseline reproduziert · PASS

- `python -m pytest -q` → **305 passed**, 1 Starlette/httpx-Deprecation-Warnung (wie im Handoff dokumentiert). Python 3.11.15.
- `ruff check .` → **All checks passed**.
- Hinweis (kein Gate-Kriterium): `ruff format --check` meldet 38 unformatierte Dateien — Bestand, wird nicht flächig umformatiert, um Diff-Rauschen zu vermeiden.

## BASE-04 — Schema- und Migrationsinventur · PASS

Schema v2 (`app/db.py`, `SCHEMA_VERSION = 2`, SQLite/aiosqlite, WAL, `executescript` bei Start; Legacy-v1-Tabellen werden per Rename `*_v1` beiseitegestellt):

Tabellen: `schema_meta`, `users`, `provider_accounts` (Token AES-256-GCM versiegelt), `runs`, `skipped_tracks`, `run_events`, `jobs`.

**Migrationsrelevante Befunde für die 30 Use Cases:**

1. `idx_runs_one_live` (partieller Unique-Index auf `runs(user_id, provider, playlist_id, mode) WHERE status IN ('active','paused')`) verhindert mehrere unabhängige Live-Runs derselben Playlist → blockiert UC-16; Migration erforderlich.
2. `runs.status` CHECK kennt nur `active/paused/completed/cancelled` — kein eigener „gestoppt"-Zustand (UC-13) und kein Reset-Vertrag (UC-15).
3. Es existiert **keine** Persistenz für: Playlist-Import/Snapshot (UC-03/04), gespeicherte Konfigurationen/Presets (UC-10, 27–29), Favoriten (UC-08), Wiederholungsregeln/Mindestabstand (UC-07/09), Ausschlüsse (UC-20/21), Skip-Policy (UC-19), Manual-Use-Policy (UC-18), neue-Tracks-Politik (UC-25).
4. `run_events` besitzt keine Idempotenz-/Correlation-Metadaten; doppelte Provider-Events sind auf DB-Ebene nicht abweisbar (Invariante „Ereignis-Idempotenz").
5. Kein Migrationsframework; Schemaänderungen laufen als Startup-Code. Für Phase 3 werden versionierte, getestete Migrationen mit Rollback-Notizen eingeführt.

## Codebeleg zum Queue-Fehler (Evidenzklasse `VERIFIED_CODE`)

- `core/engine.py::start` liefert `play_track_id` + `queue_track_ids = upcoming(queue_buffer=5)`; `app/runs.py::_apply` führt `PUT /me/player/play` mit **einer einzelnen URI** aus und hängt danach 5 Titel einzeln per `POST /me/player/queue` an.
- `app/runs.py::_apply` hängt die `queue_track_ids` bei **jedem** Advance erneut an — auch bei `TRACK_ENDED` ohne Override. Die Queue-Vervielfachung folgt damit aus jedem Advance-Pfad, nicht nur aus Skips.
- `providers/spotify.py` implementiert **kein** `GET /me/player/queue`; der Code beobachtet die Spotify-Queue nie und kann daher weder deduplizieren noch reconciliieren.
- Kein Queue-Ownership, kein Diff, kein Clear (Clear existiert in der Web API auch nicht).

Einstufungen: Queue-Vervielfachung beim Advance = `VERIFIED_CODE` (Mechanismus) + `OBSERVED_USER` (Live-Wirkung). „Titel 6 = Titel 1" = `OBSERVED_USER` + `INFERRED` (Kandidat: Ein-URI-Play-Kontext wiederholt sich nach Erschöpfung der Queue); Live-Beweis steht aus.

## BASE-05 — Aktuelle Spotify-Dokumente geprüft · PASS

Alle Quellen am 2026-07-31 live abgerufen (vier unabhängige Doc-Reader-Agenten, strukturierte Rückgabe):

| Quelle (abgerufen 2026-07-31) | Kernbefund |
|---|---|
| Reference: add-to-queue, get-queue, start-a-users-playback, skip-to-next, pause, get-playback-state, recently-played, transfer-playback, rate-limits | Queue ist **append-only** (nur POST add + GET read; kein Remove/Clear/Reorder). `PUT /me/player/play` akzeptiert `context_uri` **oder `uris`-Array + `offset` + `position_ms`** — ein vollständiges „Reihenfolge setzen"-Primitiv. Alle mutierenden Player-Endpunkte tragen die Warnung „order of execution is not guaranteed". 429 mit `Retry-After`, rollierendes 30-s-Fenster. `GET /me/player` → 204 bei fehlendem aktivem Gerät. Transfer: genau eine `device_id`. |
| Februar-2026-Migrationsleitfaden | Gilt für Development-Mode-Apps. Playlist-Inhalte nur noch für **eigene/kollaborative** Playlists. `/playlists/{id}/items` (Rename), Batch-GETs entfernt, `available_markets`/`popularity`/`linked_from` entfernt, `/me` ohne `country`/`product`. Neue Apps: Owner braucht Premium, 5 Nutzer je App. Keine dokumentierten Player-/OAuth-Änderungen. Der Code ist bereits auf diese Formen migriert (PR #3). |
| Juli-2026-Changelog (+ März/Mai 2026) | Keine Player-/Queue-/Playlist-/OAuth-Änderungen. 25 Client-IDs je Developer-Account, Quota jetzt **pro Developer-Account** gebündelt, strukturierter 429-Body `reason: QUOTA_EXCEEDED`. Mai 2026: neues `account_id`-Feld. März 2026: `external_ids`-Entfernung zurückgenommen. |
| Developer Policy + Terms | Fernsteuerung einer Spotify-App = „Streaming" ⇒ die App ist eine **Streaming SDA**: kommerzielle Nutzung **nicht gestattet** (Policy IV.2) ohne Sondervereinbarung; Player-UI muss Cover-Art + Metadaten des laufenden Inhalts zeigen (Policy II.5); Attribution mit Spotify-Marks (II.4); kein künstliches Erhöhen von Play-Counts durch Bots/Automatisierung (II.2 — automatisches Vorantreiben nur als Abbild echten Nutzerhörens); kein Mixen/Überlagern mit anderem Audio (III.7); Disconnect-Mechanismus verpflichtend, Löschung personenbezogener Daten binnen **5 Tagen** nach Disconnect (Terms V.8, Appendix A.5.c); Datenminimierung (V.3); keine abgeleiteten Listenership-Metriken/Nutzerprofile (III.13); kein AI/ML-Training auf Spotify-Content (III.14). |

**Konsequenzen:** (1) Der Strategieraum für Phase 2 erweitert sich um das `uris`-Array-Play-Fenster; die Handoff-Kandidaten A–D bleiben Prüfkandidaten. (2) UC-02 muss die Own/Collaborative-Einschränkung ehrlich anzeigen. (3) Ein kommerzieller Launch ist bis zu einer gesonderten Prüfung/Vereinbarung als **nicht zulässig** zu behandeln (Release-Gate, wie im Handoff). (4) Player-UI-Pflicht: Cover-Art + Metadaten + Attribution — fließt als harter Filter in die UX-Konzepte ein. (5) Disconnect-/Löschpfad binnen 5 Tagen wird als Produktanforderung in Phase 3/4 implementiert und getestet.

## BASE-06 — Mika-Library-Revision geprüft · PASS

Die angebundene private Mika UX Library wurde am 2026-07-31 neu abgerufen und verifiziert: aktueller Snapshot-Stand bestätigt, Eintragszahl (123 aktive Einträge) und Katalog-Integritätsnachweise (Index-Hash, sortierte Code-Liste, kritischer Regression-Fixture-Hash) stimmen mit dem Manifest überein. Ein Eintrag ist im Manifest ausdrücklich als unvalidierter Regressions-Fixture markiert und wird von der Konzeptauswahl ausgeschlossen. Exakte Quell-IDs, Revisionen und Hashes liegen ausschließlich im geschützten privaten Arbeitsnachweis; im Produkt-Repository erscheinen später nur freigegebene Quellaliase und Transferregeln (siehe `02_SOURCE_PRIORITY_AND_CONFLICT_RULES.md`).

Randbefund an die Library-Verwaltung (privat gemeldet): Das Aggregations-Hash-Schema der Verzeichnis-Digests ist im Manifest nicht dokumentiert und ließ sich mit drei üblichen Konstruktionen nicht reproduzieren; die Einzeldatei-Hashes stimmen. Kein Korruptionsbefund.

## Live-Credential-Stand

Kein `.env`, keine Provider-Credentials in der Umgebung. Der angebundene Spotify-Connector der Chat-Plattform bietet nur Suche/aktueller-Titel/Playlist-Anlage — keine Player-Steuerung, kein Queue-Read, kein Ersatz für ein dediziertes Premium-Testkonto mit realem Gerät.

**Konsequenz:** Alle `VERIFIED_LIVE`-Gates werden ehrlich als `BLOCKED` geführt, mit exakter externer Voraussetzung: (1) Spotify-App-Client-ID (Development Mode, Owner mit Premium), (2) dediziertes Premium-Testkonto als eingetragener App-Nutzer, (3) mindestens ein reales aktives Wiedergabegerät, (4) `.env` gemäß `.env.example`. Implementierung, Instrumentierung und alle nicht-live Evidenzklassen laufen ungebremst weiter; eine redigierte Live-Testanleitung wird geliefert.
