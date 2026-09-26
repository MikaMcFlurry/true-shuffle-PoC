# True Shuffle

Deine Spotify-Playlists als **Sender mit Gedächtnis**. Du tippst auf einen Sender, Spotify spielt, und True Shuffle sorgt dafür, dass

1. **kein Fortschritt verloren geht**: Jeder gehörte Song landet im Gedächtnis, egal ob über True Shuffle, direkt in Spotify, im Auto oder an der Box.
2. **nichts schnell wiederkommt**: Gehörtes bleibt draußen, bis die Runde durch ist.
3. **irgendwann jeder Song drankommt**: Bei 10.000 Songs eben alle 10.000, lange nicht Gehörtes zuerst.
4. **Favoriten öfter kommen, aber nicht zu oft**: standardmäßig höchstens einmal pro Woche, einstellbar.
5. **Neues dazukommt**: Songs von Künstlern, die du magst, dazu Neuerscheinungen, Last.fm, Deezer und KI-Vorschläge. Jeder Vorschlag wird vorher auf Spotify geprüft.

Frühes Überspringen (unter 30 Sekunden) heißt „nicht jetzt, und seltener". Daumen runter heißt „nie wieder". Der **Gast-Modus** ignoriert alles, was läuft, und schaltet sich nach einer eingestellten Zeit selbst ab.

## Wie es funktioniert

Jeder Sender ist eine private Playlist „True Shuffle · <Sender>" in deinem Spotify-Konto. True Shuffle schreibt sie aus deinem Gedächtnis neu, und zwar nur dann, wenn gerade niemand zuhört. Spotify spielt sie ganz normal mit ausgeschaltetem Shuffle ab. Deshalb funktioniert es auf jedem Gerät, auch im Auto, und auch, wenn du die Playlist direkt in Spotify startest. Spotifys Warteschlangen-API muss dafür nicht dauerhaft mitlaufen.

Im Hintergrund schaut ein Durable Object pro Hörer nach, was läuft und was gelaufen ist: während ein Sender spielt nach jedem Song, sonst seltener. Daraus erkennt es Durchläufe, frühe Skips und Musik außerhalb von True Shuffle und plant die nächste Reihenfolge. Die Entscheidungen dahinter stehen in [docs/adr/ADR-006-cloudflare-neustart.md](docs/adr/ADR-006-cloudflare-neustart.md).

## Stand

Release-Kandidat. Alles ist gegen einen simulierten Spotify-Server getestet (Unit-, Szenario- und End-to-End-Tests). Der Test mit einem echten Spotify-Konto steht noch aus, dafür gibt es die Checkliste [docs/LIVE_TEST.md](docs/LIVE_TEST.md).

- Voraussetzung: **Spotify Premium**, denn Spotify erlaubt das Fernsteuern der Wiedergabe nur mit Premium.
- Bis zu **5 Konten** (Spotifys Grenze für Apps im Entwicklungsmodus).

## Einrichten

Schritt für Schritt: **[docs/SETUP.md](docs/SETUP.md)** (Cloudflare Workers, kostenloser Plan, Deploy per Git-Push).

## Entwickeln

```sh
npm install
npm test            # Unit- und Szenario-Tests (vitest)
npm run test:e2e    # End-to-End: echter Worker + Spotify-Attrappe (Playwright)
npm run typecheck
npm run lint
```

Lokal mit der Spotify-Attrappe und synthetischen Demodaten:

```sh
node e2e/fake-server.ts                                  # Attrappe auf :8788
npm run build && npx wrangler dev -c wrangler.e2e.jsonc  # App auf :8787
```

Lokal gegen das echte Spotify: `.dev.vars` mit `SPOTIFY_CLIENT_ID` und `APP_SECRET` anlegen, `http://127.0.0.1:8787/auth/callback` in der Spotify-App als Redirect-URI eintragen und `npm run dev` starten. Workers AI läuft dabei in der Cloud, deshalb vorher einmal `npx wrangler login`.

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `src/core/` | Reine Fachlogik: Gedächtnis, Mischung, Planer, Deck-Abgleich, Hörverlauf |
| `src/worker/hub/` | `HubCore`: Sync, Decks, Jobs und Entdeckungen je Hörer (SQLite im Durable Object) |
| `src/worker/spotify/` | Spotify-Web-API-Client (PKCE, Budget, Fehlerarten) |
| `src/worker/index.ts` | Hono-Worker: Anmeldung, API, Cron |
| `src/worker/userhub.ts`, `registry.ts` | Durable Objects |
| `src/client/` | Oberfläche (Preact): „Autoradio-Senderspeicher" |
| `test/` | Unit-Tests, Hub-Szenarien gegen die Spotify-Attrappe (`test/fakes/`) |
| `e2e/` | Playwright-Suite und Attrappen-Server |
| `DESIGN.md`, `PRODUCT.md` | Gestaltungssystem und Produktbild |

## Geschichte

Bis Commit `db73bc5` war True Shuffle ein Python-Prototyp auf Fly.io. Er wurde verworfen, weil sich seine Spotify-Anbindung nicht zuverlässig machen ließ. Der Code ist in der Git-Historie weiterhin einsehbar.
