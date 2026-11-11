import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalRoutes } from "../routes/approvals.js";
import { operatorDecisionRoutes } from "../routes/operator-decisions.js";
import { errorHandler } from "../middleware/index.js";

/**
 * [휴먼카드 초보자 해석본 — 조회 후킹/재해석 라우트 계약]
 * 표시 전용 계약 검증:
 * - 결정 대기(pending) 카드: 해석 행이 없으면 ensureSummary 가 발동되고(응답은 막히지 않음), 응답에 humanSummary 가 붙는다.
 * - 이미 done 인 해석: 재기동 없이 스냅숋만 첨부.
 * - 결정 완료(approved) 카드: ensure 가 호출되지 않는다(원 카드 플로우 무간섭).
 * - retranslate: board 권한만, 어댑터·모델 전달.
 */

const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({ listIssuesForApproval: vi.fn() }));
const mockSecretService = vi.hoisted(() => ({ normalizeHireApprovalPayloadForPersistence: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());

const mockCardSummaryService = vi.hoisted(() => ({
  getRow: vi.fn(),
  getRows: vi.fn(),
  ensureSummary: vi.fn(),
  retranslate: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

vi.mock("../services/card-summaries.js", () => ({
  cardSummaryService: () => mockCardSummaryService,
}));

const mockDecisionRead = vi.hoisted(() => ({
  list: vi.fn(),
  getRequired: vi.fn(),
}));
const mockDecisionWrite = vi.hoisted(() => ({ create: vi.fn(), resolve: vi.fn(), cancel: vi.fn(), retryContinuation: vi.fn() }));
const mockHeartbeatForDecisions = vi.hoisted(() => ({ wakeup: vi.fn() }));

vi.mock("../services/operator-decisions-read.js", () => ({ operatorDecisionReadService: () => mockDecisionRead }));
vi.mock("../services/operator-decisions-write.js", () => ({ operatorDecisionWriteService: () => mockDecisionWrite }));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => mockHeartbeatForDecisions }));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes({} as any));
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

const doneSummaryRow = {
  id: "sum-1",
  companyId: "company-1",
  cardKind: "approval",
  cardId: "approval-1",
  status: "done",
  adapterType: "pi_local",
  model: "some-model",
  // 신형(Stage 3) 고정 축소 3항목: symptom(≤2줄) / optionsLine(1줄) / interpretation(1문장)
  summaryJson: { symptom: ["대기 중 승인 카드 증상"], optionsLine: "승인(진행) / 거절(중단)", interpretation: "사람이 방향을 정해야 진행되기 때문에 확인이 필요합니다." },
  error: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("operator decision human summary display hook", () => {
  const decisionView = {
    id: "decision-1",
    companyId: "company-1",
    status: "pending",
    title: "런 부활 요청",
    description: "v3 카드 원문",
    interactionType: "choice",
    definition: { options: [] },
  };

  function decisionApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", operatorDecisionRoutes({} as any));
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockCardSummaryService.getRows.mockResolvedValue(new Map());
    mockCardSummaryService.ensureSummary.mockResolvedValue(null);
    mockCardSummaryService.retranslate.mockResolvedValue(null);
  });

  it("ensures a summary for a pending operator decision on board list and attaches snapshot", async () => {
    mockDecisionRead.list.mockResolvedValue({ data: [decisionView], page: { nextCursor: null } });
    const res = await request(decisionApp(boardActor)).get("/api/companies/company-1/operator-decisions?view=pending");
    expect(res.status).toBe(200);
    expect(res.body.data[0].humanSummary).toBeNull();
    expect(mockCardSummaryService.ensureSummary).toHaveBeenCalledTimes(1);
    const [companyId, cardKind, cardId, view] = mockCardSummaryService.ensureSummary.mock.calls[0];
    expect([companyId, cardKind, cardId]).toEqual(["company-1", "operator_decision", "decision-1"]);
    expect(view.title).toBe("런 부활 요청");
  });

  it("retranslate on operator decisions is board-only", async () => {
    mockDecisionRead.getRequired.mockResolvedValue(decisionView);
    const agentActor = { type: "agent", agentId: "agent-1", companyId: "company-1", runId: null };
    const denied = await request(decisionApp(agentActor)).post("/api/operator-decisions/decision-1/summary/retranslate").send({});
    expect(denied.status).toBe(403);

    mockCardSummaryService.retranslate.mockResolvedValue({
      id: "sum-2", companyId: "company-1", cardKind: "operator_decision", cardId: "decision-1",
      status: "pending", adapterType: "pi_local", model: "m2", summaryJson: null, error: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const ok = await request(decisionApp(boardActor)).post("/api/operator-decisions/decision-1/summary/retranslate").send({ model: "m2" });
    expect(ok.status).toBe(200);
    expect(mockCardSummaryService.retranslate).toHaveBeenCalledWith(
      "company-1", "operator_decision", "decision-1",
      expect.objectContaining({ model: "m2" }),
    );
  });
});

describe("approval human summary display hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCardSummaryService.getRows.mockResolvedValue(new Map());
    mockCardSummaryService.ensureSummary.mockResolvedValue(null);
    mockCardSummaryService.retranslate.mockResolvedValue(null);
  });

  it("ensures a summary for a decision-pending approval and attaches null snapshot without blocking", async () => {
    mockApprovalService.list.mockResolvedValue([
      { id: "approval-1", companyId: "company-1", type: "hire_agent", status: "pending", payload: { reason: "x" } },
    ]);
    const res = await request(createApp(boardActor)).get("/api/companies/company-1/approvals");
    expect(res.status).toBe(200);
    expect(res.body[0].humanSummary).toBeNull();
    expect(mockCardSummaryService.ensureSummary).toHaveBeenCalledTimes(1);
    const [companyId, cardKind, cardId] = mockCardSummaryService.ensureSummary.mock.calls[0];
    expect([companyId, cardKind, cardId]).toEqual(["company-1", "approval", "approval-1"]);
    // 해석 입력은 재편집된 payload만 담는다(원본 객체 아님 — 비밀 원본 미전달 계약).
    const view = mockCardSummaryService.ensureSummary.mock.calls[0][3];
    expect(view.kind).toBe("approval");
    expect(view.payload).toEqual({ reason: "x" });
  });

  it("attaches an existing done summary without re-kicking", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockCardSummaryService.getRows.mockResolvedValue(new Map([[
      "approval-1",
      doneSummaryRow,
    ]]));
    const res = await request(createApp(boardActor)).get("/api/approvals/approval-1");
    expect(res.status).toBe(200);
    expect(res.body.humanSummary.status).toBe("done");
    expect(res.body.humanSummary.summary.symptom).toEqual(["대기 중 승인 카드 증상"]);
    expect(res.body.humanSummary.summary.optionsLine).toBe("승인(진행) / 거절(중단)");
    expect(res.body.humanSummary.summary.interpretation).toContain("확인이 필요");
    expect(mockCardSummaryService.ensureSummary).not.toHaveBeenCalled();
  });

  it("attaches a legacy 5-section summary row unchanged (pre-Stage-3 DB rows)", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    // 기존 DB에 저장된 구 5섹션 행 — 읽기 경로는 재검증 없이 통과 전달해야 한다(빈 화면/파싱 실패 금지).
    const legacySummaryJson = {
      oneLine: "구 요약",
      whatHappening: "구 설명",
      decisionNeeded: "구 결정",
      options: [{ label: "승인", meaning: "진행됩니다" }],
      cautions: ["승인만으로 실행되지 않을 수 있습니다"],
    };
    mockCardSummaryService.getRows.mockResolvedValue(new Map([[
      "approval-1",
      { ...doneSummaryRow, summaryJson: legacySummaryJson },
    ]]));
    const res = await request(createApp(boardActor)).get("/api/approvals/approval-1");
    expect(res.status).toBe(200);
    expect(res.body.humanSummary.status).toBe("done");
    expect(res.body.humanSummary.summary).toEqual(legacySummaryJson);
    expect(mockCardSummaryService.ensureSummary).not.toHaveBeenCalled();
  });

  it("does not ensure summaries for decided approvals", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "approved",
      payload: {},
    });
    const res = await request(createApp(boardActor)).get("/api/approvals/approval-1");
    expect(res.status).toBe(200);
    expect(mockCardSummaryService.ensureSummary).not.toHaveBeenCalled();
    expect(res.body.humanSummary).toBeNull();
  });

  it("retranslate requires board actor and passes adapter/model through", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockCardSummaryService.retranslate.mockResolvedValue({
      ...doneSummaryRow,
      status: "pending",
      summaryJson: null,
      adapterType: "pi_local",
      model: "new-model",
    });

    const agentActor = { type: "agent", agentId: "agent-1", companyId: "company-1", runId: null };
    const denied = await request(createApp(agentActor))
      .post("/api/approvals/approval-1/summary/retranslate")
      .send({ model: "new-model" });
    expect(denied.status).toBe(403);

    const res = await request(createApp(boardActor))
      .post("/api/approvals/approval-1/summary/retranslate")
      .send({ adapterType: "pi_local", model: "new-model" });
    expect(res.status).toBe(200);
    expect(res.body.humanSummary.status).toBe("pending");
    expect(mockCardSummaryService.retranslate).toHaveBeenCalledWith(
      "company-1",
      "approval",
      "approval-1",
      expect.objectContaining({ adapterType: "pi_local", model: "new-model" }),
    );
  });
});
