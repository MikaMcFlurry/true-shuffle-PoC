import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "../../src/core/types";
import { onboarded } from "./harness";

type H = Awaited<ReturnType<typeof onboarded>>;

const rows = (h: H, from: number, to: number) =>
	h.sql.all<{ track_id: string; ignored: number }>(
		`SELECT track_id, ignored FROM plays WHERE played_at > ? AND played_at <= ? ORDER BY played_at`,
		from,
		to,
	);

/** A second Spotify device on the listener's account, e.g. in a party room. */
function addParty(h: H): string {
	const u = h.fake.user();
	u.devices.push({ id: "party-room", name: "Partyraum", type: "Speaker", restricted: false });
	return "party-room";
}

describe("a device that always counts as guest", () => {
	it("music on it never counts; back on the phone it counts again", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		const party = addParty(h);
		h.hub.setGuestDevices([{ id: party, name: "Partyraum" }]);
		expect((await h.hub.play(sid)).ok).toBe(true);
		await h.listen(20 * MINUTE_MS);
		const p = h.fake.user().player;
		const phone = p.deviceId;
		const before = h.clock.t;
		expect(rows(h, 0, before).some((r) => r.ignored === 0)).toBe(true);
		const memoryBefore = h.sql.all(`SELECT * FROM memory ORDER BY id`);

		p.deviceId = party; // the music moves to the party room
		await h.listen(40 * MINUTE_MS);
		const st = await h.hub.state();
		expect(st.guest).toMatchObject({ active: true, device: "Partyraum" });
		const onParty = rows(h, before + 60_000, h.clock.t);
		expect(onParty.length).toBeGreaterThan(3);
		expect(onParty.every((r) => r.ignored === 1)).toBe(true);
		// Nothing heard there reached the memory.
		const heardThere = new Set(onParty.map((r) => r.track_id));
		const memoryNow = h.sql
			.all<{ id: string }>(`SELECT * FROM memory ORDER BY id`)
			.filter((m) => heardThere.has(m.id));
		const was = (memoryBefore as { id: string }[]).filter((m) => heardThere.has(m.id));
		expect(memoryNow).toEqual(was);

		const back = h.clock.t;
		p.deviceId = phone; // and back on the phone
		await h.listen(40 * MINUTE_MS);
		expect((await h.hub.state()).guest.active).toBe(false);
		const afterBack = rows(h, back + 10 * MINUTE_MS, h.clock.t);
		expect(afterBack.length).toBeGreaterThan(3);
		expect(afterBack.every((r) => r.ignored === 0)).toBe(true);
	});

	it("is matched by name too, when Spotify gives the device a new id", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		addParty(h);
		h.hub.setGuestDevices([{ id: "old-id-from-last-week", name: "Partyraum" }]);
		await h.hub.play(sid);
		h.fake.user().player.deviceId = "party-room";
		await h.listen(20 * MINUTE_MS);
		expect((await h.hub.state()).guest).toMatchObject({ active: true, device: "Partyraum" });
	});

	it("leaves guest time switched on by hand alone", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		const party = addParty(h);
		h.hub.setGuestDevices([{ id: party, name: "Partyraum" }]);
		await h.hub.play(sid);
		await h.hub.setGuest(true, 6);
		h.fake.user().player.deviceId = party;
		await h.listen(20 * MINUTE_MS);
		h.fake.user().player.deviceId = h.fake.user().devices[0]!.id;
		await h.listen(20 * MINUTE_MS);
		const st = await h.hub.state();
		expect(st.guest.active).toBe(true);
		expect(st.guest.device ?? null).toBeNull();
		expect(st.guest.until! - h.clock.t).toBeGreaterThan(5 * 60 * MINUTE_MS);
	});

	it("keeps the list clean and refuses nonsense", async () => {
		const h = await onboarded({ tracks: 40 });
		expect(
			h.hub.setGuestDevices([
				{ id: "a", name: " Partyraum " },
				{ id: "a", name: "Partyraum" },
			]),
		).toEqual([{ id: "a", name: "Partyraum" }]);
		expect((await h.hub.state()).guest.devices).toEqual([{ id: "a", name: "Partyraum" }]);
		expect(() => h.hub.setGuestDevices([{ id: "", name: "x" }])).toThrow();
		expect(() =>
			h.hub.setGuestDevices(Array.from({ length: 21 }, (_, i) => ({ id: `d${i}`, name: "x" }))),
		).toThrow();
		expect(h.hub.setGuestDevices([])).toEqual([]);
		expect((await h.hub.state()).guest.devices).toEqual([]);
	});
});
