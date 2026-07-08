import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, heartbeatRuns } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { hermesChatService } from "../services/hermes-chat.js";
import { isWorkflowReworkRun, runMadeObservableProgress } from "../services/workflow/agent-api.js";

// [목적] QA rework closeout guard의 두 helper(rework run 판별 + 진행 증거)가 exact run attribution으로 동작하는지 검증.
//   completeWorkflowIssue의 wiring(throw conflict)은 1줄이고 helper가 핵심 로직.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres rework closeout guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("QA rework closeout guard helpers", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let reworkRunId: string;
  let plainRunId: string;
  let otherRunId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rework-closeout-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Rework Closeout Co",
      issuePrefix: `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    agentId = (await hermesChatService(db).ensureOperationsAgent(companyId)).id;

    const [r1] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        contextSnapshot: {
          paperclipWorkflowReworkContract: {
            kind: "workflow_qa_rework",
            producerStepId: "materialize-html-report",
            iterationLabel: "1/2",
            qaFeedbacks: [{ qaStepId: "qa-1", qaIssueId: null, feedback: "REQUEST_CHANGES: fix X" }],
            dependencyArtifacts: null,
            requiredActions: [],
          },
        },
      })
      .returning({ id: heartbeatRuns.id });
    reworkRunId = r1.id;

    const [r2] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, contextSnapshot: {} })
      .returning({ id: heartbeatRuns.id });
    plainRunId = r2.id;

    const [r3] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId })
      .returning({ id: heartbeatRuns.id });
    otherRunId = r3.id;
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("isWorkflowReworkRun: true only for a run whose contextSnapshot carries a workflow_qa_rework contract", async () => {
    expect(await isWorkflowReworkRun(db, reworkRunId)).toBe(true);
    expect(await isWorkflowReworkRun(db, plainRunId)).toBe(false);
  });

  it("runMadeObservableProgress: exact run attribution — another run's artifact is NOT this run's progress", async () => {
    // 처음엔 진행 없음.
    expect(await runMadeObservableProgress(db, reworkRunId)).toBe(false);

    // 다른 run이 artifact 등록 → 이 run(reworkRunId)엔 진행으로 안 침(exact runId).
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.workflow_artifact_registered",
      entityType: "issue",
      entityId: randomUUID(),
      agentId,
      runId: otherRunId,
    });
    expect(await runMadeObservableProgress(db, reworkRunId)).toBe(false);

    // 이 run이 artifact 등록 → 진행 있음(closeout 허용).
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.workflow_artifact_registered",
      entityType: "issue",
      entityId: randomUUID(),
      agentId,
      runId: reworkRunId,
    });
    expect(await runMadeObservableProgress(db, reworkRunId)).toBe(true);
  });
});
