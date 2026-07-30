# Auftrag: true-shuffle auf Fly.io fertig einrichten und mit Spotify verbinden

> **So benutzt du das:** Kopier den kompletten Text ab „--- AB HIER KOPIEREN ---"
> in einen neuen Claude-Chat, der Zugriff auf deinen Browser hat.
> Sei vorher in Chrome bei **fly.io** und beim **Spotify Developer Dashboard**
> eingeloggt.

---

--- AB HIER KOPIEREN ---

Du hast Zugriff auf meinen Chrome-Browser. Bitte richte für mich eine
Web-Anwendung auf Fly.io zu Ende ein und verbinde sie mit Spotify. Ich bin in
beiden Diensten bereits eingeloggt.

## Was das ist

**true-shuffle** — eine FastAPI-App (Python), die eine Playlist wie einen
Kartenstapel abspielt: jeder spielbare Titel genau einmal pro Durchlauf, keine
Wiederholung, exaktes Fortsetzen. Der Ton kommt immer vom Streamingdienst, die
App entscheidet nur, was als Nächstes kommt.

* GitHub-Repo: `MikaMcFlurry/true-shuffle-PoC`
* **Branch: `claude/true-shuffle-mvp-streaming-52jofw`** — nicht `main`.
  `main` ist 11 Commits zurück und enthält weder `Dockerfile` noch `fly.toml`.
  Ich habe den Branch in Fly bereits ausgewählt.
* Im Repo liegen fertig: `Dockerfile`, `fly.toml`, `DEPLOY.md` (ausführlich),
  `TESTEN.md` (Testplan).

## Stand

Ich habe auf Fly.io über die Website ein Deployment aus dem Repo gestartet und
komme nicht weiter. Bitte schau dir an, wo es hängt, und führe es zu Ende.

## Was zu tun ist

### 1. Fly.io: den Stand aufnehmen

Öffne das Fly-Dashboard und stell fest:

* Existiert die App schon? Wie heißt sie genau? (Der Name bestimmt die URL:
  `https://<name>.fly.dev`)
* Gab es einen Build? Ist er fehlgeschlagen? **Lies die Build-Logs und sag mir
  wörtlich, was dort steht.**
* Existiert bereits ein Volume namens `true_shuffle_data`?

### 2. Fly.io: Volume anlegen (sehr wahrscheinlich der Knackpunkt)

`fly.toml` deklariert:

```toml
[mounts]
  source = "true_shuffle_data"
  destination = "/data"
```

**Wenn dieses Volume nicht existiert, schlägt jeder Deploy fehl.** Die Web-UI
legt es nicht automatisch an.

Leg es an: **Volumes → Create Volume**
* Name: `true_shuffle_data`
* Region: **dieselbe wie die App** (in `fly.toml` steht `fra` = Frankfurt)
* Größe: **1 GB**

Das Volume ist die Festplatte. Ohne sie wären nach jedem Deploy alle
verbundenen Konten und Läufe weg.

### 3. Fly.io: Secrets setzen

Unter **Secrets** genau diese drei anlegen:

| Name | Wert |
|---|---|
| `SECRET_KEY` | **Frag mich danach.** Ich erzeuge ihn selbst — schreib ihn nicht in den Chat und denk dir keinen aus. |
| `SPOTIFY_CLIENT_ID` | Kommt aus Schritt 5. Kann auch danach gesetzt werden. |
| `ACCESS_CODE` | **Frag mich danach.** Ein gemeinsamer Zugangscode für meine Tester. |

Optional, damit meine Tester auch ohne Spotify etwas sehen können:

| `ENABLE_DEMO_PROVIDER` | `true` |

> **`BASE_URL` NICHT setzen.** Die App leitet die öffentliche Adresse selbst aus
> `FLY_APP_NAME` ab. Ein manueller Wert hier ist die häufigste Fehlerquelle.
> Nur bei einer eigenen Domain wäre er nötig.

### 4. Fly.io: deployen und prüfen

Deploy auslösen. Danach prüfen:

* `https://<name>.fly.dev/health` muss `{"status":"ok","version":"0.2.0"}`
  liefern. **Das ist der schnellste Test, ob die App überhaupt läuft.**
* `https://<name>.fly.dev/` muss die Seite **„Geschlossene Beta"** mit einem
  Feld *Zugangscode* zeigen (falls `ACCESS_CODE` gesetzt ist).

Wenn der Build scheitert: Logs lesen, mir den Text zeigen. Rat nicht.

### 5. Spotify Developer Dashboard

Öffne https://developer.spotify.com/dashboard

**Falls noch keine App existiert:** *Create app*
* Name: beliebig, z. B. `true-shuffle`
* **Which API/SDKs:** **Web API** ankreuzen
* **Redirect URI** — exakt, dann **Add** klicken:
  ```
  https://<fly-app-name>.fly.dev/auth/spotify/callback
  ```
  Setz `<fly-app-name>` durch den echten Namen aus Schritt 1.

**Falls die App schon existiert:** *Settings* → *Redirect URIs* → obige Adresse
**ergänzen** (vorhandene stehen lassen, Spotify erlaubt mehrere).

Ein *Client Secret* wird **nicht** gebraucht — die App nutzt PKCE.
**Kopier die Client ID** und setz sie in Fly als `SPOTIFY_CLIENT_ID`
(Schritt 3). Danach startet Fly die App neu.

> `localhost` als Redirect-URI ist bei Spotify verboten; HTTP ist nur für
> ausdrückliche Loopback-IPs erlaubt. Unsere Fly-URL ist HTTPS, das passt.

### 6. Spotify: Tester freischalten

*Settings* → **User Management** → **Add new user**

Frag mich nach Name und **Spotify-E-Mail-Adresse** meines Bruders und meines
Kumpels und trag beide ein.

> Spotify: „Up to 5 authenticated Spotify users can use an app that is in
> development mode." Ohne Freischaltung bekommen sie **403**.
> Außerdem: **der App-Besitzer (ich) braucht Spotify Premium**, sonst
> funktioniert die App im Entwicklungsmodus für niemanden.

### 7. Abschlusstest

Öffne `https://<name>.fly.dev`, gib den Zugangscode ein, dann:

1. **Dienste** → Spotify muss auf *Nicht verbunden* stehen (nicht auf *Nicht
   eingerichtet* — sonst fehlt `SPOTIFY_CLIENT_ID`).
2. **Spotify verbinden** → Spotifys Zustimmungsseite → *Agree*.
3. Zurück in der App muss Spotify auf **Verbunden** stehen, mit meinem
   Kontonamen und Tarif.
4. **Sammlung** → meine echten Playlists müssen erscheinen.

Wenn das steht, sag mir:
* die fertige URL,
* dass Spotify verbunden ist,
* und was von Schritt 1–7 **nicht** geklappt hat.

## Regeln

* **Schreib keine Secrets in den Chat** und erfinde keine. Frag mich.
* **Ändere nichts am Code** und pushe nichts. Alles Nötige liegt im Repo.
* **Rate nicht bei Fehlern.** Log lesen, Text zeigen.
* Wenn du an eine Bezahlschranke oder eine Kreditkartenabfrage kommst: **halt
  an und frag mich**, führ das nicht selbst aus.

## Häufigste Fehler

| Symptom | Ursache |
|---|---|
| Deploy bricht mit *volume not found* ab | Schritt 2 — Volume fehlt oder liegt in einer anderen Region als die App. |
| `INVALID_CLIENT: Invalid redirect URI` | Die URI im Spotify-Dashboard und `https://<fly-app>.fly.dev/auth/spotify/callback` stimmen nicht zeichengenau überein. |
| App zeigt *Nicht eingerichtet* statt *Nicht verbunden* | `SPOTIFY_CLIENT_ID` fehlt oder die App wurde danach nicht neu gestartet. |
| **403** beim Verbinden | Konto nicht unter *User Management* freigeschaltet — oder der Besitzer hat kein Premium. |
| Nach dem Deploy sind alle Konten weg | Volume nicht gemountet. |
| Build findet kein `Dockerfile` | Falscher Branch. Es muss `claude/true-shuffle-mvp-streaming-52jofw` sein, nicht `main`. |

--- BIS HIER KOPIEREN ---

---

## Was du selbst vorbereiten solltest

**1. Den `SECRET_KEY` erzeugen** — nicht von einem Chat erzeugen lassen, sonst
steht er in einem Protokoll:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Kein Python zur Hand? Jeder Passwortmanager tut es, 40+ zufällige Zeichen.

> Dieser Schlüssel signiert die Sitzungen **und** verschlüsselt die
> gespeicherten Spotify-Tokens. Änderst du ihn später, sind alle Konten
> getrennt und müssen neu verbunden werden.

**2. Einen `ACCESS_CODE` ausdenken** — den bekommen deine Tester zusammen mit
dem Link. Etwas Merkbares reicht, z. B. `plattenschrank-2026`.

**3. Die Spotify-E-Mail-Adressen** deines Bruders und deines Kumpels
bereitlegen — es muss die Adresse ihres **Spotify-Kontos** sein.

**4. Prüfen, ob du Spotify Premium hast.** Ohne Premium beim App-Besitzer
funktioniert eine Development-Mode-App für niemanden — auch der Handoff-Modus
nicht. Das ist Spotifys Regel.

## Wenn der neue Chat nicht weiterkommt

Schick mir hierher:
* den Text aus den Fly-**Build-Logs**,
* den genauen App-Namen,
* und was `https://<name>.fly.dev/health` antwortet.

Damit kann ich die Ursache eingrenzen, ohne deinen Browser zu sehen.
