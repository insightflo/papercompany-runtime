import { and, desc, eq, gte, ne } from "drizzle-orm";
import type { Db, workflowDefinitions } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { WorkflowStep } from "./dag-engine.js";
import { stableJson, isCacheEnabled, getCacheTtlSeconds } from "./dag-tool-cache-helpers.js";
import { getMetadataRecord } from "./dag-metadata-helpers.js";

export async function findCachedToolStepRun(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  toolName: string;
  args: unknown;
  now: Date;
}): Promise<typeof workflowStepRuns.$inferSelect | null> {
  if (!isCacheEnabled(input.step)) return null;

  const ttlSeconds = getCacheTtlSeconds(input.step);
  const cutoff = ttlSeconds ? new Date(input.now.getTime() - ttlSeconds * 1000) : null;
  const conditions = [
    eq(workflowRuns.companyId, input.run.companyId),
    eq(workflowRuns.workflowId, input.definition.id),
    ne(workflowRuns.id, input.run.id),
    eq(workflowStepRuns.stepId, input.step.id),
    eq(workflowStepRuns.status, "completed"),
    ...(cutoff ? [gte(workflowStepRuns.completedAt, cutoff)] : []),
  ];
  const rows = await input.db
    .select({ stepRun: workflowStepRuns })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(and(...conditions))
    .orderBy(desc(workflowStepRuns.completedAt))
    .limit(25);
  const argsKey = stableJson(input.args);

  for (const row of rows) {
    const invocation = getMetadataRecord(row.stepRun.metadata, "toolInvocation");
    const result = getMetadataRecord(row.stepRun.metadata, "toolResult");
    if (result.success !== true) continue;
    if (invocation.toolName !== input.toolName) continue;
    if (stableJson(invocation.args ?? {}) !== argsKey) continue;
    return row.stepRun;
  }

  return null;
}

export async function getRunningConcurrencyCount(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  stepRun: typeof workflowStepRuns.$inferSelect;
  concurrencyKey: string;
}): Promise<number> {
  const rows = await input.db
    .select({ stepRun: workflowStepRuns })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(and(
      eq(workflowRuns.companyId, input.run.companyId),
      eq(workflowStepRuns.status, "running"),
      ne(workflowStepRuns.id, input.stepRun.id),
    ));
  return rows.filter((row) => {
    const controls = getMetadataRecord(row.stepRun.metadata, "executionControls");
    return controls.concurrencyKey === input.concurrencyKey;
  }).length;
}
