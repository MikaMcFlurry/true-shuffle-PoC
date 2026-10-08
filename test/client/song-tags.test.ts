import { describe, expect, it } from "vitest";
import { songTags } from "../../src/client/components/song-tags-text";

const facts = (
	plays: number,
	inStation: boolean,
	kind: "fresh" | "discovery" | "favorite" = "fresh",
) => ({
	plays,
	lastPlayedAt: plays ? Date.now() - 90 * 86_400_000 : null,
	inStation,
	kind,
});
const texts = (...a: Parameters<typeof songTags>) => songTags(...a).map((t) => t.text);

describe("song tags: where it comes from, then what was recorded", () => {
	it("the source comes first and answers one question only", () => {
		expect(texts("fresh", facts(0, false))[0]).toBe("Aus der Kassette");
		expect(texts("discovery", facts(0, false, "discovery"))[0]).toBe("Empfehlung");
		expect(texts("favorite", facts(9, true, "favorite"))[0]).toBe("Favorit");
	});

	it("the pool lane never claims a playlist: liked songs and kept recommendations share it", () => {
		for (const short of [false, true])
			for (const known of [false, true])
				for (const n of [0, 1, 7])
					expect(texts("fresh", facts(n, n > 0), 0, known, short).join(" ")).not.toMatch(
						/Playlist/,
					);
	});

	it("no stored play is never proof of never hearing a song", () => {
		// Every combination of import present or not, long or short form.
		for (const known of [false, true])
			for (const short of [false, true]) {
				const note = texts("fresh", facts(0, false), 0, known, short).slice(1).join(" ");
				expect(note).not.toMatch(/nie gehört|noch nicht gehört|neu für|nie /i);
				// Bounded to what it rests on: the imported Verlauf, or true-shuffle's own count.
				expect(note).toMatch(known ? /Verlauf/ : /gezählt/);
			}
	});

	it("without an import the long form says why nothing is known", () => {
		expect(texts("fresh", facts(0, false), 0, false)).toEqual([
			"Aus der Kassette",
			"noch nicht gezählt, kein Verlauf importiert",
		]);
	});

	it("with a partial import a song it omits reads as not in the Verlauf, not as never heard", () => {
		expect(texts("discovery", facts(0, false, "discovery"), 0, true, true)).toEqual([
			"Empfehlung",
			"nicht im Verlauf",
		]);
	});

	it("not on this station is bounded to the 180 days the plays log keeps", () => {
		expect(texts("fresh", facts(3, false))[1]).toBe(
			"in den letzten 180 Tagen nicht auf dieser Kassette",
		);
	});

	it("a pruned play that the warm cache still holds makes no 'not here' claim", () => {
		expect(texts("fresh", facts(1, true))).toEqual([
			"Aus der Kassette",
			expect.stringMatching(/^einmal gehört/),
		]);
	});

	it("a recommendation already heard elsewhere says so instead of 'new'", () => {
		expect(texts("discovery", facts(1, false, "discovery"), 0, true, true)).toEqual([
			"Empfehlung",
			"lange nicht hier",
			"1× gehört",
		]);
	});

	it("a thumbs-up adds Favorit to a playlist song", () => {
		expect(texts("fresh", facts(5, true), 1, true, true)).toEqual([
			"Aus der Kassette",
			"Favorit",
			"5× gehört",
		]);
	});
});

describe("tags in the Verlauf", () => {
	it("never says not yet heard or not here for a song just heard", () => {
		const f = { plays: 0, lastPlayedAt: null, inStation: false, kind: "fresh" as const };
		expect(songTags("fresh", f, 0, true, true, true).map((t) => t.text)).toEqual([
			"Aus der Kassette",
		]);
		const g = { plays: 4, lastPlayedAt: 1, inStation: false, kind: "discovery" as const };
		expect(songTags(null, g, 0, true, true, true).map((t) => t.text)).toEqual([
			"Empfehlung",
			"4× gehört",
		]);
	});
});
