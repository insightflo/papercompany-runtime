import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, heartbeatRuns, workflowRuns, workflowStepRuns, workflowTerminalDecisions, workflowRecoveryAuthorities } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReplacement } from "./helpers/replacement-scenario.js";
import { proposeReplacement, approveReplacement } from "../services/workflow/replacement-approval.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
let db: ReturnType<typeof createDb>, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
const roots: string[] = [];
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("replacement-explicit-"); db = createDb(temp.connectionString); }, 60_000);
afterAll(async () => { await db.$client.end(); await temp.cleanup(); roots.forEach(r => rmSync(r, { recursive: true, force: true })); });
it("a failed replacement requires its own current decision and explicit approval, not a blanket lineage ban", async () => {
  const s = await seedReplacement(db); roots.push(s.tempRoot);
  const first = (await admitReplacement(db, s.input, s.actor)).run;
  await db.update(workflowRuns).set({ status: "failed", completedAt: new Date() }).where(eq(workflowRuns.id, first.id));
  const stepRunId = randomUUID(), heartbeatId = randomUUID();
  await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId: first.id, stepId: "collect-us-stockflow", status: "failed" });
  await db.insert(workflowTerminalDecisions).values({ companyId: s.companyId, workflowRunId: first.id, decidedAuthorityVersion: 0,
    decision: "failed", policyCause: "recovery_deadline_hard", discoveryPath: "stuck_diagnostic", origin: "reconciler", reason: "another failure", recoveryGate: {} });
  await expect(proposeReplacement(db, s.companyId, s.board, { sourceRunId: first.id,
    decisionEventId: s.input.replacementIntent.decisionEventId, idempotencyKey: "second-explicit", externalEffects: "operator_reconciled" })).rejects.toThrow("replacement_owner_decision_invalid");
  await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId: s.companyId, agentId: s.actor.agentId,
    issueId: s.recoveryIssueId, status: "succeeded", finishedAt: new Date(), invocationSource: "manual" });
  const decision = await recordMissionOwnerDecision({ db, issue: { id: s.recoveryIssueId, companyId: s.companyId, missionId: s.mission.id },
    heartbeatRunId: heartbeatId, submission: { decision: "restart_from_start", recoveryTarget: { kind: "tool_step", workflowRunId: first.id,
      stepRunId, expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null } } });
  const proposal = await proposeReplacement(db, s.companyId, s.board, { sourceRunId: first.id,
    decisionEventId: decision.eventId, idempotencyKey: "second-explicit", externalEffects: "operator_reconciled" });
  const input = { ...s.input, replacementIntent: { ...s.input.replacementIntent, sourceRunId: first.id,
    decisionEventId: decision.eventId, approvalId: proposal.id, idempotencyKey: "second-explicit" } };
  await expect(admitReplacement(db, input, s.actor)).rejects.toThrow("replacement_operator_approval_required");
  await approveReplacement(db, s.companyId, proposal.id, s.board);
  const second = await admitReplacement(db, input, s.actor);
  expect(second.replay).toBe(false); expect(second.run.id).not.toBe(first.id);
  expect(await admitReplacement(db, s.input, s.actor)).toMatchObject({ replay: true, run: { id: first.id, status: "failed" } });
  expect(await admitReplacement(db, input, s.actor)).toMatchObject({ replay: true, run: { id: second.run.id } });
  expect(await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.companyId, s.companyId))).toHaveLength(2);
});
