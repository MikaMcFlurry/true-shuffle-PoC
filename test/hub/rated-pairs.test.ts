/**
 * TS-FIX-261016-R5: the hub sends every snapshot song's rating together with
 * its write number, read as one pair: the saved queue, the song playing now,
 * and the Verlauf rows, after ratings written in between. Station details
 * stay as they were (no number). Real HubCore + SQLite + FakeSpotify.
 */
import { expect, it } from "vitest";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

/** The song's rating write number as the hub keeps it (0 when never rated). */
function rated(h: H, id: string): number {
	const c = h.sql.first<{ v: string }>(`SELECT v FROM kv WHERE k = 'rating_clock'`);
	if (!c) return 0;
	const clock = JSON.parse(c.v) as { floor: number; touched: Record<string, number> };
	return clock.touched[id] ?? clock.floor;
}
const thumb = (h: H, id: string) =>
	(h.sql.first<{ thumb: number }>(`SELECT thumb FROM memory WHERE id = ?`, id)?.thumb ?? 0) as
		| -1
		| 0
		| 1;
let n = 0;
async function rate(h: H, id: string, value: -1 | 0 | 1) {
	const a = await h.hub.rateFromHistory({
		actionId: `pairs-act-${++n}`,
		trackId: id,
		value,
		basis: rated(h, id),
	});
	expect(a.kind).toBe("done");
}

it("queue, now playing and Verlauf: each song's thumb comes with the write number it stands at", async () => {
	const h = await onboarded();
	const sid = h.stationIds[0]!;
	expect((await h.hub.play(sid)).ok).toBe(true);
	await h.settle();
	await h.listen(30_000);
	let st = await h.hub.state({ live: true });
	const now = st.nowPlaying;
	expect(now).not.toBeNull();
	const queued = st.session!.queue.map((e) => e.track);
	expect(queued.length).toBeGreaterThan(2);
	// Rate the song playing now and two queued songs, one of them twice.
	const a = queued[1]!.id;
	const b = queued[2]!.id;
	await rate(h, now!.id, 1);
	await rate(h, a, -1);
	await rate(h, b, 1);
	await rate(h, a, 0);
	st = await h.hub.state({ live: true });
	const pairs = [st.nowPlaying!, ...st.session!.queue.map((e) => e.track)];
	for (const t of pairs) {
		expect(t.rated, `${t.id} carries a write number`).toBeTypeOf("number");
		expect({ id: t.id, thumb: t.thumb, rated: t.rated }).toEqual({
			id: t.id,
			thumb: thumb(h, t.id),
			rated: rated(h, t.id),
		});
	}
	expect(st.nowPlaying).toMatchObject({ id: now!.id, thumb: 1, rated: rated(h, now!.id) });
	expect(pairs.find((t) => t.id === a)).toMatchObject({ thumb: 0, rated: rated(h, a) });
	expect(rated(h, a)).toBeGreaterThan(rated(h, b));
	for (const r of h.hub.history(200))
		expect({ thumb: r.thumb, rated: r.rated }).toEqual({
			thumb: thumb(h, r.id),
			rated: rated(h, r.id),
		});
	// Station details are left as they were: no write numbers there.
	const d = h.hub.stationDetail(sid);
	for (const t of [...d.upcoming, ...d.recent]) expect("rated" in t).toBe(false);
});
