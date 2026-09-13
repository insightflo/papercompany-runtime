// [REGRESSION] T6 평가 → T9 검증 적용 → PLAN-QA 고정 명세 소비를 실제 서비스로 잇는 영구 회귀 테스트.
// 격리 임베디드 Postgres + local_disk storage 만 쓴다(운영 DB·네트워크·dev 서버 없음).
// [합성 한계 명시] 입력 문서(계획·요구)와 제출 판정(satisfied/defect)은 모두 합성값이다. 이 테스트는
// 에이전트 추론, API 전 구간 실행, 실제 QA 개선 효과를 증명하지 않는다. 검증 대상은 기존 동작의 회귀다:
// 사례별 baseline/candidate 고정 입력 등식, 판정 커버리지, 채택 본문 bytes/hash/내용이 핀 된 명세와
// 소비 검사 내용까지 일치하는지, 그리고 정확히 채택된 버전인지.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  evaluatorCandidateRuns, evaluatorVersions, heartbeatRuns, issues, missionPlanArtifacts, missions,
  qualityConsumerBindings,
} from "@paperclipai/db";
import type { ArtifactRef, CheckResult, QualityAgentActor } from "@paperclipai/shared";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { checkInVerifier, seedEvaluationFixture, type EvaluationFixture } from "./helpers/quality-evaluation-fixture.js";
import { evaluationContract, openQualityCase, readQualityCheck } from "../services/quality/evaluation-reader.js";
import { submitQualityCandidate } from "../services/quality/evaluation-candidates.js";
import { submitQualityCase, verifyQualityEvaluation } from "../services/quality/evaluation-submissions.js";
import { applyVerifiedAddendum, verifyAdoptionReadback } from "../services/quality/adoption.js";
import { readVerifiedArtifact } from "../services/quality/evidence-store.js";
import { hashContract } from "../services/quality/contract.js";
import {
  pinPlanQaManifest, planQaOriginId, readPlanQaManifestDocument, readPinnedPlanQaManifest,
} from "../services/missions/plan-qa-addendum-manifest.js";

const ADD_CHECK_IDS = ["add-1", "add-2"];
const DECISION_HASH = "c".repeat(64);

/** 손으로 적어둔 기대값: fixture 의 고정 oracle/발생 문서 리터럴과 대조한다(코드 유도 금지). */
function expectedGoal(f: EvaluationFixture, caseId: string): string {
  if (caseId === f.caseIds.failure) return "실패 재현 계획";
  if (caseId === f.caseIds.normal[0]) return "정상 계획 1";
  return "정상 계획 2";
}

/** 손으로 적어둔 기대값: baseline 은 정책 required 1개, candidate 는 required+추가 2개. */
function expectedChecks(f: EvaluationFixture, variant: "baseline" | "candidate"): string[] {
  return variant === "baseline" ? [f.baseCheckId] : [f.baseCheckId, ...ADD_CHECK_IDS];
}

/** [합성 판정 — 발견 증거 아님] T6 PASS 행렬: 발생 사례 후보 변형의 첫 추가 검사만 defect 로 제출한다. */
function syntheticStatus(f: EvaluationFixture, caseId: string, variant: "baseline" | "candidate", checkId: string): CheckResult["status"] {
  return caseId === f.caseIds.failure && variant === "candidate" && checkId === ADD_CHECK_IDS[0] ? "defect" : "satisfied";
}

type CaseInputDoc = { plan: { goal: string }; checks: Array<{ checkId: string }> };

describeQualityDb("Quality adoption → PLAN-QA consumption regression (synthetic judgments)", () => {
  let owned: QualityTestDb;
  let f: EvaluationFixture;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-adoption-planqa-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    f = await seedEvaluationFixture(owned.db);
  }, 240_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("keeps one cohesive scenario: evaluation PASS → adoption → PLAN-QA pins and consumes the exact adopted bytes, hash, and checks", async () => {
    // ── 1) 작성자 A 후보 제출 + 독립 검증자 B 체크인 ──
    const author: QualityAgentActor = { agentId: f.authorAgentId, companyId: f.companyId, heartbeatRunId: f.authorRunId, executionEpoch: f.authorEpoch };
    const checks = ADD_CHECK_IDS.map((checkId) => ({
      checkId, requirementRefs: [f.requirementRefs[0]!], applicability: { op: "always" as const },
      expectedEvidenceKinds: ["plan_document"], instructions: `추가 검사 ${checkId}`,
    }));
    const candidate = await submitQualityCandidate(owned.db, author, { issueId: f.authorIssueId, schemaVersion: 1, checks });
    const verifierRunId = await checkInVerifier(owned.db, f, candidate.verifierIssueId, candidate.verifierStepRunId, 0);
    const verifier: QualityAgentActor = { agentId: f.verifierAgentId, companyId: f.companyId, heartbeatRunId: verifierRunId, executionEpoch: 1 };
    expect(verifier.agentId).not.toBe(author.agentId);

    // ── 2) 모든 사례×변형을 열람·판독·합성 판정 제출한다 (커버리지는 등식과 별도 수집) ──
    const cases = [f.caseIds.failure, ...f.caseIds.normal];
    const variants = ["baseline", "candidate"] as const;
    const inputDocs = new Map<string, CaseInputDoc>();
    for (const caseId of cases) {
      for (const variant of variants) {
        const opened = await openQualityCase(owned.db, verifier, { issueId: candidate.verifierIssueId, evaluationId: candidate.evaluationId, caseId, variant });
        const bytes = await readVerifiedArtifact(owned.db, { companyId: f.companyId, ref: opened.inputRef, maxBytes: 524_288 });
        inputDocs.set(`${caseId}:${variant}`, JSON.parse(bytes.toString("utf8")));
        const results: CheckResult[] = [];
        for (const checkId of expectedChecks(f, variant)) {
          const read = await readQualityCheck(owned.db, verifier, { invocationId: opened.invocationId, checkId, pointers: ["/plan/goal"] });
          results.push({ checkId, status: syntheticStatus(f, caseId, variant, checkId), readRef: read.readRef, evidence: [] });
        }
        expect(results.map((result) => result.checkId)).toEqual(expectedChecks(f, variant));
        await submitQualityCase(owned.db, verifier, { invocationId: opened.invocationId, schemaVersion: 1, results });
      }
    }
    // 커버리지(등식과 무관): 3 사례 × 2 변형 여섯 쌍이 모두 열리고 제출됐다.
    const expectedPairs = cases.flatMap((caseId) => variants.map((variant) => `${caseId}:${variant}`));
    expect([...inputDocs.keys()].sort()).toEqual([...expectedPairs].sort());

    // ── 3) 사례별 등식: 같은 고정 plan 이 baseline/candidate 양변에 그대로 저장됐다 ──
    for (const caseId of cases) {
      const baseline = inputDocs.get(`${caseId}:baseline`)!;
      const candidateDoc = inputDocs.get(`${caseId}:candidate`)!;
      expect(JSON.stringify(baseline.plan)).toBe(JSON.stringify(candidateDoc.plan));
      expect(baseline.plan.goal).toBe(expectedGoal(f, caseId));
      expect(baseline.checks.map((check) => check.checkId)).toEqual(expectedChecks(f, "baseline"));
      expect(candidateDoc.checks.map((check) => check.checkId)).toEqual(expectedChecks(f, "candidate"));
    }

    // ── 4) 판정: 손으로 유도한 Comparison 행렬 그대로 PASS ──
    const verdict = await verifyQualityEvaluation(owned.db, verifier, { companyId: f.companyId, actionId: f.actionId });
    expect(verdict.status).toBe("pass");

    // ── 5) 적용 + readback: 현재 평가 원본, 정확한 버전, 원래 영수증 ──
    const key = { companyId: f.companyId, actionId: f.actionId };
    const adopted = await applyVerifiedAddendum(owned.db, key);
    expect(adopted.revision).toBe(1);
    expect(await verifyAdoptionReadback(owned.db, key)).toEqual({ verified: true, evidenceRefId: adopted.evidenceRefId });
    const [evaluation] = await owned.db.select().from(evaluatorCandidateRuns).where(eq(evaluatorCandidateRuns.id, candidate.evaluationId));
    expect(evaluation!.evaluatorVersionId).toBe(candidate.candidateVersionId);
    const state = evaluationContract(evaluation!);
    expect(state.verdict!.rows).toEqual([
      { id: f.caseIds.failure, group: "failure", expected: "request_changes", baseline: "pass", candidate: "request_changes", semantic: "verified" },
      { id: f.caseIds.normal[0], group: "normal", expected: "pass", baseline: "pass", candidate: "pass", semantic: "verified" },
      { id: f.caseIds.normal[1], group: "normal", expected: "pass", baseline: "pass", candidate: "pass", semantic: "verified" },
    ]);
    const [binding] = await owned.db.select().from(qualityConsumerBindings).where(and(
      eq(qualityConsumerBindings.companyId, f.companyId), eq(qualityConsumerBindings.id, adopted.bindingId),
    ));
    expect(binding).toMatchObject({
      activeVersionId: candidate.candidateVersionId, revision: 1, adoptionEvidenceRefId: adopted.evidenceRefId,
    });

    // ── 6) PLAN-QA 명세 고정: 활성 추가 검사가 새 명세에 영구 핀 된다 ──
    const missionId = randomUUID();
    await owned.db.insert(missions).values({ id: missionId, companyId: f.companyId, ownerAgentId: f.authorAgentId, title: "소비 회귀 미션", status: "active" });
    const [plan] = await owned.db.insert(missionPlanArtifacts).values({
      companyId: f.companyId, missionId, ownerAgentId: f.authorAgentId, revision: 1, missionGoal: "소비 회귀 목표",
      refs: {
        schemaVersion: 3,
        selectedExecutionUnits: [{ id: "unit-1", title: "작성", selectionState: "selected" }],
        planTemplates: { selectionSource: "explicit", items: [{ id: f.templateId, key: f.templateId.slice(0, 8), contentHash: f.baseHash }] },
        ownerPlanDecision: { decisionHash: DECISION_HASH },
      },
      requiredInputs: [], successCriteria: [], steps: [],
    }).returning({ id: missionPlanArtifacts.id });
    const qaIssue = (await owned.db.insert(issues).values({
      companyId: f.companyId, missionId, title: "[PLAN-QA] 소비 회귀", originKind: "mission_plan_qa",
      originId: planQaOriginId(missionId, DECISION_HASH), status: "todo", assigneeAgentId: f.verifierAgentId,
    }).returning())[0]!;
    const qaRunId = randomUUID();
    await owned.db.insert(heartbeatRuns).values({ id: qaRunId, companyId: f.companyId, agentId: f.verifierAgentId, issueId: qaIssue.id, executionEpoch: 1, status: "running" });
    const manifestRef = await pinPlanQaManifest(owned.db, { companyId: f.companyId, missionId, planArtifactId: plan!.id, decisionHash: DECISION_HASH, reviewGeneration: 1 });
    const manifest = await readPlanQaManifestDocument(owned.db, f.companyId, manifestRef);
    const template = manifest.templates.find((entry) => entry.templateId === f.templateId)!;
    expect(template.status).toBe("applied");
    expect(template.addendumVersionId).toBe(candidate.candidateVersionId);
    expect(template.checks.map((check) => check.checkId)).toEqual([f.baseCheckId, ...ADD_CHECK_IDS]);

    // ── 7) 채택 본문 불변성: 저장 bytes·hash·내용이 핀 된 명세와 정확히 일치 ──
    const [version] = await owned.db.select().from(evaluatorVersions).where(eq(evaluatorVersions.id, candidate.candidateVersionId));
    const contract = version!.qualityContract as unknown as { bodyHash: string; bodyRef: ArtifactRef; checks: unknown[] };
    const bodyBytes = await readVerifiedArtifact(owned.db, { companyId: f.companyId, ref: contract.bodyRef, maxBytes: 524_288 });
    // bodyRef 무결성: readVerifiedArtifact 는 sha 불일치 저장 bytes 를 닫는다 — 여기 도달 자체가 1차 검증이고
    // 아래는 원문 bytes 의 hash 를 직접 대조한다.
    expect(createHash("sha256").update(bodyBytes).digest("hex")).toBe(contract.bodyRef.sha256);
    const body = JSON.parse(bodyBytes.toString("utf8"));
    expect(contract.bodyHash).toBe(template.addendumBodySha256);
    expect(hashContract(body)).toBe(template.addendumBodySha256);
    const pinnedAddendumChecks = template.checks.filter((check) => check.checkId !== f.baseCheckId);
    expect(JSON.stringify(body.checks)).toBe(JSON.stringify(pinnedAddendumChecks));

    // ── 8) 검토자 소비 경로: ID 가 아니라 검사 내용까지 동일하게 돌려준다 ──
    const consumed = await readPinnedPlanQaManifest(owned.db, {
      kind: "plan_qa", companyId: f.companyId, missionId, planArtifactId: plan!.id, issueId: qaIssue.id,
      decisionHash: DECISION_HASH, reviewGeneration: 1, manifestRef, heartbeatRunId: qaRunId, executionEpoch: 1,
      workflow: { kind: "not_applicable" as const, reason: "mission_plan_qa_issue" },
    });
    expect(consumed.inputRef).toEqual(manifestRef);
    expect(consumed.checks.map((check) => check.checkId)).toEqual([f.baseCheckId, ...ADD_CHECK_IDS]);
    expect(JSON.stringify(consumed.checks)).toBe(JSON.stringify(manifest.checks));
    expect(JSON.stringify(consumed.checks.filter((check) => check.checkId !== f.baseCheckId))).toBe(JSON.stringify(body.checks));
  }, 180_000);
});
