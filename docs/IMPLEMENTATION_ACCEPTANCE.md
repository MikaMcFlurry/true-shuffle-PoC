# Implementierungsstand und Abnahme

Die Änderungen bauen auf `5ffe99b929b6a8ddf93035370e156fe036fe6a83` des Cloudflare-Zweigs auf. `main` enthält weiterhin den älteren Python-Prototyp. Die Umsetzung wird gegen `codex/cloudflare-restart-plan` zur Prüfung bereitgestellt.

## Verhalten

Normaler Play verwendet die gespeicherte Session und denselben unfertigen Queue-Eintrag. Die letzte tatsächlich beobachtete Position bleibt erhalten, auch nach rückwärts gerichteten Seeks. Eine unbekannte Position beginnt denselben Eintrag bei null. Neue Reihenfolgen entstehen durch die getrennte Aktion „Neue Warteschlange“. Session-, Eintrags- und Epoch-Fences verhindern veraltete Steuerbefehle und Beobachtungen. Unbestätigte Provider-Schreibvorgänge werden gespeichert und kontrolliert wiederhergestellt. Eine begrenzte rollierende Queue erhält den unfertigen Eintrag über Runden hinweg.

Die Migration ergänzt gespeicherte Sessions; sie ersetzt weder Verlauf noch Stationen, Einstellungen oder Account-Isolation. Der lokale Recovery-Test öffnet einen SQLite-Backup-Snapshot mit einer bei 1:37 pausierten Session erneut und prüft die unveränderte Position und den Verlauf. Ein fehlgeschlagener Migrationsschritt wird vollständig zurückgerollt.

Spotify-Aufrufe einschließlich OAuth, Token-Refresh, Player-Steuerung und Hintergrundjobs nutzen den gemeinsamen persistenten Quota-Schutz. Provider-Status, bereinigter Grund und tatsächliches Retry-After bleiben erhalten. Eine unbekannte Sperrfrist bleibt unbekannt. Die manuelle Freigabeprüfung verwendet einen einzelnen Probe-Lease; alte Account-Zustände dürfen eine bestätigte gemeinsame Freigabe nicht überschreiben. Netzwerkfehler bei schreibenden Spotify-Befehlen führen nicht zu blindem Wiederholen.

Der native Weg ist ein eigener Controller mit einer lokalen authentifizierten HA-Bridge. Geräte werden serverseitig pro Konto freigegeben; unterstützte Fähigkeiten sind ausdrücklich deklariert. Music Assistant erhält die geordnete Liste über seine offizielle `music_assistant.play_media`-Aktion. Allgemeine HA-Geräte benötigen eine konfigurierte Medien-URL und besitzen nur die eingerichteten Fähigkeiten. Einrichtung und Grenzen stehen in der Native-Dokumentation.

Die Preact-Oberfläche zeigt gespeicherten Titel, Position, Geräte- und Verbindungszustand sowie die geordnete Warteschlange. Bestehende Stations-, Mix-, Regel-, Import-, Favoriten-, Ban-, Gast- und Privat-Funktionen bleiben im selben Produkt erreichbar.

## Evidenz und Grenzen

`docs/ai-dev/EVIDENCE.json` ist die abschließende maschinenlesbare Abnahme. `docs/ai-dev/evidence/` enthält Baseline, Messungen und die Ergebnisse der unabhängigen Prüfung. Lokale Tests verwenden einen tatsächlichen lokalen Worker mit SQLite Durable Objects und einen ausdrücklich synthetischen Spotify-Testserver. Sie beweisen keine Live-Freigabe durch Spotify und keine Verbindung mit der privaten HA-Installation.

Der vorhandene Produktions-Worker wurde mit dem autorisierten Cloudflare-OAuth-Zugang aktualisiert. Aktive Version `c7b059ed-ab7c-45f5-88f2-3219ec3dd628`, Deployment `dc7496dc-b106-4daf-9925-f4e8ce81d2bd`, Quellstand `1fd551e2a1abebe1d1b2d93ff9db6403f69c4df9`: 100% Traffic. Namespace-IDs, Migration v1 und bestehende Secret-/Variablen-Bindings bleiben unverändert. Health, genaue JS/CSS-Identität, anonyme401/CSRF403 und der mobile Anmelde-Browsercheck bestehen. Der dabei gefundene falsche Offline-Hinweis nach401 wurde korrigiert; alle 16 Browserfälle und fünf unabhängige Zustandsprüfungen bestehen.

Die vollständige Live-Abnahme bleibt PARTIAL: echte Spotify-/HA/MA-Wiedergabe, tatsächliche Quota-Ursache, befüllte Produktionsdaten-Invarianten und eine ausgeführte Durable-Object-Wiederherstellung sind NOT_RUN. Die alten Worker-Versionen bleiben für Code-Rückkehr verfügbar; beide Namespaces sind SQLite und haben laut Cloudflare 30-Tage-PITR. Das beweist keine getestete Datenwiederherstellung. `docs/ai-dev/evidence/CLOUDFLARE_DEPLOYMENT.json` und `docs/RELEASE_RECOVERY.md` dokumentieren Ziel, Readback und Grenzen.
