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

	it("a device of the same name that was not chosen never counts as guest", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		const u = h.fake.user();
		u.devices[0]!.name = "iPhone";
		u.devices.push({ id: "party-iphone", name: "iPhone", type: "Smartphone", restricted: false });
		h.hub.setGuestDevices([{ id: "party-iphone", name: "iPhone" }]);
		await h.hub.play(sid);
		u.player.deviceId = u.devices[0]!.id;
		await h.listen(20 * MINUTE_MS);
		expect((await h.hub.state()).guest.active).toBe(false);
		u.player.deviceId = "party-iphone";
		await h.listen(20 * MINUTE_MS);
		expect((await h.hub.state()).guest).toMatchObject({ active: true, device: "iPhone" });
	});

	it("after a seen switch to the owner's phone, the song started there counts", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		const party = addParty(h);
		h.hub.setGuestDevices([{ id: party, name: "Partyraum" }]);
		const p = h.fake.user().player;
		const phone = h.fake.user().devices[0]!.id;
		expect((await h.hub.play(sid)).ok).toBe(true);
		p.deviceId = party;
		await h.listen(10_000);
		await h.hub.state({ live: true, refresh: true });
		expect((await h.hub.state()).guest.active).toBe(true);
		// Another song, on the owner's own phone, seen after ten seconds.
		p.deviceId = phone;
		h.fake.skip();
		const own = h.fake.current()!;
		await h.listen(10_000);
		await h.hub.state({ live: true, refresh: true });
		expect((await h.hub.state()).guest.active).toBe(false);
		await h.listen(35_000);
		h.fake.skip();
		await h.listen(5 * MINUTE_MS);
		const row = h.sql.first<{ ignored: number }>(
			`SELECT ignored FROM plays WHERE track_id = ? ORDER BY played_at DESC`,
			own,
		);
		expect(row?.ignored).toBe(0);
	});

	it("taking a device off the list ends the guest time it holds at once", async () => {
		const h = await onboarded({ tracks: 300 });
		const sid = h.stationIds[0]!;
		const party = addParty(h);
		h.hub.setGuestDevices([{ id: party, name: "Partyraum" }]);
		await h.hub.play(sid);
		h.fake.user().player.deviceId = party;
		await h.listen(10 * MINUTE_MS);
		expect((await h.hub.state()).guest.active).toBe(true);
		h.hub.setGuestDevices([]);
		expect((await h.hub.state()).guest.active).toBe(false);
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
