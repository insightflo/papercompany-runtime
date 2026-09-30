import path from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { workflowStepRuns } from "@paperclipai/db";
import { expect, it } from "vitest";
import { database, fixture } from "../helpers/qa-receipt-fixture.js";
import { prepareQaConsumer } from "../../services/workflow/qa-artifact-consumer.js";
import { randomUUID } from "node:crypto";

it("actual QA accepts two filename identities with identical bytes and runtime consumes both", async () => {
  const script = process.env.OVERSIGHT_QA_PRODUCER;
  if (!script) throw new Error("OVERSIGHT_QA_PRODUCER required (real QA script)");
  const f = await fixture(script), db = database();
  const bytes = await readFile(path.join(f.assetsDir, "hero.png"));
  await writeFile(path.join(f.assetsDir, "copy.png"), bytes);
  await writeFile(f.content, JSON.stringify({ title: "Title", summary: "Summary", tags: ["one", "two", "three"],
    blocks: [{ type: "image", assetFile: "hero.png" }, { type: "image", assetFile: "copy.png" }] }));
  const qa = await f.invoke();
  expect(qa.status, JSON.stringify(qa.body)).toBe(200);
  expect(qa.toolArtifactReceipt!.input.assetManifest.map(a => a.fileName).sort()).toEqual(["copy.png", "hero.png"]);
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  await db.update(workflowStepRuns).set({ status: "completed", metadata: { ...step.metadata, toolArtifactReceipt: qa.toolArtifactReceipt } })
    .where(eq(workflowStepRuns.id, f.qaId));
  const id = randomUUID();
  await db.insert(workflowStepRuns).values({ id, workflowRunId: f.runId, stepId: "publish", status: "running", lastDispatchRequestId: "publish-1" });
  const consumer = await prepareQaConsumer({ db, companyId: f.companyId, workflowRunId: f.runId, stepRunId: id,
    stepId: "publish", requestId: "publish-1", parameters: { sourceContentPath: f.content,
      qaResultPath: path.join(qa.toolArtifactReceipt!.outputRoot, "qa-result.json") } });
  const transported = JSON.parse(consumer.inputBytes!.toString());
  expect(transported.assets.map((a: { fileName: string }) => a.fileName).sort()).toEqual(["copy.png", "hero.png"]);
  expect(transported.assets[0].base64).toBe(transported.assets[1].base64);
});
