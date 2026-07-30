# TESTEN.md — true-shuffle MVP Schritt für Schritt prüfen

Diese Anleitung führt einmal durch **alle** Funktionen. Sie ist in zwei Teile
geteilt, und die Reihenfolge ist Absicht:

* **Teil A — Demo-Modus.** Ohne Konto, ohne Anmeldung, in etwa 15 Minuten. Hier
  lässt sich jede Funktion durchspielen: Verbinden, Lesen, Mischen, Live-Modus
  mit automatischem Weiterrücken, Handoff-Modus mit Hörverlauf, Skips, Pause,
  Fortsetzen, Ausschuss-Meldung, Export und Import.
* **Teil B — Echte Dienste.** Spotify, Apple Music, YouTube Music. Das kostet
  Zeit und bei Apple Geld, deshalb steht es hinten.

> **Wichtig zur Aussagekraft.** Was im Demo-Modus funktioniert, beweist, dass
> *true-shuffle* funktioniert — nicht, dass Spotify, Apple Music oder YouTube
> Music funktionieren. Diese drei sind bisher **nicht** mit echten Zugangsdaten
> geprüft worden. Was geprüft ist und was nicht, steht in `STATUS.md`, und dort
> gehört das Ergebnis von Teil B auch hin.

---

## 0. Vorbereitung (einmalig, ca. 3 Minuten)

Gebraucht wird **Python 3.11 oder neuer**. Sonst nichts: kein Node, kein
Docker, keine Datenbank.

```bash
git clone https://github.com/MikaMcFlurry/true-shuffle-PoC.git
cd true-shuffle-PoC
git checkout claude/true-shuffle-mvp-streaming-52jofw

python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Prüfen, dass die Basis steht:

```bash
python -m pytest -q
```

**Erwartet:** `263 passed`. Wenn hier etwas rot ist, lohnt Teil A noch nicht.

---

# TEIL A — Alles ohne Konto testen

## A1. Konfiguration anlegen

Im Projektordner eine Datei `.env` anlegen:

```bash
cp .env.example .env
```

Dann in `.env` **genau diese vier Zeilen** setzen bzw. ändern:

```ini
BASE_URL=http://127.0.0.1:8000

# Signiert die Sitzung und verschlüsselt gespeicherte Tokens.
SECRET_KEY=<hier den Wert aus dem Befehl unten einsetzen>

# Der Demo-Dienst. Standardmäßig aus.
ENABLE_DEMO_PROVIDER=true

# Nur fürs Testen: der Handoff-Abgleich läuft sonst nur einmal pro Minute.
HISTORY_POLL_SECONDS=10
```

Den Schlüssel erzeugen:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

> Solange `SECRET_KEY` auf dem Standardwert steht, warnt die Startseite in einem
> roten Kasten. Das ist gewollt — bitte einmal absichtlich stehen lassen und
> anschauen (Test **A11**), bevor du einen echten Schlüssel einsetzt.

## A2. Starten

```bash
uvicorn app.main:app --reload
```

Browser öffnen: **http://127.0.0.1:8000**

| | |
|---|---|
| ✅ **Erwartet** | Die Startseite. Rechts oben im Kasten *Beispiel* liegt ein Fach: links flach liegende, gespielte Hüllen, dann der gelbe Trennstreifen, rechts die aufrechten Rücken. |
| ✅ | Unter der Kopfzeile läuft die Betriebszeile: `TON · IMMER ÜBER DEN DIENST` und `CONNECTOREN · 1/5 EINGERICHTET`. |
| ✅ | Unter *02 Dienste* stehen Spotify, Apple Music und YouTube Music auf **Nicht eingerichtet** — mit dem `.env`-Schlüssel, der jeweils fehlt. |
| ✅ | Nur der **Demo-Dienst** steht auf *Bereit*. |

**Ansicht umschalten:** Knopf `Dunkel` / `Hell` rechts oben. Beide Ansichten
sollten vollständig lesbar sein, und die Wahl muss einen Neuladen überleben.

---

## A3. Dienst verbinden (OAuth-Ablauf)

1. Auf **Dienste** klicken.
2. Beim *Demo-Dienst* auf **Demo-Dienst verbinden**.

| | |
|---|---|
| ✅ **Erwartet** | Sofort zurück auf der Sammlung. Der Demo-Dienst steht auf **Verbunden**, im Laufzettel steht Konto `Demo-Konto`, Markt `DE`. |
| ✅ | In der Betriebszeile steht jetzt `KONTEN · 1 VERBUNDEN`. |

> Es öffnet sich absichtlich kein fremdes Fenster — es gibt keinen fremden
> Dienst. Der Rest des Ablaufs (state-Prüfung gegen CSRF, Token-Tausch,
> Konto-Abfrage, verschlüsselte Ablage) läuft aber exakt wie bei einem echten
> Dienst.

**Gegentest CSRF:** Ruf von Hand
`http://127.0.0.1:8000/auth/demo/callback?code=x&state=gefälscht` auf.
✅ **Erwartet:** Fehlerseite, **nicht** ein verbundenes Konto.

---

## A4. Playlists lesen

Auf **Sammlung** gehen.

| | |
|---|---|
| ✅ **Erwartet** | Drei Playlists: **Alles (Demo)** (1.482 Titel), **Kurzes Fach (Demo)** (12), **Mit Ausschuss (Demo)** (20). |
| ✅ | Rechts oben im Kasten steht `3 PLAYLISTS`. |
| ✅ | Ins Filterfeld `kurz` tippen → nur noch eine Zeile, Zähler wechselt auf `1 VON 3`. |

---

## A5. Ausschuss: was nicht ins Fach kommt

Das ist die Kernaussage des Produkts — *„jeder Song“* ist eine Abkürzung, und
hier siehst du, wofür.

1. **Mit Ausschuss (Demo)** anklicken.
2. Rechts die Karte **Live** wählen.
3. **Fach anlegen**.

| | |
|---|---|
| ✅ **Erwartet** | Die Lauf-Seite. Oben groß die Zahl **14**, darunter `von 14 im Fach` — obwohl die Playlist 20 Einträge hat. |
| ✅ | Rechts unten der Kasten **Nicht ins Fach gekommen** mit `6 EINTRÄGE`, aufgeschlüsselt nach Grund: *lokale Datei*, *hier nicht verfügbar*, *kein Musiktitel*, *schon im Fach*. |

> Genau das darf nie als „0 übersprungen“ dargestellt werden. Wenn dieser Kasten
> fehlt oder die Zahlen nicht aufgehen, ist das ein Fehler.

---

## A6. Live-Modus: der Lauf rückt von selbst weiter

Weiter auf derselben Seite (oder neu mit **Kurzes Fach (Demo)** anlegen).

| Schritt | Erwartet |
|---|---|
| Seite ist frisch geladen | Zustand **Bereit**, nicht *Läuft*. Knopf heißt **Lauf starten**, *Pause* ist grau. |
| **Lauf starten** drücken | Zustand wird **Läuft**, Pause wird klickbar, im Laufzettel steht *Nachführung: Rückt selbst weiter*. |
| Jetzt **nichts tun**, ca. 15 Sekunden warten | Die Position im Laufzettel springt von `1 / 12` auf `2 / 12`. Der gelbe Trennstreifen wandert eine Position nach rechts. |
| Weiter warten | Alle ~12 Sekunden eine Karte weiter. |

> Ein Demo-Titel ist 12 Sekunden lang. Das Weiterrücken macht **der Server**,
> nicht der Browser — du kannst den Tab schließen, 30 Sekunden warten, ihn
> wieder öffnen, und der Lauf ist weitergelaufen. Genau so verhält sich Spotify.

**Tastatur** (nur mit Maus/Trackpad sichtbar eingeblendet):
`Leertaste` = Start/Pause · `→` = Überspringen · `←` = Zurück.
✅ **Gegentest:** In das Feld *Abspielen auf* klicken und Leertaste drücken —
der Lauf darf **nicht** reagieren.

---

## A7. Skip, Zurück, Pause, Fortsetzen

| Schritt | Erwartet |
|---|---|
| **Überspringen** | Position +1. Ein Nutzer-Skip verbraucht eine Karte — der übersprungene Titel kommt in diesem Durchlauf **nicht** wieder. |
| **Zurück** | Position −1, der vorige Titel steht wieder unter dem Fach. |
| **Pause** | Zustand **Pausiert**, Pause wird grau, der Hauptknopf heißt wieder *Lauf starten*. Position bleibt stehen — auch nach einer Minute. |
| Seite neu laden (F5) | Zustand **Pausiert**, gleiche Position. Nichts ist verloren. |
| **Lauf fortsetzen** | Es geht auf genau derselben Karte weiter. |

**Der zentrale Test des ganzen Produkts:** Notiere dir die Zahl links oben
(*Karten übrig*), schließe den Tab komplett, öffne
`http://127.0.0.1:8000/runs`, klicke **Fortsetzen**.
✅ **Erwartet:** Exakt dieselbe Position.

---

## A8. Handoff-Modus: Position ohne offenen Tab

Das ist die Hälfte, für die nichts von uns offen bleiben muss.

1. **Sammlung** → **Kurzes Fach (Demo)** → Karte **Handoff** → **Fach anlegen**.

| | |
|---|---|
| ✅ **Erwartet** | Grüner Kasten: *„true-shuffle · Kurzes Fach (Demo)“ steht bereit*, `12 Titel in true-shuffle-Reihenfolge`, und der Hinweis, dass die Position aus dem Hörverlauf kommt. |

2. Jetzt **die Seite verlassen** — auf **Läufe** gehen. Nichts von true-shuffle
   spielt oder beobachtet etwas in deinem Browser.
3. Etwa 15 Sekunden warten, dann die Läufe-Seite neu laden. Mehrfach.

| | |
|---|---|
| ✅ **Erwartet** | Der Zähler im Kopf der Lauf-Karte wandert: `1 / 12 · 8%`, `2 / 12 · 17%`, `3 / 12 · 25%` … |

> Was hier passiert: der Demo-Dienst simuliert einen Hörer, der die
> geschriebene Playlist in seiner App durchhört (alle 8 Sekunden ein Titel).
> true-shuffle liest nur den Hörverlauf zurück und rückt den Trennstreifen
> nach. Genau dieser Weg funktioniert bei Spotify und Apple Music, **nicht**
> bei YouTube Music — dort gibt es keinen Hörverlauf über die API.

---

## A9. Ehrliche Wortwahl prüfen

Auf **Läufe** die Karten vergleichen:

| | |
|---|---|
| ✅ | Ein durchgehörter **Live**-Lauf steht auf **Durch**. |
| ✅ | Ein **Handoff**-Lauf auf einem Dienst ohne Hörverlauf stünde auf **Übergeben** und *Übrig: nicht messbar* — nie auf „Durch“. |
| ✅ | Ein beendeter Lauf steht auf **Beendet**, *Übrig: —*, und seine Transportknöpfe sind alle grau. |

> Der Demo-Dienst hat einen Hörverlauf, deshalb siehst du dort „Durch“. Den
> Fall *Übergeben* siehst du in Teil B bei YouTube Music.

---

## A10. Export und Import (Lauf mitnehmen)

1. Auf **Läufe** bei einem Lauf auf **Exportieren** → eine `.json`-Datei wird
   geladen.
2. Datei in einem Texteditor öffnen.

| | |
|---|---|
| ✅ **Erwartet** | Felder `provider`, `playlist_id`, `order`, `cursor`, `status`. |
| ✅ **Wichtig** | **Keine** Zugangsdaten: kein `access_token`, kein `refresh_token`, kein Cookie, kein Passwort. |

3. Jetzt ein **privates Fenster** öffnen (das ist eine neue Sitzung, wie ein
   anderer Rechner) und `http://127.0.0.1:8000/connect` aufrufen.
4. Auf **Läufe** gehen → unter *02 Übernahme* → **Datei wählen** →
   **Importieren**.

| | |
|---|---|
| ✅ **Erwartet** | Grüner Hinweis `… Titel übernommen, Position …`, und der Lauf steht in der Liste — mit **derselben Position** wie im Original. |

---

## A11. Fehler- und Randfälle

Diese Fälle sind schnell und decken erfahrungsgemäß die meisten Probleme auf.

| Test | So geht's | Erwartet |
|---|---|---|
| **Unsicherer Schlüssel** | `SECRET_KEY` in `.env` auf `change_me_to_a_random_string` setzen, neu starten | Roter Kasten *Konfiguration* auf der Startseite |
| **Nicht eingerichteter Dienst** | `http://127.0.0.1:8000/auth/spotify/login` aufrufen | Seite *Dieser Dienst ist noch nicht eingerichtet* mit der Liste der fehlenden `.env`-Werte |
| **Seite gibt es nicht** | `http://127.0.0.1:8000/player/9999` | Fehlerseite **404 · Hier ist nichts**, deutscher Text |
| **Fremder Lauf** | Lauf-ID aus dem normalen Fenster im privaten Fenster öffnen | Ebenfalls 404 — **nicht** 403, das würde die Existenz der ID bestätigen |
| **Trennen** | Dienste → **Trennen** | Rückfrage; danach *Nicht verbunden*, die Läufe bleiben erhalten |
| **Großes Fach** | **Alles (Demo)** (1.482 Titel) anlegen | Fortschrittsanzeige *„Playlist wird gelesen — 250 von 1.482“*, danach ein Fach mit 1.482 Karten |
| **Neu mischen** | Bei laufendem Fach in der Sammlung *Neu mischen* wählen | Der alte Lauf steht auf **Beendet**, ein neuer beginnt bei 1 |
| **Lauf beenden** | Im Laufzettel **Lauf beenden** | Rückfrage; danach zurück auf Läufe, Lauf steht auf **Beendet** |

## A12. Handy und Tastatur

| Test | Erwartet |
|---|---|
| Fenster auf ~390 px Breite ziehen (oder Handy-Ansicht in den Entwicklertools) | Nichts läuft seitlich aus dem Bild. Auf **Läufe** ist **Fortsetzen** immer sichtbar und erreichbar. |
| Nur mit `Tab` durch die Lauf-Seite gehen | Jedes Element bekommt einen deutlich sichtbaren gelben Rahmen. Ganz am Anfang erscheint *Zum Inhalt springen*. |
| Betriebssystem auf *Bewegung reduzieren* stellen | Keine Animation mehr — der Trennstreifen springt, statt zu gleiten. |

---

# TEIL B — Echte Streamingdienste

Ab hier brauchst du Konten. **Reihenfolge nach Aufwand**: Spotify (10 min,
**setzt aber Premium voraus**) → YouTube Music (20 min, wirklich kostenlos)
→ Apple Music (teuer).

Für jeden Dienst gilt: nach dem Eintragen in `.env` **den Server neu starten**.
Die Werte werden beim Start gelesen.

## B1. Spotify (empfohlen zuerst)

**Aufwand:** etwa 10 Minuten. **Kosten:** keine — *wenn* die Voraussetzung
unten erfüllt ist.

### Voraussetzung, die Spotify seit Kurzem stellt

> „The app owner must have a Spotify Premium account for apps in development
> mode to function."
> „Up to 5 authenticated Spotify users can use an app that is in development
> mode."
> — Spotify, *Quota modes*, geprüft im Juli 2026

Das heißt konkret:

* **Du brauchst Spotify Premium**, um die Developer-App überhaupt zu betreiben —
  auch dann, wenn du nur den Handoff-Modus testen willst. Das ist Spotifys
  Regel, nicht unsere.
* Jedes **weitere** Konto (Freunde, Beta-Tester) musst du im Dashboard einzeln
  freischalten, höchstens 5 insgesamt. Ohne Freischaltung antwortet die API mit
  **403**.
* Ein Konto *ohne* Premium kann Handoff nutzen — aber nur über eine App, deren
  Besitzer zahlt.

**Ohne Premium hat es keinen Zweck, hier weiterzumachen.** Nimm dann Teil A oder
B2 (YouTube Music, kostenlos).

### Schritt 1 — App bei Spotify anlegen

1. https://developer.spotify.com/dashboard öffnen und einloggen.
2. **Create app**.
3. Ausfüllen:
   * **App name / description:** beliebig, z. B. `true-shuffle lokal`.
   * **Redirect URI:** zeichengenau
     ```
     http://127.0.0.1:8000/auth/spotify/callback
     ```
     Danach auf **Add** klicken, sonst wird sie nicht gespeichert.
   * **Which API/SDKs are you planning to use:** **Web API** ankreuzen.
4. **Save**.

> **`localhost` funktioniert nicht.** Spotify verbietet es ausdrücklich und
> erlaubt HTTP nur für ausdrückliche Loopback-Adressen — also `127.0.0.1`.
> Deshalb steht überall `127.0.0.1` und nicht `localhost`.

### Schritt 2 — Client ID eintragen

Im Dashboard **Settings** öffnen und die **Client ID** kopieren. Ein *Client
Secret* wird **nicht** gebraucht: true-shuffle nutzt PKCE und speichert deshalb
gar kein Geheimnis.

In `.env`:

```ini
BASE_URL=http://127.0.0.1:8000
SPOTIFY_CLIENT_ID=deine_client_id
```

> `BASE_URL` und die Redirect URI müssen zusammenpassen. Läuft der Server auf
> einem anderen Port, muss **beides** geändert werden — auch im Dashboard.

### Schritt 3 — dich selbst freischalten (falls nötig)

Dashboard → deine App → **Settings** → **User Management** → **Add new user**,
mit deinem Namen und der **E-Mail-Adresse deines Spotify-Kontos**.

Als Besitzer bist du meist schon zugelassen. Falls beim ersten Verbinden ein
**403** kommt, ist das hier die Ursache.

### Schritt 4 — starten und verbinden

```bash
uvicorn app.main:app --reload
```

**Dienste** → **Spotify verbinden** → Spotifys Zustimmungsseite → *Agree*.

| | |
|---|---|
| ✅ **Erwartet** | Zurück in true-shuffle, Spotify auf **Verbunden**, im Laufzettel dein Kontoname, Markt (z. B. `DE`) und Tarif (`premium`). |

### Schritt 5 — Vor dem Live-Test: ein Gerät bereitstellen

**Öffne Spotify** auf Handy, Rechner oder Box und **spiel dort kurz irgendetwas
an**. Spotify meldet ein Gerät erst, wenn es aktiv ist. Danach die
true-shuffle-Seite neu laden — das Gerät muss unter *Abspielen auf* stehen.

### Schritt 6 — Die eigentlichen Tests

| Test | Vorgehen | Erwartet |
|---|---|---|
| **Playlists lesen** | Sammlung öffnen | Deine echten Playlists mit echten Titelzahlen |
| **Großes Fach** | Deine größte Playlist wählen | Fortschritt beim Lesen; Ausschuss-Kasten listet lokale Dateien und nicht verfügbare Titel einzeln auf |
| **Live-Modus** | Live wählen → Fach anlegen → **Lauf starten** | Die Musik startet **in deiner Spotify-App**, nicht im Browser |
| **Server rückt weiter** | Browser-Tab **schließen**, zwei Titel abwarten, `127.0.0.1:8000/runs` öffnen | Der Lauf ist weitergerückt — das ist der Kern von Live auf Spotify |
| **Skip in Spotify selbst** | In der **Spotify-App** auf *Weiter* drücken | true-shuffle zählt das als **eine Karte**; es entsteht keine zweite Reihenfolge |
| **Abweichung** | In Spotify etwas ganz anderes spielen | Laufzettel meldet *„Spotify spielt etwas anderes"* statt dagegen anzukämpfen |
| **Handoff** | Handoff wählen → Fach anlegen | In deinem Spotify erscheint eine Playlist `true-shuffle · <Name>` |
| **Position ohne offenen Tab** | Diese Playlist in Spotify abspielen, true-shuffle komplett schließen, nach ein paar Titeln `/runs` öffnen | Der Zähler ist gewandert — gelesen aus deinem Hörverlauf |
| **Keine Wiederholung** | Einen Lauf möglichst weit durchhören | Kein Titel kommt zweimal, bis das Fach leer ist |

### Wenn etwas schiefgeht

| Meldung | Ursache |
|---|---|
| `INVALID_CLIENT: Invalid redirect URI` | Die URI im Dashboard stimmt nicht zeichengenau mit `BASE_URL` + `/auth/spotify/callback` überein. Häufig: `localhost` statt `127.0.0.1`, fehlendes `http://`, anderer Port, oder **Add** nicht geklickt. |
| **403** direkt nach dem Verbinden | Konto nicht freigeschaltet (Schritt 3) — oder der App-Besitzer hat kein Premium. |
| **403** erst beim Abspielen | Live-Modus braucht Premium auf dem **hörenden** Konto. Handoff geht auch ohne. |
| *Kein Spotify-Gerät aktiv* | Schritt 5: in der Spotify-App erst etwas anspielen, dann hier neu laden. |
| **429** | Spotify drosselt. Die App wartet und versucht es erneut; einfach laufen lassen. |

> Wenn du damit durch bist: **trag das Ergebnis in `STATUS.md` ein.** Spotify
> steht dort bis dahin als *BERICHTET*, nicht als *VERIFIZIERT* — dein Test ist
> genau das, was daraus einen belegten Zustand macht.

## B2. YouTube Music

**Voraussetzung:** Google-Konto. Kostenlos, aber mehr Klicks.

1. https://console.cloud.google.com → neues Projekt.
2. **APIs & Dienste → Bibliothek** → *YouTube Data API v3* → **Aktivieren**.
3. **OAuth-Zustimmungsbildschirm** → Extern → ausfüllen → unter **Testnutzer**
   deine eigene Google-Adresse eintragen.
4. **Anmeldedaten → Anmeldedaten erstellen → OAuth-Client-ID →
   Webanwendung**. Autorisierter Redirect-URI:
   ```
   http://127.0.0.1:8000/auth/youtube/callback
   ```
5. In `.env`:
   ```ini
   YOUTUBE_CLIENT_ID=...
   YOUTUBE_CLIENT_SECRET=...
   YOUTUBE_DAILY_QUOTA=10000
   ```

| Test | Erwartet |
|---|---|
| Playlist-Liste | Nur **selbst angelegte** Playlists. Mediathek, „Liked Music“ und Uploads fehlen — dafür gibt es keine öffentliche API. |
| Nicht-Musik in einer Playlist | Wird gemeldet und kommt nicht ins Fach |
| Live-Modus | Läuft im Browser-Tab über den offiziellen YouTube-Player. Tab schließen stoppt die Musik. |
| Handoff mit großer Playlist | **Wird bewusst verweigert**, mit der Rechnung: jeder Titel kostet 50 von 10.000 Kontingent-Einheiten pro Tag |
| Handoff mit ≤ 150 Titeln | Funktioniert; danach steht der Lauf auf **Übergeben**, nicht auf „Durch“ — YouTube gibt keinen Hörverlauf heraus |

## B3. Apple Music

**Voraussetzung: kostenpflichtiges Apple-Developer-Programm (99 €/Jahr)** plus
ein Apple-Music-Abo. Ohne das ist Apple Music nicht testbar — das ist Apples
Bedingung, nicht unsere.

1. Apple Developer → *Certificates, Identifiers & Profiles* → **Identifiers** →
   Media ID mit **MusicKit** anlegen.
2. **Keys** → neuer Schlüssel mit MusicKit → `.p8`-Datei laden (**nur einmal
   möglich**) → **Key ID** notieren.
3. **Team ID** steht oben rechts im Developer-Portal.
4. `.p8`-Datei nach `./secrets/` legen, dann `.env`:
   ```ini
   APPLE_TEAM_ID=XXXXXXXXXX
   APPLE_KEY_ID=YYYYYYYYYY
   APPLE_PRIVATE_KEY_PATH=./secrets/AuthKey_YYYYYYYYYY.p8
   ```
   > Die `.p8`-Datei gehört **nie** ins Git-Repository.

| Test | Erwartet |
|---|---|
| Verbinden | Eigene Seite mit *Bei Apple Music anmelden*, dann ein Apple-Fenster |
| Live-Modus | Spielt im Browser-Tab über Apples eigenen Player |
| Eigene Uploads in der Mediathek | Werden gemeldet und ausgelassen — sie haben keinen Katalog-Eintrag |
| Handoff | Playlist landet in deiner Mediathek; Position wird danach aus dem Apple-Hörverlauf zurückgelesen, ohne dass hier etwas offen bleibt |

## B4. YouTube Music inoffiziell (optional, mit Risiko)

Erreicht Mediathek, „Liked Music“, Uploads und Hörverlauf — also alles, was die
offizielle API nicht hergibt. **Der Preis:** es spricht YouTubes interne
Schnittstelle, kann jederzeit ohne Vorwarnung brechen und verstößt sehr
wahrscheinlich gegen YouTubes Nutzungsbedingungen.

```bash
pip install -r requirements-optional.txt
```
```ini
ENABLE_UNOFFICIAL_YTMUSIC=true
```
Dann `ytmusicapi browser` ausführen und den Inhalt der erzeugten
`browser.json` in der App einfügen.

| Test | Erwartet |
|---|---|
| Ohne die `.env`-Zeile | Der Connector taucht als *Nicht eingerichtet* auf und lässt sich nicht verbinden |
| Verbinden-Seite | Roter Kasten mit genau dieser Warnung, bevor irgendetwas passiert |
| Playlist-Liste | Jetzt **mit** Mediathek und „Liked Music“ |
| Handoff | Läuft hier ebenfalls mit Positionszählung, weil es einen Hörverlauf gibt |

---

## Was du nach Teil B tun solltest

`STATUS.md` ist die Stelle, an der steht, was tatsächlich mit echten
Zugangsdaten geprüft wurde. Trag dort pro Dienst ein, was funktioniert hat und
was nicht — mit Datum. Alles andere bleibt **BERICHTET**, nicht **VERIFIZIERT**.

## Wenn etwas nicht geht

| Symptom | Ursache |
|---|---|
| `.env`-Änderung wirkt nicht | Server nicht neu gestartet. `uvicorn --reload` lädt Code neu, aber nicht die Einstellungen. |
| Nach Ändern von `SECRET_KEY` sind alle Dienste getrennt | Richtig so: der Schlüssel entschlüsselt die gespeicherten Tokens. Einfach neu verbinden. |
| Spotify: „Kein Gerät gefunden“ | In der Spotify-App erst irgendetwas anspielen, dann hier neu laden. |
| Spotify meldet 403 | Beim **Verbinden**: Konto nicht freigeschaltet, oder der App-Besitzer hat kein Premium. Beim **Abspielen**: Live-Modus braucht Premium auf dem hörenden Konto. Siehe B1. |
| OAuth bricht mit *redirect_uri mismatch* ab | Die URI beim Dienst muss zeichengenau zu `BASE_URL` + `/auth/<dienst>/callback` passen. |
| Sauber neu anfangen | Server stoppen, `data/true_shuffle.db` löschen, starten. Alle Läufe und Verbindungen sind weg. |
