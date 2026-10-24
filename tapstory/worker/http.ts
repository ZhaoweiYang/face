// Small HTTP helpers shared by the route handlers.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly code?: string,
  ) {
    super(detail);
  }
}

export const now = () => Date.now() / 1000;

export function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, { ...init, headers: { "Cache-Control": "no-store", ...init.headers } });
}

export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

export function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function setCookie(
  name: string,
  value: string,
  { maxAge, path = "/", sameSite = "Lax" }: { maxAge: number; path?: string; sameSite?: "Lax" | "None" },
): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${sameSite}`;
}

export async function readJson<T>(request: Request): Promise<Partial<T>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Partial<T>) : {};
  } catch {
    throw new HttpError(400, "请求格式错误");
  }
}

export function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/** Only same-site relative paths may be used as a post-login destination. */
export function safeNext(value: string | null | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/app";
}

export async function limit(binding: RateLimit, key: string, message = "操作过于频繁，请稍后再试"): Promise<void> {
  if (!(await binding.limit({ key })).success) throw new HttpError(429, message);
}
