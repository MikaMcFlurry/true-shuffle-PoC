# Security-/Privacy-Status — TS-FABLE-01 (Phase 4 §B3, G5)

Stand: 2026-08-01 · Basis: unabhängiger Opus-Security-Review (kein
Implementierungskontext, 20 Findings + 18 als solide bestätigte Punkte, je mit
praktischem TestClient-Beleg) + Lead-Fix-Pass `07d5575`.
Rolle: Erzeuger ≠ Abnehmer — der Review prüfte fremden Code.

## Als solide bestätigt (mit Beleg, Auszug)

- **Autorisierung/IDOR:** 36/36 Cross-Session-Angriffe gegen alle 24 Run-Routen
  inkl. der neuen (`GET …/tracks`, `PUT …/weight`, `POST …/apply-sync`) → 404,
  nie 403 (bestätigt die Id nicht). `run_track_id` run-gebunden, auch innerhalb
  eines Nutzers keine Verwechslung. apply-sync prüft Diff-Eigentümerschaft.
- **Verschlüsselung at rest:** AES-256-GCM, frischer 12-Byte-Nonce (200 Seals →
  200 verschiedene Blobs), greifendes Tag, nichts im Klartext (auch nicht im
  WAL). scrypt-Ableitung schlüsselabhängig.
- **OAuth/PKCE:** state session-gebunden, 32 Zeichen, einmalig (Replay → 400),
  Provider-Abgleich; PKCE echtes S256 (rechnerisch verifiziert), Redirect-URI
  aus Settings (kein Open Redirect).
- **SQL-Injection ausgeschlossen** (alle dynamischen SQL-Teile Code-Konstanten
  bzw. Allowlist; `Rules.from_dict` wirft bei unbekannten Keys), **kein SSRF**
  (Provider-URLs Modulkonstanten, `httpx.URL.host` bleibt immer der Dienst),
  **XSS-Oberfläche klein** (Autoescape, kein `|safe`, `el()` nur Textknoten).
- **Log-Vertrag hält bei INFO** (dem Produktionswert); keine Tokens in Antworten
  (Sweep über alle Bodies), FK-Kaskaden löschen `snapshot_diffs`/`items`.

## Findings und Status

| ID | Schwere | Thema | Status |
|---|---|---|---|
| SEC-01 | hoch (bedingt) | Default-SECRET_KEY nur geloggt, nicht erzwungen → Gate-Bypass | **BEHOBEN** `07d5575`: `refuse_to_start_reason` bricht Start ab, wenn Default-Key und nicht rein lokal; getestet |
| SEC-02 | mittel | Session-Fixation: kein Handle-Rotieren beim Connect | **OFFEN (dokumentiert)** — Fix gehört an dieselbe Stelle wie SEC-08; Ausnutzbarkeit auf `*.fly.dev` niedrig (PSL/HSTS), vor öffentlicher Version Pflicht |
| SEC-03 | mittel | Löschung ließ Ids/Namen/event_key/skip-track_id stehen | **BEHOBEN** `07d5575`: Allowlist-Redaktion, `playlist_id`/`name` weg, `event_key` gehasht, `skipped_tracks.track_id` weg; getestet |
| SEC-04 | mittel | `jobs`-Tabelle nie gelöscht (Playlist-Ids im result_json) | **BEHOBEN** `07d5575`: `DELETE FROM jobs` in `execute_request`; getestet |
| SEC-05 | mittel | Stufe 3 als „anonymisiert" deklariert, ist Pseudonymisierung | **BEHOBEN** `07d5575`: Wortwahl in Docstring/ADR-003/Disconnect-Dialog korrigiert (Salt bleibt in der DB — bewusst, für Reconnect) |
| SEC-06 | mittel | Disconnect stoppt Watcher/Lauf nicht → Endlos-Poll | **BEHOBEN** `07d5575`: Stufe 1d stoppt Watcher + setzt Läufe auf `stopped`; Watcher beendet Loop bei `AccountNotConnected`; getestet |
| SEC-07 | mittel | Unlesbarer Token-Blob → 500 auf jeder Provider-Route | **BEHOBEN** `07d5575`: `VaultError` → `AccountNotConnected` (409); getestet |
| SEC-08 | gering | Identität nur am Cookie-Handle (Cookie weg = Läufe verwaist) | **OFFEN (dokumentiert)** — Re-Bind über `provider_user_id` beim Reconnect skizziert; kein Datenverlust-Risiko, Nutzerkomfort; vor öffentlicher Version |
| SEC-09 | gering | `signout` als GET; Callback poppt state auch bei Fehltreffer | **TEILBEHOBEN** `07d5575`: Callback poppt state nur bei Treffer (getestet); `signout`→POST als Kleinpunkt offen |
| SEC-10 | gering | Kein Rate-Limiting/Lockout am Zugangscode | **OFFEN (Restrisiko)** — dokumentiert; Auflage: `ACCESS_CODE`-Mindestentropie in DEPLOY.md (s. u.) |
| SEC-11 | gering | Import-/Body-Größe unbegrenzt | **OFFEN (Restrisiko)** — `max_length` am Pydantic-Modell als Kleinpunkt notiert |
| SEC-12 | gering | Disconnect ohne Provider-/Konto-Validierung (Ledger-Spam) | **BEHOBEN** `07d5575`: Registry-Lookup + Konto-Pflicht (404), keine Ledger-Zeile ohne Konto; getestet |
| SEC-13 | gering | `/auth/{unbekannt}/browser` → 500 | **BEHOBEN** `07d5575`: `KeyError` → 404; getestet |
| SEC-14 | gering | `LOG_LEVEL=DEBUG` loggt SQL-Parameter (Tokens) | **BEHOBEN** `07d5575`: `aiosqlite`-Logger hart auf INFO gepinnt |
| SEC-15 | gering/info | `ts.provider.command` loggt `provider_track_id` | **DOKUMENTIERT** — Log-Vertrag ehrlich um „Provider-Track-Ids" ergänzt (unten); Hash optional |
| SEC-16 | gering | Keine Security-Header | **BEHOBEN** `07d5575`: `X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy`-Middleware; getestet |
| SEC-17 | info | Rohe Provider-Fehlertexte im Ledger | **BEHOBEN** `07d5575`: `str(exc)[:200]` bei `window_reassert_failed`; `error`-Key in SEC-03-Allowlist ausgenommen |
| SEC-18 | info | Vault akzeptiert Legacy-Klartext ohne `tsv1:` | **OFFEN (dokumentiert)** — hinter Migrationsschalter legen; Angreifer bräuchte ohnehin DB-Schreibzugriff |
| SEC-19 | info | Sitzungscookie signiert, nicht verschlüsselt; state ohne TTL | **OFFEN (dokumentiert)** — state-TTL + kürzere Cookie-Max-Age als Kleinpunkte |
| SEC-20 | info | Volllöschung nur per API, nicht in der UI | **TEILBEHOBEN** — Disconnect-Dialog nennt jetzt Frist/Export/Pseudonymisierung; UI-Schalter für Full-Delete offen |

## Gesamtempfehlung des Reviews

**Freigabefähig mit Auflagen** — alle fünf als blockierend eingestuften
Auflagen (SEC-01, SEC-07, SEC-06, SEC-03+04, SEC-05) sind in `07d5575`
umgesetzt und getestet. Die Substanz (Autorisierung, Verschlüsselung, OAuth,
Injection/SSRF) wurde als überzeugend belegt.

## Offene Restrisiken (bewusst nicht in diesem Gate gebaut)

Dokumentiert, für eine ÖFFENTLICHE Version (jenseits „fünf Leute mit einem
geteilten Code", wie `app/gate.py`/README es selbst abgrenzen) Pflicht:
- **Echte Konten statt Cookie-Identität** (SEC-02/SEC-08 — ein Patch an
  derselben Stelle: Re-Bind über `provider_user_id` beim Reconnect, mit den
  zwei Fallen aus dem Review — nur wenn die Sitzung noch nichts Eigenes hat,
  und NICHT für Apple, dessen `provider_user_id` kein stabiler Nutzerbezug ist).
- **Rate-Limiting/Lockout** (SEC-10) — **Auflage schon jetzt:** `DEPLOY.md`
  schreibt eine Mindestentropie für `ACCESS_CODE` vor (der Beispielwert war zu
  schwach; 544 Rateversuche/s gemessen).
- **CSRF jenseits SameSite** (SEC-09-Rest, Origin-Middleware), **CSP** (SEC-16
  zweite Stufe), Import-Größenlimit (SEC-11), Legacy-Vault-Pfad (SEC-18),
  Cookie-Verschlüsselung/state-TTL (SEC-19), Full-Delete-UI (SEC-20).

## Nicht geprüft (Review-Grenzen, ehrlich)

Live gegen echte Provider-Endpunkte (keine Credentials — PKCE nur rechnerisch),
das Fly-Deployment selbst (TLS/HSTS, `fly.dev`-PSL-Status), echtes
Browser-`SameSite`-Verhalten, der per Default deaktivierte
`ytmusic_unofficial`-Connector (potenzielles Cookie-Leak in Fehlertext, vor
Aktivierung prüfen), Apple MusicKit-Signierung, Dependency-CVE-Scan
(`cryptography 41.0.7` als Systempaket — separat gegen Advisories prüfen).

## Log-Vertrag (präzisiert, SEC-15)

`ts.provider.command` (INFO) protokolliert `run_id`, `cursor`, Fenstergröße und
**`provider_track_id`** (öffentliche Katalogdaten) — über die Zeit eine
Hörhistorie im Logstream. Ausdrücklich NICHT geloggt: Access-/Refresh-Token,
`provider_user_id`, Kontoname, Gerätename/-Id, Playlist-Name/-Id, Titelnamen.
