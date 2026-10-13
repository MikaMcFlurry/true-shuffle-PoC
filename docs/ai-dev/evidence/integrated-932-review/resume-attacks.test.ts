import { expect, it } from "vitest";
import { MINUTE_MS } from "/workspace/ts-review-93241/src/core/types";
import { onboarded } from "/workspace/ts-review-93241/test/hub/harness";

type H = Awaited<ReturnType<typeof onboarded>>;

/** Time passes with no look at the player at all. */
const quiet = (h: H, ms: number) => {
	h.clock.t += ms;
	h.fake.advance(ms, h.fake.user().id);
};

/** Into the run, then a look that sees a new song begin. */
async function seenBeginning(h: H) {
	const sid = h.stationIds[0]!;
	expect((await h.hub.play(sid)).ok).toBe(true);
	await h.listen(10 * MINUTE_MS);
	const x = h.fake.current()!;
	while (h.fake.current() === x) await h.listen(1_000);
	await h.hub.state({ live: true, refresh: true });
	const saved = h.hub.savedSession(sid)!;
	const t = h.fake.current()!;
	return { sid, t, index: saved.currentIndex, progress: saved.progressMs! };
}

/** The phone is gone: no player to see any more. */
function gone(h: H) {
	const p = h.fake.user().player;
	p.isPlaying = false;
	p.deviceId = "gone";
}



it("near-end unseen skip at 166s does not complete a 180s occurrence", async () => {
 const h = await onboarded({tracks:300,durationMs:180000});
 const {sid,t,index,progress}=await seenBeginning(h);
 quiet(h,166000-progress); h.fake.skip(); quiet(h,1000); gone(h);
 await h.hub.state({live:true,refresh:true}); await h.listen(5*MINUTE_MS);
 console.log("near-end",{index,after:h.hub.savedSession(sid),history:h.hub.history(20).filter(e=>e.id===t)});
 expect(h.hub.savedSession(sid)!.currentIndex).toBe(index);
 expect(h.hub.savedSession(sid)!.progressMs).toBe(progress);
});

it("unseen pause followed by 40s partial skip retains the unfinished occurrence", async () => {
 const h = await onboarded({tracks:300,durationMs:180000});
 const {sid,t,index,progress}=await seenBeginning(h);
 h.fake.pause(); quiet(h,10*MINUTE_MS);
 h.fake.user().player.isPlaying=true; quiet(h,40000-progress); h.fake.skip(); quiet(h,1000); gone(h);
 await h.hub.state({live:true,refresh:true}); await h.listen(5*MINUTE_MS);
 console.log("paused-partial",{index,after:h.hub.savedSession(sid),history:h.hub.history(20).filter(e=>e.id===t)});
 expect(h.hub.savedSession(sid)!.currentIndex).toBe(index);
 expect(h.hub.savedSession(sid)!.progressMs).toBe(progress);
});

it("saved checkpoint near end plus later restart/partial skip does not prove old completion", async () => {
 const h = await onboarded({tracks:300,durationMs:180000});
 const {sid,t,index}=await seenBeginning(h);
 quiet(h,120000); await h.hub.state({live:true,refresh:true});
 const before=h.hub.savedSession(sid)!;
 h.fake.user().player.progressMs=0; h.fake.user().player.listenedMs=0;
 quiet(h,65000); h.fake.skip(); quiet(h,1000); gone(h);
 await h.hub.state({live:true,refresh:true}); await h.listen(5*MINUTE_MS);
 console.log("seek-partial",{index,before,after:h.hub.savedSession(sid),history:h.hub.history(20).filter(e=>e.id===t)});
 expect(h.hub.savedSession(sid)!.currentIndex).toBe(before.currentIndex);
 expect(h.hub.savedSession(sid)!.progressMs).toBe(before.progressMs);
});
