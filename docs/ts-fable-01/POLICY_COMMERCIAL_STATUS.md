# Policy-/Kommerz-Status — TS-FABLE-01 (Phase 4, §B6)

Stand: 2026-08-01 · Quellenbasis: Phase-0-Re-Audit (BASE-05, developer.spotify.com,
Freshness am 01.08. erneut geprüft: unverändert; Policy-Datum 15.05.2025).
**Dieses Dokument enthält bewusst KEINE Compliance-Zusicherung** — es
inventarisiert Pflichten, Umsetzungsstand und offene Prüfungen.

## Einstufung

Fernsteuerung der Spotify-Wiedergabe ⇒ True Shuffle ist eine **Streaming
SDA** (Policy IV.2): **kommerzielle Nutzung ohne Sondervereinbarung mit
Spotify nicht gestattet**. Jeder Launch-/Pricing-Claim bleibt bis zu einer
juristischen/vertraglichen Prüfung gesperrt (Release-Gate, GATE_STATUS
§Blocker). Development-Mode-Grenzen: Owner braucht Premium, max. 5 Nutzer
je App; 25 Client-IDs, Quota pro Developer-Account (Juli 2026).

## Pflichten-Inventar und Umsetzungsstand

| Pflicht (Quelle) | Stand im Produkt | Evidenz |
|---|---|---|
| Disconnect-Mechanismus + Löschung binnen 5 Tagen (Terms V.8, App. A.5.c) | Umgesetzt: dreistufiger Löschpfad mit nachweisbarer Frist (`deletion_requests`-Ledger), Export-Karenz, Voll-Löschschalter | `app/retention.py`, `tests/test_retention.py` (ERR-07); ADR-003 F10 |
| Player-UI zeigt Cover/Metadaten des laufenden Inhalts (Policy II.5) | Umgesetzt in der Nachtpult-Player-UI | G2-Abnahme; Browser-Suite; Live-Sichtprüfung BLOCKED |
| Attribution mit Spotify-Marks (II.4) | Umgesetzt (Provider-Attribution in der UI); finale Marken-Sichtprüfung live | G2-Restnotiz: „Spotify-Attribution live erst mit Credentials prüfbar" |
| Kein künstliches Play-Count-Inflating (II.2) | Architektur bildet nur echtes Nutzerhören ab: Advance folgt beobachteter Wiedergabe (Watcher), nie Timer-getrieben | ADR-002-Kommando-Disziplin; `core/engine.py::reconcile` |
| Kein Mixen/Überlagern mit fremdem Audio (III.7) | Produkt spielt nie selbst Ton („spielt nie selbst Ton ab" ist gepinnter UI-Claim) | `test_every_page_states_that_the_audio_is_never_ours` |
| Datenminimierung (V.3) | Logs ohne Tokens/Kontonamen/Gerätenamen (Command-Log-Vertrag); Beobachtungen löschbar | `app/runs.py` `_command_log`-Docstring; retention Stufe 1 |
| Keine abgeleiteten Listenership-Metriken/Profile (III.13) | Nur run-lokale Fortschritts-/Wiederholungszähler für den Nutzer selbst; keine Aggregation über Nutzer | Schema v3; UC-22 |
| Kein AI/ML-Training auf Spotify-Content (III.14) | Nicht vorhanden | — |
| Playlist-Lesen nur eigene/kollaborative (Feb-2026-Guide) | Umgesetzt inkl. ehrlicher Anzeige unlesbarer Playlists | UC-02-Tests |
| 429/`QUOTA_EXCEEDED` respektieren (Juli 2026) | Retry-After-Behandlung in HTTP-Schicht + Watcher-Backoff | ADR-002 Auflage 5; ERR-Zeilen in Phase 4 |

## Offen / gesperrt

1. **Kommerzielle Zulässigkeit:** BLOCKED bis Sondervereinbarung/juristische
   Prüfung. Kein Claim im Produkt, keine Preiskommunikation.
2. **Live-Sichtprüfungen** (Cover/Attribution am realen Gerät): BLOCKED mit
   dem übrigen Live-Gate (LT-Guide).
3. **Extended Quota / App-Review:** nicht beantragt; Development Mode ist
   für den PoC-Betrieb (≤ 5 Nutzer) ausreichend und ehrlich zu kommunizieren.
