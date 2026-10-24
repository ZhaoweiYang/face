// Accounts and login: email code, Google and Sign in with Apple. Sessions are an
// HttpOnly cookie holding a random token whose hash is stored in D1.

import { HttpError, clientIp, cookie, json, limit, now, readJson, redirect, safeNext, setCookie, str } from "./http";
import { hashToken, jwtPayload, newToken, pkceChallenge, sha256, signEs256, sixDigitCode } from "./security";

export const SESSION_COOKIE = "ts_session";
const OAUTH_COOKIE = "ts_oauth";
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const CODE_TTL = 600;
const MAX_CODE_ATTEMPTS = 5;

export interface User {
  id: number;
  email: string | null;
  name: string;
  avatar_url: string;
}

export function providers(env: Env) {
  return {
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    apple: Boolean(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY),
    email: Boolean(env.RESEND_API_KEY) || emailDevCodes(env),
  };
}

/** Test mode: the login code is returned to the browser instead of being emailed. */
export function emailDevCodes(env: Env): boolean {
  return env.EMAIL_DEV_CODES === "1";
}

export async function currentUser(env: Env, request: Request): Promise<User | null> {
  const token = cookie(request, SESSION_COOKIE);
  if (!token || token.length > 64) return null;
  return env.DB.prepare(
    "SELECT users.id, users.email, users.name, users.avatar_url FROM sessions " +
      "JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
  )
    .bind(await hashToken(token), now())
    .first<User>();
}

export async function requireUser(env: Env, request: Request): Promise<User> {
  const user = await currentUser(env, request);
  if (!user) throw new HttpError(401, "请先登录", "login_required");
  return user;
}

async function sessionCookie(env: Env, userId: number): Promise<string> {
  const token = newToken();
  const ttl = Number(env.SESSION_DAYS) * 86400;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(
      await hashToken(token),
      userId,
      now() + ttl,
    ),
  ]);
  return setCookie(SESSION_COOKIE, token, { maxAge: ttl });
}

/** Finds or creates the user behind a login identity; a verified email links providers. */
async function loginIdentity(
  env: Env,
  provider: string,
  subject: string,
  profile: { email?: string; emailVerified?: boolean; name?: string; avatar?: string },
): Promise<number> {
  const linked = await env.DB.prepare("SELECT user_id FROM identities WHERE provider = ? AND subject = ?")
    .bind(provider, subject)
    .first<number>("user_id");
  let userId = linked;
  const email = profile.emailVerified && profile.email ? profile.email.toLowerCase() : null;
  if (!userId && email) {
    userId = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<number>("id");
  }
  if (!userId) {
    const name = profile.name?.trim() || (email ? email.split("@")[0] : "") || "TapStory 用户";
    userId = await env.DB.prepare(
      "INSERT INTO users (email, name, avatar_url, created_at) VALUES (?, ?, ?, ?) RETURNING id",
    )
      .bind(email, name.slice(0, 40), profile.avatar ?? "", now())
      .first<number>("id");
  } else if (profile.avatar) {
    await env.DB.prepare("UPDATE users SET avatar_url = ? WHERE id = ? AND avatar_url = ''").bind(profile.avatar, userId).run();
  }
  if (!linked) {
    await env.DB.prepare("INSERT OR IGNORE INTO identities (provider, subject, user_id) VALUES (?, ?, ?)")
      .bind(provider, subject, userId)
      .run();
  }
  return userId!;
}

// --- email code --------------------------------------------------------------

export async function emailStart(env: Env, request: Request): Promise<Response> {
  if (!providers(env).email) throw new HttpError(404, "邮箱登录未开启");
  const body = await readJson<{ email: string }>(request);
  const email = str(body.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "请输入正确的邮箱地址");
  await limit(env.RL_EMAIL, `ip:${clientIp(request)}`, "发送太频繁，请稍后再试");
  await limit(env.RL_EMAIL, `to:${email}`, "发送太频繁，请稍后再试");

  const code = sixDigitCode();
  await env.DB.prepare(
    "INSERT INTO email_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0) " +
      "ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0",
  )
    .bind(email, await sha256(`${email}|${code}`), now() + CODE_TTL)
    .run();

  if (env.RESEND_API_KEY) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: email,
        subject: `TapStory 登录验证码 ${code}`,
        text: `你的 TapStory 登录验证码是 ${code}，10 分钟内有效。如果不是你本人操作，请忽略这封邮件。`,
      }),
    });
    if (!res.ok) {
      console.error("resend", res.status, await res.text());
      if (!emailDevCodes(env)) throw new HttpError(502, "验证码发送失败，请稍后再试");
    }
  }
  return json({ sent: true, ...(emailDevCodes(env) ? { dev_code: code } : {}) });
}

export async function emailVerify(env: Env, request: Request): Promise<Response> {
  const body = await readJson<{ email: string; code: string }>(request);
  const email = str(body.email, 254).toLowerCase();
  const code = str(body.code, 12);
  await limit(env.RL_VERIFY, `ip:${clientIp(request)}`, "尝试次数过多，请稍后再试");
  const row = await env.DB.prepare("SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ?")
    .bind(email)
    .first<{ code_hash: string; expires_at: number; attempts: number }>();
  if (!row || row.expires_at < now() || row.attempts >= MAX_CODE_ATTEMPTS) {
    throw new HttpError(400, "验证码已失效，请重新获取");
  }
  if ((await sha256(`${email}|${code}`)) !== row.code_hash) {
    await env.DB.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
    throw new HttpError(400, "验证码不正确");
  }
  await env.DB.prepare("DELETE FROM email_codes WHERE email = ?").bind(email).run();
  const userId = await loginIdentity(env, "email", email, { email, emailVerified: true });
  return json({ ok: true }, { headers: { "Set-Cookie": await sessionCookie(env, userId) } });
}

// --- OAuth (Google, Apple) ----------------------------------------------------

interface OAuthState {
  provider: "google" | "apple";
  state: string;
  verifier: string;
  next: string;
}

function callbackUrl(request: Request, provider: string): string {
  return `${new URL(request.url).origin}/api/auth/${provider}/callback`;
}

export async function oauthStart(env: Env, request: Request, provider: "google" | "apple"): Promise<Response> {
  if (!providers(env)[provider]) throw new HttpError(404, "该登录方式未开启");
  const st: OAuthState = {
    provider,
    state: newToken(),
    verifier: newToken(32),
    next: safeNext(new URL(request.url).searchParams.get("next")),
  };
  const params = new URLSearchParams({ redirect_uri: callbackUrl(request, provider), response_type: "code", state: st.state });
  let url: string;
  if (provider === "google") {
    params.set("client_id", env.GOOGLE_CLIENT_ID!);
    params.set("scope", "openid email profile");
    params.set("code_challenge", await pkceChallenge(st.verifier));
    params.set("code_challenge_method", "S256");
    params.set("prompt", "select_account");
    url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  } else {
    params.set("client_id", env.APPLE_CLIENT_ID!);
    params.set("scope", "name email");
    params.set("response_mode", "form_post");
    url = `https://appleid.apple.com/auth/authorize?${params}`;
  }
  // Apple returns with a cross-site POST, which only carries SameSite=None cookies.
  const value = btoa(JSON.stringify(st));
  return redirect(url, [setCookie(OAUTH_COOKIE, value, { maxAge: 600, path: "/api/auth", sameSite: provider === "apple" ? "None" : "Lax" })]);
}

function readOAuthState(request: Request, provider: string, state: string | null): OAuthState {
  try {
    const st = JSON.parse(atob(cookie(request, OAUTH_COOKIE) ?? "")) as OAuthState;
    if (st.provider === provider && state && st.state === state) return st;
  } catch {
    // fall through
  }
  throw new HttpError(400, "登录已过期，请重新登录");
}

async function tokenRequest(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.id_token !== "string") {
    console.error("oauth token", res.status, data);
    throw new HttpError(502, "登录失败，请重试");
  }
  return jwtPayload(data.id_token);
}

export async function oauthCallback(env: Env, request: Request, provider: "google" | "apple"): Promise<Response> {
  let code: string | null;
  let state: string | null;
  let appleUser: { name?: { firstName?: string; lastName?: string } } = {};
  if (request.method === "POST") {
    const form = await request.formData();
    code = form.get("code") as string | null;
    state = form.get("state") as string | null;
    try {
      appleUser = JSON.parse((form.get("user") as string) ?? "{}");
    } catch {
      // only sent on the first Apple login
    }
  } else {
    const q = new URL(request.url).searchParams;
    code = q.get("code");
    state = q.get("state");
  }
  const st = readOAuthState(request, provider, state);
  if (!code) return redirect(`/login?next=${encodeURIComponent(st.next)}`);

  let claims: Record<string, unknown>;
  let name = "";
  if (provider === "google") {
    claims = await tokenRequest("https://oauth2.googleapis.com/token", {
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: callbackUrl(request, provider),
      grant_type: "authorization_code",
      code_verifier: st.verifier,
    });
    if (claims.aud !== env.GOOGLE_CLIENT_ID || !["accounts.google.com", "https://accounts.google.com"].includes(String(claims.iss)))
      throw new HttpError(400, "登录失败，请重试");
    name = String(claims.name ?? "");
  } else {
    const t = Math.floor(now());
    const secret = await signEs256(
      { alg: "ES256", kid: env.APPLE_KEY_ID },
      { iss: env.APPLE_TEAM_ID, iat: t, exp: t + 300, aud: "https://appleid.apple.com", sub: env.APPLE_CLIENT_ID },
      env.APPLE_PRIVATE_KEY!,
    );
    claims = await tokenRequest("https://appleid.apple.com/auth/token", {
      code,
      client_id: env.APPLE_CLIENT_ID!,
      client_secret: secret,
      redirect_uri: callbackUrl(request, provider),
      grant_type: "authorization_code",
    });
    if (claims.aud !== env.APPLE_CLIENT_ID || claims.iss !== "https://appleid.apple.com") throw new HttpError(400, "登录失败，请重试");
    name = [appleUser.name?.lastName, appleUser.name?.firstName].filter(Boolean).join("");
  }
  if (Number(claims.exp) < now() || typeof claims.sub !== "string") throw new HttpError(400, "登录失败，请重试");

  const userId = await loginIdentity(env, provider, claims.sub, {
    email: typeof claims.email === "string" ? claims.email : undefined,
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name,
    avatar: typeof claims.picture === "string" ? claims.picture : undefined,
  });
  return redirect(st.next, [
    await sessionCookie(env, userId),
    setCookie(OAUTH_COOKIE, "", { maxAge: 0, path: "/api/auth", sameSite: provider === "apple" ? "None" : "Lax" }),
  ]);
}

export async function logout(env: Env, request: Request): Promise<Response> {
  const token = cookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hashToken(token)).run();
  return json({ ok: true }, { headers: { "Set-Cookie": setCookie(SESSION_COOKIE, "", { maxAge: 0 }) } });
}
