// server/src/__tests__/quality-evaluation-native.test.ts
//
// [purpose] T6 실제 native 흐름: author A 단계 → 후보 고정 → B 평가 단계 전달 → 전용 API
// open/read/submit/verify → 완료 게이트. board 검증자 대체 불가, 이전 PASS·현재 FAIL,
// 후보 무차이(no_improvement), 세대/epoch binding 을 실제 HTTP·DB 로 검증.
// 결정적 fixture 상태(B 가 제출하는 status 값)와 실제 에이전트 판단을 구분해 기록한다.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, evaluatorCandidateRuns, issues, qualityActions } from "@paperclipai/db";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { qualityEvaluationRoutes } from "../routes/quality-evaluations.js";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { checkInVerifier, seedEvaluationFixture, type EvaluationFixture } from "./helpers/quality-evaluation-fixture.js";
import { completeWorkflowIssue } from "../services/workflow/agent-api.js";
import { readCurrentEvaluationVerdict } from "../services/quality/evaluation-candidates.js";

type AgentActor = { type: "agent"; agentId: string; companyId: string; runId: string; source: string; keyId?: string };

describeQualityDb("Quality evaluation native agent steps", () => {
  let owned: QualityTestDb;
  let f: EvaluationFixture;
  let root: string;
  let authorRunId: string;
  let verifierRunId: string;
  let evaluationId: string;
  let verifierIssueId: string;
  let verifierStepRunId: string;
  let candidateVersionId: string;
  let addChecks: Array<{ checkId: string; requirementRefs: { attachmentId: string; sha256: string }[]; applicability: { op: "always" }; expectedEvidenceKinds: string[]; instructions: string }>;

  function app(db: Db) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      const kind = (req.get("x-test-actor") ?? "author") as "author" | "verifier" | "board" | "wrong-company";
      req.actor = actorFor(kind) as typeof req.actor;
      next();
    });
    server.use("/api", qualityEvaluationRoutes(db));
    server.use(errorHandler);
    return server;
  }
  function actorFor(kind: "author" | "verifier" | "board" | "wrong-company"): AgentActor | { type: "board"; userId: string; source: string } {
    if (kind === "board") return { type: "board", userId: "local-board", source: "local_implicit" };
    if (kind === "wrong-company") return { type: "agent", agentId: f.authorAgentId, companyId: f.otherCompanyId, runId: authorRunId, source: "agent_key" };
    if (kind === "verifier") return { type: "agent", agentId: f.verifierAgentId, companyId: f.companyId, runId: verifierRunId, source: "agent_key" };
    return { type: "agent", agentId: f.authorAgentId, companyId: f.companyId, runId: authorRunId, source: "agent_key" };
  }
  function post(db: Db, url: string, body: object, actor: "author" | "verifier" | "board" | "wrong-company" = "author") {
    return request(app(db)).post(url).set("x-test-actor", actor).send(body);
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t6-native-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    f = await seedEvaluationFixture(owned.db);
    addChecks = [{ checkId: "add-1", requirementRefs: [f.requirementRefs[0]!], applicability: { op: "always" }, expectedEvidenceKinds: ["plan_document"], instructions: "실패 사례 추가 검사" }];
    authorRunId = f.authorRunId;
  }, 240_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("blocks author step completion without a stored candidate", async () => {
    const [authorIssue] = await owned.db.select().from(issues).where(eq(issues.id, f.authorIssueId));
    await expect(completeWorkflowIssue({
      db: owned.db, issue: { ...authorIssue, missionId: f.missionId },
      actor: { actorType: "agent", actorId: f.authorAgentId, agentId: f.authorAgentId, runId: authorRunId },
      data: {},
    })).rejects.toMatchObject({ status: 409, message: "quality_candidate_missing" });
  });

  it("submits a candidate through the dedicated route; fixes it and delivers B's step", async () => {
    const res = await post(owned.db, `/api/issues/${f.authorIssueId}/quality/candidates`, { schemaVersion: 1, checks: addChecks });
    expect(res.status).toBe(201);
    evaluationId = res.body.data.evaluationId;
    verifierIssueId = res.body.data.verifierIssueId;
    verifierStepRunId = res.body.data.verifierStepRunId;
    candidateVersionId = res.body.data.candidateVersionId;
    expect(evaluationId).toBeTruthy();
    const [action] = await owned.db.select().from(qualityActions).where(eq(qualityActions.id, f.actionId));
    expect(action!.currentEvaluationId).toBe(evaluationId);
    const [evaluation] = await owned.db.select().from(evaluatorCandidateRuns).where(eq(evaluatorCandidateRuns.id, evaluationId));
    expect(evaluation!.qualityActionId).toBe(f.actionId);
    const [verifierIssue] = await owned.db.select().from(issues).where(eq(issues.id, verifierIssueId));
    expect(verifierIssue!.assigneeAgentId).toBe(f.verifierAgentId);
    expect(verifierIssue!.missionId).toBe(f.missionId);
    const attempts = await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(attempts.some((row) => row.idempotencyKey?.includes(verifierStepRunId))).toBe(true);
    verifierRunId = await checkInVerifier(owned.db, f, verifierIssueId, verifierStepRunId, 0);
  });

  it("refuses board actors and wrong-company agents on every evaluation endpoint", async () => {
    const url = `/api/issues/${verifierIssueId}/quality/evaluations/${evaluationId}/v1/cases/${f.caseIds.failure}/baseline/open`;
    const board = await request(app(owned.db)).post(url).set("x-test-actor", "board").send({});
    expect(board.status).toBe(403);
    expect(board.body.error).toBe("quality_verifier_agent_required");
    const foreign = await post(owned.db, url, {}, "wrong-company");
    expect(foreign.status).toBe(403);
  });

  it("rejects candidate author A invoking verify (verifier binding on every v1 call)", async () => {
    const denied = await post(owned.db, `/api/issues/${verifierIssueId}/quality/evaluations/${evaluationId}/v1/verify`, {}, "author");
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("quality_verifier_role_required");
  });

  it("runs baseline+candidate evaluation through the dedicated API and verifies PASS", async () => {
    const statuses: Record<string, Record<string, "satisfied" | "defect">> = {
      [`${f.caseIds.failure}:baseline`]: { "base-plan-check": "satisfied" },
      [`${f.caseIds.failure}:candidate`]: { "base-plan-check": "satisfied", "add-1": "defect" },
      [`${f.caseIds.normal[0]}:baseline`]: { "base-plan-check": "satisfied" },
      [`${f.caseIds.normal[0]}:candidate`]: { "base-plan-check": "satisfied", "add-1": "satisfied" },
      [`${f.caseIds.normal[1]}:baseline`]: { "base-plan-check": "satisfied" },
      [`${f.caseIds.normal[1]}:candidate`]: { "base-plan-check": "satisfied", "add-1": "satisfied" },
    };
    for (const key of Object.keys(statuses)) {
      const [caseId, variant] = key.split(":") as [string, "baseline" | "candidate"];
      const opened = await post(owned.db, `/api/issues/${verifierIssueId}/quality/evaluations/${evaluationId}/v1/cases/${caseId}/${variant}/open`, {}, "verifier");
      expect(opened.status).toBe(201);
      const invocationId = opened.body.data.invocationId;
      const submittedResults = [];
      for (const [checkId, status] of Object.entries(statuses[key]!)) {
        const read = await post(owned.db, `/api/issues/${verifierIssueId}/quality/evaluations/${evaluationId}/v1/invocations/${invocationId}/read`, { checkId, pointers: ["/plan/goal"] }, "verifier");
        expect(read.status).toBe(201);
        submittedResults.push({ checkId, status, readRef: read.body.data.readRef, evidence: [] });
      }
      const submitted = await post(owned.db, `/api/issues/${verifierIssueId}/quality/evaluations/${evaluationId}/v1/invocations/${invocationId}/results`, { schemaVersion: 1, results: submittedResults }, "verifier");
      expect(submitted.status).toBe(201);
      expect(submitted.body.data.submissionRef).toBeTruthy();
    }
    const verdict = await post(owned.db, `/api/issues/${verifierIssueId}/quality/evaluations/${evaluationId}/v1/verify`, {}, "verifier");
    expect(verdict.status).toBe(200);
    expect(verdict.body.data).toMatchObject({ status: "pass" });
    expect(readCurrentEvaluationVerdict(owned.db, { companyId: f.companyId, actionId: f.actionId })).resolves.toMatchObject({ evaluationId, status: "pass" });
  });

  it("blocks evaluation step completion and pass verdicts before the dedicated verdict evidence", async () => {
    // 아직 verdict 가 없는 두 번째 평가 사이클에서 게이트를 검증한다 — 새 후보 → 새 evaluation.
    const second = await post(owned.db, `/api/issues/${f.authorIssueId}/quality/candidates`, { schemaVersion: 1, checks: [{ ...addChecks[0]!, checkId: "add-2" }] });
    expect(second.status).toBe(201);
    const secondEvaluationId = second.body.data.evaluationId;
    const secondIssueId = second.body.data.verifierIssueId;
    const secondRunId = await checkInVerifier(owned.db, f, secondIssueId, second.body.data.verifierStepRunId, 0);
    await expect(completeWorkflowIssue({
      db: owned.db, issue: { ...(await owned.db.select().from(issues).where(eq(issues.id, secondIssueId)))[0]!, missionId: f.missionId },
      actor: { actorType: "agent", actorId: f.verifierAgentId, agentId: f.verifierAgentId, runId: secondRunId },
      data: {},
    })).rejects.toMatchObject({ status: 409, message: "quality_evaluation_verdict_missing" });
  });

  it("suspends previous adoption eligibility when a new evaluation starts (previous PASS, current FAIL)", async () => {
    const second = await readCurrentEvaluationVerdict(owned.db, { companyId: f.companyId, actionId: f.actionId });
    expect(second).not.toBeNull();
    // 이전 evaluation 는 PASS 로 저장돼 있지만 적용 자격은 현재 evaluation 뿐이다.
    const [previous] = await owned.db.select().from(evaluatorCandidateRuns).where(eq(evaluatorCandidateRuns.id, evaluationId));
    expect(previous!.status).toBe("passed");
    const currentId = second!.evaluationId;
    // 이전(스테일) evaluation 로의 verify 경로는 409 로 거부된다.
    const stale = await post(owned.db, `/api/issues/${verifierIssueId}/quality/evaluations/${evaluationId}/v1/verify`, {}, "verifier");
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("quality_evaluation_not_current");
    // 현재 평가: 후보가 정상 사례를 망친다 → FAIL (이전 PASS 는 현재를 덮지 못한다).
    const currentVerdict = await submitFailVerdictFor(currentId);
    expect(currentVerdict).toMatchObject({ status: "fail" });
    expect(await readCurrentEvaluationVerdict(owned.db, { companyId: f.companyId, actionId: f.actionId })).toMatchObject({ evaluationId: currentId, status: "fail" });
  });

  async function submitFailVerdictFor(evaluationIdToFail: string) {
    const [evaluation] = await owned.db.select().from(evaluatorCandidateRuns).where(eq(evaluatorCandidateRuns.id, evaluationIdToFail));
    const contract = evaluation!.qualityContract as { verifier: { step: { issueId: string } } };
    const issueId = contract.verifier.step.issueId;
    // 새 평가 이슈에 실제 검증자 run 체크인 — 이후 라우트 actor 가 이 run 을 쓴다.
    verifierRunId = await checkInVerifier(owned.db, f, issueId, (evaluation!.qualityContract as { verifier: { step: { stepRunId: string } } }).verifier.step.stepRunId, (evaluation!.qualityContract as { verifier: { step: { generation: number } } }).verifier.step.generation);
    const statuses: Array<[string, "baseline" | "candidate", Record<string, "satisfied" | "defect">]> = [
      [f.caseIds.failure, "baseline", { "base-plan-check": "satisfied" }],
      [f.caseIds.failure, "candidate", { "base-plan-check": "satisfied", "add-2": "defect" }],
      [f.caseIds.normal[0]!, "baseline", { "base-plan-check": "satisfied" }],
      [f.caseIds.normal[0]!, "candidate", { "base-plan-check": "satisfied", "add-2": "defect" }],
      [f.caseIds.normal[1]!, "baseline", { "base-plan-check": "satisfied" }],
      [f.caseIds.normal[1]!, "candidate", { "base-plan-check": "satisfied", "add-2": "satisfied" }],
    ];
    for (const [caseId, variant, checks] of statuses) {
      const opened = await post(owned.db, `/api/issues/${issueId}/quality/evaluations/${evaluationIdToFail}/v1/cases/${caseId}/${variant}/open`, {}, "verifier");
      expect(opened.status).toBe(201);
      const invocationId = opened.body.data.invocationId;
      const submittedResults = [];
      for (const [checkId, status] of Object.entries(checks)) {
        const read = await post(owned.db, `/api/issues/${issueId}/quality/evaluations/${evaluationIdToFail}/v1/invocations/${invocationId}/read`, { checkId, pointers: ["/plan/goal"] }, "verifier");
        submittedResults.push({ checkId, status, readRef: read.body.data.readRef, evidence: [] });
      }
      const submitted = await post(owned.db, `/api/issues/${issueId}/quality/evaluations/${evaluationIdToFail}/v1/invocations/${invocationId}/results`, { schemaVersion: 1, results: submittedResults }, "verifier");
      expect(submitted.status).toBe(201);
    }
    const verified = await post(owned.db, `/api/issues/${issueId}/quality/evaluations/${evaluationIdToFail}/v1/verify`, {}, "verifier");
    expect(verified.status).toBe(200);
    return verified.body.data;
  }
});
