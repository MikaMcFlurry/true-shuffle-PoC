import { describe, expect, it } from "vitest";
import { songTags } from "../../src/client/components/song-tags-text";

const facts = (plays: number, inStation: boolean) => ({
	plays,
	lastPlayedAt: plays ? Date.now() - 90 * 86_400_000 : null,
	inStation,
	kind: "fresh" as const,
});
const texts = (...a: Parameters<typeof songTags>) => songTags(...a).map((t) => t.text);

describe("song tags claim only what was recorded", () => {
	it("an unheard song is 'never heard' only by the imported history, never as a fact", () => {
		expect(texts("fresh", facts(0, false), 0, true)).toEqual([
			"Laut deinem Verlauf noch nie gehört",
		]);
		expect(texts("fresh", facts(0, false), 0, false)).toEqual(["Bisher nicht gehört"]);
	});

	it("not on this station is bounded to the half year the plays log keeps", () => {
		const t = texts("fresh", facts(3, false));
		expect(t[0]).toBe("In den letzten 180 Tagen nicht auf dieser Kassette");
		expect(t.join(" ")).not.toMatch(/ersten Mal/);
	});

	it("a pruned play that the warm cache still holds makes no claim at all", () => {
		expect(texts("fresh", facts(1, true))).toEqual([expect.stringMatching(/^Einmal gehört/)]);
	});

	it("lists use the short forms", () => {
		expect(texts("fresh", facts(22, false), 0, true, true)).toEqual([
			"lange nicht hier",
			"22× gehört",
		]);
		expect(texts("fresh", facts(0, false), 0, true, true)).toEqual(["laut Verlauf neu"]);
	});
});
