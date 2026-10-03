import type { z } from "zod";
import type { workProductProducerSchema } from "@paperclipai/shared/validators/workflow-artifact";
import type { workflowRuns, workflowStepRuns, issueWorkProducts } from "@paperclipai/db";

/** Exact original selector comparisons, reusable for diagnostics. Does not validate heartbeat/bytes. */
export function workProductProducerMismatches(p: z.infer<typeof workProductProducerSchema>, input: {
  companyId: string; workflowRunId: string;
  run: Pick<typeof workflowRuns.$inferSelect, "missionId">;
  step: Pick<typeof workflowStepRuns.$inferSelect, "id" | "stepId" | "executionGeneration" | "retryCount" | "iterationIndex">;
  product: Pick<typeof issueWorkProducts.$inferSelect, "sourceExecutionGeneration" | "createdByRunId">;
}): string[] {
  const s = input.step;
  return ([
    ["companyId", p.companyId, input.companyId], ["missionId", p.missionId, input.run.missionId],
    ["workflowRunId", p.workflowRunId, input.workflowRunId], ["stepRunId", p.stepRunId, s.id], ["stepId", p.stepId, s.stepId],
    ["executionGeneration", p.executionGeneration, s.executionGeneration], ["retryCount", p.retryCount, s.retryCount],
    ["iterationIndex", p.iterationIndex, s.iterationIndex],
    ["sourceExecutionGeneration", input.product.sourceExecutionGeneration, s.executionGeneration],
    ["createdByRunId", input.product.createdByRunId, p.heartbeatRunId],
  ] as const).filter(([, actual, expected]) => actual !== expected).map(([field]) => field);
}
