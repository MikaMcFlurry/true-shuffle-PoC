import { describe, expect, it } from "vitest";
import type { HubDeps } from "../../src/worker/hub/hub";
import {
	ARTIST_ALBUMS_ENDPOINT,
	RequestBudget,
	type SpotifyClient,
	type SpotifyCooldown,
	type SpotifyCooldownScope,
} from "../../src/worker/spotify/client";
import { SpotifyGate, type SpotifyGateState } from "../../src/worker/spotify/gate";

interface SpotifyMetricPeriod {
	hour: number;
	counts: Record<string, number>;
}

import { onboarded, T0 } from "../hub/harness";

type H = Awaited<ReturnType<typeof onboarded>>;
const artistId = `A${"0".repeat(21)}`;
const probePath = `/artists/${artistId}/albums`;
const client = (h: H) =>
	(h.hub as unknown as { client(b: RequestBudget): SpotifyClient }).client(new RequestBudget(40));
const fail = (retry?: string, reason = "QUOTA_EXCEEDED") => ({
	status: 429,
	count: 1,
	body: { error: { status: 429, reason, message: "private upstream contents" } },
	headers: retry === undefined ? undefined : { "Retry-After": retry },
});
function sharedFixture() {
	const states = new Map<SpotifyCooldownScope | undefined, SpotifyGateState>();
	let now = T0;
	let seq = 0;
	const gate = (scope?: SpotifyCooldownScope) =>
		new SpotifyGate(
			{
				get: () => states.get(scope) ?? null,
				set: (s) => {
					states.set(scope, s);
				},
			},
			() => now,
		);
	const account = (): NonNullable<HubDeps["sharedSpotify"]> => {
		const tokens = new Map<SpotifyCooldownScope | undefined, string>();
		return {
			getCooldown: async (scope) => gate(scope).get(tokens.get(scope)),
			getSnapshot: async (scope) => gate(scope).snapshot(tokens.get(scope)),
			setCooldown: async (c) => gate(c.scope).block(c, tokens.get(c.scope)),
			beginRecheck: async (scope) => {
				const token = gate(scope).begin(`probe-${++seq}`);
				if (token) tokens.set(scope, token);
				return token !== null;
			},
			finishRecheck: async (ok, scope) => {
				const token = tokens.get(scope);
				tokens.delete(scope);
				if (token) gate(scope).finish(token, ok);
			},
		};
	};
	return {
		gate,
		account,
		advance: (ms: number) => {
			now += ms;
		},
	};
}
function putKv(h: H, key: string, value: unknown) {
	h.sql.run(
		"INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
		key,
		JSON.stringify(value),
	);
}
function legacy(h: H): SpotifyCooldown {
	return {
		until: h.clock.t + 3600000,
		kind: "quota",
		reason: "QUOTA_EXCEEDED",
		retryAfter: "3600",
		observedAt: h.clock.t,
	};
}
function proof(h: H): SpotifyMetricPeriod {
	return {
		hour: Math.floor(h.clock.t / 3600000),
		counts: {
			[`read:${ARTIST_ALBUMS_ENDPOINT}:429:quota`]: 1,
			"read:/me/player:200:none": 1,
			"read:/me/player/devices:200:none": 1,
			"read:/me/player/recently-played:200:none": 1,
			"read:/me/player/devices:429:blocked": 3,
		},
	};
}
function seedLegacy(h: H, c: SpotifyCooldown, m: SpotifyMetricPeriod) {
	putKv(h, "spotify_cooldown", c);
	putKv(h, "backoff", { until: c.until, kind: c.kind });
	putKv(h, "spotify_request_metrics", m);
}

describe("exact application artist-albums quota scope", () => {
	it("keeps successful playback paths usable after a real artist-albums quota; suppresses only that GET family", async () => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = fail("86400");
		await expect(client(h).artistAlbums(artistId)).rejects.toMatchObject({
			kind: "quota",
			scope: "artist-albums",
			endpoint: ARTIST_ALBUMS_ENDPOINT,
		});
		expect((await h.hub.play(h.allId)).ok).toBe(true);
		const calls = h.fake.calls.length;
		h.restart();
		await client(h).player();
		await client(h).devices();
		await client(h).recentlyPlayed();
		await client(h).setShuffle(false);
		await client(h).setRepeat("off");
		await client(h).pause();
		await client(h).resume();
		await client(h).artist(h.fake.tracks.values().next().value!.artistId);
		await expect(client(h).artistAlbums(artistId)).rejects.toMatchObject({
			scope: "artist-albums",
			retryAfterMs: 86400000,
		});
		expect(h.fake.calls.length).toBe(calls + 8);
		const diagnostics = (await h.hub.spotifyDiagnostics()) as {
			cooldown: unknown;
			artistAlbumsCooldown: SpotifyCooldown;
		};
		expect(diagnostics.cooldown).toBeNull();
		expect(diagnostics.artistAlbumsCooldown.endpoint).toBe(ARTIST_ALBUMS_ENDPOINT);
		expect(JSON.stringify(diagnostics)).not.toMatch(
			new RegExp(`${artistId}|probePath|private upstream`),
		);
		expect((await h.hub.play(h.allId)).ok).toBe(true);
	});
	it.each(["UNKNOWN", "QUOTA_EXCEEDED"])(
		"keeps rate and other-endpoint quota gates global (%s)",
		async (reason) => {
			const h = await onboarded({ tracks: 30 });
			h.fake.failNext = fail("3600", reason);
			if (reason === "UNKNOWN")
				await expect(client(h).artistAlbums(artistId)).rejects.toMatchObject({
					kind: "rate",
					scope: undefined,
				});
			else
				await expect(client(h).artist(artistId)).rejects.toMatchObject({
					kind: "quota",
					scope: undefined,
				});
			const calls = h.fake.calls.length;
			await expect(h.hub.devices()).rejects.toMatchObject({ status: 429 });
			expect(h.fake.calls.length).toBe(calls);
		},
	);
	it("unknown scope recheck uses the actual held artist source; player200 never clears it", async () => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = fail();
		await expect(client(h).artistAlbums(artistId)).rejects.toMatchObject({
			scope: "artist-albums",
		});
		await client(h).player();
		await expect(client(h).artistAlbums(artistId)).rejects.toMatchObject({
			scope: "artist-albums",
		});
		const before = h.fake.calls.length;
		h.restart();
		await h.hub.retryQuota();
		expect(h.fake.calls.slice(before)).toEqual([`GET /v1${probePath}`]);
		await client(h).artistAlbums(artistId);
	});
	it.each([
		undefined,
		"https://other.test/artists/secret/albums",
		"/artists/private/albums",
		`/artists/${artistId}/albums?token=secret`,
	])("missing/invalid probe source cannot clear or send a request (%s)", async (source) => {
		const h = await onboarded({ tracks: 30 });
		putKv(h, "spotify_artist_albums_cooldown", {
			until: null,
			kind: "quota",
			reason: "QUOTA_EXCEEDED",
			retryAfter: null,
			observedAt: h.clock.t,
			scope: "artist-albums",
			endpoint: ARTIST_ALBUMS_ENDPOINT,
			probePath: source,
		});
		const calls = h.fake.calls.length;
		await expect(h.hub.retryQuota()).rejects.toMatchObject({ status: 409 });
		expect(h.fake.calls.length).toBe(calls);
		await expect(client(h).artistAlbums(artistId)).rejects.toMatchObject({
			scope: "artist-albums",
		});
	});
	it("future artist deadline cannot be manually bypassed", async () => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = fail("172800");
		await expect(client(h).artistAlbums(artistId)).rejects.toMatchObject({
			retryAfterMs: 172800000,
		});
		const calls = h.fake.calls.length;
		await expect(h.hub.retryQuota()).rejects.toMatchObject({ status: 429 });
		expect(h.fake.calls.length).toBe(calls);
	});
	it("combined scopes retain independent deadlines; clearing global leaves artist closed", async () => {
		const h = await onboarded({ tracks: 30 });
		h.fake.failNext = fail("86400");
		await expect(client(h).artistAlbums(artistId)).rejects.toMatchObject({
			scope: "artist-albums",
		});
		h.fake.failNext = fail();
		await expect(client(h).player()).rejects.toMatchObject({ scope: undefined });
		await expect(client(h).artistAlbums(artistId)).rejects.toMatchObject({ scope: undefined });
		await h.hub.retryQuota();
		await h.hub.devices();
		await expect(client(h).artistAlbums(artistId)).rejects.toMatchObject({
			scope: "artist-albums",
			retryAfterMs: 86400000,
		});
	});
	it("scoped gate coordinates isolated accounts across eviction and successful scoped recheck", async () => {
		const shared = sharedFixture();
		const a = await onboarded({ tracks: 30, sharedSpotify: shared.account() });
		const b = await onboarded({ tracks: 35, sharedSpotify: shared.account() });
		a.fake.failNext = fail();
		await expect(client(a).artistAlbums(artistId)).rejects.toMatchObject({
			scope: "artist-albums",
		});
		b.restart();
		const before = b.fake.calls.length;
		await b.hub.devices();
		await expect(client(b).artistAlbums(artistId)).rejects.toMatchObject({
			scope: "artist-albums",
		});
		expect(b.fake.calls.length).toBe(before + 1);
		await b.hub.retryQuota();
		a.restart();
		await client(a).artistAlbums(artistId);
		expect(shared.gate("artist-albums").get()).toBeNull();
		expect(shared.gate().get()).toBeNull();
	});
});

describe("legacy global cooldown preservation", () => {
	it.each(["local", "first-shared", "merged-shared", "merged-before-publication"])(
		"keeps artist-looking old metadata global without trusting incomplete hour history (%s)",
		async (mode) => {
			const shared = sharedFixture();
			const h = await onboarded({
				tracks: 30,
				sharedSpotify: mode === "local" ? undefined : shared.account(),
			});
			const c = { ...legacy(h), endpoint: ARTIST_ALBUMS_ENDPOINT };
			const oldRate: SpotifyCooldown = {
				kind: "rate",
				until: c.observedAt + 1200000,
				retryAfter: "4800",
				observedAt: c.observedAt - 3600000,
				endpoint: "/me/player",
			};
			seedLegacy(h, c, proof(h));
			if (mode === "merged-shared") {
				shared.gate().block(oldRate);
				shared.gate().block(c);
			}
			if (mode === "first-shared" || mode === "merged-before-publication") shared.gate().block(c);
			h.restart();
			const before = h.fake.calls.length;
			const d = (await h.hub.spotifyDiagnostics()) as {
				cooldown: SpotifyCooldown;
				artistAlbumsCooldown: SpotifyCooldown | null;
			};
			expect(d.cooldown.until).toBe(c.until);
			expect(d.artistAlbumsCooldown).toBeNull();
			await expect(h.hub.devices()).rejects.toMatchObject({ kind: "quota" });
			await expect(client(h).player()).rejects.toMatchObject({ kind: "quota", scope: undefined });
			await expect(h.hub.retryQuota()).rejects.toMatchObject({ status: 429 });
			expect(h.fake.calls.length).toBe(before);
			if (mode !== "local") {
				expect(shared.gate().get()?.until).toBe(c.until);
				expect(shared.gate("artist-albums").get()).toBeNull();
			}
		},
	);
});
