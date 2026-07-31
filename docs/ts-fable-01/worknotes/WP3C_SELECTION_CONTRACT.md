# WP3-C Vertrag: Reine Auswahl-Engine (core/selection.py)

Fachliche Basis: ADR-003 (F3/F4/F6), UC-06..09/19/20/21/25, Invarianten aus 03 (Regelauflösung, Reproduzierbarkeit, Run-Isolation). Rein, ohne I/O — SQL filtert nur vor, Regeln leben hier (Blueprint §5.3).

## Datentypen (core/selection.py, dataclasses frozen)

- `Rules`: repeat_mode ('no_repeat'|'limited_repeat'|'free_repeat'), min_gap:int≥0, repeat_quota_pct:int 0..100, favorite_weight:float≥1.0, skip_policy ('consume'|'keep_open'|'requeue_later'|'defer_to_end'), new_tracks_policy, duplicate_policy, played_threshold(+seconds). Validierung: `Rules.validate()` → Liste[RuleConflict].
- `Candidate`: run_track_id:int, track_key:str, state ('open'|'played'|'deferred'), play_count:int, last_played_seq:Optional[int], favorite:bool, weight:float, admitted:bool, excluded:bool (excluded/nicht admitted sind KEINE Kandidaten — der Aufrufer filtert; die Engine assertet das defensiv).
- `Selection`: run_track_id, seq, seed_used:int, candidate_count:int, filtered_by:dict (z.B. {"gap":41,"deferred":3,"quota_blocked":2,"gap_relaxed_from":50,"gap_relaxed_to":7}), exhausted:bool (kein Kandidat → Zyklusende/Abschluss).

## Funktionen

1. `plan_cycle(candidates, rules, seed, *, previous_order=None) -> list[run_track_id]`
   Für no_repeat: vollständige Permutation via Fisher-Yates (bestehender core/shuffle-Algorithmus wiederverwenden inkl. Similarity-Guard gegen previous_order). Für Wiederholungsmodi: rollierender Horizont (Länge min(50, n)) über wiederholte select_next-Aufrufe.
2. `select_next(candidates, rules, seed, seq) -> Selection`
   Deterministisch: derselbe Input ⇒ dieselbe Wahl. Zug-Seed = stabiler Hash(seed, seq) (kein Python-hash()!, nutze hashlib/struct).
   Auswahllogik: (1) harte Filter: state='open' bevorzugt; bei limited/free_repeat auch 'played' mit gap-Prüfung seq - last_played_seq > min_gap; quota: Anteil Wiederholungen an den letzten 100 Zügen ≤ repeat_quota_pct (Aufrufer liefert repeat_count_window als Parameter — halte die Funktion rein: `select_next(..., recent_repeat_share:float)`). (2) Gewichtung: weight × (favorite_weight wenn favorite). (3) Ziehung: gewichtete Auswahl mit Zug-Seed. (4) Relaxationsleiter NUR für min_gap (F6): wenn kein Kandidat gap-konform, senke gap auf max erfüllbares k, protokolliere in filtered_by; Nutzer-Ausschlüsse NIEMALS relaxen (sind eh keine Kandidaten). (5) exhausted=True wenn im no_repeat-Modus keine offenen admitted Titel bleiben.
3. `apply_skip(state, skip_policy) -> neuer state + requeue-Anweisung` (consume→played; keep_open→open bleibt, Karte NICHT verbraucht — Cursor rückt trotzdem im Plan weiter, Titel bleibt im Pool; requeue_later→deferred mit Wiedervorlage nach ≥10 Zügen; defer_to_end→deferred bis alle offenen durch sind).
4. `preflight(candidates, rules) -> list[RuleConflict]` (RUN-05): min_gap ≥ admitted_count ⇒ Konflikt mit Korrekturvorschlag (max k); quota 0 mit repeat_mode limited ⇒ Konflikt; leere Kandidatenmenge ⇒ Konflikt.

## Invarianten (Property-Test-Ziele, unabhängiger Opus-Lauf schreibt sie)

P1 No-Repeat: über einen kompletten Zyklus wird jeder admitted-offene Titel exakt einmal gewählt, keiner doppelt (beliebige seeds/n bis 10_000).
P2 Min-Gap hart: in jeder Auswahlfolge gilt für jede Wiederholung seq_neu - seq_alt > effektives gap; Relaxation nur dokumentiert (filtered_by) und nie unter Nutzer-Ausschluss-Bruch.
P3 Determinismus: gleiche (candidates, rules, seed, seq[, recent_repeat_share]) ⇒ identische Selection (auch über Prozessgrenzen — kein hash()).
P4 Gewichtung statistisch: bei favorite_weight=3 und genügend Zügen liegt der Favoriten-Anteil signifikant über Gleichverteilung (Toleranzfenster, kein exakter Wert), WÄHREND P2 nie verletzt wird.
P5 Ausschlüsse absolut: excluded/nicht-admitted erscheinen in keiner Selection.
P6 Skip-Policies: je Policy die spezifizierte Zustandsfolge; requeue_later-Titel erscheinen wieder, defer_to_end-Titel erst nach Erschöpfung der offenen.
P7 Quota: Wiederholungsanteil überschreitet repeat_quota_pct nicht (bei erfüllbarer Lage).
P8 exhausted korrekt: genau dann, wenn kein regelkonformer Kandidat existiert und keine Relaxation zulässig ist.

## Anbindung (WP3-D, nicht Teil von WP3-C)

runs-Service materialisiert Kandidaten aus run_tracks, ruft plan_cycle/select_next, persistiert run_plan/run_selections mit candidate_hash + filtered_by_json, schreibt rules_hash aus run_config_versions.
