// engine-contract S23·S24 — PLAN-QA 게이트 계약 (mission_plan_qa_verdicts 원장만이 권위).
// 활성 계획 refs.planQa 가 가리키는 issueId+decisionHash 와 일치하는 공식 verdict 행이 있어야만
// materialization(requireOwnerPlanQaPass)과 이슈 완료(assertCanCompleteMissionPlanQaIssue)가 허가된다.
// seed: 순수 DB 행 → entry: recordMissionPlanQaVerdict / requireOwnerPlanQaPass /
//   assertCanCompleteMissionPlanQaIssue → assert: mission_plan_qa_verdicts 최종 행 + 게이트 판정.
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  issues,
  missionPlanArtifacts,
  missionPlanQaVerdicts,
  missions,
  type Db,
} from "@paperclipai/db";
import { recordMissionPlanQaVerdict } from "../../services/missions/mission-plan-qa-verdicts.js";
import { requireOwnerPlanQaPass } from "../../services/missions/owner-plan-qa-consumers.js";
import { hasMissionPlanQaCompletionLedger } from "../../services/missions/mission-plan-qa-completion-gate.js";
import { assertCanCompleteMissionPlanQaIssue } from "../../services/issue-update-completion-guards.js";
import { describeEP, startContractDb, type ContractDb } from "./helpers.js";

let w: ContractDb;

beforeAll(async () => {
  w = await startContractDb("contract-plan-qa-", { finalizationV1: true });
}, 120_000);

afterAll(async () => {
  await w.temp.cleanup();
});

const DH_A = "a".repeat(64);
const DH_B = "b".repeat(64);
const DH_WRONG = "f".repeat(64);

/** mission + mission_plan_qa 이슈 + 활성 계획 아티팩트(refs.planQa 바인딩) 시드. */
async function seedPlanQaWorld(db: Db, decisionHash: string) {
  const [mission] = await db.insert(missions).values({
    companyId: w.companyId, title: "plan-qa mission", status: "active", ownerAgentId: w.agentId,
  }).returning();
  const [planQaIssue] = await db.insert(issues).values({
    companyId: w.companyId, missionId: mission.id, title: "[PLAN-QA] review",
    status: "in_progress", assigneeAgentId: w.agentId, originKind: "mission_plan_qa",
  }).returning();
  const [plan] = await db.insert(missionPlanArtifacts).values({
    companyId: w.companyId, missionId: mission.id, ownerAgentId: w.agentId,
    missionGoal: "goal", status: "active",
    refs: { planQa: { issueId: planQaIssue.id, decisionHash, status: "pending" } },
  }).returning();
  return { mission, planQaIssue, plan };
}

describeEP("engine-contract S23/S24 — PLAN-QA verdict ledger gates", () => {
  it("S23: materialization 게이트는 활성 해시의 pass verdict 만 허가한다", async () => {
    const { mission, planQaIssue, plan } = await seedPlanQaWorld(w.db, DH_A);
    const gate = { db: w.db, companyId: w.companyId, missionId: mission.id, missionPlanArtifactId: plan.id, decisionHash: DH_A };

    // FAIL: verdict 부재 → materialization 차단.
    await expect(requireOwnerPlanQaPass(gate)).rejects.toThrow("quality_plan_qa_approval_missing");

    // request_changes 기록 → 행은 남지만 materialization 은 여전히 차단(FAIL), 이슈 완료는 허가(PASS).
    const recorded = await recordMissionPlanQaVerdict({
      db: w.db, companyId: w.companyId, missionId: mission.id, planQaIssueId: planQaIssue.id,
      decisionHash: DH_A, verdict: "request_changes",
      reviewedBy: { actorType: "agent", actorId: w.agentId },
    });
    expect(recorded.status).toBe("recorded");
    const rows = await w.db.select().from(missionPlanQaVerdicts).where(and(
      eq(missionPlanQaVerdicts.planQaIssueId, planQaIssue.id),
      eq(missionPlanQaVerdicts.decisionHash, DH_A),
    ));
    expect(rows.length).toBe(1);
    expect(rows[0]!.verdict).toBe("request_changes");
    expect(rows[0]!.sourceCommentId).toBeNull();
    await expect(requireOwnerPlanQaPass(gate)).rejects.toThrow("quality_plan_qa_approval_missing");
    await expect(assertCanCompleteMissionPlanQaIssue(w.db, planQaIssue)).resolves.toBeUndefined();

    // 동일 해시의 pass 판정(upsert) → materialization 허가(PASS).
    await recordMissionPlanQaVerdict({
      db: w.db, companyId: w.companyId, missionId: mission.id, planQaIssueId: planQaIssue.id,
      decisionHash: DH_A, verdict: "pass",
      reviewedBy: { actorType: "agent", actorId: w.agentId },
    });
    const after = await w.db.select().from(missionPlanQaVerdicts).where(and(
      eq(missionPlanQaVerdicts.planQaIssueId, planQaIssue.id),
      eq(missionPlanQaVerdicts.decisionHash, DH_A),
    ));
    expect(after.length).toBe(1);
    expect(after[0]!.verdict).toBe("pass");
    await expect(requireOwnerPlanQaPass(gate)).resolves.toBeUndefined();
  });

  it("S24: 완료 게이트는 활성 decisionHash 와 일치하는 verdict 만 인정한다", async () => {
    const { mission, planQaIssue } = await seedPlanQaWorld(w.db, DH_B);

    // FAIL: verdict 부재 → 이슈 완료 차단.
    await expect(assertCanCompleteMissionPlanQaIssue(w.db, planQaIssue))
      .rejects.toThrow("active plan decision hash");

    // FAIL: 다른 해시의 verdict 는 활성 해시 원장을 만족시키지 못한다.
    await recordMissionPlanQaVerdict({
      db: w.db, companyId: w.companyId, missionId: mission.id, planQaIssueId: planQaIssue.id,
      decisionHash: DH_WRONG, verdict: "pass",
      reviewedBy: { actorType: "agent", actorId: w.agentId },
    });
    await expect(assertCanCompleteMissionPlanQaIssue(w.db, planQaIssue))
      .rejects.toThrow("active plan decision hash");
    const unsatisfied = await hasMissionPlanQaCompletionLedger({
      db: w.db, companyId: w.companyId, missionId: mission.id, planQaIssueId: planQaIssue.id,
    });
    expect(unsatisfied.satisfied).toBe(false);
    expect(unsatisfied.decisionHash).toBe(DH_B);
    expect(unsatisfied.lookupMode).toBe("active_decision_hash");

    // PASS: 활성 해시의 verdict → 완료 허가.
    await recordMissionPlanQaVerdict({
      db: w.db, companyId: w.companyId, missionId: mission.id, planQaIssueId: planQaIssue.id,
      decisionHash: DH_B, verdict: "pass",
      reviewedBy: { actorType: "agent", actorId: w.agentId },
    });
    const satisfied = await hasMissionPlanQaCompletionLedger({
      db: w.db, companyId: w.companyId, missionId: mission.id, planQaIssueId: planQaIssue.id,
    });
    expect(satisfied.satisfied).toBe(true);
    await expect(assertCanCompleteMissionPlanQaIssue(w.db, planQaIssue)).resolves.toBeUndefined();
  });
});
