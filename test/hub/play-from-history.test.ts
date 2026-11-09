/** P3 step 2: playing a Verlauf song in Spotify only on purpose, on the device named. */

import { expect, it } from "vitest";
import { onboarded } from "./harness";

const PLAY = "PUT /v1/me/player/play";

it("plays exactly the Verlauf song on the device seen, only when asked with that device", async () => {
	const h = await onboarded({ tracks: 30 });
	expect((await h.hub.play(h.allId)).ok).toBe(true);
	await h.listen(10 * 60_000);
	const row = h.hub.history(10)[0]!;
	const device = (await h.hub.state({ live: true })).observed!.device!;
	await expect(
		h.hub.playFromHistory({ trackId: row.id, playedAt: row.playedAt, deviceId: "other" }),
	).rejects.toMatchObject({ status: 409 });
	await expect(
		h.hub.playFromHistory({ trackId: row.id, playedAt: row.playedAt + 1, deviceId: device.id }),
	).rejects.toMatchObject({ status: 404 });
	const calls = h.fake.calls.length;
	const r = await h.hub.playFromHistory({
		trackId: row.id,
		playedAt: row.playedAt,
		deviceId: device.id,
	});
	expect(r.deviceName).toBe(device.name);
	expect(h.fake.calls.slice(calls).filter((c) => c.startsWith(PLAY))).toHaveLength(1);
	expect(h.fake.current()).toBe(row.id);
});
