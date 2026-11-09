// engine-contract S06·S07·S08 — workflow 종결 결정의 cancel_heartbeat_run 효과 계약 (#682 회귀).
// seed: workflow run + terminal decision + effect intent 행 → entry: executeTerminalEffectIntents
// → assert: heartbeat_runs / intents / finalizations / wakeups / issues 최종 행만.
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRunFinalizations,
  issues,
  workflowStepRuns,
  workflowTerminalDecisions,
  workflowTerminalEffectIntents,
  type Db,
} from "@paperclipai/db";
import { executeTerminalEffectIntents } from "../../services/workflow/run-terminal-effect-executor.js";
import {
  MIN,
  describeEP,
  fetchHeartbeatRun,
  seedHeartbeatRun,
  seedMissionV1Run,
  seedWorkflow,
  startContractDb,
  type ContractDb,
} from "./helpers.js";

let w: ContractDb;
let off: ContractDb;

beforeAll(async () => {
  w = await startContractDb("contract-cancel-v1-", { finalizationV1: true, runTerminalBoundaryV1: true });
  off = await startContractDb("contract-cancel-off-", {});
}, 120_000);

afterAll(async () => {
  await w.temp.cleanup();
  await off.temp.cleanup();
});

/** 결정 + cancel_heartbeat_run 인텐트 1건을 시드하고 결정 id 를 돌려준다. */
async function seedCancelIntent(
  db: Db,
  input: { companyId: string; workflowRunId: string; targetRunId: string },
) {
  const [decision] = await db
    .insert(workflowTerminalDecisions)
    .values({
      companyId: input.companyId,
      workflowRunId: input.workflowRunId,
      decidedAuthorityVersion: 1,
      decision: "terminate",
      policyCause: "operator_cancel",
      discoveryPath: "contract-seed",
      origin: "contract",
      capturedStopTargets: { runtimeIds: [], heartbeatRunIds: [input.targetRunId], supersededUnblockIssueIds: [] },
    })
    .returning();
  const [intent] = await db
    .insert(workflowTerminalEffectIntents)
    .values({
      companyId: input.companyId,
      terminalDecisionId: decision.id,
      effectKind: "cancel_heartbeat_run",
      targetId: input.targetRunId,
      payload: {},
      status: "pending",
      attemptCount: 0,
    })
    .returning();
  return { decision, intent };
}

describeEP("engine-contract S06/S07/S08 — terminal cancel effect (#682)", () => {
  it("S06: flag ON + v1 run 은 취소 계약으로 종결되고 finalization shadow 가 남는다", async () => {
    const wf = await seedWorkflow(w.db, { companyId: w.companyId, steps: [] });
    const seed = await seedMissionV1Run(w.db, {
      companyId: w.companyId,
      agentId: w.agentId,
      run: { workflowStepRunId: null },
    });
    const { decision, intent } = await seedCancelIntent(w.db, {
      companyId: w.companyId,
      workflowRunId: wf.run.id,
      targetRunId: seed.run.id,
    });

    const result = await executeTerminalEffectIntents(w.db, decision.id, new Date());
    expect(result.failed).toBe(0);
    expect(result.executed).toBe(1);

    const run = await fetchHeartbeatRun(w.db, seed.run.id);
    expect(run.status).toBe("cancelled");
    expect(run.errorCode).toBe("cancelled");
    expect(run.finishedAt).not.toBeNull();
    // v1 종결: 미정산 유지 — 정산은 recovery lane 계약.
    expect(run.finalizationVersion).toBe(1);
    expect(run.settledAt).toBeNull();

    const finRows = await w.db
      .select()
      .from(heartbeatRunFinalizations)
      .where(eq(heartbeatRunFinalizations.heartbeatRunId, run.id));
    expect(finRows.length).toBeGreaterThanOrEqual(1);

    const [wake] = await w.db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seed.wakeupRequestId));
    expect(wake.status).toBe("cancelled");

    const [issue] = await w.db.select().from(issues).where(eq(issues.id, seed.issue.id));
    expect(issue.checkoutRunId).toBeNull();
    expect(issue.executionRunId).toBeNull();
    expect(issue.executionLockedAt).toBeNull();

    const [intentRow] = await w.db
      .select()
      .from(workflowTerminalEffectIntents)
      .where(eq(workflowTerminalEffectIntents.id, intent.id));
    expect(intentRow.status).toBe("completed");
    expect(intentRow.completedAt).not.toBeNull();
    expect(intentRow.attemptCount).toBe(1);
  });

  it("S07: 완료 step 증거가 있는 run 은 취소 결정에서도 succeeded 로 보존된다", async () => {
    const wf = await seedWorkflow(w.db, { companyId: w.companyId, steps: [] });
    const { run: wfRun } = wf;
    const [completedStep] = await w.db
      .insert(workflowStepRuns)
      .values({
        workflowRunId: wfRun.id,
        stepId: "a",
        status: "completed",
        startedAt: new Date(Date.now() - 10 * MIN),
        completedAt: new Date(Date.now() - 5 * MIN),
        metadata: {},
      })
      .returning();
    const seed = await seedMissionV1Run(w.db, {
      companyId: w.companyId,
      agentId: w.agentId,
      stepCompleted: true,
      run: { workflowStepRunId: completedStep.id, resultJson: { ok: true } },
    });
    const { decision, intent } = await seedCancelIntent(w.db, {
      companyId: w.companyId,
      workflowRunId: wfRun.id,
      targetRunId: seed.run.id,
    });

    const result = await executeTerminalEffectIntents(w.db, decision.id, new Date());
    expect(result.failed).toBe(0);

    const run = await fetchHeartbeatRun(w.db, seed.run.id);
    expect(run.status).toBe("succeeded");
    expect(run.resultJson).toEqual({ ok: true });
    const [wake] = await w.db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seed.wakeupRequestId));
    expect(wake.status).toBe("completed");
    const [intentRow] = await w.db
      .select()
      .from(workflowTerminalEffectIntents)
      .where(eq(workflowTerminalEffectIntents.id, intent.id));
    expect(intentRow.status).toBe("completed");
  });

  it("S08: 이미 정산된 대상은 실패로 남기고, flag OFF 는 레거시 취소와 동일하다", async () => {
    // S08a — settled target: throw 없이 인텐트를 pending(lastError)으로 남긴다.
    const wf = await seedWorkflow(w.db, { companyId: w.companyId, steps: [] });
    const settledRun = await seedHeartbeatRun(w.db, {
      companyId: w.companyId,
      agentId: w.agentId,
      status: "succeeded",
      terminalOutcome: "succeeded",
      finishedAt: new Date(Date.now() - 30 * MIN),
      settledAt: new Date(Date.now() - 30 * MIN),
    });
    const { decision, intent } = await seedCancelIntent(w.db, {
      companyId: w.companyId,
      workflowRunId: wf.run.id,
      targetRunId: settledRun.id,
    });
    const result = await executeTerminalEffectIntents(w.db, decision.id, new Date());
    expect(result.executed).toBe(0);
    expect(result.failed).toBe(1);
    const [intentRow] = await w.db
      .select()
      .from(workflowTerminalEffectIntents)
      .where(eq(workflowTerminalEffectIntents.id, intent.id));
    expect(intentRow.status).toBe("pending");
    expect(intentRow.attemptCount).toBe(1);
    expect(intentRow.lastError).toContain("already settled");
    // 원본 run 은 무결.
    const untouched = await fetchHeartbeatRun(w.db, settledRun.id);
    expect(untouched.status).toBe("succeeded");

    // S08b — flag OFF: 성공 증거 평가 없이 레거시 취소와 동일한 행을 쓰고 shadow 는 없다.
    const wfOff = await seedWorkflow(off.db, { companyId: off.companyId, steps: [] });
    const offRun = await seedHeartbeatRun(off.db, {
      companyId: off.companyId,
      agentId: off.agentId,
      status: "running",
      finalizationVersion: 1,
      resultJson: { ok: true },
    });
    const { decision: offDecision } = await seedCancelIntent(off.db, {
      companyId: off.companyId,
      workflowRunId: wfOff.run.id,
      targetRunId: offRun.id,
    });
    const offResult = await executeTerminalEffectIntents(off.db, offDecision.id, new Date());
    expect(offResult.failed).toBe(0);
    const after = await fetchHeartbeatRun(off.db, offRun.id);
    expect(after.status).toBe("cancelled");
    expect(after.errorCode).toBe("cancelled");
    expect(after.finishedAt).not.toBeNull();
    const finRows = await off.db
      .select()
      .from(heartbeatRunFinalizations)
      .where(eq(heartbeatRunFinalizations.heartbeatRunId, offRun.id));
    expect(finRows.length).toBe(0);
  });
});
