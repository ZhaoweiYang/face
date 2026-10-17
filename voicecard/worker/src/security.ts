// Card tokens, session tokens and password hashing (Web Crypto; mirrors voicecard/security.py).
//
// Card URLs are bearer secrets: the only way to reach a card is to already hold its
// 128-bit random token (written on the NFC tag), so there is nothing to enumerate.
// D1 stores only SHA-256 hashes of card and session tokens.

export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
export const USERNAME_RE = /^[\p{L}\p{N}_.-]{2,32}$/u;
export const MIN_PASSWORD = 8;

const enc = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 16 random bytes -> 22 url-safe base64 characters (128 bits). */
export function newToken(bytes = 16): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashToken(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(token)));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number, bits: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const out = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, bits);
  return new Uint8Array(out);
}

export async function hashPassword(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await pbkdf2(password, salt, iterations, 256);
  return `pbkdf2-sha256$${iterations}$${hex(salt)}$${hex(digest)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, iter, salt, digest] = stored.split("$");
  if (algo !== "pbkdf2-sha256" || !iter || !salt || !digest) return false;
  const got = await pbkdf2(password, fromHex(salt), Number(iter), (digest.length / 2) * 8);
  return timingSafeEqual(got, fromHex(digest));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Hash of a random password, verified against when the username does not exist so a
 * failed login takes the same time either way. */
export function dummyPasswordHash(iterations: number): string {
  return `pbkdf2-sha256$${iterations}$${"00".repeat(16)}$${"00".repeat(32)}`;
}

/** (mime, extension) from the file's magic bytes; the client's content type is not trusted. */
export function sniffAudio(head: Uint8Array): [string, string] | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return ["audio/webm", "webm"];
  if (ascii(0, 4) === "OggS") return ["audio/ogg", "ogg"];
  if (ascii(4, 8) === "ftyp") return ["audio/mp4", "m4a"];
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return ["audio/wav", "wav"];
  if (ascii(0, 3) === "ID3") return ["audio/mpeg", "mp3"];
  if (head.length > 1 && head[0] === 0xff) {
    if ((head[1] & 0xf6) === 0xf0) return ["audio/aac", "aac"];
    if ((head[1] & 0xe0) === 0xe0) return ["audio/mpeg", "mp3"];
  }
  return null;
}
