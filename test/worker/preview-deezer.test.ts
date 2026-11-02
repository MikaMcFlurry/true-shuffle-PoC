/**
 * The Verlauf's listening sample, server side (docs/HISTORY_PREVIEW.md): one
 * Deezer search per tap, the same recording or none, only the verified media
 * host, every failure said. All Deezer answers here are synthetic.
 */

import { describe, expect, it } from "vitest";
import {
	PREVIEW_MEDIA_ORIGIN,
	type PreviewSubject,
	resolveDeezerPreview,
	split,
} from "../../src/worker/preview/deezer";

const BASE = "https://fake/deezer";
const SUBJECT: PreviewSubject = {
	name: "Around the World",
	artists: ["Daft Punk"],
	album: "Homework",
	durationMs: 429_000,
};

let n = 1;
function dz(over: Record<string, unknown> = {}): Record<string, unknown> {
	const id = n++;
	return {
		id,
		readable: true,
		title: "Around the World",
		title_short: "Around the World",
		title_version: "",
		isrc: "SYNTH0000001",
		link: `https://www.deezer.com/track/${id}`,
		duration: 429,
		preview: `${PREVIEW_MEDIA_ORIGIN}/api/1/1/s/y/n/t/${id}.mp3?hdnea=exp=1792262524~acl=/x*~hmac=synthetic`,
		artist: { name: "Daft Punk" },
		album: { title: "Homework" },
		...over,
	};
}

function deezer(answer: () => Response | Promise<Response>) {
	const urls: string[] = [];
	return {
		urls,
		fetch: async (req: Request) => {
			urls.push(req.url);
			return answer();
		},
	};
}
const ok = (data: unknown) => () =>
	new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

async function resolve(data: unknown[], subject: PreviewSubject = SUBJECT) {
	const d = deezer(ok({ data }));
	const r = await resolveDeezerPreview(subject, { fetch: d.fetch, base: BASE });
	return { r, urls: d.urls };
}

describe("history preview: Deezer resolver", () => {
	it("finds the one matching recording with exactly one search request", async () => {
		const { r, urls } = await resolve([dz()]);
		expect(urls).toHaveLength(1);
		expect(urls[0]).toBe(`${BASE}/search?q=Daft%20Punk%20Around%20the%20World&limit=25`);
		expect(r.status).toBe("ready");
		if (r.status !== "ready") return;
		expect(new URL(r.url).origin).toBe(PREVIEW_MEDIA_ORIGIN);
		expect(r.expiresAt).toBe(1792262524_000);
		expect(r.source).toBe("deezer");
		expect(r.link).toMatch(/^https:\/\/www\.deezer\.com\/track\/\d+$/);
	});

	it("never takes the first hit blindly: live, remix, remaster and edit are other recordings", async () => {
		const live = dz({
			title: "Around the World (Live)",
			title_version: "(Live)",
			isrc: "L1",
			duration: 430,
		});
		const remix = dz({
			title: "Around the World (I:Cube Remix)",
			title_version: "(I:Cube Remix)",
			isrc: "R1",
			duration: 429,
		});
		const remaster = dz({
			title: "Around the World (Remastered)",
			title_version: "(Remastered)",
			isrc: "M1",
		});
		const edit = dz({
			title: "Around the World (Radio Edit)",
			title_version: "(Radio Edit)",
			isrc: "E1",
			duration: 429,
		});
		const plain = dz({ isrc: "P1" });
		const { r } = await resolve([live, remix, remaster, edit, plain]);
		expect(r.status === "ready" && r.url).toBe(plain.preview);
		// Only versions there: none of them is the Verlauf's song.
		expect((await resolve([live, remix, remaster, edit])).r).toMatchObject({
			status: "unavailable",
			reason: "no_match",
		});
	});

	it("a live song in the Verlauf takes only the live recording", async () => {
		const live = dz({ title: "Around the World (Live)", title_version: "(Live)", isrc: "L1" });
		const plain = dz({ isrc: "P1" });
		const { r } = await resolve([plain, live], { ...SUBJECT, name: "Around the World - Live" });
		expect(r.status === "ready" && r.url).toBe(live.preview);
	});

	it("reads version marks only from the version part, and ignores guest artists", () => {
		expect(split("Live Forever").tags.size).toBe(0);
		expect([...split("Live Forever - Remastered 2014").tags]).toEqual(["remaster"]);
		expect([...split("Song (feat. Live Crew) (Live)").tags]).toEqual(["live"]);
		expect(split("Song (feat. Live Crew)").tags.size).toBe(0);
		expect(split("Song", "Song", "(Mellow Mix)").tags.has("remix")).toBe(true);
	});

	it("asks with the title as written, accents and all, without its version part", async () => {
		const d = deezer(ok({ data: [] }));
		await resolveDeezerPreview(
			{
				name: "Rücklicht (Letzte Ausfahrt) - Remastered 2011",
				artists: ["Brausepulver"],
				album: "",
				durationMs: 1,
			},
			{ fetch: d.fetch, base: BASE },
		);
		expect(new URL(d.urls[0]!).searchParams.get("q")).toBe("Brausepulver Rücklicht");
	});

	it("wrong artist or wrong length: no sample (P3: missing is not an unclear match)", async () => {
		expect((await resolve([dz({ artist: { name: "Daft Punk Tribute Band" } })])).r).toMatchObject({
			status: "unavailable",
			reason: "missing",
		});
		expect((await resolve([dz({ duration: 241 })])).r).toMatchObject({ reason: "no_match" });
		// Within the rounding slack it is the same recording.
		expect((await resolve([dz({ duration: 431 })])).r.status).toBe("ready");
	});

	it("an unknown length needs the same album", async () => {
		const subject = { ...SUBJECT, durationMs: 0 };
		expect((await resolve([dz({ album: { title: "Best Of" } })], subject)).r.status).toBe(
			"unavailable",
		);
		expect((await resolve([dz()], subject)).r.status).toBe("ready");
	});

	it("several different recordings that fit equally: ambiguous unless the album decides", async () => {
		const a = dz({ isrc: "A1", album: { title: "Compilation One" } });
		const b = dz({ isrc: "B1", album: { title: "Compilation Two" } });
		expect((await resolve([a, b])).r).toMatchObject({ status: "unavailable", reason: "ambiguous" });
		const home = dz({ isrc: "H1", album: { title: "Homework (Deluxe)" } });
		const { r } = await resolve([a, home, b]);
		expect(r.status === "ready" && r.url).toBe(home.preview);
	});

	it("the same recording on several albums (one ISRC) is one recording", async () => {
		const a = dz({ isrc: "SAME", album: { title: "Best Of" } });
		const b = dz({ isrc: "SAME", album: { title: "Other" } });
		expect((await resolve([a, b])).r.status).toBe("ready");
	});

	it("takes the sample address only as sent and only from the verified host", async () => {
		for (const preview of [
			"",
			null,
			"http://cdnt-preview.dzcdn.net/x.mp3",
			"https://evil.example/x.mp3",
			"https://cdnt-preview.dzcdn.net.evil.example/x.mp3",
			"https://user@cdnt-preview.dzcdn.net/x.mp3",
			"javascript:alert(1)",
		])
			expect((await resolve([dz({ preview })])).r).toMatchObject({
				status: "unavailable",
				reason: "no_preview",
			});
		expect((await resolve([dz({ readable: false })])).r).toMatchObject({ reason: "no_preview" });
		// A linkback elsewhere is dropped, the sample stays.
		const { r } = await resolve([dz({ link: "https://evil.example/track/1" })]);
		expect(r.status === "ready" && r.link).toBeNull();
	});

	it("says every failure, once, without retrying", async () => {
		const cases: [() => Response | Promise<Response>, string, string][] = [
			[() => new Response("", { status: 401 }), "error", "denied"],
			[() => new Response("", { status: 403 }), "error", "denied"],
			[() => new Response("", { status: 404 }), "error", "upstream"],
			[() => new Response("", { status: 429 }), "error", "rate"],
			[() => new Response("", { status: 500 }), "error", "upstream"],
			[() => new Response("not json"), "error", "upstream"],
			[
				ok({ error: { type: "Exception", message: "Quota limit exceeded", code: 4 } }),
				"error",
				"rate",
			],
			[ok({ error: { type: "OAuthException", code: 300 } }), "error", "denied"],
			[
				ok({ error: { type: "DataException", message: "no data", code: 800 } }),
				"unavailable",
				"missing",
			],
			[ok({ data: [] }), "unavailable", "missing"],
			[
				() => {
					throw new TypeError("network down");
				},
				"error",
				"upstream",
			],
		];
		for (const [answer, status, reason] of cases) {
			const d = deezer(answer);
			const r = await resolveDeezerPreview(SUBJECT, { fetch: d.fetch, base: BASE });
			expect({ status: r.status, reason: "reason" in r ? r.reason : null }).toEqual({
				status,
				reason,
			});
			expect(d.urls).toHaveLength(1);
		}
	});

	it("gives up at the deadline, even when the request ignores its signal", async () => {
		const d = deezer(() => new Promise<Response>(() => {}));
		const r = await resolveDeezerPreview(SUBJECT, { fetch: d.fetch, base: BASE, timeoutMs: 20 });
		expect(r).toMatchObject({ status: "error", reason: "timeout" });
		expect(d.urls).toHaveLength(1);
	});

	it("asks only Deezer, never Spotify", async () => {
		const { urls } = await resolve([dz()]);
		expect(urls.every((u) => u.startsWith(`${BASE}/`))).toBe(true);
	});
});

/**
 * Review 2026-10-18 (P2-02): two named versions of one kind (two remixes, two
 * remaster years, two live recordings) are different recordings. A lone hit of
 * the wrong one is no sample; among several, only the named one is.
 */
describe("history preview: the named version, not just its kind (P2-02)", () => {
	const versions: [string, string, string][] = [
		["Alice Remix", "Song (Alice Remix)", "Song (Bob Remix)"],
		["remaster year", "Song - Remastered 2011", "Song (Remastered 2014)"],
		["named live", "Song - Live at Wembley", "Song (Live in Tokyo)"],
	];
	const subject = (name: string): PreviewSubject => ({
		name,
		artists: ["Artist"],
		album: "Album",
		durationMs: 180_000,
	});
	const hit = (title: string, isrc: string) => {
		const m = /^(.*?)\s*(?:\((.*)\)|- (.*))$/.exec(title)!;
		return dz({
			title,
			title_short: m[1],
			title_version: `(${m[2] ?? m[3]})`,
			isrc,
			duration: 180,
			artist: { name: "Artist" },
			album: { title: "Album" },
		});
	};
	for (const [what, wanted, other] of versions) {
		it(`${what}: the wrong one alone is no sample`, async () => {
			expect((await resolve([hit(other, "WRONG")], subject(wanted))).r).toMatchObject({
				status: "unavailable",
			});
		});
		it(`${what}: among several, the named one`, async () => {
			const right = hit(
				wanted.replace(" - ", " (").replace(/$/, wanted.includes(" - ") ? ")" : ""),
				"RIGHT",
			);
			const { r } = await resolve([hit(other, "WRONG"), right], subject(wanted));
			expect(r.status === "ready" && r.url).toBe(right.preview);
		});
	}

	it("the same version written differently is still the same recording", async () => {
		const cases: [string, Record<string, unknown>][] = [
			[
				"Song - Remastered 2011",
				{ title: "Song (Remastered 2011)", title_version: "(Remastered 2011)" },
			],
			[
				"Song - 2011 Remaster",
				{ title: "Song (Remastered 2011)", title_version: "(Remastered 2011)" },
			],
			["Song - Radio Edit", { title: "Song (Radio Edit)", title_version: "(Radio Edit)" }],
			["Song (feat. Guest) - Live", { title: "Song (Live)", title_version: "(Live)" }],
			[
				"(I Can't Get No) Satisfaction",
				{ title: "(I Can't Get No) Satisfaction", title_short: "(I Can't Get No) Satisfaction" },
			],
		];
		for (const [name, over] of cases) {
			const { r } = await resolve(
				[
					dz({
						title_short: "Song",
						duration: 180,
						artist: { name: "Artist" },
						album: { title: "Album" },
						...over,
					}),
				],
				subject(name),
			);
			expect({ name, status: r.status }).toEqual({ name, status: "ready" });
		}
	});
});

/**
 * Review 2026-10-18 (P2-04): the deadline covers the whole answer — headers
 * and body — and gives up cleanly, with the one request aborted.
 */
describe("history preview: the deadline covers the body (P2-04)", () => {
	const hung = (r: Promise<unknown>, ms = 1_000) =>
		Promise.race([r, new Promise((res) => setTimeout(() => res("still waiting"), ms))]);
	/** Headers at once, then the body as `chunks` say, aborted with the request's signal. */
	function streaming(chunks: { at: number; text: string }[], end: number | null) {
		const seen: Request[] = [];
		return {
			seen,
			fetch: async (req: Request) => {
				seen.push(req);
				const enc = new TextEncoder();
				const body = new ReadableStream<Uint8Array>({
					start(ctl) {
						const timers = chunks.map((c) =>
							setTimeout(() => ctl.enqueue(enc.encode(c.text)), c.at),
						);
						if (end !== null) timers.push(setTimeout(() => ctl.close(), end));
						req.signal.addEventListener("abort", () => {
							for (const t of timers) clearTimeout(t);
							ctl.error(new DOMException("aborted", "AbortError"));
						});
					},
				});
				return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
			},
		};
	}
	const json = JSON.stringify({ data: [dz()] });

	it("headers at once, a body that never ends: timeout, the request aborted, nothing more", async () => {
		const s = streaming([{ at: 0, text: json.slice(0, 10) }], null);
		const r = await hung(
			resolveDeezerPreview(SUBJECT, { fetch: s.fetch, base: BASE, timeoutMs: 50 }),
		);
		expect(r).toMatchObject({ status: "error", reason: "timeout" });
		expect(s.seen).toHaveLength(1);
		expect(s.seen[0]!.signal.aborted).toBe(true);
	});

	it("a body slower than the deadline: timeout", async () => {
		const s = streaming(
			[
				{ at: 0, text: json.slice(0, 10) },
				{ at: 300, text: json.slice(10) },
			],
			310,
		);
		const r = await hung(
			resolveDeezerPreview(SUBJECT, { fetch: s.fetch, base: BASE, timeoutMs: 50 }),
		);
		expect(r).toMatchObject({ status: "error", reason: "timeout" });
		expect(s.seen).toHaveLength(1);
	});

	it("a body complete just before the deadline: the sample", async () => {
		const s = streaming(
			[
				{ at: 0, text: json.slice(0, 10) },
				{ at: 20, text: json.slice(10) },
			],
			25,
		);
		const r = await hung(
			resolveDeezerPreview(SUBJECT, { fetch: s.fetch, base: BASE, timeoutMs: 200 }),
		);
		expect(r).toMatchObject({ status: "ready" });
		expect(s.seen[0]!.signal.aborted).toBe(false);
	});

	it("a broken body inside the deadline: upstream, once", async () => {
		const s = streaming([{ at: 0, text: "{not json" }], 5);
		const r = await hung(
			resolveDeezerPreview(SUBJECT, { fetch: s.fetch, base: BASE, timeoutMs: 200 }),
		);
		expect(r).toMatchObject({ status: "error", reason: "upstream" });
		expect(s.seen).toHaveLength(1);
	});
});
