import { describe, expect, it } from "vitest";
import { b64urlEncode, Keys } from "../../src/worker/lib/crypto";
import { readRemoteKey, remoteKeyFor } from "../../src/worker/lib/remote-key";

const SECRET = "test-secret-test-secret-test-secret-42";

describe("remote keys", () => {
	it("carry the account and key id, signed", async () => {
		const key = await remoteKeyFor(SECRET, "mika.h|x", "kid123");
		expect(key).toMatch(/^tsr_[A-Za-z0-9_-]+$/);
		expect(await readRemoteKey(SECRET, key)).toEqual({ uid: "mika.h|x", kid: "kid123" });
	});

	it("reject a changed key, another secret and a signed session cookie", async () => {
		const key = await remoteKeyFor(SECRET, "mika", "kid123");
		const flipped = key.slice(0, -2) + (key.endsWith("A") ? "B" : "A") + key.slice(-1);
		expect(await readRemoteKey(SECRET, flipped)).toBeNull();
		expect(await readRemoteKey(`${SECRET}-other`, key)).toBeNull();
		expect(await readRemoteKey(SECRET, "tsr_%%%")).toBeNull();
		expect(await readRemoteKey(SECRET, "")).toBeNull();
		// A session cookie is signed for another purpose and never passes as a key.
		const cookie = await new Keys(SECRET).sign("mika|kid123");
		expect(
			await readRemoteKey(SECRET, `tsr_${b64urlEncode(new TextEncoder().encode(cookie))}`),
		).toBeNull();
		// Nor does a remote key pass as a session cookie.
		const signed = await new Keys(SECRET, "remote-key").sign("mika|kid123");
		expect(await new Keys(SECRET).verify(signed)).toBeNull();
	});
});
