import { describe, expect, it, vi } from "vitest";
import { boundedSpotifyRpc } from "../../src/worker/spotify/rpc";

describe("provider gate RPC failure bounds", () => {
	it("sanitizes provider coordination errors", async () => {
		await expect(
			boundedSpotifyRpc(Promise.reject(new Error("private account or token"))),
		).rejects.toMatchObject({
			kind: "network",
			status: 503,
			message: "Die Spotify-Anbietersperre ist nicht erreichbar",
		});
	});
	it("rejects a hanging gate with a deterministic timeout and ignores late completion", async () => {
		vi.useFakeTimers();
		try {
			let resolve!: (result: number) => void;
			const work = new Promise<number>((r) => {
				resolve = r;
			});
			const result = boundedSpotifyRpc(work, 15000);
			const assertion = expect(result).rejects.toMatchObject({ kind: "network", status: 503 });
			await vi.advanceTimersByTimeAsync(15000);
			await assertion;
			resolve(42);
			await work;
		} finally {
			vi.useRealTimers();
		}
	});
});
