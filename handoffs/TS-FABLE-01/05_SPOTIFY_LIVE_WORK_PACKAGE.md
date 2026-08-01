# Spotify Live Work Package

## Ziel

Eine Spotify-Ausführung, die den True-Shuffle-Run zuverlässig abbildet, ohne Queue-Duplikate zu erzeugen und ohne den unabhängigen Run-Fortschritt bei normaler Spotify-Nutzung zu beschädigen.

## Aktueller Fehlerpfad

### Start

- True Shuffle startet Track `t0` mit einem einzelnen URI.
- True Shuffle hängt `t1...t5` einzeln an die Spotify-Queue.

### Nativer Skip

- Spotify wechselt zu `t1`; `t2...t5` bleiben voraussichtlich in der Queue.
- Watcher interpretiert den Wechsel.
- True Shuffle startet `t1` erneut per Playback Override.
- True Shuffle hängt `t2...t6` erneut an.

Das ist nicht idempotent. Der Code kennt weder Queue-Eigentum noch Queue-Diff noch Clear/Replace.

## Zuerst instrumentiert reproduzieren

Vor einer Lösung:

1. dediziertes Spotify-Premium-Testkonto und mindestens ein echtes Gerät verwenden,
2. Shuffle und Repeat in Spotify kontrolliert deaktivieren,
3. initialen Player- und Queue-Zustand erfassen,
4. jeden True-Shuffle-Command mit Korrelations-ID, Run-Version und Zieltrack protokollieren,
5. vor/nach Play, Enqueue, Skip und Watcher-Tick `/me/player` und `/me/player/queue` redigiert erfassen,
6. exakte Timeline für Start und mindestens drei Skips erstellen,
7. prüfen, ob Watcher denselben Trackwechsel mehrfach verarbeitet,
8. den „sechsten Titel = erster Titel“-Fall separat beweisen oder falsifizieren.

Keine Tokens, Account-IDs oder unnötigen personenbezogenen Daten loggen.

## Offizielle Plattformgrenzen

Zum Zeitpunkt dieses Handoffs:

- „Add Item to Playback Queue“ fügt genau einen Eintrag an.
- „Get the User's Queue“ liest aktuelle Wiedergabe plus Queue.
- Es gibt im Web API kein entsprechendes öffentliches Remove/Clear/Replace für einzelne Queue-Einträge.
- Spotify warnt bei Player-Endpunkten, dass die Ausführungsreihenfolge bei kombinierten Requests nicht garantiert ist.
- Playback-Control setzt Premium und ein geeignetes aktives Gerät voraus.

Aktuelle Quellen beim Lauf erneut prüfen:

- https://developer.spotify.com/documentation/web-api/reference/add-to-queue
- https://developer.spotify.com/documentation/web-api/reference/get-queue
- https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback
- https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
- https://developer.spotify.com/documentation/web-api/references/changes/july-2026
- https://developer.spotify.com/policy/

## Lösungsrichtungen zur Prüfung – keine Vorgabe

### A. Materialisierter Ausführungskontext

Eine run-spezifische Spotify-Playlist oder ein anderer kontrollierbarer Kontext enthält die geplante Reihenfolge. Wiedergabe erfolgt per `context_uri` plus Offset.

Zu prüfen:

- Seiteneffekte und Sichtbarkeit der erzeugten Playlist,
- Synchronisation und Resume,
- Änderung des Runs während Wiedergabe,
- Nutzer-Queue vor/nach dem Run,
- Policy und Rate Limits,
- Cleanup und Benennung.

### B. Kein Prefetch

True Shuffle überschreibt erst am Trackende/Skip den jeweils nächsten Titel. Keine eigene mehrteilige Queue.

Zu prüfen:

- hörbare Lücken,
- Polling-Latenz,
- Race Conditions,
- Background-/Sleep-Verhalten,
- Gerätewechsel.

### C. Idempotenter Ein-Slot-Prefetch

Queue lesen und nur den nächsten fehlenden Zieltrack anhängen.

Zu prüfen:

- Queue ist nicht vollständig kontrollierbar,
- gleiche URI kann absichtlich oder manuell vorkommen,
- Race zwischen Queue-Lesen und Anhängen,
- Spotify-Reihenfolge gemischter Endpunkte,
- keine Clear-Funktion.

### D. Web Playback SDK / eigener Player

True Shuffle besitzt den Wiedergabekontext stärker.

Zu prüfen:

- widerspricht möglicherweise „Spotify parallel normal verwenden“,
- Tab-/App-Lebenszyklus,
- Mobile- und Background-Einschränkungen,
- SDK-Policy, Premium und Browser-Support.

Fable darf weitere Strategien entwickeln und soll mindestens zwei ernsthafte Alternativen prototypisch oder durch belastbare Evidenz vergleichen.

## Fachliche Architektur-Invarianten

- Das persistierte Run-Ledger ist Source of Truth.
- Providerzustand ist beobachtete externe Realität, nicht automatisch fachliche Wahrheit.
- Jeder Command besitzt Idempotency-/Correlation-Metadaten im eigenen System.
- Derselbe reale Providerübergang wird höchstens einmal auf den Run angewendet.
- Ein Watcher-Tick darf die Queue nicht blind erneut befüllen.
- Prefetch ist eine Optimierung, keine Voraussetzung für korrekten Fortschritt.
- Providerdrift löst die konfigurierte Manual-Use-Policy aus.
- Bei Unsicherheit lieber kontrolliert pausieren/nachfragen als den Player zu bekämpfen.
- Run- und Regelversion werden zusammen mit jeder Auswahlentscheidung festgehalten.

## Pflichtzustände

- kein aktives Gerät,
- Premium fehlt,
- Token abgelaufen/entzogen,
- Track nicht verfügbar,
- lokaler oder nicht abspielbarer Track,
- anderer Track manuell gestartet,
- manuelle Queue vorhanden,
- Gerät gewechselt,
- Netzwerkfehler/429/5xx,
- verspäteter oder doppelter Watcher-Tick,
- True-Shuffle-Prozess-Neustart,
- Playlist während des Runs geändert.

## Live-Testkern

Mindestens:

- Start einer Playlist mit 6, 20 und 100+ Tracks,
- 10 native Skips in Folge,
- Skip in True Shuffle,
- manuell einen anderen Song starten,
- manuell Album/Playlist starten,
- manuell 1 und mehrere Queue-Titel hinzufügen,
- Pause in Spotify und in True Shuffle,
- App-Prozess neu starten,
- Tokenrefresh,
- Gerät wechseln,
- Run nach mindestens einem simulierten Langzeit-Unterbruch fortsetzen,
- Ende eines No-Repeat-Durchlaufs,
- Wiederholungsabstand an Grenzfällen,
- zwei unabhängige Runs derselben Playlist.

Für jeden Fall Queue, Playerzustand und Run-Ledger vergleichen.

## Policy-/Business-Gate

Die Spotify Developer Policy mit Stand des tatsächlichen Laufs prüfen. Die Fassung zum Handoff enthält erhebliche Einschränkungen für kommerzielle Nutzung von Streaming-SDAs. Vor Produkt-, Pricing- oder Launch-Claims:

- aktuellen App-Typ und Daten-/Playback-Nutzung klassifizieren,
- kommerzielle Zulässigkeit juristisch bzw. mit geeigneter Fachprüfung klären,
- Disconnect und Löschung personenbezogener Daten implementieren,
- unabhängigen Produktnutzen und transparente Attribution sicherstellen,
- keine Aussage „policy compliant“ ohne dokumentierte Prüfung.

Das ist ein Release-Gate, keine beiläufige Dokumentationsaufgabe.

