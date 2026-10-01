# Spotify-Anfragen: Optimierung vom 1. Oktober 2026

Verglichen wurden `2d96fb6890e070af7c141e9cb59b80c704709d82` und `30ae6a2d5349e3f37bce18ab39b3c920c5543c35` mit identischen Real-Hub/FakeSpotify-Tagesabläufen und künstlicher Uhr. Keine Last wurde gegen echtes Spotify erzeugt. Die Bibliothek umfasst 1.200 Songs; Einrichtung und initiales Starten liegen außerhalb des Messfensters. Wartung, Discovery und Token-Erneuerungen innerhalb des Fensters sind enthalten.

| Simulierter Tag | Vorher | Nachher | Weniger Anfragen |
| --- | ---: | ---: | ---: |
| 24 Stunden pausiert und geschlossen | 856 | 269 | 68,6 % |
| 4 Stunden sichtbare Wiedergabe, dann 20 Stunden pausiert/geschlossen | 2.015 | 810 | 59,8 % |
| 4 Stunden geschlossene Wiedergabe, dann 20 Stunden pausiert/geschlossen | 1.748 | 487 | 72,1 % |

Der aktive sichtbare Vierstundenabschnitt steigt von 510 auf 567 Anfragen. Die engere Beobachtung erhält kurze tatsächlich gehörte Songs und den Verlauf. Ein getesteter längerer Abstand verlor vier geschützte Verlaufsfälle und wurde verworfen. Der geschlossene aktive Abschnitt bleibt mit 243 gegenüber 244 nahezu gleich. Die wesentliche Einsparung entsteht im pausierten Hintergrund; sie ist keine pauschale Verringerung jedes Nutzungsfensters.

In den separaten 15-Minuten-Fenstern bleiben geschlossene Wiedergabe und eine gerade begonnene Pause unverändert bei 20 beziehungsweise 15 Spotify-Anfragen. Sichtbar, nach Reload und mit drei Tabs sinkt der Wert jeweils von 41 auf 40; mit Geräteabfrage von 56 auf 55. Das bestätigt ausdrücklich keine großen Einsparungen bei kurzen aktiven Fenstern. Die Token-Erneuerungen betragen im Tageslauf 23 beziehungsweise 24 nach der Änderung gegenüber zuvor 24.

Erfolgreiche Player-Abfragen haben einen dauerhaften Zeitpunkt; reine Wartungsalarme oder Cache-Lesezugriffe verschieben ihn nicht. Normale Pausen erhalten zunehmend größere Abstände. Gast-/Privatgrenzen, bekannte abgelehnte Songs und alte gefährdete Reihenfolgen behalten kurze Prüfungen. Deshalb kann eine solche Station auch im pausierten Zustand mehr Verkehr erzeugen als der oben gemessene normale Fall. Der Verlauf besitzt eine eigene Frist; ein bestätigtes Verlaufslimit blockiert weder andere Operationen noch das Weiterfüllen aus dem bekannten Gedächtnis bei frisch beobachtetem Player.

Nutzerbefehle erhalten sofort lokales Feedback. Erfolgreiche Pause/Fortsetzen/Weiter-Antworten warten nicht auf nachfolgende Player-/Verlaufsmessungen. Ein eigener Alarm und zwei begrenzte Cache-Lesezugriffe holen die Bestätigung; die lokale Sekundenuhr erzeugt keine Spotify-Abfragen. Unklare Antworten werden von tatsächlichen Ablehnungen unterschieden. Ausdrücklich gewählte Geräte werden tatsächlich angesprochen, auch wenn sie in einer aktuellen Liste fehlen. Spotify kann ein nicht erreichbares Gerät weiterhin ablehnen; die App kann eine suspendierte iPhone-App nicht garantiert aufwecken.

Der projizierte unmittelbare Folgesong ist ausschließlich Anzeige: höchstens ein bekannter Nachfolger, eine höchstens zwei Minuten alte Beobachtung und höchstens 30 Sekunden im Folgesong. Er verändert weder Queue-Instanz noch Hörnachweis oder gespeicherten Fortschritt. Die Vorschau zeigt bis zu 50 gespeicherte kommende Einträge ohne zusätzliche Spotify-Anfrage.

Die Tageswerte sind keine Quota-Messung. Andere Apps desselben Entwicklerkontos sind im Tracker unsichtbar; verbleibendes Budget und tatsächliche Anbieter-Bucket-Zuordnung bleiben unbekannt. Drei-/Fünf-Konto-Werte in den Rohdaten sind lineare Rechnungen, keine Live-Abnahme. Echte 429-Antworten und Wiederfreigaben werden weiterhin je Konto und HTTP-Methode/Endpoint aufgezeichnet. Bekannte echte Wartefristen bleiben für genau diese Operation wirksam; unbekannte Sperren benötigen einen ausdrücklichen begrenzten Versuch. Ein neues Entwicklerkonto ist keine nachgewiesene Lösung.

Die revisiongebundenen Rohdaten und Prüfergebnisse stehen in `docs/ai-dev/evidence/RESPONSIVENESS_OPTIMIZATION.json` und `docs/ai-dev/evidence/responsiveness-optimization/`. Physische iPhone-Latenz und Aufwecken, private HA/MA und tatsächliches Wiederherstellen gefüllter Produktionsobjekte bleiben getrennte offene Live-Prüfungen. Das externe UI-/UX- und Audit-Briefing liegt in `docs/UI_UX_START.md`.
