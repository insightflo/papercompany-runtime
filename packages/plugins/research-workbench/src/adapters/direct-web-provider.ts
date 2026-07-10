import type {
  DirectWebProviderFailureReason,
  VaneHeadlessSearchResult,
} from "../types.js";

export interface DirectWebHttp {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface DirectWebProviderRequest {
  http: DirectWebHttp;
  timeoutMs: number;
  query: string;
  maxResults: number;
}

export const MAX_DIRECT_WEB_RESPONSE_BYTES = 2_000_000;
export const DIRECT_WEB_RESPONSE_LIMIT_HEADER = "X-Paperclip-Max-Response-Bytes";

export class DirectWebTimeoutError extends Error {
  constructor() {
    super("direct-web provider request timed out");
    this.name = "DirectWebTimeoutError";
  }
}

export class DirectWebResponseLimitError extends Error {
  constructor() {
    super(`direct-web provider response exceeded ${MAX_DIRECT_WEB_RESPONSE_BYTES} bytes`);
    this.name = "DirectWebResponseLimitError";
  }
}

export type DirectWebProviderOutput =
  | {
      ok: true;
      results: VaneHeadlessSearchResult[];
      upstreamVersion?: string;
    }
  | {
      ok: false;
      error: string;
      reason: DirectWebProviderFailureReason;
      retryable: boolean;
      retryAfterSeconds?: number;
    };

export function isRetryableHttpStatus(status: number): boolean {
  return status === 202 || status === 408 || status === 425 || status === 429 || status >= 500;
}

export function parseRetryAfterSeconds(response: Response): number | undefined {
  const retryAfter = response.headers.get("Retry-After");
  if (!retryAfter) return undefined;

  const seconds = Number.parseInt(retryAfter, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function fetchWithDeadline(
  http: DirectWebHttp,
  url: string,
  init: RequestInit,
  deadline: number,
): Promise<Response> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new DirectWebTimeoutError();

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DirectWebTimeoutError());
    }, remainingMs);
  });

  try {
    return await Promise.race([
      http.fetch(url, { ...init, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readBoundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DIRECT_WEB_RESPONSE_BYTES) {
    throw new DirectWebResponseLimitError();
  }

  if (!response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_DIRECT_WEB_RESPONSE_BYTES) {
        await reader.cancel();
        throw new DirectWebResponseLimitError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
