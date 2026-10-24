// End-to-end API tests against `wrangler dev` with local D1/R2, walking the product flow.
// Run: npm test  (builds the web app first; logins use EMAIL_DEV_CODES test mode)

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const persist = mkdtempSync(join(tmpdir(), "tapstory-test-"));
let server;

const M4A = Buffer.concat([Buffer.from("\0\0\0\x20ftypM4A ", "latin1"), Buffer.alloc(64)]);

function wrangler(args) {
  return execFileSync("npx", ["wrangler", ...args, "--persist-to", persist], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
}
const sql = (command) => wrangler(["d1", "execute", "tapstory-db", "--local", "--command", command]);

before(async () => {
  wrangler(["d1", "migrations", "apply", "tapstory-db", "--local"]);
  server = spawn(
    "npx",
    ["wrangler", "dev", "--ip", "127.0.0.1", "--port", String(PORT), "--persist-to", persist, "--var", "EMAIL_DEV_CODES:1", "--var", "PAYMENT_MODE:demo"],
    { cwd: ROOT, stdio: ["ignore", "ignore", process.env.TS_TEST_LOG ? "inherit" : "ignore"], detached: true },
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
const hash = (t) => createHash("sha256").update(t).digest("hex");

function makeCard() {
  const token = newToken();
  sql(`INSERT INTO cards (token_hash, batch, created_at) VALUES ('${hash(token)}', 'test', 0)`);
  return token;
}

let ipCounter = 1;

/** A phone: own cookie jar, own client IP, sends the CSRF header. */
class Phone {
  constructor({ csrf = true } = {}) {
    this.cookie = "";
    this.ip = `10.1.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`;
    this.csrf = csrf;
  }
  async req(method, path, { json, form, headers = {} } = {}) {
    const h = { "CF-Connecting-IP": this.ip, ...headers };
    if (this.csrf) h["X-Requested-With"] = "tapstory";
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
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      if (pair.startsWith("ts_session=")) this.cookie = pair.endsWith("=") ? "" : pair;
    }
    return res;
  }
  get = (p, o) => this.req("GET", p, o);
  post = (p, o) => this.req("POST", p, o);
  async json(method, path, opts) {
    const res = await this.req(method, path, opts);
    const data = await res.json();
    if (opts?.status !== undefined) assert.equal(res.status, opts.status, JSON.stringify(data));
    else assert.ok(res.ok, `${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  }
  async login(email) {
    const { dev_code } = await this.json("POST", "/api/auth/email/start", { json: { email } });
    await this.json("POST", "/api/auth/email/verify", { json: { email, code: dev_code } });
    return this;
  }
  upload(path) {
    const form = new FormData();
    form.append("audio", new Blob([M4A]), "voice.m4a");
    form.append("duration", "4.2");
    return this.post(`${path}/messages`, { form });
  }
}

const uniq = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}@example.com`;

// --- anti-crawling ----------------------------------------------------------------

test("card pages look the same for any token; crawlers are told to stay out", async () => {
  const card = makeCard();
  const p = new Phone();
  const good = await p.get(`/c/${card}`);
  const bad = await p.get(`/c/${newToken()}`);
  assert.equal(good.status, 200);
  assert.equal(await good.text(), await bad.text());
  assert.match(good.headers.get("x-robots-tag"), /noindex/);
  assert.equal(good.headers.get("referrer-policy"), "no-referrer");
  assert.match(await (await p.get("/robots.txt")).text(), /Disallow: \//);
  assert.equal((await p.get("/assets/nope.js")).status, 404);
});

test("unknown tokens are 404 and guessing gets rate limited", async () => {
  const p = new Phone();
  const a = await p.get(`/api/cards/t/${newToken()}`);
  const b = await p.get("/api/cards/t/1");
  assert.equal(a.status, 404);
  assert.deepEqual(await a.json(), await b.json());
  let limited = false;
  for (let i = 0; i < 20 && !limited; i++) limited = (await p.get(`/api/cards/t/${newToken()}`)).status === 429;
  assert.ok(limited);
});

test("writes need the CSRF header", async () => {
  const res = await new Phone({ csrf: false }).post("/api/auth/email/start", { json: { email: uniq("x") } });
  assert.equal(res.status, 403);
});

// --- login ------------------------------------------------------------------------

test("email code login, wrong code, logout", async () => {
  const p = new Phone();
  const cfg = await p.json("GET", "/api/config");
  assert.deepEqual(cfg.providers, { google: false, apple: false, email: true });
  const email = uniq("mom");
  const { dev_code } = await p.json("POST", "/api/auth/email/start", { json: { email } });
  assert.match(dev_code, /^\d{6}$/);
  const wrong = dev_code === "000000" ? "111111" : "000000";
  await p.json("POST", "/api/auth/email/verify", { json: { email, code: wrong }, status: 400 });
  const ok = await p.post("/api/auth/email/verify", { json: { email, code: dev_code } });
  assert.match(ok.headers.get("set-cookie"), /ts_session=.*HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await p.json("GET", "/api/me")).me.email, email);
  await p.post("/api/auth/logout");
  assert.equal((await p.json("GET", "/api/me")).me, null);
  // A used code cannot be replayed.
  await p.json("POST", "/api/auth/email/verify", { json: { email, code: dev_code }, status: 400 });
});

test("OAuth providers stay off until configured", async () => {
  const res = await new Phone().get("/api/auth/google/start?next=/app");
  assert.equal(res.status, 404);
});

// --- the product flow -------------------------------------------------------------

test("activate, record, upgrade, apply, approve, invite, expire", async () => {
  const token = makeCard();
  const card = `/api/cards/t/${token}`;
  const mom = new Phone();
  const anon = new Phone();
  const grandkid = new Phone();
  const uncle = new Phone();

  // Not activated: anonymous visitors are sent to login; activation needs a session.
  let view = await anon.json("GET", card);
  assert.equal(view.card.activated, false);
  assert.equal(view.me, null);
  await anon.json("POST", `${card}/activate`, { json: { family_name: "杨家" }, status: 401 });

  // Mom signs in, has no family yet, creates one while activating.
  await mom.login(uniq("mom"));
  view = await mom.json("GET", card);
  assert.deepEqual(view.families, []);
  const { family_id } = await mom.json("POST", `${card}/activate`, { json: { family_name: "杨家", card_name: "" } });
  await mom.json("POST", `${card}/activate`, { json: { family_id }, status: 409 });
  view = await mom.json("GET", card);
  assert.equal(view.card.activated, true);
  assert.deepEqual(view.card.family, { id: family_id, name: "杨家", plan: "standard" });
  assert.equal(view.role, "admin");
  assert.equal(view.can_record, true);

  // Naming the card, then the first message on a standard card offers the upgrade once.
  await mom.json("PATCH", card, { json: { name: "外婆的八十岁生日" } });
  let res = await mom.json("POST", `${card}/messages`, { form: (() => { const f = new FormData(); f.append("audio", new Blob([M4A]), "v.m4a"); f.append("duration", "84"); return f; })() });
  assert.equal(res.upsell, true);
  res = await (await mom.upload(card)).json();
  assert.equal(res.upsell, false);

  // Anyone can listen without signing in; recording asks them to log in.
  view = await anon.json("GET", card);
  assert.equal(view.card.name, "外婆的八十岁生日");
  assert.equal(view.messages.length, 2);
  assert.equal(view.messages[0].duration, 84);
  assert.equal(view.record_block, "login");
  assert.equal(view.card.id, null, "non-members never learn the card id");
  const audio = await anon.get(view.messages[0].url, { headers: { Range: "bytes=0-3" } });
  assert.equal(audio.status, 206);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), M4A.subarray(0, 4));
  assert.equal((await anon.upload(card)).status, 401);

  // A signed-in non-member on a standard family sees the upgrade page and cannot apply yet.
  await grandkid.login(uniq("grandkid"));
  view = await grandkid.json("GET", card);
  assert.equal(view.record_block, "upgrade");
  await grandkid.json("POST", `${card}/apply`, { json: { identity: "孙女 小美" }, status: 409 });
  assert.equal((await grandkid.upload(card)).status, 403);

  // "当前家庭升级为家庭版" (demo payment), then the visitor can send a request.
  await grandkid.json("POST", `/api/families/${family_id}/upgrade`, { json: { period: "year" } });
  view = await grandkid.json("GET", card);
  assert.equal(view.card.family.plan, "family");
  assert.equal(view.record_block, "apply");
  await grandkid.json("POST", `${card}/apply`, { json: { identity: "", reason: "x" }, status: 400 });
  await grandkid.json("POST", `${card}/apply`, { json: { identity: "孙女 小美", reason: "想给外婆留生日祝福" } });
  assert.equal((await grandkid.json("GET", card)).record_block, "pending");

  // The admin sees and approves the request in 家庭成员.
  let fam = await mom.json("GET", `/api/families/${family_id}`);
  assert.equal(fam.applications.length, 1);
  assert.equal(fam.applications[0].identity, "孙女 小美");
  assert.equal(fam.applications[0].card_name, "外婆的八十岁生日");
  await grandkid.json("GET", `/api/families/${family_id}`, { status: 403 });
  await grandkid.json("POST", `/api/families/${family_id}/applications/${fam.applications[0].id}/approve`, { status: 403 });
  await mom.json("POST", `/api/families/${family_id}/applications/${fam.applications[0].id}/approve`);

  view = await grandkid.json("GET", card);
  assert.equal(view.role, "member");
  assert.equal(view.can_record, true);
  assert.equal((await grandkid.upload(card)).status, 200);
  view = await anon.json("GET", card);
  assert.equal(view.messages.at(-1).author.name, "孙女 小美");

  // Members can open the card by id from the app; others cannot.
  const cardId = (await mom.json("GET", card)).card.id;
  assert.ok(cardId);
  assert.equal((await grandkid.json("GET", `/api/cards/i/${cardId}`)).messages.length, 3);
  assert.equal((await uncle.get(`/api/cards/i/${cardId}`)).status, 404);

  // Only the author or the admin deletes a message.
  const momMsg = view.messages[0].id;
  const kidMsg = view.messages.at(-1).id;
  assert.equal((await grandkid.req("DELETE", `${card}/messages/${momMsg}`)).status, 403);
  await mom.json("DELETE", `${card}/messages/${kidMsg}`);

  // Invite links work while the family plan is active.
  const { url } = await mom.json("POST", `/api/families/${family_id}/invites`);
  const invite = new URL(url).pathname.split("/").pop();
  await uncle.login(uniq("uncle"));
  assert.equal((await uncle.json("GET", `/api/invites/${invite}`)).family.name, "杨家");
  await uncle.json("POST", `/api/invites/${invite}/accept`, { json: { nickname: "舅舅" } });
  fam = await mom.json("GET", `/api/families/${family_id}`);
  assert.deepEqual(fam.members.map((m) => m.name).sort(), ["孙女 小美", "舅舅", fam.members.find((m) => m.role === "admin").name].sort());
  assert.equal(fam.cards[0].messages, 2);

  // When the family plan lapses, only the admin can record again.
  sql(`UPDATE families SET plan_until = 0 WHERE id = ${family_id}`);
  view = await grandkid.json("GET", card);
  assert.equal(view.record_block, "plan_expired");
  assert.equal((await grandkid.upload(card)).status, 403);
  assert.equal((await mom.upload(card)).status, 200);
  await mom.json("POST", `/api/families/${family_id}/invites`, { status: 409 });
});

test("activating into an existing family needs membership", async () => {
  const a = await new Phone().login(uniq("a"));
  const b = await new Phone().login(uniq("b"));
  const fam = await a.json("POST", "/api/families", { json: { name: "A 家" } });
  const token = makeCard();
  await b.json("POST", `/api/cards/t/${token}/activate`, { json: { family_id: fam.id }, status: 403 });
  await a.json("POST", `/api/cards/t/${token}/activate`, { json: { family_id: fam.id } });
  assert.deepEqual((await a.json("GET", "/api/me")).families.map((f) => f.name), ["A 家"]);
});
