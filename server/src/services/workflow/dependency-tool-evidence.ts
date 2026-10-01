import { and, eq, inArray, isNull } from "drizzle-orm";
import { workflowStepRuns, type Db } from "@paperclipai/db";
import { readWorkflowToolArtifactPath } from "./tool-artifact-path.js";
import { readSeededStepProducts } from "./workflow-seed-evidence.js";

/** Display/input projection only; verified seeds retain their source product identity. */
export async function dependencyToolEvidence(db: Db, input: { companyId: string; runId: string; stepIds: string[] }) {
  const rows = input.stepIds.length ? await db.select({ id: workflowStepRuns.id, stepId: workflowStepRuns.stepId, metadata: workflowStepRuns.metadata })
    .from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, input.runId), inArray(workflowStepRuns.stepId, input.stepIds),
      isNull(workflowStepRuns.issueId), eq(workflowStepRuns.status, "completed"))) : [];
  const refs: Array<{ type: "dependency_work_product" | "dependency_tool_artifact"; id: string; path: string; description: string }> = [];
  for (const row of rows) {
    const seeded = await readSeededStepProducts(db, { companyId: input.companyId, workflowRunId: input.runId, stepId: row.stepId });
    if (seeded) {
      refs.push(...seeded.map(s => ({ type: "dependency_work_product" as const, id: s.product.id, path: s.file,
        description: `Board-approved source workProduct for step ${row.stepId}: ${s.product.title}` })));
      continue;
    }
    const file = readWorkflowToolArtifactPath(row.metadata.toolResult);
    if (file) refs.push({ type: "dependency_tool_artifact", id: row.id, path: file,
      description: `Workflow tool artifact from step ${row.stepId}` });
  }
  return refs;
}
