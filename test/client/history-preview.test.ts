/**
 * The Verlauf's sample player (src/client/history-preview.ts, see
 * docs/HISTORY_PREVIEW.md) with a synthetic audio element and resolver:
 * nothing without a tap, one player, every late answer or play() of an
 * earlier tap without effect, every stop really silent.
 */

import { describe, expect, it } from "vitest";
import {
	PREVIEW_MAX_SECONDS,
	type PreviewAudio,
	PreviewController,
} from "../../src/client/history-preview";
import type { PreviewResult } from "../../src/shared/api";

class FakeAudio implements PreviewAudio {
	src = "";
	preload = "auto";
	currentTime = 0;
	playing = false;
	/** Each play(): settle it by hand, or leave it open. */
	plays: { src: string; ok: () => void; fail: (name: string) => void }[] = [];
	autoplay: "ok" | "manual" | "NotAllowedError" | "NotSupportedError" = "ok";
	private on = new Map<string, (() => void)[]>();
	play(): Promise<void> {
		return new Promise((resolve, reject) => {
			const src = this.src;
			const ok = () => {
				this.playing = true;
				resolve();
			};
			const fail = (name: string) => reject(Object.assign(new Error(name), { name }));
			this.plays.push({ src, ok, fail });
			if (this.autoplay === "ok") ok();
			else if (this.autoplay !== "manual") fail(this.autoplay);
		});
	}
	pause() {
		this.playing = false;
	}
	load() {}
	removeAttribute(name: string) {
		if (name === "src") this.src = "";
	}
	addEventListener(type: string, fn: () => void) {
		this.on.set(type, [...(this.on.get(type) ?? []), fn]);
	}
	fire(type: string) {
		for (const fn of this.on.get(type) ?? []) fn();
	}
}

const READY = (n: number, expiresAt: number | null = null): PreviewResult => ({
	status: "ready",
	source: "deezer",
	url: `https://cdnt-preview.dzcdn.net/api/1/1/s/y/n/t/${n}.mp3`,
	expiresAt,
	title: `Song ${n}`,
	artist: "Artist",
	album: "Album",
	link: `https://www.deezer.com/track/${n}`,
});

function setup() {
	const asked: {
		trackId: string;
		playedAt: number;
		answer: (r: PreviewResult) => void;
		fail: (e: unknown) => void;
	}[] = [];
	let audios = 0;
	const audio = new FakeAudio();
	const clock = { t: 1_000_000 };
	const c = new PreviewController({
		resolve: (trackId, playedAt) =>
			new Promise((answer, fail) => asked.push({ trackId, playedAt, answer, fail })),
		audio: () => {
			audios++;
			return audio;
		},
		now: () => clock.t,
	});
	return { c, asked, audio, clock, audios: () => audios };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("history preview: the page's player", () => {
	it("does nothing at all without a tap", () => {
		const { c, asked, audios } = setup();
		expect(c.view("A", 1)).toEqual({ phase: "idle", message: null, found: null });
		c.pause();
		c.reset();
		c.forget();
		expect(asked).toHaveLength(0);
		expect(audios()).toBe(0);
	});

	it("tap: looks up, plays; tap: stops silent; tap: plays again without asking again", async () => {
		const { c, asked, audio } = setup();
		c.tap("A", 1);
		expect(c.view("A", 1).phase).toBe("loading");
		asked[0]!.answer(READY(1));
		await flush();
		expect(c.view("A", 1).phase).toBe("playing");
		expect(audio.preload).toBe("none");
		expect(audio.src).toContain("/1.mp3");
		c.tap("A", 1);
		expect(c.view("A", 1).phase).toBe("stopped");
		expect(audio.playing).toBe(false);
		expect(audio.src).toBe("");
		c.tap("A", 1);
		await flush();
		expect(c.view("A", 1).phase).toBe("playing");
		expect(asked).toHaveLength(1);
		expect(audio.plays).toHaveLength(2);
	});

	it("stops at its natural end, and never runs past 30 seconds", async () => {
		const { c, asked, audio } = setup();
		c.tap("A", 1);
		asked[0]!.answer(READY(1));
		await flush();
		audio.fire("ended");
		expect(c.view("A", 1).phase).toBe("stopped");
		c.tap("A", 1);
		await flush();
		audio.currentTime = PREVIEW_MAX_SECONDS - 0.5;
		audio.fire("timeupdate");
		expect(c.view("A", 1).phase).toBe("playing");
		audio.currentTime = PREVIEW_MAX_SECONDS;
		audio.fire("timeupdate");
		expect(c.view("A", 1).phase).toBe("stopped");
		expect(audio.playing).toBe(false);
	});

	it("A → B → A quickly: a late answer for A never plays", async () => {
		const { c, asked, audio } = setup();
		c.tap("A", 1);
		c.tap("B", 2);
		expect(c.view("A", 1).phase).toBe("idle");
		asked[0]!.answer(READY(1)); // A's answer, late
		await flush();
		expect(audio.plays).toHaveLength(0);
		asked[1]!.answer(READY(2));
		await flush();
		expect(c.view("B", 2).phase).toBe("playing");
		expect(audio.src).toContain("/2.mp3");
		c.tap("A", 1);
		expect(c.view("B", 2).phase).toBe("idle");
		expect(audio.playing).toBe(false);
		expect(asked).toHaveLength(3);
		asked[2]!.answer(READY(1));
		await flush();
		expect(c.view("A", 1).phase).toBe("playing");
		expect(audio.src).toContain("/1.mp3");
	});

	it("the same song twice in the Verlauf is two rows", async () => {
		const { c, asked } = setup();
		c.tap("A", 1);
		asked[0]!.answer(READY(1));
		await flush();
		expect(c.view("A", 1).phase).toBe("playing");
		expect(c.view("A", 2).phase).toBe("idle");
		c.tap("A", 2);
		expect(c.view("A", 1).phase).toBe("idle");
		expect(asked[1]).toMatchObject({ trackId: "A", playedAt: 2 });
	});

	it("a play() that answers after the stop is silenced again", async () => {
		const { c, asked, audio } = setup();
		audio.autoplay = "manual";
		c.tap("A", 1);
		asked[0]!.answer(READY(1));
		await flush();
		expect(c.view("A", 1).phase).toBe("loading"); // starting: play() not answered yet
		c.reset(); // left the page
		audio.plays[0]!.ok(); // the browser starts it only now
		await flush();
		expect(audio.playing).toBe(false);
		expect(c.view("A", 1).phase).toBe("idle");
	});

	it("an old play() answering late leaves a newer start alone", async () => {
		const { c, asked, audio } = setup();
		audio.autoplay = "manual";
		c.tap("A", 1);
		asked[0]!.answer(READY(1));
		await flush();
		c.pause(); // the tab hides while it starts: stopped (review P2-01)
		expect(c.view("A", 1).phase).toBe("stopped");
		c.tap("A", 1); // a second, deliberate start, play() open
		audio.plays[0]!.ok(); // the first one answers late
		await flush();
		audio.plays[1]!.ok();
		await flush();
		expect(c.view("A", 1).phase).toBe("playing");
		expect(audio.playing).toBe(true);
	});

	it("a browser that refuses play() gets an honest second tap, not a workaround", async () => {
		const { c, asked, audio } = setup();
		audio.autoplay = "NotAllowedError";
		c.tap("A", 1);
		asked[0]!.answer(READY(1));
		await flush();
		expect(c.view("A", 1)).toMatchObject({
			phase: "ready",
			message: expect.stringContaining("nochmal tippen"),
		});
		expect(audio.plays).toHaveLength(1);
		audio.autoplay = "ok";
		c.tap("A", 1);
		await flush();
		expect(c.view("A", 1).phase).toBe("playing");
		expect(asked).toHaveLength(1);
	});

	it("media errors and unknown play() failures say error; a tap asks again, once", async () => {
		const { c, asked, audio } = setup();
		audio.autoplay = "NotSupportedError";
		c.tap("A", 1);
		asked[0]!.answer(READY(1));
		await flush();
		expect(c.view("A", 1).phase).toBe("error");
		audio.autoplay = "ok";
		c.tap("A", 1);
		expect(asked).toHaveLength(2);
		asked[1]!.answer(READY(1));
		await flush();
		expect(c.view("A", 1).phase).toBe("playing");
		audio.fire("error"); // e.g. the signed address was refused
		expect(c.view("A", 1).phase).toBe("error");
		expect(audio.playing).toBe(false);
		await flush();
		expect(asked).toHaveLength(2); // no retry by itself
		c.tap("A", 1);
		expect(asked).toHaveLength(3);
	});

	it("an error from asking (offline, timeout) is said; no retries by itself", async () => {
		const { c, asked } = setup();
		c.tap("A", 1);
		asked[0]!.fail(Object.assign(new Error("x"), { code: "offline", status: 0 }));
		await flush();
		expect(c.view("A", 1)).toMatchObject({
			phase: "error",
			message: expect.stringContaining("Keine Verbindung"),
		});
		c.tap("A", 1);
		asked[1]!.answer({ status: "error", reason: "rate", message: "Pause" });
		await flush();
		expect(c.view("A", 1)).toMatchObject({ phase: "error", message: "Pause" });
		await flush();
		expect(asked).toHaveLength(2);
	});

	it("no sample: said for that row, and its key stops nothing else", async () => {
		const { c, asked, audio } = setup();
		c.tap("A", 1);
		asked[0]!.answer({ status: "unavailable", reason: "ambiguous", message: "mehrdeutig" });
		await flush();
		expect(c.view("A", 1)).toMatchObject({ phase: "unavailable", message: "mehrdeutig" });
		c.tap("B", 2);
		asked[1]!.answer(READY(2));
		await flush();
		expect(c.view("A", 1).phase).toBe("unavailable");
		c.tap("A", 1);
		expect(c.view("B", 2).phase).toBe("playing");
		expect(audio.playing).toBe(true);
		expect(asked).toHaveLength(2);
	});

	it("background, leaving, signing out: silent, and nothing comes back by itself", async () => {
		const { c, asked, audio } = setup();
		c.tap("A", 1);
		asked[0]!.answer(READY(1));
		await flush();
		c.pause(); // tab hidden
		expect(c.view("A", 1).phase).toBe("stopped");
		expect(audio.playing).toBe(false);
		c.tap("B", 2);
		c.pause(); // hidden while looking up
		asked[1]!.answer(READY(2));
		await flush();
		expect(c.view("B", 2).phase).toBe("idle");
		expect(audio.plays).toHaveLength(1);
		c.tap("C", 3);
		asked[2]!.answer({ status: "unavailable", reason: "no_match", message: "nix" });
		await flush();
		c.tap("D", 4);
		asked[3]!.answer(READY(4));
		await flush();
		c.forget(); // signed out / another account
		expect(audio.playing).toBe(false);
		expect(c.view("D", 4).phase).toBe("idle");
		expect(c.view("C", 3).phase).toBe("idle"); // nothing of the account before
	});

	it("a signed address about to run out is asked for again on the tap", async () => {
		const { c, asked, clock } = setup();
		c.tap("A", 1);
		asked[0]!.answer(READY(1, clock.t + 10 * 60_000));
		await flush();
		c.tap("A", 1); // stop
		clock.t += 10 * 60_000;
		c.tap("A", 1);
		expect(c.view("A", 1).phase).toBe("loading");
		expect(asked).toHaveLength(2);
	});
});

/**
 * Review 2026-10-18 (P2-01): a play() still open when the tab goes to the
 * background, the same key is tapped, the page is left or the account
 * changes must never start later — whether it is then fulfilled or refused —
 * and must never stop a newer start the listener asked for.
 */
describe("history preview: a start still on its way (P2-01)", () => {
	async function opening() {
		const s = setup();
		s.audio.autoplay = "manual";
		s.c.tap("A", 1);
		s.asked[0]!.answer(READY(1));
		await flush();
		expect(s.audio.plays).toHaveLength(1); // play() asked, not answered
		return s;
	}
	const stops = {
		background: (c: PreviewController) => c.pause(),
		"same key": (c: PreviewController) => c.tap("A", 1),
		leaving: (c: PreviewController) => c.reset(),
		"another account": (c: PreviewController) => c.forget(),
	};
	for (const [what, stop] of Object.entries(stops))
		for (const late of ["fulfilled", "refused"] as const)
			it(`${what}, then the open play() is ${late}: silent, and it stays silent`, async () => {
				const { c, audio, asked } = await opening();
				stop(c);
				expect(audio.playing).toBe(false);
				expect(audio.src).toBe("");
				if (late === "fulfilled") audio.plays[0]!.ok();
				else audio.plays[0]!.fail("NotAllowedError");
				await flush();
				// The browser may have started it: the page must have silenced it again.
				if (late === "fulfilled") expect(audio.playing).toBe(false);
				expect(c.view("A", 1).phase).not.toBe("playing");
				expect(c.view("A", 1).phase).not.toBe("ready");
				// Visible again: nothing comes back by itself.
				await flush();
				expect(audio.playing).toBe(false);
				expect(audio.plays).toHaveLength(1);
				expect(asked).toHaveLength(1);
			});

	it("the same key during the start stops it; the next tap starts anew, and the old answer leaves it alone", async () => {
		const { c, audio, asked } = await opening();
		c.tap("A", 1); // stop while starting
		expect(c.view("A", 1).phase).toBe("stopped");
		c.tap("A", 1); // a new, deliberate start
		const fresh = asked.length === 2 ? asked[1]! : null;
		if (fresh) fresh.answer(READY(1));
		await flush();
		expect(audio.plays).toHaveLength(2);
		audio.plays[0]!.ok(); // the old one answers late
		await flush();
		audio.plays[1]!.ok();
		await flush();
		expect(c.view("A", 1).phase).toBe("playing");
		expect(audio.playing).toBe(true);
	});

	it("after a refused play() the second tap still plays", async () => {
		const { c, audio } = await opening();
		audio.plays[0]!.fail("NotAllowedError");
		await flush();
		expect(c.view("A", 1).phase).toBe("ready");
		c.pause(); // background while merely ready: nothing to stop
		audio.autoplay = "ok";
		c.tap("A", 1);
		await flush();
		expect(c.view("A", 1).phase).toBe("playing");
	});
});

/**
 * Review 2026-10-18 (P2-03): one tap, at most one lookup. An answer whose
 * signed address is already run out (or about to) ends in a said error; only
 * another tap asks again.
 */
describe("history preview: run-out addresses, one lookup per tap (P2-03)", () => {
	const cases: [string, (t: number) => number][] = [
		["already run out", (t) => t - 1_000],
		["inside the safety margin", (t) => t + 10_000],
		["clock far ahead of Deezer's", (t) => t - 3_600_000],
	];
	for (const [what, exp] of cases)
		it(`the same unusable address every time (${what}): one lookup per tap, then an error`, async () => {
			const { c, asked, clock, audio } = setup();
			c.tap("A", 1);
			asked[0]!.answer(READY(1, exp(clock.t)));
			await flush();
			await flush();
			expect(asked).toHaveLength(1);
			expect(c.view("A", 1).phase).toBe("error");
			expect(c.view("A", 1).message).toMatch(/abgelaufen/);
			expect(audio.plays).toHaveLength(0);
			await flush();
			expect(asked).toHaveLength(1); // nothing by itself
			c.tap("A", 1); // the listener tries again
			expect(asked).toHaveLength(2);
			asked[1]!.answer(READY(1, exp(clock.t)));
			await flush();
			await flush();
			expect(asked).toHaveLength(2);
			expect(c.view("A", 1).phase).toBe("error");
		});

	it("a run-out address replaced by a fresh one on the tap plays, with exactly one more lookup", async () => {
		const { c, asked, clock } = setup();
		c.tap("A", 1);
		asked[0]!.answer(READY(1, clock.t + 10 * 60_000));
		await flush();
		c.tap("A", 1); // stop
		clock.t += 10 * 60_000;
		c.tap("A", 1); // run out: asks once
		expect(asked).toHaveLength(2);
		asked[1]!.answer(READY(1, clock.t + 15 * 60_000));
		await flush();
		expect(c.view("A", 1).phase).toBe("playing");
		expect(asked).toHaveLength(2);
	});

	it("stop or another account while that one lookup runs: its answer does nothing", async () => {
		for (const stop of [
			(c: PreviewController) => c.tap("A", 1),
			(c: PreviewController) => c.forget(),
		]) {
			const { c, asked, clock, audio } = setup();
			c.tap("A", 1);
			asked[0]!.answer(READY(1, clock.t + 10 * 60_000));
			await flush();
			c.tap("A", 1);
			clock.t += 10 * 60_000;
			c.tap("A", 1);
			stop(c);
			asked[1]!.answer(READY(1, clock.t - 1));
			await flush();
			await flush();
			expect(asked).toHaveLength(2);
			expect(audio.playing).toBe(false);
			expect(c.view("A", 1).phase).not.toBe("error");
		}
	});
});

/**
 * Review 2026-10-18 (COR2): the current start's play() refused with
 * AbortError — no stop, reset or newer tap of the page's own — must not leave
 * the row "looking up" with nothing on its way: it ends, said, and only a tap
 * tries again. (No browser cause is claimed; this is the promise's own path.)
 */
describe("history preview: the current start aborted (COR2)", () => {
	async function opening() {
		const s = setup();
		s.audio.autoplay = "manual";
		s.c.tap("A", 1);
		s.asked[0]!.answer(READY(1));
		await flush();
		expect(s.c.view("A", 1).phase).toBe("loading"); // starting
		return s;
	}

	it("ends said and silent, nothing by itself, a tap tries again", async () => {
		const { c, asked, audio } = await opening();
		audio.plays[0]!.fail("AbortError");
		await flush();
		const v = c.view("A", 1);
		expect(v.phase).not.toBe("loading");
		expect(v.phase).toBe("error");
		expect(v.message).toMatch(/unterbrochen/);
		expect(audio.playing).toBe(false);
		await flush();
		await flush();
		expect(asked).toHaveLength(1); // no lookup by itself
		expect(audio.plays).toHaveLength(1); // no play by itself
		audio.autoplay = "ok";
		c.tap("A", 1); // the listener tries again
		expect(asked).toHaveLength(2);
		asked[1]!.answer(READY(1));
		await flush();
		expect(c.view("A", 1).phase).toBe("playing");
	});

	const stops = {
		"same key": (c: PreviewController) => c.tap("A", 1),
		background: (c: PreviewController) => c.pause(),
		leaving: (c: PreviewController) => c.reset(),
		"another account": (c: PreviewController) => c.forget(),
	};
	for (const [what, stop] of Object.entries(stops))
		it(`${what} first, then the AbortError: nothing said, nothing changes`, async () => {
			const { c, asked, audio } = await opening();
			stop(c);
			const before = c.view("A", 1);
			audio.plays[0]!.fail("AbortError");
			await flush();
			expect(c.view("A", 1)).toEqual(before);
			expect(c.view("A", 1).phase).not.toBe("error");
			expect(audio.playing).toBe(false);
			expect(asked).toHaveLength(1);
		});

	it("an old start's AbortError leaves a newer start alone", async () => {
		const { c, audio } = await opening();
		c.tap("A", 1); // stop while starting
		c.tap("A", 1); // a new, deliberate start (kept address)
		expect(audio.plays).toHaveLength(2);
		audio.plays[0]!.fail("AbortError"); // the old one, refused late
		await flush();
		expect(c.view("A", 1).phase).toBe("loading");
		audio.plays[1]!.ok();
		await flush();
		expect(c.view("A", 1).phase).toBe("playing");
		expect(audio.playing).toBe(true);
	});

	it("NotAllowedError still offers the listener's own second tap", async () => {
		const { c, audio, asked } = await opening();
		audio.plays[0]!.fail("NotAllowedError");
		await flush();
		expect(c.view("A", 1).phase).toBe("ready");
		audio.autoplay = "ok";
		c.tap("A", 1);
		await flush();
		expect(c.view("A", 1).phase).toBe("playing");
		expect(asked).toHaveLength(1);
	});
});
