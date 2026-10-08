# Startauftrag: true-shuffle UX/UI von Grund auf neu

Stand dieser Übergabe: 2026-10-08. Prüfe alles selbst nach. Dieses Dokument
ist Navigation, kein Beweis.

## 1. Worum es geht

Der Besitzer (Mika) hält die Oberfläche trotz mehrerer Neugestaltungen für
**unbrauchbar**. Seit September gab es diese Runden: Röhrenradio,
Konzertplakat, vier wählbare Designs (Kontaktbogen, Linienplan, Strichliste,
Klassisch) und sechs „Bedienflächen“ (Leuchttisch, Fahrt, Notizblock,
Player, Umlauf, Fahrmodus). Alle haben vor allem die **Optik** gewechselt.
Informationsarchitektur, Wortwahl und Abläufe sind im Kern gleich geblieben.

Auftrag: Baue eine Oberfläche, die man **ohne Erklärung versteht**. Sie soll
sinnvoll, intuitiv, selbsterklärend und schön sein, als **ein** System statt
als Auswahl von Themen. Beginne bei Nutzern, Aufgaben und Abläufen, nicht
bei Farben. Eine weitere Stilvariante über derselben Struktur gilt als
gescheitert.

Der Backend-Teil funktioniert und ist frisch repariert (siehe §5). Er bleibt
unverändert.

## 2. Repo, Branches, Live-Stand

- Repo `MikaMcFlurry/true-shuffle-PoC`. Die aktive App ist
  Preact/TypeScript/Hono auf einem Cloudflare Worker mit einem Durable Object
  pro Konto. `main` ist die **historische Python-App**. Nie daraus bauen,
  deployen oder mergen.
- Build-Branch (Cloudflare Workers Builds, Produktion):
  `codex/implement-cloudflare-restart`. Jeder Push dorthin wird live
  deployt.
- Live seit 2026-10-08: Quelle `5ea6f6d` (fix(session) …), Cloudflare-Version
  `6b2a79a2`, 100 %. URL: https://true-shuffle.mikahertler-72c.workers.dev/
- Arbeite auf einem eigenen Branch, der von `codex/implement-cloudflare-restart`
  abzweigt. Öffne einen PR dorthin. Gemergt bzw. per Fast-Forward
  veröffentlicht wird erst nach grüner CI **und ausdrücklicher Freigabe des
  Besitzers**.
- Bekannt und harmlos: Cloudflare-**Vorschau**-Builds für PR-Branches
  scheitern sofort mit „root directory not found“. Ursache ist eine
  Einstellung unter „Previews Base“, nicht der Code. Maßgeblich sind die
  GitHub-Prüfung `verify` und nach dem Merge der Produktions-Build unter
  Workers & Pages → true-shuffle → Deployments.

Lies vorher `AGENTS.md`, `CODEX_START.md`, `PRODUCT.md`, `DESIGN.md`,
`docs/BRAND.md`, `docs/ai-dev/MISSION.md` (geschützte Anforderungen
NN-01…NN-11) und `docs/UI_UX_START.md` (früherer UI-Auftrag; seine
Schutzregeln gelten weiter).

## 3. Was du ändern darfst und was nicht

**Frei:**
- `src/client/screens/**`, `src/client/components/**`,
  `src/client/styles/**`
- `src/client/design.ts`, `src/client/router.ts` (Routen und Navigation
  dürfen neu geordnet werden; alte Pfade bitte auf neue umleiten)
- `src/client/format.ts`, `src/client/index.html`, `src/client/public/**`
  (Icons und Manifest)
- `DESIGN.md`, `docs/BRAND.md`, die Design-Teile von `PRODUCT.md`
- Alle Texte der Oberfläche (Deutsch)

**Technische Verträge, nur übernehmen und nicht umschreiben** (Änderungen
höchstens als separat begründeter Vorschlag mit Tests):
- `src/client/store.ts`: Zustand, Abfragerhythmus, Befehlsbehandlung, Fencing
- `src/client/playback-view.ts`, `src/client/progress.ts`: Anzeige-Projektion
  und lokale Songuhr. Die sind **nur Anzeige** und nie ein Beleg, dass etwas
  gehört wurde.
- `src/client/api.ts`: Client des Worker-API

**Tabu:**
- `src/worker/**`, `src/core/**`, `src/shared/**` (API-Typen)
- Migrationen und Schema, `wrangler*.jsonc` (Bindings, Durable-Object-Namen,
  Migrations-Tags)
- Secrets, Spotify-Anfragelogik, Scheduler, Authentifizierung
- Vendorte Skills unter `.agents/skills/**` und `.claude/skills/**`

## 4. Was die Oberfläche heute können muss (nichts davon darf verloren gehen)

Routen heute (`src/client/router.ts`): `/` (Hören/Player und Sender),
`/sender/:id`, `/sender/neu`, `/menu`, `/verlauf`, `/import`, `/geraete`,
`/info`, `/fernbedienung`, `/suchlauf`.

Funktionen, mit den API-Aufrufen aus `src/worker/index.ts`:

| Bereich | Funktion | API |
|---|---|---|
| Anmelden | Mit Spotify verbinden, abmelden, Konto löschen | `/auth/login`, `/auth/logout`, `DELETE /api/account` |
| Einrichtung | Playlists wählen, aus denen Sender werden („Alles“ kombiniert alle) | `GET /api/playlists`, `POST /api/onboarding` |
| Hören | Fortsetzen der gespeicherten Warteschlange (Standard). „Neue Warteschlange“ ist eine **getrennte, bewusste** Aktion | `POST /api/stations/:id/play` (`newQueue`) |
| Hören | Pause, Weiter, Fortsetzen; Fortschritt, Cover, aktueller Song, kommende Songs | `POST /api/player/:action`, `GET /api/state` |
| Geräte | Gerät wählen (Auswahl wird lokal gemerkt), Hinweis, wenn kein Gerät aktiv ist | `GET /api/devices` |
| Bewerten | Daumen hoch (Favorit) und runter (nie wieder) | `POST /api/tracks/:id/thumb` |
| Sender | Anlegen, umbenennen, Quellen ändern, löschen | `POST/PATCH/DELETE /api/stations` |
| Sender | Mischung „Entdecken ↔ Vertraut“ und Erweitert: Favoriten-Abstand und -Anteil, Skip-Regel, Künstlerabstand, Neuentdeckungen an/aus | `PATCH /api/stations/:id` (`rules`) |
| Sender | Fortschritt der Runde, zuletzt gehört, Neuentdeckungen und deren Quellen | `GET /api/stations/:id` |
| Verlauf | Jeder Song ab 30 s, nach Tagen gruppiert, mit Sender | `GET /api/history` |
| Import | Spotify-Export „Streaming_History_Audio_*.json“ im Browser auswerten und als Zahlen pro Song hochladen | `POST /api/history/import` |
| Gäste | Gast-Modus mit Ablaufzeit: was der Gast hört, zählt nicht | `POST /api/guest` |
| Fernbedienung | Schlüssel für Kurzbefehle (iPhone, CarPlay, Apple Watch, Android) | `GET/POST/DELETE /api/remote`, `/remote/:action` |
| Suchlauf | Sendersuchlauf | Route `/suchlauf` |
| Heimautomation | Native Home-Assistant- und Music-Assistant-Player | `/api/native/*` |
| Diagnose | Spotify-Erreichbarkeit, eigene Anfragezahlen, Wartezeiten nach echten 429 | `/api/spotify/*` |
| Darstellung | Hell, dunkel, automatisch (`ts-illumination`); bisher Design-Auswahl (`ts-design`) | lokal |

Lokale Schlüssel im Browser: `ts-device`, `ts-device-name`,
`ts-illumination`, `ts-design`. Fällt die Design-Auswahl weg, muss ein alter
`ts-design`-Wert still ignoriert werden, ohne Fehler.

## 5. Geschützte Verhaltensverträge, die die Oberfläche sichtbar machen muss

- **Die gespeicherte Stelle geht nur vorwärts** (neu seit `5ea6f6d`). Spielt
  ein anderes Gerät die Sender-Playlist an einer älteren Stelle, bleibt die
  Stelle stehen und die Session meldet `status: "external"`. Die Oberfläche
  muss dann klar sagen: „Deine Warteschlange wartet. Fortsetzen holt sie
  zurück.“ Ein Fehler ist das nicht.
- „Fortsetzen“ macht hinter dem am weitesten gehörten Song weiter. Ein
  mitten im Song pausierter Titel läuft an der Pausenstelle weiter (NN-03,
  NN-04, NN-07).
- Drei getrennte Ebenen: angefordert, von Spotify angenommen, durch Messung
  bestätigt. Pause reagiert sofort und friert die Uhr ein. Ältere Messwerte
  dürfen die Anzeige kurz nach einem Klick nicht zurückschalten.
- Session-Status `active`, `paused`, `disconnected`, `external`, `ambiguous`
  und `saved`, dazu offene Befehle (`pending`): jeder davon braucht einen
  verständlichen Zustand mit einem nächsten Schritt.
- Ehrliche Grenzen: Spotify-Kontingent oder 429 mit echter Wartezeit, kein
  Gerät, offline, fremde Wiedergabe, Spotify-eigenes Shuffle oder Smart
  Shuffle, nicht-Premium. Keine erfundenen Wartezeiten oder Restbudgets.
- Die Vorschau kommender Songs liest den gespeicherten Plan. Sie löst keine
  zusätzlichen Spotify-Aufrufe aus und täuscht keine Übereinstimmung vor.

## 6. Konkrete UX-Probleme als Startpunkt (bitte mit dem Besitzer bestätigen)

Diese Beobachtungen stammen aus dem Gespräch vom 2026-10-08:
- Fachsprache statt Alltagssprache: „Gedächtnis“, „Startwissen“, „Runde“,
  „Sendersuchlauf“, „Bedienflächen“, Platzangaben.
- Die Import-Seite zeigt Rohzahlen (14.753 Songs, 91.210 mal gehört, 9.590
  früh übersprungen), sagt aber nicht, **was sich für den Nutzer ändert**.
  Nach dem Import fehlt eine Bestätigung, was nun anders ist.
- Wichtiges liegt verstreut im Menü (Geräte, Verlauf, Import, Gäste,
  Fernbedienung, Diagnose, Gestaltung).
- Sechs Designs zur Wahl verschieben die Gestaltungsentscheidung auf den
  Nutzer.
- Verlauf auf dem iPhone (Screenshot 2026-10-08): Die Uhrzeit-Spalte ist zu
  schmal, „09:1“ überlappt den Songtitel und die Künstlerzeile. Sie braucht
  eine feste, ausreichend breite Spalte mit nicht umbrechender Zeit.
- Der Verlauf zeigt doppelte Einträge (bekannter, noch nicht vollständig
  geklärter Backend-Fall, siehe §9). Das ist kein UI-Fehler, aber die
  Oberfläche darf ihn nicht verstärken.

Erster Schritt im neuen Chat: In wenigen Fragen mit dem Besitzer klären, was
ihn im Alltag stört (Auto, Arbeit, unterwegs; Blick auf das Handy für
Sekunden). Erst dann die Informationsarchitektur entwerfen.

## 7. Vorgehen

1. Prüfe den Ist-Stand: Branch, `git log`, laufe `npm ci`, `npm run build`,
   `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`.
   Schaue die echte Oberfläche lokal mit FakeSpotify an, so wie es
   `playwright.config.ts` tut: `node e2e/fake-server.ts` (Port 8788) und
   `npx vite build && npx wrangler dev -c wrangler.e2e.jsonc --port 8787`.
   Mache Screenshots auf Handy und Desktop, hell und dunkel.
2. Befrage den Besitzer kurz (§6). Entwirf dann die Informationsarchitektur:
   Startbildschirm, Navigation, Sender, Einstellungen, Verlauf, Import, Geräte.
   Die drei Leitfragen aus `MISSION.md` bleiben: Was läuft weiter? Wo spielt
   es? Was kommt als Nächstes?
3. Zeige dem Besitzer einen gerenderten ersten Bildschirm (echte Daten aus
   FakeSpotify, Handy), bevor du alles umsetzt. Nutze dafür den
   Impeccable-Skill `.agents/skills/impeccable/SKILL.md`.
4. Setze es als **ein** zusammenhängendes System um. Die Design-Auswahl
   entfällt oder bleibt höchstens als Hell/Dunkel bestehen.
5. Tests: Die funktionalen Prüfungen in `e2e/app.spec.ts`,
   `e2e/client-playback.spec.ts` und `e2e/recovery.spec.ts` bleiben inhaltlich
   erhalten (Selektoren dürfen sich ändern, die geprüften Abläufe nicht).
   `e2e/designs.spec.ts` und `e2e/capture.spec.ts` dürfen für das neue System
   ersetzt werden. Alle Unit- und Worker-Tests unter `test/**` bleiben
   unverändert grün.
6. Barrierefreiheit: iPhone Safari, Tastatur, Screenreader-Beschriftungen,
   reduzierte Bewegung, lange deutsche Texte, Touch-Ziele ab 44 px.
7. Aktualisiere `DESIGN.md` und `docs/BRAND.md` nach dem fertigen Stand.

## 8. Abnahme

- Grün: Build, Typecheck, Lint, `npm test`, `npm run test:e2e` und
  `wrangler deploy --dry-run` (entspricht der CI `verify`).
- Screenshots aller Hauptabläufe (Handy und Desktop, hell und dunkel)
  einschließlich der Zustände Laden, leer, kein Gerät, extern, offline,
  Kontingent und unbestätigt.
- PR gegen `codex/implement-cloudflare-restart`. Release nur auf
  ausdrückliche Freigabe des Besitzers. Danach den Produktions-Build und die
  aktive Version im Cloudflare-Dashboard prüfen (der Besitzer kann Screenshots
  schicken). Echte iPhone- und Spotify-Abnahme durch den Besitzer bleibt
  `NOT_RUN`, bis er sie selbst gemacht hat.

## 9. Offene Punkte aus der letzten Sitzung (nicht Teil des UI-Auftrags)

- Doppelte Plays im Verlauf (z. B. Merry Christmas am 6.10. um 22:19 laut
  Spotify, zusätzlich 22:26 von true-shuffle). Teilweise behoben
  (`SAME_PLAY_SLACK_MS`); die Restursache braucht Worker-Logs.
- Der Test „a turned-down song is skipped after a weekend…“ überschreitet
  lokal knapp sein 20-s-Limit. Das war schon vor `5ea6f6d` so; in der CI
  läuft er grün.
- Vorschau-Builds bei Cloudflare scheitern („Previews Base“ → Root directory).
- Hörverlauf-Import am 2026-10-08: 14.753 Songs, 91.210 Plays, 9.590 frühe
  Skips aus 15 Dateien (6.11.2014–26.09.2026). Das wurde gegen den Export
  nachgerechnet und stimmt exakt.
