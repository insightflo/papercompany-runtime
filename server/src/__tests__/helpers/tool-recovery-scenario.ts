import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  issueComments,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import type { createDb } from "@paperclipai/db";
import { captureExecutionDefinition } from "../../services/workflow/execution-definition.js";

const FAILED_STARTED_AT = new Date("2026-07-06T04:52:47.000Z");
const FAILED_COMPLETED_AT = new Date("2026-07-06T04:56:23.000Z");

type TestDb = ReturnType<typeof createDb>;

export type ToolRecoveryScenario = {
  readonly artifactPath: string;
  readonly companyId: string;
  readonly missionId: string;
  readonly ownerAgentId: string;
  readonly oversightIssueId: string;
  readonly recoveryIssueId: string;
  readonly stepRunId: string;
  readonly downstreamStepRunId: string;
  readonly tempRoot: string;
  readonly workflowRunId: string;
};

export async function seedToolRecoveryScenario(input: {
  readonly db: TestDb;
  readonly artifactExists: boolean;
  /** Opt-in only: capture a REAL execution-definition snapshot while the run is still
   * pending/not started, then restore the intended failed facts. Default false keeps
   * the legacy unmarked run for every existing caller. */
  readonly captureExecutionDefinitionSnapshot?: boolean;
}): Promise<ToolRecoveryScenario> {
  const companyId = randomUUID();
  const ownerAgentId = randomUUID();
  const missionId = randomUUID();
  const workflowId = randomUUID();
  const workflowRunId = randomUUID();
  const stepRunId = randomUUID();
  const downstreamStepRunId = randomUUID();
  const oversightIssueId = randomUUID();
  const recoveryIssueId = randomUUID();
  // macOS tmpdir(/var/folders)는 realpath 시 /private/var/folders 로 달라져 artifact 루트
  // canonical 검증(artifact-files.ts captureArtifactRoot)이 거부한다. 생성 직후 realpath 로
  // 정규화해 artifactPath/기록/DB 사실 전부 canonical 경로에서 파생한다.
  const tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "tool-recovery-result-")));
  const artifactPath = path.join(tempRoot, "us-stockflow_latest.json");
  if (input.artifactExists) {
    writeFileSync(artifactPath, JSON.stringify({ status: "success" }));
  }

  await input.db.insert(companies).values({
    id: companyId,
    name: "Tool Recovery Result Company",
    issuePrefix: `TR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await input.db.insert(agents).values({
    id: ownerAgentId,
    companyId,
    name: "Main Executor",
    role: "operator",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await input.db.insert(missions).values({
    id: missionId,
    companyId,
    ownerAgentId,
    title: "Issue-less tool recovery result mission",
    status: "active",
  });
  await input.db.insert(issues).values([
    {
      id: oversightIssueId,
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_oversight",
      status: "todo",
      title: "[OVERSIGHT] tool recovery",
    },
    {
      id: recoveryIssueId,
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_unblock",
      originId: oversightIssueId,
      status: "done",
      title: "[Owner Action] Tool step failed: collect-us-stockflow",
      description: `<!-- tool-step-recovery:${workflowRunId}:collect-us-stockflow -->`,
    },
  ]);
  await input.db.insert(workflowDefinitions).values({
    id: workflowId,
    companyId,
    name: "gazua-morning",
    stepsJson: [
      {
        id: "collect-us-stockflow",
        name: "Collect US stockflow",
        type: "tool",
        dependencies: [],
        toolNames: ["collect-us-stockflow"],
      },
      {
        id: "summarize-stockflow",
        name: "Summarize stockflow",
        type: "agent",
        agentId: ownerAgentId,
        dependencies: ["collect-us-stockflow"],
      },
    ],
  });
  await input.db.insert(workflowRuns).values(input.captureExecutionDefinitionSnapshot
    ? {
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "test",
      status: "pending",
      startedAt: null,
      completedAt: null,
      metadata: { executionDefinitionVersion: 1 },
    }
    : {
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "test",
      status: "failed",
      startedAt: FAILED_STARTED_AT,
      completedAt: FAILED_COMPLETED_AT,
    });
  if (input.captureExecutionDefinitionSnapshot) {
    // Real capture path: the production invariant is "snapshot only inside run creation
    // while pending". Capture here with the real service, then restore the intended
    // failed facts BEFORE any execution or assertion can observe the pending window.
    await input.db.transaction((tx) => captureExecutionDefinition(tx, workflowRunId));
    await input.db.update(workflowRuns).set({
      status: "failed",
      startedAt: FAILED_STARTED_AT,
      completedAt: FAILED_COMPLETED_AT,
    }).where(eq(workflowRuns.id, workflowRunId));
  }
  await input.db.insert(workflowStepRuns).values([
    {
      id: stepRunId,
      workflowRunId,
      stepId: "collect-us-stockflow",
      issueId: null,
      status: "failed",
      startedAt: new Date("2026-07-06T04:52:47.000Z"),
      completedAt: new Date("2026-07-06T04:56:23.000Z"),
      lastDispatchErrorSummary: "missing env root",
      metadata: {
        toolResult: {
          toolName: "collect-us-stockflow",
          success: false,
          error: "missing env root",
        },
      },
    },
    {
      id: downstreamStepRunId,
      workflowRunId,
      stepId: "summarize-stockflow",
      issueId: null,
      status: "skipped",
      startedAt: null,
      completedAt: new Date("2026-07-06T04:56:23.000Z"),
    },
  ]);
  await input.db.insert(issueComments).values({
    companyId,
    issueId: recoveryIssueId,
    authorAgentId: ownerAgentId,
    body: [
      "### Native tool step recovery result",
      "Status: success",
      "Exit code: 0",
      `Artifact: ${artifactPath}`,
      `[ARTIFACT]: ${artifactPath}`,
    ].join("\n"),
  });

  return {
    artifactPath,
    companyId,
    missionId,
    ownerAgentId,
    oversightIssueId,
    recoveryIssueId,
    stepRunId,
    downstreamStepRunId,
    tempRoot,
    workflowRunId,
  };
}

export async function loadToolRecoveryScenarioRows(
  db: TestDb,
  scenario: ToolRecoveryScenario,
) {
  const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, scenario.workflowRunId));
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, scenario.workflowRunId));
  const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, scenario.recoveryIssueId));

  return { stepRuns, run, commentText: comments.map((comment) => comment.body).join("\n") };
}
