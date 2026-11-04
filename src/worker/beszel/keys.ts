import { getSetting, setSetting } from "../db";

/**
 * The hub's Ed25519 identity. The agent's KEY env var holds the public key in
 * OpenSSH authorized_keys format; the agent verifies our signature of its token.
 */

function u32be(n: number): Uint8Array {
	return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

export function toBase64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

/** "ssh-ed25519 " + base64(string("ssh-ed25519") + string(pubkey)) — SSH wire format. */
export function sshPublicKey(raw: Uint8Array): string {
	const type = new TextEncoder().encode("ssh-ed25519");
	const blob = concat(u32be(type.length), type, u32be(raw.length), raw);
	return `ssh-ed25519 ${toBase64(blob)}`;
}

let cachedKey: CryptoKey | null = null;

export async function getHubKey(db: D1Database): Promise<{ privateKey: CryptoKey; publicSsh: string }> {
	const jwk = await getSetting(db, "hub_private_jwk");
	const pub = await getSetting(db, "hub_public_ssh");
	if (jwk && pub) {
		if (!cachedKey) {
			cachedKey = await crypto.subtle.importKey("jwk", JSON.parse(jwk), { name: "Ed25519" }, false, ["sign"]);
		}
		return { privateKey: cachedKey, publicSsh: pub };
	}
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
	const publicSsh = sshPublicKey(raw);
	// INSERT OR IGNORE so two isolates racing on first boot converge on one key.
	await db.batch([
		db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('hub_private_jwk', ?)").bind(JSON.stringify(priv)),
		db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('hub_public_ssh', ?)").bind(publicSsh),
	]);
	return getHubKey(db);
}

/** Raw 64-byte Ed25519 signature of the token — what Go's ssh.Signer puts in Signature.Blob. */
export async function signToken(key: CryptoKey, token: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(token)));
}

export { setSetting };
