# Optionale Provider-Erweiterung

## Eintrittskriterium

Erst beginnen, wenn:

- UX-Gate PASS,
- Spotify-Live-Gate PASS,
- alle 30 Spotify-Use-Cases ohne offenes FAIL,
- keine kritische Datenmigrations- oder Security-Lücke,
- Spotify-Lösung nicht mehr grundlegend umgebaut werden muss.

Ein wegen fehlender Zugangsdaten `BLOCKED` markierter Spotify-Live-Gate ist kein PASS.

## Bestehender Stand

Der Produktbranch enthält bereits Abstraktionen und Code für:

- Apple Music,
- YouTube Music,
- einen inoffiziellen YouTube-Music-Pfad,
- Demo/Utility.

Requestformen und interne Verträge sind teilweise gegen Fakes/Stubs geprüft. Reale Anbieterparität ist nicht belegt.

## Vorgehen

1. Provider-Fähigkeitsmatrix aus den 30 Use Cases ableiten.
2. Für jeden Provider „native steuerbar“, „Utility/Handoff möglich“, „nicht unterstützt“ unterscheiden.
3. Aktuelle offizielle APIs, SDKs, Policies und Accountanforderungen prüfen.
4. Nur den providerneutralen Domänenkern wiederverwenden; keine Spotify-Annahmen in andere Adapter kopieren.
5. Unsupported States ehrlich in der UX zeigen.
6. Pro Provider dediziertes Live-Testkonto und echte Geräte-/App-Tests.
7. Featureparität nur behaupten, wenn derselbe Akzeptanzvertrag erfüllt ist.

## Capability Contract

Mindestens pro Provider bewerten:

- Login/Token-Lifecycle,
- Playlistliste und Pagination,
- Playlistimport und stabile Trackidentität,
- Sync-Diff,
- Start/Pause/Resume/Skip,
- Player-/Queue-Observation,
- manuelle Übernahme,
- Geräteauswahl,
- Background-/Mobile-Verhalten,
- Rate Limits,
- lokale/nicht verfügbare Tracks,
- Disconnect und Datenlöschung,
- kommerzielle und produktbezogene Policy-Grenzen.

## Zulässige Degraded Modes

Ein Provider darf als Utility-/Handoff-Modus angeboten werden, wenn echte Controller-Parität technisch oder policyseitig nicht möglich ist. Dann müssen:

- die Einschränkung vor der Verbindung klar sein,
- Fortschritt und Regeln weiterhin intern korrekt bleiben,
- keine Controller-Funktion vorgetäuscht werden,
- Export-/Copy-Artefakte verständlich verwaltet und gelöscht werden können.

## Priorität

Fable darf Anbieter auswählen oder auslassen. Kein zusätzlicher Provider darf die fertige Spotify-Version destabilisieren oder den Abschluss der Kern-Use-Cases verzögern.

