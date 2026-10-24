// Tokens, hashing and audio sniffing (Web Crypto only).
//
// Card URLs are bearer secrets: reaching a card requires its 128-bit random token
// (written on the NFC tag), so there is nothing to enumerate. D1 stores only hashes.

export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

const enc = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 16 random bytes -> 22 url-safe characters (128 bits). */
export function newToken(bytes = 16): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export const hashToken = sha256;

export function sixDigitCode(): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return String(n % 1_000_000).padStart(6, "0");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}

/** Payload of a JWT. Only for id_tokens received directly from the issuer's token endpoint over TLS. */
export function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("malformed id_token");
  return JSON.parse(new TextDecoder().decode(fromBase64url(part)));
}

/** ES256-signed JWT, e.g. the client secret for Sign in with Apple. */
export async function signEs256(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  pkcs8Pem: string,
): Promise<string> {
  const der = fromBase64url(
    pkcs8Pem
      .replace(/-----[^-]+-----/g, "")
      .replace(/\s+/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_"),
  );
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const body = `${base64url(enc.encode(JSON.stringify(header)))}.${base64url(enc.encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(body));
  return `${body}.${base64url(new Uint8Array(sig))}`;
}

/** (mime, extension) from magic bytes; the client's content type is not trusted. */
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
