/**
 * A personal remote key: "tsr_" + the signed pair of account and key id.
 * The Worker checks the signature, so a made-up key never reaches a Durable
 * Object; the hub then checks the key id is still the current one.
 */

import { b64urlDecode, b64urlEncode, Keys } from "./crypto";

const PREFIX = "tsr_";

export async function remoteKeyFor(secret: string, uid: string, kid: string): Promise<string> {
	const signed = await new Keys(secret, "remote-key").sign(`${uid}|${kid}`);
	return PREFIX + b64urlEncode(new TextEncoder().encode(signed));
}

export async function readRemoteKey(
	secret: string,
	key: string,
): Promise<{ uid: string; kid: string } | null> {
	if (!key.startsWith(PREFIX) || key.length > 600) return null;
	let signed: string;
	try {
		signed = new TextDecoder().decode(b64urlDecode(key.slice(PREFIX.length)));
	} catch {
		return null;
	}
	const payload = await new Keys(secret, "remote-key").verify(signed);
	const i = payload?.lastIndexOf("|") ?? -1;
	if (!payload || i <= 0 || i === payload.length - 1) return null;
	return { uid: payload.slice(0, i), kid: payload.slice(i + 1) };
}
