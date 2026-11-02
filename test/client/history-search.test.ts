import { describe, expect, it } from "vitest";
import { HistorySearch, search } from "../../src/client/history-search";
import type { HistoryEntry, HistorySearchAnswer } from "../../src/shared/api";
import { matches, normalize, queryWords } from "../../src/shared/search";

const entry = (id: string, name: string, artists: string, playedAt: number): HistoryEntry => ({
	id,
	name,
	artists,
	album: "A",
	imageUrl: null,
	durationMs: 180_000,
	thumb: 0,
	playedAt,
	stationName: null,
	ignored: false,
});

describe("S1 normalization", () => {
	it("ignores case and accents", () => {
		expect(normalize("Beyoncé")).toBe("beyonce");
		expect(normalize("  MÖTLEY   Crüe ")).toBe("motley crue");
		expect(normalize("Straße")).toBe("strasse");
		expect(matches(normalize("Halo Beyoncé"), queryWords("beyonce"))).toBe(true);
	});
	it("finds parts of words, every word of the query", () => {
		const t = normalize("Golden Hour – Live JVKE");
		expect(matches(t, queryWords("gold"))).toBe(true);
		expect(matches(t, queryWords("hour jvk"))).toBe(true);
		expect(matches(t, queryWords("hour beyonce"))).toBe(false);
		expect(matches(t, queryWords("   "))).toBe(false);
	});
});

describe("S1 search over the Verlauf", () => {
	const answer: HistorySearchAnswer = {
		through: 300,
		complete: true,
		songs: [
			{ entry: entry("a", "Halo", "Beyoncé", 300), plays: [300, 100] },
			{ entry: entry("b", "Crazy in Love", "Beyoncé, Jay-Z", 200), plays: [200] },
			{ entry: entry("c", "Hello", "Adele", 150), plays: [150] },
		],
	};

	it("groups by song, newest first, with every play", async () => {
		const hs = new HistorySearch(async () => answer);
		const index = await hs.load("me");
		const hits = search(index, "beyonce");
		expect(hits.map((h) => h.entry.id)).toEqual(["a", "b"]);
		expect(hits[0]!.plays).toEqual([300, 100]);
		expect(search(index, "nichts davon")).toEqual([]);
	});

	it("20 searches send one request; opening again asks only for what came after", async () => {
		const asked: number[] = [];
		const hs = new HistorySearch(async (since) => {
			asked.push(since);
			return since === 0
				? answer
				: {
						through: 400,
						complete: true,
						songs: [{ entry: entry("a", "Halo", "Beyoncé", 400), plays: [400] }],
					};
		});
		for (let i = 0; i < 20; i++) search(await hs.load("me"), `be${"yonce".slice(0, i % 5)}`);
		expect(hs.requests).toBe(1);
		const again = await hs.load("me", true);
		expect(asked).toEqual([0, 300]);
		expect(again.songs.get("a")!.plays).toEqual([400, 300, 100]);
	});

	it("another account never sees the index of the one before", async () => {
		const hs = new HistorySearch(async () => answer);
		await hs.load("me");
		const other = await hs.load("you");
		expect(other.account).toBe("you");
		expect(hs.requests).toBe(2);
	});
});
