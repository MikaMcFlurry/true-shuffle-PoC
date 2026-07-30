# DEPLOY.md — true-shuffle online stellen

Ziel: eine feste HTTPS-Adresse, die du deinem Bruder und deinem Kumpel schicken
kannst, und die als Redirect-URI bei Spotify funktioniert.

---

## Warum Fly.io und nicht Vercel

Das ist keine Geschmacksfrage, sondern folgt aus zwei Eigenschaften dieser App:

**1. Der Watcher ist ein Dauerläufer.** `app/watcher.py` fragt alle paar
Sekunden nach, ob der Titel zu Ende ist, und rückt den Trennstreifen weiter.
Genau das macht die Zusage *„Tab zu, der Lauf läuft weiter"* bei Spotify wahr.
Vercel führt Funktionen nur pro Request aus und beendet sie danach — der
Watcher würde dort gar nicht existieren.

**2. Die Karten-Sperre lebt im Prozess.** In `app/runs.py`:

```python
_advance_locks: Dict[int, asyncio.Lock] = {}
```

Ihr eigener Kommentar nennt den Fehler, den sie verhindert, *„the single
nastiest bug class in this design"*: der Browser meldet „Titel zu Ende" und der
Watcher merkt es im selben Moment — und ein Song verbraucht zwei Karten. Diese
Sperre wirkt **nur innerhalb eines Prozesses**. Auf einer Plattform, die
mehrere Instanzen parallel startet, schützt sie nichts mehr.

Deshalb: **ein Prozess, eine Maschine.** Das steht so in `fly.toml` und ist
dort auch als Korrektheitsanforderung kommentiert, nicht als Sparmaßnahme.

Auf Fly.io läuft die App **ohne eine einzige Codeänderung**. Ein Vercel-Umbau
wären ~1.000 Zeilen an der heikelsten Stelle des Projekts (SQLite → Postgres,
Watcher → Cron, asyncio-Sperre → Datenbank-Sperre) — inklusive der Regel, auf
der das ganze Produkt steht.

> Für die **Landing-Page** (`true-shuffle-site`, reines HTML) ist Vercel dagegen
> ideal. Nur der MVP selbst gehört auf einen echten Prozess.

---

## Was es kostet

Geprüft auf fly.io/docs/about/pricing, Juli 2026:

| Posten | Preis |
|---|---|
| `shared-cpu-1x`, 512 MB, Europa | **3,32 $/Monat** |
| Volume, 1 GB | **0,15 $/Monat** |
| **Summe** | **≈ 3,50 $/Monat** (~3,20 €) |

**Kein Free Tier mehr für neue Konten**, aber auch **keine Mindestgebühr** —
abgerechnet wird anteilig nach Laufzeit. Wenn der Test nach einer Woche vorbei
ist und du die App löschst, zahlst du ungefähr einen Euro.

Kreditkarte ist bei der Registrierung nötig.

---

## Was hiervon geprüft ist

Ehrlichkeitshalber, weil der Unterschied zählt:

| | |
|---|---|
| ✅ **Geprüft** | Der Startbefehl aus dem `Dockerfile` — mit derselben Umgebung, die Fly setzt (nur Secrets, `DB_PATH` auf dem Volume-Pfad, `BASE_URL` auf `https://…`). Health-Check grün, Datenbank auf dem Volume angelegt, Zugangsseite da, keine Fehler im Log. |
| ✅ **Geprüft** | `fly.toml` ist gültiges TOML mit den Werten, die dort stehen sollen. |
| ✅ **Geprüft** | Die App baut **keine** URL aus dem Request. Die Redirect-URI kommt fest aus `BASE_URL`, also gibt es hinter Flys TLS-Proxy kein `http://`-Problem — der klassische Fehler an dieser Stelle. |
| ⚠️ **Nicht geprüft** | Der eigentliche `docker build`. In der Umgebung, in der das entstanden ist, läuft kein Docker-Daemon. Das Image ist Standard (`python:3.11-slim`, `pip install -r requirements.txt`), aber der erste `fly deploy` ist der erste echte Build. |
| ⚠️ **Nicht geprüft** | Fly selbst. Kein Konto, kein `flyctl` hier. Die Befehle unten folgen Flys Dokumentation, nicht einem Durchlauf. |

Wenn der erste `fly deploy` an etwas scheitert: `fly logs`, und schick mir die
Ausgabe.

---

## Schritt 1 — Fly-CLI installieren und anmelden

```bash
# macOS / Linux
curl -L https://fly.io/install.sh | sh

# Windows (PowerShell)
pwsh -Command "iwr https://fly.io/install.sh -useb | iex"
```

```bash
fly auth signup     # oder: fly auth login
```

## Schritt 2 — Namen festlegen

Der App-Name bestimmt die URL. `true-shuffle-mvp` ist vermutlich vergeben —
nimm etwas Eigenes, z. B. `true-shuffle-mika`.

**In `fly.toml` an zwei Stellen ändern, und die müssen zusammenpassen:**

```toml
app = "true-shuffle-mika"

[env]
  BASE_URL = "https://true-shuffle-mika.fly.dev"
```

> `BASE_URL` baut die Redirect-URI, die an Spotify geschickt wird. Steht dort
> etwas anderes als im Spotify-Dashboard, bricht der Login mit
> *INVALID_CLIENT: Invalid redirect URI* ab. Das ist der häufigste Fehler
> überhaupt.

## Schritt 3 — App und Volume anlegen

```bash
fly launch --no-deploy --copy-config --name true-shuffle-mika --region fra
fly volumes create true_shuffle_data --region fra --size 1
```

`--no-deploy` ist wichtig: erst müssen die Geheimnisse gesetzt sein.

Das Volume ist die Festplatte. **Ohne sie wäre nach jedem Deploy alles weg** —
verbundene Konten, Läufe, Positionen: die Container-Festplatte wird bei jedem
Deploy neu gebaut.

## Schritt 4 — Geheimnisse setzen

Diese Werte gehören **nicht** in `fly.toml` (die Datei liegt im Git):

```bash
fly secrets set \
  SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')" \
  SPOTIFY_CLIENT_ID="deine_client_id" \
  ACCESS_CODE="ein-code-den-du-verschickst"
```

| Wert | Wofür |
|---|---|
| `SECRET_KEY` | Signiert Sitzungen **und** verschlüsselt die gespeicherten OAuth-Tokens. Ändern trennt alle Konten — die Tokens sind damit nicht mehr lesbar. |
| `SPOTIFY_CLIENT_ID` | Aus dem Spotify-Dashboard. Kein Secret nötig, die App nutzt PKCE. |
| `ACCESS_CODE` | Der gemeinsame Zugangscode (siehe unten). Weglassen = offen für jeden, der die URL kennt. |

Optional, falls die Tester auch ohne Spotify etwas sehen sollen:

```bash
fly secrets set ENABLE_DEMO_PROVIDER=true
```

## Schritt 5 — Deployen

```bash
fly deploy
fly open
```

Erwartet: die Zugangsseite **Geschlossene Beta**.

---

## Schritt 6 — Spotify auf die neue URL umstellen

Im [Spotify-Dashboard](https://developer.spotify.com/dashboard) → deine App →
**Settings** → **Redirect URIs** die neue Adresse **hinzufügen**:

```
https://true-shuffle-mika.fly.dev/auth/spotify/callback
```

Die lokale `http://127.0.0.1:8000/auth/spotify/callback` kannst du daneben
stehen lassen — Spotify erlaubt mehrere. Dann funktioniert beides.

## Schritt 7 — Bruder und Kumpel freischalten

Das ist der Schritt, den man am leichtesten vergisst, und ohne ihn bekommen
beide ein **403**.

Dashboard → deine App → **Settings** → **User Management** → **Add new user**,
mit Name und der **E-Mail-Adresse ihres Spotify-Kontos** (nicht irgendeiner).

> „Up to 5 authenticated Spotify users can use an app that is in development
> mode." — Spotify, *Quota modes*
>
> Du + Bruder + Kumpel = 3. Passt.
>
> Und weiterhin gilt: **du als App-Besitzer brauchst Premium**, sonst
> funktioniert die App im Entwicklungsmodus für niemanden. Ob deine Tester
> Premium haben, entscheidet nur, ob sie den **Live-Modus** nutzen können —
> Handoff geht auch ohne.

## Schritt 8 — Verschicken

Schick beiden **zwei** Dinge:

1. den Link `https://true-shuffle-mika.fly.dev`
2. den `ACCESS_CODE`

Und einen Satz dazu, was sie testen sollen — sonst klicken sie herum und
melden nichts Brauchbares. Vorschlag:

> „Verbinde Spotify, wähl eine große Playlist, starte den Live-Modus, und dann
> **schließ den Tab**. Öffne ihn später wieder — läuft der Lauf da weiter, wo
> die Musik inzwischen ist? Und kommt irgendein Titel doppelt?"

---

## Der Zugangscode

Das README dieses Projekts sagt: *„It has no password login — a browser session
**is** the identity. Do not expose it to the internet as-is."* Genau das tun
wir hier, also braucht es eine Tür.

Was `ACCESS_CODE` leistet: ein gemeinsamer Code, einmal pro Browser abgefragt,
in der signierten Sitzung gemerkt, in konstanter Zeit verglichen.

Was er **nicht** leistet: er ist kein Benutzersystem. Alle Tester teilen sich
einen Code. Er hält Fremde aus einer Beta heraus — mehr nicht.

Die Sitzungen der Tester sind voneinander getrennt: jede Lauf- und
Job-Abfrage ist auf den Besitzer eingegrenzt, ein fremder Lauf ist ein 404
(nicht 403 — das würde bestätigen, dass die ID existiert). Dein Bruder sieht
also deine Läufe nicht, auch wenn ihr denselben Code habt.

---

## Betrieb

```bash
fly logs                 # Live-Logs, hier steht auch was der Watcher tut
fly status               # läuft die Maschine?
fly deploy               # neue Version ausrollen
fly ssh console          # auf die Maschine
fly secrets list         # Namen der gesetzten Werte (nicht die Werte)
```

**Datenbank sichern** (vor größeren Änderungen):

```bash
fly ssh console -C "cat /data/true_shuffle.db" > backup.db
```

**Test beendet, Kosten stoppen:**

```bash
fly apps destroy true-shuffle-mika
```

Das löscht Volume und Daten mit. Vorher exportieren, falls ein Lauf erhalten
bleiben soll — `/runs` → **Exportieren**.

---

## Wenn etwas nicht geht

| Symptom | Ursache |
|---|---|
| `INVALID_CLIENT: Invalid redirect URI` | `BASE_URL` in `fly.toml` und die URI im Spotify-Dashboard stimmen nicht zeichengenau überein. Auf `https://` und den fehlenden Schrägstrich am Ende achten. |
| Tester bekommt **403** beim Verbinden | Nicht im *User Management* freigeschaltet — oder du als Besitzer hast kein Premium. |
| Nach `fly deploy` sind alle Konten weg | Volume nicht gemountet. `fly volumes list` prüfen; `[mounts]` in `fly.toml` muss auf `/data` zeigen und `DB_PATH` dorthin. |
| Der Lauf rückt nicht weiter, wenn der Tab zu ist | `auto_stop_machines` steht auf `true` oder es laufen mehrere Maschinen. `fly status` prüfen; es darf **genau eine** sein. |
| „Zugangscode nötig" bei jedem Klick | Der Browser blockt Cookies von Drittanbietern oder es ist ein privates Fenster mit strikten Einstellungen. |
| App startet nicht | `fly logs` — meist fehlt ein Secret. `SECRET_KEY` ist Pflicht. |

---

## Was das hier **nicht** ist

Ein Produktionsbetrieb. Es fehlen: echte Benutzerkonten, Rate-Limiting,
Backups, Monitoring, DSGVO-Dokumentation für die Tokens, und eine
Löschfunktion für Nutzerdaten. Für drei Leute und zwei Wochen ist das in
Ordnung. Für die Warteliste auf der Landing-Page ist es das nicht.

Und wie überall gilt: dass Spotify hier läuft, ist erst dann eine belegte
Aussage, wenn es jemand mit echten Zugangsdaten getan und in `STATUS.md`
eingetragen hat.
