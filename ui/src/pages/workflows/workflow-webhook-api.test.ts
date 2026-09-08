// @vitest-environment node
// [bounded correction] workflow-webhook-api 회귀 — B2 공개 URL 계약, 404/오류의 상태 코드
// 보존(산문 파싱 금지), enable/disable 요청 형태, 그리고 [B1] 수명 토큰의 실제 지연 완료
// 폐기(구조적 단언이 아닌 deferred Promise 증명 — 코디네이터 수정사항).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLifecycleGuard,
  disableWorkflowWebhook,
  enableWorkflowWebhook,
  fetchWorkflowWebhookStatus,
  WebhookApiError,
  webhookDeliveryUrl,
} from "./workflow-webhook-api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webhookDeliveryUrl — B2 public ingress contract", () => {
  it("points at the real ingress POST /api/webhooks/workflows/:workflowId (not the old deliveries path)", () => {
    const url = webhookDeliveryUrl("11111111-1111-4111-8111-111111111111");
    expect(url).toBe("http://localhost:3100/api/webhooks/workflows/11111111-1111-4111-8111-111111111111");
    expect(url).not.toContain("/api/workflows/");
    expect(url).not.toContain("/deliveries");
    expect(url).toContain("/api/webhooks/workflows/");
  });
});

describe("fetchWorkflowWebhookStatus — structured status-code contract", () => {
  it("returns the parsed status on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ enabled: true, last4: "ab12", deliveriesLast24h: 3 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWorkflowWebhookStatus("wf-1")).resolves.toEqual({ enabled: true, last4: "ab12", deliveriesLast24h: 3 });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/workflows/wf-1/webhook");
  });

  it("real 404 (unconfigured) raises WebhookApiError with status 404 — the machine signal for the register path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "Workflow webhook is not configured" }, 404)));
    const error = await fetchWorkflowWebhookStatus("wf-1").then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(WebhookApiError);
    expect((error as WebhookApiError).status).toBe(404);
    // Prose must not be the discriminator — only the status code is asserted as contract.
  });

  it("non-404 errors keep their status (unknown state, mutation must be denied upstream)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500)));
    const error = await fetchWorkflowWebhookStatus("wf-1").then(() => null, (e: unknown) => e);
    expect((error as WebhookApiError).status).toBe(500);
  });

  it("non-JSON error bodies still preserve the status code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => { throw new Error("not json"); },
    } as unknown as Response));
    const error = await fetchWorkflowWebhookStatus("wf-1").then(() => null, (e: unknown) => e);
    expect((error as WebhookApiError).status).toBe(503);
  });
});

describe("enable/disable request shapes", () => {
  it("enableWorkflowWebhook POSTs and returns the one-time secret payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ secret: "s3cr3t", last4: "3t3t", enabled: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(enableWorkflowWebhook("wf-1")).resolves.toEqual({ secret: "s3cr3t", last4: "3t3t", enabled: true });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("disableWorkflowWebhook DELETEs and returns enabled:false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ enabled: false }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(disableWorkflowWebhook("wf-1")).resolves.toEqual({ enabled: false });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
  });
});

describe("createLifecycleGuard — [B1] real deferred-completion fencing", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it("returns the task value while alive", async () => {
    const guard = createLifecycleGuard();
    await expect(guard.run(async () => "fresh")).resolves.toBe("fresh");
  });

  it("discards a deferred completion when the lifetime ended before resolution", async () => {
    const guard = createLifecycleGuard();
    const d = deferred<string>();
    const pending = guard.run(() => d.promise);
    guard.end(); // 신원 변경/언마운트 — 이후의 완료는 폐기된다.
    d.resolve("stale-value");
    await expect(pending).resolves.toBeNull();
  });

  it("discards multiple in-flight completions after end (GET+POST race shape)", async () => {
    const guard = createLifecycleGuard();
    const a = deferred<string>();
    const b = deferred<number>();
    const pa = guard.run(() => a.promise);
    const pb = guard.run(() => b.promise);
    guard.end();
    a.resolve("stale-status");
    b.resolve(7);
    await expect(pa).resolves.toBeNull();
    await expect(pb).resolves.toBeNull();
  });

  it("alive flag reflects the ended lifetime for action-side checks", () => {
    const guard = createLifecycleGuard();
    expect(guard.alive).toBe(true);
    guard.end();
    expect(guard.alive).toBe(false);
  });
});
