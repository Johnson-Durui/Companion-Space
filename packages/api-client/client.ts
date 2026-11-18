import createClient from "openapi-fetch";
import type { paths } from "./schema";

export function browserApiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const request = input instanceof Request ? input : null;
  const url = new URL(request?.url ?? String(input), globalThis.location?.href);
  const headers = new Headers(init.headers ?? request?.headers);
  const method = (init.method ?? request?.method ?? "GET").toUpperCase();
  // Use the CSRF token only for same-origin requests. Never forward the readable CSRF value to another host.
  if (typeof document !== "undefined" && url.origin === globalThis.location.origin && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    const token = document.cookie.match(/(?:^|;\s*)companion_csrf=([^;]+)/)?.[1];
    if (token) headers.set("X-CSRF-Token", token);
  }
  return fetch(input, { ...init, headers, credentials: "include", cache: init.cache ?? "no-store" });
}

export function createApiClient(baseUrl: string) {
  return createClient<paths>({ baseUrl, fetch: browserApiFetch });
}
