/**
 * PR31-STORAGE-CLASSIFICATION through the actual UserHub method: a storage
 * error thrown inside a listener's operation becomes the answer the app shows.
 * Only the daily limit promises when it ends; a full database promises nothing.
 * The method is taken from src/worker/userhub.ts as in preview-userhub.test.ts.
 */

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";
import { expect, it } from "vitest";
import { NativeError } from "../../src/worker/controllers/native";
import { HubError } from "../../src/worker/hub/hub";
import {
	isStorageFull,
	isStorageLimit,
	STORAGE_FULL_CODE,
	STORAGE_LIMIT_CODE,
	storageFullMessage,
	storageLimitMessage,
} from "../../src/worker/lib/storage-limit";
import { SpotifyError } from "../../src/worker/spotify/client";

const compiled = transpileModule(readFileSync("src/worker/userhub.ts", "utf8"), {
	compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;
function method(name: string) {
	const start = compiled.search(new RegExp(`\\n {4}(async )?${name}\\(`));
	if (start < 0) throw new Error(`UserHub ${name} not found`);
	const end = compiled.slice(start + 1).search(/\n {4}\}/);
	return compiled.slice(start + 1, start + 1 + end + 6);
}

type Answer = { ok: boolean; error?: { code: string; message: string; status: number } };

function hub() {
	const errors: unknown[] = [];
	const h = runInNewContext(`({ chain: Promise.resolve(), ${method("exclusive")} })`, {
		HubError,
		NativeError,
		SpotifyError,
		isStorageLimit,
		isStorageFull,
		STORAGE_LIMIT_CODE,
		STORAGE_FULL_CODE,
		storageLimitMessage,
		storageFullMessage,
		console: { error: (...a: unknown[]) => errors.push(a) },
	}) as { exclusive: (fn: () => unknown) => Promise<Answer> };
	return h;
}

it("SQLITE_FULL inside an operation: storage_full, 503, no promised time", async () => {
	const r = await hub().exclusive(() => {
		throw new Error("SQLITE_FULL: database or disk is full");
	});
	expect(r.ok).toBe(false);
	expect(r.error).toMatchObject({ code: "storage_full", status: 503 });
	expect(r.error!.message).not.toMatch(/Uhr|Tageslimit/);
});

it("the named daily limit still says when it ends", async () => {
	const r = await hub().exclusive(() => {
		throw new Error("Exceeded allowed rows read in Durable Objects free tier.");
	});
	expect(r.error).toMatchObject({ code: "storage_limit", status: 503 });
	expect(r.error!.message).toMatch(/Ab \d\d:\d\d Uhr/);
});

it("an ordinary failure stays an internal error", async () => {
	const r = await hub().exclusive(() => {
		throw new Error("boom");
	});
	expect(r.error).toMatchObject({ code: "internal", status: 500 });
});
