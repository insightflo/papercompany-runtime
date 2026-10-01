import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, qualityReviewItems, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedQaSourceDefectScenario } from "./helpers/qa-source-defect-seed.js";
import { applyBackEdgeReworkPass } from "../services/workflow/control-flow/loop-driver.js";

let db: ReturnType<typeof createDb>;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("delivery-finding-"); db = createDb(temp.connectionString); }, 60000);
afterAll(async () => { await db?.$client.end({ timeout: 5 }); await temp?.cleanup(); });
// Removing the explicit required-policy branch loses durable quality findings for content QA.
it.each([
  { qaType: "content", deliveryVerification: "required", expected: 1 },
  { qaType: "delivery", expected: 1 },
  { qaType: "content", deliveryRole: "publication-verify", expected: 1 },
  { qaType: "content", expected: 0 },
])("records delivery quality findings only for declared delivery QA: %j", async ({ expected, ...policy }) => {
  const f = await seedQaSourceDefectScenario(db, [{ id: "layout", summary: "Layout defect", layer: "artifact" }]);
  const steps = f.steps.map(step => step.id === "qa-validate" ? { ...step, type: "qa", ...policy } : step);
  const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, f.runId));
  const result = await applyBackEdgeReworkPass({ db,
    run: { id: f.runId, companyId: f.companyId, status: "running", missionId: f.missionId }, steps, stepRuns,
    predsByStepId: new Map([["qa-validate", { status: "failed", isQaGate: true, verdict: "request_changes" }]]) });
  expect(result.reworkedCount).toBe(1);
  const findings = await db.select().from(qualityReviewItems).where(eq(qualityReviewItems.companyId, f.companyId));
  expect(findings).toHaveLength(expected);
  if (expected) expect(findings[0]).toMatchObject({ companyId: f.companyId, missionId: f.missionId,
    title: "Delivery verification failed: qa-validate", triggerSource: "delivery_verification",
    triggerMetadata: { workflowRunId: f.runId, qaStepId: "qa-validate", qaIssueId: f.qaIssueId, producerStepId: "produce" } });
});
