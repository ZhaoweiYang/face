// TapStory Worker: JSON API under /api, the mobile web app (web/, built to dist/) for
// everything else. Card URLs on the NFC tags look like https://<host>/c/<token>.

import { currentUser, emailDevCodes, emailStart, emailVerify, logout, oauthCallback, oauthStart, providers } from "./auth";
import { App, PRICES, type CardRef } from "./app";
import { HttpError, clientIp, json, limit } from "./http";

const CSRF_HEADER = "x-requested-with";
const CSRF_VALUE = "tapstory";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; media-src 'self' blob:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

async function api(env: Env, request: Request, path: string[]): Promise<Response> {
  const method = request.method;
  const read = method === "GET" || method === "HEAD";
  await limit(env.RL_API, clientIp(request), "请求过于频繁，请稍后再试");

  const [a, b, c, d, e, f] = path;
  // OAuth redirects are top-level navigations (Apple's is a cross-site form POST) and
  // are protected by their state cookie instead of the CSRF header.
  if (a === "auth" && (b === "google" || b === "apple") && (c === "start" || c === "callback")) {
    return c === "start" ? oauthStart(env, request, b) : oauthCallback(env, request, b);
  }
  // Cross-site pages cannot add a custom header without a CORS preflight, which this
  // Worker never approves, so this blocks CSRF.
  if (!read && request.headers.get(CSRF_HEADER) !== CSRF_VALUE) throw new HttpError(403, "缺少请求头");

  if (a === "config" && read) {
    return json({
      providers: providers(env),
      email_dev_codes: emailDevCodes(env),
      payment_demo: env.PAYMENT_MODE === "demo",
      prices: PRICES,
    });
  }
  if (a === "auth" && method === "POST") {
    if (b === "email" && c === "start") return emailStart(env, request);
    if (b === "email" && c === "verify") return emailVerify(env, request);
    if (b === "logout") return logout(env, request);
  }

  const app = new App(env, request, await currentUser(env, request));
  if (a === "me" && !b) {
    if (read) return app.me();
    if (method === "PATCH") return app.updateMe();
  }
  if (a === "cards" && (b === "t" || b === "i") && c) {
    const ref: CardRef = { kind: b, ref: c };
    if (!d) {
      if (read) return app.cardView(ref);
      if (method === "PATCH") return app.renameCard(ref);
    }
    if (d === "activate" && method === "POST" && b === "t") return app.activate(c);
    if (d === "apply" && method === "POST") return app.apply(ref);
    if (d === "messages") {
      if (!e && method === "POST") return app.upload(ref);
      if (e && !f && method === "DELETE") return app.deleteMessage(ref, e);
      if (e && f === "audio" && read) return app.audio(ref, e);
    }
  }
  if (a === "families") {
    if (!b && method === "POST") return app.newFamily();
    const id = Number(b);
    if (Number.isInteger(id) && id > 0) {
      if (!c) {
        if (read) return app.familyView(id);
        if (method === "PATCH") return app.updateFamily(id);
      }
      if (c === "upgrade" && method === "POST") return app.upgrade(id);
      if (c === "invites" && method === "POST") return app.createInvite(id);
      if (c === "applications" && d && (e === "approve" || e === "reject") && method === "POST") {
        return app.decide(id, Number(d), e === "approve");
      }
      if (c === "members" && d) {
        if (method === "PATCH") return app.updateMember(id, Number(d));
        if (method === "DELETE") return app.removeMember(id, Number(d));
      }
    }
  }
  if (a === "invites" && b) {
    if (!c && read) return app.inviteView(b);
    if (c === "accept" && method === "POST") return app.acceptInvite(b);
  }
  throw new HttpError(404, "not found");
}

/** The single-page app: hashed assets are cached, every other path gets index.html. */
async function web(env: Env, request: Request, pathname: string): Promise<Response> {
  if (pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" } });
  }
  if (pathname.startsWith("/assets/")) {
    const res = await env.ASSETS.fetch(request);
    if (res.ok) {
      const out = new Response(res.body, res);
      out.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return out;
    }
    throw new HttpError(404, "not found");
  }
  // /c/<token> returns the same page for valid and invalid tokens: no oracle for scanners.
  const index = await env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
  return new Response(index.body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function withSecurityHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  if (!out.headers.has("Cache-Control")) out.headers.set("Cache-Control", "no-store");
  return out;
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    let response: Response;
    try {
      if (pathname.startsWith("/api/")) response = await api(env, request, pathname.split("/").slice(2));
      else if (request.method === "GET" || request.method === "HEAD") response = await web(env, request, pathname);
      else throw new HttpError(405, "method not allowed");
    } catch (err) {
      if (err instanceof HttpError) {
        response = json({ detail: err.detail, code: err.code ?? null }, { status: err.status });
      } else {
        console.error(err);
        response = json({ detail: "服务器错误，请稍后再试" }, { status: 500 });
      }
    }
    return withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;
