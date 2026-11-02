import { describe, expect, it } from "vitest";
import { upcomingEntries } from "../../src/client/playback-view";

const e = (n: number, id = `t${n}`) => ({ entryId: `e${n}`, track: { id } });
const queue = [e(1), e(2), e(3), e(4)];
const track = (id: string) => ({ id }) as never;

describe("P10: Als Nächstes never repeats the song playing now", () => {
	it("after the own song: the ones behind it", () => {
		expect(
			upcomingEntries(queue, { entryId: "e2", track: track("t2"), checkpoint: null }).map(
				(x) => x.entryId,
			),
		).toEqual(["e3", "e4"]);
	});
	it("after a skip, the next song already shown while the saved place is the old one", () => {
		const view = {
			entryId: null,
			track: track("t3"),
			checkpoint: { entryId: "e2", track: track("t2"), position: 0 },
		};
		expect(upcomingEntries(queue, view).map((x) => x.entryId)).toEqual(["e4"]);
	});
	it("a command holding the new song with the old entry id", () => {
		expect(
			upcomingEntries(queue, { entryId: "e2", track: track("t3"), checkpoint: null }).map(
				(x) => x.entryId,
			),
		).toEqual(["e4"]);
	});
	it("a song played outside the order does not hide true-shuffle's next one", () => {
		const view = {
			entryId: null,
			track: track("other"),
			checkpoint: { entryId: "e2", track: track("t2"), position: 0 },
		};
		expect(upcomingEntries(queue, view).map((x) => x.entryId)).toEqual(["e3", "e4"]);
	});
	it("nothing known: the whole queue", () => {
		expect(upcomingEntries(queue, { entryId: null, track: null, checkpoint: null })).toHaveLength(
			4,
		);
	});
});
