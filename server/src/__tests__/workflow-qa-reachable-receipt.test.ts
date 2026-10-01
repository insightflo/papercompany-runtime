import { writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { workflowStepRuns } from "@paperclipai/db";

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../services/public-https-request.js", () => ({ requestPublicHttps: transport.request }));
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { fixture, database } from "./helpers/qa-receipt-fixture.js";

it.each([true, false])("awaits link reachability (%s) before accepting a byte-bound receipt", async reachable => {
  const f = await fixture();
  transport.request.mockReset().mockResolvedValue({ ok: reachable, status: reachable ? 200 : 404, text: "" });
  await writeFile(f.content, JSON.stringify({ title: "Report", source: "https://example.org/article",
    blocks: [{ type: "image", assetFile: "hero.png" }] }));
  await database().update(workflowStepRuns).set({ metadata: { artifactExecution: freezeArtifactAttempt({
    adapterConfig: f.adapterConfig, step: { qaConfig: { rules: { "links-reachable": {} } } },
    executionGeneration: 2, requestId: f.requestId,
  }) } }).where(eq(workflowStepRuns.id, f.qaId));
  const result = await f.invoke();
  expect(transport.request).toHaveBeenCalledTimes(1);
  expect(transport.request.mock.calls[0][0]).toBe("https://example.org/article");
  if (reachable) {
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.toolArtifactReceipt?.runtimeChecks).toContainEqual({ id: "links-reachable", ok: true, severity: "error" });
  } else {
    expect(result.status).toBe(500); // Existing executor maps failed tool/QA verification to 500.
    expect(result.body.error).toContain("qa_artifact_runtime_checks_failed:links-reachable");
    expect(result.toolArtifactReceipt).toBeUndefined();
  }
});
