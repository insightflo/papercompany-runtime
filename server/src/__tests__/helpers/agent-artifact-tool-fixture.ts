import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { agents, agentToolGrants, heartbeatRuns, issues, toolDefinitions, workflowDefinitions,
  workflowRuns, workflowStepRuns, workflowStepOutputBindings } from '@paperclipai/db';
import { pluginRoutes } from '../../routes/plugins.js';
import { errorHandler } from '../../middleware/index.js';
import { artifactDagFixture } from './artifact-dag-fixture.js';
import { admittedProducer } from './admitted-producer.js';

/** Real HTTP authorization, DB admission, artifact readers and local machine tool processes. */
export async function agentArtifactFixture() {
  const f = await artifactDagFixture(true);
  const [agent] = await f.db.insert(agents).values({ companyId: f.companyId, name: 'Artifact agent' }).returning();
  const [run] = await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
  const steps = f.steps.map(s => s.id === 'write' ? s : { ...s, type: 'action', agentId: agent.id });
  await f.db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, run.workflowId));
  const tools = await f.db.select().from(toolDefinitions).where(eq(toolDefinitions.companyId, f.companyId));
  for (const tool of tools) await f.db.insert(agentToolGrants).values({ companyId: f.companyId, agentId: agent.id, toolId: tool.id, grantedBy: 'test' });
  const calls: Record<string, { heartbeatId: string; issueId: string; stepRunId: string }> = {};
  for (const [stepId, stepRunId] of [['qa', f.qaId], ['publisher', f.publishId], ['inspector', f.verifyId]]) {
    const [issue] = await f.db.insert(issues).values({ companyId: f.companyId, missionId: f.missionId,
      assigneeAgentId: agent.id, title: stepId, status: 'in_progress' }).returning();
    await f.db.update(workflowStepRuns).set({ issueId: issue.id, metadata: {}, lastDispatchRequestId: null })
      .where(eq(workflowStepRuns.id, stepRunId));
    const heartbeatId = randomUUID();
    await admittedProducer(f.db, { companyId: f.companyId, agentId: agent.id, issueId: issue.id,
      stepRunId, heartbeatId, status: 'running' });
    await f.db.update(heartbeatRuns).set({ contextSnapshot: { paperclipWorkflowStepToolContract: {
      toolNames: tools.map(t => t.name), tools: tools.map(t => ({ name: t.name })) } } }).where(eq(heartbeatRuns.id, heartbeatId));
    await f.db.update(issues).set({ executionRunId: heartbeatId, checkoutRunId: heartbeatId }).where(eq(issues.id, issue.id));
    calls[stepId] = { heartbeatId, issueId: issue.id, stepRunId };
  }
  // Agent dispatch must establish its own declared input pin, not inherit an engine fixture pin.
  await f.db.delete(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.consumerStepRunId, f.qaId));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: 'agent', agentId: agent.id, companyId: f.companyId, source: 'agent_key' };
    next();
  });
  app.use('/api', pluginRoutes(f.db, {} as never));
  app.use(errorHandler);
  const call = (stepId: string, parameters?: unknown, extra: Record<string, unknown> = {}, tool?: string) =>
    request(app).post('/api/plugins/tools/execute').send({ tool: tool ?? (stepId === 'qa' ? 'local-qa' : stepId),
      parameters: parameters ?? { content: f.content, assetsDir: f.assetsDir, section: 'tech-blog' },
      runContext: { agentId: agent.id, companyId: f.companyId, runId: calls[stepId].heartbeatId }, ...extra });
  const step = async (id: string) => (await f.db.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, calls[id].stepRunId)))[0];
  const finish = async (id: string) => {
    // Isolate tool submission from the separately tested heartbeat/issue lifecycle.
    await f.db.update(workflowStepRuns).set({ status: 'completed' }).where(eq(workflowStepRuns.id, calls[id].stepRunId));
  };
  const publishArgs = (receiptPath: string) => ({ review: receiptPath, source: f.content, entry: 'article', day: '2026-10-01' });
  return { ...f, agentId: agent.id, calls, call, step, finish, publishArgs };
}
