import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ArtifactContract } from '@paperclipai/shared';
import { captureArtifactRoot } from '../services/workflow/artifact-files.js';
import { verifyPublicationResult } from '../services/workflow/publication-result.js';
import { validateToolArtifactContract } from '../services/workflow/artifact-config-validation.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const contract: ArtifactContract = { role: 'publication', resultFileName: 'published.json',
  resultSchemaVersion: 'workflow.publication-result.v1', resultAdapter: 'generic', inputParams: {},
  deploymentFiles: ['publish.mjs'], inputEnvelopeVersion: 'workflow.artifact-input.v1', publication: {
    identity: { param: 'entry', sourcePathParam: 'decision', sourceFieldParam: 'field', format: 'date-prefixed-slug', dateParam: 'day' },
    command: 'publish', commandKeySeparator: ':',
    audience: { parameter: 'access', privateValue: 'hidden', privateResult: 'private', defaultResult: 'public' },
    bindings: [{ resultPointer: '/date', parameter: 'day', optional: true }],
    publishedAt: { resultPointer: '/publishedAt', dateParam: 'day', suffix: 'T00:00:00Z' } } };
async function fixture() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'publication-declaration-'))); dirs.push(dir);
  const scope = { companyId: randomUUID(), missionId: randomUUID(), workflowRunId: randomUUID(), stepRunId: randomUUID(),
    stepId: 'publish', requestId: 'request', executionGeneration: 0, retryCount: 0, iterationIndex: 0 };
  const hash = 'a'.repeat(64), url = 'https://example.org/article';
  const result = { schemaVersion: 'workflow.publication-result.v1', ok: true, command: 'publish', mode: 'content',
    section: 'articles', id: '20261014-article', date: '2026-10-14', scope, title: null, publishedAt: '2026-10-14T00:00:00Z', publicUrl: url,
    inputDigest: { mode: 'content', sha256: hash, qaSha256: hash, assetManifest: [] },
    cms: { ok: true, audience: 'public', contentId: '20261014-article', slug: 'article', publicUrl: url,
      liveStatus: 200, blocks: 1, assets: 0, commandKey: '20261014-article:1', contentHash: hash, contentBytes: 1 } };
  const input = { root: await captureArtifactRoot(dir), scope, contract, runOutputDir: dir,
    inputBytes: Buffer.from(JSON.stringify({ content: { sha256: hash }, qa: { sha256: hash }, assets: [] })) };
  return { dir, result, input };
}
it('rejects a date-disabled contract at the tool save boundary', () => {
  expect(() => validateToolArtifactContract({ artifactContract: { ...contract,
    publication: { ...contract.publication, bindings: undefined, publishedAt: undefined } } })).toThrow('Invalid tool artifactContract');
});
it.each(['explicit', 'pre-dated-source'])('keeps absent date valid with %s identity', async kind => {
  const f = await fixture(), file = path.join(f.dir, 'decision.json');
  await writeFile(file, JSON.stringify({ slug: '20261014-article' }));
  const parameters = kind === 'explicit' ? { entry: '20261014-article' } : { decision: file, field: 'slug' };
  const result = await verifyPublicationResult({ ...f.input, parameters, bytes: Buffer.from(JSON.stringify(f.result)) });
  expect(result.artifactPath).toBe(path.join(f.dir, 'published.json'));
});
it('still rejects an undated source slug when its date argument is absent', async () => {
  const f = await fixture(), file = path.join(f.dir, 'decision.json');
  await writeFile(file, JSON.stringify({ slug: 'article' }));
  await expect(verifyPublicationResult({ ...f.input, parameters: { decision: file, field: 'slug' },
    bytes: Buffer.from(JSON.stringify(f.result)) })).rejects.toThrow('qa_publish_result_id_source_invalid');
});
it('binds timestamp to validated result date when the optional date argument is absent', async () => {
  const f = await fixture(); f.result.publishedAt = '2026-10-15T00:00:00Z';
  await expect(verifyPublicationResult({ ...f.input, parameters: { entry: f.result.id },
    bytes: Buffer.from(JSON.stringify(f.result)) })).rejects.toThrow('qa_publish_result_target_mismatch');
});
it('rejects supplied date disagreement even when timestamp agrees with the supplied date', async () => {
  const f = await fixture(); f.result.publishedAt = '2026-10-15T00:00:00Z';
  await expect(verifyPublicationResult({ ...f.input, parameters: { entry: f.result.id, day: '2026-10-15' },
    bytes: Buffer.from(JSON.stringify(f.result)) })).rejects.toThrow('qa_publish_result_target_mismatch');
});
it.each(['valid', 'date-tampered', 'timestamp-tampered'])('verification requires only source publication, not publisher settings: %s', async scenario => {
  const f = await fixture(), result = { ...f.result, command: 'verify' };
  if (scenario === 'date-tampered') result.date = '2026-10-15';
  if (scenario === 'timestamp-tampered') result.publishedAt = '2026-10-15T00:00:00Z';
  const verifying: ArtifactContract = { ...contract, role: 'publication-verify',
    publication: { command: 'verify', commandKeySeparator: ':' } };
  const verification = verifyPublicationResult({ ...f.input, contract: verifying, sourcePublication: f.result,
    parameters: {}, inputBytes: Buffer.alloc(0), bytes: Buffer.from(JSON.stringify(result)) });
  if (scenario === 'valid') expect((await verification).artifactPath).toBe(path.join(f.dir, 'published.json'));
  else await expect(verification).rejects.toThrow('qa_publish_result_target_mismatch');
});
