import type { PluginConfigValidationResult } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_BRIDGE_BASE_URL,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_HISTORY_LIMIT,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_HISTORY_LIMIT,
  MIN_REQUEST_TIMEOUT_MS,
} from "./constants.js";

export type PcBridgeConfig = {
  bridgeBaseUrl: string;
  /** Secret reference for the mac bridge webhook key (preferred). */
  webhookKeyRef: string;
  /** Inline webhook key fallback when no secret reference is configured. */
  webhookKeyInline: string;
  requestTimeoutMs: number;
  historyLimit: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed;
}

export function resolvePcBridgeConfig(raw: unknown): PcBridgeConfig {
  const record = asRecord(raw);

  const bridgeBaseUrl = asString(record.bridgeBaseUrl) || DEFAULT_BRIDGE_BASE_URL;
  const clampedTimeout = Math.min(
    Math.max(asNumber(record.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS), MIN_REQUEST_TIMEOUT_MS),
    MAX_REQUEST_TIMEOUT_MS,
  );
  const clampedHistoryLimit = Math.min(
    Math.max(Math.trunc(asNumber(record.historyLimit, DEFAULT_HISTORY_LIMIT)), MIN_HISTORY_LIMIT),
    MAX_HISTORY_LIMIT,
  );

  return {
    bridgeBaseUrl: bridgeBaseUrl.replace(/\/+$/, ""),
    webhookKeyRef: asString(record.webhookKeyRef),
    webhookKeyInline: asString(record.webhookKey),
    requestTimeoutMs: clampedTimeout,
    historyLimit: clampedHistoryLimit,
  };
}

export function isWebhookKeyConfigured(config: PcBridgeConfig): boolean {
  return config.webhookKeyRef.length > 0 || config.webhookKeyInline.length > 0;
}

export function validatePcBridgeConfig(raw: unknown): PluginConfigValidationResult {
  const config = resolvePcBridgeConfig(raw);
  const warnings: string[] = [];
  const errors: string[] = [];

  try {
    const parsed = new URL(config.bridgeBaseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.push(`bridgeBaseUrl 프로토콜은 http 또는 https 여야 합니다: ${config.bridgeBaseUrl}`);
    }
  } catch {
    errors.push(`bridgeBaseUrl이(가) 유효한 URL이 아닙니다: ${config.bridgeBaseUrl}`);
  }

  if (!isWebhookKeyConfigured(config)) {
    warnings.push(
      "웹훅 키가 설정되지 않았습니다. webhookKeyRef(시크릿 참조, 권장) 또는 webhookKey를 설정하세요.",
    );
  }

  if (config.webhookKeyRef && config.webhookKeyInline) {
    warnings.push("webhookKeyRef와 webhookKey가 모두 설정되어 있습니다. 시크릿 참조(webhookKeyRef)를 우선 사용합니다.");
  }

  return errors.length > 0 ? { ok: false, errors, warnings } : { ok: true, warnings };
}
