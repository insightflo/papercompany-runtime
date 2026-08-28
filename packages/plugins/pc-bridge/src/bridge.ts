import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  HEALTH_PATH,
  HEALTH_TIMEOUT_MS,
  PUBLISH_PATH,
  WEBHOOK_KEY_HEADER,
} from "./constants.js";
import type { PcBridgeConfig } from "./config.js";
import type { ValidatedPublishRequest } from "./validate.js";
import { buildBridgePayload } from "./validate.js";

export type BridgeHttpClient = {
  fetch(url: string, init?: RequestInit): Promise<Response>;
};

export type BridgeHealth = {
  checkedAt: string;
  baseUrl: string;
  reachable: boolean;
  healthy: boolean;
  httpStatus: number | null;
  detail: string;
};

export type BridgePublishResult = {
  /** Mirrors the mac bridge body's own `ok` flag; false for transport errors too. */
  ok: boolean;
  httpStatus: number | null;
  /** Mac bridge JSON response, passed through unmodified when parseable. */
  body: Record<string, unknown> | null;
  /** Synthesized transport error (network/timeout/non-JSON), never the bridge's own message. */
  error: string | null;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}이(가) ${timeoutMs}ms 안에 완료되지 않았습니다.`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function parseJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text();
    if (!text) {
      return null;
    }

    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function checkBridgeHealth(
  http: BridgeHttpClient,
  baseUrl: string,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<BridgeHealth> {
  const checkedAt = new Date().toISOString();

  try {
    const response = await withTimeout(
      http.fetch(`${baseUrl}${HEALTH_PATH}`, { method: "GET" }),
      timeoutMs,
      "PC 브리지 health 확인",
    );
    const body = await parseJsonBody(response);
    const healthy = response.ok && body !== null && body.ok === true;

    return {
      checkedAt,
      baseUrl,
      reachable: true,
      healthy,
      httpStatus: response.status,
      detail: healthy
        ? "PC 브리지가 응답 중입니다."
        : body !== null
          ? `health 응답이 ok가 아닙니다 (HTTP ${response.status}).`
          : `health 응답을 파싱할 수 없습니다 (HTTP ${response.status}).`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      checkedAt,
      baseUrl,
      reachable: false,
      healthy: false,
      httpStatus: null,
      detail: `PC 브리지에 연결할 수 없습니다: ${message}`,
    };
  }
}

export async function postPublishToBridge(
  http: BridgeHttpClient,
  params: {
    baseUrl: string;
    webhookKey: string;
    request: ValidatedPublishRequest;
    timeoutMs: number;
  },
): Promise<BridgePublishResult> {
  const payload = buildBridgePayload(params.request);

  let response: Response;
  try {
    response = await withTimeout(
      http.fetch(`${params.baseUrl}${PUBLISH_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [WEBHOOK_KEY_HEADER]: params.webhookKey,
        },
        body: JSON.stringify(payload),
      }),
      params.timeoutMs,
      "PC 브리지 발행 요청",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      httpStatus: null,
      body: null,
      error: `PC 브리지로 요청을 전달하지 못했습니다: ${message}`,
    };
  }

  const body = await parseJsonBody(response);

  if (!response.ok) {
    return {
      ok: false,
      httpStatus: response.status,
      body,
      error: `PC 브리지가 HTTP ${response.status}을(를) 반환했습니다.`,
    };
  }

  if (body === null) {
    return {
      ok: false,
      httpStatus: response.status,
      body: null,
      error: "PC 브리지 응답을 JSON으로 파싱할 수 없습니다.",
    };
  }

  // Pass the bridge's own verdict through untouched.
  return {
    ok: body.ok === true,
    httpStatus: response.status,
    body,
    error: null,
  };
}

export async function resolveWebhookKey(ctx: PluginContext, config: PcBridgeConfig): Promise<string> {
  if (config.webhookKeyRef) {
    return (await ctx.secrets.resolve(config.webhookKeyRef)).trim();
  }

  return config.webhookKeyInline;
}
