# Akzeptanz- und Testmatrix

## Gate-Regel

Ein Gate ist nur `PASS`, wenn alle Pflichtszenarien bestanden und belegt sind. Mögliche Zustände:

- `PASS`
- `FAIL`
- `BLOCKED` mit exakter externer Voraussetzung
- `N/A` nur mit fachlicher Begründung

`BLOCKED` ist kein Release-PASS.

## G0 – Baseline

| ID | Prüfung | Evidenz |
|---|---|---|
| BASE-01 | exakter Basis-Commit bestätigt | `git rev-parse HEAD` |
| BASE-02 | bestehende Tests unverändert grün | Testlog |
| BASE-03 | Ruff/Lint grün | Lintlog |
| BASE-04 | DB-Schema und Migrationsweg inventarisiert | Schema-/Migrationsnotiz |
| BASE-05 | aktuelle Spotify-Dokumente und Policy geprüft | datierte Quellenliste |
| BASE-06 | aktuelle Mika-Library-Revision geprüft | Source Manifest |

## G1/G2 – UX

| ID | Prüfung | Evidenz |
|---|---|---|
| UX-01 | drei unterscheidbare Single-Source-Konzepte | Konzeptartefakte |
| UX-02 | intern exakter Herkunftsnachweis; öffentlich freigegebener Quellalias und Transferregeln | Source Manifest ohne private Library-Metadaten |
| UX-03 | unabhängiger Fidelity-Review | Reviewprotokoll |
| UX-04 | alle Pflichtscreens Mobile/Desktop | Screenshot-/Route-Index |
| UX-05 | kritische Flows browserautomatisiert | E2E-Log/Video/Screens |
| UX-06 | Tastatur, Focus, Kontrast, Reduced Motion | Accessibility-Bericht |
| UX-07 | Run-Status und Spotify-Status klar getrennt | UX-Review + Nutzertestheuristik |
| UX-08 | lange Namen, fehlende Cover, leere/Fehlerzustände | Screenshotmatrix |

## G3 – Spotify-Fehler und Strategie

| ID | Prüfung | Erwartung |
|---|---|---|
| SP-001 | Start mit 6 Tracks | keine ungewollte Wiederholung von Track 1 als Track 6 |
| SP-002 | Start mit 20 Tracks | erwartete Reihenfolge/Strategie und kein blindes mehrfaches Prefetch |
| SP-003 | zehn native Skips | keine Queue-Vervielfachung; jedes reale Ereignis einmal im Ledger |
| SP-004 | wiederholter Watcher-Tick | idempotent, keine zusätzlichen Queue-Einträge |
| SP-005 | Retry nach Timeout | kein doppelter fachlicher Advance |
| SP-006 | Prozessneustart | Run und Providerzustand werden sicher reconciled |
| SP-007 | zwei Strategiekandidaten | Vergleich mit Messung und ADR |
| SP-008 | Queue-Duplikat-Regressionstest | vor Fix rot, nach Fix grün |

## G4 – Spotify-Use-Cases

Die IDs `UC-01` bis `UC-30` entsprechen `03A_CANONICAL_USE_CASES.md`. Jede Zeile muss in der Ergebnis-Matrix enthalten:

- automatisierter Test,
- erforderlicher Live-Test,
- Status,
- Evidenz,
- bekannte Einschränkung.

Zusätzliche Pflichtszenarien:

| ID | Prüfung | Erwartung |
|---|---|---|
| RUN-01 | zwei Runs derselben Playlist | vollständig isolierte Fortschritte |
| RUN-02 | Run über Neustart fortsetzen | keine verlorenen/offen doppelt verbuchten Tracks |
| RUN-03 | No-Repeat bis Abschluss | jeder berücksichtigte Track exakt einmal |
| RUN-04 | Mindestabstand exakt an Grenze | kein zu früher Repeat |
| RUN-05 | unmögliche Regelkombination | vor Start erklärt oder dokumentiert aufgelöst |
| RUN-06 | Skip-Policy je vier Varianten | korrekte offene/gespielte Reihenfolge |
| RUN-07 | Favoritengewichtung | statistisch/property-basiert korrekt, Mindestabstand bleibt hart |
| RUN-08 | Ausschließen/Reaktivieren | sofortige, run-spezifische Wirkung |
| RUN-09 | Playlist-Sync | Add/Remove mit erhaltbarem Fortschritt und Nutzerentscheidung |
| RUN-10 | neue Tracks im laufenden Run | alle drei Aufnahmeoptionen |
| RUN-11 | Config duplizieren/übertragen | unabhängige Identität und sichere trackbezogene Regeln |
| RUN-12 | Löschen | nur Ziel-Run, Spotify-Playlist unverändert |

## Manuelle Spotify-Nutzung

| ID | Aktion | Automatisch fortsetzen | Automatisch pausieren | Nachfragen |
|---|---|---|---|---|
| MAN-01 | anderen Song starten | nach manueller Sequenz regelkonform weiter | Run pausiert | Entscheidung erscheint |
| MAN-02 | anderes Album/Playlist starten | definierte Wiederkehr ohne Ledger-Schaden | Run pausiert | Entscheidung erscheint |
| MAN-03 | einen Queue-Titel hinzufügen | manuelle Queue respektiert | Run pausiert nach Erkennung | Entscheidung erscheint |
| MAN-04 | mehrere Queue-Titel hinzufügen | alle manuellen Titel respektiert | Run pausiert nach Erkennung | Entscheidung erscheint |
| MAN-05 | Gerät wechseln | kontrollierte Fortsetzung | Run sicher pausiert | Entscheidung erscheint |

Die genaue Interpretation von „nach der manuellen Queue“ muss aus real beobachtbarer Spotify-Semantik abgeleitet und in der UX erklärt werden.

## Fehler- und Recovery-Matrix

| ID | Zustand | Erwartung |
|---|---|---|
| ERR-01 | kein aktives Gerät | keine stille Endlosschleife; klare Geräteaktion |
| ERR-02 | Premium fehlt | verständliche Blockade, Run bleibt erhalten |
| ERR-03 | 401/Tokenrefresh | höchstens kontrollierter Retry |
| ERR-04 | 429 | `Retry-After` respektieren, keine Doppelcommands |
| ERR-05 | 5xx/Timeout | Backoff und idempotente Recovery |
| ERR-06 | Track unverfügbar | regelkonforme Skip-/Fehlerpolicy |
| ERR-07 | Spotify-Disconnect | Tokens/Daten sicher behandeln, Runs gemäß Produktentscheidung |
| ERR-08 | DB-/Prozessrestart | keine halb angewandte Run-Transition |

## Nichtfunktionale Abnahme

- Property Tests für No-Repeat, Mindestabstand, Gewichtungen und Regelkonflikte
- Migrationstest mit Kopie einer bestehenden DB
- Concurrency-/Lock-Test für parallele Requests und Watcher
- Paginationstest für große Playlists
- Browsermatrix mindestens Chromium plus ein zweiter relevanter Browser
- Mobile Viewports
- Security-Review für OAuth, Tokenverschlüsselung, CSRF/State, Logs und Datenlöschung
- Performanceprofil für 10.000 Tracks
- keine Produktclaims ohne Live-/Policy-Evidenz

## Live-Testbericht

Muss enthalten:

- Datum, App-Version, Commit,
- Testkonto-Klasse ohne Identifikator,
- Gerät/Client/OS,
- Spotify-App-Einstellungen wie Shuffle/Repeat,
- Ausgangszustand,
- Commands und beobachtete Zustände mit Korrelations-IDs,
- redigierte Queue-Snapshots,
- PASS/FAIL/BLOCKED,
- bekannte Nichtdeterminismen,
- keine Tokens oder unnötigen personenbezogenen Daten.
