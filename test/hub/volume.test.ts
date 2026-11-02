/** P8: the volume of the active device, and a plain word where it cannot be changed. */

import { expect, it } from "vitest";
import { onboarded } from "./harness";

it("louder and quieter in steps of five on the active device; a fixed device says so", async () => {
	const h = await onboarded({ tracks: 20 });
	expect((await h.hub.play(h.allId)).ok).toBe(true);
	await h.listen(20_000);
	let st = await h.hub.state({ live: true });
	const device = st.observed!.device!;
	expect(device).toMatchObject({ volume: 50, volumeControl: true });
	expect(await h.hub.changeVolume({ deviceId: device.id, step: 1 })).toMatchObject({ volume: 55 });
	expect(await h.hub.changeVolume({ deviceId: device.id, step: -1 })).toMatchObject({ volume: 50 });
	const fake = h.fake.user("mika").devices.find((d) => d.id === device.id)!;
	expect(fake.volume).toBe(50);
	await expect(h.hub.changeVolume({ deviceId: "other", step: 1 })).rejects.toMatchObject({
		status: 409,
	});
	fake.fixedVolume = true;
	await expect(h.hub.changeVolume({ deviceId: device.id!, step: 1 })).rejects.toMatchObject({
		code: "no_volume",
	});
	st = await h.hub.state();
	expect(st.observed!.device!.volumeControl).toBe(false);
});
