import '../helpers/workflow-control-node-boundary.js';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { agents, companies, createDb, heartbeatRuns, issues, missions, toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowStepOutputBindings } from '@paperclipai/db';
import { updateWorkflowDefinitionSchema } from '@paperclipai/shared';
import { startEmbeddedPostgresTestDatabase } from '../helpers/embedded-postgres.js';
import { createWorkflowRunWithDefinition } from '../../services/workflow/workflow-run-create.js';
import { loadExecutionDefinition } from '../../services/workflow/execution-definition.js';
import type { PersistedWorkflowStep } from '../../services/workflow/execution-steps.js';
import { workProductService } from '../../services/work-products.js';
import { resolveWorkflowToolStepArgs } from '../../services/workflow/tool-step-args.js';
import { executeCoreWorkflowTool } from '../../services/workflow/core-tool-executor.js';
import { completeWorkflowToolStepFromResult } from '../../services/workflow/dag-engine.js';
import { readQaReceiptBytes } from '../../services/workflow/qa-artifact-receipt.js';

const ops = process.env.OVERSIGHT_OPERATIONS_ROOT;
if (!ops || !path.isAbsolute(ops)) throw Error('OVERSIGHT_OPERATIONS_ROOT must explicitly name the tools checkout');
if (!process.env.OVERSIGHT_READER_BUNDLE) throw Error('OVERSIGHT_READER_BUNDLE required; build actual reader outside service repo');
if (process.env.DATABASE_URL) throw Error('Unset DATABASE_URL: isolated embedded PostgreSQL only');
const tools = path.join(ops, 'scripts/paperclip-addon/automation/research-company/manual-onboarding');
const bridge = fileURLToPath(new URL('../../../../tests/external/helpers/oversight-container-bridge.mjs', import.meta.url));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase('oversight-managed-'); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oversight-managed-')));
}, 60000);
afterAll(async () => {
  await temp?.cleanup(); if (root) { execFileSync('chmod', ['-R', 'u+w', root]); await rm(root, { recursive: true, force: true }); }
});

it.each(['document-first', 'image-first'])('managed frozen definition → official registration → real QA/publisher/reader (%s)', async order => {
  const candidate = JSON.parse(await readFile(path.join(ops, 'workflow-definitions/managed/research-company/tech-blog-radar.json'), 'utf8'));
  const parsed = updateWorkflowDefinitionSchema.parse({ steps: candidate.steps });
  const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID(), workflowId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: 'Isolated oversight', issuePrefix: companyId.slice(0,8), workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: 'Fixture writer' });
  await db.insert(missions).values({ id: missionId, companyId, title: 'Isolated acceptance', ownerAgentId: agentId });
  // Identity FKs are isolated; the actual 13-step graph, tool args, runInputs and trigger fields are unedited.
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: candidate.name, stepsJson: parsed.steps,
    executionMode: candidate.executionMode, dynamicPlanBootstrapOnly: candidate.dynamicPlanBootstrapOnly,
    source: candidate.source, sourceKind: candidate.sourceKind, runInputs: candidate.runInputs,
    schedule: candidate.schedule, timezone: candidate.timezone, triggerLabels: candidate.triggerLabels, labelIds: candidate.labelIds });
  const [storedDefinition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, workflowId));
  for (const field of ['runInputs','schedule','timezone','triggerLabels','labelIds'] as const) expect(storedDefinition[field]).toEqual(candidate[field]);
  const run = await createWorkflowRunWithDefinition(db, { companyId, workflowId, missionId, triggeredBy: 'board', runDate: '2026-09-30' });
  const frozen = await loadExecutionDefinition(db, run.id, { requireHistorical: true });
  expect(frozen.source).toBe('snapshot'); expect(frozen.steps).toHaveLength(13);
  for (const step of frozen.steps) {
    const source = candidate.steps.find((s: { id: string }) => s.id === step.id);
    expect(step.toolArgs).toEqual(source.toolArgs);
    expect(step.dependencies).toEqual(source.dependencies);
    expect(step.conditionalDependencies ?? []).toEqual(source.conditionalDependencies ?? []);
  }
  const qa = frozen.steps.find(s => s.id === 'qa-digest-content')! as PersistedWorkflowStep;
  const publish = frozen.steps.find(s => s.id === 'publish-digest')! as PersistedWorkflowStep;
  expect(qa.workProductSelectors).toEqual({ 'build-digest-content': { type: 'document', title: 'content.json' } });
  expect(qa.toolArtifactContract).toEqual({ schemaVersion: 'manual-onboarding.qa.v1', role: 'qa', inputStepId: 'build-digest-content' });
  expect(publish.workProductSelectors).toEqual(qa.workProductSelectors);
  await db.update(workflowDefinitions).set({ stepsJson: [], runInputs: [], triggerLabels: ['changed-after-acceptance'] }).where(eq(workflowDefinitions.id, workflowId));
  expect(await loadExecutionDefinition(db, run.id, { requireHistorical: true })).toEqual(frozen);
  await db.update(workflowRuns).set({ status: 'running' }).where(eq(workflowRuns.id, run.id));
  const issueId = randomUUID(), heartbeatId = randomUUID();
  const ids = new Map(frozen.steps.map(s => [s.id, randomUUID()]));
  const requests = new Map(frozen.steps.map(s => [s.id, `${run.id}:${s.id}:1`]));
  await db.insert(issues).values({ id: issueId, companyId, missionId, title: 'Fixture content', status: 'done' });
  // Upstream agents/control nodes are seeded, NOT executed. All other rows remain in-flight
  // so official QA completion cannot accidentally launch cloud/agent operations.
  await db.insert(workflowStepRuns).values(frozen.steps.map(s => ({ id: ids.get(s.id)!, workflowRunId: run.id, stepId: s.id,
    issueId: s.id === 'build-digest-content' ? issueId : null, status: s.id === 'build-digest-content' ? 'completed' : 'running',
    startedAt: new Date('2026-01-01'), executionGeneration: 1, lastDispatchRequestId: requests.get(s.id)! })));
  await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId, agentId, issueId, status: 'succeeded',
    startedAt: new Date('2026-01-02'), workflowStepRunId: ids.get('build-digest-content'), workflowExecutionGeneration: 1 });
  const dir = path.join(root, 'missions', missionId, 'draft'); await mkdir(path.join(dir, 'assets'), { recursive: true });
  const content = Buffer.from(JSON.stringify({title:'Frozen native acceptance',summary:'본문 검증',tags:['테크 블로그','워크플로우','검증'],
    blocks:[{type:'paragraph',text:'검증 본문'},{type:'image',assetFile:'hero.png',alt:'검증 이미지'}]}));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
  const contentPath = path.join(dir,'content.json'), imagePath = path.join(dir,'assets/hero.png');
  await writeFile(contentPath,content); await writeFile(imagePath,png);
  const svc = workProductService(db);
  const records = order === 'document-first' ? ['document','artifact'] : ['artifact','document'];
  let contentId: string | undefined;
  for (const type of records) {
    const product = await svc.createForIssue(issueId, companyId, { provider:'local_file', type, title:type==='document'?'content.json':'hero.png', status:'active',
      isPrimary:true, createdByRunId:heartbeatId, metadata:{path:type==='document'?contentPath:imagePath} });
    expect(product!.isPrimary).toBe(true); // Reproduce cross-type primaries regardless of the new instruction.
    expect(product!.metadata?.workflowProducer).toMatchObject({workflowRunId:run.id,stepRunId:ids.get('build-digest-content'),executionGeneration:1,heartbeatRunId:heartbeatId});
    if(type==='document') contentId=product!.id;
  }
  const evidenceDir = path.join(root, `evidence-${order}`); await mkdir(evidenceDir);
  for (const [name, script, command] of [['manual-onboarding-qa','manual-onboarding-qa.mjs','qa'],['manual-onboarding-publish','manual-onboarding-workflow-tool.mjs','publish']]) {
    await db.insert(toolDefinitions).values({companyId,name,description:'Isolated real CLI',adapterType:'builtin',adapterConfig:{
      command:`${process.execPath} ${bridge} ${path.join(tools,script)} ${command}`, timeoutMs:100000,
      env:{OVERSIGHT_READER_BUNDLE:process.env.OVERSIGHT_READER_BUNDLE,OVERSIGHT_EVIDENCE_DIR:evidenceDir} }});
  }
  const args = await resolveWorkflowToolStepArgs({db,run,step:qa,workflowSteps:frozen.steps,consumerStepRunId:ids.get(qa.id)});
  expect(args).toEqual({content:contentPath,assetsDir:path.join(dir,'assets'),section:'tech-blog'});
  const bindings = await db.select().from(workflowStepOutputBindings).where(and(eq(workflowStepOutputBindings.workflowRunId,run.id),eq(workflowStepOutputBindings.consumerStepRunId,ids.get(qa.id)!)));
  expect(bindings.map(b=>b.workProductId)).toEqual([contentId]);
  const invoke = (step: typeof qa, parameters: unknown) => executeCoreWorkflowTool({db,companyId,workflowRunId:run.id,stepId:step.id,
    stepRunId:ids.get(step.id),requestId:requests.get(step.id)!,toolName:step.toolNames![0],parameters});
  const result = await invoke(qa,args); expect(result.status,JSON.stringify(result.body)).toBe(200);
  expect(result.toolArtifactReceipt?.input.sha256).toBe(sha(content));
  expect(result.toolArtifactReceipt?.input.assetManifest[0].sha256).toBe(sha(png));
  await completeWorkflowToolStepFromResult(db,{companyId,workflowRunId:run.id,stepRunId:ids.get(qa.id)!,stepId:qa.id,
    requestId:requests.get(qa.id),toolName:'manual-onboarding-qa',success:true,data:result.body.data,toolArtifactReceipt:result.toolArtifactReceipt});
  const receipt = await readQaReceiptBytes(db,{companyId,workflowRunId:run.id,stepId:qa.id});
  expect(receipt.receipt.sha256).toBe(sha(receipt.bytes));
  const publishArgs = await resolveWorkflowToolStepArgs({db,run,step:publish,workflowSteps:frozen.steps,consumerStepRunId:ids.get(publish.id)});
  // Mutate display source paths after QA: publishing must use the captured validated bytes.
  await writeFile(contentPath,'{"title":"POISON"}'); await writeFile(imagePath,'POISON');
  const published = await invoke(publish,publishArgs); expect(published.status,JSON.stringify(published.body)).toBe(200);
  const evidence = JSON.parse(await readFile(path.join(evidenceDir,'publication.json'),'utf8'));
  expect(evidence.inputSha256).toBe(sha(content)); expect(evidence.qaSha256).toBe(receipt.receipt.sha256);
  expect(evidence.putSha256).toEqual([sha(png)]); expect(evidence.ingestCount).toBe(1);
  expect(evidence.verifier.kstDateContractOk).toBe(true); expect(evidence.verifier.ok).toBe(true);
  const publishData = published.body.data as { artifactPath: string; ok: boolean };
  const durablePublish = JSON.parse(await readFile(publishData.artifactPath, 'utf8'));
  expect(durablePublish.ok).toBe(true);
  expect(result.body.invocationProvenance?.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(published.body.invocationProvenance?.bundleSha256).toBe(result.body.invocationProvenance?.bundleSha256);
  expect(await loadExecutionDefinition(db,run.id,{requireHistorical:true})).toEqual(frozen);
  if (process.env.OVERSIGHT_ACCEPTANCE_OUTPUT) {
    await mkdir(process.env.OVERSIGHT_ACCEPTANCE_OUTPUT, {recursive:true});
    await writeFile(path.join(process.env.OVERSIGHT_ACCEPTANCE_OUTPUT, `${order}.json`), JSON.stringify({
      schemaVersion:1, candidateSha256:sha(await readFile(path.join(ops,'workflow-definitions/managed/research-company/tech-blog-radar.json'))),
      frozen, qaReceipt:receipt.receipt, qaResult:JSON.parse(receipt.bytes.toString()), publication:evidence,
      qaInvocation:result.body.invocationProvenance, publishInvocation:published.body.invocationProvenance,
      limitations:['Seeded upstream/control/semantic QA; no full DAG execution','CMS and reader storage are stand-ins','Node test bridge replaces direct process launch; real CLIs run in network-none containers']}, null, 2));
  }
  console.log(JSON.stringify({order,source:'managed tech-blog-radar',frozenHash:frozen.definitionHash,inputSha256:sha(content),
    receiptSha256:receipt.receipt.sha256,readerHtmlSha256:evidence.readerHtmlSha256,verifiedDate:'2026-09-30',network:'none',
    limitation:'13-step graph frozen; upstream/control/semantic QA seeded, only mechanical QA/publish/readback exercised'}));
}, 120000);
