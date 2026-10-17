// VoiceCard on Cloudflare Workers: the same HTTP API as voicecard/app.py, backed by
// D1 (users, sessions, cards, messages) and R2 (audio), with the front-end in ../static.
//
// GET    /c/{token}                               the card page (same HTML for every token)
// GET    /api/cards/{token}                       card info + message list
// POST   /api/cards/{token}/claim                 first signed-in user claims the card
// PATCH  /api/cards/{token}                       owner: set title
// POST   /api/cards/{token}/messages              owner: upload audio (multipart `audio`, `duration`)
// DELETE /api/cards/{token}/messages/{id}         owner: delete
// GET    /api/cards/{token}/messages/{id}/audio   stream audio (supports Range)
// POST   /api/auth/register | login | logout,  GET /api/auth/me

import {
  MIN_PASSWORD,
  TOKEN_RE,
  USERNAME_RE,
  dummyPasswordHash,
  hashPassword,
  hashToken,
  newToken,
  sniffAudio,
  verifyPassword,
} from "./security";

const SESSION_COOKIE = "vc_session";
const CSRF_HEADER = "x-requested-with";
const CSRF_VALUE = "voicecard";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

interface User {
  id: number;
  username: string;
}

interface Card {
  id: number;
  title: string;
  owner_id: number | null;
  owner_name: string | null;
}

interface Message {
  id: string;
  card_id: number;
  filename: string;
  mime: string;
  size: number;
  duration: number;
  created_at: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
  }
}

const json = (data: unknown, init: ResponseInit = {}) =>
  Response.json(data, { ...init, headers: { "Cache-Control": "no-store", ...init.headers } });

const now = () => Date.now() / 1000;

function config(env: Env) {
  return {
    sessionSeconds: Number(env.SESSION_DAYS) * 86400,
    maxSeconds: Number(env.MAX_SECONDS),
    maxBytes: Number(env.MAX_AUDIO_MB) * 1024 * 1024,
    maxMessages: Number(env.MAX_MESSAGES),
    iterations: Math.min(Number(env.PBKDF2_ITERATIONS), 100_000),
  };
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "请求格式错误");
  }
}

class App {
  readonly cfg: ReturnType<typeof config>;

  constructor(
    readonly env: Env,
    readonly request: Request,
  ) {
    this.cfg = config(env);
  }

  // --- auth -----------------------------------------------------------------

  async currentUser(): Promise<User | null> {
    const token = cookie(this.request, SESSION_COOKIE);
    if (!token || token.length > 64) return null;
    return this.env.DB.prepare(
      "SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id " +
        "WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
    )
      .bind(await hashToken(token), now())
      .first<User>();
  }

  async requireUser(): Promise<User> {
    const user = await this.currentUser();
    if (!user) throw new HttpError(401, "请先登录");
    return user;
  }

  async startSession(userId: number, body: unknown): Promise<Response> {
    const token = newToken();
    const ttl = this.cfg.sessionSeconds;
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()),
      this.env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(
        await hashToken(token),
        userId,
        now() + ttl,
      ),
    ]);
    return json(body, {
      headers: { "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${ttl}; HttpOnly; Secure; SameSite=Lax` },
    });
  }

  async register(): Promise<Response> {
    if (!(await this.env.RL_REGISTER.limit({ key: clientIp(this.request) })).success)
      throw new HttpError(429, "注册过于频繁，请稍后再试");
    const body = await readJson<{ username?: unknown; password?: unknown }>(this.request);
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    if (!USERNAME_RE.test(username)) throw new HttpError(400, "用户名为 2–32 位字母、数字、汉字或 . _ -");
    if (password.length < MIN_PASSWORD || password.length > 256) throw new HttpError(400, `密码至少 ${MIN_PASSWORD} 位`);
    const hash = await hashPassword(password, this.cfg.iterations);
    const row = await this.env.DB.prepare(
      "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING id",
    )
      .bind(username, hash, now())
      .first<{ id: number }>();
    if (!row) throw new HttpError(409, "用户名已被使用");
    return this.startSession(row.id, { username });
  }

  async login(): Promise<Response> {
    const body = await readJson<{ username?: unknown; password?: unknown }>(this.request);
    const user = await this.env.DB.prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
      .bind(String(body.username ?? "").trim())
      .first<User & { password_hash: string }>();
    const ok = await verifyPassword(
      String(body.password ?? ""),
      user?.password_hash ?? dummyPasswordHash(this.cfg.iterations),
    );
    if (!user || !ok) {
      if (!(await this.env.RL_LOGIN.limit({ key: clientIp(this.request) })).success)
        throw new HttpError(429, "尝试次数过多，请稍后再试");
      throw new HttpError(401, "用户名或密码错误");
    }
    return this.startSession(user.id, { username: user.username });
  }

  async logout(): Promise<Response> {
    const token = cookie(this.request, SESSION_COOKIE);
    if (token) await this.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hashToken(token)).run();
    return json(
      { ok: true },
      { headers: { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } },
    );
  }

  async me(): Promise<Response> {
    const user = await this.currentUser();
    return json({ username: user?.username ?? null });
  }

  // --- cards ----------------------------------------------------------------

  /** Unknown and malformed tokens look identical; each miss counts against the IP. */
  async loadCard(token: string): Promise<Card> {
    const card = TOKEN_RE.test(token)
      ? await this.env.DB.prepare(
          "SELECT cards.id, cards.title, cards.owner_id, users.username AS owner_name FROM cards " +
            "LEFT JOIN users ON users.id = cards.owner_id WHERE cards.token_hash = ? AND cards.revoked = 0",
        )
          .bind(await hashToken(token))
          .first<Card>()
      : null;
    if (!card) {
      const { success } = await this.env.RL_MISS.limit({ key: clientIp(this.request) });
      throw success ? new HttpError(404, "卡片不存在") : new HttpError(429, "访问过于频繁，请稍后再试");
    }
    return card;
  }

  requireOwner(card: Card, user: User): void {
    if (card.owner_id !== user.id) throw new HttpError(403, "只有卡片主人可以留言");
  }

  messageOut(token: string, m: Message) {
    return {
      id: m.id,
      created_at: m.created_at,
      duration: m.duration,
      size: m.size,
      mime: m.mime,
      url: `/api/cards/${token}/messages/${m.id}/audio`,
    };
  }

  async getCard(token: string): Promise<Response> {
    const [card, user] = await Promise.all([this.loadCard(token), this.currentUser()]);
    const { results } = await this.env.DB.prepare("SELECT * FROM messages WHERE card_id = ? ORDER BY created_at")
      .bind(card.id)
      .all<Message>();
    return json({
      title: card.title,
      claimed: card.owner_id !== null,
      owner: card.owner_name,
      is_owner: user !== null && card.owner_id === user.id,
      me: user?.username ?? null,
      messages: results.map((m) => this.messageOut(token, m)),
      limits: { max_seconds: this.cfg.maxSeconds, max_bytes: this.cfg.maxBytes, max_messages: this.cfg.maxMessages },
    });
  }

  async claim(token: string): Promise<Response> {
    const user = await this.requireUser();
    const card = await this.loadCard(token);
    if (card.owner_id === user.id) return json({ claimed: true, already: true });
    // Atomic: only the first UPDATE against an unowned card changes a row.
    const res = await this.env.DB.prepare(
      "UPDATE cards SET owner_id = ?, claimed_at = ? WHERE id = ? AND owner_id IS NULL",
    )
      .bind(user.id, now(), card.id)
      .run();
    if (res.meta.changes !== 1) throw new HttpError(409, "这张卡片已经被别人认领了");
    return json({ claimed: true, already: false });
  }

  async updateCard(token: string): Promise<Response> {
    const user = await this.requireUser();
    const card = await this.loadCard(token);
    this.requireOwner(card, user);
    const body = await readJson<{ title?: unknown }>(this.request);
    const title = String(body.title ?? "").trim().slice(0, 60);
    await this.env.DB.prepare("UPDATE cards SET title = ? WHERE id = ?").bind(title, card.id).run();
    return json({ title });
  }

  // --- messages -------------------------------------------------------------

  async upload(token: string): Promise<Response> {
    const user = await this.requireUser();
    const card = await this.loadCard(token);
    this.requireOwner(card, user);
    if (!(await this.env.RL_UPLOAD.limit({ key: String(user.id) })).success)
      throw new HttpError(429, "上传过于频繁，请稍后再试");
    const count = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE card_id = ?")
      .bind(card.id)
      .first<number>("n");
    if ((count ?? 0) >= this.cfg.maxMessages)
      throw new HttpError(409, `每张卡片最多 ${this.cfg.maxMessages} 条留言，请先删除旧留言`);

    const tooBig = new HttpError(413, `录音超过 ${this.cfg.maxBytes / (1024 * 1024)} MB`);
    if (Number(this.request.headers.get("Content-Length") ?? 0) > this.cfg.maxBytes + 64 * 1024) throw tooBig;
    let form: FormData;
    try {
      form = await this.request.formData();
    } catch {
      throw new HttpError(400, "请求格式错误");
    }
    const file = form.get("audio");
    if (!file || typeof file === "string") throw new HttpError(400, "缺少录音文件");
    if (file.size > this.cfg.maxBytes) throw tooBig;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniffAudio(bytes.subarray(0, 16));
    if (!kind) throw new HttpError(415, "不支持的音频格式");
    const [mime, ext] = kind;

    const raw = Number(form.get("duration") ?? 0);
    const duration = Number.isFinite(raw) ? Math.round(Math.min(Math.max(raw, 0), this.cfg.maxSeconds + 5) * 10) / 10 : 0;
    const id = newToken(12);
    const key = `audio/${id}.${ext}`;
    await this.env.AUDIO.put(key, bytes, { httpMetadata: { contentType: mime } });
    const message: Message = { id, card_id: card.id, filename: key, mime, size: bytes.length, duration, created_at: now() };
    await this.env.DB.prepare(
      "INSERT INTO messages (id, card_id, author_id, filename, mime, size, duration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, card.id, user.id, key, mime, message.size, duration, message.created_at)
      .run();
    return json(this.messageOut(token, message));
  }

  async findMessage(card: Card, id: string): Promise<Message> {
    const m = await this.env.DB.prepare("SELECT * FROM messages WHERE id = ? AND card_id = ?")
      .bind(id, card.id)
      .first<Message>();
    if (!m) throw new HttpError(404, "留言不存在");
    return m;
  }

  async deleteMessage(token: string, id: string): Promise<Response> {
    const user = await this.requireUser();
    const card = await this.loadCard(token);
    this.requireOwner(card, user);
    const m = await this.findMessage(card, id);
    await this.env.DB.prepare("DELETE FROM messages WHERE id = ? AND card_id = ?").bind(id, card.id).run();
    await this.env.AUDIO.delete(m.filename);
    return json({ ok: true });
  }

  /** Streams audio from R2. Range support is required for playback in iOS Safari. */
  async audio(token: string, id: string): Promise<Response> {
    const card = await this.loadCard(token);
    const m = await this.findMessage(card, id);
    const ranged = this.request.headers.has("Range");
    let object: R2ObjectBody | R2Object | null;
    try {
      object = await this.env.AUDIO.get(m.filename, ranged ? { range: this.request.headers } : undefined);
    } catch {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${m.size}` } });
    }
    if (!object || !("body" in object)) throw new HttpError(404, "留言不存在");

    const headers = new Headers({
      "Content-Type": m.mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=86400",
      ETag: object.httpEtag,
    });
    let status = 200;
    let length = object.size;
    if (ranged && object.range) {
      const r = object.range as { offset?: number; length?: number; suffix?: number };
      const offset = r.suffix !== undefined ? object.size - r.suffix : (r.offset ?? 0);
      length = r.suffix !== undefined ? r.suffix : (r.length ?? object.size - offset);
      headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      status = 206;
    }
    headers.set("Content-Length", String(length));
    return new Response(this.request.method === "HEAD" ? null : object.body, { status, headers });
  }

  // --- routing --------------------------------------------------------------

  async page(path: string): Promise<Response> {
    const url = new URL(path, this.request.url);
    return this.env.ASSETS.fetch(new Request(url, { method: this.request.method, headers: this.request.headers }));
  }

  async route(): Promise<Response> {
    const { pathname } = new URL(this.request.url);
    const method = this.request.method;
    const read = method === "GET" || method === "HEAD";

    if (read && (pathname === "/" || /^\/c\/[^/]+\/?$/.test(pathname))) {
      // Same response for valid and invalid tokens: the page is no oracle for scanners.
      const res = await this.page("/index.html");
      return new Response(res.body, { status: res.status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (read && pathname.startsWith("/static/")) {
      const res = await this.page(pathname.slice("/static".length));
      if (res.status !== 200) throw new HttpError(404, "not found");
      const out = new Response(res.body, res);
      out.headers.set("Cache-Control", "public, max-age=3600");
      return out;
    }
    if (read && pathname === "/robots.txt") {
      return new Response(ROBOTS_TXT, { headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" } });
    }
    if (!pathname.startsWith("/api/")) throw new HttpError(404, "not found");

    if (!(await this.env.RL_API.limit({ key: clientIp(this.request) })).success)
      throw new HttpError(429, "请求过于频繁，请稍后再试");
    // Cross-site pages cannot add a custom header without a CORS preflight, which
    // this Worker never approves, so this blocks CSRF.
    if (!read && this.request.headers.get(CSRF_HEADER) !== CSRF_VALUE) throw new HttpError(403, "缺少请求头");

    const parts = pathname.split("/").slice(2); // after "/api"
    const [a, b, c, d, e] = parts;
    if (a === "auth" && parts.length === 2) {
      if (method === "POST" && b === "register") return this.register();
      if (method === "POST" && b === "login") return this.login();
      if (method === "POST" && b === "logout") return this.logout();
      if (method === "GET" && b === "me") return this.me();
    }
    if (a === "cards" && b) {
      if (parts.length === 2 && method === "GET") return this.getCard(b);
      if (parts.length === 2 && method === "PATCH") return this.updateCard(b);
      if (parts.length === 3 && c === "claim" && method === "POST") return this.claim(b);
      if (parts.length === 3 && c === "messages" && method === "POST") return this.upload(b);
      if (parts.length === 4 && c === "messages" && method === "DELETE") return this.deleteMessage(b, d);
      if (parts.length === 5 && c === "messages" && e === "audio" && read) return this.audio(b, d);
    }
    throw new HttpError(404, "not found");
  }
}

function withSecurityHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  if (!out.headers.has("Cache-Control")) out.headers.set("Cache-Control", "no-store");
  return out;
}

export default {
  async fetch(request, env): Promise<Response> {
    let response: Response;
    try {
      response = await new App(env, request).route();
    } catch (err) {
      if (err instanceof HttpError) {
        response = json({ detail: err.detail }, { status: err.status });
      } else {
        console.error(err);
        response = json({ detail: "服务器错误" }, { status: 500 });
      }
    }
    return withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;
