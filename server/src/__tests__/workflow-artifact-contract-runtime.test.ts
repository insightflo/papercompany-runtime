import { expect, it } from 'vitest';
import { freezeArtifactAttempt, readFrozenArtifactAttempt } from '../services/workflow/artifact-contract-runtime.js';
import { encodeQaInput } from '../services/workflow/qa-byte-transport.js';
import { legacyHtmlManualContract } from './helpers/legacy-html-manual.js';

const contract = legacyHtmlManualContract('check.mjs');
it('freezes preset then step rules and rejects mutated or stale snapshots', () => {
  const config = { ...contract, defaultRules: { rules: { 'tag-count': { params: { min: 2 } } } } };
  const frozen = freezeArtifactAttempt({ adapterConfig: { artifactContract: config },
    step: { qaConfig: { rules: { 'tag-count': { params: { min: 3 } } } } }, executionGeneration: 2, requestId: 'request' })!;
  config.defaultRules.rules['tag-count'].params.min = 9;
  expect(frozen.qaConfig.rules['tag-count']?.params?.min).toBe(3);
  expect(readFrozenArtifactAttempt(frozen, { executionGeneration: 2, requestId: 'request' })).toEqual(frozen);
  expect(() => readFrozenArtifactAttempt(frozen, { executionGeneration: 3, requestId: 'request' })).toThrow('artifact_contract_snapshot_stale');
  expect(() => readFrozenArtifactAttempt({ ...frozen, contractHash: '0'.repeat(64) })).toThrow('artifact_contract_snapshot_hash');
});
it('fails closed for declared artifact steps without a valid tool contract', () => {
  expect(() => freezeArtifactAttempt({ adapterConfig: {}, step: { toolArtifactContract: { role: 'qa' } },
    executionGeneration: 1, requestId: 'r' })).toThrow('artifact_contract_required');
  expect(freezeArtifactAttempt({ adapterConfig: {}, step: {}, executionGeneration: 1, requestId: 'r' })).toBeNull();
});
it('takes envelope version from declaration rather than a producer name', () => {
  expect(JSON.parse(encodeQaInput(Buffer.from('{}'), [], null, undefined, 'example.input.v3').toString()).schemaVersion).toBe('example.input.v3');
});
