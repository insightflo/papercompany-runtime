import type { Page } from "@playwright/test";

/**
 * [목적] Task 6D 브라우저 수용 테스트 전용 픽스처. 로컬 Vite(5279)가 서빙하는 실제 UI를
 * 대상으로 하며, 모든 /api HTTP·WebSocket을 내비게이션 전에 가로채 백엔드로 아무것도
 * 보내지 않는다. 미등록 요청은 abort + 예외로 실패 처리한다(픽스처 결함을 숨기지 않음).
 * [care] 이 픽스처의 응답은 서버 동작의 증거가 아니다. 서버 경계 증명은 Task 6A/6B
 * 통합 테스트가 담당한다. 프로덕션·실제 정의로 이동하거나 수정하지 않는다.
 */

export const companyId = "00000000-0000-4000-8000-000000000001";
export const workflowId = "00000000-0000-4000-8000-000000000002";
export const runId = "00000000-0000-4000-8000-000000000003";

/** 로컬 구조 타입. 앱 패키지를 import 하지 않아 테스트 그래프 의존성을 고정하지 않는다. */
export type RunInputOption = { value: string; label: string };

export type RunInputDeclaration = {
  key: string;
  label?: string;
  required?: boolean;
  placeholder?: string;
  type?: "text" | "radio" | "checkbox" | "switch";
  options?: RunInputOption[];
  default?: string | string[] | boolean;
  deriveFrom?: { input: string; extract: "youtubeVideoId" };
};

export type FixtureWorkflow = {
  id: string;
  name: string;
  description: string;
  status: string;
  sourceKind: string;
  steps: unknown[];
  runInputs: RunInputDeclaration[];
};

export type RunResponderResult = { status: number; body: unknown };
export type RunResponder = (submission: Record<string, unknown>) => RunResponderResult | Promise<RunResponderResult>;

export type WorkflowFixture = {
  submissions: Record<string, unknown>[];
  browserDialogs: Array<{ type: string; message: string }>;
  sourceFetches: string[];
  state: {
    overviewRequests: number;
    workflows: FixtureWorkflow[];
    setRunResponder: (responder: RunResponder | null) => void;
    failNextOverviewRefresh: () => void;
  };
};

/** 기본 선언: radio 기본값, checkbox 기본값, 무기본 switch, text, deriveFrom text(max 5). */
export function buildDefaultRunInputs(): RunInputDeclaration[] {
  return [
    {
      key: "section", label: "콘텐츠 종류", type: "radio",
      options: [{ value: "manuals", label: "매뉴얼" }, { value: "concepts", label: "개념 설명" }],
      default: "manuals",
    },
    { key: "tags", label: "태그", type: "checkbox", required: false, options: [{ value: "a", label: "A" }], default: ["a"] },
    { key: "enabled", label: "활성화", type: "switch" },
    { key: "url", label: "영상 URL", placeholder: "https://youtu.be/dQw4w9WgXcQ" },
    { key: "videoId", label: "영상 ID", deriveFrom: { input: "url", extract: "youtubeVideoId" } },
  ];
}

export function buildDefaultWorkflow(): FixtureWorkflow {
  return {
    id: workflowId,
    name: "Input controls",
    description: "Local test only",
    status: "active",
    sourceKind: "workflow",
    steps: [],
    runInputs: buildDefaultRunInputs(),
  };
}

function buildCompany(): Record<string, unknown> {
  return {
    id: companyId, name: "Run Input Test", issuePrefix: "WRI", status: "active",
    description: null, pauseReason: null, pausedAt: null, issueCounter: 0,
    budgetMonthlyCents: 0, spentMonthlyCents: 0, requireBoardApprovalForNewAgents: false,
    brandColor: null, logoAssetId: null, logoUrl: null, timezone: "Asia/Seoul",
    workProductRoot: null, defaultLanguage: "ko",
    createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z",
  };
}

function buildOverview(workflows: FixtureWorkflow[]): Record<string, unknown> {
  return { projects: [], labels: [], activeRuns: [], recentRuns: [], workflows };
}

export async function installWorkflowFixture(page: Page): Promise<WorkflowFixture> {
  const submissions: Record<string, unknown>[] = [];
  const browserDialogs: Array<{ type: string; message: string }> = [];
  const sourceFetches: string[] = [];
  const workflows: FixtureWorkflow[] = [buildDefaultWorkflow()];
  const state = {
    overviewRequests: 0,
    workflows,
    runResponder: null as RunResponder | null,
    failOverview: false,
    setRunResponder: (responder: RunResponder | null) => { state.runResponder = responder; },
    failNextOverviewRefresh: () => { state.failOverview = true; },
  };

  const company = buildCompany();
  const responses = new Map<string, unknown>([
    ["/api/health", { status: "ok", deploymentMode: "local_trusted", bootstrapStatus: "ready" }],
    ["/api/auth/get-session", null],
    ["/api/companies", [company]],
    [`/api/companies/${companyId}`, company],
    [`/api/companies/${companyId}/workflows/tools`, { tools: [], grants: [], sources: { core: { available: true } } }],
    [`/api/companies/${companyId}/labels`, []],
    [`/api/companies/${companyId}/projects`, []],
    [`/api/companies/${companyId}/agents`, []],
    [`/api/companies/${companyId}/live-runs`, []],
    [`/api/companies/${companyId}/missions/human-operator-requests`, []],
    [`/api/companies/${companyId}/operator-decisions`, { data: [], page: { nextCursor: null } }],
    [`/api/companies/${companyId}/sidebar-badges`, { inbox: 0, approvals: 0, failedRuns: 0, joinRequests: 0 }],
    // 레이아웃 부수 호출(ui/src/api/plugins.ts listUiContributions) — 읽기 전용 빈 목록.
    ["/api/plugins/ui-contributions", []],
    // 레이아웃 부수 호출(ui/src/api/approvals.ts list, ?status=pending 포함) — 빈 목록.
    [`/api/companies/${companyId}/approvals`, []],
    // useInboxBadge(ui/src/hooks/useInboxBadge.ts) 부수 호출 — 읽기 전용 빈 값/요약.
    [`/api/companies/${companyId}/join-requests`, []],
    [`/api/companies/${companyId}/dashboard`, { agents: { error: 0 }, costs: { monthBudgetCents: 0, monthUtilizationPercent: 0 } }],
    [`/api/companies/${companyId}/issues`, []],
    [`/api/companies/${companyId}/heartbeat-runs/attention`, { summary: { failed: 0, timedOut: 0, cancelled: 0, agents: 0 }, items: [], nextCursor: null }],
    // 레이아웃 사이드 Hermes 패널(ui/src/components/HermesChatPanel.tsx) 부수 호출 — 빈 세션/미구성 상태.
    [`/api/companies/${companyId}/hermes-chat/sessions`, []],
    [`/api/companies/${companyId}/hermes-chat/operations-agent`, { configured: false, agent: null, environment: { adapterType: "claude_local", status: "pass", checks: [], testedAt: "2026-09-08T00:00:00Z" } }],
  ]);
  const overviewPath = `/api/companies/${companyId}/workflows/overview`;
  const runPath = `/api/workflows/${workflowId}/runs`;

  // 브라우저 window.prompt/confirm/alert 는 실패다. 기록하고 닫아 런이 멈추지 않게 한다.
  // 기록만으로는 실패가 아니므로, 시행은 dialog-helpers 의 workflowFixture teardown 이
  // 모든 테스트에 대해 전역으로 수행하고 기록을 첨부 증거로 남긴다.
  page.on("dialog", (dialog) => {
    browserDialogs.push({ type: dialog.type(), message: dialog.message() });
    void dialog.dismiss();
  });
  // 소스 fetch 검증: 설정된 Vite 원본이 200으로 서빙한 /src 모듈 응답만 증거로 수집한다.
  // 요청 경로만 기록하면 실패·비원본 응답도 증거처럼 보이므로 성공 응답만 담는다.
  const viteOrigin = "http://127.0.0.1:5279";
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === viteOrigin && url.pathname.startsWith("/src/") && response.status() === 200) {
      sourceFetches.push(url.pathname);
    }
  });

  // [주의] "/**/api/**" 글롭은 Vite 소스 모듈(/src/api/auth.ts 등)까지 가로챈다.
  // 실제 앱 API 경로(/api/ 로 시작)만 정확히 걸러야 소스 fetch가 서버에 닿는다.
  await page.route(`${viteOrigin}/api/**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === runPath) {
      const submission = request.postDataJSON() as Record<string, unknown>;
      submissions.push(submission);
      const responder = state.runResponder;
      if (responder) {
        const result = await responder(submission);
        await route.fulfill({ status: result.status, json: result.body });
        return;
      }
      await route.fulfill({ status: 201, json: { runId, workflowId, status: "running" } });
      return;
    }
    if (request.method() === "GET") {
      if (pathname === overviewPath) {
        state.overviewRequests += 1;
        if (state.failOverview) {
          state.failOverview = false;
          await route.fulfill({ status: 500, json: { error: "overview refresh failed (fixture)" } });
          return;
        }
        await route.fulfill({ json: buildOverview(workflows) });
        return;
      }
      if (responses.has(pathname)) {
        await route.fulfill({ json: responses.get(pathname) });
        return;
      }
    }
    await route.abort();
    throw new Error(`Unexpected fixture API request: ${request.method()} ${pathname}`);
  });
  await page.routeWebSocket("**/api/**", (ws) => { ws.close(); });
  await page.addInitScript((id) => { localStorage.setItem("paperclip.selectedCompanyId", id); }, companyId);

  return { submissions, browserDialogs, sourceFetches, state };
}
