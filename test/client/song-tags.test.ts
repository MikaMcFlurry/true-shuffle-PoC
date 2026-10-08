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
		expect(texts("fresh", facts(0, false))[0]).toBe("Aus deiner Playlist");
		expect(texts("discovery", facts(0, false, "discovery"))[0]).toBe("Empfehlung");
		expect(texts("favorite", facts(9, true, "favorite"))[0]).toBe("Favorit");
	});

	it("an unheard song is 'not yet heard', never a claim about all time", () => {
		expect(texts("fresh", facts(0, false))).toEqual(["Aus deiner Playlist", "noch nicht gehört"]);
		expect(texts("fresh", facts(0, false)).join(" ")).not.toMatch(/nie|neu/i);
	});

	it("not on this station is bounded to the 180 days the plays log keeps", () => {
		expect(texts("fresh", facts(3, false))[1]).toBe(
			"in den letzten 180 Tagen nicht auf dieser Kassette",
		);
	});

	it("a pruned play that the warm cache still holds makes no 'not here' claim", () => {
		expect(texts("fresh", facts(1, true))).toEqual([
			"Aus deiner Playlist",
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
			"Aus deiner Playlist",
			"Favorit",
			"5× gehört",
		]);
	});
});
