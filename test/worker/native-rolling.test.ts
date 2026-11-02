import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("actual bridge functions keep 10000 rolling native occurrences and same-epoch journal bounded", async () => {
	const source = readFileSync("scripts/native/ha-bridge.mjs", "utf8");
	const functions = source.slice(
		source.indexOf("async function observe(d)"),
		source.indexOf("let tail = Promise.resolve()"),
	);
	// Exercise the actual production functions without opening a listener; HA responses
	// and durable-write latency are controlled, while all occurrence/journal logic is real.
	const bridge = runInNewContext(`(() => {
 const devices=[{id:'media_player.ma',name:'MA',mediaTemplate:'spotify://track/{id}',service:'music_assistant.play_media',pause:true}];
 const state={sequence:0,devices:{},commands:{}};
 let current='spotify://track/a';let serviceCalls=0;
 async function save() {}
 async function ha(path,body) {if(body) {serviceCalls++;return [];}return {state:'playing',attributes:{media_content_id:current,media_position:97}};}
 ${functions}
 return {command,observe,state,device:devices[0],setMedia:id=>{current='spotify://track/'+id;},serviceCalls:()=>serviceCalls};
 })()`) as {
		command: (c: Record<string, unknown>) => Promise<[number, unknown]>;
		observe: (d: unknown) => Promise<{ entryId: string; progressMs: number; state: string }>;
		state: { devices: Record<string, { queue: unknown[] }>; commands: Record<string, unknown> };
		device: { id: string };
		setMedia: (id: string) => void;
		serviceCalls: () => number;
	};
	const base = {
		deviceId: bridge.device.id,
		sessionId: "s",
		entryId: "s:0",
		playbackEpoch: 1,
		orderRevision: 1,
	};
	expect(
		(
			await bridge.command({
				...base,
				operationId: "play",
				action: "play",
				mediaId: "a",
				queue: [{ entryId: "s:0", mediaId: "a" }],
			})
		)[0],
	).toBe(200);
	for (let n = 1; n <= 10000; n++) {
		// Repeating native media identities in later rounds must remain distinct occurrences.
		const mediaId = n % 2 ? "b" : "a";
		const command = {
			...base,
			entryId: `s:${n - 1}`,
			orderRevision: n + 1,
			operationId: `append${n}`,
			action: "append",
			queue: [{ entryId: `s:${n}`, mediaId }],
		};
		expect((await bridge.command(command))[0]).toBe(200);
		bridge.setMedia(mediaId);
		expect(await bridge.observe(bridge.device)).toMatchObject({
			entryId: `s:${n}`,
			progressMs: 97000,
			state: "playing",
		});
		expect(bridge.state.devices[bridge.device.id]!.queue.length).toBe(1);
		expect(Object.keys(bridge.state.commands).length).toBeLessThanOrEqual(2);
	}
	const calls = bridge.serviceCalls();
	expect(
		(
			await bridge.command({
				...base,
				operationId: "append1",
				orderRevision: 2,
				action: "append",
				queue: [{ entryId: "s:1", mediaId: "b" }],
			})
		)[0],
	).toBe(409);
	expect(bridge.serviceCalls()).toBe(calls);
});
