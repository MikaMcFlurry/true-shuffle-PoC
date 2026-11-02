import { describe, expect, it } from "vitest";
import { parseGenres } from "../../src/worker/hub/genres";

describe("genre reply", () => {
	it("keeps named genres with positive shares, scaled to 100 and sorted", () => {
		expect(
			parseGenres(
				'Sure! {"genres":[{"name":"Pop","share":10},{"name":" Indie ","share":30},{"name":"x","share":-1},{"share":5}],"summary":" Kurz. "}',
			),
		).toEqual({
			genres: [
				{ name: "Indie", share: 75 },
				{ name: "Pop", share: 25 },
			],
			summary: "Kurz.",
		});
	});

	it("is null for nothing usable", () => {
		expect(parseGenres("no json")).toBeNull();
		expect(parseGenres('{"genres":[]}')).toBeNull();
		expect(parseGenres('{"genres":"Pop"}')).toBeNull();
	});
});
