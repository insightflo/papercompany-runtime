import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HumanOperatorRequest } from "../services/missions/human-operator-requests.js";
import { missionRoutes } from "../routes/missions.js";
import { errorHandler } from "../middleware/index.js";

/**
 * [휴먼카드 해석 — 미션 운영자 요청 카드] 조회 후킹/재해석 라우트 계약.
 * 승인 카드(approvals)·운영자 결정 카드(operator-decisions)와 같은 표시 전용 계약:
 * - 목록(열린 미션+열린 이슈 요청만 반환)의 전 행에 humanSummary 스냅숋을 붙이고,
 *   해석 행이 없거나 done 이 아니면 ensureSummary 가 비동기로 발동된다(응답은 막히지 않음).
 * - 이미 done 인 해석은 재기동 없이 스냅숋만 첨부.
 * - retranslate: board 권한만, 알 수 없는 requestId 는 404, 어댑터·모델 전달.
 */

const mockListRequests = vi.hoisted(() => vi.fn());
const mockCardSummaryService = vi.hoisted(() => ({
  getRow: vi.fn(),
  getRows: vi.fn(),
  ensureSummary: vi.fn(),
  retranslate: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn(), cancelRun: vi.fn() }));

vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => mockHeartbeatService }));
vi.mock("../services/missions.js", () => ({
  missionService: () => ({
    list: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
}));
vi.mock("../services/mission-delegations.js", () => ({ missionDelegationService: () => ({}) }));
vi.mock("../services/missions/human-operator-requests.js", () => ({
  listCompanyHumanOperatorRequests: mockListRequests,
}));
vi.mock("../services/card-summaries.js", () => ({ cardSummaryService: () => mockCardSummaryService }));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", missionRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

function makeRequest(id: string, overrides: Partial<HumanOperatorRequest> = {}): HumanOperatorRequest {
  return {
    id,
    companyId: "company-1",
    missionId: "mission-1",
    missionTitle: "미션 제목",
    missionStatus: "active",
    issueId: "issue-1",
    title: "Human/operator input requested",
    summary: "무엇이: 미션 진행이 막힘\n운영자 할 일: 방향을 선택",
    timestamp: "2026-11-01T00:00:00.000Z",
    count: 2,
    severity: "attention",
    event: {
      id: `owner_diagnosis:activity_log:${id}`,
      companyId: "company-1",
      scope: { missionId: "mission-1", issueId: "issue-1" },
      sourceRef: { type: "activity_log", id: id, table: "activity_log" },
      eventType: "owner_diagnosis",
      title: "Human/operator input requested",
      summary: "Direction is requested.",
      timestamp: "2026-11-01T00:00:00.000Z",
      severity: "attention",
      evidenceRefs: [{ type: "log", ref: id, label: "mission owner decision" }],
      suggestedResumeTarget: { action: "request_human_input", issueId: "issue-1" },
      rawAvailable: true,
    },
    ...overrides,
  };
}

const doneSummaryRow = {
  id: "sum-1",
  companyId: "company-1",
  cardKind: "owner_recovery",
  cardId: "mission-1:act-1",
  status: "done",
  adapterType: "pi_local",
  model: "some-model",
  // 신형(Stage 3) 고정 축소 3항목: symptom(≤2줄) / optionsLine(1줄) / interpretation(1문장)
  summaryJson: { symptom: ["미션이 사람 확인 대기 중"], optionsLine: "재개 / 중단 중 선택", interpretation: "사람이 진행 방향을 정해야 해서 확인이 필요합니다." },
  error: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("human operator request human summary display hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListRequests.mockResolvedValue([]);
    mockCardSummaryService.getRows.mockResolvedValue(new Map());
    mockCardSummaryService.ensureSummary.mockResolvedValue(null);
    mockCardSummaryService.retranslate.mockResolvedValue(null);
  });

  it("ensures owner_recovery summaries for listed open requests and attaches null snapshots without blocking", async () => {
    mockListRequests.mockResolvedValue([makeRequest("mission-1:act-1")]);
    const res = await request(createApp(boardActor)).get(
      "/api/companies/company-1/missions/human-operator-requests",
    );
    expect(res.status).toBe(200);
    expect(res.body[0].humanSummary).toBeNull();
    expect(mockCardSummaryService.ensureSummary).toHaveBeenCalledTimes(1);
    const [companyId, cardKind, cardId, view] = mockCardSummaryService.ensureSummary.mock.calls[0];
    expect([companyId, cardKind, cardId]).toEqual(["company-1", "owner_recovery", "mission-1:act-1"]);
    // 해석 입력은 운영자가 보는 요청 행의 표시 필드로만 구성된다(원본 이벤트 로그 미전달).
    expect(view.kind).toBe("owner_recovery");
    expect(view.title).toBe("Human/operator input requested");
    expect(view.bodyText).toContain("운영자 할 일: 방향을 선택");
    expect(view.payload).toEqual({
      missionTitle: "미션 제목",
      severity: "attention",
      issueId: "issue-1",
      count: 2,
    });
  });

  it("attaches an existing done summary without re-kicking", async () => {
    mockListRequests.mockResolvedValue([makeRequest("mission-1:act-1")]);
    mockCardSummaryService.getRows.mockResolvedValue(new Map([["mission-1:act-1", doneSummaryRow]]));
    const res = await request(createApp(boardActor)).get(
      "/api/companies/company-1/missions/human-operator-requests",
    );
    expect(res.status).toBe(200);
    expect(res.body[0].humanSummary.status).toBe("done");
    expect(res.body[0].humanSummary.summary.symptom).toEqual(["미션이 사람 확인 대기 중"]);
    expect(res.body[0].humanSummary.summary.optionsLine).toBe("재개 / 중단 중 선택");
    expect(res.body[0].humanSummary.summary.interpretation).toContain("확인이 필요");
    expect(mockCardSummaryService.ensureSummary).not.toHaveBeenCalled();
  });

  it("retranslate is board-only, 404s unknown request ids, and passes adapter/model with rebuilt view", async () => {
    const agentActor = { type: "agent", agentId: "agent-1", companyId: "company-1", runId: null };
    const denied = await request(createApp(agentActor))
      .post("/api/companies/company-1/missions/human-operator-requests/mission-1:act-1/summary/retranslate")
      .send({});
    expect(denied.status).toBe(403);

    mockListRequests.mockResolvedValue([makeRequest("mission-1:act-1")]);
    const missing = await request(createApp(boardActor))
      .post("/api/companies/company-1/missions/human-operator-requests/mission-1:unknown/summary/retranslate")
      .send({});
    expect(missing.status).toBe(404);

    mockCardSummaryService.retranslate.mockResolvedValue({
      ...doneSummaryRow,
      status: "pending",
      summaryJson: null,
      model: "m2",
    });
    const ok = await request(createApp(boardActor))
      .post("/api/companies/company-1/missions/human-operator-requests/mission-1:act-1/summary/retranslate")
      .send({ adapterType: "pi_local", model: "m2" });
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe("mission-1:act-1");
    expect(ok.body.humanSummary.status).toBe("pending");
    expect(mockCardSummaryService.retranslate).toHaveBeenCalledWith(
      "company-1",
      "owner_recovery",
      "mission-1:act-1",
      expect.objectContaining({
        adapterType: "pi_local",
        model: "m2",
        view: expect.objectContaining({ kind: "owner_recovery", bodyText: expect.any(String) }),
      }),
    );
  });
});
