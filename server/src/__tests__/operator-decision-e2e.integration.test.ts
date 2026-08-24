import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  operatorDecisionContinuations,
  operatorDecisions,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { infloOpportunityOperatorDecisionInput } from "./helpers/inflo-operator-decision-fixture.js";
import { operatorDecisionContinuationWorker } from "../services/operator-decision-continuation-worker.js";
import { operatorDecisionReadService } from "../services/operator-decisions-read.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("Inflo Operator Decision end-to-end", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let issueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("operator-decision-inflo-e2e-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });
  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(operatorDecisionContinuations);
    await db.delete(operatorDecisions);
    await db.delete(agentWakeupRequests);
    // [delivery bridge] resolve 가 시스템 코멘트를 남기므로 issues 삭제 전에 정리한다(FK 순서).
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Inflo", issuePrefix: `I${companyId.slice(0, 4)}` });
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Opportunity Lead" });
    issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Prepare selected opportunity proposal intake",
      status: "todo",
      assigneeAgentId: agentId,
    });
  });

  it("persists the choice, Activity evidence, and one admitted linked-work wakeup", async () => {
    const write = operatorDecisionWriteService(db);
    const created = await write.create(
      companyId,
      infloOpportunityOperatorDecisionInput("inflo:fixture:choice", issueId),
      { type: "agent", id: agentId },
    );
    const pending = await operatorDecisionReadService(db).list(companyId, { view: "pending", limit: 50 });
    expect(pending.data[0]).toMatchObject({
      id: created.decision.id,
      definition: {
        approvedScope: expect.arrayContaining(["Prepare an internal draft only"]),
        forbiddenScope: expect.arrayContaining(["External contact", "Submission", "Price commitment", "Contract commitment"]),
      },
    });

    const resolved = await write.resolve(created.decision.id, {
      actionId: "prepare_internal_proposal",
      selectedOptionIds: ["candidate-north"],
      comment: "Proceed internally",
    }, "board-user");
    expect(resolved.decision).toMatchObject({
      status: "resolved",
      resolvedByUserId: "board-user",
      result: { actionId: "prepare_internal_proposal", outcome: "submit", selectedOptionIds: ["candidate-north"] },
    });
    expect((await operatorDecisionReadService(db).list(companyId, { view: "pending", limit: 50 })).data).toEqual([]);

    // [delivery bridge] resolve 는 이슈에 시스템 코멘트(저자 없음)를 남긴다 — running 런도 다음 실행에서
    //   brief 의 recentIssueComments 로 결정을 본다.
    const resolvedComments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(resolvedComments).toHaveLength(1);
    expect(resolvedComments[0]).toMatchObject({ authorAgentId: null, authorUserId: null });
    expect(resolvedComments[0]!.body).toContain("## 운영자 결정 반영 (operator decision resolved)");
    expect(resolvedComments[0]!.body).toContain("- 선택: North District modernization — Internal proposal candidate");
    expect(resolvedComments[0]!.body).toContain(`- operatorDecisionId: ${created.decision.id}`);
    expect(resolvedComments[0]!.body).toContain("다음 실행자는 이 결정을 우선 지시로 따른다.");

    const wakeup = vi.fn(async (targetAgentId: string, options: Record<string, unknown>) => {
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId: targetAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "operator_decision_resolved",
        payload: options.payload as Record<string, unknown>,
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        idempotencyKey: options.idempotencyKey as string,
        requestKind: "operator_decision_resolution",
        issueId,
      });
    });
    await operatorDecisionContinuationWorker(db, { wakeup, workerId: "inflo-e2e" }).pollOnce();
    // [delivery bridge] payload 매칭에 paperclipOperatorDecisionResolution 키 추가 — 기존 키의 의미는
    //   변경 없음(신규 전달 필드 추가).
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      payload: {
        kind: "operator_decision_resolution",
        operatorDecisionId: created.decision.id,
        issueId,
        actionId: "prepare_internal_proposal",
        selectedOptionIds: ["candidate-north"],
        paperclipOperatorDecisionResolution: {
          operatorDecisionId: created.decision.id,
          options: [{ id: "candidate-north", label: "North District modernization", description: "Internal proposal candidate" }],
        },
      },
      contextSnapshot: {
        issueId,
        wakeReason: "operator_decision_resolved",
        operatorDecisionId: created.decision.id,
        paperclipOperatorDecisionResolution: {
          operatorDecisionId: created.decision.id,
          options: [{ id: "candidate-north", label: "North District modernization", description: "Internal proposal candidate" }],
        },
      },
      idempotencyKey: `operator-decision-wake:${created.decision.id}:g1:a1`,
    }));
    expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
    const actions = (await db.select().from(activityLog).where(eq(activityLog.entityId, created.decision.id)))
      .map((row) => row.action);
    expect(actions).toEqual([
      "operator_decision.created",
      "operator_decision.resolved",
      "operator_decision.continuation_accepted",
    ]);

    const replay = await write.resolve(created.decision.id, {
      actionId: "prepare_internal_proposal",
      selectedOptionIds: ["candidate-north"],
      comment: "Proceed internally",
    }, "board-user");
    expect(replay.applied).toBe(false);
    expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
    // [delivery bridge] replay resolve 는 시스템 코멘트를 중복 생성하지 않는다.
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(1);
  });

  it.each([
    ["hold_all", "hold"],
    ["reject_shortlist", "reject"],
  ])("records %s without an external or continuation side effect", async (actionId, outcome) => {
    const write = operatorDecisionWriteService(db);
    const fixture = {
      ...infloOpportunityOperatorDecisionInput(`inflo:fixture:${actionId}`, issueId),
      continuationMode: "none" as const,
    };
    const created = await write.create(companyId, fixture, { type: "user", id: "board" });
    const resolved = await write.resolve(created.decision.id, { actionId, selectedOptionIds: [], comment: null }, "board");
    expect(resolved.decision.result).toMatchObject({ actionId, outcome });
    expect(resolved.continuation).toBeNull();
    expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });
});
