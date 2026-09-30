import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";
import { agents, companies, createDb, issues, missions, toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { workProductService } from "../../services/work-products.js";
import { executeCoreWorkflowTool } from "../../services/workflow/core-tool-executor.js";
import { resolveWorkflowToolStepArgs } from "../../services/workflow/tool-step-args.js";
import { admittedProducer } from "./admitted-producer.js";
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("qa-receipt-v31-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-v31-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); execFileSync("chmod", ["-R", "u+w", root]); await rm(root, { recursive: true, force: true }); });

export function database() { return db; }

export async function fixture(producerScript?: string) {
  const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID(), workflowId = randomUUID(), runId = randomUUID(),
    issueId = randomUUID(), producerId = randomUUID(), qaId = randomUUID(), heartbeatId = randomUUID(), toolId = randomUUID();
  const requestId = `${runId}:qa:1`;
  await db.insert(companies).values({ id: companyId, name: "QA", issuePrefix: companyId.slice(0, 8), workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Writer" });
  await db.insert(missions).values({ id: missionId, companyId, title: "QA", ownerAgentId: agentId });
  const steps = [{ id: "write", name: "Write", agentId, dependencies: [] }, { id: "qa", name: "QA", type: "tool", agentId: "",
    dependencies: ["write"], toolNames: ["local-qa"], workProductSelectors: { write: { type: "document", title: "content.json" } },
    toolArtifactContract: { schemaVersion: "manual-onboarding.qa.v1", role: "qa", inputStepId: "write" } }];
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "QA", stepsJson: steps });
  await db.insert(workflowRuns).values({ id: runId, companyId, missionId, workflowId, triggeredBy: "board", status: "running" });
  await db.insert(issues).values({ id: issueId, companyId, missionId, title: "Write", status: "done" });
  await db.insert(workflowStepRuns).values([
    { id: producerId, workflowRunId: runId, stepId: "write", issueId, status: "completed", executionGeneration: 1, startedAt: new Date("2026-01-01") },
    { id: qaId, workflowRunId: runId, stepId: "qa", status: "running", executionGeneration: 2, lastDispatchRequestId: requestId },
  ]);
  await admittedProducer(db, { companyId, agentId, issueId, stepRunId: producerId, heartbeatId });
  const dir = path.join(root, "missions", missionId, "draft"); await mkdir(path.join(dir, "assets"), { recursive: true });
  const content = path.join(dir, "content.json"), assetsDir = path.join(dir, "assets");
  await writeFile(content, JSON.stringify({ title: "Title", summary: "Summary", tags: ["tag1", "tag2", "tag3"], blocks: [{ type: "image", assetFile: "hero.png", alt: "Hero" }] }));
  await writeFile(path.join(assetsDir, "hero.png"), Buffer.from("89504e470d0a1a0a00000000", "hex"));
  await workProductService(db).createForIssue(issueId, companyId, { provider: "local_file", type: "document", title: "content.json", status: "active",
    createdByRunId: heartbeatId, metadata: { path: content } });
  let script = producerScript;
  if (!script) {
    script = path.join(root, `${toolId}.mjs`);
    // Explicit producer test double: machine fixture only; real producer belongs in external test.
    await writeFile(script, `import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';import path from'node:path';
const a=Object.fromEntries(process.argv.slice(3).reduce((r,v,i,all)=>i%2?r:[...r,[v.slice(2),all[i+1]]],[]));
const v=JSON.parse(readFileSync(0,'utf8'));
const h=b=>createHash('sha256').update(b).digest('hex'), asset=Buffer.from(v.assets[0].base64,'base64');
const q={schemaVersion:'manual-onboarding.qa.v1',command:'qa',mode:'content',section:'tech-blog',ok:true,checkedAt:new Date().toISOString(),checks:[{id:'fixture',ok:true,detail:null}],artifactPath:a.out,contentSha256:h(Buffer.from(v.content.base64,'base64')),assetManifest:[{fileName:'hero.png',sha256:h(asset),byteSize:asset.length}]};
writeFileSync(4,JSON.stringify(q)); console.log('not JSON; stdout is diagnostic only');`);
  }
  await db.insert(toolDefinitions).values({ id: toolId, companyId, name: "local-qa", description: "QA", adapterType: "builtin",
    adapterConfig: { command: `${process.execPath} ${script} qa` } });
  await resolveWorkflowToolStepArgs({ db, run: { id: runId, companyId }, consumerStepRunId: qaId,
    step: { ...steps[1], toolArgs: { content: "{$steps.write.workProductPath}" } }, workflowSteps: steps });
  const invoke = () => executeCoreWorkflowTool({ db, companyId, toolName: "local-qa", workflowRunId: runId, stepRunId: qaId, stepId: "qa",
    requestId, parameters: { content, assetsDir, section: "tech-blog" } });
  return { companyId, runId, qaId, missionId, content, assetsDir, requestId, invoke };
}

