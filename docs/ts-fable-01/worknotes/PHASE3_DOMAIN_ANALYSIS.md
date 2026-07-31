# Domänen-/Datenmodell-Analyse — True Shuffle v2 → v3

Basis: `/home/user/true-shuffle-PoC`, HEAD `9c2e7b1`. Nur Analyse, keine Dateiänderung.

---

## 1. BEFUND (Ist-Modell)

### 1.1 Strukturelle Kernprobleme

| # | Befund | Beleg | Blockiert |
|---|---|---|---|
| B1 | `runs` ist eine **fusionierte Entität**: Snapshot (`order_json`), Konfiguration (`mode`, `seed`), Fortschritt (`cursor`), Ausführungsziel (`device_id`, `copy_playlist_id`) und Historienwurzel in einer Zeile | `app/db.py:68-85` | UC-03/04/05/10/16/27-29 |
| B2 | Track-Identität = nackter Provider-String. `Track.key` (`provider:id`) existiert in `core/models.py:106`, aber `order_json` speichert nur `t.id` (`core/shuffle.py:182`) | `core/shuffle.py:182` | Invariante „Track-Identität" |
| B3 | Duplikate/lokale/unverfügbare Titel werden **vor** dem Shuffle verworfen und nur denormalisiert (`name`, `artist`, `reason`) in `skipped_tracks` abgelegt — ohne Playlist-Position, ohne Entry-Identität | `core/shuffle.py:46-63`, `app/db.py:99-107` | UC-03, UC-19, Frage 3 |
| B4 | Kein persistierter Playlist-Import. `build_run` liest die Playlist bei jedem Lauf neu; es gibt keine Version, keinen ETag, keinen Diff | `app/runs.py:117-126` | UC-03/04, RUN-09 |
| B5 | `idx_runs_one_live` erzwingt **genau einen** Live-Run je `(user, provider, playlist, mode)` | `app/db.py:89-91` | UC-16, RUN-01 |
| B6 | `status`-CHECK kennt kein `stopped`; UC-13 fällt heute auf `cancelled`, das `engine.ensure_live` hart ablehnt (`_TERMINAL_TEXT`) → nicht fortsetzbar | `app/db.py:77-78`, `core/engine.py:56-67` | UC-13/14/15 |
| B7 | `order_json` ist eine **vormaterialisierte Vollpermutation**. Sie kann Wiederholung, Mindestabstand, Gewichtung, Skip-Rückführung und Mid-Run-Neuzugänge strukturell nicht ausdrücken | `app/db.py:75`, `core/shuffle.py:160-185` | UC-07/08/09/19/25 |
| B8 | Fortschritt = ein `INTEGER cursor`. Sobald Wiederholungen existieren, ist „gespielt" ≠ „Präfix von order". `engine.previous()` bewegt den Cursor rückwärts und macht damit stillschweigend eine Karte ungespielt | `core/engine.py:134-149` | UC-06/22/23 |
| B9 | `run_events` hat **keine** Idempotenz-/Correlation-Metadaten. `record_event` ist ein reines INSERT | `app/db.py:534-548` | Invariante „Ereignis-Idempotenz", SP-003/004/005 |
| B10 | Einziger Doppelverarbeitungs-Schutz ist `runs.advance_lock` — ein **prozesslokales** `dict[int, asyncio.Lock]`, das bei Neustart verschwindet | `app/runs.py:455-469` | ERR-08, SP-006 |
| B11 | Kein Command-Log. `_apply` hängt bei **jedem** Advance erneut `queue_buffer` Titel an (auch bei `TRACK_ENDED`), ohne Provider-Queue je zu lesen | `app/runs.py:210-229` | SP-003/004/008 |
| B12 | Reproduzierbarkeit endet beim `runs.seed`. Regelversion, Kandidatenmenge und Entscheidungsgrund je Auswahl existieren nicht | `app/db.py:79` | Invariante „Reproduzierbarkeit" |
| B13 | Keine Persistenz für Presets, Favoriten, Ausschlüsse, Skip-/Manual-Use-/Neue-Tracks-Policy | — | UC-07-10, 18-21, 25, 27-29 |
| B14 | Wortkollision: `skipped_tracks` meint **Import-Ausschlüsse** (`SkipReason`), nicht UC-19-Skips (`AdvanceReason`). Zwei gegensätzliche Konzepte, ein Wort | `core/models.py:38-67` | Verständlichkeit, Testlesbarkeit |

### 1.2 Migrationsmechanik (Ist)

- `init_db()` ruft `_migrate_legacy()` und danach **bei jedem Start** `executescript(_SCHEMA_SQL)` mit `CREATE ... IF NOT EXISTS`; `schema_meta.version` wird erst *danach* geschrieben → nach einem Teilfehler ist die Version undefiniert (`app/db.py:147-167`).
- Kein geordnetes, einzeln getestetes Migrationsverzeichnis, keine Checksummen, keine Rollback-Skripte.
- `_migrate_legacy` muss `idx_runs_user_playlist` **explizit** droppen (`app/db.py:196`) — Beleg dafür, dass `ALTER TABLE ... RENAME TO` in SQLite Indexnamen mitzieht. Das ist die Falle für v3 (siehe M005).
- Laufzeit: SQLite 3.45.1 lokal, `python:3.11-slim` (bookworm) → 3.40.1 in Produktion. **Verbindlicher Floor: 3.35** (DROP COLUMN vorhanden, partielle Indizes vorhanden). Kein `STRICT` (bräuchte 3.37) — hält den Floor niedrig.

### 1.3 Was heute korrekt ist und erhalten bleiben muss

- Ownership-in-der-Query (`get_run(..., user_id=...)`, fremder Run = 404) — `app/deps.py:44-57`.
- Partieller Unique-Index als Muster (statt Voll-UNIQUE) — nur das *Prädikat* ist falsch, nicht die Technik.
- `jobs` mit SSE-Progress — der richtige Persistenzschnitt für Import und Copy-Write.
- Reinheit von `core/engine.py` und `core/shuffle.py` (kein I/O) — Voraussetzung für die Property-Tests aus RUN-03/04/07.
- Token-Versiegelung (`TokenVault`), `latest_completed_order`-Similarity-Guard, `advance_lock`.

---

## 2. ZIELDOMÄNENMODELL (Schema v3)

Vier Schichten: **Inhalt → Regeln → Lauf → Ledger**. Tabellennamen englisch (Codebase-Konvention), Nutzertexte deutsch.

### 2.1 Inhaltsschicht — Track-Identität und versionierter Import

Die Invariante verlangt drei getrennte Identitätsebenen. Das Modell macht sie zu drei Tabellen:

| Ebene | Träger | Beispiel-Frage die sie beantwortet |
|---|---|---|
| **Eintrag** (Playlist-Position) | `snapshot_items` | „Der Song steht auf Position 3 *und* 47" |
| **Provider-Ressource** (URI) | `tracks` | „Das ist `spotify:track:ABC`" |
| **Werk** (Song, Re-Upload, Markt) | `tracks.work_key` (ISRC) | „Album- und Single-Version sind derselbe Song" |

```sql
CREATE TABLE tracks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    provider          TEXT    NOT NULL,
    provider_track_id TEXT    NOT NULL DEFAULT '',   -- '' bei lokalen Dateien
    local_key         TEXT    NOT NULL DEFAULT '',   -- Fallback-Identität: hash(name,artist,album,dur/1000)
    work_key          TEXT    NOT NULL DEFAULT '',   -- ISRC (März 2026 wieder verfügbar)
    name              TEXT    NOT NULL DEFAULT '',
    artist            TEXT    NOT NULL DEFAULT '',
    album             TEXT    NOT NULL DEFAULT '',
    duration_ms       INTEGER NOT NULL DEFAULT 0,
    kind              TEXT    NOT NULL DEFAULT 'track',
    artwork_url       TEXT    NOT NULL DEFAULT '',
    is_local          INTEGER NOT NULL DEFAULT 0,
    first_seen_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_tracks_provider ON tracks(provider, provider_track_id)
    WHERE provider_track_id != '';
CREATE UNIQUE INDEX idx_tracks_local    ON tracks(provider, local_key)
    WHERE provider_track_id = '' AND local_key != '';
CREATE INDEX        idx_tracks_work     ON tracks(work_key) WHERE work_key != '';

CREATE TABLE playlists (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider             TEXT    NOT NULL,
    provider_playlist_id TEXT    NOT NULL,
    name                 TEXT    NOT NULL DEFAULT '',
    owner                TEXT    NOT NULL DEFAULT '',
    is_own               INTEGER NOT NULL DEFAULT 1,
    editable             INTEGER NOT NULL DEFAULT 1,
    readable             INTEGER NOT NULL DEFAULT 1,
    unreadable_reason    TEXT    NOT NULL DEFAULT '',
    image_url            TEXT    NOT NULL DEFAULT '',
    last_imported_at     TEXT,
    UNIQUE(user_id, provider, provider_playlist_id)
);

CREATE TABLE playlist_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id   INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    version       INTEGER NOT NULL,
    source_etag   TEXT    NOT NULL DEFAULT '',    -- Spotify snapshot_id
    content_hash  TEXT    NOT NULL DEFAULT '',    -- hash über (entry_uid,position)*  → "nichts geändert" ohne Diff
    item_count    INTEGER NOT NULL DEFAULT 0,
    playable_count INTEGER NOT NULL DEFAULT 0,
    excluded_count INTEGER NOT NULL DEFAULT 0,
    status        TEXT    NOT NULL DEFAULT 'importing'
                      CHECK(status IN ('importing','ready','failed')),
    derived       INTEGER NOT NULL DEFAULT 0,     -- 1 = aus Altbestand rekonstruiert, kein echter Import
    job_id        TEXT    NOT NULL DEFAULT '',    -- → jobs.id
    imported_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(playlist_id, version)
);

CREATE TABLE snapshot_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id  INTEGER NOT NULL REFERENCES playlist_snapshots(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    track_id     INTEGER NOT NULL REFERENCES tracks(id),
    entry_uid    TEXT    NOT NULL,        -- f"{provider_track_id}#{occurrence_index}"
    added_at     TEXT    NOT NULL DEFAULT '',
    availability TEXT    NOT NULL DEFAULT 'playable'
                     CHECK(availability IN ('playable','unavailable','local',
                                            'wrong_kind','missing_id','not_music')),
    UNIQUE(snapshot_id, position),
    UNIQUE(snapshot_id, entry_uid)
);
CREATE INDEX idx_snapshot_items_track ON snapshot_items(snapshot_id, track_id);

CREATE TABLE snapshot_diffs (              -- RUN-09: „Ergebnis vor Anwendung anzeigen"
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    from_snapshot_id INTEGER NOT NULL REFERENCES playlist_snapshots(id) ON DELETE CASCADE,
    to_snapshot_id   INTEGER NOT NULL REFERENCES playlist_snapshots(id) ON DELETE CASCADE,
    added_json       TEXT NOT NULL DEFAULT '[]',
    removed_json     TEXT NOT NULL DEFAULT '[]',
    moved_count      INTEGER NOT NULL DEFAULT 0,
    applied_at       TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(from_snapshot_id, to_snapshot_id)
);
```

**Warum `entry_uid`**: Spotify-Playlist-Einträge haben keine eigene ID. `f"{track_id}#{n-te Vorkommnis}"` ist die einzige über Snapshots hinweg stabile Entry-Identität, wenn Positionen sich verschieben. Damit wird „derselbe Song zweimal in der Playlist" eine *Datenaussage*, und die Behandlung (kollabieren / beide behalten) eine *Regel* — genau die Trennung, die Frage 3 verlangt.

**Warum unspielbare Einträge persistiert werden**: Heute verschwinden sie in `skipped_tracks` ohne Position und ohne Wiedervorlage. Mit `availability` in `snapshot_items` kann ein Titel, der im Markt wieder verfügbar wird, beim nächsten Sync regelkonform zurück in den Lauf (UC-04, ERR-06) — heute ist er für immer weg.

### 2.2 Regelschicht — Preset, Version, Effective-From

Die Trennung ist der Kern von Frage 7: **`run_configs` enthält ausschließlich playlistneutrale Regeln. Trackbezogenes lebt in `run_tracks`.** Eine Config ist damit per Konstruktion übertragbar.

```sql
CREATE TABLE run_configs (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                   TEXT    NOT NULL,
    kind                   TEXT    NOT NULL DEFAULT 'preset'
                               CHECK(kind IN ('preset','run_local')),
    origin_config_id       INTEGER REFERENCES run_configs(id) ON DELETE SET NULL,  -- UC-28
    current_version        INTEGER NOT NULL DEFAULT 1,

    -- Wiederholung (UC-06/07/09)
    repeat_mode            TEXT    NOT NULL DEFAULT 'no_repeat'
                               CHECK(repeat_mode IN ('no_repeat','limited_repeat','free_repeat')),
    min_gap                INTEGER NOT NULL DEFAULT 0,
    repeat_quota_pct       INTEGER NOT NULL DEFAULT 0,
    favorite_weight        REAL    NOT NULL DEFAULT 1.0,

    -- Policies (UC-18/19/25, Frage 3/4)
    skip_policy            TEXT NOT NULL DEFAULT 'consume'
                               CHECK(skip_policy IN ('consume','keep_open','requeue_later','defer_to_end')),
    manual_use_policy      TEXT NOT NULL DEFAULT 'auto_resume'
                               CHECK(manual_use_policy IN ('auto_resume','auto_pause','ask')),
    manual_wait_seconds    INTEGER NOT NULL DEFAULT 900,
    new_tracks_policy      TEXT NOT NULL DEFAULT 'ignore'
                               CHECK(new_tracks_policy IN ('include_now','after_cycle','ignore')),
    duplicate_policy       TEXT NOT NULL DEFAULT 'collapse'
                               CHECK(duplicate_policy IN ('collapse','keep_entries')),
    unplayable_policy      TEXT NOT NULL DEFAULT 'exclude'
                               CHECK(unplayable_policy IN ('exclude','retry_next_cycle')),
    played_threshold       TEXT NOT NULL DEFAULT 'on_track_end'
                               CHECK(played_threshold IN ('on_start','on_min_seconds','on_track_end')),
    played_threshold_seconds INTEGER NOT NULL DEFAULT 30,

    -- Ausführung (Ergebnis des Phase-2-ADR wird Daten, nicht Code)
    execution_strategy     TEXT NOT NULL DEFAULT 'uris_window'
                               CHECK(execution_strategy IN ('single_uri','uris_window',
                                                            'context_playlist','no_prefetch')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_configs_name ON run_configs(user_id, name) WHERE kind = 'preset';

CREATE TABLE run_config_versions (          -- unveränderliche Regelversion
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id  INTEGER NOT NULL REFERENCES run_configs(id) ON DELETE CASCADE,
    version    INTEGER NOT NULL,
    rules_json TEXT    NOT NULL,            -- eingefrorene Kopie aller Regelspalten
    rules_hash TEXT    NOT NULL,            -- sha256 über kanonisches JSON
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(config_id, version)
);

CREATE TABLE run_rule_bindings (            -- Effective-From (UC-27, Risiko „Regeländerung im Lauf")
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id              INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    config_version_id   INTEGER NOT NULL REFERENCES run_config_versions(id),
    effective_from_seq  INTEGER NOT NULL,   -- ab welchem selection_seq die Version gilt
    replan              TEXT    NOT NULL DEFAULT 'tail_only'
                            CHECK(replan IN ('none','tail_only','full')),
    applied_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(run_id, effective_from_seq)
);
```

**Spalten *und* eingefrorenes JSON**, bewusst redundant: Spalten geben DB-seitige CHECK-Validierung und Abfragbarkeit für die *editierbare* Config; `rules_json`/`rules_hash` geben den unveränderlichen, hashbaren Nachweis für Reproduzierbarkeit. Eine Regeländerung mutiert nie die Vergangenheit — sie öffnet ein neues Binding.

### 2.3 Laufschicht

```sql
CREATE TABLE runs (                          -- v3
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider         TEXT    NOT NULL,
    playlist_ref_id  INTEGER REFERENCES playlists(id),          -- neu, normalisiert
    playlist_id      TEXT    NOT NULL,                          -- bleibt (Provider-ID, Kompatibilität)
    playlist_name    TEXT    NOT NULL DEFAULT '',
    snapshot_id      INTEGER REFERENCES playlist_snapshots(id), -- Version, auf der der Run arbeitet
    config_id        INTEGER REFERENCES run_configs(id),
    name             TEXT    NOT NULL DEFAULT '',               -- UC-16: mehrere Runs brauchen Namen
    mode             TEXT    NOT NULL CHECK(mode IN ('utility','controller')),
    status           TEXT    NOT NULL DEFAULT 'active'
                         CHECK(status IN ('active','paused','stopped','completed','cancelled')),
    cycle            INTEGER NOT NULL DEFAULT 1,                -- UC-15/24
    selection_seq    INTEGER NOT NULL DEFAULT 0,                -- Ledger-Uhr, ersetzt cursor fachlich
    cursor           INTEGER NOT NULL DEFAULT 0,                -- bleibt bis M009 (abgeleitet)
    plan_version     INTEGER NOT NULL DEFAULT 1,
    seed             INTEGER,                                    -- Master-Seed; je Zug: hash(seed, seq)
    device_id        TEXT,
    copy_playlist_id TEXT,
    manual_state     TEXT    NOT NULL DEFAULT 'none'
                         CHECK(manual_state IN ('none','manual_detected',
                                                'awaiting_decision','suspended')),
    manual_since     TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity_at TEXT,
    stopped_at       TEXT,
    completed_at     TEXT,
    archived_at      TEXT                                        -- UC-26 Soft-Delete
);
```

**Indexwechsel — der Kern von UC-16.** `idx_runs_one_live` entfällt. Der *echte* Konflikt ist nicht „zwei Decks derselben Playlist", sondern „zwei Runs kämpfen um dasselbe Wiedergabegerät":

```sql
DROP INDEX idx_runs_one_live;
CREATE INDEX        idx_runs_user       ON runs(user_id, provider, updated_at DESC);   -- unverändert
CREATE INDEX        idx_runs_live       ON runs(user_id, provider, playlist_id, status);
CREATE UNIQUE INDEX idx_runs_one_playing ON runs(user_id, provider)
    WHERE status = 'active' AND mode = 'controller';
CREATE UNIQUE INDEX idx_runs_name       ON runs(user_id, playlist_id, name)
    WHERE archived_at IS NULL AND name != '';
```

Beliebig viele `paused`/`stopped` Runs je Playlist; höchstens **ein** aktiv steuernder Run je (Nutzer, Provider). Das ist die Ablösung, die UC-16 freischaltet, ohne SP-003 („keine Queue-Vervielfachung") zu gefährden.

```sql
CREATE TABLE run_tracks (        -- Kandidatenmenge + Per-Track-Zustand: trägt UC-06..09,19..22,25
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id                 INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    track_id               INTEGER NOT NULL REFERENCES tracks(id),
    entry_uid              TEXT    NOT NULL DEFAULT '',   -- != '' nur bei duplicate_policy='keep_entries'
    state                  TEXT    NOT NULL DEFAULT 'open'
                               CHECK(state IN ('open','played','deferred',
                                               'excluded_user','excluded_rule')),
    play_count             INTEGER NOT NULL DEFAULT 0,
    last_played_seq        INTEGER,                       -- Mindestabstand wird damit ein SQL-Prädikat
    favorite               INTEGER NOT NULL DEFAULT 0,    -- UC-08, run-scoped
    weight                 REAL    NOT NULL DEFAULT 1.0,
    admitted               INTEGER NOT NULL DEFAULT 1,    -- UC-25 'after_cycle' → 0 bis Zyklusende
    added_in_cycle         INTEGER NOT NULL DEFAULT 1,
    source_snapshot_id     INTEGER REFERENCES playlist_snapshots(id),
    removed_from_snapshot  INTEGER NOT NULL DEFAULT 0,    -- UC-04: nicht mehr in Playlist, Historie bleibt
    excluded_reason        TEXT    NOT NULL DEFAULT '',
    excluded_at            TEXT,
    UNIQUE(run_id, track_id, entry_uid)
);
CREATE INDEX idx_run_tracks_open ON run_tracks(run_id, state, admitted);
CREATE INDEX idx_run_tracks_gap  ON run_tracks(run_id, last_played_seq);

CREATE TABLE run_plan (          -- materialisierte Reihenfolge; ersetzt runs.order_json
    run_id       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    run_track_id INTEGER NOT NULL REFERENCES run_tracks(id) ON DELETE CASCADE,
    plan_version INTEGER NOT NULL DEFAULT 1,
    state        TEXT NOT NULL DEFAULT 'planned'
                     CHECK(state IN ('planned','current','consumed','discarded')),
    planned_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(run_id, seq)
);
CREATE INDEX idx_run_plan_state ON run_plan(run_id, state);

CREATE TABLE run_selections (    -- Reproduzierbarkeit je Entscheidung
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id            INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq               INTEGER NOT NULL,
    run_track_id      INTEGER REFERENCES run_tracks(id),
    config_version_id INTEGER REFERENCES run_config_versions(id),
    rules_hash        TEXT    NOT NULL DEFAULT '',
    seed              INTEGER NOT NULL,          -- abgeleitet: hash(runs.seed, seq)
    candidate_hash    TEXT    NOT NULL DEFAULT '',  -- hash über sortierte Kandidaten-IDs
    candidate_count   INTEGER NOT NULL DEFAULT 0,
    filtered_by_json  TEXT    NOT NULL DEFAULT '{}', -- {"gap":412,"excluded":7,"quota":3}
    decided_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(run_id, seq)
);
```

**Hybrider Plan** (Empfehlung): bei `repeat_mode='no_repeat'` wird der Plan zu Zyklusbeginn vollständig materialisiert — das ist exakt das heutige Verhalten und erhält Similarity-Guard, SP-001/SP-002 und die `order_sample`-Rack-Darstellung. Bei Wiederholungsmodi ist der Plan ein rollierender Horizont (z. B. 50 Einträge), der bei Regelwechsel oder Neuzugang neu geplant wird (`plan_version++`, alte Zeilen `state='discarded'` statt Löschung → RUN-04/05-Evidenz).

`candidate_hash` statt Kandidatenliste: 10 000 IDs je Zug wären unbrauchbar. Hash + `filtered_by_json` (Zähler je Ausschlussgrund) macht jede Auswahl nachvollziehbar, ohne die DB zu sprengen.

### 2.4 Ledger- und Idempotenzschicht

```sql
-- run_events erweitert (KEIN Rebuild nötig, siehe M007)
ALTER TABLE run_events ADD COLUMN event_key      TEXT    NOT NULL DEFAULT '';
ALTER TABLE run_events ADD COLUMN correlation_id TEXT    NOT NULL DEFAULT '';
ALTER TABLE run_events ADD COLUMN source         TEXT    NOT NULL DEFAULT 'system';
ALTER TABLE run_events ADD COLUMN applied        INTEGER NOT NULL DEFAULT 1;
ALTER TABLE run_events ADD COLUMN seq            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE run_events ADD COLUMN run_track_id   INTEGER;   -- DEFAULT NULL: FK-Regel von SQLite
CREATE UNIQUE INDEX idx_events_key ON run_events(run_id, event_key);
CREATE INDEX        idx_events_run ON run_events(run_id, id DESC);   -- bestehend, bleibt

CREATE TABLE provider_commands (   -- idempotente Provider-Commands
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          INTEGER REFERENCES runs(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider        TEXT    NOT NULL,
    kind            TEXT    NOT NULL
                        CHECK(kind IN ('play','enqueue','pause','transfer',
                                       'create_playlist','add_tracks','read_queue')),
    idempotency_key TEXT    NOT NULL,
    correlation_id  TEXT    NOT NULL DEFAULT '',
    target_track_id TEXT    NOT NULL DEFAULT '',
    device_id       TEXT    NOT NULL DEFAULT '',
    payload_json    TEXT    NOT NULL DEFAULT '{}',
    status          TEXT    NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','sent','succeeded','failed',
                                         'skipped','superseded')),
    attempt         INTEGER NOT NULL DEFAULT 0,
    http_status     INTEGER,
    retry_after_ms  INTEGER,
    error           TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    sent_at         TEXT,
    settled_at      TEXT,
    UNIQUE(idempotency_key)
);
CREATE INDEX idx_commands_run ON provider_commands(run_id, created_at DESC);

CREATE TABLE provider_observations (  -- redigierte Provider-Snapshots für SP-00x-Evidenz
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         INTEGER REFERENCES runs(id) ON DELETE CASCADE,
    correlation_id TEXT NOT NULL DEFAULT '',
    kind           TEXT NOT NULL CHECK(kind IN ('playback_state','queue')),
    payload_json   TEXT NOT NULL DEFAULT '{}',
    observed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_obs_run ON provider_observations(run_id, observed_at DESC);

CREATE TABLE deletion_requests (      -- Frage 10 / Terms V.8: 5-Tage-Frist prüfbar machen
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider     TEXT    NOT NULL,
    scope        TEXT    NOT NULL DEFAULT 'provider_content',
    requested_at TEXT    NOT NULL DEFAULT (datetime('now')),
    due_at       TEXT    NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','done','failed')),
    completed_at TEXT
);
```

**Schlüsselkonstruktion `event_key`** (das Herz der Idempotenz-Invariante):

```
advance:  f"{run_id}:{plan_version}:{plan_seq}:{from_track}:{to_track}"
history:  f"{run_id}:hist:{track_id}:{played_at}"          # Provider-Zeitstempel = natürlicher Dedup
browser:  Client-generierte X-Event-Id (UUID pro realem Ereignis, Retry-stabil)
```

`UNIQUE(run_id, event_key)` macht SP-005 („Retry nach Timeout: kein doppelter fachlicher Advance") zu einem `IntegrityError`, den der Aufrufer als „bereits angewendet" behandelt und mit dem bestehenden Ergebnis beantwortet — **neustartfest**, anders als `advance_lock`.

**`idempotency_key`** für Commands: `f"{run_id}:{plan_version}:{seq}:{kind}:{track_id}:{device_id}"`. Ein wiederholter Watcher-Tick erzeugt denselben Schlüssel → kein zweiter Enqueue (SP-004). Das ist der mechanische Riegel gegen B11.

### 2.5 UC → Modell-Abdeckung

| UC | Tragende Struktur |
|---|---|
| 01-02 | `provider_accounts`, `playlists` (unverändert / neu normalisiert) |
| 03 | `playlist_snapshots` v1 + `snapshot_items` (alle Einträge, inkl. Duplikate/lokal/unverfügbar) |
| 04 | neuer Snapshot + `snapshot_diffs`; `run_tracks.removed_from_snapshot`, `.admitted` |
| 05, 16 | `runs.name` + `runs.config_id`; Wegfall `idx_runs_one_live` |
| 06 | `run_tracks.state`, `run_plan`, `runs.cycle` |
| 07 | `repeat_mode`, `repeat_quota_pct`, `min_gap`, `run_tracks.weight` |
| 08 | `run_tracks.favorite` + `run_configs.favorite_weight` |
| 09 | `min_gap` gegen `selection_seq - last_played_seq` |
| 10, 27, 28, 29 | `run_configs` (+`origin_config_id`), `run_config_versions` |
| 11, 14 | `run_plan.state='current'`, `provider_commands`, `runs.device_id` |
| 12, 13 | `status='paused'` / `status='stopped'` + `stopped_at` |
| 15 | `runs.cycle++`, `run_tracks.state='open'`, Ledger bleibt |
| 17, 18 | `runs.manual_state`, `manual_since`, `manual_use_policy`, `manual_wait_seconds` |
| 19 | `skip_policy` × `run_tracks.state` ∈ {played, open, deferred} + Replan |
| 20, 21 | `run_tracks.state='excluded_user'` ↔ `'open'` |
| 22 | Aggregate über `run_tracks.state`, `play_count`, `runs.selection_seq` |
| 23 | `run_events` (Typ `played`/`skipped`) join `run_tracks` → View `v_run_history` |
| 24 | `open AND admitted = 0` → `status='completed'`, `cycle` erlaubt Folgezyklus |
| 25 | `new_tracks_policy` → `run_tracks.admitted` / `added_in_cycle` |
| 26 | `runs.archived_at` → harte Löschung; Provider-Playlist unberührt |
| 30 | `run_plan`-Horizont + `runs.last_activity_at` (Fortsetzen nach Wochen) |

---

## 3. MIGRATIONSPFAD v2 → v3

**Prinzip: additiv zuerst, destruktiv zuletzt.** `runs.order_json` bleibt bis zum letzten Schritt maßgeblich; damit ist der gesamte Mittelteil per `DROP TABLE`/`DROP COLUMN` rückrollbar und v2-Code bleibt lauffähig.

### Anforderungen an den Runner (M001)

- Tabelle `schema_migrations` statt `executescript`-only.
- Jeder Schritt: eigene Datei, eigene Transaktion (`BEGIN IMMEDIATE` … `COMMIT`), eigener Test.
- **Kein `executescript` für versionierte Schritte** — es committet implizit und zerstört die Atomarität. Geordnete `execute()`-Folge.
- `PRAGMA foreign_keys` lässt sich **nicht in einer Transaktion** umschalten → vor M005 committen.
- Vor destruktiven Schritten: `VACUUM INTO '<db>.pre-v3.db'` als Rollback-Artefakt (erfüllt zugleich „Migrationstest mit Kopie einer bestehenden DB").
- Nach jedem Schritt: `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, Zeilenzahl-Assertions.
- Versions-Floor prüfen: `sqlite_version() >= 3.35` (bookworm liefert 3.40.1) — kein `STRICT` (bräuchte 3.37).

| # | Schritt | SQL-Skizze | Datenübernahme | Rollback | Risiko |
|---|---|---|---|---|---|
| **M001** | Migrations-Metatabelle | `CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL DEFAULT '', applied_at TEXT NOT NULL DEFAULT (datetime('now')));` `INSERT OR IGNORE ... VALUES (2,'baseline_v2');` | keine | `DROP TABLE schema_migrations` (v2-Code ignoriert sie) | **niedrig** — aber: `init_db` muss `executescript(_SCHEMA_SQL)` ab jetzt **nur noch bei leerer DB** ausführen |
| **M002** | Inhaltsschicht | `CREATE TABLE tracks / playlists / playlist_snapshots / snapshot_items / snapshot_diffs` + Indizes | **Default: nur `playlists`** aus `SELECT DISTINCT user_id, provider, playlist_id, playlist_name FROM runs`. `runs.snapshot_id` bleibt NULL → Altrun läuft über `order_json` weiter. Optional (`--derive-snapshots`): Snapshot `derived=1` aus `order_json` + `skipped_tracks` | `DROP TABLE` ×5 | **niedrig** (ohne Derive) / **mittel** (mit Derive: die Shuffle-Reihenfolge ist *nicht* die Playlist-Reihenfolge — deshalb `derived`-Flag und Zwang zum Re-Import vor UC-04) |
| **M003** | Regelschicht | `CREATE TABLE run_configs / run_config_versions / run_rule_bindings` | je Nutzer ein Preset **„Ohne Wiederholungen"** mit exakt dem heutigen Verhalten: `no_repeat`, `skip_policy='consume'`, `manual_use_policy='auto_resume'`, `new_tracks_policy='ignore'`, `duplicate_policy='collapse'`, `played_threshold='on_track_end'`; dazu `run_config_versions` v1 | `DROP TABLE` ×3 | **niedrig** — der Preset ist bewusst verhaltensneutral, damit „Altrun verhält sich identisch" testbar ist |
| **M004** | `runs` additiv erweitern | `ALTER TABLE runs ADD COLUMN name TEXT NOT NULL DEFAULT '';` … `ADD COLUMN config_id INTEGER REFERENCES run_configs(id) DEFAULT NULL;` … `ADD COLUMN selection_seq INTEGER NOT NULL DEFAULT 0;` | `UPDATE runs SET config_id=<Legacy-Preset des Nutzers>, name=playlist_name, cycle=1, selection_seq=cursor, plan_version=1;` | `ALTER TABLE runs DROP COLUMN x` (3.35+; Spalten sind bewusst nicht indiziert/CHECKed) | **niedrig-mittel**. Fallen: (a) ADD COLUMN akzeptiert **keinen** Ausdrucks-Default → `DEFAULT (datetime('now'))` wird abgelehnt, Backfill per UPDATE; (b) eine Spalte mit `REFERENCES` **muss** bei aktiven FKs `DEFAULT NULL` haben |
| **M005** | `runs`-Rebuild: `status`-CHECK + Indexwechsel | `PRAGMA foreign_keys=OFF;` (außerhalb TX) `BEGIN IMMEDIATE;` `CREATE TABLE runs_new (… CHECK(status IN ('active','paused','stopped','completed','cancelled')) …);` `INSERT INTO runs_new SELECT … FROM runs;` `DROP TABLE runs;` `ALTER TABLE runs_new RENAME TO runs;` + alle Indizes neu; `PRAGMA foreign_key_check;` `COMMIT;` `PRAGMA foreign_keys=ON;` | 1:1-Kopie; `status` unverändert (kein Bestand ist `stopped`) | **Backup-Restore** aus `VACUUM INTO`. Skriptierter Reverse-Rebuild nur möglich, wenn zwischenzeitlich kein zweiter Live-Run entstand → Reverse-Skript prüft zuerst `… GROUP BY user_id,provider,playlist_id,mode HAVING count(*)>1` | **HOCH** — zwei benannte Fallen: (1) Bei `foreign_keys=ON` führt `DROP TABLE runs` ein implizites DELETE aus und **cascade-löscht `run_events` und `skipped_tracks`**. Pragma muss aus sein. (2) `ALTER TABLE ... RENAME` zieht Indexnamen mit; ein Rename-statt-Drop würde `idx_runs_one_live` am Leben lassen und `CREATE UNIQUE INDEX IF NOT EXISTS` still zum No-op machen → **DROP TABLE, nicht RENAME** |
| **M006** | Laufschicht | `CREATE TABLE run_tracks / run_plan / run_selections` + Indizes | Je Altrun aus `order_json`: Index `< cursor` → `state='played', play_count=1, last_played_seq=index`; `>= cursor` → `'open'`. `run_plan`: `seq=index`, `'consumed'`/`'current'`/`'planned'`. `skipped_tracks` → `run_tracks(state='excluded_rule', excluded_reason=reason)`, damit UC-22 sie zeigen kann. `tracks` per Get-or-Create aus `(provider, provider_track_id)` | `DROP TABLE` ×3; `order_json` ist weiter maßgeblich | **mittel** — Volumen (10 000 Tracks × N Runs). Batchweise, eine Transaktion je Run; Fortschritt über die bestehende `jobs`-Tabelle |
| **M007** | Idempotenz + Command-Log | `ALTER TABLE run_events ADD COLUMN event_key/correlation_id/source/applied/seq/run_track_id;` `UPDATE run_events SET event_key='legacy:'||id, seq=id WHERE event_key='';` `CREATE UNIQUE INDEX idx_events_key ON run_events(run_id,event_key);` + `CREATE TABLE provider_commands / provider_observations` | Backfill macht Altzeilen eindeutig, ohne sie zu bewerten | `DROP INDEX idx_events_key;` dann `ALTER TABLE run_events DROP COLUMN …`; `DROP TABLE provider_commands, provider_observations` | **niedrig-mittel** — **kein Table-Rebuild nötig**, weil alle Defaults konstant sind. Reihenfolge zwingend: Index vor Spalte droppen (indizierte Spalten sind nicht droppbar) |
| **M008** | `skipped_tracks`-Kompatibilität | v3.0: **Dual-Write** — `record_skipped()` schreibt zusätzlich `run_tracks`. v3.1: `ALTER TABLE skipped_tracks RENAME TO import_exclusions_legacy;` + `CREATE VIEW skipped_tracks AS SELECT …` | keine | Dual-Write abschalten / View droppen | **niedrig** — Dual-Write hält BASE-02 („bestehende Tests unverändert grün") im ersten Migrations-PR erreichbar |
| **M009** | `order_json` entkoppeln (**destruktiv, zuletzt**) | `ALTER TABLE runs DROP COLUMN order_json;` (legal: kein Index/CHECK/View/Trigger referenziert sie; `json_array_length(order_json)` steht nur in Python-Queries, `app/db.py:448`) | `run_plan` ist ab hier alleinige Quelle | Reverse-Skript: Spalte neu anlegen + `json_group_array` über `run_plan ORDER BY seq` — billig, muss aber geschrieben **und getestet** sein | **mittel** — erst freigeben, wenn v3-Code produktiv gelaufen ist |
| **M010** | Retention/Löschung | `CREATE TABLE deletion_requests` | keine | `DROP TABLE` | **niedrig** |

**Testbarkeit je Schritt**: M001-M004, M006-M008 und M010 sind per `DROP` rückrollbar und einzeln testbar. Nur M005 und M009 brauchen das Datei-Backup. Genau diese Aufteilung liefert die geforderte „einzeln testbare" Eigenschaft.

---

## 4. ENTSCHEIDUNGSVORSCHLÄGE zu den 10 offenen Fragen

> Alle folgenden Punkte sind **VORSCHLÄGE** zur Entscheidung durch den Lead. Jeder ist so gewählt, dass er reversibel ist (Config-Spalte, additiver Enum-Wert oder nachrüstbare Tabelle) — nie ein irreversibler Datenverlust.

**F1 — Stop vs. Pause vs. Cancel · VORSCHLAG: drei getrennte Zustände**
`paused` = kurze Unterbrechung, Watcher bleibt registriert, `device_id` bleibt, Provider erhält `pause`. `stopped` = bewusstes Sitzungsende, Watcher abgemeldet, `device_id` geleert, `stopped_at` gesetzt, Run vollständig fortsetzbar, verlässt die „Jetzt"-Oberfläche und erscheint unter „Fortsetzen". `cancelled` = endgültig, bleibt als Historie, `ensure_live` lehnt weiter ab. Löschen (UC-26) ist davon getrennt: `archived_at` → harte Löschung nach Bestätigung.
*Modell:* `status`-CHECK + `stopped_at`; `core/engine._TERMINAL_TEXT` bekommt einen `stopped`-Text, `_LIVE_STATUSES` bleibt unverändert (stopped ist nicht live), `resume()` hebt `stopped → active`. *Reversibel:* rein additiver Enum-Wert.

**F2 — Historie nach Reset · VORSCHLAG: behalten, in Zyklen**
Reset löscht nichts: `runs.cycle++`, alle `run_tracks.state='open'`, `play_count` bleibt kumulativ, `last_played_seq=NULL` (neuer Zyklus startet abstandsfrei), Ereignis `cycle_reset`. `run_events`/`run_selections` bleiben unberührt. UI: „Durchlauf 2".
*Begründung:* „Verlauf löschen" lässt sich später nachrüsten; gelöschte Historie lässt sich nicht wiederherstellen. *Modell:* `runs.cycle`, `run_tracks.added_in_cycle`.

**F3 — Identische Tracks mehrfach in einer Playlist · VORSCHLAG: `collapse` als Default, `keep_entries` als Option**
Default bleibt „eine Karte je Titel" (heutiges Verhalten, Produktversprechen). Aber **jeder Eintrag wird persistiert** (`snapshot_items.entry_uid`), sodass die Policy jederzeit umschaltbar ist, ohne neu zu importieren.
*Modell:* `run_configs.duplicate_policy`, `run_tracks.entry_uid`, `UNIQUE(run_id, track_id, entry_uid)`. *Reversibel:* Umschalten ist ein Replan, kein Datenverlust.

**F4 — Wann gilt ein Track als „gespielt" · VORSCHLAG: `on_track_end` mit 30-s-Fallback**
Gespielt gilt, wenn (a) der Provider auf den Folgetrack wechselt und der vorherige Fortschritt innerhalb `NEAR_END_MS` lag (bestehende `TRACK_ENDED`-Logik) **oder** (b) ≥ 30 s hörbare Zeit erreicht wurden — was zuerst eintritt. Ein Nutzer-Skip zählt immer gemäß `skip_policy`.
*Begründung:* 30 s ist die branchenübliche, erklärbare Schwelle und schützt gegen einen Watcher, der das Trackende verpasst. *Modell:* `played_threshold`, `played_threshold_seconds`; `run_events` bekommt Typ `played` **getrennt** von `advanced` — das Ledger hält Spiel-Fakten, der Plan hält Positions-Fakten.

**F5 — Skip bei sehr frühem/verspätetem Watcher-Signal · VORSCHLAG: das Ledger entscheidet, nicht der Timer**
Jeder Advance trägt `event_key = f"{run_id}:{plan_version}:{plan_seq}:{from}:{to}"`. Ein zweiter Report derselben Transition scheitert an `UNIQUE(run_id,event_key)` und wird mit `applied=0` protokolliert. Verspätete Signale auf bereits konsumierte `plan_seq` → `applied=0, reason='stale'`. Frühe Signale behalten die bestehende `NATIVE_SKIP`-Klassifikation (`SKIP_PROGRESS_MS`), aber ihre *Wirkung* ist die `skip_policy` des Runs, nicht mehr ein fester Consume.
*Modell:* `run_events.event_key/applied`, `run_plan.seq`.

**F6 — Mindestabstand bei kleiner Kandidatenmenge · VORSCHLAG: dokumentierte Relaxationsleiter, nie stiller Verstoß**
1. Nutzer-Ausschlüsse: **hart**, nie gelockert. 2. `min_gap`: schrittweise auf den größtmöglichen realisierbaren Wert `k = candidate_count - 1` gelockert. 3. Protokoll: `run_selections.filtered_by_json = {"gap_relaxed_from":N,"to":k}` + Ereignis `rule_relaxed`. 4. UI sagt es einmal je Lauf: „Bei 8 Titeln sind höchstens 7 Titel Abstand möglich."
Zusätzlich **Pre-Flight** (RUN-05): `min_gap >= admitted_count` ist ein Startfehler mit konkretem Korrekturvorschlag, kein Laufzeitproblem.
*Modell:* nichts Neues über `run_selections.filtered_by_json` hinaus.

**F7 — Trackbezogene Favoriten beim Config-Transfer · VORSCHLAG: Config ist playlistneutral, Track-Regeln sind run-scoped**
Eine Config auf eine andere Playlist anzuwenden überträgt **nur Regeln**. Favoriten/Ausschlüsse wandern nicht mit. Optional, explizit und sichtbar: ein zweiter Schritt „Favoriten mitnehmen", der zuerst über ISRC (`tracks.work_key`), dann über (normalisierter Name, Artist, Dauer ±2 s) matcht und dem Nutzer zeigt, was zugeordnet wurde und was nicht.
*Modell:* Die Trennung ist bereits im Schema (`run_configs` vs. `run_tracks`). Die portable Variante hieße `config_track_rules(config_id, provider, provider_track_id, work_key, kind, weight)` — **Name reservieren, in v3.0 nicht bauen.** *Reversibel:* additive Tabelle.

**F8 — Wie lange „automatisch fortsetzen" wartet · VORSCHLAG: beobachten statt kämpfen, mit harter Obergrenze**
Keine Timer-Primärregel. Zustandsautomat auf `runs.manual_state`: `manual_detected`, sobald der Provider etwas außerhalb des Plans spielt → True Shuffle **sendet keine Commands mehr und beobachtet nur**. Fortsetzung wenn (a) der Provider idle wird, (b) die Wiedergabe auf einen Plan-Track zurückkehrt, oder (c) `manual_wait_seconds` (Default 900 s) durchgehender Fremdwiedergabe verstreichen → `suspended` (Run pausiert kontrolliert).
*Begründung:* Die Spotify-API kann „die manuelle Queue ist zu Ende" nicht signalisieren; begrenztes Beobachten-dann-Aussetzen ist ehrlich und beschädigt das Ledger nie. `ask` setzt `awaiting_decision` und fragt beim nächsten Öffnen.
*Modell:* `runs.manual_state/manual_since`, `run_configs.manual_wait_seconds`, Ereignistypen `manual_detected|manual_resumed|manual_suspended`.

**F9 — Sichtbarer Ausführungskontext in Spotify · VORSCHLAG: ja, aber opt-in je Run und beschriftet**
Default für v3.0 bleibt `execution_strategy='uris_window'` (`PUT /me/player/play` mit `uris`-Array + `offset` — laut Phase-0-Re-Audit vorhanden), weil es **keine Seiteneffekte in der Bibliothek** erzeugt und die append-only-Queue umgeht. `context_playlist` ist eine per Run wählbare Alternative mit klarer Benennung (`true-shuffle · <Name>`) und Cleanup-Pfad.
*Modell:* `run_configs.execution_strategy`, `runs.copy_playlist_id` (existiert), `provider_commands.kind ∈ {create_playlist, add_tracks}`. *Reversibel:* beide Pfade koexistieren als Datenwert — das ist exakt die Struktur, die SP-007 („zwei Strategiekandidaten mit Messung") messbar macht.

**F10 — Datenlöschung bei Spotify-Disconnect · VORSCHLAG: dreistufig, Frist 5 Tage (Terms V.8 / Appendix A.5.c)**
*Sofort:* `provider_accounts`-Zeile inkl. versiegelter Tokens, alle `provider_observations` dieses Providers, `provider_commands.payload_json` redigiert.
*Innerhalb 5 Tagen (Job über `deletion_requests`):* alle Spotify-**Inhalte** — `snapshot_items`, `playlist_snapshots`, `playlists`, `tracks` dieses Providers.
*Behalten, anonymisiert:* der eigene Hörfortschritt als abstraktes Deck — `runs`, `run_tracks` mit `track_id` → lokaler Opaque-Hash, `run_events` ohne `detail`. Begründung: das ist Nutzerzustand, kein Spotify-Content, und es ist der Grund, warum ein Reconnect fortsetzt statt neu zu beginnen.
*Exportierbar vor Löschung:* `/export/{run_id}` zu einem Account-Export erweitern.
*Falls die Rechtsprüfung widerspricht:* ein Flag schaltet auf Vollöschung. *Modell:* `deletion_requests`, `runs.content_detached INTEGER`.

---

## 5. KONFLIKTE UND RISIKEN

### 5.1 Tests, die das Zielmodell bricht (mit Begründung)

| Test | Bruch | Empfohlener Ersatz |
|---|---|---|
| `tests/test_db.py:107 test_only_one_live_run_per_playlist_and_mode` | Erwartet `aiosqlite.IntegrityError` beim zweiten Live-Run. Das Zielmodell erlaubt das **absichtlich** (UC-16) | Umschreiben zu: zwei Live-Runs erlaubt; genau ein `active`-Controller-Run je (user, provider). **Die Neufassung ist die Akzeptanzevidenz für RUN-01** |
| `tests/test_db.py:125 test_a_cancelled_run_frees_the_slot` | Es gibt keinen „Slot" mehr | „`close_live_runs` beendet nur den benannten Run und lässt andere Runs derselben Playlist unberührt" (= Run-Isolation-Invariante) |
| `tests/test_db.py:14 test_init_creates_the_v2_schema` | Prüft `<=`, überlebt neue Tabellen — verliert aber seine Aussagekraft | v3-Tabellenmenge ergänzen |
| `tests/test_db.py:171 test_latest_completed_order_...` | Liest `order_json` | überlebt bis M009, danach über `run_plan` |
| `tests/test_api.py:308` (`"reshuffle": True`) | `reshuffle` ist heute „Live-Run canceln + neu würfeln". Mit UC-15/UC-16 zerfällt das in zwei getrennte Aktionen | Lead-Entscheidung: `reshuffle` → UC-15-Reset **oder** „neuen Run anlegen". Der Parametername sollte nicht beides bedeuten |
| `tests/test_watcher.py`, `tests/test_history_sync.py` | bauen Runs über `db.create_run(...)` | `create_run` muss abwärtskompatibel bleiben: `config_id` defaultet auf das Legacy-Preset |

### 5.2 Code-Semantik, die falsch wird

- **`app/routes_export.py:54-58`**: Der Kommentar „An import must not collide with a deck that is already live … the partial unique index would reject the insert" und der `close_live_runs`-Aufruf werden **sachlich falsch**. Ein Import muss einen unabhängigen Run erzeugen (UC-16) und darf einen laufenden Run nicht mehr abräumen.
- **`app/runs.py:102-107` (`build_run`)**: „Resume by default" via `find_live_run` wird bei mehreren Live-Runs je Playlist **mehrdeutig**. Muss zu „Run X fortsetzen" (explizite Run-ID) oder „neuen Run anlegen" werden. Das ist die zentrale Verhaltensänderung im Service-Layer.
- **`core/engine.previous()`** gegen ein `played`-Ledger: Rückwärtsgehen darf nicht still ent-spielen. *Vorschlag:* `previous()` ist ein **Replay** — `play_count` bleibt, die Plan-Zeile wird erneut `current`, ein `replayed`-Ereignis wird geschrieben. Andernfalls lässt sich die No-Repeat-Invariante durch wiederholtes Zurückspringen aushebeln.
- **`core/exporter.py` / `EXPORT_VERSION=2`** transportiert nur `order` + `cursor`. Mit `run_tracks` muss es v3 werden (Config, Zustände, Favoriten, Ausschlüsse) oder ausdrücklich als verlustbehafteter Legacy-Export dokumentiert sein.

### 5.3 Semantik, die **erhalten bleiben muss**

- **`runs.advance_lock` (`app/runs.py:455-469`) behalten.** `UNIQUE(run_id,event_key)` ersetzt sie nicht: der Index *weist den zweiten identischen Schreiber ab*, er *ordnet zwei nebenläufige Schreiber nicht*. Beides zusammen erfüllt SP-004/SP-005 **und** ERR-08. Ein DB-Lease (`runs.lease_owner`, `lease_expires_at`) nur reservieren, nicht bauen, solange die Ein-Prozess-Annahme gilt.
- **`latest_completed_order` / Similarity-Guard** (`app/db.py:424-439`, `core/shuffle.py:116-148`) behalten — er ist eine nutzerspürbare Qualitätseigenschaft. **Achtung, stille Änderung:** die heutige Query ignoriert `mode` und Config. In v3 muss sie auf den letzten abgeschlossenen Zyklus **derselben (Playlist, Config)** eingeschränkt werden, sonst beeinflussen sich zwei unterschiedlich konfigurierte Runs gegenseitig (Verstoß gegen die Run-Isolations-Invariante).
- **`jobs` unverändert.** Import (UC-03) und Copy-Write laufen bereits darüber; `playlist_snapshots.job_id` gibt dem Fortschrittsbalken einen echten Besitzer.
- **Reinheit von `core/engine.py`/`core/shuffle.py`.** Die Auswahl bekommt eine reine Funktion `select_next(candidates, rules, seed, seq) -> Selection`. SQL filtert nur vor (`state='open' AND admitted=1`); die Regellogik gehört **nicht** in SQL, sonst sind RUN-03/04/07 nicht property-testbar.
- **`reconcile` / `reconcile_history`** behalten; sie werden von Advance-Auslösern zu **Ereignis-Produzenten**, die einen `event_key` emittieren, statt direkt `advance()` zu rufen.
- **Ownership-in-der-Query** auf jedem neuen Accessor.

### 5.4 Technische Risiken (priorisiert)

1. **`init_db` führt `executescript(_SCHEMA_SQL)` bei jedem Start aus** (`app/db.py:158`). Nach M005 würde `CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_live` den **UC-16-Blocker bei jedem Neustart still wiederherstellen**. Das ist die dringendste Codeänderung im Migrations-PR: `_SCHEMA_SQL` darf nur noch bei leerer Datenbank laufen.
2. **`DROP TABLE runs` bei `foreign_keys=ON`** führt ein implizites DELETE aus und cascade-löscht `run_events` + `skipped_tracks`. Pragma zwingend vorher aus, außerhalb der Transaktion, mit `PRAGMA foreign_key_check` vor dem Commit.
3. **`ALTER TABLE ... RENAME` zieht Indexnamen mit** — `IF NOT EXISTS` wird dann zum stillen No-op. In M005 `DROP TABLE` statt `RENAME` verwenden. (`app/db.py:196` belegt, dass dieses Problem im Repo schon einmal manuell umschifft wurde.)
4. **ADD COLUMN akzeptiert keinen Ausdrucks-Default** (`(datetime('now'))`, `CURRENT_TIMESTAMP`) und verlangt bei `REFERENCES` + aktiven FKs `DEFAULT NULL`. Beide Regeln sind in M004 eingearbeitet.
5. **DROP COLUMN scheitert an indizierten/CHECK-referenzierten Spalten.** Reihenfolge in jedem Rollback: erst Index droppen, dann Spalte.
6. **Volumen**: `run_tracks` + `run_plan` bei 10 000 Tracks × N Runs. Die Akzeptanzforderung „Performanceprofil für 10 000 Tracks" bekommt damit ein konkretes Ziel: Plan-Materialisierung und die `select_next`-Kandidatenquery (`idx_run_tracks_open`, `idx_run_tracks_gap`).
7. **SQLite-Floor**: lokal 3.45.1, Produktion `python:3.11-slim`/bookworm = 3.40.1. Floor auf **3.35** festschreiben und beim Start prüfen; kein `STRICT` (3.37).
8. **Migrations-Metatabelle vs. `schema_meta`**: beide synchron halten, solange v2-Code rollbar sein soll — `schema_meta.version` bleibt der Wert, den alter Code liest.

---

### Critical Files for Implementation

- `/home/user/true-shuffle-PoC/app/db.py` — Schema v2, `_SCHEMA_SQL`, `_migrate_legacy`, alle Run-/Event-Accessoren; hier entsteht der Migrations-Runner und die v3-Schemadefinition
- `/home/user/true-shuffle-PoC/app/runs.py` — `build_run` (Resume-by-default), `_apply` (Queue-Vervielfachung), `advance_lock`; Service-Layer für `run_tracks`/`run_plan`/`provider_commands`
- `/home/user/true-shuffle-PoC/core/models.py` — `RunStatus` (`stopped`), `SkipReason`/`AdvanceReason`, `Track.key`, neue Config-/Selection-Typen
- `/home/user/true-shuffle-PoC/core/shuffle.py` — `prepare_shuffled_run` wird zu `plan_cycle` + reinem `select_next(candidates, rules, seed, seq)`
- `/home/user/true-shuffle-PoC/tests/test_db.py` — die beiden Live-Run-Constraint-Tests kodieren die Semantik, die UC-16 auflöst; ihre Neufassung ist die RUN-01-Evidenz