/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbProvider } from "../context/BreadcrumbContext";
import { InstanceExperimentalSettings } from "./InstanceExperimentalSettings";

type SettingsFixture = ReturnType<typeof settingsFixture>;
function settingsFixture() {
  return {
    enableIsolatedWorkspaces: false,
    autoRestartDevServerWhenIdle: false,
    enableHeartbeatFinalizationV1: false,
    enableRunTerminalBoundaryV1: false,
    enableRunReopenGuardV1: false,
    enableRunRecoveryServiceV1: false,
    enableWorkProductBindingV1: false,
    enableKnowledgePatternInjection: true,
    enableQaRebindRecoveryV1: false,
    enableQaRebindRecoveryCompanyIdsV1: [],
    broadSearchAllowedCompanyIdsV1: [] as string[],
    broadSearchAllowedMissionIdsV1: [] as string[],
    broadSearchAllowedAgentIdsV1: [] as string[],
  };
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let saved: SettingsFixture;
let patches: Record<string, unknown>[];
let failSave: boolean;

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <BreadcrumbProvider><InstanceExperimentalSettings /></BreadcrumbProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
}
function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent) === label,
  );
  expect(found, `accessible button ${label}`).toBeDefined();
  return found!;
}
async function click(label: string) {
  await act(async () => { button(label).click(); });
  await flush();
}
async function input(label: string, value: string) {
  const labelElement = Array.from(host.querySelectorAll("label")).find((element) => element.textContent === label);
  expect(labelElement, `input label ${label}`).toBeDefined();
  const element = host.querySelector<HTMLInputElement>(`#${labelElement!.htmlFor}`);
  expect(element).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  saved = settingsFixture();
  patches = [];
  failSave = false;
  // Only the HTTP boundary is replaced; hooks, API serialization and UI remain real.
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    expect(url).toBe("/api/instance/settings/experimental");
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push(patch);
      if (failSave) return new Response(JSON.stringify({ error: "허용 목록 저장 실패" }), { status: 422 });
      saved = { ...saved, ...patch };
    }
    return new Response(JSON.stringify(saved), { status: 200 });
  });
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear();
  host?.remove();
  vi.unstubAllGlobals();
});

const scopes = [
  { label: "회사", field: "broadSearchAllowedCompanyIdsV1" },
  { label: "미션", field: "broadSearchAllowedMissionIdsV1" },
  { label: "에이전트", field: "broadSearchAllowedAgentIdsV1" },
] as const;

describe("broad-search allowlist editing through the real settings page", () => {
  it("shows default-deny empty lists without saving automatically", async () => {
    await mount();
    expect(host.textContent).toContain("광역 탐색 허용 (실험)");
    expect(host.textContent).toContain("기본적으로 허용하지 않습니다");
    expect(host.textContent).toContain("PLAN");
    expect(host.textContent).toContain("PLAN-QA");
    expect(host.textContent).toContain("복구");
    for (const { label } of scopes) {
      expect(host.querySelector(`ul[aria-label="${label} 허용 목록"]`)?.children.length).toBe(0);
    }
    expect(patches).toEqual([]);
  });

  it.each(scopes)("trims, deduplicates, removes and saves $label IDs without changing other settings", async ({ label, field }) => {
    saved[field] = ["existing-id"];
    await mount();
    expect(button(`${label} existing-id 제거`)).toBeDefined();
    await input(`${label} ID`, "  added-id  ");
    await click(`${label} ID 추가`);
    expect(button(`${label} added-id 제거`)).toBeDefined();
    await input(`${label} ID`, "added-id");
    await click(`${label} ID 추가`);
    await input(`${label} ID`, "   ");
    expect(button(`${label} ID 추가`).disabled).toBe(true);
    expect(host.querySelector(`ul[aria-label="${label} 허용 목록"]`)?.children.length).toBe(2);
    await click(`${label} existing-id 제거`);
    expect(host.querySelector(`ul[aria-label="${label} 허용 목록"]`)?.children.length).toBe(1);
    expect(patches).toEqual([]);
    await click("광역 탐색 허용 목록 저장");
    expect(patches).toEqual([{
      broadSearchAllowedCompanyIdsV1: field === "broadSearchAllowedCompanyIdsV1" ? ["added-id"] : [],
      broadSearchAllowedMissionIdsV1: field === "broadSearchAllowedMissionIdsV1" ? ["added-id"] : [],
      broadSearchAllowedAgentIdsV1: field === "broadSearchAllowedAgentIdsV1" ? ["added-id"] : [],
    }]);
    expect(button(`${label} added-id 제거`)).toBeDefined();
    await click(`${label} added-id 제거`);
    await click("광역 탐색 허용 목록 저장");
    expect(patches[1]?.[field]).toEqual([]);
  });

  it("surfaces the server error and preserves the draft for a successful retry", async () => {
    await mount();
    await input("미션 ID", "mission-retry");
    await click("미션 ID 추가");
    failSave = true;
    await click("광역 탐색 허용 목록 저장");
    expect(host.textContent).toContain("허용 목록 저장 실패");
    expect(button("미션 mission-retry 제거")).toBeDefined();
    failSave = false;
    await click("광역 탐색 허용 목록 저장");
    expect(host.textContent).not.toContain("허용 목록 저장 실패");
    expect(patches[1]?.broadSearchAllowedMissionIdsV1).toEqual(["mission-retry"]);
  });
});

const toggles = [
  ["Toggle isolated workspaces experimental setting", "enableIsolatedWorkspaces", true],
  ["Toggle guarded dev-server auto-restart", "autoRestartDevServerWhenIdle", true],
  ["Toggle heartbeat finalization v1 shadow writes", "enableHeartbeatFinalizationV1", true],
  ["Toggle run terminal boundary v1", "enableRunTerminalBoundaryV1", true],
  ["Toggle run reopen guard v1", "enableRunReopenGuardV1", true],
  ["Toggle run recovery service v1", "enableRunRecoveryServiceV1", true],
  ["Toggle work-product binding v1", "enableWorkProductBindingV1", true],
  ["Toggle knowledge pattern injection", "enableKnowledgePatternInjection", false],
  ["Toggle QA rebind recovery v1", "enableQaRebindRecoveryV1", true],
] as const;

it.each(toggles)("preserves existing toggle mutation: %s", async (label, field, value) => {
  await mount();
  await click(label);
  expect(patches).toEqual([{ [field]: value }]);
});
