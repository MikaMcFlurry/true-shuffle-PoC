/**
 * What a Verlauf row with ratings says (see docs/HISTORY_RATINGS.md): the
 * status of the song's last rating operation, and — apart from it — what
 * "Nie wieder" would do to the song playing now.
 */

import { type Phase, busy as ratingBusy, ratingName, type SongRating } from "./history-ratings";

/** What a song's rating line says, by what happened last. */
export function ratingLine(value: -1 | 0 | 1, s: SongRating | null): string {
	const now = value === 1 ? "Favorit." : value === -1 ? "Kommt nie wieder." : "";
	const r = s?.receipt;
	const phase: Phase = s?.phase ?? "idle";
	switch (phase) {
		case "saving":
			return `Wird gespeichert: ${ratingName(s!.intent?.value ?? value)} …`;
		case "checking":
			return "Keine Antwort bekommen — es wird nachgesehen, ob es gespeichert ist …";
		case "unclear":
			return `Unklar, ob gespeichert: ${s!.error ?? ""} Nachsehen fragt nur nach, es speichert nichts.`;
		case "failed":
			return `Nicht gespeichert: ${s!.error ?? "unbekannter Fehler"}`;
		case "changed":
			return `Inzwischen anders bewertet (jetzt: ${ratingName(value)}). Hier wurde nichts geändert.`;
		case "undoing":
			return "Wird zurückgenommen …";
		case "undo-failed":
			return `Nicht zurückgenommen: ${s!.error ?? "unbekannter Fehler"}`;
		case "undo-unclear":
			return `Unklar, ob zurückgenommen: ${s!.error ?? ""}`;
		case "undone": {
			const u = r?.undo;
			if (!u) return now;
			if (s?.alreadyUndone)
				return `Gespeichert, aber schon zurückgenommen: ${s.error ?? `jetzt ${ratingName(value)}.`}`;
			if (u.outcome === "conflict") return `Nicht zurückgenommen: ${u.notes.join(" ")}`;
			return [
				`Zurückgenommen: wieder ${ratingName(u.value)}.`,
				...u.notes,
				...(r?.lasting ?? []),
			].join(" ");
		}
		case "saved": {
			const skip =
				r?.skip === "skipped"
					? " Der laufende Song wurde übersprungen."
					: r?.skip === "failed" && r.skipStage === "read"
						? ` Bewertung gespeichert; ob der Song noch läuft, ließ sich nicht prüfen (${r.skipError ?? "Spotify war nicht erreichbar"}) — Überspringen fehlgeschlagen, kein neuer Versuch.`
						: r?.skip === "failed"
							? ` Bewertung gespeichert; Überspringen fehlgeschlagen: ${r.skipError ?? "Spotify hat abgelehnt."}`
							: r?.skip === "pending"
								? " Ob der laufende Song übersprungen wurde, ist unklar; es wird nicht noch einmal versucht."
								: "";
			if (s?.overtaken && r)
				return s.error
					? `Gespeichert war: ${ratingName(r.value)}; ${s.error}${skip}`
					: `Gespeichert war: ${ratingName(r.value)} — inzwischen anders bewertet (jetzt: ${ratingName(value)}).${skip}`;
			return `Gespeichert: ${ratingName(value)}.${skip}`;
		}
		default:
			return now;
	}
}

/**
 * What "Nie wieder" would do to the song playing now, said before it is
 * tapped — whenever that tap is possible, whatever the last status said: a
 * song playing in Spotify is skipped if it still plays when the rating is
 * stored; one on a Home Assistant player is never skipped from here.
 */
export function playbackHint(
	value: -1 | 0 | 1,
	s: SongRating | null,
	playing: { native: boolean } | null,
): string {
	if (!playing || value === -1 || ratingBusy(s)) return "";
	return playing.native
		? "Läuft gerade über Home Assistant: „Nie wieder“ speichert nur die Bewertung, dort wird nicht übersprungen."
		: "Läuft gerade in Spotify: „Nie wieder“ überspringt ihn, wenn er beim Speichern noch läuft.";
}
