// Minimal pushState router.

import { useEffect, useState } from "preact/hooks";

export function navigate(to: string, { replace = false } = {}): void {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event("popstate"));
  window.scrollTo(0, 0);
}

export function useLocation(): URL {
  const [url, setUrl] = useState(() => new URL(location.href));
  useEffect(() => {
    const on = () => setUrl(new URL(location.href));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return url;
}

export function loginUrl(next = location.pathname + location.search): string {
  return `/login?next=${encodeURIComponent(next)}`;
}

/** Intercepts clicks on same-origin <a> links so they route without a reload. */
export function onLinkClick(e: MouseEvent): void {
  const a = (e.target as HTMLElement).closest("a");
  if (!a || a.target || a.origin !== location.origin || a.pathname.startsWith("/api/") || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  navigate(a.pathname + a.search);
}
