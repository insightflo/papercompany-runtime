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
function labelled<T extends HTMLElement>(label: string): T {
  const labelElement = Array.from(host.querySelectorAll("label")).find((element) => element.textContent === label);
  expect(labelElement, `label ${label}`).toBeDefined();
  const element = host.querySelector<T>(`#${labelElement!.htmlFor}`);
  expect(element, `control for ${label}`).not.toBeNull();
  return element!;
}
async function choose(label: string, value: string) {
  const element = labelled<HTMLSelectElement>(label);
  expect(Array.from(element.options).map((option) => option.value), `option ${value} in ${label}`).toContain(value);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}
function optionTexts(label: string): string[] {
  return Array.from(labelled<HTMLSelectElement>(label).options).map((option) => option.textContent ?? "");
}
function chips(label: string): string[] {
  return Array.from(host.querySelectorAll(`ul[aria-label="${label} 허용 목록"] > li`)).map((li) => li.textContent ?? "");
}

const COMPANY_A = "aaaaaaaa-0000-4000-8000-000000000001";
const COMPANY_B = "bbbbbbbb-0000-4000-8000-000000000002";
const AGENT_ACTIVE = "cccccccc-0000-4000-8000-000000000003";
const AGENT_TERMINATED = "dddddddd-0000-4000-8000-000000000004";
const AGENT_B = "eeeeeeee-0000-4000-8000-000000000005";
const MISSION_A = "ffffffff-0000-4000-8000-000000000006";
const MISSION_OLD = "99999999-0000-4000-8000-000000000007";
const UNKNOWN = "12345678-0000-4000-8000-000000000008";

const companies = [
  { id: COMPANY_A, name: "알파 회사", status: "active" },
  { id: COMPANY_B, name: "베타 회사", status: "active" },
];
const agentsByCompany: Record<string, unknown[]> = {
  [COMPANY_A]: [
    { id: AGENT_ACTIVE, companyId: COMPANY_A, name: "리서처", status: "active" },
    { id: AGENT_TERMINATED, companyId: COMPANY_A, name: "퇴사자", status: "terminated" },
  ],
  [COMPANY_B]: [{ id: AGENT_B, companyId: COMPANY_B, name: "작가", status: "idle" }],
};
const missionsByCompany: Record<string, unknown[]> = {
  [COMPANY_A]: [{ id: MISSION_A, companyId: COMPANY_A, title: "주간 리포트", status: "completed" }],
  [COMPANY_B]: [],
};
// Missions outside the recent picker window still resolve through GET /missions/:id.
const missionDetails: Record<string, unknown> = {
  [MISSION_A]: missionsByCompany[COMPANY_A]![0],
  [MISSION_OLD]: { id: MISSION_OLD, companyId: COMPANY_B, title: "오래된 미션", status: "completed" },
};
let requested: string[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  saved = settingsFixture();
  patches = [];
  failSave = false;
  requested = [];
  // Only the HTTP boundary is replaced; hooks, API serialization and UI remain real.
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requested.push(url);
    if (url === "/api/instance/settings/experimental") {
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push(patch);
        if (failSave) return json({ error: "허용 목록 저장 실패" }, 422);
        saved = { ...saved, ...patch };
      }
      return json(saved);
    }
    expect(init?.method ?? "GET").toBe("GET");
    if (url === "/api/companies") return json(companies);
    const agents = url.match(/^\/api\/companies\/([^/]+)\/agents$/);
    if (agents) return json(agentsByCompany[agents[1]!] ?? []);
    const missions = url.match(/^\/api\/companies\/([^/?]+)\/missions\?(.*)$/);
    if (missions) {
      const params = new URLSearchParams(missions[2]);
      expect(params.get("sortBy")).toBe("updatedAt");
      expect(params.get("sortOrder")).toBe("desc");
      expect(params.get("limit")).toBe("100");
      return json(missionsByCompany[missions[1]!] ?? []);
    }
    const mission = url.match(/^\/api\/missions\/([^/]+)$/);
    if (mission) {
      const detail = missionDetails[mission[1]!];
      return detail ? json(detail) : json({ error: "Mission not found" }, 404);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear();
  host?.remove();
  vi.unstubAllGlobals();
});

const scopes = ["회사", "미션", "에이전트"] as const;

describe("broad-search allowlist editing through the real settings page", () => {
  it("shows default-deny empty lists without saving automatically", async () => {
    await mount();
    expect(host.textContent).toContain("광역 탐색 허용 (실험)");
    expect(host.textContent).toContain("기본적으로 허용하지 않습니다");
    expect(host.textContent).toContain("PLAN");
    expect(host.textContent).toContain("PLAN-QA");
    expect(host.textContent).toContain("복구");
    for (const label of scopes) {
      expect(host.querySelector(`ul[aria-label="${label} 허용 목록"]`)?.children.length).toBe(0);
    }
    expect(button("광역 탐색 허용 목록 저장").disabled).toBe(true);
    expect(patches).toEqual([]);
  });

  it("picks company, agent and mission by name and saves their IDs", async () => {
    await mount();
    expect(optionTexts("회사 선택")).toEqual(expect.arrayContaining(["알파 회사", "베타 회사"]));
    expect(button("회사 추가").disabled).toBe(true);
    await choose("회사 선택", COMPANY_A);
    await click("회사 추가");
    // Already-added companies are not offered again, so duplicates cannot be created.
    expect(Array.from(labelled<HTMLSelectElement>("회사 선택").options).map((o) => o.value)).not.toContain(COMPANY_A);

    expect(button("에이전트 추가").disabled).toBe(true);
    await choose("에이전트 소속 회사", COMPANY_A);
    expect(optionTexts("에이전트 선택")).toContain("리서처");
    expect(optionTexts("에이전트 선택")).not.toContain("퇴사자");
    await choose("에이전트 선택", AGENT_ACTIVE);
    await click("에이전트 추가");

    await choose("미션 소속 회사", COMPANY_A);
    expect(optionTexts("미션 선택")).toContain("주간 리포트");
    await choose("미션 선택", MISSION_A);
    await click("미션 추가");

    expect(chips("회사")[0]).toContain("알파 회사");
    expect(chips("회사")[0]).toContain("aaaaaaaa");
    expect(chips("에이전트")[0]).toContain("리서처 (알파 회사)");
    expect(chips("미션")[0]).toContain("주간 리포트 (알파 회사)");
    expect(patches).toEqual([]);
    await click("광역 탐색 허용 목록 저장");
    expect(patches).toEqual([{
      broadSearchAllowedCompanyIdsV1: [COMPANY_A],
      broadSearchAllowedMissionIdsV1: [MISSION_A],
      broadSearchAllowedAgentIdsV1: [AGENT_ACTIVE],
    }]);
  });

  it("shows names for saved IDs, marks unresolved IDs and removes entries", async () => {
    saved.broadSearchAllowedCompanyIdsV1 = [COMPANY_B, UNKNOWN];
    saved.broadSearchAllowedAgentIdsV1 = [AGENT_B, UNKNOWN];
    saved.broadSearchAllowedMissionIdsV1 = [MISSION_OLD, UNKNOWN];
    await mount();
    expect(chips("회사")[0]).toContain("베타 회사");
    expect(chips("에이전트")[0]).toContain("작가 (베타 회사)");
    expect(chips("미션")[0]).toContain("오래된 미션 (베타 회사)");
    for (const label of scopes) {
      expect(chips(label)[1]).toContain(`알 수 없음 (${UNKNOWN})`);
    }
    await click(`에이전트 ${UNKNOWN} 제거`);
    await click(`회사 ${COMPANY_B} 제거`);
    await click("광역 탐색 허용 목록 저장");
    expect(patches).toEqual([{
      broadSearchAllowedCompanyIdsV1: [UNKNOWN],
      broadSearchAllowedMissionIdsV1: [MISSION_OLD, UNKNOWN],
      broadSearchAllowedAgentIdsV1: [AGENT_B],
    }]);
  });

  it("surfaces the server error and preserves the draft for a successful retry", async () => {
    await mount();
    await choose("미션 소속 회사", COMPANY_A);
    await choose("미션 선택", MISSION_A);
    await click("미션 추가");
    failSave = true;
    await click("광역 탐색 허용 목록 저장");
    expect(host.textContent).toContain("허용 목록 저장 실패");
    expect(button(`미션 ${MISSION_A} 제거`)).toBeDefined();
    failSave = false;
    await click("광역 탐색 허용 목록 저장");
    expect(host.textContent).not.toContain("허용 목록 저장 실패");
    expect(patches[1]?.broadSearchAllowedMissionIdsV1).toEqual([MISSION_A]);
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
