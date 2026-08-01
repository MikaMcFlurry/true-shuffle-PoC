"""Datenlöschung bei Disconnect — das dreistufige F10-Modell (ADR-003).

Stufe 1 (sofort, im Disconnect-Request): Tokens/Account-Zeile weg, rohe
Provider-Beobachtungen weg, Command-Payloads redigiert, Watcher gestoppt
und die Läufe des Providers auf ``stopped`` (SEC-06: kein verwaister
Poll-Loop).  Stufe 2 (binnen 5 Tagen, nachweisbar über
``deletion_requests``): alle Provider-Inhalte — Playlists, Snapshots,
gecachte Titel-Metadaten, Job-Reste.  Stufe 3 (behalten,
**pseudonymisiert** — nicht „anonymisiert": der HMAC-Salt bleibt für den
Reconnect-Weg in ``deletion_requests.salt`` in derselben Datenbank, die
Referenzen sind also mit DB-Zugriff rückrechenbar; SEC-05): der abstrakte
Hörfortschritt — Titel-Referenzen werden zu lokalen Opaque-Hashes, damit
ein späterer Reconnect denselben Hörstand wieder verknüpfen kann
(:func:`relink_after_import`).  ``scope='full'`` löscht stattdessen alles.

Die 5-Tage-Frist ist die SPÄTESTE Ausführung (Terms); der Job darf früher
laufen, sobald die Frist gesetzt ist, tut es aber nicht von selbst — die
Karenz existiert, damit der Export (``/export/{run_id}``) vorher noch
möglich ist.  ``run_due_deletions`` läuft beim App-Start und einmal täglich.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any, Dict, List, Optional

from app import db

logger = logging.getLogger(__name__)

#: Terms-Frist (ADR-003 F10): Provider-Inhalte spätestens nach 5 Tagen weg.
DELETION_GRACE_DAYS = 5

#: Präfix anonymisierter Titel-Referenzen in ``order_json``.
HASH_PREFIX = "h:"


def _now_iso(now: Optional[datetime] = None) -> str:
    return (now or datetime.now(UTC)).strftime("%Y-%m-%d %H:%M:%S")


def opaque_ref(salt: str, provider_track_id: str) -> str:
    """Stufe-3-Referenz: HMAC-SHA256(salt, track_id), 16 Hex-Zeichen.

    Kein blanker Hash: ohne den (nur lokal gespeicherten) Salt lässt sich
    die Referenz nicht per Katalog-Brute-Force zurückrechnen.
    """
    digest = hmac.new(
        salt.encode(), provider_track_id.encode(), hashlib.sha256
    ).hexdigest()
    return f"{HASH_PREFIX}{digest[:16]}"


async def schedule_provider_deletion(
    user_id: int, provider: str, *, full: bool = False,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Stufe 1 sofort + Lösch-Antrag mit 5-Tage-Frist in die Ledger-Tabelle.

    Idempotent genug für den Disconnect-Knopf: ein weiterer Aufruf legt einen
    weiteren Antrag an (der Job ist gegen leere Arbeit immun).
    """
    conn = db.get_db()

    # Stufe 1a — Tokens/Account-Zeile sofort weg.
    await db.delete_provider_account(user_id, provider)

    # Stufe 1d (SEC-06) — kein verwaister Betrieb: Watcher der betroffenen
    # Läufe stoppen und aktive/pausierte Läufe ehrlich auf 'stopped' setzen
    # (F1: fortsetzbar nach einem Reconnect, aber nichts pollt mehr ins
    # Leere).  Lazy import — app.watcher importiert app.runs, nicht dieses
    # Modul; der Kreis bleibt offen.
    from app.watcher import watcher

    cur = await conn.execute(
        "SELECT id, cursor FROM runs WHERE user_id = ? AND provider = ? "
        "AND status IN ('active', 'paused')",
        (user_id, provider),
    )
    live_runs = [dict(r) for r in await cur.fetchall()]
    for row in live_runs:
        await watcher.stop(int(row["id"]))
    if live_runs:
        await conn.execute(
            "UPDATE runs SET status = 'stopped', device_id = NULL "
            "WHERE user_id = ? AND provider = ? "
            "AND status IN ('active', 'paused')",
            (user_id, provider),
        )
        for row in live_runs:
            await db.record_event(
                int(row["id"]), "stopped", cursor=int(row["cursor"]),
                reason="disconnect",
            )

    # Stufe 1b — rohe Player-/Queue-Beobachtungen dieses Nutzers und
    # Providers sofort weg (sie tragen Wiedergabe-Payloads).
    await conn.execute(
        "DELETE FROM provider_observations WHERE run_id IN "
        "(SELECT id FROM runs WHERE user_id = ? AND provider = ?)",
        (user_id, provider),
    )

    # Stufe 1c — Command-Payloads redigieren: die Idempotenz-/Statusspur
    # bleibt (Locking-/Retry-Nachweis), Inhalte und Geräte verschwinden.
    await conn.execute(
        "UPDATE provider_commands SET payload_json = '{}', "
        "target_track_id = '', device_id = '' "
        "WHERE user_id = ? AND provider = ?",
        (user_id, provider),
    )

    salt = secrets.token_hex(16)
    due = (now or datetime.now(UTC)) + timedelta(days=DELETION_GRACE_DAYS)
    cur = await conn.execute(
        "INSERT INTO deletion_requests (user_id, provider, scope, "
        "requested_at, due_at, status, salt) VALUES (?, ?, ?, ?, ?, "
        "'pending', ?)",
        (user_id, provider, "full" if full else "provider_content",
         _now_iso(now), _now_iso(due), salt),
    )
    await conn.commit()
    logger.info(
        "deletion scheduled: user=%s provider=%s scope=%s due=%s",
        user_id, provider, "full" if full else "provider_content",
        _now_iso(due),
    )
    return {
        "request_id": cur.lastrowid,
        "scope": "full" if full else "provider_content",
        "due_at": _now_iso(due),
        "export_hint": "/export/{run_id} liefert vor Ablauf einen Export.",
    }


async def _affected_runs(user_id: int, provider: str) -> List[Dict[str, Any]]:
    conn = db.get_db()
    cur = await conn.execute(
        "SELECT id, order_json FROM runs WHERE user_id = ? AND provider = ?",
        (user_id, provider),
    )
    return [dict(r) for r in await cur.fetchall()]


async def _anonymise_tracks(
    run_ids: List[int], user_id: int, salt: str
) -> Dict[str, str]:
    """Stufe 3: Titel-Referenzen der betroffenen Runs → Opaque-Hashes.

    Gibt das Mapping ``provider_track_id → h:<hmac16>`` zurück.  Geteilte
    ``tracks``-Zeilen (ein anderer Nutzer referenziert sie über Runs oder
    Snapshots) bleiben unangetastet — die Run-Karten dieses Nutzers werden
    auf neue anonyme Zeilen umgehängt.  Exklusiv genutzte Zeilen werden in
    place anonymisiert.
    """
    if not run_ids:
        return {}
    conn = db.get_db()
    marks = ",".join("?" * len(run_ids))
    cur = await conn.execute(
        f"""
        SELECT DISTINCT t.id AS track_pk, t.provider, t.provider_track_id
        FROM run_tracks rt JOIN tracks t ON t.id = rt.track_id
        WHERE rt.run_id IN ({marks}) AND t.provider_track_id != ''
        """,
        run_ids,
    )
    rows = [dict(r) for r in await cur.fetchall()]
    mapping: Dict[str, str] = {}
    for row in rows:
        ref = opaque_ref(salt, row["provider_track_id"])
        mapping[row["provider_track_id"]] = ref
        shared_cur = await conn.execute(
            """
            SELECT
              (SELECT count(*) FROM run_tracks rt2
                 JOIN runs r2 ON r2.id = rt2.run_id
               WHERE rt2.track_id = ? AND r2.user_id != ?) +
              (SELECT count(*) FROM snapshot_items si
                 JOIN playlist_snapshots ps ON ps.id = si.snapshot_id
                 JOIN playlists p ON p.id = ps.playlist_id
               WHERE si.track_id = ? AND p.user_id != ?) AS foreign_refs
            """,
            (row["track_pk"], user_id, row["track_pk"], user_id),
        )
        foreign_refs = int((await shared_cur.fetchone())["foreign_refs"])
        anon_key = ref[len(HASH_PREFIX):]
        if foreign_refs:
            # Geteilte Zeile: neue anonyme Zeile, Karten dieses Nutzers
            # umhängen.  idx_tracks_local macht das idempotent eindeutig.
            ins = await conn.execute(
                "INSERT OR IGNORE INTO tracks (provider, provider_track_id, "
                "local_key, name, artist, album, kind) "
                "VALUES (?, '', ?, '', '', '', 'track')",
                (row["provider"], anon_key),
            )
            if ins.lastrowid:
                anon_pk = ins.lastrowid
            else:
                got = await conn.execute(
                    "SELECT id FROM tracks WHERE provider = ? AND "
                    "provider_track_id = '' AND local_key = ?",
                    (row["provider"], anon_key),
                )
                anon_pk = int((await got.fetchone())["id"])
            await conn.execute(
                f"UPDATE run_tracks SET track_id = ? WHERE track_id = ? "
                f"AND run_id IN ({marks})",
                (anon_pk, row["track_pk"], *run_ids),
            )
        else:
            await conn.execute(
                "UPDATE tracks SET provider_track_id = '', local_key = ?, "
                "name = '', artist = '', album = '', artwork_url = '' "
                "WHERE id = ?",
                (anon_key, row["track_pk"]),
            )
    return mapping


def _rewrite_order(order_json: str, mapping: Dict[str, str]) -> str:
    try:
        order = json.loads(order_json or "[]")
    except json.JSONDecodeError:
        return order_json
    return json.dumps([mapping.get(tid, tid) for tid in order])


#: SEC-03 (Runde-2-Security-Review): Ereignis-Details werden über eine
#: ALLOWLIST redigiert, nicht über Muster — jedes neue Detail-Feld ist sonst
#: ein neues Leck.  Erlaubt sind ausschließlich abstrakte Zustandsfelder.
_DETAIL_ALLOWLIST = frozenset({
    "cursor", "note", "policy", "action", "reason", "cycle", "plan_version",
    "total", "reopened", "replanned", "version", "effective_from_seq",
    "matched", "waited_seconds", "manual_wait_seconds", "admitted", "status",
    "window", "position_ms", "cause", "from", "rules_hash", "changed",
    "config_version_id", "seed", "duplicate_of", "since",
})


async def _redact_run_texts(
    run_ids: List[int], mapping: Dict[str, str], salt: str
) -> None:
    """Alles Identifizierende aus den bleibenden Runs entfernen (SEC-03).

    Namen und Interpreten weg; Provider-Ids (Playlist, Tracks, Geräte,
    Kopien) weg; ``event_key`` trägt rohe Track-Ids im Transitionsformat und
    wird deterministisch gehasht (Eindeutigkeit je Run bleibt erhalten);
    Ereignis-Details werden auf die Allowlist reduziert.
    """
    if not run_ids:
        return
    conn = db.get_db()
    marks = ",".join("?" * len(run_ids))
    await conn.execute(
        f"UPDATE skipped_tracks SET name = '', artist = '', track_id = '' "
        f"WHERE run_id IN ({marks})",
        run_ids,
    )
    cur = await conn.execute(
        f"SELECT id, detail, event_key FROM run_events "
        f"WHERE run_id IN ({marks})",
        run_ids,
    )
    for row in await cur.fetchall():
        try:
            detail = json.loads(row["detail"] or "{}")
        except json.JSONDecodeError:
            detail = {}
        kept = {k: v for k, v in detail.items() if k in _DETAIL_ALLOWLIST}
        new_key = row["event_key"]
        if new_key and not str(new_key).startswith("redacted:"):
            new_key = "redacted:" + opaque_ref(salt, str(new_key))[len(HASH_PREFIX):]
        await conn.execute(
            "UPDATE run_events SET detail = ?, event_key = ? WHERE id = ?",
            (json.dumps(kept), new_key, row["id"]),
        )
    for run_id in run_ids:
        cur2 = await conn.execute(
            "SELECT order_json FROM runs WHERE id = ?", (run_id,)
        )
        row2 = await cur2.fetchone()
        if row2 is not None:
            await conn.execute(
                "UPDATE runs SET order_json = ?, playlist_name = '', "
                "playlist_id = '', name = '', device_id = NULL WHERE id = ?",
                (_rewrite_order(row2["order_json"], mapping), run_id),
            )


async def execute_request(request: Dict[str, Any]) -> Dict[str, Any]:
    """Stufe 2 (+3) eines Antrags ausführen und den Ausgang stempeln."""
    conn = db.get_db()
    user_id = int(request["user_id"])
    provider = str(request["provider"])
    try:
        if request["scope"] == "full":
            await conn.execute(
                "DELETE FROM runs WHERE user_id = ? AND provider = ?",
                (user_id, provider),
            )
        else:
            runs_rows = await _affected_runs(user_id, provider)
            run_ids = [int(r["id"]) for r in runs_rows]
            mapping = await _anonymise_tracks(
                run_ids, user_id, str(request["salt"] or "")
            )
            await _redact_run_texts(run_ids, mapping, str(request["salt"] or ""))
            # Die bleibenden Runs dürfen die zu löschenden Inhalte nicht mehr
            # referenzieren (FKs ohne Cascade — die Spalten sind nullable).
            await conn.execute(
                "UPDATE runs SET playlist_ref_id = NULL, snapshot_id = NULL "
                "WHERE user_id = ? AND provider = ?",
                (user_id, provider),
            )
            if run_ids:
                marks = ",".join("?" * len(run_ids))
                await conn.execute(
                    f"UPDATE run_tracks SET source_snapshot_id = NULL "
                    f"WHERE run_id IN ({marks})",
                    run_ids,
                )

        # Stufe 2 — Provider-Inhalte: Playlists cascaden auf Snapshots,
        # Items und Diffs.
        await conn.execute(
            "DELETE FROM playlists WHERE user_id = ? AND provider = ?",
            (user_id, provider),
        )
        # SEC-04: die Job-Zeilen tragen Playlist-Ids/-Namen im result_json —
        # ohne diesen Schritt wäre „alle Provider-Inhalte" faktisch falsch.
        # Jobs sind transiente UI-Artefakte; die des Nutzers gehen komplett.
        await conn.execute("DELETE FROM jobs WHERE user_id = ?", (user_id,))
        # Verwaiste Katalog-Zeilen (von niemandem mehr referenziert) weg.
        await conn.execute(
            """
            DELETE FROM tracks WHERE provider = ?
              AND id NOT IN (SELECT track_id FROM run_tracks)
              AND id NOT IN (SELECT track_id FROM snapshot_items)
            """,
            (provider,),
        )
        await conn.execute(
            "UPDATE deletion_requests SET status = 'done', completed_at = ? "
            "WHERE id = ?",
            (_now_iso(), request["id"]),
        )
        await conn.commit()
        return {"request_id": request["id"], "status": "done"}
    except Exception as exc:  # ehrlich stempeln, nie still verschlucken
        await conn.rollback()
        await conn.execute(
            "UPDATE deletion_requests SET status = 'failed' WHERE id = ?",
            (request["id"],),
        )
        await conn.commit()
        logger.exception("deletion request %s failed", request["id"])
        return {"request_id": request["id"], "status": "failed",
                "error": str(exc)}


async def run_due_deletions(
    now: Optional[datetime] = None, *, include_not_due: bool = False,
) -> List[Dict[str, Any]]:
    """Alle fälligen Anträge ausführen (App-Start + täglicher Tick).

    ``include_not_due`` zieht die Ausführung vor (Nutzerwunsch „sofort
    löschen") — die Frist ist eine Obergrenze, kein Mindestalter.
    """
    conn = db.get_db()
    cur = await conn.execute(
        "SELECT * FROM deletion_requests WHERE status = 'pending'"
        + ("" if include_not_due else " AND due_at <= ?"),
        () if include_not_due else (_now_iso(now),),
    )
    outcomes = []
    for request in [dict(r) for r in await cur.fetchall()]:
        outcomes.append(await execute_request(request))
    return outcomes


async def relink_after_import(
    user_id: int, provider: str, snapshot_id: int
) -> int:
    """Reconnect-Weg der Stufe 3: frische Import-Titel zurückverknüpfen.

    Für jeden abgeschlossenen Löschantrag des Nutzers wird geprüft, ob ein
    importierter Titel per Opaque-Hash zu einer anonymisierten Karte gehört;
    wenn ja, zeigt die Karte wieder auf die echte Katalog-Zeile und die
    ``order_json``-Referenzen werden restauriert.  Gibt die Zahl der wieder
    verknüpften Karten zurück.
    """
    conn = db.get_db()
    cur = await conn.execute(
        "SELECT salt FROM deletion_requests WHERE user_id = ? AND "
        "provider = ? AND status = 'done' AND scope = 'provider_content' "
        "AND salt != '' ORDER BY id DESC",
        (user_id, provider),
    )
    salts = [str(r["salt"]) for r in await cur.fetchall()]
    if not salts:
        return 0

    cur = await conn.execute(
        "SELECT DISTINCT t.id AS track_pk, t.provider_track_id "
        "FROM snapshot_items si JOIN tracks t ON t.id = si.track_id "
        "WHERE si.snapshot_id = ? AND t.provider_track_id != ''",
        (snapshot_id,),
    )
    incoming = [dict(r) for r in await cur.fetchall()]
    relinked = 0
    reverse: Dict[str, tuple] = {}
    for salt in salts:
        for row in incoming:
            ref = opaque_ref(salt, row["provider_track_id"])
            reverse.setdefault(
                ref[len(HASH_PREFIX):],
                (row["track_pk"], row["provider_track_id"]),
            )
    if not reverse:
        return 0

    marks = ",".join("?" * len(reverse))
    cur = await conn.execute(
        f"""
        SELECT t.id AS anon_pk, t.local_key FROM tracks t
        WHERE t.provider = ? AND t.provider_track_id = ''
          AND t.local_key IN ({marks})
        """,
        (provider, *reverse.keys()),
    )
    order_mapping: Dict[str, str] = {}
    for row in [dict(r) for r in await cur.fetchall()]:
        real_pk, real_id = reverse[row["local_key"]]
        moved = await conn.execute(
            """
            UPDATE run_tracks SET track_id = ? WHERE track_id = ? AND run_id
              IN (SELECT id FROM runs WHERE user_id = ? AND provider = ?)
            """,
            (real_pk, row["anon_pk"], user_id, provider),
        )
        relinked += int(moved.rowcount or 0)
        order_mapping[f"{HASH_PREFIX}{row['local_key']}"] = real_id
        await conn.execute(
            "DELETE FROM tracks WHERE id = ? AND id NOT IN "
            "(SELECT track_id FROM run_tracks) AND id NOT IN "
            "(SELECT track_id FROM snapshot_items)",
            (row["anon_pk"],),
        )
    if order_mapping:
        cur = await conn.execute(
            "SELECT id, order_json FROM runs WHERE user_id = ? AND provider = ?",
            (user_id, provider),
        )
        for run_row in [dict(r) for r in await cur.fetchall()]:
            rewritten = _rewrite_order(run_row["order_json"], order_mapping)
            if rewritten != run_row["order_json"]:
                await conn.execute(
                    "UPDATE runs SET order_json = ? WHERE id = ?",
                    (rewritten, run_row["id"]),
                )
    await conn.commit()
    if relinked:
        logger.info(
            "relinked %s anonymised cards after import (user=%s provider=%s)",
            relinked, user_id, provider,
        )
    return relinked
