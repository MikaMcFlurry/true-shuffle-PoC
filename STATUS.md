# True-Shuffle PoC — Agent Handover Status

> **Last updated**: 2026-02-22  
> **Agent / Author**: Antigravity

---

## ✅ Was wurde getan?

- [x] Projektgrundlagen, scaffold und SQLite Setup (`app/db.py`, `app/models/`, `app/main.py`)
- [x] Spotify OAuth (PKCE)
- [x] Controller Mode implementiert: Queue-Buffer N=5, Polling, Hard Override, Skip-Handling, Device Handling (`app/controller.py`, `app/spotify_client.py`). Sequentielle Player-Calls integriert.
- [x] Controller UI Template hinzugefügt (`app/templates/controller.html` und `/controller/ui` Route)
- [x] `HANDOFF_agent-controller.md` im Root-Verzeichnis erstellt. Enthält alle Flow-Details und Risiken des Controller Mode.

---

## 🔲 Was ist noch offen? / Next Steps

- [ ] Abhängigkeit `itsdangerous` zur `requirements.txt` hinzufügen (fehlt aktuell für SessionMiddleware, Backend startet nicht).
- [ ] Pytest & Typing-Fehler beheben (Pydantic <-> Python 3.9 Inkompatibilität bei Union Types `str | None`). Evtl. `eval_type_backport` nutzen oder Typing klassisch auf `typing.Optional` umstellen.
- [ ] Tests ausführen, sobald die Dependencies/Typings fixiert sind (Mocks für den `_poll_playback()` Zyklus reparieren/ergänzen).
- [ ] Smoke-Test in Runtime (`uvicorn`) mit einem echten Spotify Premium Account über `/controller/ui`.
- [ ] Evaluieren, ob nach einem `_hard_override()` alte Lieder in der Spotify-internen Queue verbleiben und Probleme bereiten ("Rest-Queue").

---

## 🗒️ Notizen / Kontext

- Python 3.9 Kompatibilität bereitet bei modernen Typ-Hinting in Pydantic BaseModels (`|` Pipe Operator statt `Union`) momentan Schwierigkeiten.
- Der Controller nutzt ein hartes Polling-Intervall von 3 Sekunden. Das bedeutet, dass Fremd-Tracks bei einem fehlerhaften System minimal bis zu 3 Sekunden abspielen könnten.
- Alle Controller-API-Aufrufe sind via `asyncio.Lock` per `spotify_user_id` sequenzialisiert, um `HTTP 429`-Limits auf Spotifys Player APIs vorzubeugen.
