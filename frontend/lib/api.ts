"use client";

/** Thin fetch wrapper for the Rust API (proxied at /api/v1 by Next.js).
 *  - attaches the double-submit CSRF header on mutating requests
 *  - transparently refreshes an expired access token once and retries
 *  - turns `{ error: { code, message } }` into a typed ApiError */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Init = Omit<RequestInit, "body"> & { json?: unknown; body?: BodyInit };

let csrfToken: string | null = null;
let csrfInflight: Promise<string> | null = null;
let refreshInflight: Promise<boolean> | null = null;

async function getCsrf(force = false): Promise<string> {
  if (csrfToken && !force) return csrfToken;
  csrfInflight ??= fetch("/api/v1/auth/csrf", { credentials: "same-origin", signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json())
    .then((j: { token: string }) => (csrfToken = j.token))
    .finally(() => (csrfInflight = null));
  return csrfInflight;
}

async function send(path: string, init: Init, forceCsrf = false): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  if (method !== "GET" && method !== "HEAD") headers.set("X-CSRF-Token", await getCsrf(forceCsrf));
  // A stalled API should fail in seconds, not hang the page. Callers can pass their own signal.
  return fetch(path, { ...init, method, headers, body, credentials: "same-origin", signal: init.signal ?? AbortSignal.timeout(20_000) });
}

async function errorCode(res: Response): Promise<string | undefined> {
  try {
    return ((await res.clone().json()) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

export async function refreshSession(): Promise<boolean> {
  refreshInflight ??= send("/api/v1/auth/refresh", { method: "POST" })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshInflight = null), 0));
  return refreshInflight;
}

const NO_REFRESH = ["/api/v1/auth/login", "/api/v1/auth/signup", "/api/v1/auth/refresh", "/api/v1/auth/logout"];

export async function apiFetch(path: string, init: Init = {}): Promise<Response> {
  let res = await send(path, init);
  if (res.status === 403 && (await errorCode(res)) === "csrf_failed") {
    res = await send(path, init, true);
  }
  if (res.status === 401 && !NO_REFRESH.includes(path)) {
    if (await refreshSession()) res = await send(path, init);
  }
  return res;
}

export async function toApiError(res: Response): Promise<ApiError> {
  try {
    const j = (await res.json()) as { error?: { code: string; message: string } };
    if (j.error) return new ApiError(res.status, j.error.code, j.error.message);
  } catch {
    /* fall through */
  }
  return new ApiError(res.status, "http_error", `Request failed (${res.status}).`);
}

export async function api<T>(path: string, init: Init = {}): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204 || res.status === 202) return undefined as T;
  return (await res.json()) as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) return "The server isn't responding. Please try again in a moment.";
  if (err instanceof TypeError) return "Couldn't reach the server. Check your connection and try again.";
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
