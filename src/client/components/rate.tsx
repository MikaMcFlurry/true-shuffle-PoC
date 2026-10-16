import { ThumbsDown, ThumbsUp } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { TrackView } from "../../shared/api";
import { ApiError, api } from "../api";
import { store, useStore } from "../store";
import { Cover } from "./ui";

const SAID = {
	1: "Als Favorit gemerkt",
	0: "Bewertung zurückgesetzt",
	"-1": "Kommt nie wieder",
} as const;

/** What was chosen, said beside a refusal: the keys still show what is stored. */
const CHOICE = { 1: "Favorit", 0: "keine Bewertung", "-1": "nie wieder" } as const;

/** A song in a list can be rated afterwards: the whole row opens the sheet. */
export function RateHit({ t }: { t: TrackView }) {
	return (
		<button
			type="button"
			class="track__hit"
			aria-label={`${t.name} — ${t.artists} bewerten`}
			onClick={() => store.rate(t)}
		/>
	);
}

/** Its thumb, if it has one. */
export function ThumbMark({ t }: { t: TrackView }) {
	useStore();
	const v = store.thumbOf(t);
	if (v === 1)
		return <ThumbsUp class="track__thumb track__thumb--up" aria-label="Favorit" role="img" />;
	if (v === -1) return <ThumbsDown class="track__thumb" aria-label="Kommt nie wieder" role="img" />;
	return null;
}

/** Thumb up or down for a song from a list: now or long after it played. */
export function RateSheet() {
	const s = useStore();
	const t = s.rating;
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (t && !d.open) d.showModal();
		if (!t && d.open) d.close();
	}, [t]);
	// A rating on its way belongs to its own request, song and account: only
	// its own answer closes the sheet, and only while the sheet still shows that
	// song; a refusal keeps the sheet, the song and the choice, with a retry
	// (CTO RATE-SHEET, 2026-10-15). Cancelling stays possible meanwhile.
	const op = useRef(0);
	const alive = useRef(true);
	useEffect(
		() => () => {
			alive.current = false;
		},
		[],
	);
	const [pending, setPending] = useState<{ op: number; id: string; account: number } | null>(null);
	const [failure, setFailure] = useState<{
		id: string;
		value: -1 | 0 | 1;
		error: string;
		/** The answer got lost (no connection, no or a broken answer): it may be stored all the same. */
		unsure: boolean;
	} | null>(null);
	useEffect(() => {
		if (failure && failure.id !== t?.id) setFailure(null);
	}, [t?.id]);
	// On its way for this song and this sign-in: another account is never held up by it.
	const busy = !!t && pending?.id === t.id && pending.account === store.accountGen;
	const cur = t ? store.thumbOf(t) : 0;
	const set = (v: -1 | 0 | 1) => {
		if (!t || busy || store.load.kind !== "ready") return;
		// Its own sheet (this opening of it) and its own account (this sign-in):
		// reopening the same song, or signing out and in as the same account, starts afresh.
		const mine = {
			op: ++op.current,
			id: t.id,
			name: t.name,
			gen: store.ratingGen,
			account: store.accountGen,
		};
		const ours = () => alive.current && store.accountGen === mine.account;
		const shown = () => ours() && store.ratingGen === mine.gen && store.rating?.id === mine.id;
		setPending({ op: mine.op, id: mine.id, account: mine.account });
		setFailure(null);
		api
			.thumb(mine.id, v)
			.then((r) => {
				// Signed out or another account since: this answer is not theirs.
				if (!ours()) return;
				store.setThumb(mine.id, v);
				if (r?.skipError)
					store.say(
						`${SAID[v]} — gespeichert. Überspringen fehlgeschlagen: ${r.skipError}`,
						"warn",
					);
				else if (shown()) store.say(SAID[v], "info", 3500);
				if (shown()) store.rate(null);
				window.setTimeout(() => void store.refresh(true), 800);
			})
			.catch((e: Error) => {
				if (!ours()) return;
				// Refused by the server: not stored. Lost on the way back: maybe stored — not said either way.
				const unsure = !(e instanceof ApiError) || e.status === 0 || e.code === "invalid_response";
				if (shown()) setFailure({ id: mine.id, value: v, error: e.message, unsure });
				else
					store.say(
						`„${mine.name}“ ${unsure ? "Speicherung nicht bestätigt" : "nicht gespeichert"}: ${e.message}`,
						"error",
					);
			})
			.finally(() => setPending((p) => (p?.op === mine.op ? null : p)));
	};
	const failed = failure && t && failure.id === t.id ? failure : null;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes a modal dialog natively; the tap beside it is only a pointer convenience
		<dialog
			ref={ref}
			class="sheet"
			aria-labelledby="rate-title"
			onClose={() => {
				if (store.rating) store.rate(null);
			}}
			onClick={(e) => {
				// A tap beside the sheet closes it.
				if (e.target === ref.current) store.rate(null);
			}}
		>
			{t ? (
				<div class="sheet__body">
					<div class="sheet__song">
						<Cover src={t.imageUrl} class="cover--md" />
						<div class="track__main">
							<p id="rate-title" class="track__title">
								{t.name}
							</p>
							<p class="track__sub">{t.artists}</p>
						</div>
					</div>
					{cur !== 0 ? (
						<p class="hint sheet__state">
							{cur === 1
								? "Ist Favorit. Noch einmal Daumen hoch nimmt das zurück."
								: "Kommt nie wieder. Noch einmal Daumen runter lässt ihn wieder zu."}
						</p>
					) : null}
					<div class="sheet__actions">
						<button
							type="button"
							class="key"
							aria-pressed={cur === 1}
							disabled={busy}
							onClick={() => set(cur === 1 ? 0 : 1)}
						>
							<ThumbsUp size={20} aria-hidden="true" />
							Daumen hoch: Favorit
						</button>
						<button
							type="button"
							class="key"
							aria-pressed={cur === -1}
							disabled={busy}
							onClick={() => set(cur === -1 ? 0 : -1)}
						>
							<ThumbsDown size={20} aria-hidden="true" />
							Daumen runter: nie wieder
						</button>
						{failed ? (
							<p class="note--error sheet__error" role="alert">
								{failed.unsure ? "Speicherung nicht bestätigt" : "Nicht gespeichert"}:{" "}
								{failed.error} Gewählt war: {CHOICE[failed.value]}.{" "}
								<button type="button" class="act" disabled={busy} onClick={() => set(failed.value)}>
									Nochmal speichern
								</button>
							</p>
						) : null}
						<button type="button" class="act sheet__cancel" onClick={() => store.rate(null)}>
							Abbrechen
						</button>
					</div>
				</div>
			) : null}
		</dialog>
	);
}
