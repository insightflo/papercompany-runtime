import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activityLog, agents, companies, toolDefinitions, workflowDefinitions } from '@paperclipai/db';
import { eq } from 'drizzle-orm';
import { progressDatabase } from './helpers/tool-progress.js';
import { errorHandler } from '../middleware/index.js';
import { workflowRoutes } from '../routes/workflows.js';
import { toolDefinitionRoutes } from '../routes/tool-definitions.js';
import { toolService } from '../services/tools/registry.js';
import { workflowService } from '../services/workflow/engine.js';
import { createWorkflowDefinition, updateWorkflowDefinition } from '../services/workflow/workflow-store.js';

let fixture: Awaited<ReturnType<typeof progressDatabase>>, companyId: string;
const agentId = randomUUID();
const qaConfig = { rules: { 'tag-count': { params: { min: 2 } } } };
const step = { id: 'action', name: 'Action', agentId, dependencies: [] as string[], qaConfig };
const contract = { role: 'qa', resultFileName: 'result.json', resultSchemaVersion: 'workflow.qa-result.v1',
  resultAdapter: 'generic', inputParams: { content: 'document' }, deploymentFiles: ['check.mjs'], inputEnvelopeVersion: 'input.v1' };
function app(agent = false) {
  const server = express(); server.use(express.json());
  server.use((req, _res, next) => { req.actor = agent ? { type: 'agent', agentId, companyId, runId: null }
    : { type: 'board', userId: 'test-board', companyIds: [companyId], source: 'authenticated', isInstanceAdmin: false }; next(); });
  server.use('/api', workflowRoutes(fixture.db)); server.use('/api', toolDefinitionRoutes(fixture.db));
  server.use(errorHandler); return server;
}
beforeAll(async () => {
  fixture = await progressDatabase();
  [companyId] = (await fixture.db.insert(companies).values({ name: 'Config saves', issuePrefix: randomUUID() }).returning()).map(c => c.id);
  await fixture.db.insert(agents).values({ id: agentId, companyId, name: 'Config agent', role: 'engineer', adapterType: 'process', adapterConfig: {} });
}, 60_000);
afterAll(async () => { await fixture?.cleanup(); });

describe('artifact configuration HTTP authority and durable audit', () => {
  it('denies agent QA configuration create before persisting anything', async () => {
    const response = await request(app(true)).post(`/api/companies/${companyId}/workflows`).send({ name: 'forbidden', steps: [step] });
    expect(response.status).toBe(403);
    expect(await fixture.reader.select().from(workflowDefinitions).where(eq(workflowDefinitions.name, 'forbidden'))).toHaveLength(0);
  });
  it('audits board create/update and denies agent change, removal, or whole-step deletion', async () => {
    const created = await request(app()).post(`/api/companies/${companyId}/workflows`).send({ name: 'board workflow', steps: [step] });
    expect(created.status).toBe(201);
    const id = created.body.id;
    for (const steps of [[{ ...step, qaConfig: { rules: {} } }], [{ ...step, qaConfig: undefined }], []]) {
      const denied = await request(app(true)).patch(`/api/workflows/${id}`).send({ steps });
      expect(denied.status).toBe(403);
    }
    const updated = await request(app()).patch(`/api/workflows/${id}`).send({ steps: [{ ...step, qaConfig: { rules: {} } }] });
    expect(updated.status).toBe(200);
    const audits = await fixture.reader.select().from(activityLog).where(eq(activityLog.entityId, id));
    expect(audits.map(a => [a.action, a.actorType, a.actorId])).toEqual([
      ['workflow.created', 'user', 'test-board'], ['workflow.updated', 'user', 'test-board'],
    ]);
  });
  it('does not authorize a stale read over a concurrent board policy addition', async () => {
    const created = await createWorkflowDefinition(fixture.db, { companyId, name: 'racing edit', steps: [] });
    const getDefinition = workflowService.getDefinition.bind(workflowService);
    const spy = vi.spyOn(workflowService, 'getDefinition').mockImplementationOnce(async (db, id) => {
      const stale = await getDefinition(db, id);
      await updateWorkflowDefinition(fixture.db, id, { steps: [step] });
      return stale;
    });
    try {
      const response = await request(app(true)).patch(`/api/workflows/${created.id}`).send({ steps: [] });
      expect(response.status).toBe(403);
      expect((await getDefinition(fixture.reader, created.id))!.steps[0]).toMatchObject({ qaConfig });
    } finally { spy.mockRestore(); }
  });
  it('permits agent ordinary metadata changes without replacing QA policy', async () => {
    const created = await request(app()).post(`/api/companies/${companyId}/workflows`).send({ name: 'rename', steps: [step] });
    const updated = await request(app(true)).patch(`/api/workflows/${created.body.id}`).send({ name: 'renamed' });
    expect(updated.status).toBe(200);
    expect(updated.body.steps[0].qaConfig).toEqual(qaConfig);
  });
  it('keeps tool contract writes board-only and records successful saves', async () => {
    const body = { name: `tool-${randomUUID()}`, adapterType: 'builtin', adapterConfig: { artifactContract: contract } };
    expect((await request(app(true)).post(`/api/companies/${companyId}/tools`).send(body)).status).toBe(403);
    const created = await request(app()).post(`/api/companies/${companyId}/tools`).send(body);
    expect(created.status).toBe(201);
    expect((await request(app(true)).patch(`/api/companies/${companyId}/tools/${created.body.id}`).send({ adapterConfig: {} })).status).toBe(403);
    expect((await request(app()).patch(`/api/companies/${companyId}/tools/${created.body.id}`).send({ adapterConfig: { artifactContract: { ...contract, resultFileName: 'new.json' } } })).status).toBe(200);
    const audits = await fixture.reader.select().from(activityLog).where(eq(activityLog.entityId, created.body.id));
    expect(audits.map(a => a.action)).toEqual(['company.tool_created', 'company.tool_updated']);
  });
  it.each([
    { rules: { invented: {} } }, { rules: { 'tag-count': { params: { unknown: 1 } } } },
    { rules: { 'provenance': { enabled: false } } },
  ])('rejects invalid QA policy at HTTP create and update: %j', async invalid => {
    const created = await request(app()).post(`/api/companies/${companyId}/workflows`).send({ name: 'valid', steps: [] });
    for (const method of ['post', 'patch'] as const) {
      const url = method === 'post' ? `/api/companies/${companyId}/workflows` : `/api/workflows/${created.body.id}`;
      expect((await request(app())[method](url).send({ name: 'invalid', steps: [{ ...step, qaConfig: invalid }] })).status).toBe(400);
    }
  });
  it('rejects invalid tool contract on both HTTP save paths', async () => {
    const created = await request(app()).post(`/api/companies/${companyId}/tools`).send({ name: `valid-${randomUUID()}`, adapterType: 'builtin', adapterConfig: {} });
    for (const method of ['post', 'patch'] as const) {
      const url = `/api/companies/${companyId}/tools${method === 'patch' ? `/${created.body.id}` : ''}`;
      const result = await request(app())[method](url).send({ name: `invalid-${randomUUID()}`, adapterType: 'builtin', adapterConfig: { artifactContract: { ...contract, unknown: true } } });
      expect(result.status).toBe(400);
    }
  });
});

describe('service variants cannot bypass save validation', () => {
  it('rejects invalid QA config in native and low-level store saves', async () => {
    const badSteps = [{ ...step, qaConfig: { rules: { typo: {} } } }] as never;
    const definition = await createWorkflowDefinition(fixture.db, { companyId, name: 'store', steps: [] });
    for (const save of [
      () => workflowService.createDefinition(fixture.db, { companyId, name: 'invalid-native', steps: badSteps }),
      () => workflowService.updateDefinition(fixture.db, definition.id, { steps: badSteps }),
      () => createWorkflowDefinition(fixture.db, { companyId, name: 'invalid-store', steps: badSteps }),
      () => updateWorkflowDefinition(fixture.db, definition.id, { steps: badSteps }),
    ]) await expect(save()).rejects.toThrow();
    expect((await workflowService.getDefinition(fixture.reader, definition.id))!.steps).toEqual([]);
  });
  it('rejects malformed tool contracts in registry create/update', async () => {
    const tool = await toolService.createDefinition(fixture.db, { companyId, name: `registry-${randomUUID()}`, adapterType: 'builtin', adapterConfig: {} });
    await expect(toolService.createDefinition(fixture.db, { companyId, name: `bad-${randomUUID()}`, adapterType: 'builtin', adapterConfig: { artifactContract: null } })).rejects.toThrow();
    await expect(toolService.updateDefinition(fixture.db, tool.id, { adapterConfig: { artifactContract: { ...contract, resultFileName: '../unsafe.json' } } })).rejects.toThrow();
    const [saved] = await fixture.reader.select().from(toolDefinitions).where(eq(toolDefinitions.id, tool.id));
    expect(saved.adapterConfig).toEqual({});
  });
});
