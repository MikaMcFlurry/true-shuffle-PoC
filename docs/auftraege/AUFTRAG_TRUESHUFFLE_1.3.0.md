# Auftrag: TrueShuffle 1.3.0 (nächstes Update) · v2

Stand: 02.11.2026 · Auftraggeber: Mika Hertler · Ausführung: Claude Code oder Codex in t3-code
Repo: `MikaMcFlurry/true-shuffle-PoC` · Live: https://true-shuffle.mikahertler-72c.workers.dev/
Diese Datei: `docs/auftraege/AUFTRAG_TRUESHUFFLE_1.3.0.md` auf Branch `auftrag/1.3.0` (nur Dokument, kein Code).

## 0. So startest du

Prompt, den Mika einfügt:

> Lies docs/auftraege/AUFTRAG_TRUESHUFFLE_1.3.0.md im Repo MikaMcFlurry/true-shuffle-PoC (Branch auftrag/1.3.0) und die dort genannten Skills aus MikaMcFlurry/skills und arbeite den Auftrag ab.

Danach in dieser Reihenfolge: Abschnitt 1 (Harte Regeln) lesen, Skills aus Abschnitt 6 laden, Arbeitsplan Abschnitt 7 abarbeiten. Owner-Entscheidungen (Abschnitt 4) gelten als beschlossen, nicht erneut fragen.

## 1. Harte Regeln

- **Nie** auf `codex/implement-cloudflare-restart` (Produktionsbranch, jeder Push deployt live) oder `main` pushen, mergen oder force-pushen.
- Arbeit nur auf neuen Branches: `backup/local-1.2.0-<datum>`, `release/1.3.0`, Feature-Branches in `release/1.3.0`.
- Kein Deploy und kein Merge in den Produktionsbranch ohne Mikas ausdrückliche Freigabe.
- Tokens, Cookies, `APP_SECRET`, Remote-Schlüssel und Hördaten nie in Git, Logs, PRs oder Screenshots.
- Cloudflare-Leselimit (P1) hat Vorrang vor jeder neuen Funktion; keine neue Funktion darf zusätzliche DO-Reads pro Tastendruck oder pro Poll erzeugen.

## 2. Ziel

TrueShuffle soll stabil den ganzen Tag laufen, weniger Spotify- und Cloudflare-Aufrufe brauchen, auf Handy und Desktop sauber aussehen, im Verlauf durchsuchbar sein und alle offenen Wünsche von Mika enthalten. Ergebnis ist ein geprüfter Release-Kandidat **1.3.0** auf `release/1.3.0`, mit Versionsnummer, „Was ist neu“ und Evidenz. Live geht erst etwas, wenn Mika es freigibt.

## 3. Ausgangslage (bitte selbst nachprüfen)

- **Stack:** Preact/Vite Client, Hono Worker, Durable Objects `UserHub` (pro Spotify-Konto, SQLite) und `Registry`, Cron alle 20 min, Deploy über Workers Builds bei Push auf den Produktionsbranch `codex/implement-cloudflare-restart`. `main` ist das alte Python/Fly-Projekt. Es gibt `wrangler.preview.jsonc` (isolierter Worker `true-shuffle-preview` mit eigenen DO-Namespaces).
- **GitHub hinkt hinterher:** Produktionsbranch steht auf `8d621381` (09.10.). Der Live-Stand `47e32be6` liegt nur auf `codex/verify-history-fallback-linux-check-20261014`. PR #30 ist offen. Die Commits für 1.1.0 (`17374f75`) und 1.2.0 (`b2aac5bd`) sowie alle Korrekturen ab 15.10. (u. a. `463e3b5`, `4b7a438e`, `c5b34acc`, `f206790d`, `b5c71177`, `d2b9802c`) sind **auf GitHub nicht vorhanden** (404). Sie liegen vermutlich lokal auf Mikas Windows-Rechner unter `C:\Users\mikah\Documents\Codex\…`.
- **Version:** Mika hat **1.2.0 auf dem Handy**. 1.2.0 gilt damit als Live- und Abnahmestand (siehe E2). `package.json` auf `47e32be6` sagt noch 1.0.0.
- **Spotify-Scopes** (`src/worker/spotify/client.ts`): user-read-private, playlist-read-private, playlist-read-collaborative, playlist-modify-private, playlist-modify-public, user-library-read, user-top-read, user-read-recently-played, user-read-playback-state, user-read-currently-playing, user-modify-playback-state. Damit gehen Lautstärke, Warteschlange lesen/ergänzen und eine eigene private Likes-Playlist **ohne neue Scopes**. Die App ist im Spotify Development Mode (Regeln seit Feb./März 2026: Premium, max. 5 Nutzer, `/playlists/{id}/items` nur für eigene oder kollaborative Playlists, Bibliothek über `PUT/DELETE /me/library`).
- **Ausfall 22./23.10.:** Kontoweites Tageslimit von 5 Mio. gelesenen DO-Zeilen erreicht (22.10. 20:31: 4.963.825, davon UserHub 4.524.585, Registry 439.240). Verdachtsstellen: `GET /api/state?live=1` alle 15 s ohne Backoff (`src/client/store.ts` L297 bis 389), `SpotifyUsageTracker.record` mit `init` und Retention bei jedem Aufruf (`src/worker/spotify/usage.ts`), wiederholte Session- und State-Reads, Catch-all „Interner Fehler“ in `userhub.ts` L99 bis 124. Eine Behebung ist nicht belegt.
- **Tests:** Vitest (Unit/Worker), Playwright gegen `e2e/fake-server.ts` mit `wrangler.e2e.jsonc`, `npm run check`, CI `.github/workflows/cloudflare-checks.yml` (nur `pull_request` auf zwei Branches plus `workflow_dispatch`, kein `push`). Drei bekannte Alt-Fehlschläge sind dokumentiert. Live-Checkliste: `docs/LIVE_TEST.md`.
- **Workers Builds und Nicht-Produktionsbranches:** Ob Workers Builds für andere Branches Vorschau-Versionen baut, ist im Repo nicht ablesbar (Dashboard-Einstellung, siehe P15). Standard bei Workers Builds: Nicht-Produktionsbranches erzeugen höchstens eine Vorschau-Version (`wrangler versions upload`), kein Produktions-Deploy. Trotzdem prüfen und im Bericht nennen.

## 4. Owner-Entscheidungen (Mika, 02.11.2026)

Ersetzt die bisherigen offenen Fragen. Gilt als beschlossen.

- **E1 Private Session:** Mika schaltet sie selbst ein, oder der Agent schaltet sie selbst ein, aber nur über die Oberfläche der Spotify-App und nur, wenn er dort nachweislich Geräte- bzw. UI-Steuerung hat (die Web API kann das nicht). Sie ist optional. Ist sie nicht nachweislich aktiv, gilt der Fallback: höchstens 30 s pro Titel bei Lautstärke 0, Snapshot und exakte Wiederherstellung des Player-Zustands. Gastmodus in TrueShuffle ist in jedem Fall Pflicht (siehe E4).
- **E2 Basis 1.2.0:** 1.2.0 ist die Live- und Abnahmereferenz. Zuerst den lokalen Stand 1.1.0/1.2.0 auf einen **neuen** Branch `backup/local-1.2.0-<datum>` sichern (nur neuer Branch, kein Force-Push, nie Produktion oder `main`). `release/1.3.0` baut auf 1.2.0 auf.
- **E3 Likes-Playlist:** privat, Name **„TrueShuffle Likes“**.
- **E4 Live-Tests im Browser:** Live-Tests laufen in TrueShuffle im Browser auf Mikas PC (seine angemeldete TrueShuffle-Web-App). Der Agent schaltet den TrueShuffle-Gastmodus selbst ein und prüft vor dem ersten Test, dass er aktiv ist.
- **A1 Annahme `rated:0`:** Nicht beantwortet. Annahme: `rated:0` gilt als unbewertet/unbekannt (nicht als bekannte Revision). Änderbar; die Stelle im Code als einzelne Regel kapseln und im Bericht nennen.

## 5. Konsolidierter Backlog

Quellen: Slack `#true-shuffle` (C0C8DG6PDU7), `#team-koordination` (C0C83E1DWMV), DM CEO (D0C8BGP354J), DM COO (D0C89PPJ68N), DM CTO (D0C89QGM3V4), Mika 02.11. Status: ERLEDIGT = abgenommen, GEPLANT = beschlossen aber offen, IDEE = noch nicht beschlossen, ABGELEHNT.

| ID | Punkt | Quelle | Status | Prio |
|---|---|---|---|---|
| D1 | Import-Auswahl, Import deaktivieren/löschen, Playlist-Zählung pro Song (PR #30, a858098d), live in 47e32be6 | #true-shuffle 13.10., DM CEO 12.10. | ERLEDIGT (PR #30 noch offen) | · |
| D2 | Favorit/„Nie wieder“ an jeder Verlaufszeile sichtbar, ohne Schalter, mit Rückgängig | DM CEO 14.10. | ERLEDIGT | · |
| D3 | Mobil: überlappende Datumsfelder, Navigationsleiste 127 px | DM CEO 14.10. | ERLEDIGT (in U1 auf Rückfall prüfen) | · |
| D4 | Guard-Fix 463e3b5 (RateSheet bleibt bei Fehler offen, kein Auto-Skip aus alten Bewertungen) | #true-shuffle 15./16.10. | ERLEDIGT, nicht auf GitHub | · |
| D5 | Bewertungsspeicher R2 bis R6, TS-COMBINED, TS-LF, HISTORY-LEGACY-SEEN-COR1 | #true-shuffle 16./17.10. | ERLEDIGT, nicht auf GitHub | · |
| D6 | JH06-Core: Import-Stichzeit vor Rundung/Duplikatabgleich (4b7a438e) | #team-koordination 17.10. | ERLEDIGT, nicht auf GitHub | · |
| D7 | ZERO-FOLLOW: bestätigte Revision 0 geschützt (c5b34acc) | #team-koordination 17.10. | ERLEDIGT, nicht auf GitHub | · |
| D8 | Doppel-Skip-Schutz NP-COR1/COR2 (f206790d, b5c71177) | #true-shuffle 17.10. | ERLEDIGT, Live-iPhone offen | · |
| D9 | Deezer-Hörprobe im Verlauf, CSP nur `widget.deezer.com`, Textnennung „Deezer“ | DM CEO 14.10., #team-koordination 18.10. | ERLEDIGT | · |
| D10 | Release 1.1.0 mit Versionsnummer und Änderungs-Popup (17374f75) | #team-koordination 17.10. | ERLEDIGT | · |
| D11 | Release 1.2.0 (b2aac5bd) | #team-koordination 18.10., Mika 02.11. | ERLEDIGT, live auf Mikas Handy | · |
| P1 | DO-Leselimit: Polling, Tracker, Session-Reads drastisch senken; klare Offline-Meldung statt „Interner Fehler“ | DM CEO 22./23.10., #true-shuffle 23.10. | GEPLANT | P0 |
| P2 | Lokale Commits 1.1.0/1.2.0 und Fixes auf GitHub sichern (E2); Drift Produktionsbranch zu Live dokumentieren | #true-shuffle 14.10., Mika 02.11. | GEPLANT | P0 |
| P14 | Siri-Kurzbefehle („Favorit“, „Nie wieder“, „Weiter“) bleiben funktionsfähig | #true-shuffle 13.10. | GEPLANT (Schutz) | P0 |
| U1 | UI/UX-Bugpass Mobil und Desktop (Abschnitt 5.1) | Mika 02.11. | GEPLANT | P1 |
| S1 | Suche im Verlauf nach Titel und Künstler mit Hördaten und Like (Abschnitt 5.2) | Mika 02.11. | GEPLANT | P1 |
| P3 | Spotify-Fallback in drei Stufen: Deezer-Clip, bewusster Spotify-Start mit Gerät und Unterbrechungswarnung, direkter Spotify-Link; „kein eindeutiger Treffer“ ≠ „fehlt“, keine falschen Live/Remix-Versionen | #true-shuffle 20.10. 14:02/16:00, COO 15:40 | GEPLANT | P1 |
| P4 | Kassette „TrueShuffle Likes“ aus Daumen hoch, je Track-ID ein Eintrag, plus eigene synchrone **private** Spotify-Playlist „TrueShuffle Likes“ (E3, nicht „Entdeckungen“); sichtbar auch bei Sync-Fehler | #true-shuffle 20.10. 16:00/16:05, Mika 02.11. | GEPLANT | P1 |
| P5 | Button „Nach diesem Song fortsetzen“: laufenden Fremdsong ausspielen lassen, dann TrueShuffle; warteschlangenbasiert, kein Timer | DM COO 20.10. 22:09 | GEPLANT | P1 |
| P6 | Songs außerhalb der TS-Folge anzeigen („Aus Spotify-Warteschlange“ nur wenn erkennbar, sonst „Außerhalb der TrueShuffle-Folge“), Like/Dislike/Skip darauf | #true-shuffle 13.10. 15:57 | GEPLANT | P1 |
| P7 | Versionsnummer dauerhaft unter Menü › Über sichtbar | #true-shuffle 20.10. 14:02 | GEPLANT | P1 |
| P9 | Importlücke: JSON-Events nach erstem TS-Login werden verworfen; Filter wirken auf den importierten Spotify-JSON | #true-shuffle 13.10. | GEPLANT | P1 |
| P10 | Anzeige-Bug: laufender Song erscheint nach Skip zusätzlich als „Als Nächstes“ (keine Doppelwiedergabe) | DM CEO 14.10. 00:38, #true-shuffle 14.10. 01:24 | GEPLANT | P1 |
| P12 | Hörprobe auf echtem iPhone und in der PWA prüfen, bei laufendem Spotify | #true-shuffle 18.10. | GEPLANT | P1 |
| P13 | UX-Audit: kein „KI-Slop“, kurze klare Texte, versteckte Funktionen sichtbar, mit `impeccable` | DM CEO 14.10., #true-shuffle 13.10. | GEPLANT | P1 |
| P8 | Lautstärkeregler mit +/− für das aktive Spotify-Connect-Gerät (z. B. „Wohnzimmer · 35 %“) | #true-shuffle 15.10. 19:14 | GEPLANT | P2 |
| P11 | Importverwaltung „Original / Bereinigt / Heute“ mit Wiederholungen, kurzen Starts, Zeitgewichtung, Ausschlüssen, Auf-/Absteigern („True-Musikgeschmack“); Prototyp nur mit synthetischen Daten | DM CEO 14.10. 16:43 bis 16:50 | GEPLANT | P2 |
| P15 | Workers Builds: nur Produktionsbranch bauen, rote Branch-Builds beenden | DM CEO 13.10. 23:49 | GEPLANT (Mika-Handgriff) | P2 |
| I1 | `rated:0`: Annahme A1 umsetzen (unbewertet/unbekannt), änderbar | #true-shuffle 17.10., Mika 02.11. | GEPLANT (Annahme) | P2 |
| I2 | Playlist-Zählung auch für gefolgte Fremd-Playlists | DM CEO 12.10. | IDEE (API erlaubt es im Dev Mode nicht) | P3 |
| R1 | Hardware-Lautstärketasten in der iOS-Web-App | #true-shuffle 15.10. | ABGELEHNT (technisch unmöglich) | · |
| R2 | Spotify-Preview-Clips/Embed als Hörprobe | DM CEO 14.10. | ABGELEHNT (Policy, Embed stört Wiedergabe) | · |
| R3 | Deezer-Logo | #team-koordination 18.10. 18:39 | ABGELEHNT (nur Text) | · |
| R4 | Separate Testumgebung oder zweiter Worker für Mika | #team-koordination 17.10. 09:00, 18.10. 16:25 | ABGELEHNT (Updates auf derselben Adresse) | · |
| R5 | Timer-basiertes `resumeSession` für P5 | #true-shuffle 21.10. | ABGELEHNT | · |
| R6 | Bewertungen im Verlauf nur per Schalter | DM CEO 14.10. | ABGELEHNT | · |

### 5.1 U1: UI/UX-Bugpass Mobil und Desktop

Vorgehen:
1. Bekannte UI-Punkte als Startliste übernehmen: D3 (Rückfallprüfung Datumsfelder, Navigationsleiste), P10 (doppeltes „Als Nächstes“), P12 (Hörprobe iPhone/PWA), P13 (Texte, versteckte Funktionen). Weitere UI-Meldungen aus Slack `#true-shuffle` nur ergänzen, wenn sie dort belegt sind.
2. Playwright gegen den Fake-Server mit Device-Emulation: mindestens iPhone SE (320/375 px), iPhone 15 (393 px), Pixel 7 (412 px), iPad Mini, Desktop 1280 und 1920 px; Engines Chromium, Firefox, WebKit (WebKit steht für iOS Safari, Chromium mobil für Android Chrome). Hoch- und Querformat.
3. Pro Bildschirm und Gerät ein Screenshot (Start/Login, Player, Verlauf inkl. Suche S1, Bewertungs-Sheet, Import, Menü › Über, Fehler- und Offline-Zustand, Gastmodus). Prüfen: Touch-Ziele mindestens 44×44 px, Safe Areas (Notch, Home-Indikator, `env(safe-area-inset-*)`), Scrollen ohne horizontalen Überlauf, feste Leisten verdecken nichts, Tastatur verdeckt keine Eingaben, Fokus und Kontrast, Text bei 200 % Zoom lesbar.
4. Bugliste `docs/qa/1.3.0-ui-bugs.md`: ID, Gerät/Browser, Bildschirm, Beschreibung, Schwere, Screenshot-Pfad. Screenshots unter `docs/qa/screenshots/1.3.0/` (nur Fake-Daten, keine echten Hördaten).
5. Beheben nach `impeccable`, erneut testen, Vorher/Nachher-Screenshots je Bug.
6. Einmal kurz echt prüfen: Mikas Handy (1.2.0 Referenz) nur nach Absprache; Desktop im Browser auf Mikas PC im Rahmen von Abschnitt 9.

Abnahme U1: Bugliste vollständig mit Screenshots; alle Bugs der Schwere hoch und mittel behoben oder begründet zurückgestellt; Playwright-Visual-Specs für die genannten Viewports grün; kein horizontaler Überlauf bei 320 px; Touch-Ziele ≥ 44 px; Vorher/Nachher-Evidenz im Handoff.

### 5.2 S1: Suche im Verlauf

Funktion:
- Suchfeld oben im Verlauf. Suche nach Songtitel und Künstler, Teiltreffer, ohne Groß/Kleinschreibung und ohne Akzente (z. B. „beyonce“ findet „Beyoncé“, Normalisierung NFD plus Entfernen der Diakritika), Eingabe entprellt (ca. 200 ms).
- Treffer gruppiert pro Track-ID: Titel, Künstler, Anzahl Wiedergaben, zuletzt gehört, aufklappbar alle Wiedergabezeitpunkte (Europe/Berlin).
- Direkt am Treffer: Like (Daumen hoch) mit derselben Logik wie überall, also Eintrag in Kassette und private Playlist „TrueShuffle Likes“ (P4, E3), mit Rückgängig. Vorhandene Bewertung wird angezeigt.
- Leerer Zustand und „keine Treffer“ mit kurzem Text.

Effizienz (Pflicht wegen P1):
- Keine DO-Reads pro Tastendruck. Entweder Verlauf einmal pro Sitzung (bzw. inkrementell per Revision/`If-None-Match`) laden und clientseitig durchsuchen, oder ein indiziertes Suchfeld im `UserHub` (normalisierte Spalte plus Index) mit einer Abfrage pro entprellter Eingabe und Ergebnislimit. Entscheidung mit Messung begründen.
- Lokaler Zähler belegt die DO-Zeilenreads für 20 Suchanfragen.

Mobil: Suchfeld bleibt bei offener Tastatur sichtbar, Treffer per Daumen bedienbar, Touch-Ziele ≥ 44 px.

Abnahme S1: Unit-Tests für Normalisierung und Teiltreffer; Playwright-Spec Suche plus Like auf Fake-Server (mobil und Desktop); Like aus der Suche erzeugt genau einen Eintrag in Kassette und Playlist, keine Duplikate; 20 Suchanfragen verursachen höchstens die Reads eines einzigen Verlauf-Ladens (clientseitig) oder höchstens 20 indizierte Abfragen mit Limit; kein Lesen pro Tastendruck.

## 6. Skills

Alle Skills liegen in `MikaMcFlurry/skills` unter `skills/<name>/SKILL.md` (zusätzlich zentral in t3-code installiert). Vor Beginn lesen.

| Skill | Pfad | Wann |
|---|---|---|
| `mika-dev-studio` | `skills/mika-dev-studio/SKILL.md` | Orchestrator, Modus `AUTONOMOUS_BUILD`. |
| `mika-repo-intelligence` | `skills/mika-repo-intelligence/SKILL.md` | Zuerst, `FULL_INTELLIGENCE`, nur lesen: Live-Provenienz, lokale vs. GitHub-Commits, veraltete `AGENTS.md`. |
| `mika-product-director` | `skills/mika-product-director/SKILL.md` | P3 bis P6, P11, P13, U1, S1: Abläufe, Texte, Herkunftsetiketten, Grenzen. |
| `impeccable` | repo-lokal `.agents/skills/impeccable` | Jede sichtbare UI-Änderung, U1, S1; von Mika ausdrücklich verlangt. |
| `mika-engineering` | `skills/mika-engineering/SKILL.md` | Umsetzung, additive Migrationen, Effizienz P1, S1-Index. |
| `mika-verification` | `skills/mika-verification/SKILL.md` | Evidence Ledger, Gates, Screenshots U1, Live-Test nach Abschnitt 9. |
| `mika-red-team` | `skills/mika-red-team/SKILL.md` | Frischer unabhängiger Review vor der Freigabeanfrage. |
| `mika-app-version-updates` | `skills/mika-app-version-updates/SKILL.md` | Version 1.3.0 als einzige Quelle, „Was ist neu“, P7, Update-Knopf. |
| `github-actions-budget` | `skills/github-actions-budget/SKILL.md` | CI-Anpassung und jeder Push. |
| `mika-repo-handoff` | `skills/mika-repo-handoff/SKILL.md` | Am Ende: `AGENTS.md`/Status auf den echten Stand, keine Parallelwahrheit. |

Nicht verwenden: `mika-governance` (kein formales Regime), `mika-source-intelligence` und `mika-product-alignment` (Quellen und Owner-Entscheidungen stehen hier; nur bei neuen Widersprüchen), `adhs-chair` (nur auf Mikas Zuruf), alles unter `experimental/`.

## 7. Arbeitsplan

1. **Sichern (keine Codeänderung, E2):** lokales Repo mit `b2aac5bd` finden; Live-Version lesend feststellen (ausgelieferte Assets/Version-Endpunkt), mit 1.2.0 abgleichen. Alle lokalen Commits ab `47e32be6` auf neuen Branch `backup/local-1.2.0-<datum>` pushen. Kein Force-Push. Nie Produktionsbranch oder `main`.
2. **Repo Intelligence:** Packet erstellen; Lücken zwischen diesem Backlog und Code markieren.
3. **Plan:** Abhängigkeiten, PR-Schnitt, Messpunkte. Kurz an Mika berichten, dann weiter ohne Warten.
4. **Umsetzen:** `release/1.3.0` von 1.2.0 (`b2aac5bd` bzw. dem gesicherten Backup-Kopf). Kleine PRs in diesen Branch, Reihenfolge: P1 und P2 · P14-Schutztests · P10 und P6 · U1 Bestandsaufnahme (Bugliste) · P4 · S1 · P5 · P3 · P7 und P8 · P9, P11, I1 · U1 Fixes und P13. Jede Migration additiv; `UserHub`/`Registry`, Bindings, `APP_SECRET` und Historien bleiben unverändert.
5. **Release vorbereiten:** Version 1.3.0 nach `mika-app-version-updates`, Notizen auf Deutsch in Mikas Ton, „Was ist neu“ mit höchstens vier Highlights (Vorschlag: stabiler Betrieb, Suche im Verlauf, TrueShuffle Likes, Nach diesem Song fortsetzen).
6. **Prüfen:** lokale Gates, CI, U1-Retest, Live-Test (Abschnitt 9), Red-Team-Review, Reparatur.
7. **Freigabe anfragen:** Bericht nach Abschnitt 11. **Kein Merge in `main` oder den Produktionsbranch und kein Deploy ohne Mikas ausdrückliche Freigabe.**

## 8. Abnahmekriterien

- P1: Bei 4 h sichtbarer Wiedergabe plus 20 h Pause zeigt der lokale Zähler höchstens 10 % der bisherigen DO-Zeilenreads; Offline-Ursache wird korrekt benannt.
- P2: Jeder Live-Commit (1.2.0) ist auf GitHub auffindbar; Drift dokumentiert.
- P3: drei getrennte Aktionen; Spotify-Start nur nach Bestätigung mit Gerätename; falsche Version wird nie automatisch gewählt.
- P4: Likes-Kassette spielt ab, keine Duplikate, genau eine private Playlist „TrueShuffle Likes“, Sync-Fehler sichtbar und wiederholbar.
- P5: laufender Song wird nicht unterbrochen; Fortsetzung erst nach beobachtetem Wechsel; Abbruch jederzeit möglich, ohne Nebenwirkung.
- P6/P10: Herkunft korrekt, keine doppelte „Jetzt/Als Nächstes“-Anzeige, Bewertungen wirken.
- P7: Version und Build-ID unter Über; P8: Regler wirkt auf das aktive Gerät, Fehler bei nicht steuerbaren Geräten verständlich.
- P9/P11: Events nach Login werden dedupliziert übernommen statt verworfen; Originalhistorie bleibt unverändert.
- P14: Siri-Kurzbefehle unverändert funktionsfähig (Test gegen Fake und einmal live).
- I1: `rated:0` als unbewertet behandelt, Regel an einer Stelle, Test vorhanden.
- U1 und S1: siehe 5.1 und 5.2.
- Gates: build, typecheck, lint, Vitest, Playwright grün; die drei Alt-Fehler unverändert oder behoben, nie neu dazu; mobile Ansicht 320/390 px.

## 9. Live-Test-Sicherheit (Pflicht)

Live-Tests laufen **in TrueShuffle im Browser auf Mikas PC** (seine angemeldete TrueShuffle-Web-App, E4). Erlaubt nur, wenn alle folgenden Regeln gelten.

**Vorher**
1. **Gastmodus:** Der Agent schaltet in TrueShuffle den Gastmodus selbst ein und prüft vor dem ersten Test sichtbar, dass er aktiv ist (Anzeige in der App plus Screenshot ohne private Daten). Ohne bestätigten Gastmodus kein Test. Damit bleiben TrueShuffle-Hörprofil, Sender und Bewertungen unberührt. Keine Daumen auf echte Songs, außer in der TS-TEST-Playlist mit anschließendem Rückgängig.
2. **Private Session (optional, E1):** Mika oder der Agent schaltet sie in der Spotify-App ein; der Agent nur, wenn er nachweislich UI-Steuerung über die Spotify-App hat. Es gibt keine API dafür. Private Sitzungen beeinflussen Spotifys Empfehlungen nicht und erscheinen im erweiterten Export mit `incognito_mode: true`. Ist sie nicht nachweislich aktiv: jeden Titel unter 30 s halten (Spotify zählt ab 30 s als Stream) und Lautstärke 0.
3. **Snapshot:** `GET /me/player` (device.id, device.name, device.volume_percent, context.uri, item.uri, progress_ms, is_playing, shuffle_state, repeat_state) und `GET /me/player/queue`. Ablage lokal außerhalb des Repos (z. B. `%LOCALAPPDATA%\ts-livetest\`), in `.gitignore`, ohne Tokens.
4. Cloudflare-Verbrauch prüfen; liegt er über 50 % des Tageslimits, kein Live-Test.

**Während**
5. Zuerst nur lesende Endpunkte, Dry-Run und den Fake-Server nutzen. Schreibende Aufrufe nur, wenn der Test ohne sie nicht möglich ist.
6. Nie `next`/Skip im echten Kontext ohne Wiederherstellung. Warteschlange ergänzen (`POST /me/player/queue`) lässt sich per API nicht rückgängig machen: nur nach Mikas Go in einem angekündigten Testfenster.
7. Keine Änderungen an Playlists, Likes, Follows oder Bibliothek. Einzige Ausnahme: eine private Playlist mit Präfix `TS-TEST`, die am Ende entfolgt wird (`DELETE /me/library` mit `spotify:playlist:<id>`). Die echte Playlist „TrueShuffle Likes“ wird live nur angelegt, wenn Mika das freigibt; sonst mit `TS-TEST-Likes` testen.
8. Protokoll mit Zeitstempel (UTC und Europe/Berlin) für jeden wiedergaberelevanten Aufruf: Methode, Endpunkt, Track-URI, Gerät, Dauer bis zum nächsten Wechsel. Felder an Spotifys Export angelehnt (`ts`, `spotify_track_uri`, `ms_played`), damit Mika es mit seinem Export abgleichen kann.

**Nachher**
9. Exakt wiederherstellen: `PUT /me/player` (Gerät, `play:false`), dann `PUT /me/player/play?device_id=…` mit `context_uri`, `offset.uri`, `position_ms`; ohne Kontext mit `uris:[item.uri]`. Danach `PUT /me/player/shuffle`, `/repeat`, `/volume` auf die Snapshot-Werte; war vorher pausiert, `PUT /me/player/pause`.
10. Mit `GET /me/player` prüfen und Vorher/Nachher ins Protokoll schreiben. Abweichungen Mika melden.
11. Bei jedem unerwarteten Zustand (anderes Gerät, fremder Song, 429, Fehler): sofort stoppen, wiederherstellen, berichten.
12. Gastmodus in TrueShuffle wieder ausschalten und prüfen; Mika an das Beenden der Private Session erinnern (oder selbst beenden, wenn der Agent sie eingeschaltet hat).
13. Tokens, Cookies, `APP_SECRET`, Remote-Schlüssel und Hördaten nie in Git, Logs, PRs oder Screenshots.

## 10. CI nach `github-actions-budget`

Lokal zuerst (`npm run check`, gezielte Playwright-Specs), Vollprüfung an Meilensteinen. Workflow ergänzen um `concurrency` je PR mit `cancel-in-progress`, Klassifikation docs/Code/Lockfile und einen Gate-Job als einzigen Pflichtcheck; `pull_request` zusätzlich auf `release/**`. Visual-Specs für U1 nur an Meilensteinen und per `workflow_dispatch`, nicht bei jedem Push. Keine doppelten Push- und PR-Läufe. Statuswerte getrennt melden (`LOCAL_VERIFIED`, `CI_EFFECT_VERIFIED`, `NOT_RUN`). Workers-Builds-Previews sind keine CI.

## 11. Rückmeldung an Mika

Kurz, auf Deutsch, ohne interne Kürzel im Fließtext:
1. Was jetzt fertig ist (pro Backlog-ID: erledigt, teilweise, offen), mit Branch, Commit, PR-Link; Backup-Branch 1.2.0.
2. Messwerte P1 vorher/nachher und Reads der Verlaufssuche.
3. UI-Bugpass: Anzahl gefunden/behoben, Link zur Bugliste, Vorher/Nachher-Screenshots.
4. Live-Test: Zeitfenster, Gastmodus bestätigt, Private Session ja/nein, Protokollpfad, Vorher/Nachher-Zustand, Hinweise für den Exportabgleich.
5. Ergebnis Red Team, offene Risiken, Annahme `rated:0` zur Bestätigung.
6. Genau eine Freigabefrage: „1.3.0 aus Commit X live deployen?“
