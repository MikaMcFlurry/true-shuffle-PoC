import { describe, expect, it } from "vitest";
import { labelLayout } from "../../src/client/components/cassette-label";

const NAMES = [
	"Alles",
	"Ö",
	"Indie & Gitarren",
	"Wohnzimmer Wochenende Mitternachtsmix",
	"WWWWWWWWWWWWWWWWWWWW",
	"Musik für die lange Autofahrt nach Hamburg und zurück",
	"   ",
];

describe("cassette label", () => {
	it("never leaves the label: at most two lines, each pinned inside its width", () => {
		for (const name of NAMES) {
			const l = labelLayout(name);
			expect(l.lines.length).toBeGreaterThan(0);
			expect(l.lines.length).toBeLessThanOrEqual(2);
			expect(l.baselines.length).toBe(l.lines.length);
			for (const line of l.lines) expect(line.width).toBeLessThanOrEqual(244);
			// The label band ends where the stripes begin.
			for (const b of l.baselines) expect(b + l.size * 0.3).toBeLessThanOrEqual(70);
		}
	});

	it("short names are big, long ones break at a space instead of shrinking away", () => {
		expect(labelLayout("Alles")).toMatchObject({ size: 34, lines: [{ text: "Alles" }] });
		const long = labelLayout("Wohnzimmer Wochenende Mitternachtsmix");
		expect(long.lines.map((x) => x.text)).toEqual(["Wohnzimmer Wochenende", "Mitternachtsmix"]);
		expect(long.size).toBeGreaterThanOrEqual(16);
		expect(labelLayout("   ").lines[0]!.text).toBe("Kassette");
	});
});
