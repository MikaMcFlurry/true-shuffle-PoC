/**
 * P1: rows read on the Durable Objects over one day, measured with the local
 * rows-read model (test/hub/rows-read.ts) on the real HubCore and the real
 * usage tracker. Scenario of the 22.10. outage: 4 h playback with the app
 * visible (the client's own poll cadence), then 20 h paused with the app
 * closed, a song turned down in the deck.
 *
 * Writes the figures to $TS_EVIDENCE_DIR/do-reads-budget.json when set.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { statePollMs } from "../../src/shared/poll-pace";
import { SpotifyUsageTracker } from "../../src/worker/spotify/usage";
import { nodeSql, onboarded } from "./harness";
import { countingSql } from "./rows-read";

/** Rows read by 1.2.0 (b2aac5bd) in exactly this scenario, measured with this file. */
const BASELINE_1_2_0 = { userHub: 4_841_580, registry: 87_440 };

const EVICT_AFTER_MS = 2 * 60_000;

async function day() {
	const registry = countingSql(nodeSql());
	let clock = () => 0;
	const tracker = new SpotifyUsageTracker(registry, () => clock());
	let hubMeter: ReturnType<typeof countingSql>["meter"] | null = null;
	const h = await onboarded({
		tracks: 600,
		durationMs: 180_000,
		wrapSql: (sql) => {
			const counted = countingSql(sql);
			hubMeter = counted.meter;
			return counted;
		},
		sharedSpotify: {
			recordRequest: async (metric) => tracker.record("listener-1", metric),
			getCooldown: async () => null,
			getSnapshot: async () => ({ revision: 0, cooldown: null }),
			setCooldown: async () => 0,
			beginRecheck: async () => true,
			finishRecheck: async () => {},
		},
	});
	clock = () => h.clock.t;
	await h.hub.play(h.allId);
	await h.listen(10 * 60_000);
	// A song turned down somewhere ahead in the deck (what Mika does every day).
	const st = await h.hub.state({ live: true });
	const ahead = st.session?.queue.at(-1)?.track.id;
	if (ahead) await h.hub.thumb(ahead, -1);
	hubMeter!.reset();
	registry.meter.reset();
	const start = h.fake.calls.length;

	// 4 h playback, app visible: the client polls at its own pace.
	let interactedAt = h.clock.t;
	let polls = 0;
	const playEnd = h.clock.t + 4 * 3600_000;
	while (h.clock.t < playEnd) {
		const view = await h.hub.state({ live: true });
		polls++;
		const wait = statePollMs({
			playing: view.nowPlaying?.isPlaying === true,
			sinceInteractionMs: h.clock.t - interactedAt,
		});
		await h.listen(wait);
		if (polls % 240 === 0) interactedAt = h.clock.t; // a tap now and then
	}
	const afterPlay = { hub: hubMeter!.total, registry: registry.meter.total };
	// 20 h paused, app closed: only the hub's own alarms run. Cloudflare drops
	// an idle object from memory after about a minute or two, so every wake
	// after a longer gap starts cold (all in-memory caches gone).
	h.fake.pause();
	let colds = 0;
	const pauseEnd = h.clock.t + 20 * 3600_000;
	while (h.clock.t < pauseEnd) {
		const next = Math.min(h.alarmAt() ?? pauseEnd, pauseEnd);
		if (next - h.clock.t > EVICT_AFTER_MS) {
			h.restart();
			colds++;
		}
		await h.listen(Math.max(1000, next - h.clock.t));
	}
	const spotify = h.fake.calls.slice(start).filter((c) => / \/(?:v1|accounts)\//.test(c)).length;
	return {
		polls,
		coldStarts: colds,
		spotifyRequests: spotify,
		userHub: hubMeter!.total,
		registry: registry.meter.total,
		playing: afterPlay,
		paused: {
			hub: hubMeter!.total - afterPlay.hub,
			registry: registry.meter.total - afterPlay.registry,
		},
		topHub: hubMeter!.top(8),
		topRegistry: registry.meter.top(5),
	};
}

it("one day (4 h visible playback + 20 h paused) reads at most 10 % of what 1.2.0 read", async () => {
	const r = await day();
	const dir = process.env.TS_EVIDENCE_DIR;
	if (dir)
		writeFileSync(
			join(dir, "do-reads-budget.json"),
			JSON.stringify(
				{ model: "rows-read model, not Cloudflare's meter", baseline: BASELINE_1_2_0, ...r },
				null,
				2,
			),
		);
	console.info(
		JSON.stringify({
			userHub: r.userHub,
			registry: r.registry,
			polls: r.polls,
			spotify: r.spotifyRequests,
		}),
	);
	if (BASELINE_1_2_0.userHub > 0) {
		expect(r.userHub + r.registry).toBeLessThanOrEqual(
			0.1 * (BASELINE_1_2_0.userHub + BASELINE_1_2_0.registry),
		);
	}
}, 600_000);
