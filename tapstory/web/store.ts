// Signed-in user, site config and a toast, shared across pages.

import { useEffect, useState } from "preact/hooks";
import { api, type Config, type FamilySummary, type Me } from "./api";

interface State {
  ready: boolean;
  me: Me | null;
  families: FamilySummary[];
  config: Config | null;
  toast: string | null;
}

let state: State = { ready: false, me: null, families: [], config: null, toast: null };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useStore(): State {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return state;
}

export async function refreshMe(): Promise<void> {
  const res = await api<{ me: Me | null; families: FamilySummary[] }>("/me");
  set({ me: res.me, families: res.families, ready: true });
}

export async function boot(): Promise<void> {
  const [config] = await Promise.all([api<Config>("/config").catch(() => null), refreshMe().catch(() => set({ ready: true }))]);
  set({ config });
}

let toastTimer = 0;
export function toast(text: string): void {
  set({ toast: text });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => set({ toast: null }), 3000);
}

export function getState(): State {
  return state;
}
