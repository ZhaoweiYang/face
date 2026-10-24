// Typed client for the Worker API (worker/index.ts).

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, { method = "GET", json, form }: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "tapstory" };
  let body: BodyInit | undefined;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) body = form;
  const res = await fetch(`/api${path}`, { method, headers, body, credentials: "same-origin" });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.detail ?? `请求失败（${res.status}）`, res.status, data?.code ?? null);
  return data as T;
}

export type Plan = "standard" | "family";
export type Role = "admin" | "member";

export interface Me {
  id: number;
  name: string;
  email: string | null;
  avatar: string;
}

export interface FamilySummary {
  id: number;
  name: string;
  role: Role;
  plan: Plan;
  plan_until: number;
}

export interface Config {
  providers: { google: boolean; apple: boolean; email: boolean };
  email_dev_codes: boolean;
  payment_demo: boolean;
  prices: Record<"quarter" | "year", { monthly: number; total_fen: number; days: number; label: string }>;
}

export interface Message {
  id: string;
  author: { name: string; avatar: string };
  mine: boolean;
  can_delete: boolean;
  created_at: number;
  duration: number;
  url: string;
}

export type RecordBlock = "login" | "apply" | "upgrade" | "pending" | "plan_expired" | null;

export interface CardView {
  card: { id: number | null; name: string; activated: boolean; family: { id: number; name: string; plan: Plan } | null };
  me: Me | null;
  role?: Role | null;
  can_record?: boolean;
  record_block?: RecordBlock;
  messages?: Message[];
  families?: FamilySummary[];
  limits: { max_seconds: number; max_bytes: number };
}

export interface FamilyView {
  family: { id: number; name: string; plan: Plan; plan_until: number };
  role: Role;
  members: { id: number; name: string; account: string; email: string | null; avatar: string; role: Role; me: boolean }[];
  cards: { id: number; name: string; messages: number; last_at: number | null }[];
  applications: { id: number; identity: string; reason: string; created_at: number; name: string; email: string | null; avatar_url: string; card_name: string | null }[];
}
