import { createHash, timingSafeEqual } from "node:crypto";
import { toolProgressPolicySchema, type ToolProgressPolicy } from "@paperclipai/shared";

export class ToolProgressError extends Error {
  constructor(public readonly status: 400 | 401 | 404 | 409 | 422 | 500, public readonly reason: string) {
    super(reason);
    this.name = "ToolProgressError";
  }
}
export function readToolProgressPolicy(config: Record<string, unknown>): ToolProgressPolicy | undefined {
  if (config.progress === undefined) return undefined;
  const parsed = toolProgressPolicySchema.safeParse(config.progress);
  if (!parsed.success) throw new ToolProgressError(422, "tool_progress_invalid_policy");
  return parsed.data;
}
export function progressTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export function validProgressToken(tokenHash: string | null, token: unknown): boolean {
  const candidate = typeof token === "string" && token.length <= 256 ? progressTokenHash(token) : progressTokenHash("");
  const expected = tokenHash && /^[a-f0-9]{64}$/.test(tokenHash) ? tokenHash : "0".repeat(64);
  return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(expected, "hex")) && tokenHash !== null;
}
export function progressCallbackBase(injected?: string): string {
  const raw = injected ?? process.env.PAPERCLIP_PUBLIC_URL;
  try {
    if (!raw) throw new Error();
    const url = new URL(raw);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(injected !== undefined && loopback && url.protocol === "http:"))) throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new ToolProgressError(422, "tool_progress_invalid_callback_base");
  }
}
export function fixedHttpTimeout(value: unknown): number {
  if (value === undefined) return 120_000;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 2147483647) {
    throw new ToolProgressError(422, "tool_http_invalid_timeout");
  }
  return Math.max(1000, Math.trunc(value));
}
