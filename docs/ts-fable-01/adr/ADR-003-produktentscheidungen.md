# ADR-003 — Die zehn offenen Produktfragen (09_RISKS_AND_OPEN_QUESTIONS)

Status: Entschieden (Lead), 2026-07-31 · Grundlage: unabhängige Domänenmodell-Analyse (Opus-Lauf, Model Ledger #3), vom Lead geprüft und entschieden. Alle Entscheidungen sind bewusst reversibel angelegt (additive Enum-Werte, Config-Spalten, nachrüstbare Tabellen — nie irreversibler Datenverlust).

| # | Frage | Entscheidung | Kern-Begründung / Reversibilität |
|---|---|---|---|
| F1 | Stop vs. Pause vs. Cancel | **Drei getrennte Zustände.** `paused` = kurze Unterbrechung (Watcher registriert, Gerät bleibt). `stopped` = bewusstes Sitzungsende (Watcher ab, Gerät geleert, `stopped_at`, voll fortsetzbar, erscheint unter „Fortsetzen"). `cancelled` = endgültig (Historie bleibt). Löschen (UC-26) davon getrennt: Soft-Archiv → bestätigte Löschung. | Deckt UC-12/13/14/26 ohne Doppeldeutung; additiver Enum-Wert. |
| F2 | Historie nach Reset | **Behalten, in Durchläufen (Zyklen).** Reset = `cycle+1`, alle Titel wieder offen, `play_count` kumulativ, Ledger unangetastet; UI zeigt „Durchlauf 2". | Gelöschte Historie ist unwiederbringlich; „Verlauf löschen" bleibt nachrüstbar. |
| F3 | Identische Titel mehrfach in der Playlist | **Default `collapse`** (eine Karte je Titel — heutiges Produktversprechen), **Option `keep_entries`**; jeder Playlist-Eintrag wird mit stabiler Eintrags-Identität persistiert (Titel-ID + n-tes Vorkommen), sodass die Policy ohne Re-Import umschaltbar ist. | Track-Identitäts-Invariante wird Datenaussage statt Implementierungsdetail. |
| F4 | Wann gilt „gespielt" | **Trackende oder ≥30 s gehörte Zeit — was zuerst eintritt** (konfigurierbar: `on_start` / `on_min_seconds(30)` / `on_track_end`). Nutzer-Skip zählt gemäß Skip-Policy, nie doppelt. | 30 s ist die erklärbare Branchenkonvention und schützt gegen verpasste Trackenden. |
| F5 | Skip bei frühem/spätem Watcher-Signal | **Das Ledger entscheidet, nicht der Timer:** jede Transition trägt einen deterministischen Ereignis-Schlüssel (`run:planversion:seq:from:to`); Duplikate scheitern an `UNIQUE`, verspätete Signale auf konsumierte Positionen werden als `stale` protokolliert, nie angewendet. | Macht SP-004/005 neustartfest (ersetzt das prozesslokale Lock nicht, ergänzt es). |
| F6 | Mindestabstand unerfüllbar | **Dokumentierte Relaxationsleiter:** Nutzer-Ausschlüsse hart; `min_gap` wird auf das größtmögliche `k = Kandidaten−1` gesenkt, protokolliert (`rule_relaxed`) und dem Nutzer einmal je Lauf erklärt („Bei 8 Titeln sind höchstens 7 Abstand möglich"). Vor Start: Pre-Flight-Fehler mit Korrekturvorschlag (RUN-05). | Nie stiller Regelverstoß — Invariante „Regelauflösung". |
| F7 | Trackbezogene Favoriten beim Config-Transfer | **Configs sind playlistneutral; Favoriten/Ausschlüsse sind run-gebunden** und wandern nicht automatisch mit. Ein späterer expliziter Schritt „Favoriten mitnehmen" (Matching über Werk-Identität/ISRC, dann Name+Artist+Dauer) bleibt namentlich reserviert, wird in v3.0 nicht gebaut. | Per Konstruktion übertragbar (UC-29) ohne stilles Fehlmatching. |
| F8 | Wartezeit bei „automatisch fortsetzen" | **Beobachten statt kämpfen, mit harter Obergrenze:** Zustandsautomat je Run (`manual_detected` → Commands stoppen, nur beobachten). Fortsetzen wenn Provider idle wird oder zur Plan-Wiedergabe zurückkehrt; nach `manual_wait_seconds` (Default 900 s) durchgehender Fremdwiedergabe → kontrolliert `suspended`. `ask`-Policy setzt `awaiting_decision` (Zustand C der UX). | Die API signalisiert das Ende einer manuellen Queue nicht — begrenztes Beobachten ist die ehrliche Lösung; Ledger bleibt unbeschädigt. |
| F9 | Sichtbarer Ausführungskontext in Spotify | **Default nein** (uris-Fenster gemäß ADR-002 erzeugt keine sichtbaren Artefakte); **Kontext-Playlist als beschriftete Opt-in-Option je Run** (`true-shuffle · <Name>`) mit Cleanup-Pfad — zugleich die Großplaylist-Alternative aus ADR-002. | Beide Pfade koexistieren als Datenwert (`execution_strategy`) — exakt die Struktur, die SP-007 messbar hält. |
| F10 | Datenlöschung bei Disconnect | **Dreistufig:** (1) sofort: Tokens/Account-Zeile, Provider-Beobachtungen, Command-Payloads redigiert; (2) binnen **5 Tagen** (Frist aus Terms, nachweisbar über `deletion_requests`-Job): alle Provider-Inhalte (Snapshots, Playlists, Track-Metadaten); (3) behalten, **pseudonymisiert** (Nachtrag 2026-08-01, Security-Review SEC-05: der HMAC-Salt bleibt für den Reconnect-Weg in derselben Datenbank — mit DB-Zugriff sind die Referenzen rückrechenbar; „anonymisiert" wäre eine falsche Zusicherung): der abstrakte Hörfortschritt (Titel-Referenzen → lokale Opaque-Hashes), damit ein Reconnect fortsetzen kann. Volllöschung (`{"full": true}`) ist derzeit ein API-Schalter, kein UI-Element (SEC-20). Export vor Löschung wird angeboten. Ein Schalter für Volllöschung existiert, falls die Rechtsprüfung es verlangt. | Erfüllt die Policy-Frist prüfbar und erhält den Nutzerwert; jede Stufe einzeln testbar (ERR-07). |

## Nachträge 2026-08-02 (ADR-005)

**F4 — „gespielt" war nie implementiert.** `played_threshold` und
`played_threshold_seconds` standen im Schema (`run_configs`) und in `Rules`,
aber keine Codezeile las sie: gebucht wurde ausschließlich über die
Trackende-Klassifikation in `engine.reconcile`. Genau die 30-Sekunden-Regel,
die hier „schützt gegen verpasste Trackenden" begründet wurde, hätte den
gemeldeten Live-Fehler aufgefangen — sie fehlte.

Jetzt implementiert als `core.engine.is_played`, mit einer Präzisierung, die
den Zeilentext oben schärft: die Regel kennt **ausschließlich
`progress_ms`**, nie eine Uhr. „≥ 30 s gehörte Zeit" heißt beobachteter
Fortschritt im Titel, nicht verstrichene Zeit seit dem Start — Spotify-Policy
II.2 verbietet künstliche Abspielzahlen, und eine Karte, die sich nach 30
Sekunden Wanduhr selbst weiterschaltet, wäre genau das. `on_track_end` bleibt
der Default; die Wahl steht in der Regel-UI.

**F9 — der Default hat sich gedreht.** Die Kontext-Playlist war hier eine
Opt-in-Option je Lauf, weil das uris-Fenster „keine sichtbaren Artefakte"
erzeugt. Das stimmt — es spielt auf manchen Clients nur die erste URI. Seit
ADR-005 wird gemessen statt angenommen: bleibt das Fenster erhalten, ändert
sich nichts; geht es verloren, wechselt der Lauf selbsttätig auf die
Kontext-Playlist. Die Struktur bleibt exakt die hier gewählte — ein Datenwert
`execution_strategy` —, nur der Weg dorthin ist nicht mehr ein Schalter, den
der Nutzer finden muss.

## Konsequenz

Diese Entscheidungen sind die fachliche Spezifikation für Schema v3 und die Phase-3-Implementierung. Die zugehörigen technischen Verträge (Tabellen, Schlüsselkonstruktionen, Migrationsschritte M001–M010 mit Rollback je Schritt) folgen der unabhängigen Domänenanalyse; Abweichungen während der Implementierung werden hier nachgetragen.
