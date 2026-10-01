import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, readFile, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { activityLog } from '@paperclipai/db';
import { captureToolCallProvenance, recordToolCallProvenance, toolCallProvenanceSchema } from '../services/workflow/tool-call-provenance.js';
import { progressDatabase, progressTool } from './helpers/tool-progress.js';

let fixture: Awaited<ReturnType<typeof progressDatabase>>, root: string;
const files = ['checker.mjs', 'publish.mjs', 'assets.mjs', 'dates.mjs', 'update.mjs', 'cms.mjs', 'convert.mjs', 'canonical.mjs'];
beforeAll(async () => { fixture = await progressDatabase(); root = await mkdtemp(join(tmpdir(), 'provenance-')); }, 60_000);
afterAll(async () => { await fixture?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); });
it('records declared deployment identity independently of display name and retains audit phases', async () => {
  for (const name of files) await writeFile(join(root, name), 'console.log("diagnostic only");');
  const scope = await progressTool(fixture.db, 'builtin', { command: 'unused' });
  for (const phase of ['returned', 'threw'] as const) {
    const requestId = randomUUID();
    const p = await captureToolCallProvenance({ ...scope, toolName: 'arbitrary-display-name', requestId,
      commandParts: ['node', join(root, files[1])], cwd: root, env: { PATH: dirname(process.execPath) }, deploymentFiles: files });
    expect(p?.schemaVersion).toBe('workflow.tool-call-provenance.v1');
    expect(p!.executable.path).toBe(process.execPath);
    expect(p!.executable.sha256).toBe(createHash('sha256').update(await readFile(process.execPath)).digest('hex'));
    expect(p!.interpreter.sha256).toBe(p!.executable.sha256);
    expect(toolCallProvenanceSchema.safeParse({ ...p, schemaVersion: 'v2' }).success).toBe(false);
    expect(toolCallProvenanceSchema.safeParse({ ...p, forged: true }).success).toBe(false);
    expect(p!.toolFiles).toHaveLength(files.length);
    expect(p!.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(p!.core.files.some(f => f.path.endsWith('core-tool-executor.ts') && f.sha256)).toBe(true);
    expect(p!.core.loadedBytesAttested).toBe(false);
    await recordToolCallProvenance(fixture.db, p, 'prepared');
    await recordToolCallProvenance(fixture.db, p, phase);
    const rows = await fixture.reader.select().from(activityLog).where(eq(activityLog.entityId, scope.toolId));
    expect(rows.filter(r => r.details.requestId === requestId).map(r => r.details.phase)).toEqual(['prepared', phase]);
  }
}, 30_000);
it('direct executable records its interpreter and undeclared files are not auto-discovered', async () => {
  const script = join(root, 'publish.mjs');
  await writeFile(script, '#!/usr/bin/env node\nconsole.log("ok");'); await chmod(script, 0o755);
  const p = await captureToolCallProvenance({ companyId: randomUUID(), toolId: randomUUID(), toolName: 'anything',
    requestId: 'r', commandParts: [script], cwd: root, env: { PATH: dirname(process.execPath) }, deploymentFiles: ['publish.mjs'] });
  expect(p!.executable.path).toBe(await realpath(script));
  expect(p!.interpreter.path).toBe(process.execPath);
  expect(p!.toolFiles).toHaveLength(1);
});
it('missing declared files remain diagnostic failures, not invented attestation', async () => {
  const p = await captureToolCallProvenance({ companyId: randomUUID(), toolId: randomUUID(), toolName: 'anything',
    requestId: 'r', commandParts: [process.execPath], cwd: root, env: {}, deploymentFiles: ['missing.mjs'] });
  expect(p!.bundleSha256).toBe(null);
  expect(p!.toolFiles[0].error).toBe('ENOENT');
});
