// @vitest-environment jsdom
// [three-fixes + test-only-fast] Finding 1(실패 액션의 busy/오류/미처리 거절) + Finding 2(수명 캡처
// 후 갱신 전 상태 적용/후속 GET 차단) 실마운트 회귀. 검증자 지적 반영:
//  (1) stale POST/DELETE × 성공/실패 × unmount/동일인스턴스 전환 8케이스 전수,
//  (2) 실제 React useState setter 를 위임 관찰하는 관찰자로 "setter 없음"을 직접 관찰(긍정 통제 포함),
//  (3) unhandledRejection 리스너를 동일 함수 참조로 on/off 하고 테스트마다 버퍼를 리셋한다.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { WorkflowWebhookPanel } from "./workflow-webhook-panel.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// [setter observer] 패널이 import 한 useState 를 "실제 훅"으로 위임하되 모든 setter 호출을 센다.
// 컴포넌트/상태 로직은 재구현하지 않는다. 긍정 통제: 현재 수명의 실패/성공 경로에서 delta > 0.
const setterAudit = vi.hoisted(() => ({ calls: 0 }));
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  const observedUseState = (initial: unknown): unknown => {
    const [value, setter] = real.useState(initial);
    return [value, (next: unknown) => { setterAudit.calls += 1; setter(next); }];
  };
  return { ...real, useState: observedUseState as unknown as typeof real.useState };
});

const ENABLED = { enabled: true, last4: "ab12", deliveriesLast24h: 2 };
const UNCONFIGURED = { enabled: false, last4: null, deliveriesLast24h: 0 };
const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

type Pending = { url: string; init?: RequestInit; resolve: (r: Response) => void; reject: (e: unknown) => void };

function deferredFetch() {
  const calls: Pending[] = [];
  const fetchMock = vi.fn((url: string | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => { calls.push({ url: String(url), init, resolve, reject }); }));
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

const unhandled: unknown[] = [];
const rejectionListener = (reason: unknown) => { unhandled.push(reason); };
beforeAll(() => { process.on("unhandledRejection", rejectionListener); });
afterAll(() => { process.off("unhandledRejection", rejectionListener); });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(unhandled, "rejections must be handled inside the panel").toEqual([]);
  unhandled.length = 0;
});

async function mountPanel(workflowId: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<WorkflowWebhookPanel workflowId={workflowId} />); });
  return {
    container,
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
    async switchTo(nextId: string) { await act(async () => { root.render(<WorkflowWebhookPanel workflowId={nextId} />); }); },
  };
}

async function click(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  expect(button, `button "${label}" not found`).toBeDefined();
  await act(async () => { button!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

const text = (container: HTMLElement) => container.textContent ?? "";
const buttonByLabel = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) ?? null;

describe("Finding 1 — failed register/rotate/disable recover with visible error and settled busy", () => {
  it.each(["등록", "재발급", "비활성화"] as const)("failed %s action: busy settles, error visible, real setters observed", async (label) => {
    const io = deferredFetch();
    const panel = await mountPanel("wf-1");
    io.calls.filter((c) => c.url.includes("/webhook")).at(-1)!.resolve(jsonResponse(label === "등록" ? UNCONFIGURED : ENABLED));
    await act(async () => {});
    if (label !== "등록") { vi.spyOn(window, "confirm").mockReturnValue(true); }
    await click(panel.container, label === "등록" ? "웹훅 등록" : label === "재발급" ? "키 재발급" : "비활성화");
    const mutation = io.calls.filter((c) => c.url.includes("/webhook") && c.init?.method !== undefined).at(-1)!;
    const settersBefore = setterAudit.calls;
    mutation.reject(new Error("mutation failed"));
    await act(async () => {});
    expect(setterAudit.calls, "failure path must drive REAL useState setters (observer positive control)").toBeGreaterThan(settersBefore);
    const actionButton = label === "등록"
      ? buttonByLabel(panel.container, "웹훅 등록")
      : buttonByLabel(panel.container, "키 재발급") ?? buttonByLabel(panel.container, "비활성화");
    expect(actionButton, "mutation button should still exist after failure").toBeDefined();
    expect(actionButton!.disabled, "busy must settle after rejection").toBe(false);
    expect(text(panel.container)).toContain("웹훅 작업 실패");
    expect(text(panel.container)).toContain("mutation failed");
    await panel.unmount();
  });

  it("success after a failure recovers the controls (positive control)", async () => {
    const io = deferredFetch();
    const panel = await mountPanel("wf-1");
    io.calls.filter((c) => c.url.includes("/webhook")).at(-1)!.resolve(jsonResponse(UNCONFIGURED));
    await act(async () => {});
    await click(panel.container, "웹훅 등록");
    io.calls.filter((c) => c.init?.method === "POST").at(-1)!.reject(new Error("first attempt failed"));
    await act(async () => {});
    await click(panel.container, "웹훅 등록");
    io.calls.filter((c) => c.init?.method === "POST").at(-1)!.resolve(jsonResponse({ secret: "s3cr3t", last4: "3t3t", enabled: true }));
    await act(async () => {});
    io.calls.filter((c) => c.url.includes("/webhook") && c.init?.method === undefined).at(-1)!.resolve(jsonResponse(ENABLED));
    await act(async () => {});
    expect(text(panel.container)).toContain("서명 비밀키");
    expect(buttonByLabel(panel.container, "웹훅 등록")).toBeNull();
    expect(buttonByLabel(panel.container, "키 재발급")).toBeDefined();
    await panel.unmount();
  });
});

describe("Finding 2 — stale POST/DELETE completions: zero real setters, zero follow-up GET (8 cases)", () => {
  it.each([
    ["POST", "success", "unmount"], ["POST", "success", "identity"],
    ["POST", "failure", "unmount"], ["POST", "failure", "identity"],
    ["DELETE", "success", "unmount"], ["DELETE", "success", "identity"],
    ["DELETE", "failure", "unmount"], ["DELETE", "failure", "identity"],
  ] as const)("%s %s after %s: no setter calls, no late GET, DOM untouched", async (method, outcome, boundary) => {
    const io = deferredFetch();
    const panel = await mountPanel("wf-1");
    io.calls.filter((c) => c.url.includes("/webhook")).at(-1)!.resolve(jsonResponse(ENABLED));
    await act(async () => {});
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await click(panel.container, method === "POST" ? "키 재발급" : "비활성화");
    const stale = io.calls.filter((c) => c.init?.method === method).at(-1)!;
    expect(stale, `pending ${method} must exist`).toBeDefined();
    if (boundary === "unmount") {
      await panel.unmount();
    } else {
      await panel.switchTo("wf-2");
      io.calls.filter((c) => c.url.includes("/webhook") && c.url.includes("wf-2")).at(-1)!.resolve(jsonResponse(ENABLED));
      await act(async () => {});
      expect(text(panel.container)).toContain("ab12");
      // B(새 신원)의 자체 뮤테이션을 pending 으로 유지한다 — 구 수명의 finally 가 B의 busy 를
      // 풀어버리거나 상태를 건드리면 아래 setter/DOM 스냅샷 비교가 잡아낸다.
      await click(panel.container, "키 재발급");
      const busyButton = buttonByLabel(panel.container, "키 재발급");
      expect(busyButton!.disabled, "new identity mutation must be held pending before the stale settle").toBe(true);
    }
    const settersBefore = setterAudit.calls;
    const requestsBefore = io.calls.length;
    const html = panel.container.innerHTML;
    await act(async () => {
      if (outcome === "success") {
        stale.resolve(jsonResponse(method === "POST"
          ? { secret: "STALE-secret", last4: "old4", enabled: true }
          : { enabled: false, last4: "old4", deliveriesLast24h: 0 }));
      } else {
        stale.reject(new Error("STALE-action-error"));
      }
    });
    expect(setterAudit.calls, "stale completion must run zero state setters").toBe(settersBefore);
    expect(io.calls.length, "stale completion must not launch a follow-up GET").toBe(requestsBefore);
    expect(panel.container.innerHTML, "stale completion must not change the rendered DOM").toBe(html);
    expect(text(panel.container)).not.toContain("STALE-secret");
    expect(text(panel.container)).not.toContain("STALE-action-error");
    if (boundary !== "unmount") await panel.unmount();
  });
});
