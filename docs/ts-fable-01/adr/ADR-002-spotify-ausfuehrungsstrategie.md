# ADR-002 — Spotify-Ausführungsstrategie: uris-Fenster statt additivem Queue-Prefetch

Status: Entschieden (Lead), 2026-07-31 · Gate G3 · Evidenzklasse VERIFIED_AUTOMATED (Simulator mit deklarierten Annahmen AN-1…AN-7, je einem Live-Testfall zugeordnet); Live-Bestätigung BLOCKED (kein Testkonto/Gerät — siehe LIVE_TEST_GUIDE.md).

## Problem (bewiesen)

Der bisherige Pfad (ein Titel per `PUT /play` mit einzelner URI, danach fünf additive `POST /queue`-Appends, bei jedem Advance erneut) vervielfacht die Spotify-Queue. Beweisführung:

- `VERIFIED_CODE`: `_apply` hängt bei **jedem** Advance erneut an — auch bei natürlichem Trackende; der Code liest die Queue nie (Phase-0-Audit).
- `VERIFIED_AUTOMATED`: strict-xfail-Regressionstests reproduzieren die Vervielfachung über den **echten** Pfad `watcher._playback_loop → engine.reconcile → runs.advance → _apply` gegen den Simulator (max. Duplikate 5, 35 Appends, hörbare Wiederholung, Deck stallt bei Cursor 5–6). Der Naturallauf-Beweis ist annahmenunabhängig; der Skip-Pfad-Beweis ist AN-1-bedingt und so gekennzeichnet.
- `OBSERVED_USER` + `INFERRED`: „Titel 6 = Titel 1" ist unter der Kontext-Replay-Policy (AN-2) mechanisch reproduzierbar (`context_replayed`-Event); Live-Beweis steht aus (LT-1).

## Entscheidung

**Standard-Ausführungsstrategie wird das uris-Fenster (S1):** True Shuffle setzt die Wiedergabe mit `PUT /me/player/play` und einem `uris`-Array der nächsten Titel plus `offset {"position": 0}`; innerhalb des Fensters wird **kein** weiterer Player-Command gesendet — native Skips und Trackenden laufen im gesetzten Kontext. Neue Commands nur bei: Start/Resume, Fenstergrenze, Drift-Rückkehr gemäß Policy, TS-initiiertem Sprung, Regeländerung. Die Fenstergröße ist `min(verbleibend, N_MAX)` mit konservativem, konfigurierbarem `N_MAX` (Default 250; das dokumentierte Body-Limit ist unbekannt — Live-Messung LT-13 vor Erhöhung). Ist `verbleibend ≤ N_MAX`, existiert bis zum Runde-Ende keine Fenstergrenze.

`POST /me/player/queue` wird von True Shuffle **nicht mehr verwendet**. Die Nutzer-Queue gehört dem Nutzer.

## Warum (Messlage, adversarial verifiziert)

Entscheidend ist die Kerninvariante „keine unkontrollierten Wiederholungen" plus manuelle-Nutzung-Verträglichkeit (UC-17/18):

| Kriterium (Szenarien a–h) | S1-Fenster | S3 Ein-Slot | S4 Kontext-Playlist | S2 kein Prefetch | S0 Status quo |
|---|---|---|---|---|---|
| Queue-Duplikate (max) | 0 | 1 | 0 | 0 | **5, Deck stallt** |
| Unkontrollierte Wiederholungen, wenn Nutzer einen Deck-Titel manuell queued (stop/replay) | **0 / 1** | 2 / 2 | 1 / 2 | 0¹ / 6¹ | gestallt |
| Echte Stille je Übergang (Poll 1s / 0,25s) | 0 im Fenster; ~1s/0,23s an Grenzen | ~1s/0,23s je Titel-Slot-Nachschub | 0 | **strukturell ~1s je Übergang** | Restarts statt Stille |
| 10 native Skips | 0–3 Commands | 1 play + 11 Appends | 1 play | 12 plays | stallt |
| Doppel-Tick / Neustart | idempotent | idempotent (aus Klassifikation, nicht aus Queue-Read — gepinnt) | idempotent | idempotent | verschärft (Dup 6) |
| Nebenwirkungen im Nutzerkonto | keine | irreversible Queue-Einträge | **sichtbare Run-Playlist, Schreibquota, Cleanup** | keine | Queue-Müll |

¹ S2 vermeidet Wiederholungen um den Preis von Abdeckungslöchern („nie gehört"-Titel).

**S3 (Ein-Slot) wird verworfen**, obwohl es in der Erstmessung führte: Die adversariale Verifikation zeigte, dass (a) seine Idempotenz aus der Ereignis-Klassifikation stammt und der Queue-Read in 47 Aufrufen genau 1 Write verhinderte, und (b) im vom Handoff benannten Risikofall („gleiche URI kann absichtlich vorkommen") die append-only-Queue **unwiderruflich** ist: einmal angehängte Titel lassen sich nie zurücknehmen (kein Remove/Clear in der API), der Ledger kann Doppelungen nicht mehr verhindern — 2 unkontrollierte Wiederholungen im Audio-Strom. S1/S4 besitzen dagegen einen **widerrufbaren** Kontext, der bei jeder Neubewertung aus dem Ledger neu materialisiert wird.

**S4 (Kontext-Playlist)** bleibt dokumentierte Alternative für sehr große Playlists (falls LT-13 ein niedriges uris-Limit ergibt) und ist im Handoff-Modus faktisch bereits produktiv (Copy-Playlist). Gegen S4 als Default sprechen Sichtbarkeit im Nutzerkonto, Schreibquoten, Cleanup-Pflicht und die live unverifizierte Sichtbarkeit von Mid-Play-Rewrites.

**S2 (kein Prefetch)** wird Quota-/Degraded-Notmodus: strukturelle ~1s-Lücke je Übergang (poll-dominiert), aber minimale Angriffsfläche.

**Kandidat D (Web Playback SDK)** wird ohne Bench qualitativ verworfen: Er widerspricht UC-17 (Spotify parallel auf eigenen Geräten nutzen; SDK bindet die Wiedergabe an unseren Browser-Kontext), dem Produktversprechen „nichts muss offenbleiben" (Tab-Lebenszyklus, Mobile-Background-Restriktionen) und eröffnet eine eigene Policy-/Support-Fläche. Er bleibt als späterer Zusatzmodus denkbar, nicht als Ausführungs-Default.

## Verbindliche Implementierungsauflagen (aus Verifikation und Messung)

1. **Geräteverlust konsumiert keine Karten:** Die Bench-Minimalvariante von S1 wertete Geräteverlust als „Karte verbraucht" und übersprang einen Titel — die Produktimplementierung MUSS `engine.reconcile`s Idle-Semantik nutzen (idle ≠ advance) und 404/`SimNoActiveDevice`-Äquivalente in Zustand D überführen. Pin-Test wird auf die echte Implementierung umgezogen.
2. **AN-2 beidseitig behandeln:** Nach Kontext-Erschöpfung sowohl `replay` (sofortiger Override mit nächstem Fenster beim `context_replayed`-Muster) als auch `stop` (Play des nächsten Fensters) korrekt fortsetzen.
3. **Manuell gespielte Deck-Titel** werden im Ledger als gespielt verbucht (Skip-Policy-abhängig ab Phase 3) und bei der nächsten Fenster-Materialisierung ausgelassen (das erzeugt die 0-Wiederholungen der Messung).
4. **Idempotenz:** Advance bleibt unter `advance_lock`; jeder Command trägt die bestehende Korrelations-ID; doppelte Ticks werden über die Klassifikation (`on_expected`) verworfen. Durables Command-/Event-Dedup folgt mit Schema v3 (Phase 3).
5. **429/`Retry-After`** respektieren (Backoff, keine Doppel-Commands); Polling bleibt der dominante Quota-Faktor — adaptives Polling (`_next_delay`) bleibt erhalten.
6. **Regressionstests:** Die beiden strict-xfail-Tests werden nach der Umstellung als reguläre Tests grün (SP-008 rot→grün); die Strategie-Pins aus `test_strategy_candidates.py` bleiben als Verhaltensvertrag.

## Rückfallpfad

`execution_strategy` wird konfigurierbar angelegt (Vorbereitung auf Schema v3): `uris_window` (Default) · `context_playlist` · `no_prefetch` (Notmodus). Ein Rollback auf den additiven Queue-Pfad ist ausgeschlossen (bewiesener Defekt); der alte Code bleibt nur in der Git-Historie.

## Offener Live-Nachweis (BLOCKED)

LT-1 (AN-2), LT-7 (AN-1), LT-10 (AN-5), LT-11 (AN-6), LT-12 (AN-7), LT-13 (uris-Limit) gemäß `LIVE_TEST_GUIDE.md`. Falsifikation von AN-1 würde die Schwere des Skip-Pfads im Altsystem mindern, ändert aber nichts an dieser Entscheidung (der Naturallauf-Beweis und die Irreversibilität der Queue bleiben).
