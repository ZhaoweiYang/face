// End-to-end API tests against `wrangler dev` with local D1/R2 (mirrors voicecard/tests).
// Run: npm test

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const persist = mkdtempSync(join(tmpdir(), "voicecard-test-"));
let server;

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);
const M4A = Buffer.concat([Buffer.from("\0\0\0\x20ftypM4A ", "latin1"), Buffer.alloc(64)]);

function wrangler(args) {
  return execFileSync("npx", ["wrangler", ...args, "--persist-to", persist], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
}

before(async () => {
  wrangler(["d1", "migrations", "apply", "voicecard-db", "--local"]);
  server = spawn(
    "npx",
    ["wrangler", "dev", "--ip", "127.0.0.1", "--port", String(PORT), "--persist-to", persist, "--var", "MAX_MESSAGES:3", "--var", "PBKDF2_ITERATIONS:1000"],
    { cwd: ROOT, stdio: ["ignore", "ignore", process.env.VC_TEST_LOG ? "inherit" : "ignore"], detached: true },
  );
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/robots.txt`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start");
});

after(() => {
  if (server) process.kill(-server.pid);
  rmSync(persist, { recursive: true, force: true });
});

const newToken = () => randomBytes(16).toString("base64url");

/** Inserts cards straight into local D1 and returns their tokens. */
function makeCards(n = 1) {
  const tokens = Array.from({ length: n }, newToken);
  const values = tokens
    .map((t) => `('${createHash("sha256").update(t).digest("hex")}', 'test', ${Date.now() / 1000})`)
    .join(", ");
  wrangler(["d1", "execute", "voicecard-db", "--local", "--command", `INSERT INTO cards (token_hash, batch, created_at) VALUES ${values}`]);
  return tokens;
}

let ipCounter = 1;

/** A browser-ish client: own cookie jar, own client IP, sends the CSRF header. */
class Client {
  constructor({ csrf = true } = {}) {
    this.cookie = "";
    this.ip = `10.0.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`;
    this.csrf = csrf;
  }
  async req(method, path, { json, form, headers = {} } = {}) {
    const h = { "CF-Connecting-IP": this.ip, ...headers };
    if (this.csrf) h["X-Requested-With"] = "voicecard";
    if (this.cookie) h.Cookie = this.cookie;
    let body;
    if (json !== undefined) {
      h["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form) body = form;
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(BASE + path, { method, headers: h, body, redirect: "manual" });
        break;
      } catch (err) {
        // wrangler dev drops idle keep-alive sockets while a test shells out to wrangler.
        if (attempt === 0 && err.cause?.code === "UND_ERR_SOCKET") continue;
        throw err;
      }
    }
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    return res;
  }
  get(path, opts) {
    return this.req("GET", path, opts);
  }
  post(path, opts) {
    return this.req("POST", path, opts);
  }
  async register(name, password = "password123") {
    const res = await this.post("/api/auth/register", { json: { username: name, password } });
    assert.equal(res.status, 200, await res.text());
  }
  upload(token, data = M4A, duration = "3.2") {
    const form = new FormData();
    form.append("audio", new Blob([data]), "voice.m4a");
    form.append("duration", duration);
    return this.post(`/api/cards/${token}/messages`, { form });
  }
}

const uniq = (p) => `${p}${Math.random().toString(36).slice(2, 8)}`;

// --- anti-crawling ------------------------------------------------------------

test("card page is identical for valid and invalid tokens", async () => {
  const [card] = makeCards();
  const c = new Client();
  const good = await c.get(`/c/${card}`);
  const bad = await c.get(`/c/${newToken()}`);
  assert.equal(good.status, 200);
  assert.equal(bad.status, 200);
  assert.equal(await good.text(), await bad.text());
  assert.match(good.headers.get("x-robots-tag"), /noindex/);
  assert.equal(good.headers.get("referrer-policy"), "no-referrer");
  assert.equal(good.headers.get("cache-control"), "no-store");
});

test("static assets and robots.txt", async () => {
  const c = new Client();
  const js = await c.get("/static/app.js");
  assert.equal(js.status, 200);
  assert.equal(await js.text(), readFileSync(join(ROOT, "../static/app.js"), "utf8"));
  assert.match(await (await c.get("/robots.txt")).text(), /Disallow: \//);
  assert.equal((await c.get("/static/nope.js")).status, 404);
  assert.equal((await c.get("/wrangler.jsonc")).status, 404);
});

test("unknown and malformed tokens look the same, and guessing is rate limited", async () => {
  const c = new Client();
  const a = await c.get(`/api/cards/${newToken()}`);
  const b = await c.get("/api/cards/1");
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  assert.deepEqual(await a.json(), await b.json());
  let limited = false;
  for (let i = 0; i < 20 && !limited; i++) limited = (await c.get(`/api/cards/${newToken()}`)).status === 429;
  assert.ok(limited, "expected 429 after repeated misses");
});

test("state changes require the CSRF header", async () => {
  const res = await new Client({ csrf: false }).post("/api/auth/register", { json: { username: uniq("x"), password: "password123" } });
  assert.equal(res.status, 403);
});

// --- auth -----------------------------------------------------------------------

test("register, login, logout", async () => {
  const c = new Client();
  const name = uniq("alice");
  const res = await c.post("/api/auth/register", { json: { username: name, password: "password123" } });
  assert.match(res.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  assert.deepEqual(await (await c.get("/api/auth/me")).json(), { username: name });
  await c.post("/api/auth/logout");
  assert.deepEqual(await (await c.get("/api/auth/me")).json(), { username: null });
  assert.equal((await c.post("/api/auth/login", { json: { username: name, password: "wrong-pass" } })).status, 401);
  assert.equal((await c.post("/api/auth/login", { json: { username: name.toUpperCase(), password: "password123" } })).status, 200);
  assert.deepEqual(await (await c.get("/api/auth/me")).json(), { username: name });

  const dup = await new Client().post("/api/auth/register", { json: { username: name, password: "password123" } });
  assert.equal(dup.status, 409);
});

// --- claiming & messages ----------------------------------------------------------

test("first signed-in user claims; others can only listen", async () => {
  const [card] = makeCards();
  const alice = new Client();
  const bob = new Client();
  const anon = new Client();
  assert.equal((await anon.post(`/api/cards/${card}/claim`)).status, 401);
  await alice.register(uniq("alice"));
  await bob.register(uniq("bob"));

  assert.deepEqual(await (await alice.post(`/api/cards/${card}/claim`)).json(), { claimed: true, already: false });
  assert.deepEqual(await (await alice.post(`/api/cards/${card}/claim`)).json(), { claimed: true, already: true });
  assert.equal((await bob.post(`/api/cards/${card}/claim`)).status, 409);

  const res = await alice.upload(card);
  assert.equal(res.status, 200);
  const msg = await res.json();
  assert.equal(msg.mime, "audio/mp4");
  assert.equal(msg.duration, 3.2);
  assert.equal((await bob.upload(card)).status, 403);
  assert.equal((await anon.upload(card)).status, 401);

  const info = await (await anon.get(`/api/cards/${card}`)).json();
  assert.equal(info.claimed, true);
  assert.equal(info.is_owner, false);
  assert.deepEqual(info.messages.map((m) => m.id), [msg.id]);
  const audio = await anon.get(msg.url);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get("content-type"), "audio/mp4");
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), M4A);

  assert.equal((await bob.req("DELETE", `/api/cards/${card}/messages/${msg.id}`)).status, 403);
  assert.equal((await bob.req("PATCH", `/api/cards/${card}`, { json: { title: "mine" } })).status, 403);
  const renamed = await alice.req("PATCH", `/api/cards/${card}`, { json: { title: "  外婆的生日  " } });
  assert.deepEqual(await renamed.json(), { title: "外婆的生日" });
});

test("audio supports Range and needs the right card token", async () => {
  const [card, other] = makeCards(2);
  const c = new Client();
  await c.register(uniq("owner"));
  await c.post(`/api/cards/${card}/claim`);
  const msg = await (await c.upload(card, WEBM)).json();

  const part = await c.get(msg.url, { headers: { Range: "bytes=0-3" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 0-3/${WEBM.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), WEBM.subarray(0, 4));

  const tail = await c.get(msg.url, { headers: { Range: "bytes=-4" } });
  assert.equal(tail.status, 206);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), WEBM.subarray(-4));

  assert.equal((await c.get(`/api/cards/${other}/messages/${msg.id}/audio`)).status, 404);
});

test("rejects non-audio, enforces message limit, deletes", async () => {
  const [card] = makeCards();
  const c = new Client();
  await c.register(uniq("owner"));
  await c.post(`/api/cards/${card}/claim`);
  assert.equal((await c.upload(card, Buffer.from("<html><script>alert(1)</script>"))).status, 415);

  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await (await c.upload(card)).json()).id);
  assert.equal((await c.upload(card)).status, 409);

  const url = `/api/cards/${card}/messages/${ids[0]}`;
  assert.equal((await c.req("DELETE", url)).status, 200);
  assert.equal((await c.get(`${url}/audio`)).status, 404);
  assert.equal((await c.upload(card)).status, 200);
});

test("revoked card is gone", async () => {
  const [card] = makeCards();
  const hash = createHash("sha256").update(card).digest("hex");
  wrangler(["d1", "execute", "voicecard-db", "--local", "--command", `UPDATE cards SET revoked = 1 WHERE token_hash = '${hash}'`]);
  assert.equal((await new Client().get(`/api/cards/${card}`)).status, 404);
});
