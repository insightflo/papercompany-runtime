// @vitest-environment node
// [descope v1] claimChildInvocation / adoptChildForWaitingStep 의 새 API 계약 전용 스위트.
//   클레임: created→reused 멱등, tombstone(재생성 금지), invalid-state(retryCount/workflowRetry/
//   generation !=1 — 변이 전 fail-closed), cap(자식 상태 무관 커밋된 invocation 5개).
//   adoption: 표시 프로젝션 전용 — 무관한 메타데이터 보존, 관측 스냅숏 엄격 일치, 완료 없음,
//   materialized 자식 재실행 없음.
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  issueComments,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow child-step tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

import { agents } from "@paperclipai/db";
import { adoptChildForWaitingStep } from "../services/workflow/workflow-child-execution.js";
import { claimChildInvocation } from "../services/workflow/workflow-child-invocation-claim.js";
import {
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
  insertRunWithWorkflowStepRun,
  insertStepRunForRun,
} from "./helpers/workflow-child-fixtures.js";
import {
  insertLinkedInvocation,
  insertMaterializedChildRun,
  insertTombstoneInvocation,
} from "./helpers/workflow-child-invocation-fixtures.js";

let db: Awaited<ReturnType<typeof createDb>>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

describeEmbeddedPostgres("workflow-child claim/adoption contract", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-child-claim-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowStepInvocations);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setupParent(stepOverrides: { retryCount?: number; metadata?: Record<string, unknown> } = {}) {
    const companyId = await createCompanyFixture(`Claim Co ${Math.random().toString(36).slice(2, 8)}`);
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [{ id: "run-child", name: "Run child", type: "workflow", dependencies: [], targetWorkflowId: childDefId }],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({
      companyId,
      workflowId: parentDefId,
      ...stepOverrides,
    });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const claimInput = {
      companyId,
      run,
      parentStepRunId: stepRunId,
      stepId: "run-child",
      generation: 1 as const,
      targetWorkflowId: childDefId,
      renderedInputs: {},
      now: new Date(),
    };
    return { companyId, childDefId, parentDefId, runId, stepRunId, claimInput };
  }

  it("claims once (created) and reuses the same linked child on re-claim", async () => {
    const { claimInput } = await setupParent();
    const first = await claimChildInvocation(db, claimInput);
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") return;
    expect(first.generation).toBe(1);
    const second = await claimChildInvocation(db, claimInput);
    expect(second.outcome).toBe("reused");
    if (second.outcome !== "reused") return;
    expect(second.invocationId).toBe(first.invocationId);
    expect(second.childRunId).toBe(first.childRunId);
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(1);
  });

  it("returns tombstone for a deleted-child invocation and never recreates the child", async () => {
    const { companyId, childDefId, runId, stepRunId, claimInput } = await setupParent();
    await insertTombstoneInvocation(db, { companyId, parentStepRunId: stepRunId, targetWorkflowId: childDefId });
    const claim = await claimChildInvocation(db, claimInput);
    expect(claim).toEqual(expect.objectContaining({ outcome: "tombstone", generation: 1 }));
    // D4 — 재생성 금지: 자식 run 행이 새로 생기지 않는다.
    const childRuns = await db.select().from(workflowRuns)
      .where(eq(workflowRuns.parentRunId, runId));
    expect(childRuns).toHaveLength(0);
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(1);
  });

  it.each([
    ["nonzero retryCount", { retryCount: 1, metadata: undefined }],
    ["workflowRetry metadata key", { retryCount: 0, metadata: { workflowRetry: null } }],
  ])("refuses claim with invalid parent step state (%s) — rows unchanged", async (_label, overrides) => {
    const { claimInput } = await setupParent(overrides);
    const claim = await claimChildInvocation(db, claimInput);
    expect(claim).toEqual(expect.objectContaining({ outcome: "invalid-state" }));
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
    const childRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.triggerSource, "workflow"));
    expect(childRuns).toHaveLength(0);
  });

  it("refuses a generation other than 1 before any mutation", async () => {
    const { claimInput } = await setupParent();
    const claim = await claimChildInvocation(db, { ...claimInput, generation: 2 as unknown as 1 });
    expect(claim).toEqual(expect.objectContaining({ outcome: "invalid-state" }));
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
  });

  it("cap: 5 committed invocations on pending steps (any child state) reject the 6th claim", async () => {
    const { companyId, childDefId, runId, claimInput } = await setupParent();
    for (let i = 0; i < 5; i += 1) {
      const siblingStepRunId = await insertStepRunForRun({ runId, stepId: `sibling-${i}` });
      if (i % 2 === 0) {
        // materialized 자식 — cap 은 adoption/자식 상태를 구분하지 않는다.
        await insertMaterializedChildRun(db, {
          companyId, parentRunId: runId, parentStepRunId: siblingStepRunId, childWorkflowId: childDefId,
        });
      } else {
        await insertLinkedInvocation(db, {
          companyId, parentRunId: runId, parentStepRunId: siblingStepRunId, childWorkflowId: childDefId,
        });
      }
    }
    const claim = await claimChildInvocation(db, claimInput);
    expect(claim).toEqual(expect.objectContaining({ outcome: "cap-exceeded" }));
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(5);
  });

  it("adoption is projection-only: preserves unrelated metadata, never completes the step", async () => {
    const { companyId, childDefId, runId, stepRunId } = await setupParent();
    const identity = await insertLinkedInvocation(db, {
      companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId,
    });
    await db.update(workflowStepRuns).set({ metadata: { operatorNote: "keep-me" } })
      .where(eq(workflowStepRuns.id, stepRunId));
    const adopted = await adoptChildForWaitingStep(db, {
      identity,
      observedMetadata: { operatorNote: "keep-me" },
      now: new Date(),
    });
    expect(adopted).toBe(true);
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(step?.status).toBe("pending"); // 완료 없음(D1 — fire 즉시완료 삭제)
    const metadata = step?.metadata as Record<string, unknown>;
    expect(metadata.operatorNote).toBe("keep-me");
    expect(metadata.workflowChild).toEqual(expect.objectContaining({
      childRunId: identity.childRunId,
      invocationId: identity.invocationId,
      generation: 1,
    }));
  });

  it("stale observed metadata loses the adoption CAS; fresh observation succeeds", async () => {
    const { companyId, childDefId, runId, stepRunId } = await setupParent();
    const identity = await insertLinkedInvocation(db, {
      companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId,
    });
    await db.update(workflowStepRuns).set({ metadata: { note: "original" } })
      .where(eq(workflowStepRuns.id, stepRunId));
    const stale = await adoptChildForWaitingStep(db, {
      identity,
      observedMetadata: { note: "drifted" },
      now: new Date(),
    });
    expect(stale).toBe(false);
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect((step?.metadata as Record<string, unknown>).workflowChild).toBeUndefined();
    const fresh = await adoptChildForWaitingStep(db, {
      identity,
      observedMetadata: step?.metadata ?? null,
      now: new Date(),
    });
    expect(fresh).toBe(true);
  });

  it("adopting a materialized child only writes the projection — child execution state untouched", async () => {
    const { companyId, childDefId, runId, stepRunId } = await setupParent();
    const identity = await insertMaterializedChildRun(db, {
      companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId,
    });
    const [childBefore] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, identity.childRunId));
    const childStepsBefore = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, identity.childRunId));
    const adopted = await adoptChildForWaitingStep(db, {
      identity,
      observedMetadata: null,
      now: new Date(),
    });
    expect(adopted).toBe(true);
    const [childAfter] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, identity.childRunId));
    expect(childAfter?.status).toBe(childBefore?.status);
    expect(childAfter?.childStartToken).toBe(childBefore?.childStartToken);
    expect(childAfter?.childStartLeaseExpiresAt).toEqual(childBefore?.childStartLeaseExpiresAt);
    expect(childAfter?.childStartMaterializedAt).toEqual(childBefore?.childStartMaterializedAt);
    const childStepsAfter = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, identity.childRunId));
    expect(childStepsAfter).toHaveLength(childStepsBefore.length);
  });
});
