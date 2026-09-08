import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, issues, workflowStepRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { seedRunInputWorkflow } from "./helpers/workflow-run-input-fixture.js";
import { workflowService } from "../services/workflow/engine.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";

// workflow-manual-run-mission-label.test.ts와 동일한 wakeup-mock 경계(실제 엔진 사용).
const { heartbeatWakeup } = vi.hoisted(() => ({
  heartbeatWakeup: vi.fn(),
}));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({
      wakeup: heartbeatWakeup,
    }),
  };
});

vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (
      input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0],
    ) => actual.queueIssueAssignmentWakeup({
      ...input,
      heartbeat: { wakeup: heartbeatWakeup },
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping workflow run input template tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

const templateMetadata = { enabled: false, tags: [], sections: ["manuals", "concepts"] };

describeEP("workflow run input string templates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wf-run-input-templates-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => {
    heartbeatWakeup.mockReset();
    heartbeatWakeup.mockResolvedValue({ id: "test-wakeup" });
  });

  afterAll(async () => {
    try { await db?.$client.end({ timeout: 5 }); }
    finally { await tempDb?.cleanup(); }
  });

  it("stringifies typed JSONB run metadata values into tool step args templates", async () => {
    const args = await resolveWorkflowToolStepArgs({
      db,
      run: { id: "00000000-0000-4000-8000-00000000aa01", companyId: "00000000-0000-4000-8000-00000000aa02", metadata: templateMetadata },
      step: {
        id: "tool",
        toolArgs: {
          enabled: "{$runMetadata.enabled}",
          tags: "{$runMetadata.tags}",
          sections: "{$runMetadata.sections}",
        },
      },
      workflowSteps: [],
    });
    expect(args).toEqual({ enabled: "false", tags: "[]", sections: '["manuals","concepts"]' });
  });

  it("renders typed run metadata into the real agent-step issue title and description", async () => {
    const seed = await seedRunInputWorkflow(db, [
      { key: "enabled", type: "switch" },
      { key: "tags", type: "checkbox", required: false, options: [{ value: "a", label: "A" }] },
      { key: "sections", type: "checkbox", required: false, options: [{ value: "manuals", label: "매뉴얼" }, { value: "concepts", label: "개념 설명" }] },
    ]);
    await workflowService.updateDefinition(db, seed.workflowId, {
      steps: [{
        id: "collect",
        name: "Enabled {$runMetadata.enabled}",
        description: "Tags {$runMetadata.tags}; sections {$runMetadata.sections}; absent stays {$runMetadata.absent}",
        agentId: seed.agentId,
        dependencies: [],
      }],
    });

    const result = await workflowService.trigger(db, {
      companyId: seed.companyId,
      workflowId: seed.workflowId,
      triggeredBy: "board",
      metadata: templateMetadata,
    });
    expect(result.status).toBe("running");

    const stepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, result.runId))
      .then((rows) => rows[0] ?? null);
    expect(stepRun?.issueId).toBeTruthy();
    const createdIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdIssue?.title).toBe("Enabled false");
    expect(createdIssue?.description).toContain('Tags []; sections ["manuals","concepts"]');
    expect(createdIssue?.description).toContain("absent stays {$runMetadata.absent}");
  });
});
