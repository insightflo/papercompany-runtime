import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, issueComments, issueWorkProducts } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  handleDelegatedArtifactHandback,
} from "../services/delegated-artifact-handback.js";
import {
  captureWakeups,
  clearDelegatedArtifactHandbackTestData,
  seedDelegatedArtifactCase,
} from "./helpers/delegated-artifact-handback-fixture.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping delegated artifact handback tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("delegated artifact handback", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delegated-artifact-handback-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await clearDelegatedArtifactHandbackTestData(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("wakes the parent workflow issue when a child issue has the active artifact", async () => {
    const seeded = await seedDelegatedArtifactCase(db);
    const { heartbeat, wakeups } = captureWakeups();

    const result = await handleDelegatedArtifactHandback({
      db,
      heartbeat,
      childIssueId: seeded.childIssueId,
      childWorkProductId: seeded.childWorkProductId,
      requestedByActorType: "system",
      requestedByActorId: "test",
    });

    expect(result).toMatchObject({
      status: "handled",
      parentIssueId: seeded.parentIssueId,
      childIssueId: seeded.childIssueId,
      childWorkProductId: seeded.childWorkProductId,
      workflowRunId: seeded.workflowRunId,
      workflowStepRunId: seeded.parentStepRunId,
      wakeupRequested: true,
    });
    expect(wakeups).toHaveLength(1);
    const wakeup = wakeups[0];
    if (!wakeup) throw new Error("Expected a captured wakeup");
    expect(wakeup.agentId).toBe(seeded.assigneeAgentId);
    expect(wakeup.opts.reason).toBe("workflow_step_runnable");
    expect(wakeup.opts.idempotencyKey).toContain("delegated-artifact-handback:");
    expect(wakeup.opts.payload).toEqual(expect.objectContaining({
      issueId: seeded.parentIssueId,
      mutation: "workflow_resume",
      workflowRunId: seeded.workflowRunId,
      workflowStepRunId: seeded.parentStepRunId,
      childIssueId: seeded.childIssueId,
      childWorkProductId: seeded.childWorkProductId,
    }));
    expect(wakeup.opts.contextSnapshot).toEqual(expect.objectContaining({
      issueId: seeded.parentIssueId,
      source: "delegated_artifact_handback",
      workflowRunId: seeded.workflowRunId,
      workflowStepRunId: seeded.parentStepRunId,
    }));

    const parentProducts = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, seeded.parentIssueId));
    expect(parentProducts).toHaveLength(0);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.parentIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Delegated artifact ready");
    expect(comments[0]?.body).toContain("GAZ-261");
    expect(comments[0]?.body).not.toContain("/srv/papercompany");
  });

  it("is idempotent without parsing parent comments", async () => {
    const seeded = await seedDelegatedArtifactCase(db);
    const { heartbeat, wakeups } = captureWakeups();

    await handleDelegatedArtifactHandback({
      db,
      heartbeat,
      childIssueId: seeded.childIssueId,
      childWorkProductId: seeded.childWorkProductId,
    });
    const duplicate = await handleDelegatedArtifactHandback({
      db,
      heartbeat,
      childIssueId: seeded.childIssueId,
      childWorkProductId: seeded.childWorkProductId,
    });

    expect(duplicate).toEqual({ status: "skipped", reason: "already_dispatched" });
    expect(wakeups).toHaveLength(1);
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.parentIssueId));
    expect(comments).toHaveLength(1);
  });

  it("does not hand back when the parent already has an active workProduct", async () => {
    const seeded = await seedDelegatedArtifactCase(db, { parentHasWorkProduct: true });
    const { heartbeat, wakeups } = captureWakeups();

    const result = await handleDelegatedArtifactHandback({
      db,
      heartbeat,
      childIssueId: seeded.childIssueId,
      childWorkProductId: seeded.childWorkProductId,
    });

    expect(result).toEqual({ status: "skipped", reason: "parent_has_active_work_product" });
    expect(wakeups).toHaveLength(0);
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.parentIssueId));
    expect(comments).toHaveLength(0);
  });

  it("does not hand back to a non-workflow parent issue", async () => {
    const seeded = await seedDelegatedArtifactCase(db, { parentOriginKind: "manual" });
    const { heartbeat, wakeups } = captureWakeups();

    const result = await handleDelegatedArtifactHandback({
      db,
      heartbeat,
      childIssueId: seeded.childIssueId,
      childWorkProductId: seeded.childWorkProductId,
    });

    expect(result).toEqual({ status: "skipped", reason: "parent_not_workflow_execution" });
    expect(wakeups).toHaveLength(0);
  });
});
