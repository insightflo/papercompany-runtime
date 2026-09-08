import { ApiError } from "../../api/client.js";

export function apiBaseUrl(): string {
  if (typeof window !== "undefined" && typeof window.location?.origin === "string" && window.location.origin.startsWith("http")) {
    return window.location.origin;
  }
  return "http://localhost:3100";
}

export async function coreApiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  if (!(init?.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${apiBaseUrl()}/api${path}`, {
    credentials: "include",
    ...init,
    headers,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new ApiError(payload?.error ?? payload?.message ?? `Request failed (${res.status})`, res.status, payload);
  }
  return await res.json() as T;
}
