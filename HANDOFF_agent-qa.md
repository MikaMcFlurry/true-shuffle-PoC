# Handoff: QA, Export/Import & Similarity Check

> **Zweck**: Dokumentation des aktuellen QA-Standes, Export/Import-Logiken sowie Test-Abdeckung für das `agent-qa`-Setup.

## What’s implemented (tests + export/import + similarity)
- **Tests**: Grundlegende Unit- und Integration-Tests für `health`, `db` und `auth` sind vorhanden in `tests/`. Die Struktur (inkl. `pytest` und TestClient) steht.
- **Export/Import**: Noch **nicht implementiert**. Weder Rounting-Endpoints (`app/`) noch Logik-Klassen für den JSON-Export von Läufen sind aktuell vorhanden.
- **Similarity Check**: Der "nicht zu ähnlich nach Shuffle refresh"-Guard ist noch **nicht implementiert**.

## How to run tests
Da die Ausführung von `pytest` im aktuellen System-Aufruf ("Python wurde nicht gefunden") fehlschlug, hier die manuellen Schritte für den lokalen Dev-Cycle:
1. Python installieren bzw. PATH-Variable prüfen (`py` auf Windows).
2. Virtuelle Umgebung aufsetzen und aktivieren: `py -m venv .venv` und `.venv\Scripts\Activate.ps1`.
3. Abhängigkeiten installieren: `pip install -r requirements.txt pytest httpx`.
4. **Befehl**: `python -m pytest` im Root-Verzeichnis ausführen.

### Letzte Ausführung:
- **Anzahl Tests passed/failed**: Abbruch – keine Testresultate aufgrund fehlender Ausführungsumgebung.
- **Top 1–2 Failure Ursachen**: (Keine Daten, Test-Suite startete nicht).

## Export/Import Rules (Spezifikation für Implementierung)
Die Export-/Import-Logik erfordert folgende strikte Restriktionen:
1. **Keine Tokens in JSON**: Es dürfen unter keinen Umständen User-OAuth-Tokens (Access/Refresh) oder API-Credentials im Dump auftauchen!
2. **Schema Version**: Jeder Export muss ein `schema_version` Feld beinhalten, so dass zukünftige App-Versionen alte JSON-Dateien interpretieren können.
3. **Cursor Bounds**: Cursor für Paging dürfen nicht exportiert werden (sollten zurückgesetzt werden), da diese transiente API-Zustände sind.
4. **Run ID Collision Handling**: Ein Import einer bereits existierenden UUID/`run_id` darf die vorhandene Historie nicht blind überschreiben. Entweder wird eine neue ID für den Import-Run generiert ("clone" behaviour) oder der Vorgang mit Error abgelehnt.

## Open tasks (max 3)
1. Endpunkte (z.B. `GET /runs/{run_id}/export` & `POST /runs/import`) in FastAPI anlegen und obige Regeln per Pydantic forcieren (`exclude={"access_token", "refresh_token"}`).
2. Similarity Check (z.B. Levenshtein, Fenster-Vergleich) im `Shuffle`-Controller / in der Core-Engine verankern, um sicherzustellen, dass ein Re-Shuffle ausreichend "neu" klingt.
3. Strikte `pytest`-Abdeckung für Export/Import hinzufügen, die sicherstellt, dass exportierte Dateien nie Tokens leaken.

## Known issues / flaky tests
- Das Test-Setup mit FastAPI und asynchroner lokaler SQLite birgt das Risiko von File-Locks. Alle Pytest-Fixtures müssen Session-Cleanup (`await close_db()`) exakt einhalten, da sonst unter Windows Flaky Tests auftreten (aufgrund von "Database is locked" Errors).

## Next steps (3 konkrete Schritte)
1. **Test-Umgebung reparieren**: Virtuelle Umgebung im Workspace sauber aufbauen, so dass das Agent/Entwickler-Team `pytest` jederzeit auf Knopfdruck ("green state") verifizieren kann.
2. **Datenschutzsichere Pydantic Modelle anlegen**: Eigene Klassen (z. B. `ExportRunSchema`), die explizit alle Security-relevanten Felder per Deklaration verwerfen. In die Endpunkte integrieren.
3. **Distance Metrics**: Eine kleine isolierte Utility-Funktion in die Core-Engine für "nicht zu ähnlich" schreiben (z. B. Zählen von überschneidenden Nachbarschaften von Tracks) und sofort per Unit-Test absichern.
