import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, companies, createDb, missions, toolDefinitions, workflowRuns, workflowStepInvocations,
  workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { missionService } from "../services/missions.js";
import { resolveDevTsxLoaderPath } from "../services/plugin-loader.js";
import { workflowService } from "../services/workflow/engine.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor, syncWorkflowRunState } from "../services/workflow/dag-engine.js";

let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => {
  pg = await startEmbeddedPostgresTestDatabase("t16a-child-consume-");
  db = createDb(pg.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "t16a-child-consume-")));
  setWorkflowToolStepExecutor(async request => {
    const result = await executeCoreWorkflowTool({ db, companyId: request.companyId, agentId: request.agentId,
      agentName: request.agentName, toolName: request.toolName, parameters: request.args ?? {}, requestId: request.requestId,
      workflowRunId: request.workflowRunId, stepRunId: request.stepRunId, stepId: request.stepId });
    await completeWorkflowToolStepFromResult(db, { companyId: request.companyId, workflowRunId: request.workflowRunId,
      stepRunId: request.stepRunId, stepId: request.stepId, requestId: request.requestId, toolName: request.toolName,
      success: result.status === 200, stdout: result.body.content ?? "", data: result.body.data,
      artifactPath: result.artifactPath, toolArtifactReceipt: result.toolArtifactReceipt,
      stderr: result.body.stderr ?? "", error: result.body.error });
    return { accepted: true as const };
  });
}, 60_000);
afterAll(async () => {
  setWorkflowToolStepExecutor(null);
  await db?.$client.end({ timeout: 5 });
  await pg?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
}, 60_000);

it("retains a child workflow file and runs the existing downstream consumer exactly once before mission completion", async () => {
  const companyId = randomUUID(), agentId = randomUUID();
  const source = path.join(root, `${companyId}-source.json`), consumed = path.join(root, `${companyId}-consumed.json`);
  const calls = path.join(root, `${companyId}-calls.txt`), writer = path.join(root, `${companyId}-writer.mjs`), reader = path.join(root, `${companyId}-reader.mjs`);
  const bytes = Buffer.from('{"source":"child-workflow","revision":1}');
  const digest = createHash("sha256").update(bytes).digest("hex");
  const loader = resolveDevTsxLoaderPath();
  if (!loader) throw new Error("Existing tsx loader is unavailable");
  const fileModule = new URL("../services/workflow/artifact-files.ts", import.meta.url).href;
  const writerModule = new URL("../services/workflow/artifact-writer.ts", import.meta.url).href;
  await writeFile(writer, `import fs from 'node:fs';
import { captureArtifactRoot } from ${JSON.stringify(fileModule)};
import { writeArtifactFile } from ${JSON.stringify(writerModule)};
fs.appendFileSync(${JSON.stringify(calls)},'write\\n');
await writeArtifactFile(await captureArtifactRoot(${JSON.stringify(root)}), ${JSON.stringify(path.basename(source))},
  Buffer.from(${JSON.stringify(bytes.toString("base64"))}, 'base64'));
console.log(JSON.stringify({artifactPath:${JSON.stringify(source)}}));`);
  await writeFile(reader, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(calls)},'read\\n');
fs.writeFileSync(${JSON.stringify(consumed)},fs.readFileSync(${JSON.stringify(source)}));console.log(JSON.stringify({ok:true}));`);
  await db.insert(companies).values({ id: companyId, name: "Child acceptance", issuePrefix: `D${companyId.replaceAll("-", "").slice(0, 7)}`,
    timezone: "Asia/Seoul", workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner", status: "paused" });
  await db.insert(toolDefinitions).values([
    { companyId, name: "write-child-file", adapterType: "builtin", adapterConfig: { command: `"${process.execPath}" --import "${loader}" "${writer}"`, workingDirectory: root } },
    { companyId, name: "consume-child-file", adapterType: "builtin", adapterConfig: { command: `${process.execPath} ${reader}`, workingDirectory: root } },
  ]);
  const child = await workflowService.createDefinition(db, { companyId, name: "Producer child", status: "active",
    steps: [{ id: "write", name: "Write", type: "tool", agentId: "", dependencies: [], toolNames: ["write-child-file"], toolArgs: {} }] });
  const parent = await workflowService.createDefinition(db, { companyId, name: "Child then consume", status: "active",
    steps: [
      { id: "run-child", name: "Child", type: "workflow", agentId: "", dependencies: [], targetWorkflowId: child.id },
      { id: "consume", name: "Consume", type: "tool", agentId: "", dependencies: ["run-child"], toolNames: ["consume-child-file"], toolArgs: {} },
    ] });
  const result = await workflowService.trigger(db, { companyId, workflowId: parent.id, triggeredBy: "board", triggerSource: "api" });
  expect(result.missionId).toBeTruthy();
  for (let i = 0; i < 8; i++) {
    await processQueuedWorkflowToolStepRuns(db);
    await syncWorkflowRunState(db, result.runId);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.runId));
    if (run?.status === "completed") break;
  }
  const parentSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, result.runId));
  const childParentStep = parentSteps.find(step => step.stepId === "run-child");
  expect(childParentStep).toBeTruthy();
  const [invocation] = await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.parentStepRunId, childParentStep!.id));
  expect(invocation?.childRunId).toBeTruthy();
  const [childRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, invocation!.childRunId!));
  const [parentRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.runId));
  expect(childRun?.status).toBe("completed"); expect(parentRun?.status).toBe("completed");
  const childSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, childRun!.id));
  expect(childSteps).toEqual([expect.objectContaining({ stepId: "write", status: "completed", metadata: expect.objectContaining({
    toolResult: expect.objectContaining({ success: true, artifactPath: source, artifactSha256: digest }),
  }) })]);
  expect(parentSteps.find(step => step.stepId === "run-child")).toMatchObject({ status: "completed", metadata: {
    toolResult: expect.objectContaining({ success: true, data: { ok: true, childRunId: childRun!.id, childStatus: "completed" } }),
  } });
  expect(parentSteps.find(step => step.stepId === "consume")?.status).toBe("completed");
  expect(await readFile(source)).toEqual(bytes); expect(await readFile(consumed)).toEqual(bytes);
  expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["write", "read"]);
  await missionService(db).runActiveMissionOwnerSupervision({ companyId, missionIds: [result.missionId!], applySafeActions: true });
  const [mission] = await db.select().from(missions).where(eq(missions.id, result.missionId!));
  expect(mission).toMatchObject({ status: "completed", completedAt: expect.any(Date) });
  await syncWorkflowRunState(db, result.runId); await processQueuedWorkflowToolStepRuns(db);
  expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["write", "read"]);
  console.info("T16A_M05_EVIDENCE", JSON.stringify({ companyId, missionId: result.missionId, parentRunId: result.runId,
    childRunId: childRun!.id, childStepRunId: childSteps[0]!.id, sha256: digest, calls: ["write", "read"] }));
}, 60_000);
