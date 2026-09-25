/**
 * Small WebCrypto helpers: one APP_SECRET derives two independent keys —
 * an HMAC key for signed cookies and an AES-GCM key for the Spotify refresh
 * token at rest.
 */

const te = new TextEncoder();
const td = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): Uint8Array {
	const s = text.replace(/-/g, "+").replace(/_/g, "/");
	const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
	const bin = atob(s + pad);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function randomToken(bytes = 32): string {
	const b = new Uint8Array(bytes);
	crypto.getRandomValues(b);
	return b64urlEncode(b);
}

export async function sha256b64url(text: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", te.encode(text));
	return b64urlEncode(new Uint8Array(d));
}

async function hkdf(secret: string, info: string, usage: "hmac" | "aes"): Promise<CryptoKey> {
	if (!secret || secret.length < 32) {
		throw new Error("APP_SECRET fehlt oder ist kürzer als 32 Zeichen");
	}
	const base = await crypto.subtle.importKey("raw", te.encode(secret), "HKDF", false, [
		"deriveKey",
	]);
	const params = {
		name: "HKDF",
		hash: "SHA-256",
		salt: te.encode("true-shuffle/v1"),
		info: te.encode(info),
	};
	if (usage === "hmac") {
		return crypto.subtle.deriveKey(
			params,
			base,
			{ name: "HMAC", hash: "SHA-256", length: 256 },
			false,
			["sign", "verify"],
		);
	}
	return crypto.subtle.deriveKey(params, base, { name: "AES-GCM", length: 256 }, false, [
		"encrypt",
		"decrypt",
	]);
}

export class Keys {
	private hmac: Promise<CryptoKey> | null = null;
	private aes: Promise<CryptoKey> | null = null;
	constructor(private readonly secret: string) {}

	private hmacKey(): Promise<CryptoKey> {
		this.hmac ??= hkdf(this.secret, "cookie-signing", "hmac");
		return this.hmac;
	}
	private aesKey(): Promise<CryptoKey> {
		this.aes ??= hkdf(this.secret, "token-encryption", "aes");
		return this.aes;
	}

	async sign(payload: string): Promise<string> {
		const sig = await crypto.subtle.sign("HMAC", await this.hmacKey(), te.encode(payload));
		return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
	}

	/** Returns the payload when the signature is valid, else null. */
	async verify(signed: string): Promise<string | null> {
		const i = signed.lastIndexOf(".");
		if (i <= 0) return null;
		const payload = signed.slice(0, i);
		let sig: Uint8Array;
		try {
			sig = b64urlDecode(signed.slice(i + 1));
		} catch {
			return null;
		}
		const ok = await crypto.subtle.verify(
			"HMAC",
			await this.hmacKey(),
			sig as BufferSource,
			te.encode(payload),
		);
		return ok ? payload : null;
	}

	async encrypt(plain: string): Promise<string> {
		const iv = new Uint8Array(12);
		crypto.getRandomValues(iv);
		const ct = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			await this.aesKey(),
			te.encode(plain),
		);
		return `v1.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
	}

	async decrypt(box: string): Promise<string> {
		const [v, iv, ct] = box.split(".");
		if (v !== "v1" || !iv || !ct) throw new Error("unbekanntes Token-Format");
		const pt = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: b64urlDecode(iv) as BufferSource },
			await this.aesKey(),
			b64urlDecode(ct) as BufferSource,
		);
		return td.decode(pt);
	}
}
