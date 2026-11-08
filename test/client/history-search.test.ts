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
	describe("an answer on its way belongs to the account that asked (PR35 UI-01)", () => {
		const of = (who: string, through = 100): HistorySearchAnswer => ({
			through,
			complete: true,
			songs: [{ entry: entry(`${who}-song`, `Song of ${who}`, "X", through), plays: [through] }],
		});
		/** A fetcher whose answers are held until the test lets them go. */
		function held() {
			const open: { since: number; answer: (a: HistorySearchAnswer) => void }[] = [];
			const hs = new HistorySearch(
				(since) => new Promise((answer) => open.push({ since, answer })),
			);
			return { hs, open };
		}

		it("B never joins A's request, and A's late answer never becomes B's", async () => {
			const { hs, open } = held();
			const a = hs.load("A");
			const b = hs.load("B");
			expect(open).toHaveLength(2);
			open[0]!.answer(of("A"));
			open[1]!.answer(of("B"));
			expect((await a).account).toBe("A");
			const got = await b;
			expect(got.account).toBe("B");
			expect([...got.songs.keys()]).toEqual(["B-song"]);
			// And nothing of A is kept for B afterwards.
			expect([...(await hs.load("B")).songs.keys()]).toEqual(["B-song"]);
		});

		it("A's answer arriving after B's: B's index stays B's", async () => {
			const { hs, open } = held();
			const a = hs.load("A");
			const b = hs.load("B");
			open[1]!.answer(of("B"));
			await b;
			open[0]!.answer(of("A"));
			await a;
			const now = await hs.load("B");
			expect(now.account).toBe("B");
			expect(now.songs.has("A-song")).toBe(false);
			expect(hs.requests).toBe(2);
		});

		it("signing out (forget) while a request is on its way: its answer is not kept", async () => {
			const { hs, open } = held();
			const a = hs.load("A");
			hs.forget();
			open[0]!.answer(of("A"));
			await a;
			const again = hs.load("A");
			expect(open).toHaveLength(2);
			expect(open[1]!.since).toBe(0);
			open[1]!.answer(of("A", 200));
			expect((await again).through).toBe(200);
		});

		it("forget during an update: the index from before is not changed by the late answer", async () => {
			const { hs, open } = held();
			const first = hs.load("A");
			open[0]!.answer(of("A"));
			const index = await first;
			const update = hs.load("A", true);
			hs.forget();
			open[1]!.answer({
				...of("A", 300),
				songs: [{ entry: entry("late", "Late", "X", 300), plays: [300] }],
			});
			await update;
			expect(index.songs.has("late")).toBe(false);
		});

		it("the same account still shares one request (P1 unchanged)", async () => {
			const { hs, open } = held();
			const one = hs.load("A");
			const two = hs.load("A");
			expect(open).toHaveLength(1);
			open[0]!.answer(of("A"));
			expect(await one).toBe(await two);
		});

		it("a failed request for A leaves B free to ask", async () => {
			let n = 0;
			const hs = new HistorySearch((since) =>
				++n === 1
					? Promise.reject(new Error("offline"))
					: Promise.resolve({ ...of("B"), through: since + 1 }),
			);
			await expect(hs.load("A")).rejects.toThrow("offline");
			expect((await hs.load("B")).account).toBe("B");
		});
	});
});
