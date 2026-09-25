# ADR-006: Neustart auf Cloudflare. Die Playlist ist das Deck, das Gedächtnis ist global

Status: Angenommen · Datum: 2026-09-25 · Ersetzt ADR-002 und ADR-005 des Python-Prototyps (bis `db73bc5`)

## Kontext

Der Prototyp (Python auf Fly.io) steuerte Spotify über ein `uris`-Fenster und die Warteschlange. Im echten Betrieb ging das schief:

- Spotify spielte je nach Client nur die erste URI und füllte dann selbst auf.
- Das Ende eines Songs wurde verpasst.
- Nach einem Autostopp lief die Warteschlange rückwärts oder von vorn.
- Beim Neu-Mischen Tage später kam fast dieselbe Reihenfolge.

Der Besitzer will: Start drücken, und es läuft Musik, die er mag, mit viel Abwechslung. Sein Fortschritt darf nie verloren gehen. Irgendwann soll jeder Song drankommen, Favoriten gelegentlich, dazu Neues. Die Rangfolge (im Grilling bestätigt):

1. Fortschritt geht nie verloren.
2. Keine schnellen Wiederholungen.
3. Jeder Song irgendwann, lange nicht Gehörtes zuerst.
4. Favoriten öfter, mit einer Woche Abstand.
5. Neue Musik.

Hosting: kostenloser Cloudflare-Plan. Bis zu 5 Konten mit Spotify-Anmeldung.

## Entscheidung

### 1. Die Playlist ist das Deck

Jeder Sender ist eine private Spotify-Playlist „True Shuffle · <Sender>" mit bis zu 300 geplanten Songs. Gestartet wird sie mit `context_uri` und `offset`, Shuffle und Wiederholen sind aus. Spotify spielt sie dann selbst ab, auf jedem Gerät, auch offline im Auto und auch ohne True Shuffle. Eine Warteschlange muss niemand am Leben halten. Das behebt die Fehlerklasse des Prototyps an der Wurzel.

- **Neu geschrieben** wird ein Deck nur, wenn seit mindestens 10 Minuten niemand darin hört: Jemandem die laufende Playlist umzuschreiben ist genau der alte Fehler. Anlass ist ein verbrauchtes Deck, ein veraltetes (älter als 20 h) oder ein markiertes (neue Entdeckungen, Daumen runter, Regeländerung).
- **Angehängt** wird, wenn beim Hören weniger als 25 Songs vor der aktuellen Position übrig sind. Anhängen stört die laufende Wiedergabe nicht.
- **Schaltet jemand Spotifys Shuffle ein,** stellt True Shuffle ihn höchstens alle 10 Minuten wieder ab.

### 2. Das Gedächtnis ist global und liest alles mit

Pro Song werden gespeichert: letzte Wiedergabe, Anzahl Wiedergaben, frühe Skips, Herz in Spotify und Daumen. Quelle ist `recently-played` (≥30 s = gehört), egal wo gehört wurde. Frühe Skips erkennt True Shuffle aus der Player-Position im eigenen Deck: ein übersprungener Eintrag, zu dem nach 20 Minuten keine Wiedergabe gemeldet ist. Der Gast-Modus blendet Zeiträume aus. Der Hörverlauf-Import (Spotify-Datenexport) liefert die Vorgeschichte.

### 3. Der Planer

Jeder Sender hat Runden. Gewichtetes Mischen (Efraimidis–Spirakis) über drei Spuren:

- **ungehört in dieser Runde**, lange nicht Gehörtes zuerst, gewichtet nach Geschmack,
- **Favoriten** mit Abstand (Standard: 7 Tage),
- **Entdeckungen**.

Die Anteile kommen vom Regler „Entdecken ↔ Vertraut" (Standard Entdecker: 60 / 10 / 30). Dazu gilt Künstlerabstand, eine 24-Stunden-Sperre für kürzlich Gehörtes und „nicht jetzt" nach einem frühen Skip. Wenn die Runde leer ist, beginnt die nächste automatisch.

### 4. Ein Durable Object pro Hörer

`UserHub` hält den ganzen Zustand eines Kontos in seiner eigenen SQLite-Datenbank. Dazu gehören Bibliothek, Gedächtnis, Sender, Decks, Jobs und Entdeckungen. Alle Operationen laufen in diesem einen Objekt hintereinander (Mutex über I/O-Grenzen). So können sich der Sync im Hintergrund und ein Tipp in der App nicht in die Quere kommen.

Das Objekt weckt sich selbst per Alarm:

- alle 3 Minuten, solange ein Deck spielt,
- alle 10 Minuten bei anderer Wiedergabe,
- alle 20 Minuten im Leerlauf,
- stündlich nach 6 Stunden Stille.

Ein Cron-Trigger (alle 20 Minuten) belebt verlorene Alarmketten über die `Registry` wieder.

### 5. Innerhalb des kostenlosen Plans bleiben

- Höchstens 40 externe Anfragen pro Aufruf (die Grenze liegt bei 50). Größere Arbeiten sind Jobs, die über mehrere Aufrufe fortschreiten: Import, Deck schreiben, Entdecken.
- Bibliothek in Seiten zu 50 Songs, Hörverlauf in Seiten zu 500. Im Sync-Pfad gibt es nur Punktabfragen, damit die Zeilenkontingente (Lesen/Schreiben pro Tag) auch bei 10.000er-Playlists reichen.
- Statische Dateien gehen nie über den Worker, nur `/api/*` und `/auth/*`.

### 6. Entdeckungen werden verifiziert

Quellen sind Deep Cuts und Neuerscheinungen geliebter Künstler, Last.fm, Deezer, Genre-Suche und KI:

- Claude Sonnet 5, wenn ein Schlüssel hinterlegt ist, sonst Workers AI.
- Jeder Vorschlag wird auf Spotify gesucht. Nur echte Treffer kommen in den Sender.
- Wer eine Entdeckung zweimal hört oder mit Daumen hoch markiert, findet sie in „True Shuffle · Entdeckungen". Ein früher Skip oder Daumen runter sortiert sie aus.

### 7. Sicherheit

- Anmeldung per Authorization Code + PKCE, ohne Client-Secret.
- Refresh-Token AES-GCM-verschlüsselt, Sitzungs-Cookie HMAC-signiert, beide Schlüssel per HKDF aus `APP_SECRET`.
- Jede Änderung braucht den Header `x-ts: 1` (CSRF).
- Optionale Allowlist `ALLOWED_SPOTIFY_IDS`.
- CSP ohne Inline-Skripte.

## Verworfene Alternativen

- **Warteschlange/`uris` (Prototyp):** nachweislich client-abhängig und bricht bei Gerätewechsel und Autostopp.
- **Vercel + externe Datenbank:** Hintergrund-Sync bräuchte Cron plus Datenbank plus Sperren. Das Durable Object liefert alle drei in einem, kostenlos.
- **Eine globale D1-Datenbank:** Sperren und Alarme pro Hörer müssten nachgebaut werden, und die Kontingente teilten sich alle Konten.
- **Deck bei jeder Änderung sofort umschreiben:** würde laufende Wiedergabe stören, also genau den alten Fehler wiederholen.

## Konsequenzen und bekannte Grenzen

- **Premium ist Pflicht** für das Starten und Steuern. Das ist eine Vorgabe von Spotify.
- **`recently-played` liefert nur die letzten 50 Songs.** Wer sehr lange ohne Verbindung hört (mehr als 50 Songs zwischen zwei Syncs), verliert die ältesten aus dem Gedächtnis. Im eigenen Deck fängt die Positionsbeobachtung einen Teil davon auf.
- **Der Spotify-Entwicklungsmodus erlaubt höchstens 5 Konten** und hat ein knappes Anfragekontingent. Bei „Kontingent aufgebraucht" pausiert True Shuffle für die gemeldete Zeit und macht dann weiter (getestet).
- **Die Reihenfolge in einem laufenden Deck steht fest.** Regeländerungen wirken ab dem nächsten Neuschreiben, also sobald 10 Minuten niemand hört.
- **Nachweis:** Unit-, Eigenschafts-, Szenario- und End-to-End-Tests gegen eine Spotify-Attrappe mit Player-Simulation. Der Live-Nachweis mit echtem Spotify steht aus ([LIVE_TEST.md](../LIVE_TEST.md)).
