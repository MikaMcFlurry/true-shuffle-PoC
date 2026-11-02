import { describe, expect, it } from "vitest";
import { RequestBudget, type SpotifyClient } from "../../src/worker/spotify/client";
import { onboarded, T0 } from "../hub/harness";

const provider = (h: { hub: unknown }) =>
	(h.hub as { client(b: RequestBudget): SpotifyClient }).client(new RequestBudget(20));
const id = `A${"0".repeat(21)}`;
const failure = (reason = "QUOTA_EXCEEDED", retry?: string) => ({
	status: 429,
	count: 1,
	body: { error: { reason } },
	headers: retry ? { "Retry-After": retry } : undefined,
});
describe("confirmed artist operation only", () => {
	it.each(["QUOTA_EXCEEDED", "UNKNOWN"])(
		"429 %s never blocks writes, track catalog, or player",
		async (reason) => {
			const h = await onboarded({ tracks: 30 });
			h.fake.failNext = failure(reason, "3600");
			await expect(provider(h).artistAlbums(id)).rejects.toMatchObject({
				operation: "GET /artists/:id/albums",
			});
			const before = h.fake.calls.length;
			await expect(provider(h).artistAlbums(id)).rejects.toMatchObject({ status: 429 });
			expect(h.fake.calls.length).toBe(before);
			await provider(h).player();
			await provider(h).pause();
			await provider(h).setShuffle(false);
			await provider(h).likedTracks();
		},
	);
	it("artist unknown source is redacted, real explicit retry uses stored safe path", async () => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = failure();
		await expect(provider(h).artistAlbums(id)).rejects.toMatchObject({ retryAfter: null });
		expect(JSON.stringify(await h.hub.spotifyDiagnostics())).not.toContain(id);
		await h.hub.retryQuota("artist-albums");
		expect(h.fake.calls.at(-1)).toBe(`GET /v1/artists/${id}/albums`);
	});
	it("future same-operation deadline cannot be bypassed by retry control", async () => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = failure("QUOTA_EXCEEDED", "86400");
		await expect(provider(h).artistAlbums(id)).rejects.toMatchObject({ kind: "quota" });
		const before = h.fake.calls.length;
		await expect(h.hub.retryQuota("artist-albums")).rejects.toMatchObject({ status: 429 });
		expect(h.fake.calls.length).toBe(before);
	});
	it.each([
		"spotify_cooldown",
		"spotify_legacy_catalog_cooldown",
		"spotify_artist_albums_cooldown",
	])("archives old %s without inferring any blocked endpoint", async (key) => {
		const h = await onboarded({ tracks: 30 });
		h.sql.run("DELETE FROM kv WHERE k='spotify_operation_policy'");
		h.sql.run(
			"INSERT INTO kv(k,v)VALUES(?,?) ON CONFLICT(k)DO UPDATE SET v=excluded.v",
			key,
			JSON.stringify({
				until: T0 + 86400000,
				kind: "quota",
				reason: "QUOTA_EXCEEDED",
				retryAfter: "86400",
				observedAt: T0,
			}),
		);
		h.sql.run(
			"INSERT INTO kv(k,v)VALUES('backoff',?) ON CONFLICT(k)DO UPDATE SET v=excluded.v",
			JSON.stringify({ until: T0 + 86400000, kind: "quota" }),
		);
		h.restart();
		await provider(h).pause();
		await provider(h).player();
		await provider(h).artistAlbums(id);
		expect(h.sql.first("SELECT v FROM kv WHERE k=?", key)).toBeNull();
		expect(h.sql.first("SELECT v FROM kv WHERE k='spotify_operation_policy_backup'")).toBeTruthy();
		expect(
			((await h.hub.spotifyDiagnostics()) as { operationCooldowns: unknown[] }).operationCooldowns,
		).toEqual([]);
	});
	it("new read and write failures have independently saved method keys", async () => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = failure("UNKNOWN", "2");
		await expect(provider(h).player()).rejects.toMatchObject({ operation: "GET /me/player" });
		h.fake.failNext = failure("QUOTA_EXCEEDED", "10");
		await expect(provider(h).pause()).rejects.toMatchObject({ operation: "PUT /me/player/pause" });
		expect(
			(
				(await h.hub.spotifyDiagnostics()) as { operationCooldowns: { operation: string }[] }
			).operationCooldowns.map((c) => c.operation),
		).toEqual(["GET /me/player", "PUT /me/player/pause"]);
	});
});
