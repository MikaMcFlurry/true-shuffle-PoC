# true-shuffle einrichten

Du brauchst etwa 20 Minuten. Du brauchst:

- ein Cloudflare-Konto (der kostenlose Plan reicht),
- Zugriff auf dieses GitHub-Repository,
- die bestehende Spotify-App im [Spotify Developer Dashboard](https://developer.spotify.com/dashboard),
- Spotify Premium für alle, die true-shuffle nutzen.

Die alten Daten vom Fly.io-Prototyp werden nicht übernommen. true-shuffle startet mit leerem Gedächtnis. Mit dem Hörverlauf-Import (Schritt 7) füllst du es in Minuten wieder.

## 1. Code auf den Produktionszweig bringen

Cloudflare baut bei jedem Push auf den Produktionszweig, normalerweise `main`. Führe den Zweig mit dem neuen true-shuffle (`claude/true-shuffle-spotify-95zw0m`) per Pull Request in `main` zusammen. Alternativ stellst du in Schritt 2 diesen Zweig als Produktionszweig ein.

## 2. Worker in Cloudflare anlegen (Workers Builds)

1. Cloudflare-Dashboard → **Workers & Pages** → **Create application** → neben **Import a repository** auf **Get started**.
2. GitHub-Konto wählen, dann das Repository `true-shuffle-PoC`.
3. Einstellungen:
   - **Project name:** `true-shuffle`. Der Name muss exakt dem `name` in `wrangler.jsonc` entsprechen, sonst schlägt der Build fehl.
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy`
   - **Root directory:** leer lassen (Repository-Wurzel)
4. **Save and Deploy**. Der erste Build dauert ein bis zwei Minuten.

Danach läuft true-shuffle unter `https://true-shuffle.<dein-subdomain>.workers.dev`. Die Adresse steht auf der Übersichtsseite des Workers. Solange Schritt 3 fehlt, zeigt die Seite „Noch nicht eingerichtet".

## 3. Variablen und Secrets setzen

Worker → **Settings** → **Variables and Secrets** → **Add**:

| Name | Typ | Wert |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` | Text | Client ID deiner Spotify-App |
| `APP_SECRET` | **Secret** | mindestens 32 zufällige Zeichen, z. B. von `openssl rand -base64 48` |
| `ALLOWED_SPOTIFY_IDS` | Text, optional | kommagetrennte Spotify-Benutzer-IDs, die true-shuffle nutzen dürfen (leer: alle, die Spotify zulässt). Wer entfernt wird, ist sofort abgemeldet. |
| `LASTFM_API_KEY` | Secret, optional | kostenloser Schlüssel von [last.fm/api](https://www.last.fm/api/account/create), bessere Entdeckungen |
| `ANTHROPIC_API_KEY` | Secret, optional | für KI-Vorschläge mit Claude (siehe unten); ohne Schlüssel nutzt true-shuffle kostenlos Workers AI |
| `ANTHROPIC_MODEL` | Text, optional | Standard: `claude-sonnet-5` |
| `PUBLIC_URL` | Text, optional | nur bei eigener Domain, z. B. `https://radio.example.de` |

Mit **Deploy** übernehmen. Deploys aus Git überschreiben diese Werte nicht, dafür sorgt `keep_vars` in `wrangler.jsonc`.

> `APP_SECRET` verschlüsselt die Spotify-Zugänge und signiert die Anmeldung. Ändert es sich, müssen sich alle neu anmelden. Das Gedächtnis bleibt dabei erhalten.

## 4. Spotify-App anpassen

[Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → deine App → **Settings** → **Edit**:

1. **Redirect URIs:** `https://true-shuffle.<dein-subdomain>.workers.dev/auth/callback` hinzufügen. Die Adresse muss exakt stimmen, einschließlich `https` und ohne Schrägstrich am Ende. Die alte Fly.io-Adresse kannst du entfernen.
2. **APIs used:** Web API.
3. **User Management:** alle eintragen, die mitmachen sollen (Name und E-Mail ihres Spotify-Kontos). Im Entwicklungsmodus erlaubt Spotify höchstens 5 Konten. Wer hier fehlt, sieht beim Anmelden „nicht freigeschaltet".

## 5. Prüfen

1. `https://true-shuffle.<dein-subdomain>.workers.dev/api/health` öffnen. Erwartet: `"configured": true`.
2. Die Startseite öffnen und **Mit Spotify anmelden**.
3. Im **Sendersuchlauf** die Playlists wählen, die Sender werden sollen. „Alles" kommt automatisch dazu.
4. Spotify auf einem Gerät öffnen und einen Sender antippen. Die Anzeige zeigt Song, Gerät und Grund („Noch nicht gehört in Runde 1").

Den gründlichen Test mit echtem Spotify beschreibt [LIVE_TEST.md](LIVE_TEST.md).

## 6. Auf dem Handy wie eine App

- iPhone: in Safari **Teilen** → **Zum Home-Bildschirm**.
- Android: in Chrome **⋮** → **Zum Startbildschirm hinzufügen**.

## 7. Hörverlauf importieren (empfohlen)

Damit true-shuffle vom ersten Tag an weiß, was du lange nicht gehört hast:

1. [spotify.com](https://www.spotify.com/account/privacy/) → Konto → Datenschutz → **Erweiterter Streamingverlauf** anfordern. Spotify schickt die Dateien per Mail (bis zu 30 Tage).
2. In true-shuffle: **Menü** → **Import** → alle `Streaming_History_Audio_…json` auf einmal auswählen.

Die Dateien werden im Browser ausgewertet. Hochgeladen wird nur, wie oft und wann du welchen Song gehört hast.

## 8. Fly.io abschalten

Wenn alles läuft, kannst du den alten Prototyp löschen:

```sh
fly apps list
fly apps destroy <name-der-alten-app>
```

## KI-Vorschläge: was sie kosten

- **Ohne `ANTHROPIC_API_KEY`:** Workers AI (Llama 3.3), die Vorschläge sind brauchbar. Eine Anfrage kostet rund 150–200 „Neurons". Das kostenlose Kontingent (10.000 pro Tag) reicht also für etwa 50 Anfragen täglich, bei einer Anfrage pro Sender und Tag für rund 50 Sender über alle Konten. Ist es an einem Tag aufgebraucht, fehlen nur an diesem Tag die KI-Vorschläge. Die übrigen Quellen laufen weiter.
- **Mit `ANTHROPIC_API_KEY`:** Claude Sonnet 5 (2 $ / 10 $ pro Million Token Ein-/Ausgabe) liefert deutlich treffendere Vorschläge. Pro Sender läuft etwa einmal am Tag eine Anfrage mit rund 1.000 Token. Bei 5 Sendern sind das grob 1–3 US$ im Monat.

Jeder Vorschlag wird vor der Aufnahme in Spotify gesucht. Erfundene Songs kommen nie in einen Sender.

## Grenzen des kostenlosen Plans

true-shuffle ist auf den kostenlosen Workers-Plan ausgelegt:

- Pro Aufruf höchstens 40 Anfragen an externe Dienste (die Grenze liegt bei 50).
- Höchstens 30 Sender pro Konto. So bleiben auch 5 Konten mit großen Bibliotheken bei höchstens rund einem Drittel der täglichen Kontingente.
- Gedächtnis und Bibliothek werden in Blöcken gespeichert, damit die SQLite-Kontingente der Durable Objects (Zeilen pro Tag) auch bei 10.000er-Playlists reichen.
- Solange ein Sender läuft, schaut true-shuffle nach jedem Song nach (bei langen Songs spätestens alle 4 Minuten). In einer privaten Sitzung von Spotify überall, dann alle 30 Sekunden, auch pausiert (nach einer halben Stunde Pause alle 2 Minuten, bis zu 6 Stunden), und in den 7 Tagen danach mindestens alle 2 Minuten. Hält ein Player einen Sender pausiert, alle 30 Sekunden bis jede Minute, später alle 2 Minuten. Sonst seltener, nach 6 Stunden Stille nur noch stündlich.

## Wenn etwas nicht klappt

| Meldung | Ursache und Lösung |
| --- | --- |
| „Noch nicht eingerichtet: …" | Variable aus Schritt 3 fehlt, oder `APP_SECRET` ist kürzer als 32 Zeichen. |
| Spotify: „INVALID_CLIENT: Invalid redirect URI" | Die Redirect-URI aus Schritt 4 weicht ab (http statt https, Schrägstrich, falsche Subdomain). |
| „Dieses Spotify-Konto ist für true-shuffle nicht freigeschaltet" | Konto fehlt in der User Management (Schritt 4) oder in `ALLOWED_SPOTIFY_IDS`. |
| „Spotify erlaubt das Starten nur mit Premium." | Das Konto hat kein Premium. |
| „Kein Spotify-Gerät aktiv …" | Spotify auf einem Gerät öffnen (einmal kurz abspielen hilft) und erneut tippen. |
| „Spotify-Kontingent aufgebraucht …" | Spotify hat die App für eine Weile gebremst. true-shuffle pausiert selbst und macht danach weiter. |
| Build schlägt fehl: Worker-Name | Project name in Cloudflare muss `true-shuffle` sein. |

Logs: Worker → **Observability** (ist in `wrangler.jsonc` eingeschaltet).
