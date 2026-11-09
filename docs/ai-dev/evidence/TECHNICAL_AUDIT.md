# Technischer Red-Team-Audit true-shuffle @ b5a1856 (Auftrag B)

Status: ABGESCHLOSSEN (Audit 2026-10-01, read-only; Repro-Tests nur im Scratchpad)

## Kurzfazit
**Gesamturteil:** Für `b5a1856` (= `src` von `30ae6a2`) ist die Behauptung „Spotify-Ablehnungen werden klar erklärt“ **widerlegt** (F-01, P1, reproduziert). Die Kernaussagen „kein simulierter Fortschritt wird gespeichert“, „429 pro Konto/Operation ohne globalen Block“ und „Queue-Vorschau 50 Nachfolger“ sind auf Quellcodeebene bestätigt. Latenz- und Prioritätsaussagen sind nur gegen FakeSpotify bzw. ohne DO-Serialisierung belegt und unter realistischer Spotify-Verzögerung bzw. Joblast angreifbar (F-02, F-04). Kein P0. Live-Grenzen (iPhone, Spotify, HA/MA, Restore, Latenz) sind NOT_RUN.

- **Root Cause e2e-Fehler (Lead 9) bestätigt:** Hub schaltet bei abgelehntem Start die sichtbare gespeicherte Station um (`hub.ts:4916`, seit `23111bd`); Client löscht den fehlgeschlagenen Befehl, sobald sich `entryId` ändert (`store.ts:176-179`, seit `f5c8e0f`). Beides unabhängig reproduziert (SIMULATED).
- 1×P1, 4×P2, 3×P3; Details unten.

## Prüfgegenstand
- Subjekt: Commit `b5a18561f8316ad83a2cfb09150fe7b3fb6b35ce` (Branch `codex/implement-cloudflare-restart`).
- Extrahierte Kopie: `eine per `git archive b5a1856` extrahierte Kopie`; `src/`, `e2e/`, `test/` per `git archive b5a1856 src e2e test` frisch extrahiert und mit `diff -r` gegen die Kopie geprüft: IDENTISCH.
- Vergleichsstände: `0a05d4f` (Song-Uhr), `1328f8f` (bestätigter Tracker), `f5c8e0f`/`30ae6a2` (Optimierungslauf).
- Gate-Ergebnis (Vorlauf, nicht von mir wiederholt): `gates-b5a1856.log` (vitest); Hauptsession: typecheck PASS, lint PASS, vitest 28 Dateien/428 Tests PASS. Von mir nicht neu ausgeführt außer den unten genannten gezielten Tests.
- Von mir ausgeführt (Scratch-Kopie `scratchpad/audit/run`, `node_modules` verlinkt): `npx vitest run test/audit/<datei>.test.ts.txt --silent=false` für `refused-start`, `store-failed-notice`, `lagging-confirmation`, `lost-next`, `local-refusal` – jeweils PASS (Tests dokumentieren Befunde, keine Produkt-Gates).
- Nicht ausgeführt: Playwright, wrangler dev, Live-Spotify, Cloudflare, physisches iPhone.

## Befunde (Übersicht)
| ID | Prio | Bereich | Befund | Reproduktion | Evidenz | Risiko |
|---|---|---|---|---|---|---|
| F-01 | P1 | Start/Fehleranzeige | Abgelehnter Start (Premium/kein Gerät) auf anderer Station schaltet `active_session_station` um; `reconcileCommand` löscht dadurch den Fehlerhinweis sofort – Root Cause des e2e-Fehlers | `hub.ts:4914-4916`, `store.ts:176-179`; `npx vitest run test/audit/refused-start.test.ts.txt test/audit/store-failed-notice.test.ts.txt` (scratch) | SIMULATED + SOURCE (e2e NOT_RUN) | Keine Erklärung bei Ablehnung; gehaltene Station ersetzt |
| F-02 | P2 | Latenz/Bestätigung | Nur eine Beobachtung 1 s nach Befehl; bei verzögertem Spotify-Zustand erst nach ~31 s bestätigt, Session zwischenzeitlich `paused` | `hub.ts:5193-5196`, `store.ts:131-147`; `test/audit/lagging-confirmation.test.ts.txt` | SIMULATED (Lag-Annahme, live NOT_RUN) | Falsch „unbestätigt“, Doppelstart/Rücksprung |
| F-03 | P2 | 429 | Lokale Operation-Sperre wird wie Spotify-429 formuliert („gleich nochmal“ trotz 600 s), keine Zustandswarnung; pro Konto/Operation korrekt | `client.ts:227-257`, `hub.ts:5098-5104`; `test/audit/local-refusal.test.ts.txt` | SIMULATED | Irreführende Wiederholversuche |
| F-04 | P2 | DO-Priorität | Alle RPCs und Alarm in einer `exclusive`-Kette; Befehl wartet hinter bis zu 40 Requests Hintergrundarbeit, läuft nach Client-Timeout verspätet | `userhub.ts:95-121, 573-590`, `hub.ts:209` | SOURCE | Lange Klicklatenz, verspätete Befehle |
| F-05 | P3 | Queue-Vorschau | 51/50-Vertrag bestätigt; Randfälle (Projektion → 49, fehlender Eintrag → aktueller Song als Nr. 1); externe Queue/Autoplay/Repeat nicht abgebildet | `hub.ts:4739-4757`, `home.tsx:592-598`, `playback-view.ts:86-112` | SOURCE | Falsche „Als Nächstes“-Erwartung |
| F-06 | P3 | Weiter | Nicht ausgeführter Skip wird durch natürliches Songende bestätigt; `pending.next` ohne Ablauf | `hub.ts:4798-4812`; `test/audit/lost-next.test.ts.txt` | SIMULATED | Geringe Statistik-/UX-Verzerrung |
| F-07 | P3 | Geräte | Explizite Geräte-ID unbegrenzt in localStorage; Fehlertext nennt nicht das gewählte Gerät; Automatik korrekt begrenzt (60 s/5 s) | `home.tsx:109-120`, `hub.ts:5118-5170` | SOURCE + SIMULATED | Unklare Meldung bei iPhone im Hintergrund |
| F-08 | P2 | Tests | Keine Unit-Tests für `store.ts`/`playback-view.ts` | `grep -rln "client/store\|playback-view" test` | SOURCE | Regressionen wie F-01 nur via e2e sichtbar |

## Detaillierte Befunde

### F-01 (P1) Abgelehnter Start wechselt die sichtbare gespeicherte Station; Fehlerhinweis verschwindet sofort (Root Cause des e2e-Fehlers „says clearly when Spotify refuses“)
**Bereich:** Hub `resumeSession`, Client `reconcileCommand`.
**Mechanik (SOURCE):**
1. `src/worker/hub/hub.ts:4914-4916` – `resumeSession()` legt für die Zielstation per `createSession()` eine neue Session an (falls keine existiert) und setzt `kvSet("active_session_station", stationId)` **vor** jeder Provider-Arbeit („Journal before provider work“). Im Fehlerpfad (`hub.ts:5038-5065`) wird nur `pending` zurückgesetzt; `active_session_station` wird **nicht** zurückgestellt. Beim `no_device`-Pfad ohne Ziel (`hub.ts:4926-4937`) wird die neue Session zusätzlich `status = "disconnected"`.
2. `getState()` → `sessionView()` ohne Argument (`hub.ts:5729`, `4739-4741`) liefert daher nach dem abgelehnten Start die Session der abgelehnten Station.
3. `src/client/store.ts:176-179` (eingeführt in `f5c8e0f`): `if (command.phase === "failed" && session?.entryId !== command.entryId) clearCommand()`. Da `command.entryId` die Eintrags-ID der *vorherigen* Station ist und die Folgeabfrage (`home.tsx:222`, `store.refresh(true, true)`) die neue Session liefert, wird der fehlgeschlagene Befehl samt Hinweis „Spotify erlaubt das Starten nur mit Premium.“ (`home.tsx:325-329`) innerhalb weniger Millisekunden entfernt. Vor `f5c8e0f` (z. B. `0a05d4f`) wurde der Fehler als 7-s-Flash (`store.say`) gezeigt, der nicht an `entryId` hing – deshalb ist es eine Regression aus dem Optimierungslauf.
**Reproduktion (SIMULATED, von mir ausgeführt):**
- `docs/ai-dev/evidence/technical-audit/refused-start.test.ts.txt` (FakeSpotify-Harness, `onboarded({playlists:[300,300]})`, Station A spielen+pausieren, dann Premium aus bzw. `devices=[]`, `play(B)`): Ergebnis `{"rejection":"premium","beforeStation":1,"afterStation":2,"afterStatus":"saved","newWrites":["PUT /v1/me/player/play"]}` und `{"rejection":"no_device","beforeStation":1,"afterStation":2,"savedA":"disconnected","newWrites":["PUT /v1/me/player/shuffle","PUT /v1/me/player/repeat","PUT /v1/me/player/play"]}`. Kommando: `cd scratchpad/audit/run && npx vitest run test/audit/refused-start.test.ts.txt --silent=false` → 2/2 PASS (Assertions dokumentieren den Befund).
- `docs/ai-dev/evidence/technical-audit/store-failed-notice.test.ts.txt` (Store mit gemocktem `api.state`): mit gewechselter Session `{"kept":false}` (Hinweis weg), mit unveränderter Session `{"kept":true,"phase":"failed"}`. 2/2 PASS.
- e2e selbst: NOT_RUN durch mich (Playwright verboten); der 4/4-Fehlschlag der Hauptsession ist durch beide Mechanismen vollständig erklärt.
**Zusatzbefunde aus derselben Reproduktion:**
- Ein abgelehnter Start auf Station B setzt Station A im `no_device`-Fall auf `disconnected` (Folge der erzwungenen `sync`), und B wird mit einer frischen Session ohne Fortschritt sichtbar – die vorher gehaltene Station A verschwindet aus „Weiterhören“, obwohl nichts gestartet wurde.
- Vor dem Abbruch können bereits Spotify-Schreibzugriffe erfolgt sein (`replaceItems` bei `deck_intent`, `setShuffle`/`setRepeat`, ggf. `rebuildDeck`) – der Start ist also kein reiner lokaler Vorgang; „abgelehnt“ heißt „Wiedergabe nicht gestartet“, nicht „nichts geändert“.
**Risiko:** Nutzer sieht keine Erklärung für die Ablehnung (Kern-UX-Versprechen „sagt klar, warum“); die zuletzt gehaltene Station wird durch eine nie gestartete ersetzt.
**Fix-Vorschlag (nicht implementiert):** (a) Hub: `active_session_station` erst nach erfolgreichem/unklarem Transport setzen oder im definitiven Ablehnungspfad (`!result.uncertain`) auf den vorherigen Wert zurücksetzen; neu erzeugte, nie gestartete Session nicht als aktiv markieren. (b) Client: einen `failed`-Befehl nicht über `entryId`-Vergleich löschen, sondern nur bei Profilwechsel, neuem Befehl, explizitem Schließen oder nach Ablauf (z. B. 15 s) bzw. wenn eine *neuere* Beobachtung der Zielstation (`stationId === command.stationId`, `observedAt > failedAt`) erfolgreichen Start belegt. Testbedarf: Hub-Unit-Test „abgelehnter Start auf anderer Station lässt `state().session.stationId` unverändert“ (premium, no_device, restricted); Store-Test wie oben; e2e-Test unverändert als Regressionstest; zusätzlich e2e mit Klick auf *gleiche* Station.

### F-02 (P2) Bestätigung hängt an genau einer Beobachtung 1 s nach dem Befehl; eine verzögerte Spotify-Antwort führt zu „Bestätigung steht aus“ und zeitweise „pausiert“
**Bereich:** Latenzpfad Klick → Befehl → Beobachtung.
**Mechanik (SOURCE):**
- Hub: nach erfolgreichem `PUT /me/player/play` genau ein Beobachtungstermin `player_observation_due = now + 1000` (`hub.ts:5193-5196`, `deferPlayerObservation`). Nach dieser Beobachtung wird der Termin gelöscht (`hub.ts:2637-2640`); `session.pending` ist bereits `null` (`hub.ts:5021-5026`), d. h. es gibt keinen weiteren, befehlsgebundenen Lesetermin.
- Client: Befehlslesungen bei 1,5 s und 4 s sind `refresh(false, true)` = `/api/state` **ohne** `live` (`store.ts:131-141`) – sie lesen nur den DO-Zustand, lösen keinen Spotify-Read aus. Der 15-s-Tick (`live=1`) wird im Hub durch `foregroundObservationDeadline` gedrosselt: pausiert 2 min, aktiv 45 s (`observation-policy.ts:62-86`). Nach 20 s setzt der Client `unconfirmed` (`store.ts:143-147`).
- FakeSpotify bildet Schreibvorgänge sofort in `GET /me/player` ab (keine Lag-Modellierung in `test/fakes/fake-spotify.ts`); die bestehenden Tests prüfen daher nur den Idealfall.
**Reproduktion (SIMULATED):** `docs/ai-dev/evidence/technical-audit/lagging-confirmation.test.ts.txt` – FakeSpotify liefert nur für 1,5 s nach dem Play-Befehl noch das alte Pause-Bild. Ergebnis: `staleReads:1`; `nowPlaying.isPlaying=false` (beobachtet bei +1000 ms) bleibt bei +1,5 s, +4 s, +15 s (live), +20 s, +30 s (live) bestehen; erste echte Wiedergabe-Beobachtung erst bei **+31 s**. Damit fällt der Client nach 20 s auf „Die Gerätebestätigung fehlt noch …“ und `checkpoint()` setzt `session.status` aus der veralteten Beobachtung auf `paused` (`hub.ts:4845-4851`), sodass die UI ggf. zu erneutem Fortsetzen einlädt (Gefahr eines Rücksprungs auf die gespeicherte Position, den der Hinweistext selbst nennt).
**Evidenzgrenze:** Die tatsächliche Spotify-Propagationszeit wurde nicht gemessen (NOT_RUN live). Die Annahme „Spotify kann kurzzeitig den alten Zustand liefern“ ist eine plausible, nicht belegte Annahme; der Code verhält sich unter dieser Annahme wie beschrieben.
**Risiko:** Falsch-negativ „nicht bestätigt“ bei realer Wiedergabe; Doppelstart/Rücksprung durch Nutzer; Messgrößen der Latenz (Klick→Bestätigung) im Fake sind systematisch zu optimistisch.
**Vorschlag:** Nach einem akzeptierten Befehl eine kurze, begrenzte Bestätigungsfolge (z. B. +1 s, +3 s, +8 s, max. 3 Reads, gebunden an `operationId`) statt einer Einzelbeobachtung; eine Beobachtung, die älter wirkt als der Befehl (gleicher Track/Position/`isPlaying=false` nach `play`), nicht als `paused` in die Session schreiben, solange der Befehl offen ist. Testbedarf: FakeSpotify-Option „Lag n ms / n Reads“ und Tests für play/pause/next mit Lag.

### F-03 (P2) Lokale Sperre nach 429 wird wie eine echte Spotify-Antwort formuliert; „gleich“ trotz bekannter 10-min-Sperre, keine Warnung im Zustand
**Bereich:** 429/Retry-After, lokale Verweigerung vs. echter Spotify-Fehler.
**Mechanik (SOURCE):** `SpotifyClient.guard()` (`src/worker/spotify/client.ts:224-256`) wirft bei aktiver Operation-Sperre einen `SpotifyError(kind "rate"|"quota", status 429)` **ohne** Netzwerkanfrage (Metrik `retryCategory: "blocked"`). `Hub.playError()` (`hub.ts:5098-5104`) unterscheidet das nicht: beide Fälle → „Spotify bremst gerade — gleich noch einmal versuchen.“ Die globale Backoff-Warnung ist stillgelegt (`setBackoff`/`backoffUntil` sind No-ops, `hub.ts:1115-1121`), daher erscheint in `state().warnings` kein Hinweis auf die Sperre.
**Positiv (bestätigt):** Sperren sind pro Konto (`listener`) und pro `METHOD /endpoint` (`operation-gates.ts:35-98`, Schlüssel `(listener, operation)`); es gibt keinen erfundenen globalen Block. Unbekanntes Retry-After (`until: null`) erzeugt keine erfundene Freigabezeit; ein späteres bekanntes Datum wird nicht durch „unbekannt“ überschrieben (`operation-gates.ts:62-66`).
**Reproduktion (SIMULATED):** `docs/ai-dev/evidence/technical-audit/local-refusal.test.ts.txt`: FakeSpotify antwortet auf `PUT /me/player/play` mit 429 + `Retry-After: 600`. Ergebnis: `plays:1` (zweiter Startversuch nach 5 s sendet nur `GET /v1/me/player`, kein PUT), beide Ergebnisse identisch `{"code":"rate","message":"Spotify bremst gerade — gleich noch einmal versuchen."}`; `pause` funktioniert weiterhin (`ok:true`, korrekt pro Operation); `warnings: []`.
**Risiko:** Nutzer tippt wiederholt „gleich nochmal“, obwohl die App selbst bis zu 10 min nichts sendet; Support/Diagnose kann lokale Verweigerung und Spotify-Antwort nicht trennen.
**Vorschlag:** `PlayResult.error` um `source: "spotify" | "local_hold"` und `retryAt: number | null` erweitern; Text für lokale Sperre: „true-shuffle wartet noch bis HH:MM (Spotify hatte gebremst)“ bzw. „Freigabezeit unbekannt“. Testbedarf: Unit-Test wie oben mit Assertion auf unterschiedliche Texte/Quellen; Retry-After als HTTP-Datum; `until: null`.

### F-04 (P2) Explizite Befehle warten hinter Hintergrundarbeit derselben Durable Object-Instanz
**Bereich:** Priorität Nutzereingabe, DO-Serialisierung.
**Mechanik (SOURCE):** `UserHub.exclusive()` (`src/worker/userhub.ts:95-121`) reiht **jede** RPC (inkl. `state()` mit Live-Sync, `play`, `playerAction`) und `alarm()` (`userhub.ts:573-590`) in eine einzige Promise-Kette. Ein Alarm-Lauf darf bis zu `BUDGET_PER_INVOCATION = 40` Spotify-Anfragen (`hub.ts:209`) mit je bis zu 15 s Timeout (`client.ts:212`) seriell ausführen (`runJobs`, Importe/Deck-Schreiben). Die in `0a05d4f` eingeführte „Priorisierung“ betrifft nur, dass `resumeSession` keine automatische Reparatur vorschaltet (`hub.ts:4880-4888`); eine Vorrangregel gegenüber einem bereits laufenden Alarm gibt es nicht. `Hub.commandTail` ordnet nur Befehle untereinander. Hub-Unit-Tests rufen `h.hub` direkt auf und modellieren `exclusive` nicht (Harness `test/hub/harness.ts`), FakeSpotify antwortet sofort.
**Folge:** Ein Klick kann im schlechtesten Fall Minuten hinter Import-/Deck-Jobs warten; nach 30 s läuft das Client-Timeout ab (`api.ts:185-198`, `ApiError(0,"timeout")` → `unconfirmed`), während der Befehl weiterhin in der Kette steht und **später** ausgeführt wird. Ein „Erneut versuchen“ in dieser Zeit reiht einen zweiten Start ein.
**Evidenz:** SOURCE; Wartezeit nicht gemessen (NOT_RUN live/DO).
**Vorschlag:** Alarm-Arbeit in kurze Scheiben teilen (z. B. max. 3–5 Requests pro `exclusive`-Abschnitt, danach `setAlarm(now)`), oder Befehls-RPCs über eine eigene Vorrangwarteschlange, die zwischen Job-Schritten bedient wird; Befehl mit Ablaufzeit (`notAfter`) versehen, damit ein nach Client-Timeout verspäteter Befehl verworfen statt ausgeführt wird. Testbedarf: UserHub-Test mit langsamer Fake-Fetch-Funktion (Job hängt 20 s) + paralleler `play` – Latenz und Reihenfolge prüfen.

### F-05 (P3) Warteschlangen-Vorschau: Vertrag 51/50 bestätigt, mit Randfällen
**Mechanik (SOURCE):** `sessionView(stationId?, limit = 51)` (`hub.ts:4739-4747`) liefert aktuellen Eintrag + 50 Nachfolger; `home.tsx:592-598` zeigt `queue.slice(index(view.entryId)+1).slice(0,50)`. Randfälle: (a) während der Projektion (`view.entryId` = Nachfolger) beginnt die Liste einen Eintrag später → 49 Zeilen; (b) findet der Client `view.entryId` nicht (`findIndex = -1`), beginnt die Liste bei 0 und zeigt den aktuellen Song als „Als Nächstes“ Nr. 1; (c) `sessionView` verwirft Einträge ohne Track-Metadaten (`flatMap`, `hub.ts:4752-4757`) → weniger als 50, Nummerierung verschiebt sich gegenüber der realen Kontextposition. **Caveat:** Die App liest `GET /me/player/queue` nicht (kein Treffer in `src/worker`); manuell in Spotify hinzugefügte Songs („Zur Warteschlange“), Autoplay nach Kontextende oder Wiederholung (`repeat` wird nur beim Start auf `off` gesetzt, `hub.ts:4964-4966`; spätere Änderung am Handy wird nur über `orderBroken`/`shuffle` erkannt, nicht über `repeat_state`) sind nicht abgebildet. Die Liste ist „gespeicherte Reihenfolge“, nicht die tatsächliche Spotify-Warteschlange – das Label `Gespeicherte Reihenfolge` ist korrekt, die Projektion (`playback-view.ts:86-112`) berücksichtigt `repeat`/externe Queue aber nicht.
**Evidenz:** SOURCE. **Vorschlag:** Projektion zusätzlich bei `repeat_state !== "off"` unterdrücken (Feld ist im Snapshot vorhanden, `hub.ts:2624`); Testbedarf: `playbackView`-Unit-Test mit Repeat und mit fehlendem `entryId`.

### F-06 (P3) Ein angenommener, aber nicht ausgeführter Skip wird durch das natürliche Songende „bestätigt“
**Mechanik (SOURCE):** `performPlayerAction("next")` journalt `pending.kind="next"` (`hub.ts:5288-5302`); `checkpoint()` löscht es, sobald irgendein späterer Index beobachtet wird (`hub.ts:4798-4812`). Ohne Ablaufzeit blockiert es bis dahin weitere Skips („noch nicht bestätigt“, `hub.ts:5228-5231`) und alle normalen Checkpoint-Updates (`hub.ts:4814-4822`, früher `return`).
**Reproduktion (SIMULATED):** `docs/ai-dev/evidence/technical-audit/lost-next.test.ts.txt` (FakeSpotify ignoriert `POST /me/player/next`, antwortet 204): `r1 ok`, nach 1 s `pending:"next"`, nach 10 min Wiedergabe `pending:null, idx 0→2` – das Songende wurde als Skip-Bestätigung gewertet. Ist die Wiedergabe in diesem Moment pausiert, bleibt `pending` bis zum nächsten Start bestehen.
**Risiko:** Gering; Skip-Erkennung/Statistik könnte einen nicht erfolgten Skip als erfolgt behandeln (nicht weiter verfolgt). **Vorschlag:** Bestätigung nur, wenn die Beobachtung innerhalb eines Fensters nach `startedAt` liegt und `progressMs` klein ist; `pending.next` nach z. B. 30 s ohne passende Beobachtung als „unbekannt“ freigeben. Testbedarf: wie Repro, mit Assertion.

### F-07 (P3) Geräte-IDs: explizite Auswahl unbegrenzt gültig, automatische Auswahl begrenzt
**Mechanik (SOURCE):** Client speichert die explizite Auswahl dauerhaft in `localStorage["ts-device"]` (`home.tsx:109-120`) und sendet sie ohne Alter bei jedem Start (`home.tsx:206-216`). Hub `pickDevice()` (`hub.ts:5118-5163`): explizit gewünschte ID wird ungeprüft verwendet und **nicht** umgeleitet (korrekt); bei `no_device` wird geworfen (`hub.ts:4980-4986`). Automatisch: frisch beobachtetes Gerät aus dem Pre-Sync, sonst Gerätecache ≤ 60 s (`hub.ts:5141-5144`), bei 429 auf `GET /me/player/devices` das Snapshot-Gerät ≤ 60 s; nach `no_device`/`restricted` wird der Cache gelöscht (`hub.ts:5039-5040`); `devices()` cached leere Listen nur 5 s (`hub.ts:5166-5170`). Ein temporär nicht gelistetes, pausiertes iPhone: automatisch → eine Neuermittlung, dann `no_device` mit Text „Kein Spotify-Gerät aktiv. Öffne Spotify …“; explizit gewählt → Spotify-404 → derselbe Text, obwohl der Nutzer ein *bestimmtes* Gerät gewählt hat (Hinweis `missingDevice` existiert nur, wenn die Geräteliste geladen wurde).
**Beobachtung aus F-01-Repro:** bei `devices=[]` sendete der Hub dennoch `PUT shuffle/repeat/play` an das zuletzt beobachtete Gerät (`known`), bevor `no_device` kam – erwartbar, aber zeigt, dass „abgelehnt“ Schreibversuche einschließt.
**Evidenz:** SOURCE + SIMULATED; echtes iPhone-Verhalten (Wake-up per Web-API-Play bei inaktivem iOS-Client) NOT_RUN. **Vorschlag:** Fehlertext bei explizitem Gerät: „‚<Name>‘ ist gerade nicht erreichbar – öffne Spotify dort oder wähle automatisch.“; Testbedarf: Hub-Test explizite ID + 404.

### F-08 (P2) Keine Unit-Tests für die Client-Befehlslogik (`store.ts`) und `playback-view.ts`
**Mechanik (SOURCE):** `grep -rln "client/store\|playback-view" test e2e` findet nur meine Audit-Tests; `test/core/song-progress.test.ts.txt` deckt `src/client/progress.ts` ab. `reconcileCommand`, `refresh`-Folgeabfragen, Epoch-Verwerfung und die Projektion sind nur über Playwright-e2e abgedeckt (die Regression F-01 wurde dort sichtbar, aber nicht ursächlich lokalisiert). Vitest läuft in `environment: "node"`; mein Repro zeigt, dass Store-Tests mit zwei globalen Stubs (`window`, `document`) und `vi.mock("../../src/client/api")` ohne DOM-Bibliothek möglich sind.
**Vorschlag:** Store-Testsuite (failed/accepted/unconfirmed × gleiche/andere Station × veraltete Polls × Offline × Profilwechsel) und `playbackView`-Tabellentests (Pause, Seek zurück, Songende +0/+30/+31 s, Repeat, extern, `pending`).

### Bestätigte Eigenschaften (keine Befunde)
- **Kein simulierter Fortschritt wird gespeichert (SOURCE):** `estimatedProgress` (`src/client/progress.ts`) und `playbackView` (`playback-view.ts:17`) sind reine Anzeige; `act()` sendet keine Position (Start nutzt `session.progressMs` im Hub). Alle Schreibstellen von `session.progressMs` im Hub (`hub.ts:2465, 4475, 4729, 4811, 4848`) stammen aus Provider-/Native-Beobachtungen bzw. aus dem expliziten Native-„Weiter“ (`progressMs = 0`). Die serverseitige Extrapolation `nowPlaying.progressMs` (`hub.ts:5792-5796`) wird nur ausgeliefert, nicht gespeichert.
- **Song-Uhr:** zählt nur bei `status === "active"`, eigener Wiedergabe, ohne `pending`, nicht `stale`, Alter ≤ 120 s; Projektion auf genau einen Nachfolger für max. 30 s nach Songende, danach `awaitingObservation` (`playback-view.ts:52-112`). Pause → kein Fortschritt; Seek zurück → „neueste Beobachtung gewinnt“ (`hub.ts:4847`); Client verwirft nur Zustände mit älterem `observedAt` derselben Session (`store.ts:298-309`).
- **Doppelklick / veraltete Polls:** `beginCommand` setzt den Befehl synchron und blockiert weitere (`store.ts:84-109`); jede Annahme/Ablehnung erhöht `epoch`, ältere In-flight-Antworten werden verworfen (`store.ts:115-116, 296`). Pause/Weiter senden `sessionId`/`entryId`; der Hub lehnt veraltete Ansichten ab (`hub.ts:5222-5226`, erneut nach Beobachtung `hub.ts:5274-5278`).
- **Unbekannter Ausgang:** Netzwerk-/5xx-Fehler nach Transportversuch → `uncertain` → Client `unconfirmed` (`hub.ts:5068-5080`, `home.tsx:223-232`), Hub plant eine Beobachtung.
- **429 pro Konto und Operation**, kein globaler Block (siehe F-03, positiv).
- **Mehrere Tabs:** Lesepacing ist am letzten erfolgreichen `GET /me/player` verankert (`observation-policy.ts:38-49`, `hub.ts:5603-5640`), mehrere Tabs multiplizieren die Spotify-Reads nicht; Fokus/Sichtbarkeit nutzt ein gemeinsames 5-s-Fenster.
- **Hintergrund:** Client pollt nur sichtbar (`store.ts:351-366`); Hub-Alarme pacen pausiert 30 s → 30 min (`observation-policy.ts:9-15`), aktive Eigenwiedergabe auf Songende ausgerichtet, fremder Kontext 10 min; Gast-/Privat-/Guard-Fristen früher (`hub.ts:6057-6120`).
- **Max. fünf Konten:** im Code **nicht** erzwungen; Zugang hängt an optionalem `ALLOWED_SPOTIFY_IDS` (leer = alle, `src/worker/index.ts:58-65`) bzw. am Spotify-Developer-Mode-Allowlisting. Kein Befund am Code, aber eine Betriebsannahme (P3-Hinweis).

## Vergleich aktueller Stand vs. vorheriger Stand
- `src/` ist zwischen `30ae6a2` und `b5a1856` unverändert (`git diff --stat 30ae6a2 b5a1856 -- src e2e test` leer); `9e60ebf`/`b5a1856` ändern nur Dokumentation. Alle Befunde gelten daher identisch für `30ae6a2`.
- `1328f8f` (Tracker): nur Job-Freigabe nach stillgelegten lokalen Guards (`hub.ts` +8). Die Pro-Operation-Sperren (F-03 positiv) bestehen seit diesem Stand.
- `0a05d4f` (Song-Uhr): lokale Fortschrittsanzeige, Start ohne vorgeschaltete Reparatur. Fehler wurden als 7-s-Flash (`store.say`) gezeigt – der e2e-Test „says clearly when Spotify refuses“ konnte dort bestehen, obwohl der Hub die Station bereits wechselte (Hub-Verhalten seit `23111bd`).
- `f5c8e0f` (Optimierung): Befehlszustand im Store (`PlaybackCommand`, `reconcileCommand`), `playback-view.ts`, `observation-policy.ts`, 1-s-Beobachtung nach Befehl. **Hier entstand F-01** (Löschregel `failed && entryId !==`, `git log -S` → `f5c8e0f`) und das Einzelbeobachtungsmuster aus F-02.
- `30ae6a2`: Befehlslesungen laufen über Routenwechsel weiter (`running`-Flag); keine Auswirkung auf F-01/F-02.

## Eigene Verbesserungsvorschläge (nicht implementiert)
1. **Abgelehnter Start ist zustandsneutral** (F-01): `active_session_station` und neu erzeugte Sessions erst nach Transporterfolg/-unklarheit festschreiben; Test: Hub + Store + bestehender e2e.
2. **Failed-Notice an Zeit/Station binden** statt an `entryId` (F-01b).
3. **Begrenzte Bestätigungsfolge** nach Befehlen (F-02) und FakeSpotify-Lag-Modus, damit Latenzmessungen nicht systematisch optimistisch sind.
4. **Fehlerquelle im `PlayResult`** (`spotify` vs. `local_hold`, `retryAt`) und ehrliche Wartetexte (F-03).
5. **Befehlsvorrang im DO** durch kurze Alarm-Scheiben und Ablaufzeit für Befehle (F-04); Test mit hängender Fake-Fetch-Funktion über `UserHub`.
6. **Projektion bei `repeat_state !== "off"` unterdrücken**, Queue-Randfälle testen (F-05).
7. **`pending.next` mit Zeitfenster** (F-06).
8. **Client-Unit-Tests** für `store.ts` und `playback-view.ts` (F-08).

## Risiken
- F-01 ist nutzer-sichtbar und trifft genau die Fälle, in denen Erklärung am wichtigsten ist (kein Premium, kein Gerät); zusätzlich verliert der Nutzer die sichtbar gehaltene Station.
- F-02/F-04 können zu Doppelbefehlen und Rücksprüngen führen; Ausmaß hängt von realer Spotify-Latenz bzw. Job-Last ab (nicht gemessen).
- Alle SIMULATED-Ergebnisse beruhen auf FakeSpotify, das Schreibvorgänge sofort und deterministisch abbildet; Abweichungen des echten Spotify (Propagationszeit, iOS-Client-Wake-up, 404 vs. 202, Autoplay) sind nicht abgedeckt.

## Offene Live-Grenzen (NOT_RUN)
- Physisches iPhone (pausiert, nicht gelistet, Hintergrund, Wake-up): NOT_RUN.
- Live-Spotify-API (Premium/Free, 429/Retry-After real, Propagationslatenz, `/me/player/queue`): NOT_RUN.
- Home Assistant / Music Assistant (native Controller): NOT_RUN.
- Restore mit befüllter Produktionsdatenbank (populated restore): NOT_RUN.
- Live-Latenz Klick → Bestätigung (Browser ↔ Worker ↔ DO ↔ Spotify): NOT_RUN.
- Playwright-e2e (inkl. des fehlschlagenden Tests) und `wrangler dev`: von mir NOT_RUN (Vorgabe); typecheck/lint/Gesamt-vitest von mir nicht wiederholt (Hauptsession-Ergebnis übernommen, nicht verifiziert).

## Hinweise für die UI (Felder, die kein Hörbeweis sind)
- `PlaybackView.position`, `estimating`, `projected` und die projizierte Track-/`entryId` (`playback-view.ts`) sind lokale Schätzungen – nie als „gehört“, Skip, Checkpoint oder Bewertungsziel verwenden (Code hält das ein: Thumb/Weiter sind bei `projected` gesperrt).
- `nowPlaying.progressMs` ist serverseitig extrapoliert (`snap.obs.progressMs + elapsed`); `nowPlaying.observedAt` ist der Zeitpunkt der letzten Beobachtung, nicht des angezeigten Fortschritts.
- `session.status === "active"` stammt aus der letzten Beobachtung **oder** aus dem 2xx eines Befehls (`hub.ts:5025-5027`, Pause: `hub.ts:5253-5256`) – also Befehlsannahme, keine bestätigte Wiedergabe.
- `PlayResult.ok/acceptedAt` heißt „Spotify hat den Befehl angenommen“, nicht „spielt“. Native-Ergebnisse (`api.ts:131-160`) liefern kein `acceptedAt`.
- `session.queue` ist die gespeicherte Reihenfolge, nicht die tatsächliche Spotify-Warteschlange (F-05).
- Ein `failed`-Befehl bedeutet „nicht gestartet“, nicht „nichts geändert“ (Schreibzugriffe vor dem Abbruch möglich, F-01/F-07).
- Fehlertexte „Spotify bremst gerade …“ können aus einer lokalen Sperre stammen (F-03).


## Nachtrag der Hauptsitzung (unabhängige Gegenprüfung, 2026-10-01)
- Die sieben Reproduktionstests (Kopien unter `docs/ai-dev/evidence/technical-audit/*.test.ts.txt`; zum Ausführen nach `test/audit/` kopieren und `.txt` entfernen) liefen in der Hauptsitzung erneut: 5 Dateien / 7 Tests PASS.
- `hub.ts:4914-4916` (`kvSet("active_session_station", …)` vor Provider-Arbeit) und die Einführung der `entryId`-Regel in `store.ts` durch `f5c8e0f` wurden direkt im Quelltext bzw. per `git log -S` bestätigt.
- e2e-Bezug zu F-01: Der Playwright-Test „says clearly when Spotify refuses: no Premium, no device“ scheitert auf `b5a1856` lokal 4/4 und im CI von PR #10 (Lauf 36845755393); auf dem Redesign-Branch intermittierend (CI-Lauf 36864901558 rot, finaler lokaler Lauf grün).
- Der Audit-Bericht ist rein lesend; keiner der Vorschläge ist im Redesign-PR umgesetzt.
