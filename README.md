# true-shuffle

Deine Spotify-Playlists als **Sender mit Gedächtnis**. Du tippst auf einen Sender, Spotify spielt, und true-shuffle sorgt dafür, dass

1. **kein Fortschritt verloren geht**: Jeder gehörte Song landet im Gedächtnis, egal ob über true-shuffle, direkt in Spotify, im Auto oder an der Box. Nur in einer privaten Sitzung von Spotify zählt true-shuffle, was es selbst laufen sieht; die App sagt es dann. Ob Spotify einen Song meldet, den ein neuer Start mittendrin ersetzt, ist noch ungeprüft (siehe `docs/LIVE_TEST.md`); true-shuffle zählt ihn dann selbst, sofern es ihn mindestens 30 Sekunden laufen sah.
2. **nichts schnell wiederkommt**: Gehörtes bleibt draußen, bis die Runde durch ist.
3. **irgendwann jeder Song drankommt**: Bei 10.000 Songs eben alle 10.000, lange nicht Gehörtes zuerst. Die Sender-Playlist in Spotify enthält dafür immer nur die nächsten 300 Songs (rund 17 Stunden); true-shuffle schreibt sie neu, wenn gerade niemand sie hört.
4. **Favoriten öfter kommen, aber nicht zu oft**: standardmäßig höchstens einmal pro Woche, einstellbar. Favorit ist, was du mit Daumen hoch markierst oder in Spotify mit einem Herz speicherst (auch im Auto oder auf der Uhr; das zählt binnen etwa zehn Minuten).
5. **Neues dazukommt**: Songs von Künstlern, die du magst, dazu Neuerscheinungen, Last.fm, Deezer und KI-Vorschläge. Jeder Vorschlag wird vorher auf Spotify geprüft.

Frühes Überspringen (unter 30 Sekunden) heißt „nicht jetzt, und seltener". Tippst du in Spotify einen Song an, der bis zu zehn Plätze weiter unten im Sender steht, zählen die Songs dazwischen auch so. Daumen runter heißt „nie wieder". Taucht in einem Sender trotzdem ein Song auf, den true-shuffle dort nicht vorgesehen hat, springt es selbst weiter und sagt es in der App. Das betrifft einen abgelehnten Song, einen heute schon gehörten aus einer alten Reihenfolge des Handys, und heute schon gehörte Songs, wenn jemand die Playlist in Spotify von oben startet. Was du selbst antippst oder in die Warteschlange legst, lässt es in Ruhe, mit zwei Ausnahmen. Die erste ist ein Song, der heute schon lief und in den letzten 36 Stunden in einer Version genau dieses Senders stand, die dein Handy geladen hatte. Die zweite ist ein Song ganz vorn in einer fortgesetzten Playlist. Der **Gast-Modus** ignoriert alles, was läuft, auch den Song, der beim Einschalten gerade spielt, und schaltet sich nach einer eingestellten Zeit selbst ab. Den Song, der beim Ausschalten läuft oder pausiert ist, zählt es nur, wenn es dich danach mindestens 30 Sekunden davon hören sieht.

Bewerten geht auch nachträglich: Jeder Song im Verlauf und auf der Sender-Seite lässt sich antippen und mit Daumen hoch oder runter markieren. Unterwegs gibt es die **Fernbedienung** (Menü → Fernbedienung): ein persönlicher Schlüssel für drei Befehle an den laufenden Song, nämlich Favorit, Nie wieder und Weiter. Damit gehen Siri-Kurzbefehle auf dem iPhone, per Sprache in CarPlay, auf der Apple Watch und als Widget, unter Android etwa mit „HTTP Shortcuts“. Android Auto lässt keine eigenen Knöpfe von Web-Apps zu; dort und auf anderen Uhren zählt das Herz in Spotify.

## Wie es funktioniert

Jeder Sender ist eine private Playlist „true-shuffle · <Sender>" in deinem Spotify-Konto. true-shuffle schreibt sie aus deinem Gedächtnis neu, und zwar nur dann, wenn gerade niemand zuhört. Spotify spielt sie ganz normal mit ausgeschaltetem Shuffle ab. Deshalb funktioniert es auf jedem Gerät, auch im Auto, und auch, wenn du die Playlist direkt in Spotify startest. Spotifys Warteschlangen-API muss dafür nicht dauerhaft mitlaufen.

Im Hintergrund schaut ein Durable Object pro Hörer nach, was läuft und was gelaufen ist: während ein Sender spielt nach jedem Song, sonst seltener. Daraus erkennt es Durchläufe, frühe Skips und Musik außerhalb von true-shuffle und plant die nächste Reihenfolge. Die Entscheidungen dahinter stehen in [docs/adr/ADR-006-cloudflare-neustart.md](docs/adr/ADR-006-cloudflare-neustart.md).

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

Bis Commit `db73bc5` war true-shuffle ein Python-Prototyp auf Fly.io. Er wurde verworfen, weil sich seine Spotify-Anbindung nicht zuverlässig machen ließ. Der Code ist in der Git-Historie weiterhin einsehbar.
