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

Der öffentliche Produktions-Endpunkt antwortet; seine Frontend-Assets entsprechen der Ausgangsversion. Die genaue Worker-Version, Produktions-Backups und Runtime-Konfiguration konnten ohne authentifizierten Cloudflare-Zugang nicht geprüft werden. Kein neues Deployment und keine Produktionsdatenänderung wurden vorgenommen. `docs/RELEASE_RECOVERY.md` beschreibt getrenntes Preview, additive Migration und die noch erforderlichen Produktionsprüfungen.
