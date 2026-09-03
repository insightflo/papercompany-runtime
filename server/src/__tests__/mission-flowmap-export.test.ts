// [파일 목적] 미션 실행흐름 flowmap 내보내기(안 A — repo-flowmap 흡수) 검증.
//   순수 빌더/렌더러/validator 단위 테스트 + 라우트(임베디드 PG) 테스트.
// [고정 계약] flowmap.json 규격(repo-flowmap SCHEMA.md) — 고정 렌더러 template.html 에
//   /* FLOWMAP_JSON */ 1회 인라인, "<" 는 \u003c 로 escape. 렌더러 자체는 수정하지 않는다.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, missions, workflowDefinitions, workflowRuns, type Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { missionRoutes } from "../routes/missions.js";
import { validateFlowmap } from "../services/missions/flowmap-validator.js";
import {
  buildMissionRunFlowmap,
  renderFlowmapHtml,
  type MissionFlowmapRunInput,
} from "../services/missions/mission-flowmap-export.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping mission flowmap export route tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

// ---------------------------------------------------------------------------
// Unit: builder + validator + renderer (순수 함수, DB 없음)
// ---------------------------------------------------------------------------

function sampleStep(overrides: Partial<MissionFlowmapRunInput["steps"][number]> & { stepId: string }) {
  return {
    name: overrides.stepId,
    type: "agent",
    agentId: "",
    dependencies: [],
    conditionalDependencies: [],
    status: "pending",
    issue: null,
    toolNames: [],
    ...overrides,
  } as MissionFlowmapRunInput["steps"][number];
}

function sampleRun(): MissionFlowmapRunInput {
  return {
    id: "0b0f47a2-1111-2222-3333-444455556666",
    workflowName: "Mission Workflow",
    status: "running",
    progress: { totalSteps: 8, pendingSteps: 7, runningSteps: 1, completedSteps: 0, failedSteps: 0, skippedSteps: 0 },
    steps: [
      sampleStep({ stepId: "draft", name: "Draft", status: "running", dependencies: [] }),
      sampleStep({ stepId: "review", name: "Review", dependencies: ["draft"] }),
      sampleStep({ stepId: "gate", name: "Quality gate (IF)", dependencies: ["review"] }),
      sampleStep({ stepId: "onTrue", name: "Publish", conditionalDependencies: [{ stepId: "gate", when: "condition_true" }] }),
      sampleStep({ stepId: "onFalse", name: "Hold <for> review", conditionalDependencies: [{ stepId: "gate", when: "condition_false" }] }),
      sampleStep({ stepId: "onFail", name: "Escalate on failure", conditionalDependencies: [{ stepId: "gate", when: "failure" }] }),
      sampleStep({
        stepId: "fix",
        name: "Apply rework",
        dependencies: ["onTrue"],
        conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 3 }],
      }),
      sampleStep({ stepId: "qa", name: "QA check", dependencies: ["fix"] }),
    ],
  };
}

describe("mission flowmap export (pure builder/validator/renderer)", () => {
  it("builds a schema-valid flowmap with IF branch and rework loop edges", () => {
    const flowmap = buildMissionRunFlowmap(sampleRun(), { missionId: "mission-1" });

    // 레벨(의존 깊이) → 레이어. draft=L0, qa=L5.
    expect(flowmap.layers).toHaveLength(6);
    expect(flowmap.layers[0]).toMatchObject({ id: "l0", label: "Stage 1" });
    const layerOf = (stepId: string) =>
      flowmap.nodes.find((node) => node.file === stepId)?.layer;
    expect(layerOf("draft")).toBe("l0");
    expect(layerOf("qa")).toBe("l5");
    expect(flowmap.nodes).toHaveLength(8);

    // 하나의 run → 하나의 flow. edge 조건은 repo-flowmap "cond" 상태 + 12자 이하 라벨로.
    expect(flowmap.flows).toHaveLength(1);
    const flow = flowmap.flows[0];
    expect(flow.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(flow.title).toBe("Mission Workflow");
    expect(flow.summary).toContain("running");

    const idOf = (stepId: string) => flowmap.nodes.find((node) => node.file === stepId)!.id;
    const edge = (from: string, to: string) =>
      flow.steps.find((step) => step.from === idOf(from) && step.to === idOf(to));

    expect(edge("draft", "review")).toEqual({ from: "draft", to: "review" });
    expect(edge("gate", "onTrue")).toMatchObject({ state: "cond", stateLabel: "TRUE" });
    expect(edge("gate", "onFalse")).toMatchObject({ state: "cond", stateLabel: "FALSE" });
    expect(edge("gate", "onFail")).toMatchObject({ state: "cond", stateLabel: "ON FAIL" });
    // rework back-edge: qa --(request_changes)--> fix
    expect(edge("qa", "fix")).toMatchObject({ state: "cond", stateLabel: "REWORK×3" });

    // 빌더 출력은 repo-flowmap validator 를 통과해야 한다.
    expect(validateFlowmap(flowmap)).toEqual([]);
  });

  it("renders flowmap into the fixed template with the marker consumed and '<' escaped", () => {
    const flowmap = buildMissionRunFlowmap(sampleRun(), { missionId: "mission-1" });
    const template = "head\n/* FLOWMAP_JSON */\ntail";
    const html = renderFlowmapHtml(flowmap, template);

    expect(html).not.toContain("/* FLOWMAP_JSON */");
    expect(html).toContain("Mission Workflow");
    expect(html).toContain("Draft");
    // node name "Hold <for> review" → JSON 인라인 시 < 는 \u003c 로 escape 되어야 한다(원 계약: '<' 만 escape).
    expect(html).toContain("Hold \\u003cfor> review");
  });

  it("rejects templates without exactly one marker", () => {
    const flowmap = buildMissionRunFlowmap(sampleRun(), { missionId: "mission-1" });
    expect(() => renderFlowmapHtml(flowmap, "no marker here")).toThrow(/FLOWMAP_JSON/);
    expect(() => renderFlowmapHtml(flowmap, "a /* FLOWMAP_JSON */ b /* FLOWMAP_JSON */ c")).toThrow(/FLOWMAP_JSON/);
  });
});

describe("flowmap validator (TS port of repo-flowmap validate_flowmap.mjs)", () => {
  const valid = () => buildMissionRunFlowmap(sampleRun(), { missionId: "mission-1" });

  it("accepts a valid document", () => {
    expect(validateFlowmap(valid())).toEqual([]);
  });

  it("rejects unknown node layer references", () => {
    const doc = valid() as unknown as { nodes: Array<{ layer: string }> };
    doc.nodes[0].layer = "nope";
    expect(validateFlowmap(doc).some((message) => message.includes("존재하지 않는"))).toBe(true);
  });

  it("rejects stateLabel over 12 chars and stateLabel without state", () => {
    const doc = valid() as unknown as { flows: Array<{ steps: Array<Record<string, unknown>> }> };
    doc.flows[0].steps[0] = { ...doc.flows[0].steps[0], state: "cond", stateLabel: "TOO_LONG_LABEL" };
    doc.flows[0].steps[1] = { ...doc.flows[0].steps[1], stateLabel: "LONE" };
    const errors = validateFlowmap(doc);
    expect(errors.some((message) => message.includes("12자"))).toBe(true);
    expect(errors.some((message) => message.includes("state 없이"))).toBe(true);
  });

  it("rejects non-slug flow ids", () => {
    const doc = valid() as unknown as { flows: Array<{ id: string }> };
    doc.flows[0].id = "bad id!";
    expect(validateFlowmap(doc).some((message) => message.includes("영숫자"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route: GET /missions/:id/workflow-runs/:runId/flowmap
// ---------------------------------------------------------------------------

type Actor =
  | { type: "board"; source: "session"; userId: string; companyIds: string[]; isInstanceAdmin?: boolean }
  | { type: "board"; source: "local_implicit"; userId: string };

function createApp(db: Db, actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", missionRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("mission workflow run flowmap export route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let otherCompanyId: string;
  let missionId: string;
  let runId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-flowmap-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    otherCompanyId = randomUUID();
    missionId = randomUUID();
    runId = randomUUID();
    const ownerAgentId = randomUUID();
    const workflowId = randomUUID();

    await db.insert(companies).values([
      { id: companyId, name: "Flowmap Co", status: "active", issuePrefix: "FM1" },
      { id: otherCompanyId, name: "Other Co", status: "active", issuePrefix: "FM2" },
    ]);
    await db.insert(agents).values({
      id: ownerAgentId, companyId, name: "Mission Owner", role: "owner",
      status: "active", adapterType: "claude_local", adapterConfig: {},
      runtimeConfig: {}, permissions: {},
    });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Flowmap mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "if-branch-pipeline",
      stepsJson: [
        { id: "draft", name: "Draft", agentId: ownerAgentId, dependencies: [] },
        { id: "gate", name: "Quality gate", agentId: ownerAgentId, dependencies: ["draft"] },
        { id: "onTrue", name: "Publish", agentId: ownerAgentId, dependencies: [], conditionalDependencies: [{ stepId: "gate", when: "condition_true" }] },
        { id: "fix", name: "Apply rework", agentId: ownerAgentId, dependencies: ["onTrue"], conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }] },
        { id: "qa", name: "QA check", agentId: ownerAgentId, dependencies: ["fix"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId, workflowId, companyId, missionId, triggeredBy: "system", status: "running",
      startedAt: new Date("2026-09-04T07:00:00.000Z"),
    });
  }, 60_000);

  afterEach(async () => {
    // 이 테스트군은 읽기 전용(GET) — seed 는 beforeAll 1회만 수행한다.
  });

  afterAll(async () => {
    await db.delete(workflowRuns);
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("exports an interactive single-file flowmap HTML for a run", async () => {
    const app = createApp(db, { type: "board", source: "local_implicit", userId: "board-user" });

    const res = await request(app).get(`/api/missions/${missionId}/workflow-runs/${runId}/flowmap`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(String(res.headers["content-disposition"])).toContain("attachment");
    expect(res.text).not.toContain("/* FLOWMAP_JSON */");
    expect(res.text).toContain("Quality gate");
    expect(res.text).toContain("TRUE");
    expect(res.text).toContain("REWORK×2");
    // 고정 렌더러(template.html) 기반 — 흐름도 앱 셸이 포함되어야 한다.
    expect(res.text.toLowerCase()).toContain("<!doctype html>");
  });

  it("404s for an unknown run", async () => {
    const app = createApp(db, { type: "board", source: "local_implicit", userId: "board-user" });
    const res = await request(app).get(`/api/missions/${missionId}/workflow-runs/${randomUUID()}/flowmap`);
    expect(res.status).toBe(404);
  });

  it("403s for a board session without access to the mission company", async () => {
    const app = createApp(db, { type: "board", source: "session", userId: "other-user", companyIds: [otherCompanyId] });
    const res = await request(app).get(`/api/missions/${missionId}/workflow-runs/${runId}/flowmap`);
    expect(res.status).toBe(403);
  });
});
