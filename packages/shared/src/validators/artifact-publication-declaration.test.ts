import { describe, expect, it } from 'vitest';
import { artifactContractSchema } from './artifact-contract.js';

const base = { role: 'publication', resultFileName: 'published.json',
  resultSchemaVersion: 'workflow.publication-result.v1', resultAdapter: 'generic',
  inputParams: {}, deploymentFiles: ['publish.mjs'], inputEnvelopeVersion: 'workflow.artifact-input.v1' } as const;
const publication = { identity: { param: 'entry' },
  bindings: [{ resultPointer: '/date', parameter: 'day', optional: true }],
  publishedAt: { resultPointer: '/publishedAt', dateParam: 'day', suffix: 'T00:00:00Z' } };

// Removing role-specific validation must admit each unsafe declaration again.
describe('publication declaration save validation', () => {
  it.each([
    ['missing declaration', undefined], ['empty declaration', {}],
    ['missing identity', { ...publication, identity: undefined }],
    ['empty identity', { ...publication, identity: {} }],
    ['incomplete source identity', { ...publication, identity: { sourcePathParam: 'decision' } }],
    ['missing identity transform', { ...publication, identity: { sourcePathParam: 'decision', sourceFieldParam: 'field' } }],
    ['dated identity without date parameter', { ...publication, identity: { sourcePathParam: 'decision', sourceFieldParam: 'field', format: 'date-prefixed-slug' } }],
    ['missing bindings', { ...publication, bindings: undefined }],
    ['empty bindings', { ...publication, bindings: [] }],
    ['unrelated binding', { ...publication, bindings: [{ resultPointer: '/section', parameter: 'day' }] }],
    ['inconsistent date parameter', { ...publication, bindings: [{ resultPointer: '/date', parameter: 'otherDay' }] }],
    ['missing timestamp', { ...publication, publishedAt: undefined }],
    ['unrelated timestamp', { ...publication, publishedAt: { ...publication.publishedAt, resultPointer: '/title' } }],
  ])('rejects %s before saving', (_name, declaration) => {
    expect(artifactContractSchema.safeParse({ ...base, publication: declaration }).success).toBe(false);
  });

  it('keeps a declared optional date argument optional', () => {
    expect(artifactContractSchema.parse({ ...base, publication }).publication).toEqual(publication);
  });

  it.each([
    { sourcePathParam: 'decision', sourceFieldParam: 'field', format: 'literal' },
    { sourcePathParam: 'decision', sourceFieldParam: 'field', format: 'date-prefixed-slug', dateParam: 'day' },
  ])('accepts usable source identity without an explicit ID parameter: %j', identity => {
    expect(artifactContractSchema.safeParse({ ...base, publication: { ...publication, identity } }).success).toBe(true);
  });

  it('uses declared legacy result pointers rather than imposing generic field names', () => {
    const legacyMapping = { fields: { date: '/record/day', publishedAt: '/record/instant' },
      contentMode: 'draft', htmlMode: 'page', contentDigest: '/hash/source', htmlDigest: '/hash/page',
      qaDigest: '/hash/review', assets: '/media', ancillary: '/extra' };
    const contract = { ...base, resultAdapter: 'legacy-publication', publication: { ...publication, legacyMapping,
      bindings: [{ resultPointer: '/record/day', parameter: 'day', optional: true }],
      publishedAt: { ...publication.publishedAt, resultPointer: '/record/instant' } } };
    expect(artifactContractSchema.safeParse(contract).success).toBe(true);
    expect(artifactContractSchema.safeParse({ ...contract, publication: { ...contract.publication,
      bindings: publication.bindings } }).success).toBe(false);
    expect(artifactContractSchema.safeParse({ ...contract, publication: { ...contract.publication,
      publishedAt: publication.publishedAt } }).success).toBe(false);
  });

  it.each(['qa', 'publication-verify'] as const)('does not impose publisher declarations on %s', role => {
    expect(artifactContractSchema.safeParse({ ...base, role }).success).toBe(true);
    expect(artifactContractSchema.safeParse({ ...base, role, publication: {} }).success).toBe(true);
  });
});
