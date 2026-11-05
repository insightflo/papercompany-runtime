import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { agents, agentInstructionInjections, agentTaskSessions, companies, heartbeatRuns, issueExecutionCards, issues, type createDb } from "@paperclipai/db";
import { hashLoadedInstructions, loadInstructionsWithInlinedReferences } from "@paperclipai/adapter-utils/instructions";
import { buildWorkflowIssueExecutionCard } from "../../services/issue-execution-cards/builder.js";
import { hashStructuredValue } from "../../services/issue-execution-cards/hash.js";

export function createInstructionRotationFixture(getDb: () => ReturnType<typeof createDb>, getDataDir: () => string) {
  async function seedInstructionRotationFixture(input: {
    maxEstimatedChars: number;
    staleFile: boolean;
  }) {
    const db = getDb();
    const dataDir = getDataDir();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const previousRunId = randomUUID();
    const sessionId = `session-${randomUUID()}`;
    const taskKey = `issue:${issueId}`;
    const workspace = path.join(dataDir, `instruction-rotation-${randomUUID()}`);
    fs.mkdirSync(workspace, { recursive: true });
    const instructionsPath = path.join(workspace, "AGENTS.md");
    const viewedPath = path.join(workspace, "viewed.txt");
    fs.writeFileSync(instructionsPath, "FULL_INSTRUCTION_BODY_".repeat(3_000));
    fs.writeFileSync(viewedPath, "before");

    await db.insert(companies).values({
      id: companyId,
      name: "Instruction Rotation",
      issuePrefix: `IR${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Instruction Rotation Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        cwd: workspace,
        instructionsFilePath: instructionsPath,
        promptTemplate: "Continue the issue.",
      },
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: { maxEstimatedChars: input.maxEstimatedChars },
          fileViewStalenessRotation: { enabled: true },
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `IR-${issueId.slice(0, 6)}`,
      title: "Preserve full instructions across rotation",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const card = buildWorkflowIssueExecutionCard({
      title: "Preserve full instructions across rotation",
      description: "Complete the assigned work.\n[ARTIFACT]: <absolute path>",
      companyId,
      issueId,
      workflowDefinitionId: randomUUID(),
      workflowRunId: randomUUID(),
      step: { id: "work", dependencies: [], graphWorkProductRequired: true },
      isQaStep: false,
    });
    await db.insert(issueExecutionCards).values({
      companyId,
      issueId,
      contentHash: hashStructuredValue(card),
      cardJson: card,
    });
    await db.insert(heartbeatRuns).values({
      id: previousRunId,
      companyId,
      agentId,
      issueId,
      status: "succeeded",
      invocationSource: "on_demand",
      sessionIdAfter: sessionId,
      contextSnapshot: {
        taskKey,
        paperclipWorkspace: { cwd: workspace },
        paperclipFileViews: [{
          relativePath: "viewed.txt",
          contentHash: createHash("sha256").update("before").digest("hex"),
          exists: true,
        }],
      },
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: new Date("2026-01-01T00:01:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:01:00.000Z"),
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey,
      sessionParamsJson: { sessionId, cwd: workspace },
      sessionDisplayId: sessionId,
      lastRunId: previousRunId,
    });
    const loaded = await loadInstructionsWithInlinedReferences(instructionsPath);
    const contentHash = hashLoadedInstructions(loaded);
    await db.insert(agentInstructionInjections).values({
      companyId,
      issueId,
      agentId,
      adapterType: "codex_local",
      instructionsPath,
      contentHash,
      injectionCount: 1,
      lastInjectionJson: {
        entryPath: loaded.entryPath,
        includedPaths: loaded.includedPaths,
        deferredPaths: loaded.deferredPaths,
        warnings: loaded.warnings,
        contentHash,
        providerSessionId: sessionId,
        deliveryToken: "seed-delivery",
        mode: "full",
        deliveredAt: "2026-01-01T00:01:00.000Z",
      },
    });
    if (input.staleFile) fs.writeFileSync(viewedPath, "after");
    return { agentId, issueId, taskKey };
  }
  return seedInstructionRotationFixture;
}
