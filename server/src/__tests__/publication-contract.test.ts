import { mkdtemp, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { expectedPublicationId, verifyPublicationResult } from '../services/workflow/publication-result.js';
import { captureArtifactRoot } from '../services/workflow/artifact-files.js';
import { setPublicUrlReadbackFetcher } from '../services/public-url-readback.js';
import { legacyHtmlManualPublicationContract } from './helpers/legacy-html-manual.js';
const dirs: string[] = [];
afterEach(async () => { setPublicUrlReadbackFetcher(null); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function setup() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'publication-'))); dirs.push(dir);
  const scope = { companyId: '00000000-0000-4000-8000-000000000001', missionId: '00000000-0000-4000-8000-000000000002',
    workflowRunId: '00000000-0000-4000-8000-000000000003', stepRunId: '00000000-0000-4000-8000-000000000004',
    stepId: 'publish', requestId: 'r1', executionGeneration: 0, retryCount: 0, iterationIndex: 0 };
  const hash = 'a'.repeat(64), url = 'https://example.org/article';
  const result = { schemaVersion: 'workflow.publication-result.v1', ok: true, command: 'publish', mode: 'content',
    section: 'articles', id: 'article', date: '2026-10-14', scope: { ...scope }, title: null, publishedAt: '2026-10-14T00:00:00Z', publicUrl: url,
    inputDigest: { mode: 'content', sha256: hash, qaSha256: hash, assetManifest: [] },
    cms: { ok: true, audience: 'public', contentId: 'article', slug: 'article', publicUrl: url, liveStatus: 200,
      blocks: 1, assets: 0, commandKey: 'article:1', contentHash: hash, contentBytes: 1 } };
  const contract = { ...legacyHtmlManualPublicationContract('publish.mjs'), resultAdapter: 'generic' as const,
    resultSchemaVersion: 'workflow.publication-result.v1', resultFileName: 'receipt.json', publication: {
      identity: { param: 'entry', sourcePathParam: 'decision', sourceFieldParam: 'field', format: 'date-prefixed-slug' as const, dateParam: 'day' },
      bindings: [{ resultPointer: '/section', parameter: 'collection' }, { resultPointer: '/date', parameter: 'day' }],
      publishedAt: { resultPointer: '/publishedAt', dateParam: 'day', suffix: 'T00:00:00Z' },
      audience: { parameter: 'access', privateValue: 'hidden', privateResult: 'private', defaultResult: 'public' },
      command: 'publish', commandKeySeparator: ':' } };
  return { dir, result, contract, input: { root: await captureArtifactRoot(dir), scope, parameters: { entry: 'article', collection: 'articles', day: '2026-10-14' },
    inputBytes: Buffer.from(JSON.stringify({ content: { sha256: hash }, qa: { sha256: hash }, assets: [] })) } };
}
it('accepts a generic schema and declared output basename', async () => {
  const f = await setup();
  const value = await verifyPublicationResult({ ...f.input, contract: f.contract, bytes: Buffer.from(JSON.stringify(f.result)) });
  expect(value.artifactPath).toBe(path.join(f.dir, 'receipt.json'));
});
it.each(['scope', 'sha256', 'date', 'publishedAt', 'audience', 'commandKey', 'contentId', 'publicUrl'])('rejects independent %s tampering', async field => {
  const f = await setup();
  if (field === 'scope') f.result.scope.requestId = 'old';
  else if (field === 'sha256') f.result.inputDigest.sha256 = 'b'.repeat(64);
  else if (field === 'date' || field === 'publishedAt') f.result[field] = '2026-10-15';
  else f.result.cms[field as 'audience'] = 'wrong';
  await expect(verifyPublicationResult({ ...f.input, contract: f.contract, bytes: Buffer.from(JSON.stringify(f.result)) })).rejects.toThrow();
});
it('uses the supplied frozen contract readback rules before writing publication evidence', async () => {
  const f = await setup();
  setPublicUrlReadbackFetcher(async () => ({ ok: true, status: 200, text: '<title>Catalog Home</title>' }));
  await expect(verifyPublicationResult({ ...f.input, contract: { ...f.contract, readback: { rejectTitlePatterns: ['Catalog Home'] } },
    bytes: Buffer.from(JSON.stringify(f.result)) })).rejects.toThrow('public_readback_title_rejected');
});
it('explicit configured identity wins before reading an unsafe source', async () => {
  const f = await setup();
  expect(await expectedPublicationId({ entry: ' chosen ', decision: '/etc/hosts', field: 'bad..field' }, f.dir, f.contract.publication.identity)).toBe('chosen');
});
it.each([['topic', '20261014-topic'], ['20261015-topic', '20261015-topic']])('derives configured dated slug %s', async (slug, expected) => {
  const f = await setup(), file = path.join(f.dir, 'decision.json');
  await writeFile(file, JSON.stringify({ selection: { slug } }));
  expect(await expectedPublicationId({ decision: file, field: 'selection.slug', day: '2026-10-14' }, f.dir, f.contract.publication.identity)).toBe(expected);
});
it.each(['valid', 'wrong-ancillary', 'missing-title', 'wrong-mode'])('verifies HTML digest parity: %s', async scenario => {
  const f = await setup();
  const part = { fileName: 'meta.json', sha256: 'c'.repeat(64), byteSize: 3 };
  const result = { ...f.result, mode: 'html', title: 'Article', inputDigest: { ...f.result.inputDigest, mode: 'html', ancillaryManifest: [part] } };
  const transport = { ...JSON.parse(f.input.inputBytes.toString()), mode: 'html', ancillary: [part] };
  if (scenario === 'wrong-ancillary') result.inputDigest.ancillaryManifest = [];
  if (scenario === 'missing-title') Object.assign(result, { title: null });
  if (scenario === 'wrong-mode') result.mode = 'content';
  const verify = verifyPublicationResult({ ...f.input, inputBytes: Buffer.from(JSON.stringify(transport)), contract: f.contract, bytes: Buffer.from(JSON.stringify(result)) });
  if (scenario === 'valid') expect((await verify).artifactPath).toContain('receipt.json');
  else await expect(verify).rejects.toThrow('input_mismatch');
});
it('maps an unrelated declared legacy dialect without any field-name fallback', async () => {
  const f = await setup();
  const fields = Object.fromEntries(['ok', 'command', 'mode', 'section', 'id', 'date', 'scope', 'title', 'publishedAt', 'publicUrl', 'cms']
    .map(key => [key, `/payload/${key}`]));
  const legacy = { schemaVersion: 'catalog.receipt.v4', payload: { ...f.result, mode: 'draft' },
    hashes: { source: 'a'.repeat(64), review: 'a'.repeat(64), media: [] } };
  delete (legacy.payload as Record<string, unknown>).schemaVersion;
  delete (legacy.payload as Record<string, unknown>).inputDigest;
  const contract = { ...f.contract, resultAdapter: 'legacy-publication' as const, resultSchemaVersion: 'catalog.receipt.v4',
    publication: { ...f.contract.publication, bindings: [{ resultPointer: '/payload/section', parameter: 'collection' }, { resultPointer: '/payload/date', parameter: 'day' }],
      publishedAt: { ...f.contract.publication.publishedAt, resultPointer: '/payload/publishedAt' },
      legacyMapping: { fields, contentMode: 'draft', htmlMode: 'page', contentDigest: '/hashes/source', htmlDigest: '/hashes/page',
        qaDigest: '/hashes/review', assets: '/hashes/media', ancillary: '/hashes/extras' } } };
  const value = await verifyPublicationResult({ ...f.input, contract, bytes: Buffer.from(JSON.stringify(legacy)) });
  expect(value.schemaVersion).toBe('catalog.receipt.v4');
});
it('rejects symlink identity sources', async () => {
  const f = await setup(), file = path.join(f.dir, 'decision.json');
  await writeFile(file, JSON.stringify({ slug: 'topic' })); await symlink(file, path.join(f.dir, 'link.json'));
  await expect(expectedPublicationId({ decision: path.join(f.dir, 'link.json'), field: 'slug', day: '2026-10-14' }, f.dir, f.contract.publication.identity)).rejects.toThrow('id_source_invalid');
});
