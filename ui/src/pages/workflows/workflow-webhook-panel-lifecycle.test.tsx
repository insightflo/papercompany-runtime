// @vitest-environment jsdom
// [three-fixes + test-only-fast] Finding 3(오래된 클립보드 완료가 교체된 시크릿을 copied 로 표시)
// 실마운트 회귀 + 기존 unknown-status 게이팅 보존 통제. 검증자 지적 반영:
//  (1) 클립보드 목이 실제 resolve/reject 를 모두 노출 — 거절 경로가 실제로 실행된다,
//  (2) stale A 완료(성공/거절) × B 복사/미복사 4케이스 — setter 관찰자로 "setter 없음" 직접 관찰,
//  (3) 현재 세대 복사 성공/실거절 통제가 실제 setter 활동을 증명한다,
//  (4) unhandledRejection 리스너 동일 참조 on/off + 테스트마다 버퍼 리셋.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { WorkflowWebhookPanel } from "./workflow-webhook-panel.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// [setter observer] 패널이 import 한 useState 를 "실제 훅"으로 위임하되 모든 setter 호출을 센다.
// 컴포넌트/상태 로직은 재구현하지 않는다. 긍정 통제: 현재 세대 복사 성공/거절에서 delta > 0.
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
const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

function deferredFetch() {
  const calls: Array<{ url: string; init?: RequestInit; resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
  const fetchMock = vi.fn((url: string | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => { calls.push({ url: String(url), init, resolve, reject }); }));
  vi.stubGlobal("fetch", fetchMock);
  const last = (predicate: (c: { url: string; init?: RequestInit }) => boolean) => {
    const found = calls.filter((c) => predicate(c));
    expect(found.length, "expected webhook call missing").toBeGreaterThan(0);
    return found[found.length - 1]!;
  };
  const lastGet = () => last((c) => c.url.includes("/webhook") && c.init?.method === undefined);
  const lastPost = () => last((c) => c.init?.method === "POST");
  return { calls, lastGet, lastPost };
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
  };
}

async function click(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  expect(button, `button "${label}" not found`).toBeDefined();
  await act(async () => { button!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

const text = (container: HTMLElement) => container.textContent ?? "";

// 클립보드 목: 각 writeText 호출의 실제 resolve/reject 를 모두 보관한다 — 거절 경로를 실제로 실행.
type WriteCall = { secret: string; resolve: (v?: void | PromiseLike<void>) => void; reject: (e: unknown) => void };
function stubClipboard() {
  const writes: WriteCall[] = [];
  const writeText = vi.fn((secret: string) =>
    new Promise<void>((resolve, reject) => { writes.push({ secret, resolve, reject }); }));
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return {
    writes,
    resolveWrite: async (index: number) => { await act(async () => { writes[index]!.resolve(); }); },
    rejectWrite: async (index: number, err: Error) => { await act(async () => { writes[index]!.reject(err); }); },
    waitCalled: async () => { await vi.waitFor(() => expect(writeText).toHaveBeenCalled()); },
  };
}

async function mountRegisteredWithSecret(io: ReturnType<typeof deferredFetch>, secret: string, last4: string) {
  const clipboard = stubClipboard();
  const panel = await mountPanel("wf-1");
  io.lastGet().resolve(jsonResponse({ error: "not configured" }, 404));
  await act(async () => {});
  await click(panel.container, "웹훅 등록");
  io.lastPost().resolve(jsonResponse({ secret, last4, enabled: true }));
  await act(async () => {});
  io.lastGet().resolve(jsonResponse(ENABLED));
  await act(async () => {});
  expect(text(panel.container)).toContain(secret);
  return { clipboard, panel };
}

describe("Finding 3 — delayed clipboard completion must reference the CURRENT secret generation", () => {
  it.each([
    ["success", false], ["success", true], ["rejection", false], ["rejection", true],
  ] as const)("copy A pending, rotate to B, A real %s with B %s: no stale setters/error, B feedback preserved", async (outcome, bCopied) => {
    const io = deferredFetch();
    const { clipboard, panel } = await mountRegisteredWithSecret(io, "secret-A", "et-A");
    // A 복사 시작 → writeText(pending)
    await click(panel.container, "복사");
    await clipboard.waitCalled();
    expect(clipboard.writes[0]!.secret).toBe("secret-A");
    // 키 재발급 → secret B 표시 (세대 +1)
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await click(panel.container, "키 재발급");
    io.lastPost().resolve(jsonResponse({ secret: "secret-B", last4: "et-B", enabled: true }));
    await act(async () => {});
    io.lastGet().resolve(jsonResponse(ENABLED));
    await act(async () => {});
    expect(text(panel.container)).toContain("secret-B");
    if (bCopied) {
      await click(panel.container, "복사");
      await clipboard.resolveWrite(1);
      expect(text(panel.container)).toContain("복사됨");
    }
    const settersBefore = setterAudit.calls;
    const html = panel.container.innerHTML;
    if (outcome === "success") await clipboard.resolveWrite(0);
    else await clipboard.rejectWrite(0, new Error("STALE-copy-error"));
    expect(setterAudit.calls, "stale clipboard completion must run zero state setters").toBe(settersBefore);
    expect(panel.container.innerHTML, "stale clipboard completion must not change the DOM").toBe(html);
    expect(text(panel.container)).not.toContain("STALE-copy-error");
    expect(text(panel.container)).not.toContain("웹훅 작업 실패");
    if (bCopied) expect(text(panel.container), "B's own copy feedback must be preserved").toContain("복사됨");
    else expect(text(panel.container), "no copied label without B's own copy").not.toContain("복사됨");
    expect(text(panel.container)).toContain("secret-B");
    await panel.unmount();
  });

  it("normal current copy success shows feedback via real setters (positive control)", async () => {
    const io = deferredFetch();
    const { clipboard, panel } = await mountRegisteredWithSecret(io, "secret-A", "et-A");
    await click(panel.container, "복사");
    const settersBefore = setterAudit.calls;
    await clipboard.resolveWrite(0);
    expect(setterAudit.calls, "current copy success must drive REAL useState setters").toBeGreaterThan(settersBefore);
    expect(text(panel.container)).toContain("복사됨");
    await panel.unmount();
  });

  it("normal current copy real rejection clears feedback via real setters (control)", async () => {
    const io = deferredFetch();
    const { clipboard, panel } = await mountRegisteredWithSecret(io, "secret-A", "et-A");
    await click(panel.container, "복사");
    await clipboard.resolveWrite(0);
    expect(text(panel.container)).toContain("복사됨");
    await click(panel.container, "복사됨");
    const settersBefore = setterAudit.calls;
    await clipboard.rejectWrite(1, new Error("clipboard denied"));
    expect(setterAudit.calls, "current copy rejection must drive REAL useState setters").toBeGreaterThan(settersBefore);
    expect(text(panel.container), "failed current copy clears the copied label").not.toContain("복사됨");
    expect(text(panel.container)).not.toContain("clipboard denied");
    await panel.unmount();
  });
});

describe("existing unknown-status gating preserved (controls)", () => {
  it("loading hides mutation buttons; non-404 error hides them; 404 shows register", async () => {
    const io = deferredFetch();
    const panel = await mountPanel("wf-1");
    expect(text(panel.container)).toContain("웹훅 상태를 불러오는 중");
    expect([...panel.container.querySelectorAll("button")].find((b) => b.textContent?.includes("웹훅 등록"))).toBeUndefined();
    io.lastGet().resolve(jsonResponse({ error: "boom" }, 500));
    await act(async () => {});
    expect(text(panel.container)).toContain("웹훅 상태 로드 실패");
    expect([...panel.container.querySelectorAll("button")].find((b) => b.textContent?.includes("웹훅 등록"))).toBeUndefined();
    await panel.unmount();
    const io2 = deferredFetch();
    const panel2 = await mountPanel("wf-2");
    io2.lastGet().resolve(jsonResponse({ error: "not configured" }, 404));
    await act(async () => {});
    expect([...panel2.container.querySelectorAll("button")].find((b) => b.textContent?.includes("웹훅 등록"))).toBeDefined();
    await panel2.unmount();
  });
});
