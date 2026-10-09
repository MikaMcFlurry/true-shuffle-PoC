# true-shuffle: Weg zum vermarktbaren Produkt

Stand: 09.10.2026. Grundlage sind der Produktions-Branch `codex/implement-cloudflare-restart` (Cloudflare-App inkl. PR #19–#29 von heute), die offiziellen Spotify-Dokumente (Developer Terms v10 und Developer Policy, beide gültig ab 15.05.2025, am 09.10.2026 live abgerufen) sowie drei Recherchen zu Spotify, anderen Anbietern und Markt. Das ist **keine Rechtsberatung**. Wo etwas Auslegung ist, steht es dabei.

Workflow: Mika Dev Studio → Product Alignment (Status `OWNER_REVIEW_IN_PROGRESS`, die offenen Owner-Entscheidungen stehen in §10) → Product Director (Verdict in §1).

---

## 1. Kurzfazit

**Verdict (Product Director): `ACCEPT_WITH_PIVOT`.** Deine Grundstrategie trägt: Spotify kostenlos und selbst gehostet, Geld auf offenen Plattformen, später Spotify mit Firma und Zahlen. Drei Annahmen müssen aber angepasst werden.

1. **„Erst die großen anderen Anbieter“ passt nicht zum Produkt.** true-shuffle ist heute ein *Sender mit Gedächtnis*: ein Gedächtnis pro Song, das über alles Hören hinweg nicht verloren geht. Das braucht zwei Dinge: einen **Hörverlauf** des Anbieters und **überschreibbare Playlists**.
   - **YouTube Music** hat keinen Hörverlauf per API und verbietet Hintergrund-Wiedergabe. Damit fällt der Kern weg.
   - **Apple Music** kann Playlists per API weder umsortieren noch leeren noch löschen, und der Hörverlauf ist lückenhaft. Ob ein bezahltes Feature dort erlaubt ist, hat Apple nicht beantwortet.
   - **Technisch und rechtlich passen am besten eigene Musikserver** (Navidrome/Subsonic, Jellyfin, Plex). Der Markt ist klein, aber zahlungsbereit.
2. **Druck auf Spotify durch selbst gehostete Nutzer funktioniert nicht direkt.** Jede Selbst-Host-Instanz ist eine eigene Spotify-App mit maximal 5 Nutzern, und diese Zahlen addieren sich bei Spotify nicht. Für den Spotify-Antrag zählt nur deine eigene App bzw. dein Dienst. Spotify verlangt dafür eine eingetragene Firma, mindestens 250.000 monatlich aktive Nutzer, Umsatznachweise über 12 Monate und Präsenz in Spotify-Kernmärkten. Selbst eine bewilligte Extended Quota hebt das Verkaufsverbot für Fernsteuer-Apps **nicht** auf. Dafür braucht es einen separat unterschriebenen Vertrag mit Spotify.
3. **Bevor überhaupt etwas veröffentlicht wird, gibt es Compliance-Arbeit.** Die KI-Entdeckungen schicken Spotify-Daten (Künstlernamen aus deinem Spotify-Konto) an Claude/Workers AI. Die Spotify-Policy verbietet das für **jede** Spotify-App, also auch für die kostenlose Edition. Weitere Punkte stehen in §4.

**Empfohlener Weg in einem Satz:** Compliance-Fixes und Live-Test → kostenlose, quelloffene **Spotify Community Edition** zum Selbsthosten (One-Click-Deploy auf Cloudflare, ohne Upsell) → **kommerzielles true-shuffle für eigene Musikserver**, danach Apple Music prüfen → Firma, Umsatz und Nutzerzahlen → Spotify-Partneranfrage mit einem vorbereiteten „Non-Streaming“-Modus.

**Realistische Erwartung:** Ohne Spotify ist das in den ersten 24 Monaten eher ein Nebenprojekt mit Umsatz im unteren dreistelligen bis niedrigen vierstelligen Euro-Bereich pro Monat als ein Vollzeitgeschäft (Herleitung in §7). Der große Hebel bleibt Spotify, und der ist nicht planbar.

---

## 2. Was true-shuffle heute ist (Produktions-Branch, Stand 09.10.)

Der Python-Stand auf `main` ist Geschichte. Das echte Produkt ist eine Cloudflare-App (Vite/Preact/Hono, ein Durable Object pro Hörer, kostenloser Plan):

| Bereich | Funktion |
|---|---|
| **Sender mit Gedächtnis** | Jede Playlist (oder „Alles“, „Lieblingssongs“) wird ein Sender. Er ist eine private Spotify-Playlist `true-shuffle · <Sender>`, die neu geschrieben wird, wenn niemand zuhört. Sie läuft auf jedem Gerät, auch im Auto und bei Start direkt in Spotify. |
| **Gedächtnis** | Jeder Song, der irgendwo ≥ 30 s lief, zählt, auch außerhalb von true-shuffle. Keine schnellen Wiederholungen, lange Ungehörtes zuerst, Runden bis 10.000 Songs, exaktes Fortsetzen. |
| **Mischung** | Regler „Entdecken ↔ Vertraut“ (Default ≈ 60 % ungehört, 10 % Favoriten, 30 % Neues), Favoriten-Pause, Künstlerabstand, „Erweitert“. |
| **Geschmack** | Herzen, Daumen hoch/runter (auch nachträglich), frühe Skips machen Songs seltener, „Overplayed“-Songs ruhen statt zu verschwinden (PR #28), Opener-Logik inkl. Podcasts (PR #27). |
| **Entdeckungen** | Deep Cuts, Neuerscheinungen, Last.fm, Deezer, Genre-Suche, KI (Claude/Workers AI). Jeder Vorschlag wird auf Spotify geprüft. |
| **Hörprofil** | Statistiken und Charts für frei wählbare Zeiträume (PR #22/#26), Import der Spotify-Extended-Streaming-History. |
| **Alltag** | Gast-Modus, Fernbedienung (Siri-Kurzbefehle, CarPlay, Apple Watch, Android „HTTP Shortcuts“), Geräteauswahl, Home Assistant/Music Assistant über eine lokale Bridge, Song-Uhr, mehrere umschaltbare Designs. |
| **Stand** | Release-Kandidat. Getestet gegen eine Spotify-Attrappe, Live-Betrieb für max. 5 Konten. |

**Positionierung:** true-shuffle ist kein besserer Zufallsknopf. Es ist **„ein persönlicher Radiosender aus deiner eigenen Musik, der sich alles merkt“**. Das ist wichtig, weil Spotify das Shuffle-Problem seit 13.11.2025 mit „Fewer Repeats“ teilweise selbst adressiert (§6). Gegen „Fewer Repeats“ verliert ein reines Shuffle-Tool. Gegen ein Gedächtnis mit Planer, Entdeckungen und Hörprofil nicht.

**Technische Konsequenz für mehrere Anbieter:** Die Cloudflare-Version ist Spotify-only. `src/core/` (≈ 2.400 Zeilen) ist reine Fachlogik und wiederverwendbar. `src/worker/hub/hub.ts` (≈ 7.300 Zeilen, über 200 Spotify-Bezüge) ist eng an Spotify gekoppelt. Der Python-Prototyp hatte eine Provider-Abstraktion, die neue App nicht. Jeder weitere Anbieter braucht also zuerst eine Provider-Schicht im Hub.

---

## 3. Spotify: Was die Regeln wörtlich sagen

### 3.1 Ist true-shuffle eine „Streaming SDA“? Ja, sobald es die Wiedergabe steuert.

Developer Terms v10, §II (wörtlich):

> „'Streaming' means using the Spotify Platform to enable playback of sound recordings available through the Spotify Service, **including using the Spotify Platform to control a background Spotify application**."
>
> „'Streaming SDA' is an SDA … that provides Streaming functionality **or some subset of Streaming functionality, regardless of whether it also provides additional functionality**."

Die Compliance-Tips zählen ausdrücklich Apps als Streaming, die `/v1/me/player/play` oder `/v1/me/player/next` nutzen, „or any other Spotify API or SDK to control playback“.

Du hast recht, dass true-shuffle kein Streaming-*Dienst* ist. Vertraglich ist aber jede App „Streaming“, die die Spotify-App fernsteuert. Der Produktions-Branch nutzt `play` (Start-Knopf), `next` (automatisches Weiterspringen bei ungewollten Songs, Fernbedienung „Weiter“), `pause`, `shuffle`, `repeat` und Gerätewechsel.

### 3.2 Verkaufsverbot nur für Streaming-Apps

Developer Policy §IV.2 (wörtlich): „commercial uses are not permitted for SDAs“. Beispiele: „the sale … of a Streaming SDA“, „any e-commerce (e.g., in-app payment or monetization) initiated via a Streaming SDA“, Werbung auf einer Streaming SDA.

§IV.3: Für **Non-Streaming SDAs** sind Verkauf, Abo und Werbung ausdrücklich erlaubt. Die Compliance-Tips nennen als erlaubtes Beispiel: „Making a playlist manager app and charging users $5/month to use it.“ Als verbotenes Beispiel: „Charging users $5/month for a home automation app that includes the ability to trigger music“.

**Wichtig für true-shuffle:** Der Kern (Sender-Playlist neu schreiben, Hörverlauf lesen) kommt ohne Fernsteuerung aus. Ein **„Non-Streaming-Modus“**, in dem man den Sender per Link in Spotify öffnet und es keine play/next/pause-Aufrufe gibt, wäre verkaufbar. Wegen des Entwicklungsmodus allerdings nur an 5 Nutzer, bis Spotify Extended Quota gewährt. Auslegung: Das Lesen von `GET /me/player` steuert nichts und ist nach dem Wortlaut kein Streaming.

### 3.3 Dein Modell: kostenlose Selbst-Host-Edition mit eigener Spotify-App

- **Zulässig**, wenn kein Geld fließt. Wer eine Spotify-Entwickler-App anlegt, ist selbst der „Developer“ (Terms §I.3). Spotify beschreibt den Entwicklungsmodus genau dafür („personal projects“, „friends“). Fernsteuerung ist für Premium-Nutzer nicht-kommerziell erlaubt (Policy IV.1).
- **Etablierte Praxis:** Home Assistant, Music Assistant (~3.200 GitHub-Sterne), spotify_player (~7.300), ncspot (~6.800) und Exportify (~4.200) lassen Nutzer eigene Client-IDs anlegen. Durchsetzungsmaßnahmen von Spotify gegen solche Tools sind nicht bekannt, nur gegen DRM-Umgehung und Downloader.
- **Nicht zulässig:** eine gehostete App, in die Nutzer ihre Client-ID/ihr Secret eintragen. Das verstößt gegen Terms VI.1.2, VI.1.3 und IV.2.2. Erst recht nicht, wenn sie kostenpflichtig ist.
- **Auflagen für die Community Edition:**
  - Kein Upsell, kein „Pro“-Hinweis, keine Spendenknöpfe *in* der App, denn das wäre „e-commerce initiated via a Streaming SDA“.
  - Keine Telemetrie, die Client-IDs oder Tokens an dich schickt.
  - Keine Anleitung, mehrere Client-IDs für mehr als 5 Freunde zu bündeln.
- **Praktische Hürden für Selbsthoster:**
  - Spotify Premium für den App-Besitzer.
  - Redirect-URI nur per HTTPS oder 127.0.0.1. Cloudflare `*.workers.dev` erfüllt das.
  - Seit Juli 2026 laufen Refresh-Tokens nach 6 Monaten ab, Nutzer müssen sich also zweimal im Jahr neu anmelden.
  - Playlists anderer Leute sind seit Februar 2026 nicht mehr lesbar, nur eigene oder kollaborative.
  - Alle nötigen Player- und Playlist-Endpunkte sind im Entwicklungsmodus weiter verfügbar.

### 3.4 Extended Quota und die 250.000 Nutzer

Quota-Modes-Doku (wörtlich, Auszug): „as of May 15th 2025, Spotify only accepts applications from organizations (not individuals)“. Kriterien:

- „Established Business Entity“
- „Operating an active, and Launched Service“
- „at least 250k MAUs“
- „Being available in key Spotify markets“
- „Commercial Viability“
- Prüfdauer bis zu sechs Wochen

Laut einem Antragsteller verlangt das Formular Analytics-Daten (max. 30 Tage alt), Marktanteile in den Top-3-Märkten und Umsatznachweise der letzten 12 Monate.

**Zählt der ganze Dienst oder nur Spotify-Nutzer?** Spotify sagt es nirgends. Der Wortlaut („your application“, „App Store/Analytics tool“) spricht eher für den **ganzen Dienst**, also auch für Nutzer auf Apple Music oder eigenen Servern. Dein Argument ist damit plausibel, aber unbestätigt. Zwei Dinge gelten trotzdem:

1. Gezählt werden **monatlich aktive Nutzer, keine Downloads**.
2. Die Bewilligung liegt im Ermessen von Spotify („no promise or guarantee“). Laut Spotify scheiterten über 95 % der Anträge. Im Entwickler-Forum bleiben Anfragen kleiner Entwickler 2026 unbeantwortet.

**Präzedenzfälle für Druck:** Community-Feedback hat 2026 Details geändert: Verschiebung der Endpunkt-Kürzung, Rücknahme der ISRC-Entfernung, 25 statt 1 Client-ID. Am Geschäftsmodell hat es nie etwas geändert. Die große „True Shuffle“-Idee in der Spotify-Community (6.813 Stimmen) hat Spotify mit einer **eigenen Funktion** beantwortet, nicht mit einer Öffnung für Drittanbieter. Was bei Spotify wirkt, zeigt TuneMyMusic: Es wurde Spotify-Partner (seit 20.11.2025 steckt es in Spotifys „Import your music“), weil sein Anwendungsfall Spotify Nutzer bringt. Für true-shuffle heißt das: Der Antrag braucht eine Geschichte, warum true-shuffle **Spotify** nützt, z. B. dass Hörer mehr vom eigenen Katalog hören, Künstler entdecken und weniger kündigen.

---

## 4. Compliance-Befunde im aktuellen Produkt

Sie gelten für jede Spotify-Edition, auch die kostenlose.

| # | Befund | Regel (wörtlich, Auszug) | Schwere | Empfehlung |
|---|---|---|---|---|
| C1 | **KI-Entdeckungen und KI-Genres** schicken Künstlernamen aus Spotify an Claude/Workers AI (`src/worker/hub/discovery.ts`, `genres.ts`). | Policy III / Terms: „Do not … otherwise ingest Spotify Content into a machine learning or AI model.“ Spotify Content umfasst ausdrücklich „metadata“. | **Blockierend** vor Veröffentlichung | In der Spotify-Edition KI standardmäßig aus. Seeds nur aus Nicht-Spotify-Quellen (z. B. selbst eingegebene Künstler, Last.fm-Profil des Nutzers) oder ganz entfernen. Juristisch prüfen lassen. |
| C2 | **Hörprofil**: Statistiken über das eigene Hören. | Policy III: „Do not analyze the Spotify Content … for any purpose, including … creating new or derived listenership metrics, … usage statistics, … building profiles of users“. | Hoch (Auslegung) | Profile aus dem **importierten DSGVO-Export** stammen nicht über die Spotify-Plattform. Das ist deutlich sicherer. Profile aus Daten der Spotify-API: rechtlich prüfen, in der Edition evtl. nur aus dem Import speisen. |
| C3 | **Gedächtnis „wird nie verloren“** speichert Track-IDs und Abspielzeiten dauerhaft. | Terms: „you may not store … Spotify Content, other than as strictly necessary to operate your SDA … Do not store Spotify Content indefinitely.“ | Mittel | Das Gedächtnis ist der Zweck der App, also „strictly necessary“ argumentierbar. Löschfristen bei Inaktivität und Disconnect festlegen (der Python-Stand hatte 5-Tage-Löschung, die neue App prüfen). |
| C4 | Shuffle ist eine Kernfunktion von Spotify. | Policy III.11: „Do not build products … that … attempt to replace a core user experience of Spotify … Your product … must add independent value“. | Mittel | Kommunikation immer als **Gedächtnis, Planer und Entdeckungen**, nie als „Spotify-Shuffle-Ersatz“. |
| C5 | Entdeckungen über Last.fm und Deezer. | Policy III.5: „Do not create any product … integrated with streams or content from another service.“ | Niedrig bis mittel | Es werden nur Namen genutzt und auf Spotify verifiziert, keine fremden Streams. Trotzdem prüfen. Last.fm-API-Bedingungen für kommerzielle Nutzung separat prüfen. |
| C6 | Marketing mit mehreren Anbieter-Logos. | Design Guidelines: „Pairing of brands is not permitted“, kein „Spotify“ im App-Namen, keine implizierte Partnerschaft. | Mittel (für Phase 2) | Spotify-Edition und kommerzielles Produkt getrennt präsentieren. „für Spotify“ ist erlaubt. |

---

## 5. Anbieter: Was passt zum Produkt?

Bewertet wird nicht nur, ob es eine API gibt, sondern ob das Kernversprechen (Gedächtnis plus Sender, die auf jedem Gerät laufen) dort funktioniert.

| Anbieter | Markt (MIDiA Q4/2025) | API offen? | Hörverlauf | Playlist neu schreiben | Wiedergabe | Verkaufen erlaubt? | Passung |
|---|---|---|---|---|---|---|---|
| **Spotify** | 31,4 % | Dev-Modus (5 Nutzer) | ja | ja | Fernsteuerung (Premium) | nur Non-Streaming, sonst eigener Vertrag | ★★★★★ technisch, ★ kommerziell |
| **Navidrome/Subsonic, Jellyfin, Plex** | Nische | ja, ohne Prüfung | ja (Scrobbles, zuverlässig) | ja | voll, kostenlos | ja, keine Plattformgebühr (Präzedenz: Symfonium, kostenpflichtig) | ★★★★★ technisch, ★★★★★ rechtlich, ★★ Marktgröße |
| **Apple Music** | 12,6 % | ja (99 $/Jahr) | lückenhaft, Bibliotheks-Plays fehlen | nur neu anlegen und Titel anhängen, **nicht umsortieren, leeren oder löschen** | MusicKit JS im Browser bzw. nativ in iOS | Grauzone: „not … indirectly monetize access to the Apple Music service“, Apple antwortet nicht | ★★ Web, ★★★★ als native iOS-App |
| **YouTube Music** | 12,4 % (wachsend) | YouTube Data API, 10.000 Einheiten/Tag | **keiner** | 50 Einheiten pro Titel, 500 Titel ≈ 25.000 Einheiten | nur sichtbarer Player ≥ 200 px, **kein Hintergrund** | App verkaufen ja, Wiedergabe hinter Bezahlschranke nein | ★ (Kern fällt weg) |
| **Amazon Music** | 8,5 % (DE stark) | geschlossene Beta | – | – | – | Partner | später beobachten |
| **TIDAL** | klein | ja | **keiner** | ja | Web-SDK nur Vorschau | Terms: „non-commercial applications“ | ✗ |
| **Deezer** | ~9 Mio. Abos | **keine neuen Apps** (seit 2026) | (ja) | (ja) | 30 s per API | – | ✗ |
| SoundCloud / Qobuz / Napster | – | Artist Pro nötig / nur Partner / eingestellt | – | – | – | stark eingeschränkt | ✗ |

**Folgerung:**

- **Eigene Musikserver** sind der sauberste kommerzielle Start. Das Gedächtnis funktioniert dort sogar besser als bei Spotify (verlässliche Scrobbles, keine Quoten). Die Zielgruppe überschneidet sich stark mit der Spotify-Selbsthost-Zielgruppe (Home Assistant und Music Assistant werden schon unterstützt). Eine Community kann so zwei Editionen speisen.
- **Apple Music** ist der zweite Schritt, und realistisch als **native iOS-App**. Nur dort sind Warteschlange und Wiedergabe sauber steuerbar, und der App Store ist der Kanal mit der höchsten Zahlungsbereitschaft. Vorher eine schriftliche Bestätigung von Apple Developer Relations zu §3.3.6(D) einholen.
- **YouTube Music** nur als Browser-Player-Modus mit deutlich reduziertem Versprechen, oder gar nicht.

---

## 6. Markt und Wettbewerb

**Nachfrage: echt und langlebig.**

- Spotify-Community-Idee „Option to have a true shuffle“: 6.813 Stimmen, 528.400 Aufrufe.
- „WE NEED PURE SHUFFLE!“ (2023): 1.305 Stimmen, weiterhin offen.
- Apple-Community-Thread zu Wiederholungen: 2.680 „Ich auch“.
- Laufende Presse 2024–2026. Im September 2026 berichtete ein Nutzer von einer identischen 72-Titel-Folge an zwei Tagen **mit** Fewer Repeats.

**Der größte Gegenspieler ist Spotify selbst.**

- „Fewer Repeats“ ist seit 13.11.2025 Standard für Premium.
- Die große Community-Idee steht damit auf „Implemented“.
- Fewer Repeats ist probabilistisch pro Sitzung, ohne Garantie „jeder Song einmal“ und ohne Gedächtnis über Geräte und Wochen.
- Spotify darf laut Terms jederzeit Konkurrierendes bauen.

**Wettbewerb:**

- Direkte Shuffle-Apps sind winzig und kosten einmalig 0,99–9,99 $ oder nichts: True Shuffle – Random Music (iOS), Real Shuffle Music, Stochastic Music Tyrant, Skiley, Virtual Shuffle (1,99 $/Monat), Smarter Playlists (kostenlos, seit März 2026 neu aufgelegt).
- Niemand kombiniert Gedächtnis über alle Wiedergaben, Sender, Entdeckungen und Hörprofil.
- Nächste Verwandte im Konzept: Plexamp (Guest DJ / Radio), stats.fm und Last.fm (Statistik).

**Namenskonflikt:**

- Im iOS App Store gibt es „True Shuffle – Random Music“ (Apple Music, Fisher-Yates, 0,99 $, 20 Bewertungen, seit etwa März 2026).
- Vor Marken- und App-Store-Investitionen bei DPMA, EUIPO und WIPO recherchieren und ggf. „true-shuffle“ als Wort-/Bildmarke (Klassen 9, 42) anmelden.
- PRODUCT.md hält die Schreibweise **„true-shuffle“** (klein, mit Bindestrich, Owner-Entscheidung 27.09.2026) fest. Das ist auch markenrechtlich unterscheidbarer als „True Shuffle“.

---

## 7. Wirtschaftlichkeit

**Benchmarks:**

- RevenueCat 2026 (115.000 Apps):
  - Freemium wandelt im Median 2,1 % in Zahlende, harte Bezahlschranke 10,7 %.
  - Umsatz pro Installation nach 60 Tagen: 0,38 $ (Freemium) gegenüber 3,09 $.
  - Median-Monatsumsatz ein Jahr nach Launch ≈ 72 $.
  - 17 % der neuen Apps erreichen jemals 1.000 $/Monat, 4,6 % erreichen 10.000 $/Monat.
- Preise vergleichbarer Musik-Tools: Soundiiz 5 $/Monat bzw. 39 $/Jahr, Last.fm Pro 4,99 $/Monat bzw. 49,99 $/Jahr, FreeYourMusic 39,99 €/Jahr bzw. 199,99 € lifetime, stats.fm Plus ≈ 14–21 $ lifetime.

**Grobe Größenordnung** (Annahmen, nicht belegt):

| Szenario (24 Monate, organisch) | Registrierte Nutzer | Zahlende (1,5–3 %) | MRR bei ~2 € netto/Monat |
|---|---|---|---|
| Basis | 3.000–20.000 | 50–600 | 100–1.200 € |
| Gut (z. B. erfolgreiche iOS-App) | ~50.000 | ~1.500 | ~3.000 € |
| Spotify-Partnerschaft | offen | offen | erst dann Vollzeit-tauglich |

**Preisvorschlag kommerzielle Edition** (Hypothese, später mit echten Nutzern testen):

| | Frei | Plus |
|---|---|---|
| Sender | 1 | unbegrenzt |
| Gedächtnis, Fortsetzen, Gast-Modus | ✓ | ✓ |
| Entdeckungen, Hörprofil, History-Import, Fernbedienung, Home Assistant | – | ✓ |
| Preis | 0 € | **2,99 €/Monat · 24 €/Jahr · 49 € lifetime** |

Jahres- und Lifetime-Pläne bevorzugen. Bei 2,99 €/Monat fressen Gebühren eines Merchant of Record (5 % + 0,50 €) rund 22 %.

**Kosten und Formalien** (Deutschland, mit Steuerberater bestätigen):

- Gewerbeanmeldung; Kleinunternehmerregel bis 25.000 € Vorjahr / 100.000 € laufendes Jahr.
- Merchant of Record (Paddle oder Polar) übernimmt EU-Umsatzsteuer. Achtung: Reverse-Charge auf deren Gebühren (§13b UStG) auch für Kleinunternehmer.
- Impressum (§5 DDG), Datenschutzerklärung, AV-Verträge.
- **Kündigungsbutton** (§312k BGB) und **Widerrufsbutton** (§356a BGB, Pflicht seit 19.06.2026).
- Cloudflare Workers Paid ab 5 $/Monat sobald kommerziell. Apple Developer Program 99 $/Jahr.
- Für die Spotify-Partnerschaft später eine **UG/GmbH**.

---

## 8. Empfohlener Fahrplan

### Phase 0: Fundament (jetzt, ca. 2–4 Wochen)

1. **Live-Test** nach `docs/LIVE_TEST.md` abschließen. Bisher ist alles nur gegen die Spotify-Attrappe belegt.
2. **Compliance C1–C3** umsetzen: KI in der Spotify-Edition aus bzw. ohne Spotify-Seeds, Hörprofil-Datenquelle klären, Löschfristen.
3. **Markenrecherche** „true-shuffle“ (DPMA/EUIPO) und Entscheidung zur Markenanmeldung.
4. Die **Owner-Entscheidungen** aus §10 treffen.

*Gate:* Live-Test bestanden, C1 geschlossen, Lizenz entschieden.

### Phase 1: Spotify Community Edition (kostenlos, selbst gehostet)

- Quelloffenes Repo mit **„Deploy to Cloudflare“**-Knopf. Die App läuft bereits im kostenlosen Plan.
- Setup-Assistent für Spotify-App, Redirect-URI und User-Management. Ziel: unter 15 Minuten.
- **Kein** Upsell und keine Bezahl-Links in der App. Die Website darf beide Editionen getrennt zeigen.
- Optional ein **Non-Streaming-Schalter** (nur Playlists schreiben und „In Spotify öffnen“). Das ist der Grundstein für einen späteren Spotify-Antrag.
- Community-Kanäle: GitHub, r/truespotify (~139.000), r/selfhosted, Home-Assistant- und Music-Assistant-Community. Hilfreiche Antworten statt Werbung.
- *Messbar, ohne Telemetrie:* GitHub-Sterne, Forks, Issues, Erfahrungsberichte. Das sind Nachfragebelege, aber **keine** Spotify-MAU.

### Phase 2: Kommerzielles true-shuffle

1. **Provider-Schicht** im Hub einziehen. Der Core bleibt.
2. **Navidrome/Subsonic zuerst**, danach Jellyfin und Plex. Angebot als gehosteter Dienst (Abo) und/oder Selbsthost-Lizenz.
3. **Apple Music:** schriftliche Anfrage an Apple stellen, danach eine native iOS-App bewerten (MusicKit, App Store, Abo oder Lifetime).
4. Bezahlung über Merchant of Record, Rechtstexte, Kündigungs- und Widerrufsbutton.

*Gate:* Erste zahlende Nutzer, Kündigungsrate messen, Preis validieren.

### Phase 3: Spotify-Partnerschaft

- Firma (UG/GmbH), 12 Monate Umsatznachweis, MAU sauber und datenschutzkonform gemessen, Präsenz in Kernmärkten (DE, US, UK …).
- Antrag mit einer Geschichte, die Spotify nützt: mehr Katalogtiefe, Künstler-Entdeckung, Bindung.
- Zwei Stufen anfragen: (a) Extended Quota für den **Non-Streaming-Modus** (verkaufbar laut IV.3), (b) eine Separate Agreement für den vollen Modus mit Fernsteuerung.
- Ehrliche Erwartung: Ausgang offen, Spotify entscheidet nach Ermessen.

---

## 9. Deine Annahmen im Abgleich

| Annahme | Befund | Konsequenz |
|---|---|---|
| true-shuffle ist kein Streaming-Dienst, also gelten die Streaming-Regeln nicht. | Vertraglich zählt **Fernsteuern** als Streaming (Terms §II). | Fernsteuer-Modus: nicht verkaufbar ohne Vertrag. Non-Streaming-Modus: verkaufbar. |
| Erst andere Anbieter kommerziell, wo möglich. | Richtig, aber die großen (YouTube, Apple Web) passen schlecht zum Gedächtnis-Kern, und TIDAL/Deezer/Amazon sind zu. | Start mit eigenen Musikservern, Apple nativ als Schritt 2. |
| Spotify kostenlos über eigene Developer-App selbst hosten. | Zulässig und etabliert, ohne Upsell und ohne Credential-Sharing. | Community Edition mit One-Click-Deploy. |
| So entsteht genug Druck auf Spotify. | Selbsthoster addieren sich nicht zu Spotify-MAU. Druck hat das Geschäftsmodell nie verändert. | Druck über eigene Firma, eigene Zahlen und Nutzen für Spotify. |
| 250.000 Nutzer über alle Plattformen reichen. | Plausibel (Wortlaut „your application“), aber unbestätigt. Es zählen aktive Nutzer, nicht Downloads. Plus Umsatznachweis und Firma. | Ziel bleibt, aber als langfristige Option, nicht als Plan. |
| True Shuffle hilft sehr vielen Leuten. | Nachfrage ist belegt (Hunderttausende Aufrufe). Spotify hat teilweise nachgezogen. Zahlungsbereitschaft für Abos ist unbelegt. | Mit Phase 1 echte Nutzerstimmen sammeln, Preis in Phase 2 testen. |

---

## 10. Offene Owner-Entscheidungen (Product Alignment)

Diese Punkte kann nur Mika entscheiden. Sie blockieren `ALIGNED`. Die Empfehlung steht jeweils dabei.

**Owner-Entscheidungen vom 09.10.2026 (in der Sitzung bestätigt):**

- **SD-01 → CONFIRM:** Free + Non-Streaming. Kostenlose Selbst-Host-Edition mit voller Steuerung und zusätzlich ein Non-Streaming-Modus als verkaufbare Basis für den Spotify-Antrag.
- **SD-03 → CONFIRM:** Der kommerzielle Start erfolgt mit eigenen Musikservern (Navidrome/Subsonic, dann Jellyfin/Plex).
- **SD-04 → CONFIRM:** KI in der Spotify-Edition standardmäßig aus, nur mit Nicht-Spotify-Seeds.
- **SD-02 → CONFIRM:** Die Community Edition erscheint unter AGPL-3.0.
- **SD-05 → CONFIRM:** Das Hörprofil der Spotify-Edition nutzt nur Daten aus dem importierten DSGVO-Export.
- **SD-06 → CONFIRM:** Die Marke bleibt „true-shuffle“ (klein, mit Bindestrich).
- **SD-07 → CONFIRM:** Nebenprojekt mit Gates. Mehr Einsatz erst bei messbarer Traktion in Phase 2.

Offen bleiben **SD-08** (Rechtsform) und **SD-09** (Markenanmeldung). Beide werden erst vor dem öffentlichen Launch der kommerziellen Edition fällig. Die Empfehlung steht in der Tabelle. Zustand der Alignment-Review: `OWNER_REVIEW_IN_PROGRESS`, alle Entscheidungen für Phase 0 und Phase 1 sind getroffen.

| ID | Entscheidung | Empfehlung | Alternativen |
|---|---|---|---|
| **SD-01** | Spotify kommerziell: Akzeptierst du, dass ein **bezahlter, gehosteter Spotify-Dienst mit Fernsteuerung** ohne Vertrag mit Spotify ausgeschlossen ist? | Ja → Community Edition plus optional Non-Streaming-Modus. | Juristische Zweitmeinung vorher. |
| **SD-02** | Lizenz der Community Edition. | **AGPL-3.0**: offen, aber niemand darf sie als geschlossenen Dienst weiterverkaufen. | MIT (maximal offen), Source-available (nicht offen). |
| **SD-03** | Erster kommerzieller Anbieter. | **Navidrome/Subsonic**, dann Jellyfin/Plex, dann Apple nativ. | Apple Music zuerst (größer, aber Grauzone und iOS-Aufwand), YouTube (Kern fällt weg). |
| **SD-04** | KI-Entdeckungen in der Spotify-Edition. | Standardmäßig aus, nur mit Nicht-Spotify-Seeds. | Komplett entfernen; drin lassen (Verstoß gegen Policy). |
| **SD-05** | Hörprofil in der Spotify-Edition. | Nur aus importiertem DSGVO-Export; API-basierte Profile nach juristischer Prüfung. | Unverändert lassen (Risiko). |
| **SD-06** | Schreibweise der Marke. | Bei **„true-shuffle“** bleiben (bereits beschlossen, unterscheidbarer). | „True Shuffle“. |
| **SD-07** | Ambition und Zeitbudget. | Nebenprojekt mit klaren Gates; Vollzeit erst bei Phase-2-Traktion. | Sofort als Geschäft aufbauen. |
| **SD-08** | Rechtsform. | Jetzt Einzelunternehmen (Kleinunternehmer); UG vor dem Spotify-Antrag. | Direkt UG. |
| **SD-09** | Markenanmeldung. | Recherche jetzt, Anmeldung DPMA (≈ 290 €) vor öffentlichem Launch. | Später. |

---

## 11. Quellen (Auswahl, abgerufen 09.10.2026)

- Spotify Developer Terms v10: https://developer.spotify.com/terms
- Spotify Developer Policy: https://developer.spotify.com/policy
- Compliance Tips: https://developer.spotify.com/compliance-tips
- Quota Modes: https://developer.spotify.com/documentation/web-api/concepts/quota-modes
- Kriterien Extended Access (15.04.2025): https://developer.spotify.com/blog/2025-04-15-updating-the-criteria-for-web-api-extended-access
- Developer-Mode-Änderungen 02/2026: https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security · https://developer.spotify.com/documentation/web-api/references/changes/february-2026
- Quota-Änderungen 07/2026: https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates
- Refresh-Token-Ablauf: https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration
- Partner-Formular (Zitat eines Antragstellers): https://community.spotify.com/t5/Spotify-for-Developers/Partner-Application-Form/td-p/7329000
- Fewer Repeats: https://newsroom.spotify.com/2025-11-13/shuffle-update-fewer-repeats/ · https://techcrunch.com/2025/11/13/spotify-adds-a-new-less-repetitive-shuffle-plus-audiobook-recaps
- Community-Idee True Shuffle: https://community.spotify.com/t5/Implemented-Ideas/All-Platforms-Option-to-have-a-true-shuffle/idi-p/4880594
- TuneMyMusic in Spotify: https://techcrunch.com/2025/11/20/spotifys-latest-feature-lets-you-transfer-playlists-from-other-services/
- Apple Developer Program License Agreement §3.3.6(D): https://developer.apple.com/support/terms/apple-developer-program-license-agreement
- Apple-Forum zur Monetarisierung (unbeantwortet): https://developer.apple.com/forums/thread/838157
- Apple Music API: Playlist anlegen / Titel hinzufügen; Bearbeiten nicht möglich: https://developer.apple.com/forums/thread/107807
- YouTube API Developer Policies: https://developers.google.com/youtube/terms/developer-policies · Quota: https://developers.google.com/youtube/v3/determine_quota_cost
- TIDAL Developer Terms: https://developer.tidal.com/documentation/guidelines-developer-terms-1_0
- Deezer, keine neuen Apps: https://en.deezercommunity.com/other-devices-49/impossible-de-creer-une-app-migration-spotify-vers-deezer-pour-un-projet-de-decouvert-et-jeux-musicaux-82752
- Amazon Music API (geschlossen): https://developer.amazon.com/docs/music/API_web_overview.html
- Navidrome Subsonic API: https://www.navidrome.org/docs/developers/subsonic-api
- Symfonium: https://symfonium.app/
- Music Assistant / Spotify mit eigener Client-ID: https://music-assistant.io/music-providers/spotify
- Home Assistant Spotify: https://www.home-assistant.io/integrations/spotify
- Marktanteile MIDiA Q4/2025: https://www.midiaresearch.com/blog/music-subscriber-market-shares-q4-2025-the-chess-board-is-set
- RevenueCat State of Subscription Apps 2026: https://www.revenuecat.com/state-of-subscription-apps
- Konkurrenz-App „True Shuffle – Random Music“: https://apps.apple.com/app/id6760772291
- Widerrufsbutton: https://www.ihk.de/karlsruhe/fachthemen/recht/internetrecht/fallback1433495812828/widerrufsbutton-wird-verpflichtend-7020816
- Kleinunternehmergrenzen: https://www.ihk-muenchen.de/magazin/solo-selbststaendige/unternehmen-in-oberbayern/grenzwerte-beachten.html
