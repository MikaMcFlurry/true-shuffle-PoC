import { expect, it } from "vitest";
import { skipsWeigh } from "../../src/core/memory";
import { DAY_MS, MINUTE_MS, type SlotKind } from "../../src/core/types";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

/** Songs of the library skipped three times 40 days ago (heard often a year before). */
async function withShunned(n: number) {
	const h = await onboarded({ tracks: 200 });
	const songs = h.sql
		.all<{ data: string }>(`SELECT data FROM pages WHERE data <> '[]'`)
		.flatMap((r) => (JSON.parse(r.data) as [string][]).map((t) => t[0]));
	const shunned = songs.slice(0, n);
	const now = h.clock.t;
	h.hub.importHistory(
		shunned.map((id) => [id, 9, 3, now - 400 * DAY_MS, now - 40 * DAY_MS]),
		0,
		1,
	);
	return { h, shunned: new Set(shunned) };
}

const deck = (h: H, sid: number) =>
	(
		JSON.parse(
			h.sql.first<{ deck: string }>(`SELECT deck FROM stations WHERE id = ?`, sid)!.deck,
		) as {
			items: { id: string; kind: SlotKind }[];
		}
	).items;

it("a deck carries retests of shunned songs; one plays and shows as such", async () => {
	const { h, shunned } = await withShunned(20);
	const sid = h.stationIds[0]!;
	expect((await h.hub.play(sid)).ok).toBe(true);
	const probes = deck(h, sid).filter((i) => i.kind === "probe");
	expect(probes.length).toBeGreaterThan(0);
	for (const p of probes) expect(shunned.has(p.id)).toBe(true);
	// Listen until the first retest plays: the player says why it is there.
	const first = probes[0]!.id;
	for (let t = 0; t < 120 && h.fake.current() !== first; t++) await h.listen(MINUTE_MS);
	expect(h.fake.current()).toBe(first);
	const state = await h.hub.state({ live: true, refresh: true });
	expect(state.nowPlaying).toMatchObject({ id: first, kind: "probe" });
});

it("no retests when the cassette has them switched off", async () => {
	const { h } = await withShunned(20);
	const sid = h.stationIds[0]!;
	await h.hub.updateStation(sid, { rules: { retestEnabled: false } });
	expect((await h.hub.play(sid)).ok).toBe(true);
	expect(deck(h, sid).some((i) => i.kind === "probe")).toBe(false);
});

it("'Gern wieder' is kept across a restart; 'Eher nicht' moves on to the next song", async () => {
	const { h, shunned } = await withShunned(5);
	const [kept] = [...shunned];
	expect(skipsWeigh(h.hub.memory(kept!), h.clock.t)).toBe(true);
	expect(await h.hub.retestVerdict(kept!, true)).toEqual({ skipped: false });
	h.restart();
	expect(h.hub.memory(kept!)).toMatchObject({ verdict: 1, verdictAt: h.clock.t });
	expect(skipsWeigh(h.hub.memory(kept!), h.clock.t)).toBe(false);

	const sid = h.stationIds[0]!;
	expect((await h.hub.play(sid)).ok).toBe(true);
	await h.listen(MINUTE_MS);
	const playing = h.fake.current()!;
	expect(await h.hub.retestVerdict(playing, false)).toMatchObject({ skipped: true });
	expect(h.fake.current()).not.toBe(playing);
	expect(h.hub.memory(playing)).toMatchObject({ verdict: -1 });
	await expect(h.hub.retestVerdict("nope", true)).rejects.toThrow();
});
