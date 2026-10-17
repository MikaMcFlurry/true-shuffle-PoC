/**
 * Writes on their way from this page (TS-RELEASE-NOTICE-COR1-261017): each
 * one counted on its own; the page is quiet again only once the task the
 * last one ended in is over — what its answer starts meanwhile (a waiting
 * second write) keeps it busy throughout. A listener's failure is its own.
 */
import { expect, it } from "vitest";
import { PendingMutations } from "../../src/client/pending-mutations";

/** The next task: everything the current one queued (answers, their `.then`s) has run. */
const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

function watched() {
	const p = new PendingMutations();
	const heard: boolean[] = [];
	p.subscribe(() => heard.push(p.busy()));
	return { p, heard };
}

it("starts quiet; a write makes it busy at once and tells its listeners", () => {
	const { p, heard } = watched();
	expect(p.busy()).toBe(false);
	expect(p.count).toBe(0);
	p.begin();
	expect(p.busy()).toBe(true);
	expect(p.count).toBe(1);
	expect(heard).toEqual([true]);
});

it("the end of the last write is not yet quiet: only from the next task on", async () => {
	const { p, heard } = watched();
	const end = p.begin();
	end();
	expect(p.count).toBe(0);
	expect(p.busy(), "in the same task").toBe(true);
	await Promise.resolve();
	await Promise.resolve();
	expect(p.busy(), "after the answer's microtasks").toBe(true);
	expect(heard).toEqual([true]);
	await nextTask();
	expect(p.busy()).toBe(false);
	expect(heard).toEqual([true, false]);
});

it("overlapping writes count each on their own: the first one's end frees nothing", async () => {
	const { p, heard } = watched();
	const a = p.begin();
	const b = p.begin();
	expect(p.count).toBe(2);
	a();
	expect(p.count).toBe(1);
	await nextTask();
	expect(p.busy()).toBe(true);
	expect(heard).toEqual([true]);
	b();
	await nextTask();
	expect(p.busy()).toBe(false);
	expect(heard).toEqual([true, false]);
});

it("a write started from the answer of the last one: busy throughout, no quiet moment told or read", async () => {
	const { p, heard } = watched();
	const reads: boolean[] = [];
	const first = p.begin();
	let second: () => void = () => {};
	// What a `.then` of the answer does: start the waiting write, read the state meanwhile.
	const answered = Promise.resolve().then(() => {
		first();
		reads.push(p.busy());
		return Promise.resolve().then(() => {
			reads.push(p.busy());
			// A newcomer subscribing in the gap reads it busy too.
			const leave = p.subscribe(() => {});
			reads.push(p.busy());
			leave();
			second = p.begin();
		});
	});
	await answered;
	expect(reads).toEqual([true, true, true]);
	await nextTask();
	expect(p.busy(), "the quiet moment queued by the first end no longer counts").toBe(true);
	expect(p.count).toBe(1);
	expect(heard).toEqual([true]);
	second();
	await nextTask();
	expect(p.busy()).toBe(false);
	expect(heard).toEqual([true, false]);
});

it("an end called twice counts once", async () => {
	const p = new PendingMutations();
	const a = p.begin();
	const b = p.begin();
	a();
	a();
	expect(p.count).toBe(1);
	b();
	b();
	expect(p.count).toBe(0);
	await nextTask();
	expect(p.busy()).toBe(false);
	expect(p.count).toBe(0);
});

it("a failing listener changes nothing: the others hear it, the count stays right", async () => {
	const p = new PendingMutations();
	const heard: string[] = [];
	p.subscribe(() => {
		throw new Error("listener broke");
	});
	p.subscribe(() => heard.push(p.busy() ? "busy" : "quiet"));
	let end: () => void = () => {};
	expect(() => {
		end = p.begin();
	}).not.toThrow();
	expect(p.count).toBe(1);
	expect(() => end()).not.toThrow();
	await nextTask();
	expect(p.count).toBe(0);
	expect(p.busy()).toBe(false);
	expect(heard).toEqual(["busy", "quiet"]);
});

it("a listener that left hears nothing more", async () => {
	const p = new PendingMutations();
	const heard: boolean[] = [];
	const leave = p.subscribe(() => heard.push(p.busy()));
	const end = p.begin();
	leave();
	end();
	await nextTask();
	p.begin();
	expect(heard).toEqual([true]);
});
